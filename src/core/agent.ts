import type { LlmClient } from './llm';
import { GuardError } from './paths';
import { COMPACTION_PROMPT, subagentPrompt } from './prompt';
import { Rule, RuleActivator } from './rules';
import { newSessionState, RejectedError, SessionState, Tool, ToolContext, toolsFor, toSpecs, truncateMiddle } from './tools';
import { AbortError, ChatMessage, ContextLengthError, Host, newId, Policy, ToolCall, UiItem, Usage } from './types';

export interface AgentOptions {
  llm: LlmClient;
  host: Host;
  root: string;
  policy: Policy;
  rules: Rule[];
  mode: 'agent' | 'ask';
  system: string;
  session: SessionState;
  /** Shared running totals; sub-agents add to the same object. */
  usage: Usage;
  signal: AbortSignal;
  depth?: number;
  shell?: string;
  /** Restored conversation, without the system message. */
  messages?: ChatMessage[];
}

type ToolItem = Extract<UiItem, { kind: 'tool' }>;

const SUBAGENT_MAX_TURNS = 40;
/** Rough cost of one attached image, for context budgeting. */
const IMAGE_TOKENS = 1500;
const imageNote = (n: number) => `[${n} image${n === 1 ? '' : 's'} attached here earlier; removed to save context. Ask the user to attach again if you need to see ${n === 1 ? 'it' : 'them'}.]`;

export class Agent {
  readonly messages: ChatMessage[];
  private readonly tools: Tool[];
  private readonly activator: RuleActivator;
  private readonly depth: number;
  private lastPrompt = 0;

  constructor(private readonly o: AgentOptions) {
    this.depth = o.depth ?? 0;
    this.messages = o.messages ?? [];
    this.tools = toolsFor({ readOnly: o.mode === 'ask', depth: this.depth });
    this.activator = new RuleActivator(o.rules);
  }

  private get isSub(): boolean {
    return this.depth > 0;
  }

  private check(): void {
    if (this.o.signal.aborted) throw new AbortError();
  }

  /** Runs one user request to completion and returns the final reply text. */
  async run(userText: string, images: string[] = []): Promise<string> {
    repairToolResults(this.messages);
    const user: ChatMessage = { role: 'user', content: userText };
    if (images.length) user.images = images;
    this.messages.push(user);
    let turns = 0;
    let lengthRetries = 0;
    let contextRetries = 0;
    let wrapUp = false;

    for (;;) {
      this.check();
      await this.compactIfNeeded(false);

      const itemId = newId('a');
      let started = false;
      let res;
      try {
        res = await this.o.llm.chat({
          messages: [{ role: 'system', content: this.o.system }, ...this.messages],
          tools: wrapUp ? undefined : toSpecs(this.tools),
          signal: this.o.signal,
          light: this.isSub,
          onText: (d) => {
            if (!started) {
              started = true;
              this.o.host.upsert({ kind: 'assistant', id: itemId, text: '', streaming: true });
            }
            this.o.host.delta(itemId, d);
          },
        });
      } catch (e) {
        if (e instanceof ContextLengthError && contextRetries++ < 2) {
          await this.compactIfNeeded(true);
          continue;
        }
        throw e;
      }

      this.o.usage.input += res.usage.input;
      this.o.usage.cachedInput += res.usage.cachedInput;
      this.o.usage.output += res.usage.output;
      this.lastPrompt = res.usage.input + res.usage.output;
      if (!this.isSub) {
        this.o.usage.lastPrompt = this.lastPrompt;
      }
      this.o.host.setUsage(this.o.usage);
      if (started) this.o.host.upsert({ kind: 'assistant', id: itemId, text: res.content, streaming: false });

      const truncated = res.finishReason === 'length';
      const assistant: ChatMessage = { role: 'assistant', content: res.content || null };
      if (res.toolCalls.length) assistant.tool_calls = res.toolCalls.map((c) => ({ ...c, id: c.id || newId('call') }));
      if (assistant.content === null && !assistant.tool_calls) assistant.content = '';
      this.messages.push(assistant);

      if (!assistant.tool_calls) {
        if (truncated && lengthRetries++ < 3) {
          this.messages.push({ role: 'user', content: 'Your reply was cut off at the output limit. Continue from exactly where you stopped, without repeating anything.' });
          continue;
        }
        return res.content;
      }

      const results = await this.execute(assistant.tool_calls, truncated);
      for (const r of results) this.messages.push(r);
      turns++;

      if (this.isSub && turns >= SUBAGENT_MAX_TURNS && !wrapUp) {
        wrapUp = true;
        this.messages.push({ role: 'user', content: 'You have reached your step limit. Do not call any more tools. Write your final report now from what you have found, and list what you could not finish.' });
      } else if (!this.isSub && turns % Math.max(1, this.o.policy.maxTurns) === 0) {
        const id = newId('t');
        const item: ToolItem = { kind: 'tool', id, name: 'limit', title: `Paused after ${turns} steps`, detail: 'The agent reached the step limit for one run. Continue?', status: 'approval' };
        this.o.host.upsert(item);
        const d = await this.o.host.requestApproval({ toolItemId: id, kind: 'continue' });
        this.check();
        this.o.host.upsert({ ...item, status: d.decision === 'reject' ? 'rejected' : 'done' });
        if (d.decision === 'reject') {
          wrapUp = true;
          this.messages.push({ role: 'user', content: `The user chose to stop here.${d.feedback ? ` They said: ${d.feedback}` : ''} Do not call tools. Summarise what is done, what you found, and what remains.` });
        }
      }
    }
  }

  private async execute(calls: ToolCall[], truncated: boolean): Promise<ChatMessage[]> {
    const byName = new Map(this.tools.map((t) => [t.name, t]));
    const parallel = calls.length > 1 && calls.every((c) => ['read', 'agent'].includes(byName.get(c.function.name)?.kind ?? ''));
    if (parallel) {
      const settled = await Promise.all(calls.map((c) => this.runOne(c, byName.get(c.function.name), truncated).catch((e) => e as Error)));
      this.check();
      const fatal = settled.find((s) => s instanceof Error) as Error | undefined;
      if (fatal) throw fatal;
      return calls.map((c, i) => ({ role: 'tool', tool_call_id: c.id, content: (settled[i] as { text: string }).text }));
    }
    const out: ChatMessage[] = [];
    let skipReason = '';
    for (const c of calls) {
      if (skipReason) {
        out.push({ role: 'tool', tool_call_id: c.id, content: skipReason });
        continue;
      }
      const r = await this.runOne(c, byName.get(c.function.name), truncated);
      out.push({ role: 'tool', tool_call_id: c.id, content: r.text });
      if (r.rejected) skipReason = 'Skipped: the user declined the previous action in this turn. Reconsider before continuing.';
    }
    return out;
  }

  private async runOne(call: ToolCall, tool: Tool | undefined, truncated: boolean): Promise<{ text: string; rejected?: boolean }> {
    this.check();
    const name = call.function.name;
    if (!tool) {
      return { text: `Error: there is no tool named "${name}". Available tools: ${this.tools.map((t) => t.name).join(', ')}.` };
    }
    let args: any;
    try {
      args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
    } catch {
      const why = truncated
        ? 'The arguments were cut off because the reply hit the output limit. Send less in one call: write large files in parts (create the file, then extend it with edit_file).'
        : 'The arguments were not valid JSON.';
      this.o.host.upsert({ kind: 'tool', id: newId('t'), name, title: name, status: 'error', output: why });
      return { text: `Error: ${why}` };
    }

    const item: ToolItem = { kind: 'tool', id: newId('t'), name, status: 'running', ...tool.title(args) };
    const push = () => this.o.host.upsert({ ...item });
    push();

    const ctx: ToolContext = {
      root: this.o.root,
      host: this.o.host,
      policy: this.o.policy,
      signal: this.o.signal,
      readOnly: this.o.mode === 'ask',
      itemId: item.id,
      rules: this.activator,
      session: this.o.session,
      update: (patch) => {
        Object.assign(item, patch);
        push();
      },
      approve: async (req) => {
        Object.assign(item, { status: 'approval', danger: req.danger, reason: req.reason, canAlways: req.canAlways });
        push();
        const d = await this.o.host.requestApproval({ toolItemId: item.id, ...req });
        this.check();
        if (d.decision === 'reject') throw new RejectedError(d.feedback);
        Object.assign(item, { status: 'running', reason: undefined });
        push();
        return d;
      },
      spawn: this.depth === 0 ? (description, prompt, onProgress) => this.spawn(description, prompt, onProgress) : undefined,
    };

    try {
      const out = await tool.run(args, ctx);
      this.check();
      const result = typeof out === 'string' ? out : out.result;
      item.status = 'done';
      item.output = typeof out === 'string' ? truncateMiddle(out, 20_000) : (out.display ?? truncateMiddle(out.result, 20_000));
      item.progress = undefined;
      push();
      return { text: result };
    } catch (e) {
      if (e instanceof RejectedError) {
        item.status = 'rejected';
        item.output = e.feedback ? `Declined: ${e.feedback}` : 'Declined';
        push();
        return { text: `The user declined this action.${e.feedback ? ` Their feedback: ${e.feedback}` : ''} Do not retry it unchanged.`, rejected: true };
      }
      if (e instanceof AbortError || this.o.signal.aborted) {
        item.status = 'error';
        item.output = 'Stopped';
        push();
        throw new AbortError();
      }
      const message = (e as Error).message || String(e);
      item.status = 'error';
      item.output = message;
      push();
      return { text: `${e instanceof GuardError ? 'Not allowed' : 'Error'}: ${message}` };
    }
  }

  private async spawn(description: string, prompt: string, onProgress: (text: string) => void): Promise<string> {
    let steps = 0;
    const parent = this.o.host;
    const quiet: Host = {
      upsert: (item) => {
        if (item.kind === 'tool' && item.status === 'running') {
          steps++;
          onProgress(`${steps} step${steps === 1 ? '' : 's'} · ${item.title}${item.detail ? ` ${item.detail.slice(0, 80)}` : ''}`);
        }
      },
      delta: () => undefined,
      setTodos: () => undefined,
      setUsage: (u) => parent.setUsage(u),
      requestApproval: async () => ({ decision: 'reject', feedback: 'Sub-agents cannot ask for approval.' }),
      runCommand: (c, opts) => parent.runCommand(c, opts),
      beforeWrite: async () => undefined,
      afterWrite: async () => undefined,
    };
    const sub = new Agent({
      ...this.o,
      host: quiet,
      mode: 'ask',
      depth: this.depth + 1,
      system: subagentPrompt({ root: this.o.root, rules: this.o.rules, shell: this.o.shell }),
      session: newSessionState(),
      messages: [],
    });
    onProgress(`starting · ${description}`);
    return sub.run(prompt);
  }

  // ---- Context management ----

  private estimateTokens(): number {
    let chars = this.o.system.length;
    for (const m of this.messages) {
      chars += (m.content?.length ?? 0) + 20 + (m.images?.length ?? 0) * IMAGE_TOKENS * 3.6;
      for (const c of m.tool_calls ?? []) chars += c.function.arguments.length + c.function.name.length + 20;
    }
    return Math.ceil(chars / 3.6);
  }

  private async compactIfNeeded(force: boolean): Promise<void> {
    const window = this.o.policy.contextWindow;
    if (!force && Math.max(this.estimateTokens(), this.lastPrompt) < window * 0.7) return;

    // Step 1: shrink old tool output and drop old images. Cheap, and often enough.
    const keepFrom = Math.max(0, this.messages.length - 12);
    let pruned = 0;
    for (let i = 0; i < keepFrom; i++) {
      const m = this.messages[i];
      if (m.images?.length) {
        m.content = `${m.content ?? ''}\n${imageNote(m.images.length)}`;
        delete m.images;
        pruned++;
      }
      if (m.role === 'tool' && m.content && m.content.length > 1500 && !m.content.includes('[pruned')) {
        m.content = `${m.content.slice(0, 600)}\n[pruned to save context — run the tool again if you need the rest]`;
        pruned++;
      }
    }
    this.lastPrompt = 0;
    if (!force && this.estimateTokens() < window * 0.5) {
      if (pruned && !this.isSub) this.notice('info', 'Trimmed older tool output and images to free up context.');
      return;
    }

    // Step 2: summarise everything except a recent tail.
    const tailBudget = window * 0.2 * 3.6;
    let split = this.messages.length;
    let chars = 0;
    while (split > 1) {
      const m = this.messages[split - 1];
      const len = (m.content?.length ?? 0) + (m.images?.length ?? 0) * IMAGE_TOKENS * 3.6 + (m.tool_calls?.reduce((n, c) => n + c.function.arguments.length, 0) ?? 0);
      if (chars + len > tailBudget) break;
      chars += len;
      split--;
    }
    // A tool message must stay with the assistant message that called it.
    while (split < this.messages.length && this.messages[split].role === 'tool') split++;
    if (split <= 1) return;
    const head = this.messages.slice(0, split);
    const tail = this.messages.slice(split);

    const original = head.find((m) => m.role === 'user')?.content ?? '';
    let transcript = head.map(renderForSummary).join('\n\n');
    const maxTranscript = Math.floor(window * 0.5 * 3.6);
    if (transcript.length > maxTranscript) {
      transcript = `${transcript.slice(0, Math.floor(maxTranscript * 0.3))}\n\n[... middle omitted for size ...]\n\n${transcript.slice(-Math.floor(maxTranscript * 0.7))}`;
    }
    const todos = this.o.session.todos.length
      ? `\n\nCurrent task list:\n${this.o.session.todos.map((t) => `- [${t.status}] ${t.content}`).join('\n')}`
      : '';

    const res = await this.o.llm.chat({
      messages: [
        { role: 'system', content: COMPACTION_PROMPT },
        { role: 'user', content: `Transcript to compact:\n\n${transcript}${todos}` },
      ],
      signal: this.o.signal,
      light: true,
      maxCompletionTokens: 8000,
    });
    this.o.usage.input += res.usage.input;
    this.o.usage.cachedInput += res.usage.cachedInput;
    this.o.usage.output += res.usage.output;

    const summary =
      `[Earlier conversation compacted to save context. This briefing replaces it.]\n\n` +
      `Original request:\n${original.slice(0, 8000)}\n\n` +
      `Briefing:\n${res.content}${todos}\n\n` +
      `If you kept a notes file under .forge/notes/, reread it before continuing.`;
    this.messages.splice(0, this.messages.length, { role: 'user', content: summary }, ...tail);
    if (!this.isSub) this.notice('info', 'Compacted the earlier conversation to stay within the model context window.');
  }

  private notice(level: 'info' | 'warn' | 'error', text: string): void {
    this.o.host.upsert({ kind: 'notice', id: newId('n'), level, text });
  }
}

/**
 * A stopped or failed run can leave an assistant tool call with no result, which the API rejects.
 * Fills each gap with a placeholder result.
 */
export function repairToolResults(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const calls = messages[i].tool_calls;
    if (messages[i].role !== 'assistant' || !calls?.length) continue;
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') answered.add(messages[j++].tool_call_id ?? '');
    const missing = calls.filter((c) => !answered.has(c.id));
    messages.splice(j, 0, ...missing.map((c): ChatMessage => ({ role: 'tool', tool_call_id: c.id, content: '[Interrupted before this tool finished. Its effect is unknown; check before relying on it.]' })));
  }
}

function renderForSummary(m: ChatMessage): string {
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} [...]` : s);
  if (m.role === 'user') return `USER:\n${cap(m.content ?? '', 6000)}${m.images?.length ? `\n${imageNote(m.images.length)}` : ''}`;
  if (m.role === 'tool') return `TOOL RESULT:\n${cap(m.content ?? '', 2500)}`;
  const calls = (m.tool_calls ?? []).map((c) => `CALL ${c.function.name}(${cap(c.function.arguments, 800)})`).join('\n');
  return `ASSISTANT:\n${cap(m.content ?? '', 6000)}${calls ? `\n${calls}` : ''}`;
}

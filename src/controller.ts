import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Agent } from './core/agent';
import { ConnectionConfig, loadConnection, missingSettings } from './core/env';
import { execCommand } from './core/exec';
import { AzureOpenAIClient } from './core/llm';
import { isSensitivePath } from './core/paths';
import { systemPrompt } from './core/prompt';
import { loadRules } from './core/rules';
import { newSessionState, SessionState } from './core/tools';
import {
  AbortError,
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  CommandResult,
  emptyUsage,
  Host,
  newId,
  Policy,
  Todo,
  UiItem,
  Usage,
} from './core/types';
import type { ActiveFile, FromWebview, ToWebview, ViewState } from './protocol';
import { SessionStore } from './store';

export const DIFF_SCHEME = 'forge-diff';

interface Proposal {
  abs: string;
  before: string;
  after: string;
}

/** Owns one chat: transcript, model conversation, approvals, file snapshots. Bridges core and webview. */
export class ChatController implements Host {
  private items: UiItem[] = [];
  private messages: ChatMessage[] = [];
  private todos: Todo[] = [];
  private usage: Usage = emptyUsage();
  private session: SessionState = newSessionState();
  private sessionId = newId('s');
  private title = '';
  private mode: 'agent' | 'ask' = 'agent';
  private busy = false;
  private abort: AbortController | undefined;
  private readonly approvals = new Map<string, (d: ApprovalDecision) => void>();
  private readonly proposals = new Map<string, Proposal>();
  private readonly snapshots = new Map<string, string | null>();
  private readonly deltas = new Map<string, string>();
  private deltaTimer: NodeJS.Timeout | undefined;
  private activeFile: ActiveFile | undefined;
  private poster: ((m: ToWebview) => void) | undefined;

  constructor(
    private readonly store: SessionStore,
    private readonly output: vscode.OutputChannel,
  ) {}

  // ---- Wiring ----

  attach(poster: (m: ToWebview) => void): void {
    this.poster = poster;
  }

  private post(m: ToWebview): void {
    this.poster?.(m);
  }

  get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('forge');
  }

  connection(): ConnectionConfig {
    const c = this.cfg();
    return loadConnection({
      explicitFile: c.get<string>('envFile') || undefined,
      workspaceRoot: this.root,
      overrides: {
        endpoint: c.get<string>('azure.endpoint') || undefined,
        apiVersion: c.get<string>('azure.apiVersion') || undefined,
        deployment: c.get<string>('azure.deployment') || undefined,
        subagentDeployment: c.get<string>('azure.subagentDeployment') || undefined,
      },
    });
  }

  client(conn: ConnectionConfig): AzureOpenAIClient {
    const c = this.cfg();
    return new AzureOpenAIClient(conn, {
      maxCompletionTokens: c.get<number>('model.maxCompletionTokens', 32000),
      reasoningEffort: c.get<string>('model.reasoningEffort', 'default'),
    });
  }

  private policy(): Policy {
    const c = this.cfg();
    return {
      autoApproveEdits: c.get('autoApprove.edits', false),
      autoApproveSafeCommands: c.get('autoApprove.safeCommands', true),
      autoApproveAllCommands: c.get('autoApprove.allCommands', false),
      orgWrites: c.get<'ask' | 'block'>('salesforce.orgWrites', 'ask'),
      protectedPaths: c.get<string[]>('protectedPaths', []),
      maxTurns: c.get('limits.maxTurns', 150),
      commandTimeoutSeconds: c.get('limits.commandTimeoutSeconds', 120),
      contextWindow: c.get('model.contextWindow', 200000),
    };
  }

  viewState(): ViewState {
    const conn = this.connection();
    const missing = missingSettings(conn);
    const c = this.cfg();
    return {
      items: this.items,
      todos: this.todos,
      usage: this.usage,
      busy: this.busy,
      mode: this.mode,
      ready: { ok: missing.length === 0, missing, source: conn.source, deployment: conn.deployment },
      activeFile: this.activeFile,
      pricing: {
        input: c.get('pricing.inputPerMillion', 0),
        cachedInput: c.get('pricing.cachedInputPerMillion', 0),
        output: c.get('pricing.outputPerMillion', 0),
      },
      contextWindow: c.get('model.contextWindow', 200000),
      hasWorkspace: !!this.root,
    };
  }

  refresh(): void {
    this.post({ type: 'state', state: this.viewState() });
  }

  // ---- Messages from the webview ----

  async handle(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready':
        return this.refresh();
      case 'send':
        return this.send(m.text, m.includeActive);
      case 'stop':
        return this.stop();
      case 'approval': {
        const resolve = this.approvals.get(m.id);
        this.approvals.delete(m.id);
        resolve?.({ decision: m.decision, feedback: m.feedback?.trim() || undefined });
        return;
      }
      case 'mode':
        this.mode = m.mode;
        return;
      case 'viewDiff':
        return this.viewDiff(m.id);
      case 'openFile':
        return this.openFile(m.path);
      case 'attach':
        return this.attachFile();
      case 'command':
        await vscode.commands.executeCommand(`forge.${m.command}`);
        return;
    }
  }

  // ---- Running a request ----

  private async send(text: string, includeActive: boolean): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.busy) return;
    const root = this.root;
    if (!root) {
      this.notice('error', 'Open a folder first. Forge works inside a workspace folder.');
      return;
    }
    const conn = this.connection();
    const missing = missingSettings(conn);
    if (missing.length) {
      this.notice('error', `Azure connection is not set up. Missing: ${missing.join(', ')}. Run "Forge: Set Up Azure OpenAI Connection".`);
      return;
    }

    this.upsert({ kind: 'user', id: newId('u'), text: trimmed });
    if (!this.title) this.title = trimmed.replace(/\s+/g, ' ').slice(0, 70);
    this.setBusy(true);
    this.abort = new AbortController();

    const shell = this.cfg().get<string>('shell') || undefined;
    const rules = loadRules(root);
    const agent = new Agent({
      llm: this.client(conn),
      host: this,
      root,
      policy: this.policy(),
      rules,
      mode: this.mode,
      system: systemPrompt({ root, mode: this.mode, rules, shell }),
      session: this.session,
      usage: this.usage,
      signal: this.abort.signal,
      shell,
      messages: this.messages,
    });

    try {
      const reply = await agent.run(trimmed + this.editorContext(includeActive));
      if (!reply.trim()) this.notice('warn', 'The model returned an empty reply. Try rephrasing, or raise forge.model.maxCompletionTokens.');
    } catch (e) {
      if (e instanceof AbortError || this.abort.signal.aborted) {
        this.notice('info', 'Stopped.');
      } else {
        const message = (e as Error).message || String(e);
        this.output.appendLine(`[error] ${(e as Error).stack ?? message}`);
        this.notice('error', message);
      }
    } finally {
      this.flushDeltas();
      // Close any card left open by a stop or an error.
      for (const item of this.items) {
        if (item.kind === 'assistant' && item.streaming) this.upsert({ ...item, streaming: false });
        if (item.kind === 'tool' && (item.status === 'running' || item.status === 'approval')) {
          this.upsert({ ...item, status: 'error', output: item.output ?? 'Stopped' });
        }
      }
      this.abort = undefined;
      this.setBusy(false);
      this.save();
    }
  }

  private editorContext(include: boolean): string {
    const f = this.activeFile;
    if (!include || !f) return '';
    let out = `\n\n<editor_context>\nThe user has this file open in the editor (it may or may not be what they mean): ${f.path}`;
    const editor = vscode.window.activeTextEditor;
    if (f.selection && editor && !editor.selection.isEmpty) {
      const text = editor.document.getText(editor.selection);
      if (text.length <= 12_000) {
        out += `\nSelected lines ${f.selection.start}-${f.selection.end}:\n\`\`\`\n${text}\n\`\`\``;
      } else {
        out += `\nLines ${f.selection.start}-${f.selection.end} are selected.`;
      }
    }
    return `${out}\n</editor_context>`;
  }

  stop(): void {
    this.abort?.abort();
    for (const [id, resolve] of this.approvals) {
      this.approvals.delete(id);
      resolve({ decision: 'reject' });
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.post({ type: 'busy', busy });
  }

  private notice(level: 'info' | 'warn' | 'error', text: string): void {
    this.upsert({ kind: 'notice', id: newId('n'), level, text });
  }

  // ---- Host: called by the core ----

  upsert(item: UiItem): void {
    if (item.kind === 'assistant' && !item.streaming) {
      // The final text replaces whatever was streamed; drop deltas still waiting.
      this.deltas.delete(item.id);
    }
    const i = this.items.findIndex((x) => x.id === item.id);
    if (i >= 0) this.items[i] = item;
    else this.items.push(item);
    this.post({ type: 'item', item });
  }

  delta(id: string, text: string): void {
    const item = this.items.find((x) => x.id === id);
    if (item?.kind === 'assistant') item.text += text;
    this.deltas.set(id, (this.deltas.get(id) ?? '') + text);
    this.deltaTimer ??= setTimeout(() => this.flushDeltas(), 40);
  }

  private flushDeltas(): void {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    for (const [id, text] of this.deltas) this.post({ type: 'delta', id, text });
    this.deltas.clear();
  }

  setTodos(todos: Todo[]): void {
    this.todos = todos;
    this.post({ type: 'todos', todos });
  }

  setUsage(usage: Usage): void {
    this.usage = usage;
    this.post({ type: 'usage', usage: { ...usage } });
  }

  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.flushDeltas();
    return new Promise((resolve) => {
      this.approvals.set(req.toolItemId, resolve);
      // Surface the request if the chat is not visible.
      void vscode.commands.executeCommand('forge.chat.focus');
    });
  }

  runCommand(
    command: string,
    opts: { cwd: string; timeoutMs: number; signal: AbortSignal; onOutput?: (chunk: string) => void },
  ): Promise<CommandResult> {
    this.output.appendLine(`[command] ${command}`);
    return execCommand(command, { ...opts, shell: this.cfg().get<string>('shell') || undefined });
  }

  async beforeWrite(abs: string): Promise<void> {
    if (this.snapshots.has(abs)) return;
    try {
      this.snapshots.set(abs, await fs.promises.readFile(abs, 'utf8'));
    } catch {
      this.snapshots.set(abs, null);
    }
  }

  async afterWrite(): Promise<void> {
    // VS Code reloads changed files on its own.
  }

  proposeEdit(toolItemId: string, abs: string, newContent: string): void {
    let before = '';
    try {
      before = fs.readFileSync(abs, 'utf8');
    } catch {
      // New file.
    }
    this.proposals.set(toolItemId, { abs, before, after: newContent });
  }

  // ---- Diff, files, revert ----

  diffContent(uri: vscode.Uri): string {
    const [, side, id] = uri.path.split('/');
    const p = this.proposals.get(id);
    return p ? (side === 'before' ? p.before : p.after) : '';
  }

  private async viewDiff(id: string): Promise<void> {
    const p = this.proposals.get(id);
    if (!p) {
      void vscode.window.showInformationMessage('This diff is no longer available. It is kept only while the window stays open.');
      return;
    }
    const name = path.basename(p.abs);
    const left = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/before/${id}/${name}` });
    const right = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/after/${id}/${name}` });
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (Forge edit)`, { preview: true });
  }

  private async openFile(ref: string): Promise<void> {
    const root = this.root;
    if (!root) return;
    const m = /^(.*?)(?::(\d+))?$/.exec(ref.trim());
    if (!m) return;
    const abs = path.resolve(root, m[1]);
    if (!abs.startsWith(root) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return;
    const doc = await vscode.workspace.openTextDocument(abs);
    const line = m[2] ? Math.max(0, Number(m[2]) - 1) : undefined;
    await vscode.window.showTextDocument(doc, {
      preview: true,
      selection: line === undefined ? undefined : new vscode.Range(line, 0, line, 0),
    });
  }

  private async attachFile(): Promise<void> {
    const root = this.root;
    if (!root) return;
    const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out}/**', 5000);
    const items = files
      .map((u) => path.relative(root, u.fsPath).split(path.sep).join('/'))
      .filter((p) => !isSensitivePath(p))
      .sort()
      .map((label) => ({ label }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Mention a file in your message', matchOnDescription: true });
    if (picked) this.post({ type: 'insert', text: `@${picked.label} ` });
  }

  insertText(text: string): void {
    this.post({ type: 'insert', text });
  }

  focusInput(): void {
    this.post({ type: 'focus' });
  }

  async revertChanges(): Promise<void> {
    if (this.busy) {
      void vscode.window.showWarningMessage('Stop the agent before reverting.');
      return;
    }
    if (!this.snapshots.size) {
      void vscode.window.showInformationMessage('No file changes from this chat to revert. Snapshots are kept only while the window stays open.');
      return;
    }
    const names = [...this.snapshots.keys()].map((p) => path.basename(p));
    const ok = await vscode.window.showWarningMessage(
      `Revert ${names.length} file${names.length === 1 ? '' : 's'} to how ${names.length === 1 ? 'it was' : 'they were'} before this chat changed ${names.length === 1 ? 'it' : 'them'}?`,
      { modal: true, detail: names.slice(0, 15).join('\n') + (names.length > 15 ? `\n… and ${names.length - 15} more` : '') },
      'Revert',
    );
    if (ok !== 'Revert') return;
    let failed = 0;
    for (const [abs, content] of this.snapshots) {
      try {
        if (content === null) await fs.promises.rm(abs, { force: true });
        else await fs.promises.writeFile(abs, content, 'utf8');
      } catch {
        failed++;
      }
    }
    this.snapshots.clear();
    const text = failed ? `Reverted, but ${failed} file(s) could not be restored.` : `Reverted ${names.length} file${names.length === 1 ? '' : 's'}.`;
    this.notice(failed ? 'warn' : 'info', text);
    this.messages.push({ role: 'user', content: `[System note: the user reverted every file change made in this chat. ${names.length} file(s) are back to their earlier content. Reread files before relying on them.]` });
    this.save();
  }

  // ---- Editor tracking ----

  updateActiveFile(editor: vscode.TextEditor | undefined): void {
    let next: ActiveFile | undefined;
    const root = this.root;
    if (editor && root && editor.document.uri.scheme === 'file') {
      const rel = path.relative(root, editor.document.uri.fsPath);
      if (!rel.startsWith('..') && !path.isAbsolute(rel) && !isSensitivePath(rel)) {
        next = { path: rel.split(path.sep).join('/') };
        if (!editor.selection.isEmpty) {
          next.selection = { start: editor.selection.start.line + 1, end: editor.selection.end.line + 1 };
        }
      }
    }
    if (JSON.stringify(next) === JSON.stringify(this.activeFile)) return;
    this.activeFile = next;
    this.post({ type: 'activeFile', file: next });
  }

  // ---- Sessions ----

  private save(): void {
    if (!this.items.length) return;
    this.store.save({
      id: this.sessionId,
      title: this.title || 'Untitled chat',
      updatedAt: Date.now(),
      workspace: this.root ?? '',
      mode: this.mode,
      items: this.items,
      messages: this.messages,
      todos: this.todos,
      usage: this.usage,
    });
  }

  newChat(): void {
    if (this.busy) this.stop();
    this.save();
    this.items = [];
    this.messages = [];
    this.todos = [];
    this.usage = emptyUsage();
    this.session = newSessionState();
    this.sessionId = newId('s');
    this.title = '';
    this.proposals.clear();
    this.snapshots.clear();
    this.refresh();
    this.focusInput();
  }

  async showHistory(): Promise<void> {
    const all = this.store.list();
    if (!all.length) {
      void vscode.window.showInformationMessage('No earlier chats yet.');
      return;
    }
    const here = this.root ?? '';
    type Pick = vscode.QuickPickItem & { id?: string };
    const toPick = (s: (typeof all)[number]): Pick => ({
      id: s.id,
      label: s.title,
      description: timeAgo(s.updatedAt),
      detail: s.workspace && s.workspace !== here ? path.basename(s.workspace) : undefined,
      buttons: [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete this chat' }],
    });
    const qp = vscode.window.createQuickPick<Pick>();
    const fill = () => {
      const list = this.store.list();
      const mine = list.filter((s) => s.workspace === here);
      const other = list.filter((s) => s.workspace !== here);
      qp.items = [
        ...mine.map(toPick),
        ...(other.length ? [{ label: 'Other folders', kind: vscode.QuickPickItemKind.Separator } as Pick, ...other.map(toPick)] : []),
      ];
    };
    fill();
    qp.placeholder = 'Open an earlier chat';
    qp.matchOnDescription = true;
    qp.onDidTriggerItemButton((e) => {
      if (e.item.id) this.store.delete(e.item.id);
      fill();
    });
    qp.onDidAccept(() => {
      const id = qp.selectedItems[0]?.id;
      qp.hide();
      if (id) this.openSession(id);
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  private openSession(id: string): void {
    const s = this.store.load(id);
    if (!s) return;
    if (this.busy) this.stop();
    this.save();
    this.sessionId = s.id;
    this.title = s.title;
    this.items = s.items;
    this.messages = s.messages;
    this.todos = s.todos ?? [];
    this.usage = { ...emptyUsage(), ...s.usage };
    this.mode = s.mode ?? 'agent';
    this.session = newSessionState();
    this.session.todos = this.todos;
    this.proposals.clear();
    this.snapshots.clear();
    this.refresh();
  }

  dispose(): void {
    this.stop();
    this.save();
  }
}

function timeAgo(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Agent, repairToolResults } from '../src/core/agent';
import { classifyCommand, commandPrefix } from '../src/core/commands';
import { ConnectionConfig, loadConnection, missingSettings, parseEnv } from '../src/core/env';
import { execCommand } from '../src/core/exec';
import { matchGlob } from '../src/core/glob';
import { AzureOpenAIClient } from '../src/core/llm';
import { assertWritable, GuardError, isSensitivePath, resolveInWorkspace } from '../src/core/paths';
import { COMPACTION_PROMPT, systemPrompt } from '../src/core/prompt';
import { loadRules, parseRule } from '../src/core/rules';
import { lineDiff, newSessionState } from '../src/core/tools';
import { AbortError, ApprovalDecision, ApprovalRequest, ChatMessage, cleanImages, defaultPolicy, emptyUsage, Host, Policy, Todo, UiItem } from '../src/core/types';
import { MockAzure, Responder } from './mockAzure';

const mock = new MockAzure();
let root = '';

class TestHost implements Host {
  items = new Map<string, UiItem>();
  approvals: ApprovalRequest[] = [];
  todos: Todo[] = [];
  text = '';
  decide: (r: ApprovalRequest) => ApprovalDecision = () => ({ decision: 'approve' });
  upsert(item: UiItem) {
    this.items.set(item.id, item);
  }
  delta(_id: string, t: string) {
    this.text += t;
  }
  setTodos(t: Todo[]) {
    this.todos = t;
  }
  setUsage() {}
  async requestApproval(r: ApprovalRequest) {
    this.approvals.push(r);
    return this.decide(r);
  }
  runCommand(c: string, o: { cwd: string; timeoutMs: number; signal: AbortSignal; onOutput?: (s: string) => void }) {
    return execCommand(c, o);
  }
  async beforeWrite() {}
  async afterWrite() {}
  tools() {
    return [...this.items.values()].filter((i): i is Extract<UiItem, { kind: 'tool' }> => i.kind === 'tool');
  }
}

function conn(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientSecret: 'test-secret',
    scope: 'https://cognitiveservices.azure.com/.default',
    apiKey: '',
    endpoint: mock.url,
    apiVersion: '2025-04-01-preview',
    deployment: 'gpt-main',
    subagentDeployment: '',
    authorityHost: mock.url,
    ...over,
  };
}

const client = (over: Partial<ConnectionConfig> = {}) => new AzureOpenAIClient(conn(over), { maxCompletionTokens: 4000, retryBaseMs: 5 });

function makeAgent(opts: { host?: TestHost; mode?: 'agent' | 'ask'; policy?: Partial<Policy>; signal?: AbortSignal; messages?: ChatMessage[] } = {}) {
  const host = opts.host ?? new TestHost();
  const rules = loadRules(root);
  const mode = opts.mode ?? 'agent';
  const agent = new Agent({
    llm: client(),
    host,
    root,
    policy: { ...defaultPolicy(), ...opts.policy },
    rules,
    mode,
    system: systemPrompt({ root, mode, rules }),
    session: newSessionState(),
    usage: emptyUsage(),
    signal: opts.signal ?? new AbortController().signal,
    messages: opts.messages,
  });
  return { agent, host };
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Replies from a list, one per main-agent request; sub-agent and compaction requests are answered separately. */
function scripted(steps: Array<ReturnType<Responder>>): Responder {
  let i = 0;
  return (body) => {
    const sys: string = body.messages[0]?.content ?? '';
    if (sys.startsWith('You are a read-only research sub-agent')) {
      const task = body.messages[body.messages.length - 1].content as string;
      return { content: `REPORT(${task})` };
    }
    if (sys === COMPACTION_PROMPT) return { content: 'BRIEFING: goal and findings preserved.' };
    return steps[Math.min(i++, steps.length - 1)];
  };
}

function assertValidConversation(messages: any[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') {
      let j = i - 1;
      while (messages[j].role === 'tool') j--;
      assert.equal(messages[j].role, 'assistant', 'tool result must follow an assistant message');
      assert.ok(messages[j].tool_calls.some((c: any) => c.id === m.tool_call_id), 'tool result must answer a call');
    }
    if (m.role === 'assistant' && m.tool_calls) {
      for (const c of m.tool_calls) {
        assert.ok(messages.slice(i + 1).some((x) => x.role === 'tool' && x.tool_call_id === c.id), `call ${c.id} has no result`);
      }
    }
  }
}

before(async () => {
  await mock.start();
});
after(async () => {
  await mock.stop();
});
beforeEach(() => {
  mock.reset();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/app.js'), 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(root, '.env'), 'CLIENT_SECRET = "do-not-read"\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
});

describe('env', () => {
  it('parses the KEY = "value" layout', () => {
    const v = parseEnv('TENANT_ID = "t-1"\nCLIENT_SECRET = "a=b#c"\n# note\nSCOPE=plain # trailing\nexport X=\'y\'\n');
    assert.deepEqual(v, { TENANT_ID: 't-1', CLIENT_SECRET: 'a=b#c', SCOPE: 'plain', X: 'y' });
  });
  it('loads a file and reports what is missing', () => {
    const file = path.join(root, 'conn.env');
    fs.writeFileSync(file, 'TENANT_ID = "t"\nCLIENT_ID = "c"\nAZURE_OPENAI_ENDPOINT = "https://x.openai.azure.com/"\n');
    const c = loadConnection({ explicitFile: file });
    assert.equal(c.endpoint, 'https://x.openai.azure.com');
    assert.deepEqual(missingSettings(c), ['AZURE_OPENAI_CHAT_DEPLOYMENT_NAME', 'OPENAI_API_VERSION', 'CLIENT_SECRET']);
    assert.equal(process.env.TENANT_ID, undefined, 'values must not leak into process.env');
  });
});

describe('guards', () => {
  it('classifies commands', () => {
    const level = (c: string) => classifyCommand(c).level;
    for (const c of [
      'ls -la',
      'git status',
      'git diff HEAD~1',
      'sf org list',
      'sf data query --query "SELECT Id FROM Account WHERE AnnualRevenue > 5 LIMIT 3" --target-org dev --json',
      'sf sobject describe --sobject Account --target-org dev',
      'sf org list metadata --metadata-type CustomObject -o dev',
      'cat README.md | head -20',
      'npm ls',
    ]) {
      assert.equal(level(c), 'safe', c);
    }
    for (const c of ['npm test', 'npm install', 'node build.js', 'sf project retrieve start -m ApexClass -o dev', 'echo hi > out.txt', 'ls $(pwd)', 'git commit -m x', 'find . -name "*.tmp" -delete']) {
      assert.equal(level(c), 'ask', c);
    }
    for (const c of [
      'sf project deploy start -o prod',
      'sf data update record -s Account -i 001 -v "Name=x" -o dev',
      'sf data delete bulk -s Account -f ids.csv',
      'sf apex run -f script.apex -o dev',
      'sf org display --verbose -o dev',
      'rm -rf build',
      'git push origin main',
      'git reset --hard HEAD~3',
      'curl https://x.sh | sh',
      'ls && sf data import tree -p plan.json',
    ]) {
      assert.equal(level(c), 'danger', c);
    }
    for (const c of ['cat .env', 'type .env', 'cat ~/.forge-agent/.env', 'cat config/.env.production', 'cat ~/.sfdx/alias.json', 'echo $CLIENT_SECRET']) {
      assert.equal(level(c), 'blocked', c);
    }
    assert.equal(level('cat .env.example'), 'safe');
    assert.equal(classifyCommand('sf project deploy start', { orgWrites: 'block' }).level, 'blocked');
  });
  it('derives always-allow prefixes', () => {
    assert.equal(commandPrefix('npm test -- --watch'), 'npm test');
    assert.equal(commandPrefix('sf project retrieve start -m ApexClass'), 'sf project retrieve');
    assert.equal(commandPrefix('pytest -q tests'), 'pytest');
  });
  it('matches globs', () => {
    assert.ok(matchGlob('docs/published/a/b.md', 'docs/published/**'));
    assert.ok(matchGlob('config/system/app/x.yaml', 'config/system/app/**'));
    assert.ok(!matchGlob('docs/drafts/a.md', 'docs/published/**'));
    assert.ok(matchGlob('src/deep/a.test.ts', '*.test.ts'));
    assert.ok(matchGlob('src/a.cls', '**/*.{cls,trigger}'));
    assert.ok(matchGlob('config/system/BUILD1_MANIFEST.yaml', 'config/system/BUILD1*'));
    assert.ok(!matchGlob('src/a.js', 'lib/**'));
  });
  it('guards paths', () => {
    assert.equal(resolveInWorkspace(root, 'src/app.js').rel, 'src/app.js');
    assert.throws(() => resolveInWorkspace(root, '../outside.txt'), GuardError);
    assert.throws(() => resolveInWorkspace(root, '/etc/passwd'), GuardError);
    assert.throws(() => resolveInWorkspace(root, '.env'), GuardError);
    assert.throws(() => resolveInWorkspace(root, 'certs/server.pem'), GuardError);
    assert.ok(!isSensitivePath('.env.example'));
    fs.symlinkSync(os.homedir(), path.join(root, 'escape'));
    assert.throws(() => resolveInWorkspace(root, 'escape/secret.txt'), GuardError);
    assert.throws(() => assertWritable('docs/published/page.md', ['docs/published/**']), GuardError);
    assert.doesNotThrow(() => assertWritable('docs/drafts/page.md', ['docs/published/**']));
  });
  it('produces a compact diff', () => {
    const d = lineDiff('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne');
    assert.match(d, /^@@ line 1 @@\n a\n b\n-c\n\+X\n d\n e$/);
  });
});

describe('rules', () => {
  it('parses Cursor .mdc frontmatter', () => {
    const always = parseRule('a.mdc', '---\ndescription: Always-on safety\nalwaysApply: true\n---\n\n# Safety\nNo secrets.');
    assert.equal(always.always, true);
    assert.equal(always.body, '# Safety\nNo secrets.');
    const scoped = parseRule('b.mdc', '---\ndescription: Config rules\nglobs:\n  - config/system/app/**\n  - data/raw/app/**\nalwaysApply: false\n---\nBody');
    assert.equal(scoped.always, false);
    assert.deepEqual(scoped.globs, ['config/system/app/**', 'data/raw/app/**']);
    assert.equal(parseRule('c.md', 'Plain rule').always, true);
    assert.deepEqual(parseRule('d.mdc', '---\nglobs: "*.ts, src/**"\n---\nx').globs, ['*.ts', 'src/**']);
  });
});

describe('azure client', () => {
  it('signs in once and reuses the token', async () => {
    const c = client();
    const a = await c.chat({ messages: [{ role: 'user', content: 'hi' }] });
    await c.chat({ messages: [{ role: 'user', content: 'again' }] });
    assert.equal(a.content, 'ok');
    assert.equal(mock.tokenCalls, 1);
    assert.equal(mock.authHeaders[0], 'Bearer token-1');
    assert.equal(mock.requests[0].max_completion_tokens, 4000);
    assert.equal(mock.requests[0].max_tokens, undefined);
    assert.equal(mock.requests[0].temperature, undefined);
  });
  it('refreshes the token after a 401', async () => {
    mock.responder = (_b, n) => (n === 1 ? { status: 401, errorMessage: 'expired' } : { content: 'fine' });
    const r = await client().chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.content, 'fine');
    assert.equal(mock.tokenCalls, 2);
    assert.equal(mock.authHeaders[1], 'Bearer token-2');
  });
  it('retries rate limits and server errors', async () => {
    mock.responder = (_b, n) => (n === 1 ? { status: 429, headers: { 'retry-after-ms': '5' } } : n === 2 ? { status: 503 } : { content: 'done' });
    const r = await client().chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.content, 'done');
    assert.equal(mock.chatCalls, 3);
  });
  it('explains a wrong deployment and a bad secret', async () => {
    mock.responder = () => ({ status: 404, errorMessage: 'DeploymentNotFound' });
    await assert.rejects(client().chat({ messages: [{ role: 'user', content: 'hi' }] }), /Deployment "gpt-main" was not found/);
    await assert.rejects(client({ clientSecret: 'wrong' }).chat({ messages: [{ role: 'user', content: 'hi' }] }), /Service principal sign-in failed \(401\).*Invalid client secret/);
  });
  it('streams text and assembles tool calls', async () => {
    mock.responder = () => ({ content: 'Reading now.', toolCalls: [{ name: 'read_file', args: { path: 'src/app.js' } }, { name: 'list_dir', args: { path: '.' } }] });
    let streamed = '';
    const r = await client().chat({ messages: [{ role: 'user', content: 'hi' }], onText: (t) => (streamed += t) });
    assert.equal(streamed, 'Reading now.');
    assert.equal(r.toolCalls.length, 2);
    assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { path: 'src/app.js' });
    assert.equal(r.toolCalls[1].function.name, 'list_dir');
    assert.deepEqual(r.usage, { input: 100, cachedInput: 0, output: 10 });
  });
  it('uses the v1 route when asked', async () => {
    await client({ apiVersion: 'v1' }).chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(mock.requests[0].model, 'gpt-main');
  });
});

describe('agent loop', () => {
  it('reads, edits with approval, verifies and answers', async () => {
    mock.responder = scripted([
      { toolCalls: [{ name: 'update_todos', args: { todos: [{ content: 'Fix add', status: 'in_progress' }] } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'src/app.js' } }, { name: 'search_text', args: { pattern: 'add\\(' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'src/app.js', old_string: 'return a - b;', new_string: 'return a + b;' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: 'node -e "console.log(require(\'./src/app.js\').add(2,3))"' } }] },
      { content: 'Fixed: `add` now returns the sum.' },
    ]);
    const { agent, host } = makeAgent({ policy: { autoApproveAllCommands: true } });
    const reply = await agent.run('fix add');
    assert.equal(reply, 'Fixed: `add` now returns the sum.');
    assert.match(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), /return a \+ b;/);
    assert.equal(host.approvals.length, 1);
    assert.equal(host.approvals[0].kind, 'edit');
    assert.deepEqual(host.todos, [{ content: 'Fix add', status: 'in_progress' }]);
    const tools = host.tools();
    assert.ok(tools.every((t) => t.status === 'done'), JSON.stringify(tools.map((t) => [t.title, t.status, t.output])));
    assert.match(tools.find((t) => t.name === 'edit_file')!.diff!, /-  return a - b;\n\+  return a \+ b;/);
    const last = mock.requests[mock.requests.length - 1].messages;
    assertValidConversation(last);
    const toolTexts = last.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
    assert.match(toolTexts[1], /^\s+1\tfunction add/);
    assert.match(toolTexts[2], /src\/app\.js:1: function add/);
    assert.match(toolTexts[4], /^Exit code: 0\n5$/);
    assert.equal(host.text, 'Fixed: `add` now returns the sum.');
  });

  it('passes a rejection and its feedback back to the model', async () => {
    mock.responder = scripted([
      { toolCalls: [{ name: 'write_file', args: { path: 'src/new.js', content: 'x' } }, { name: 'write_file', args: { path: 'src/other.js', content: 'y' } }] },
      { content: 'Understood.' },
    ]);
    const host = new TestHost();
    host.decide = () => ({ decision: 'reject', feedback: 'use TypeScript' });
    const { agent } = makeAgent({ host });
    await agent.run('add files');
    assert.ok(!fs.existsSync(path.join(root, 'src/new.js')));
    assert.ok(!fs.existsSync(path.join(root, 'src/other.js')));
    const msgs = mock.requests[1].messages;
    assertValidConversation(msgs);
    const results = msgs.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
    assert.match(results[0], /declined.*use TypeScript/);
    assert.match(results[1], /^Skipped/);
    assert.equal(host.approvals.length, 1, 'the second edit must not prompt after a rejection');
  });

  it('refuses secrets, outside paths and protected paths', async () => {
    fs.mkdirSync(path.join(root, 'docs/published'), { recursive: true });
    mock.responder = scripted([
      {
        toolCalls: [
          { name: 'read_file', args: { path: '.env' } },
          { name: 'read_file', args: { path: '../../etc/passwd' } },
        ],
      },
      { toolCalls: [{ name: 'write_file', args: { path: 'docs/published/page.md', content: 'x' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: 'cat .env' } }] },
      { toolCalls: [{ name: 'search_text', args: { pattern: 'do-not-re.d', include_ignored: true } }] },
      { content: 'done' },
    ]);
    const { agent, host } = makeAgent({ policy: { protectedPaths: ['docs/published/**'] } });
    await agent.run('try things');
    const results = mock.requests[mock.requests.length - 1].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
    assert.match(results[0], /^Not allowed: .*secrets/);
    assert.match(results[1], /^Not allowed: .*outside the workspace/);
    assert.match(results[2], /^Not allowed: .*protected/);
    assert.match(results[3], /^Not allowed: .*secrets file/);
    assert.equal(results[4], 'No matches.');
    assert.equal(host.approvals.length, 0);
    assert.ok(!JSON.stringify(mock.requests).includes('do-not-read'), 'the secret must never reach the model');
  });

  it('always asks before an org change and never offers "always allow"', async () => {
    mock.responder = scripted([{ toolCalls: [{ name: 'run_command', args: { command: 'sf project deploy start --target-org uat' } }] }, { content: 'ok' }]);
    const host = new TestHost();
    host.decide = () => ({ decision: 'reject' });
    const { agent } = makeAgent({ host, policy: { autoApproveAllCommands: true } });
    await agent.run('deploy');
    assert.equal(host.approvals.length, 1);
    assert.equal(host.approvals[0].danger, true);
    assert.equal(host.approvals[0].canAlways, false);
    assert.match(host.approvals[0].reason!, /Salesforce org/);
  });

  it('remembers "always allow" for a command prefix within the chat', async () => {
    mock.responder = scripted([
      { toolCalls: [{ name: 'run_command', args: { command: 'node -e "console.log(1)"' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: 'node -e "console.log(2)"' } }] },
      { content: 'ok' },
    ]);
    const host = new TestHost();
    host.decide = () => ({ decision: 'always' });
    const { agent } = makeAgent({ host });
    await agent.run('run twice');
    assert.equal(host.approvals.length, 1);
  });

  it('read-only mode offers no write tools and refuses changing commands', async () => {
    mock.responder = scripted([{ toolCalls: [{ name: 'run_command', args: { command: 'npm install left-pad' } }, { name: 'write_file', args: { path: 'a.txt', content: 'x' } }] }, { content: 'ok' }]);
    const { agent, host } = makeAgent({ mode: 'ask' });
    await agent.run('change things');
    const names = mock.requests[0].tools.map((t: any) => t.function.name);
    assert.ok(!names.includes('write_file') && !names.includes('edit_file'));
    const results = mock.requests[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
    assert.match(results[0], /Read-only mode/);
    assert.match(results[1], /no tool named "write_file"/);
    assert.equal(host.approvals.length, 0);
    assert.ok(!fs.existsSync(path.join(root, 'a.txt')));
  });

  it('runs sub-agents in parallel with their own context', async () => {
    mock.responder = scripted([
      {
        toolCalls: [
          { name: 'spawn_agent', args: { description: 'map src', prompt: 'TASK-A' } },
          { name: 'spawn_agent', args: { description: 'map tests', prompt: 'TASK-B' } },
        ],
      },
      { content: 'combined' },
    ]);
    const { agent, host } = makeAgent();
    assert.equal(await agent.run('explore'), 'combined');
    const final = mock.requests[mock.requests.length - 1].messages;
    assert.deepEqual(final.filter((m: any) => m.role === 'tool').map((m: any) => m.content), ['REPORT(TASK-A)', 'REPORT(TASK-B)']);
    const subs = mock.requests.filter((r) => r.messages[0].content.startsWith('You are a read-only research sub-agent'));
    assert.equal(subs.length, 2);
    assert.ok(subs.every((r) => r.messages.length === 2), 'sub-agents start with a fresh context');
    const subTools = subs[0].tools.map((t: any) => t.function.name);
    assert.ok(!subTools.includes('spawn_agent') && !subTools.includes('write_file') && !subTools.includes('edit_file'));
    assert.equal(host.tools().filter((t) => t.name === 'spawn_agent' && t.status === 'done').length, 2);
  });

  it('shows a scoped rule the first time a matching file is touched', async () => {
    fs.mkdirSync(path.join(root, '.cursor/rules'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cursor/rules/safety.mdc'), '---\nalwaysApply: true\n---\nALWAYS-RULE-TEXT');
    fs.writeFileSync(path.join(root, '.cursor/rules/src.mdc'), '---\ndescription: source rules\nglobs:\n  - src/**\nalwaysApply: false\n---\nSCOPED-RULE-TEXT');
    mock.responder = scripted([
      { toolCalls: [{ name: 'read_file', args: { path: 'src/app.js' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'src/app.js' } }] },
      { content: 'ok' },
    ]);
    const { agent } = makeAgent();
    await agent.run('read');
    const sys = mock.requests[0].messages[0].content as string;
    assert.ok(sys.includes('ALWAYS-RULE-TEXT'));
    assert.ok(!sys.includes('SCOPED-RULE-TEXT'));
    assert.ok(sys.includes('.cursor/rules/src.mdc — applies to: src/**'));
    const results = mock.requests[2].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
    assert.ok(results[0].includes('SCOPED-RULE-TEXT'));
    assert.ok(!results[1].includes('SCOPED-RULE-TEXT'), 'a rule is shown once');
  });

  it('compacts a long conversation and keeps it valid', async () => {
    fs.writeFileSync(path.join(root, 'big.txt'), Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n'));
    const steps = Array.from({ length: 14 }, () => ({ toolCalls: [{ name: 'read_file', args: { path: 'big.txt' } }] }));
    mock.responder = scripted([...steps, { content: 'finished' }]);
    const { agent, host } = makeAgent({ policy: { contextWindow: 30000 } });
    assert.equal(await agent.run('ORIGINAL-GOAL read a lot'), 'finished');
    const compactions = mock.requests.filter((r) => r.messages[0].content === COMPACTION_PROMPT);
    assert.ok(compactions.length >= 1, 'expected at least one compaction');
    const main = mock.requests.filter((r) => r.messages[0].content.startsWith('You are Forge'));
    for (const r of main) {
      assertValidConversation(r.messages);
      assert.ok(JSON.stringify(r.messages).length / 3.6 < 30000, 'request stayed inside the window');
    }
    const lastReq = main[main.length - 1].messages;
    assert.ok(lastReq[1].content.includes('ORIGINAL-GOAL'), 'the original request survives compaction');
    assert.ok(lastReq[1].content.includes('BRIEFING'));
    assert.ok([...host.items.values()].some((i) => i.kind === 'notice' && /Compacted/.test(i.text)));
  });

  it('sends attached images to the model as image parts', async () => {
    mock.responder = scripted([{ content: 'seen' }]);
    const { agent } = makeAgent();
    assert.equal(await agent.run('what does this error say?', [PNG]), 'seen');
    const user = mock.requests[0].messages[1];
    assert.deepEqual(user.content, [
      { type: 'text', text: 'what does this error say?' },
      { type: 'image_url', image_url: { url: PNG } },
    ]);
    assert.equal(user.images, undefined, 'the internal field is not sent');
    assert.deepEqual(agent.messages[0].images, [PNG], 'the image stays with the stored message');
  });

  it('accepts only well-formed image data within the limits', () => {
    assert.deepEqual(cleanImages([PNG, 'data:image/svg+xml;base64,AAAA', 'https://example.com/a.png', 'data:image/png;base64,<script>', 42]), [PNG]);
    assert.equal(cleanImages(Array.from({ length: 9 }, () => PNG)).length, 5);
    assert.deepEqual(cleanImages(['data:image/png;base64,' + 'A'.repeat(6_000_001)]), []);
    assert.deepEqual(cleanImages(undefined), []);
  });

  it('drops old images when the conversation is compacted', async () => {
    fs.writeFileSync(path.join(root, 'big.txt'), Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n'));
    const steps = Array.from({ length: 14 }, () => ({ toolCalls: [{ name: 'read_file', args: { path: 'big.txt' } }] }));
    mock.responder = scripted([...steps, { content: 'finished' }]);
    const { agent } = makeAgent({ policy: { contextWindow: 30000 } });
    assert.equal(await agent.run('look at this screenshot', [PNG]), 'finished');
    const main = mock.requests.filter((r) => String(r.messages[0].content).startsWith('You are Forge'));
    assert.ok(JSON.stringify(main[0].messages).includes('image_url'), 'the image is sent at first');
    const last = main[main.length - 1].messages;
    assertValidConversation(last);
    assert.ok(!JSON.stringify(last).includes('image_url'), 'the image is gone after compaction');
    assert.ok(agent.messages.every((m) => !m.images), 'no stored message keeps the image');
    assert.ok(JSON.stringify(mock.requests).includes('image attached here earlier'), 'a note replaces the image');
  });

  it('explains a deployment that does not accept images', async () => {
    mock.responder = () => ({ status: 400, errorMessage: 'Invalid content type. image_url is only supported by certain models.' });
    const { agent } = makeAgent();
    await assert.rejects(agent.run('read this', [PNG]), /did not accept the attached image/);
  });

  it('recovers from tool arguments cut off at the output limit', async () => {
    mock.responder = scripted([
      { toolCalls: [{ name: 'write_file', args: {}, rawArgs: '{"path":"a.txt","content":"unterminated' }], finish: 'length' },
      { content: 'will retry smaller' },
    ]);
    const { agent } = makeAgent();
    await agent.run('write');
    const results = mock.requests[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
    assert.match(results[0], /cut off because the reply hit the output limit/);
  });

  it('continues a reply cut off at the output limit', async () => {
    mock.responder = scripted([{ content: 'part one', finish: 'length' }, { content: ' part two' }]);
    const { agent } = makeAgent();
    assert.equal(await agent.run('long answer'), ' part two');
    assert.match(mock.requests[1].messages.at(-1).content, /cut off at the output limit/);
  });

  it('pauses at the step limit and stops when told', async () => {
    mock.responder = scripted([
      { toolCalls: [{ name: 'list_dir', args: { path: '.' } }] },
      { toolCalls: [{ name: 'list_dir', args: { path: 'src' } }] },
      { content: 'summary of progress' },
    ]);
    const host = new TestHost();
    host.decide = () => ({ decision: 'reject' });
    const { agent } = makeAgent({ host, policy: { maxTurns: 2 } });
    assert.equal(await agent.run('loop'), 'summary of progress');
    assert.equal(host.approvals[0].kind, 'continue');
    assert.equal(mock.requests[2].tools, undefined, 'the wrap-up request offers no tools');
  });

  it('stops a running command promptly and repairs the conversation', async () => {
    mock.responder = scripted([{ toolCalls: [{ name: 'run_command', args: { command: 'node -e "setTimeout(()=>{},20000)"' } }] }, { content: 'after stop' }]);
    const ac = new AbortController();
    const messages: ChatMessage[] = [];
    const { agent } = makeAgent({ signal: ac.signal, policy: { autoApproveAllCommands: true }, messages });
    const started = Date.now();
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(agent.run('wait'), AbortError);
    assert.ok(Date.now() - started < 5000, 'stop must not wait for the command');
    const next = makeAgent({ messages });
    assert.equal(await next.agent.run('carry on'), 'after stop');
    assertValidConversation(mock.requests[mock.requests.length - 1].messages);
  });

  it('repairs unanswered tool calls', () => {
    const m: ChatMessage[] = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 't', arguments: '{}' } }, { id: 'b', type: 'function', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'ok' },
    ];
    repairToolResults(m);
    assert.equal(m.length, 4);
    assert.equal(m[3].tool_call_id, 'b');
  });

  it('times out a command and reports it', async () => {
    const r = await execCommand('node -e "setTimeout(()=>{},20000)"', { cwd: root, timeoutMs: 300, signal: new AbortController().signal });
    assert.equal(r.timedOut, true);
  });
});

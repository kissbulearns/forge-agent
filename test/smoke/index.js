// End-to-end smoke test, run inside a real VS Code extension host against a local mock of Azure.
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

exports.run = async function run() {
  const out = process.env.FORGE_SMOKE_RESULT;
  const log = [];
  try {
    await main(log);
    fs.writeFileSync(out, 'PASS\n' + log.join('\n') + '\n');
  } catch (e) {
    fs.writeFileSync(out, 'FAIL\n' + log.join('\n') + '\n' + (e && e.stack ? e.stack : String(e)) + '\n');
    throw e;
  }
};

async function main(log) {
  let chat = 0;
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url.includes('/oauth2/v2.0/token')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'smoke-token', expires_in: 3600 }));
      }
      const n = ++chat;
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const w = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (n === 1) {
        const args = JSON.stringify({ path: 'hello.txt', old_string: 'world', new_string: 'forge' });
        w({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'edit_file', arguments: args } }] } }] });
        w({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        w({ choices: [{ index: 0, delta: { content: 'Changed **hello.txt**.' } }] });
        w({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      w({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;

  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const envFile = path.join(path.dirname(root), 'smoke.env');
  fs.writeFileSync(envFile, [
    'TENANT_ID = "t"', 'CLIENT_ID = "c"', 'CLIENT_SECRET = "s"',
    `AZURE_OPENAI_ENDPOINT = "${url}"`, `AZURE_AUTHORITY_HOST = "${url}"`,
    'OPENAI_API_VERSION = "2025-04-01-preview"', 'AZURE_OPENAI_CHAT_DEPLOYMENT_NAME = "smoke"', '',
  ].join('\n'));

  const ext = vscode.extensions.getExtension('internal.forge-agent');
  assert.ok(ext, 'extension is installed');
  const api = await ext.activate();
  log.push('activated');

  const commands = await vscode.commands.getCommands(true);
  for (const c of ['newChat', 'history', 'setup', 'testConnection', 'revertChanges', 'openSettings', 'addSelection', 'focus']) {
    assert.ok(commands.includes('forge.' + c), 'command forge.' + c);
  }
  log.push('commands registered');

  const cfg = vscode.workspace.getConfiguration('forge');
  await cfg.update('envFile', envFile, vscode.ConfigurationTarget.Global);
  await cfg.update('autoApprove.edits', true, vscode.ConfigurationTarget.Global);

  // The webview announcing itself proves its script loaded under the content security policy.
  const seen = [];
  const original = api.controller.handle.bind(api.controller);
  api.controller.handle = (m) => { seen.push(m.type); return original(m); };
  await vscode.commands.executeCommand('forge.chat.focus');
  const deadline = Date.now() + 15000;
  while (!seen.includes('ready') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(seen.includes('ready'), 'webview loaded and sent ready');
  log.push('webview ready');

  const state0 = api.controller.viewState();
  assert.deepStrictEqual(state0.ready.missing, [], 'connection resolved from forge.envFile');
  assert.strictEqual(state0.ready.deployment, 'smoke');

  await api.controller.handle({ type: 'send', text: 'change world to forge in hello.txt', includeActive: false });
  const state = api.controller.viewState();
  const kinds = state.items.map((i) => i.kind + (i.status ? ':' + i.status : '') + (i.level ? ':' + i.level : ''));
  log.push('items: ' + kinds.join(', '));
  assert.strictEqual(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8'), 'hello forge\n', 'file edited on disk');
  assert.deepStrictEqual(kinds, ['user', 'tool:done', 'assistant']);
  assert.strictEqual(state.items[2].text, 'Changed **hello.txt**.');
  assert.strictEqual(state.usage.input, 100);
  assert.strictEqual(bodies[0].messages[0].role, 'system');
  assert.ok(bodies[0].tools.some((t) => t.function.name === 'run_command'));
  log.push('agent run edited the file and replied');

  await vscode.commands.executeCommand('forge.newChat');
  assert.strictEqual(api.controller.viewState().items.length, 0);
  log.push('new chat cleared the transcript');
  server.closeAllConnections();
  server.close();
}

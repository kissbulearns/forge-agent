import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChatController, DIFF_SCHEME } from './controller';
import { missingSettings, userEnvPath } from './core/env';
import type { FromWebview } from './protocol';
import { SessionStore } from './store';

const ENV_TEMPLATE = `# Forge Agent connection values. Keep this file out of every repository.

TENANT_ID = ""
CLIENT_ID = ""
CLIENT_SECRET = ""
SCOPE = ""
AZURE_OPENAI_ENDPOINT = ""
OPENAI_API_VERSION = ""
AZURE_OPENAI_CHAT_DEPLOYMENT_NAME = ""
AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME = ""

# Optional: use an API key instead of the service principal above.
# AZURE_OPENAI_API_KEY = ""
`;

class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
  ) {
    controller.attach((m) => void this.view?.webview.postMessage(m));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: FromWebview) => void this.controller.handle(m));
    view.onDidDispose(() => (this.view = undefined));
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const nonce = Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      'img-src data:',
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Forge Agent</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): { controller: ChatController } {
  const output = vscode.window.createOutputChannel('Forge Agent');
  const store = new SessionStore(context.globalStorageUri.fsPath);
  const controller = new ChatController(store, output);

  context.subscriptions.push(
    output,
    { dispose: () => controller.dispose() },
    vscode.window.registerWebviewViewProvider('forge.chat', new ChatViewProvider(context.extensionUri, controller), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
      provideTextDocumentContent: (uri) => controller.diffContent(uri),
    }),

    vscode.commands.registerCommand('forge.newChat', () => controller.newChat()),
    vscode.commands.registerCommand('forge.history', () => controller.showHistory()),
    vscode.commands.registerCommand('forge.revertChanges', () => controller.revertChanges()),
    vscode.commands.registerCommand('forge.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:internal.forge-agent')),
    vscode.commands.registerCommand('forge.focus', async () => {
      await vscode.commands.executeCommand('forge.chat.focus');
      controller.focusInput();
    }),

    vscode.commands.registerCommand('forge.addSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      const root = controller.root;
      if (!editor || !root) return;
      const rel = path.relative(root, editor.document.uri.fsPath).split(path.sep).join('/');
      const s = editor.selection;
      const ref = s.isEmpty ? `@${rel} ` : `@${rel}:${s.start.line + 1}-${s.end.line + 1} `;
      await vscode.commands.executeCommand('forge.chat.focus');
      controller.insertText(ref);
    }),

    vscode.commands.registerCommand('forge.setup', async () => {
      const custom = vscode.workspace.getConfiguration('forge').get<string>('envFile');
      const file = custom || userEnvPath();
      try {
        if (!fs.existsSync(file)) {
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          fs.writeFileSync(file, ENV_TEMPLATE, { mode: 0o600 });
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`Could not create ${file}: ${(e as Error).message}`);
        return;
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
      void vscode.window.showInformationMessage(
        'Fill in the values and save. This file stays on your machine, outside your repositories, and the agent itself is not allowed to read it.',
      );
    }),

    vscode.commands.registerCommand('forge.testConnection', async () => {
      const conn = controller.connection();
      const missing = missingSettings(conn);
      if (missing.length) {
        const pick = await vscode.window.showErrorMessage(`Missing: ${missing.join(', ')}`, 'Set Up');
        if (pick) await vscode.commands.executeCommand('forge.setup');
        return;
      }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Forge: testing the Azure OpenAI connection…' }, async () => {
        const started = Date.now();
        try {
          const res = await controller.client(conn).chat({
            messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
            maxCompletionTokens: 2000,
          });
          void vscode.window.showInformationMessage(
            `Connected to deployment "${conn.deployment}" in ${((Date.now() - started) / 1000).toFixed(1)}s. Reply: ${res.content.trim().slice(0, 60) || '(empty)'}`,
          );
        } catch (e) {
          void vscode.window.showErrorMessage(`Connection failed: ${(e as Error).message}`);
        }
      });
      controller.refresh();
    }),

    vscode.window.onDidChangeActiveTextEditor((e) => controller.updateActiveFile(e)),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) controller.updateActiveFile(e.textEditor);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('forge')) controller.refresh();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (path.basename(doc.fileName) === '.env') controller.refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => controller.refresh()),
  );

  controller.updateActiveFile(vscode.window.activeTextEditor);
  // Returned for automated tests; not a public API.
  return { controller };
}

export function deactivate(): void {
  // Disposables registered in activate() do the cleanup.
}

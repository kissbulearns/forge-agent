# Forge Agent

An autonomous coding agent for VS Code that runs on your own Azure OpenAI deployment. Nothing is sent anywhere except your Azure endpoint and the Microsoft sign-in service.

It works like Cline or Cursor's agent: you describe a task, and it reads and searches the workspace, edits files, runs commands, and keeps going until the task is done, asking for approval before anything risky.

It is not tied to a language or stack. It works on any codebase you can open as a folder, new or existing, and because it can run command-line tools (git, build and test tools, cloud and platform CLIs) it can also investigate the systems behind them: query, compare with what the code or documentation says, and report the differences.

## Install

1. In VS Code: **Extensions** → **…** menu → **Install from VSIX…** → choose `forge-agent-0.1.0.vsix`.
2. Open the **Forge Agent** icon in the activity bar.
3. Click **Open connection file** (or run **Forge: Set Up Azure OpenAI Connection**). This creates `~/.forge-agent/.env`. Fill it in and save:

   ```
   TENANT_ID = "..."
   CLIENT_ID = "..."
   CLIENT_SECRET = "..."
   SCOPE = "..."
   AZURE_OPENAI_ENDPOINT = "..."
   OPENAI_API_VERSION = "..."
   AZURE_OPENAI_CHAT_DEPLOYMENT_NAME = "..."
   ```

   Use the values your Azure administrator gives you. `SCOPE` may be left empty to use the standard scope for Azure OpenAI.

4. Run **Forge: Test Azure OpenAI Connection**.

### Where the connection file lives

Forge looks in this order and uses the first file that has values:

1. the path in the `forge.envFile` setting, if set;
2. `~/.forge-agent/.env` (recommended: it is outside every repository, so it cannot be committed);
3. `.env` in the workspace root (make sure `.env` is in `.gitignore`).

The values are read by the extension only. They are never put into the environment of commands the agent runs, the agent's file tools refuse to open `.env` files, and commands that mention them are blocked.

The service principal needs the **Cognitive Services OpenAI User** role on the Azure OpenAI resource. To use an API key instead, set `AZURE_OPENAI_API_KEY` and leave the three service-principal values empty.

## What it can do

| Tool | What it does | Approval |
|---|---|---|
| Read, list, find, search | Reads files and searches the workspace | Never asks |
| Edit, write | Changes or creates files, with a diff | Asks, unless `forge.autoApprove.edits` is on |
| Run command | Runs a shell command | Read-only commands run on their own; others ask; dangerous ones always ask |
| Plan | Keeps a visible task list | Never asks |
| Sub-agent | Sends a read-only researcher off with its own context; several run in parallel | Never asks |

Long tasks are supported: there is no fixed step count (it pauses to check in every `forge.limits.maxTurns` steps), the conversation is compacted automatically as it nears the model's context window, and the agent is told to keep a notes file under `.forge/notes/` so findings survive compaction.

### Modes

- **Agent**: can edit files and run commands.
- **Read-only**: can only read, search and run read-only commands. Use it for analysis you do not want to change anything.

## Guard rails enforced in code

These hold whatever the model decides:

- **Workspace only.** File tools refuse paths outside the open folder, including through symlinks.
- **No secrets.** `.env` files, private keys and CLI auth stores (`.ssh`, `.aws`, `.azure`, `.sf`, …) cannot be read, written, searched or touched by a command.
- **Protected paths.** Globs in `forge.protectedPaths` are read-only for the agent, for example `docs/published/**`.
- **Destructive commands** (`rm -rf`, `git push`, `git reset --hard`, piping a download into a shell, …) always ask.
- **Changes to remote systems.** Commands recognised as changing a remote system ask every time and can never be set to "always allow". See the next section.
- **Sub-agents are read-only.**

A command is treated as read-only only if every part of it is on a known list (`ls`, `git status`, `git diff`, …) and it has no redirection or substitution. Everything else asks.

## Working with external systems through a CLI

Anything you can do from a terminal, the agent can do with your approval: cloud CLIs, database clients, platform tools. It uses the sign-ins already on your machine and cannot sign in by itself.

A CLI the agent does not know is treated cautiously: by default every command asks first. For CLIs it has rules for, read-only commands run on their own and changes always ask. The first such rule set is for the Salesforce CLI (`sf`): queries and describes run unprompted, while deploys, data changes, anonymous Apex and package installs ask every time, or are refused outright if `forge.salesforce.orgWrites` is `block`. Rule sets for other CLIs can be added in `src/core/commands.ts`.

## Project rules

Forge loads rules from the workspace at the start of each request:

- `AGENTS.md`, `.forge/rules.md`, `.forge/rules/*.md`
- `.cursor/rules/*.mdc` and `.cursorrules` (existing Cursor rules work unchanged)
- `.clinerules`

A rule with `alwaysApply: true` (or no frontmatter) is always in effect. A rule with `globs` is shown to the agent the first time it touches a matching file.

## Everyday use

- **Enter** sends, **Shift+Enter** adds a line, **Esc** stops.
- The chip above the input shows the file you have open; click it to leave it out.
- **@** mentions a file. Right-click a selection → **Add Selection to Forge Chat**.
- File paths in replies are clickable.
- The view's toolbar has **New Chat**, **Chat History** and **Settings**; the **…** menu has **Revert File Changes Made in This Chat**.
- The footer shows tokens used, an estimated cost if you set the `forge.pricing.*` settings, and how full the context window is.

## Settings worth knowing

| Setting | Default | Purpose |
|---|---|---|
| `forge.model.reasoningEffort` | `default` | Raise for harder investigations, lower for speed |
| `forge.model.contextWindow` | `200000` | Set to your deployment's input limit |
| `forge.model.maxCompletionTokens` | `32000` | Output cap per reply |
| `forge.azure.subagentDeployment` | empty | A cheaper deployment for sub-agents and summaries |
| `forge.autoApprove.*` | safe commands only | What runs without asking |
| `forge.protectedPaths` | `[]` | Globs the agent may not write |
| `forge.shell` | system default | Shell for commands (`cmd.exe` on Windows) |

## Limits in this version

- One workspace folder (the first, in a multi-root workspace).
- Revert and "Open diff" are kept only while the window stays open; use git for anything longer.
- Commands run without a terminal, so interactive prompts and long-running servers do not work; the agent is told to pass flags instead.
- No MCP servers, image input or web access yet.
- Behind a corporate proxy, VS Code's own proxy settings apply (`http.proxy`, `http.proxySupport`).

## Develop

```bash
npm install
npm test          # core tests against a mock Azure endpoint
npm run build     # dist/extension.js and dist/webview.js
npm run package   # forge-agent-0.1.0.vsix
```

Press F5 in VS Code to run the extension in a development window. `src/core` has no VS Code dependency, so the same agent can be driven from a CLI or a test.

## Licence

Copyright 2026 kissbulearns. Licensed under the [Apache License, Version 2.0](LICENSE). The software is provided "as is", without warranty of any kind.

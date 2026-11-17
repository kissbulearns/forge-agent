import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyCommand, commandPrefix } from './commands';
import { matchGlob, walk } from './glob';
import type { ToolSpec } from './llm';
import { assertWritable, GuardError, isSensitivePath, resolveInWorkspace } from './paths';
import type { RuleActivator } from './rules';
import type { ApprovalDecision, Host, Policy, Todo } from './types';

export class RejectedError extends Error {
  constructor(readonly feedback?: string) {
    super('Rejected');
  }
}

export interface SessionState {
  /** Command prefixes the user chose to always allow in this chat. */
  allowedPrefixes: Set<string>;
  alwaysEdits: boolean;
  todos: Todo[];
}

export const newSessionState = (): SessionState => ({ allowedPrefixes: new Set(), alwaysEdits: false, todos: [] });

export interface ToolContext {
  root: string;
  host: Host;
  policy: Policy;
  signal: AbortSignal;
  readOnly: boolean;
  itemId: string;
  rules: RuleActivator;
  session: SessionState;
  /** Patch the visible tool card. */
  update(patch: { output?: string; diff?: string; progress?: string; canViewDiff?: boolean }): void;
  /** Ask the user; resolves on approve, throws RejectedError on reject. */
  approve(req: { kind: 'edit' | 'command'; danger?: boolean; reason?: string; canAlways?: boolean }): Promise<ApprovalDecision>;
  spawn?(description: string, prompt: string, onProgress: (text: string) => void): Promise<string>;
}

export interface ToolOutput {
  result: string;
  /** What the tool card shows. Defaults to the result. */
  display?: string;
}

export interface Tool {
  name: string;
  kind: 'read' | 'write' | 'command' | 'meta' | 'agent';
  description: string;
  parameters: Record<string, unknown>;
  title(args: any): { title: string; detail?: string };
  run(args: any, ctx: ToolContext): Promise<ToolOutput | string>;
}

const MAX_RESULT = 30_000;
const MAX_READ_LINES = 2000;
const MAX_LINE = 2000;

export function truncateMiddle(text: string, max = MAX_RESULT): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[... ${text.length - max} characters omitted ...]\n\n${text.slice(-tail)}`;
}

const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8000).includes(0);

/** Compact diff: trims the common head and tail, shows what is left with three lines of context. */
export function lineDiff(before: string, after: string, maxLines = 400): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return '';
  const ctx = 3;
  const from = Math.max(0, start - ctx);
  const lines: string[] = [`@@ line ${from + 1} @@`];
  for (let i = from; i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i < endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i < endB; i++) lines.push(`+${b[i]}`);
  for (let i = endA; i < Math.min(a.length, endA + ctx); i++) lines.push(` ${a[i]}`);
  if (lines.length > maxLines) {
    return [...lines.slice(0, maxLines), `[... ${lines.length - maxLines} more diff lines; open the diff to see all ...]`].join('\n');
  }
  return lines.join('\n');
}

async function gateEdit(ctx: ToolContext, rel: string, abs: string, before: string | null, after: string): Promise<void> {
  if (ctx.readOnly) throw new GuardError('Read-only mode: file changes are disabled. Describe the change instead.');
  assertWritable(rel, ctx.policy.protectedPaths);
  const diff = before === null ? after.split('\n').slice(0, 400).map((l) => `+${l}`).join('\n') : lineDiff(before, after);
  ctx.host.proposeEdit?.(ctx.itemId, abs, after);
  ctx.update({ diff, canViewDiff: true });
  if (!ctx.policy.autoApproveEdits && !ctx.session.alwaysEdits) {
    const d = await ctx.approve({ kind: 'edit', canAlways: true });
    if (d.decision === 'always') ctx.session.alwaysEdits = true;
  }
}

async function writeText(ctx: ToolContext, abs: string, text: string): Promise<void> {
  await ctx.host.beforeWrite(abs);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, text, 'utf8');
  await ctx.host.afterWrite(abs);
}

const readFile: Tool = {
  name: 'read_file',
  kind: 'read',
  description:
    'Read a text file from the workspace. Returns numbered lines. Reads up to 2000 lines; use offset and limit for larger files. Prefer reading whole files over guessing their content.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      offset: { type: 'integer', description: 'First line to read, 1-based.' },
      limit: { type: 'integer', description: 'Number of lines to read.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  title: (a) => ({ title: `Read ${a.path ?? ''}`, detail: a.offset ? `from line ${a.offset}` : undefined }),
  async run(a, ctx) {
    const { abs, rel } = resolveInWorkspace(ctx.root, a.path);
    const stat = await fs.promises.stat(abs).catch(() => null);
    if (!stat) throw new Error(`File not found: ${rel}. Use find_files to locate it.`);
    if (stat.isDirectory()) throw new Error(`${rel} is a directory. Use list_dir.`);
    if (stat.size > 20 * 1024 * 1024) throw new Error(`${rel} is ${Math.round(stat.size / 1048576)} MB, too large to read. Use search_text to find the part you need.`);
    const buf = await fs.promises.readFile(abs);
    if (isBinary(buf)) throw new Error(`${rel} is a binary file.`);
    const all = buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
    if (all.length && all[all.length - 1] === '') all.pop();
    const offset = Math.max(1, Math.floor(a.offset ?? 1));
    const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(a.limit ?? MAX_READ_LINES)));
    const slice = all.slice(offset - 1, offset - 1 + limit);
    let body = slice
      .map((l, i) => `${String(offset + i).padStart(6)}\t${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + ' [line truncated]' : l}`)
      .join('\n');
    if (!all.length) body = '[empty file]';
    const end = offset - 1 + slice.length;
    if (end < all.length) body += `\n\n[Showing lines ${offset}-${end} of ${all.length}. Call read_file with offset ${end + 1} for more.]`;
    return {
      result: truncateMiddle(body, 120_000) + ctx.rules.activate(rel),
      display: `${slice.length} line${slice.length === 1 ? '' : 's'}${end < all.length ? ` of ${all.length}` : ''}`,
    };
  },
};

const listDir: Tool = {
  name: 'list_dir',
  kind: 'read',
  description: 'List the files and folders directly inside a workspace directory. Folders end with "/".',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Workspace-relative directory. Use "." for the root.' } },
    required: ['path'],
    additionalProperties: false,
  },
  title: (a) => ({ title: `List ${a.path ?? '.'}` }),
  async run(a, ctx) {
    const { abs, rel } = resolveInWorkspace(ctx.root, a.path || '.');
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      throw new Error(`Directory not found: ${rel}`);
    }
    const names = entries
      .filter((e) => e.name !== '.git')
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((x, y) => Number(y.endsWith('/')) - Number(x.endsWith('/')) || x.localeCompare(y));
    const shown = names.slice(0, 800);
    return {
      result: (shown.join('\n') || '[empty directory]') + (names.length > shown.length ? `\n[... ${names.length - shown.length} more entries ...]` : ''),
      display: `${names.length} entr${names.length === 1 ? 'y' : 'ies'}`,
    };
  },
};

const findFiles: Tool = {
  name: 'find_files',
  kind: 'read',
  description:
    'Find files by glob pattern, for example "**/*.cls", "src/**/test_*.py" or "*invoice*". A pattern without "/" matches file names at any depth. Skips files ignored by .gitignore unless include_ignored is true.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the workspace root.' },
      include_ignored: { type: 'boolean' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  title: (a) => ({ title: `Find ${a.pattern ?? ''}`, detail: a.path }),
  async run(a, ctx) {
    const from = a.path ? resolveInWorkspace(ctx.root, a.path).rel : '';
    const base = from === '.' ? '' : from;
    const hits: string[] = [];
    let more = false;
    for await (const rel of walk(ctx.root, { from: base, includeIgnored: !!a.include_ignored, signal: ctx.signal })) {
      const local = base ? rel.slice(base.length + 1) : rel;
      if (isSensitivePath(rel)) continue;
      if (matchGlob(local, a.pattern) || matchGlob(rel, a.pattern)) {
        if (hits.length >= 500) {
          more = true;
          break;
        }
        hits.push(rel);
      }
    }
    return {
      result: hits.length ? hits.join('\n') + (more ? '\n[More than 500 matches. Narrow the pattern.]' : '') : 'No files matched.',
      display: `${hits.length}${more ? '+' : ''} file${hits.length === 1 ? '' : 's'}`,
    };
  },
};

const searchText: Tool = {
  name: 'search_text',
  kind: 'read',
  description:
    'Search file contents with a regular expression (JavaScript syntax). Returns "path:line: text" matches. Use include to limit by glob, for example "*.md". Use output "files" to list only the files that match.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression.' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the workspace root.' },
      include: { type: 'string', description: 'Glob the file must match.' },
      case_sensitive: { type: 'boolean', description: 'Default false.' },
      context_lines: { type: 'integer', description: 'Lines of context around each match (0-5).' },
      output: { type: 'string', enum: ['matches', 'files'] },
      include_ignored: { type: 'boolean' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  title: (a) => ({ title: `Search "${String(a.pattern ?? '').slice(0, 80)}"`, detail: [a.path, a.include].filter(Boolean).join(' · ') || undefined }),
  async run(a, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(a.pattern, a.case_sensitive ? '' : 'i');
    } catch (e) {
      throw new Error(`Invalid regular expression: ${(e as Error).message}`);
    }
    const target = resolveInWorkspace(ctx.root, a.path || '.');
    const stat = await fs.promises.stat(target.abs).catch(() => null);
    if (!stat) throw new Error(`Path not found: ${target.rel}`);
    const ctxLines = Math.min(5, Math.max(0, Math.floor(a.context_lines ?? 0)));
    const filesOnly = a.output === 'files';
    const MAX = filesOnly ? 300 : 250;
    const out: string[] = [];
    let matches = 0;
    let filesHit = 0;
    let capped = false;

    const searchFile = async (rel: string) => {
      if (isSensitivePath(rel)) return;
      let buf: Buffer;
      try {
        const s = await fs.promises.stat(path.join(ctx.root, rel));
        if (s.size > 3 * 1024 * 1024) return;
        buf = await fs.promises.readFile(path.join(ctx.root, rel));
      } catch {
        return;
      }
      if (isBinary(buf)) return;
      const lines = buf.toString('utf8').split(/\r?\n/);
      let hitHere = false;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        if (!hitHere) {
          hitHere = true;
          filesHit++;
          if (filesOnly) {
            out.push(rel);
            matches++;
            return;
          }
        }
        matches++;
        if (ctxLines) {
          for (let j = Math.max(0, i - ctxLines); j <= Math.min(lines.length - 1, i + ctxLines); j++) {
            out.push(`${rel}${j === i ? ':' : '-'}${j + 1}${j === i ? ':' : '-'} ${lines[j].slice(0, 400)}`);
          }
          out.push('--');
        } else {
          out.push(`${rel}:${i + 1}: ${lines[i].slice(0, 400)}`);
        }
        if (matches >= MAX) {
          capped = true;
          return;
        }
      }
    };

    if (stat.isFile()) {
      await searchFile(target.rel);
    } else {
      const base = target.rel === '.' ? '' : target.rel;
      for await (const rel of walk(ctx.root, { from: base, includeIgnored: !!a.include_ignored, signal: ctx.signal })) {
        if (a.include && !matchGlob(rel, a.include) && !matchGlob(base ? rel.slice(base.length + 1) : rel, a.include)) continue;
        await searchFile(rel);
        if (capped || matches >= MAX) {
          capped = true;
          break;
        }
      }
    }
    if (!matches) return { result: 'No matches.', display: 'no matches' };
    return {
      result: truncateMiddle(out.join('\n')) + (capped ? `\n[Stopped at ${MAX} results. Narrow the pattern or path.]` : ''),
      display: filesOnly ? `${filesHit}${capped ? '+' : ''} files` : `${matches}${capped ? '+' : ''} matches in ${filesHit} file${filesHit === 1 ? '' : 's'}`,
    };
  },
};

const writeFile: Tool = {
  name: 'write_file',
  kind: 'write',
  description:
    'Create a file, or replace the whole content of an existing one. Parent folders are created. For a change to part of an existing file use edit_file instead. Always send the complete file content.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  title: (a) => ({ title: `Write ${a.path ?? ''}` }),
  async run(a, ctx) {
    if (typeof a.content !== 'string') throw new Error('content is required.');
    const { abs, rel } = resolveInWorkspace(ctx.root, a.path);
    let before: string | null = null;
    try {
      before = (await fs.promises.readFile(abs, 'utf8')).toString();
    } catch {
      // New file.
    }
    let content: string = a.content;
    if (before !== null && before.includes('\r\n')) content = content.replace(/\r?\n/g, '\r\n');
    if (before === content) return { result: `${rel} already has exactly this content. Nothing was written.`, display: 'no change' };
    await gateEdit(ctx, rel, abs, before, content);
    await writeText(ctx, abs, content);
    const n = content.split('\n').length;
    return {
      result: `${before === null ? 'Created' : 'Overwrote'} ${rel} (${n} lines).` + ctx.rules.activate(rel),
      display: `${before === null ? 'created' : 'overwritten'} · ${n} lines`,
    };
  },
};

const editFile: Tool = {
  name: 'edit_file',
  kind: 'write',
  description:
    'Replace an exact piece of text in an existing file. old_string must match the file exactly, including indentation, and must be unique unless replace_all is true: include enough surrounding lines to make it unique. Read the file first.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  title: (a) => ({ title: `Edit ${a.path ?? ''}` }),
  async run(a, ctx) {
    const { abs, rel } = resolveInWorkspace(ctx.root, a.path);
    let raw: string;
    try {
      raw = await fs.promises.readFile(abs, 'utf8');
    } catch {
      throw new Error(`File not found: ${rel}. Use write_file to create it.`);
    }
    const crlf = raw.includes('\r\n');
    const text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
    const oldS = String(a.old_string ?? '').replace(/\r\n/g, '\n');
    const newS = String(a.new_string ?? '').replace(/\r\n/g, '\n');
    if (!oldS) throw new Error('old_string must not be empty. To create a file use write_file.');
    if (oldS === newS) throw new Error('old_string and new_string are identical.');
    const count = text.split(oldS).length - 1;
    if (count === 0) {
      const hint = text.includes(oldS.trim()) ? ' The text exists with different leading or trailing whitespace.' : '';
      throw new Error(`old_string was not found in ${rel}.${hint} Read the file again and copy the text exactly.`);
    }
    if (count > 1 && !a.replace_all) {
      throw new Error(`old_string appears ${count} times in ${rel}. Add surrounding lines to make it unique, or set replace_all.`);
    }
    const updated = a.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
    const final = crlf ? updated.replace(/\n/g, '\r\n') : updated;
    await gateEdit(ctx, rel, abs, text, updated);
    await writeText(ctx, abs, final);
    return {
      result: `Edited ${rel} (${count} replacement${count === 1 ? '' : 's'}).` + ctx.rules.activate(rel),
      display: `${count} replacement${count === 1 ? '' : 's'}`,
    };
  },
};

const runCommand: Tool = {
  name: 'run_command',
  kind: 'command',
  description:
    'Run a shell command in the workspace and return its output and exit code. Use it for builds, tests, git and the Salesforce CLI (sf). Commands run non-interactively: pass flags instead of answering prompts, and add --json to sf commands when you need to parse results. Long-running servers are killed at the timeout.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string', description: 'Workspace-relative directory to run in. Defaults to the workspace root.' },
      timeout_seconds: { type: 'integer', description: 'Kill the command after this long. Default 120, maximum 1800.' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  title: (a) => ({ title: 'Run command', detail: String(a.command ?? '') }),
  async run(a, ctx) {
    const command = String(a.command ?? '').trim();
    const cls = classifyCommand(command, { orgWrites: ctx.policy.orgWrites });
    if (cls.level === 'blocked') throw new GuardError(cls.reason ?? 'This command is not allowed.');
    if (ctx.readOnly && cls.level !== 'safe') {
      throw new GuardError('Read-only mode: only read-only commands can run. Report the command you wanted so the user can decide.');
    }
    const cwd = a.cwd ? resolveInWorkspace(ctx.root, a.cwd).abs : ctx.root;
    const prefix = commandPrefix(command);
    const auto =
      (cls.level === 'safe' && ctx.policy.autoApproveSafeCommands) ||
      (cls.level !== 'danger' && (ctx.policy.autoApproveAllCommands || ctx.session.allowedPrefixes.has(prefix)));
    if (!auto) {
      const d = await ctx.approve({
        kind: 'command',
        danger: cls.level === 'danger',
        reason: cls.reason,
        canAlways: cls.level !== 'danger' && !!prefix,
      });
      if (d.decision === 'always') ctx.session.allowedPrefixes.add(prefix);
    }
    const timeoutMs = Math.min(1800, Math.max(1, Math.floor(a.timeout_seconds ?? ctx.policy.commandTimeoutSeconds))) * 1000;
    let live = '';
    let last = 0;
    const res = await ctx.host.runCommand(command, {
      cwd,
      timeoutMs,
      signal: ctx.signal,
      onOutput: (chunk) => {
        live = (live + chunk).slice(-20_000);
        const now = Date.now();
        if (now - last > 150) {
          last = now;
          ctx.update({ output: live });
        }
      },
    });
    const out = res.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
    const status = res.timedOut
      ? `Timed out after ${timeoutMs / 1000}s and was stopped.`
      : res.exitCode === 0
        ? 'Exit code: 0'
        : `Exit code: ${res.exitCode ?? 'unknown'}`;
    return {
      result: `${status}\n${truncateMiddle(out) || '[no output]'}`,
      display: `${status}\n${truncateMiddle(out, 20_000)}`.trim(),
    };
  },
};

const updateTodos: Tool = {
  name: 'update_todos',
  kind: 'meta',
  description:
    'Create or update the task list the user sees. Send the whole list each time. Use it for any task with three or more steps, keep exactly one item in_progress while working, and mark items completed as soon as they are done.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Short imperative phrase.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
  title: () => ({ title: 'Update plan' }),
  async run(a, ctx) {
    if (!Array.isArray(a.todos)) throw new Error('todos must be an array.');
    const todos: Todo[] = a.todos
      .filter((t: any) => t && typeof t.content === 'string' && t.content.trim())
      .map((t: any) => ({
        content: t.content.trim(),
        status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending',
      }));
    ctx.session.todos = todos;
    ctx.host.setTodos(todos);
    const done = todos.filter((t) => t.status === 'completed').length;
    return { result: 'Task list updated.', display: `${done}/${todos.length} done` };
  },
};

const spawnAgent: Tool = {
  name: 'spawn_agent',
  kind: 'agent',
  description:
    'Hand a self-contained research question to a read-only sub-agent with its own fresh context. It can read and search files and run read-only commands, and returns a written report. Use it to explore several areas in parallel (call it more than once in the same turn) or to keep a large search out of your own context. The sub-agent knows nothing about this conversation: put everything it needs in the prompt, and say exactly what to report back, including file paths and line numbers.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Three to six words naming the job.' },
      prompt: { type: 'string', description: 'Complete instructions for the sub-agent.' },
    },
    required: ['description', 'prompt'],
    additionalProperties: false,
  },
  title: (a) => ({ title: `Sub-agent: ${a.description ?? ''}` }),
  async run(a, ctx) {
    if (!ctx.spawn) throw new Error('Sub-agents cannot start further sub-agents.');
    if (!a.prompt) throw new Error('prompt is required.');
    const report = await ctx.spawn(String(a.description ?? 'research'), String(a.prompt), (progress) => ctx.update({ progress }));
    return { result: report || '[The sub-agent returned no report.]', display: truncateMiddle(report, 6000) };
  },
};

export const ALL_TOOLS: Tool[] = [readFile, listDir, findFiles, searchText, editFile, writeFile, runCommand, updateTodos, spawnAgent];

/** The tools available for a mode. Read-only mode drops the writers; sub-agents cannot spawn. */
export function toolsFor(opts: { readOnly: boolean; depth: number }): Tool[] {
  return ALL_TOOLS.filter((t) => {
    if (opts.readOnly && t.kind === 'write') return false;
    if (opts.depth > 0 && (t.kind === 'agent' || t.kind === 'meta')) return false;
    return true;
  });
}

export const toSpecs = (tools: Tool[]): ToolSpec[] =>
  tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

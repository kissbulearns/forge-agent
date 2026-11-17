import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchGlob } from './glob';

export interface Rule {
  /** Workspace-relative path of the rule file. */
  file: string;
  description: string;
  globs: string[];
  always: boolean;
  body: string;
}

const MAX_ALWAYS_CHARS = 40_000;

/** Reads a small YAML-ish frontmatter block: description, globs (string or list), alwaysApply. */
export function parseRule(file: string, text: string): Rule {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { file, description: '', globs: [], always: true, body: text.trim() };
  const body = text.slice(m[0].length).trim();
  let description = '';
  let always = false;
  let sawAlways = false;
  const globs: string[] = [];
  let inGlobs = false;
  for (const raw of m[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (inGlobs && item) {
      globs.push(unquote(item[1]));
      continue;
    }
    inGlobs = false;
    const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(raw.trim());
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (key === 'description') description = unquote(value);
    else if (key === 'alwaysApply') {
      always = /^true$/i.test(value);
      sawAlways = true;
    } else if (key === 'globs') {
      if (!value) inGlobs = true;
      else globs.push(...value.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean));
    }
  }
  // A rule with no globs and no explicit flag has nothing to scope it, so it always applies.
  if (!sawAlways && globs.length === 0) always = true;
  return { file, description, globs, always, body };
}

const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '');

function readDir(root: string, rel: string, exts: RegExp): string[] {
  try {
    return fs
      .readdirSync(path.join(root, rel), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? readDir(root, `${rel}/${e.name}`, exts) : exts.test(e.name) ? [`${rel}/${e.name}`] : []))
      .sort();
  } catch {
    return [];
  }
}

/** Loads project rules from the common locations, including Cursor's .cursor/rules/*.mdc. */
export function loadRules(root: string): Rule[] {
  const files = [
    ...['AGENTS.md', '.forge/rules.md', '.clinerules', '.cursorrules'].filter((f) => {
      try {
        return fs.statSync(path.join(root, f)).isFile();
      } catch {
        return false;
      }
    }),
    ...readDir(root, '.forge/rules', /\.(md|mdc)$/i),
    ...readDir(root, '.cursor/rules', /\.(md|mdc)$/i),
    ...readDir(root, '.clinerules', /\.(md|mdc|txt)$/i),
  ];
  const rules: Rule[] = [];
  for (const f of files) {
    try {
      const rule = parseRule(f, fs.readFileSync(path.join(root, f), 'utf8'));
      if (rule.body) rules.push(rule);
    } catch {
      // Unreadable rule file: skip it.
    }
  }
  return rules;
}

/** Text for the system prompt: always-on rules in full, scoped rules as a list to load on demand. */
export function rulesPrompt(rules: Rule[]): string {
  if (!rules.length) return '';
  const always = rules.filter((r) => r.always);
  const scoped = rules.filter((r) => !r.always);
  let out = '\n\n# Project rules\nThe project owner wrote these rules. Follow them. If one conflicts with a user request, say so and ask.';
  let used = 0;
  for (const r of always) {
    if (used + r.body.length > MAX_ALWAYS_CHARS) {
      out += `\n\n## ${r.file}\n(Not inlined for size. Read this file before starting work.)`;
      continue;
    }
    used += r.body.length;
    out += `\n\n## ${r.file}\n${r.body}`;
  }
  if (scoped.length) {
    out += '\n\n## Scoped rules\nThese apply only to matching files. Each is shown to you automatically the first time you touch a matching file; you can also read one early.';
    for (const r of scoped) {
      out += `\n- ${r.file} — applies to: ${r.globs.join(', ') || '(on request)'}${r.description ? ` — ${r.description}` : ''}`;
    }
  }
  return out;
}

/** Tracks which scoped rules the model has already been shown in this conversation. */
export class RuleActivator {
  private readonly shown = new Set<string>();
  constructor(private readonly rules: Rule[]) {}

  /** Returns rule text to append to a tool result when a path first falls under a scoped rule. */
  activate(relPath: string): string {
    let out = '';
    for (const r of this.rules) {
      if (r.always || this.shown.has(r.file)) continue;
      if (relPath === r.file) {
        this.shown.add(r.file);
        continue;
      }
      if (r.globs.some((g) => matchGlob(relPath, g))) {
        this.shown.add(r.file);
        out += `\n\n[Project rule now in effect because you touched ${relPath} — ${r.file}]\n${r.body}`;
      }
    }
    return out;
  }
}

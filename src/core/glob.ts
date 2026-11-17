import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { Ignore } from 'ignore';

/** Converts a glob (**, *, ?, {a,b}, [abc]) to a RegExp over forward-slash paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let depth = 0;
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      re += '(?:';
      depth++;
    } else if (c === '}' && depth > 0) {
      re += ')';
      depth--;
    } else if (c === ',' && depth > 0) {
      re += '|';
    } else if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end > i) {
        re += g.slice(i, end + 1).replace(/^\[!/, '[^');
        i = end;
      } else {
        re += '\\[';
      }
    } else {
      re += c.replace(/[.+^$()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

/** True when the relative path matches the glob. A glob with no slash matches the file name at any depth. */
export function matchGlob(relPath: string, glob: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  const g = glob.trim();
  if (!g) return false;
  if (!g.includes('/')) return globToRegExp(g).test(p.slice(p.lastIndexOf('/') + 1));
  return globToRegExp(g).test(p) || globToRegExp(g.replace(/\/$/, '') + '/**').test(p);
}

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.hg', '.svn']);

function loadIgnore(root: string): Ignore {
  const ig = ignore();
  try {
    ig.add(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'));
  } catch {
    // No .gitignore.
  }
  return ig;
}

export interface WalkOptions {
  /** Relative directory to start from. */
  from?: string;
  includeIgnored?: boolean;
  signal?: AbortSignal;
  maxFiles?: number;
}

/** Yields workspace-relative file paths (forward slashes), honouring the root .gitignore. */
export async function* walk(root: string, opts: WalkOptions = {}): AsyncGenerator<string> {
  const ig = opts.includeIgnored ? undefined : loadIgnore(root);
  const max = opts.maxFiles ?? 50000;
  let seen = 0;
  const stack: string[] = [(opts.from ?? '').replace(/\\/g, '/').replace(/^\.?\/?/, '').replace(/\/$/, '')];
  while (stack.length) {
    if (opts.signal?.aborted) return;
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const dirs: string[] = [];
    for (const e of entries) {
      if (ALWAYS_SKIP.has(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (ig?.ignores(rel + '/')) continue;
        dirs.push(rel);
      } else if (e.isFile()) {
        if (ig?.ignores(rel)) continue;
        yield rel;
        if (++seen >= max) return;
      }
    }
    // Reverse so the stack pops directories in alphabetical order.
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]);
  }
}

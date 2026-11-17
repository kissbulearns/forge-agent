import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchGlob } from './glob';

export class GuardError extends Error {}

const SENSITIVE_NAMES = [
  /^\.env($|\.)/i,
  /\.(pem|pfx|p12|key|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^credentials(\.json)?$/i,
];
const SENSITIVE_DIRS = new Set(['.forge-agent', '.sfdx', '.sf', '.ssh', '.aws', '.azure']);

/** True for files that hold secrets: env files, private keys, CLI auth stores. */
export function isSensitivePath(relOrAbs: string): boolean {
  const parts = relOrAbs.replace(/\\/g, '/').split('/').filter(Boolean);
  const name = parts[parts.length - 1] ?? '';
  if (name.toLowerCase() === '.env.example' || name.toLowerCase() === '.env.template') return false;
  if (SENSITIVE_NAMES.some((re) => re.test(name))) return true;
  return parts.slice(0, -1).some((p) => SENSITIVE_DIRS.has(p));
}

export interface Resolved {
  abs: string;
  /** Workspace-relative, forward slashes. */
  rel: string;
}

/** Resolves a model-supplied path and refuses anything outside the workspace or holding secrets. */
export function resolveInWorkspace(root: string, input: string): Resolved {
  if (typeof input !== 'string' || !input.trim()) throw new GuardError('A file path is required.');
  const cleaned = input.trim().replace(/^@/, '');
  const abs = path.resolve(root, cleaned);
  const realRoot = safeReal(root);
  // Resolve symlinks on the deepest existing ancestor so a link cannot point outside.
  const real = safeReal(abs);
  const rel = path.relative(realRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new GuardError(`"${input}" is outside the workspace. File tools only work inside ${root}.`);
  }
  const posix = rel.split(path.sep).join('/');
  if (isSensitivePath(posix)) {
    throw new GuardError(`"${input}" may hold secrets, so the agent is not allowed to open it.`);
  }
  return { abs: real, rel: posix || '.' };
}

function safeReal(p: string): string {
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function assertWritable(rel: string, protectedGlobs: string[]): void {
  const hit = protectedGlobs.find((g) => matchGlob(rel, g));
  if (hit) {
    throw new GuardError(`"${rel}" is protected by the forge.protectedPaths rule "${hit}". The agent may read it but not change it.`);
  }
}

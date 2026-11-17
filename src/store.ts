import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage, Todo, UiItem, Usage } from './core/types';

export interface StoredSession {
  id: string;
  title: string;
  updatedAt: number;
  workspace: string;
  mode: 'agent' | 'ask';
  items: UiItem[];
  messages: ChatMessage[];
  todos: Todo[];
  usage: Usage;
}

export type SessionSummary = Pick<StoredSession, 'id' | 'title' | 'updatedAt' | 'workspace'>;

const MAX_SESSIONS = 200;

/** Chat history on disk: one JSON file per chat plus a small index. */
export class SessionStore {
  private readonly dir: string;
  private readonly indexFile: string;

  constructor(storageDir: string) {
    this.dir = path.join(storageDir, 'sessions');
    this.indexFile = path.join(this.dir, 'index.json');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  list(): SessionSummary[] {
    try {
      const all = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as SessionSummary[];
      return all.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  load(id: string): StoredSession | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as StoredSession;
    } catch {
      return undefined;
    }
  }

  save(s: StoredSession): void {
    try {
      fs.writeFileSync(this.file(s.id), JSON.stringify(s));
      const index = this.list().filter((x) => x.id !== s.id);
      index.unshift({ id: s.id, title: s.title, updatedAt: s.updatedAt, workspace: s.workspace });
      for (const old of index.splice(MAX_SESSIONS)) fs.rmSync(this.file(old.id), { force: true });
      fs.writeFileSync(this.indexFile, JSON.stringify(index));
    } catch {
      // History is a convenience; never fail a chat because it could not be saved.
    }
  }

  delete(id: string): void {
    try {
      fs.rmSync(this.file(id), { force: true });
      fs.writeFileSync(this.indexFile, JSON.stringify(this.list().filter((x) => x.id !== id)));
    } catch {
      // Ignore.
    }
  }

  private file(id: string): string {
    return path.join(this.dir, `${id.replace(/[^\w-]/g, '')}.json`);
  }
}

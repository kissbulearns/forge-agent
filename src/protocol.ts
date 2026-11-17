import type { Todo, UiItem, Usage } from './core/types';

export interface ActiveFile {
  path: string;
  /** 1-based inclusive line range when text is selected. */
  selection?: { start: number; end: number };
}

export interface ViewState {
  items: UiItem[];
  todos: Todo[];
  usage: Usage;
  busy: boolean;
  mode: 'agent' | 'ask';
  ready: { ok: boolean; missing: string[]; source?: string; deployment?: string };
  activeFile?: ActiveFile;
  pricing: { input: number; cachedInput: number; output: number };
  contextWindow: number;
  hasWorkspace: boolean;
}

export type ToWebview =
  | { type: 'state'; state: ViewState }
  | { type: 'item'; item: UiItem }
  | { type: 'delta'; id: string; text: string }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'usage'; usage: Usage }
  | { type: 'busy'; busy: boolean }
  | { type: 'activeFile'; file?: ActiveFile }
  | { type: 'insert'; text: string }
  | { type: 'focus' };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string; includeActive: boolean; images?: string[] }
  | { type: 'stop' }
  | { type: 'approval'; id: string; decision: 'approve' | 'always' | 'reject'; feedback?: string }
  | { type: 'mode'; mode: 'agent' | 'ask' }
  | { type: 'viewDiff'; id: string }
  | { type: 'openFile'; path: string }
  | { type: 'attach' }
  | { type: 'command'; command: 'setup' | 'testConnection' | 'openSettings' };

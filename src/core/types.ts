export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Images attached to a user message, as data URLs. Sent to the model as image parts. */
  images?: string[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface Usage {
  input: number;
  cachedInput: number;
  output: number;
  /** Prompt size of the most recent request: the live context fill. */
  lastPrompt: number;
}

export const emptyUsage = (): Usage => ({ input: 0, cachedInput: 0, output: 0, lastPrompt: 0 });

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type ToolStatus = 'approval' | 'running' | 'done' | 'error' | 'rejected';

/** One entry in the visible transcript. The host owns these; the webview renders them. */
export type UiItem =
  | { kind: 'user'; id: string; text: string; images?: string[] }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      title: string;
      detail?: string;
      status: ToolStatus;
      output?: string;
      /** Unified-diff style preview for edits. */
      diff?: string;
      danger?: boolean;
      reason?: string;
      canAlways?: boolean;
      canViewDiff?: boolean;
      progress?: string;
    }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string };

export type ApprovalDecision = { decision: 'approve' | 'always' | 'reject'; feedback?: string };

export interface ApprovalRequest {
  toolItemId: string;
  kind: 'edit' | 'command' | 'continue';
  danger?: boolean;
  reason?: string;
  canAlways?: boolean;
}

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/** Everything the core needs from its surroundings. VS Code, a CLI or a test supplies this. */
export interface Host {
  upsert(item: UiItem): void;
  delta(id: string, text: string): void;
  setTodos(todos: Todo[]): void;
  setUsage(usage: Usage): void;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  runCommand(
    command: string,
    opts: { cwd: string; timeoutMs: number; signal: AbortSignal; onOutput?: (chunk: string) => void },
  ): Promise<CommandResult>;
  /** Called before a file is first changed so the host can snapshot it for revert. */
  beforeWrite(absPath: string): Promise<void>;
  /** Called after a file changed so the host can refresh editors. */
  afterWrite(absPath: string): Promise<void>;
  /** Stash a proposed edit so the user can open it in a diff editor. */
  proposeEdit?(toolItemId: string, absPath: string, newContent: string): void;
}

export interface Policy {
  autoApproveEdits: boolean;
  autoApproveSafeCommands: boolean;
  autoApproveAllCommands: boolean;
  orgWrites: 'ask' | 'block';
  protectedPaths: string[];
  maxTurns: number;
  commandTimeoutSeconds: number;
  contextWindow: number;
}

export const defaultPolicy = (): Policy => ({
  autoApproveEdits: false,
  autoApproveSafeCommands: true,
  autoApproveAllCommands: false,
  orgWrites: 'ask',
  protectedPaths: [],
  maxTurns: 150,
  commandTimeoutSeconds: 120,
  contextWindow: 200000,
});

export class AbortError extends Error {
  constructor() {
    super('Stopped');
    this.name = 'AbortError';
  }
}

export class ContextLengthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextLengthError';
  }
}

/** Limits for images attached to a message. */
export const MAX_IMAGES = 5;
export const MAX_IMAGE_CHARS = 6_000_000;
const IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

/** Keeps only well-formed image data URLs within the limits. */
export function cleanImages(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  return images
    .filter((u): u is string => typeof u === 'string' && u.length <= MAX_IMAGE_CHARS && IMAGE_URL.test(u))
    .slice(0, MAX_IMAGES);
}

let counter = 0;
export const newId = (prefix = 'i'): string =>
  `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

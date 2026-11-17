import { AuthProvider, describeNetworkError } from './auth';
import type { ConnectionConfig } from './env';
import { AbortError, ChatMessage, ContextLengthError, ToolCall } from './types';

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  /** Use the cheaper sub-agent deployment when one is configured. */
  light?: boolean;
  maxCompletionTokens?: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: { input: number; cachedInput: number; output: number };
}

export interface ModelOptions {
  maxCompletionTokens: number;
  reasoningEffort?: string;
  /** Milliseconds; shortened in tests. */
  retryBaseMs?: number;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 6;

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatResult>;
}

/** Streaming chat-completions client for Azure OpenAI with tool calling, retry and token refresh. */
export class AzureOpenAIClient implements LlmClient {
  private readonly auth: AuthProvider;

  constructor(
    private readonly cfg: ConnectionConfig,
    private readonly opts: ModelOptions,
  ) {
    this.auth = new AuthProvider(cfg);
  }

  private url(deployment: string): string {
    const v = this.cfg.apiVersion.trim();
    if (!v || v.toLowerCase() === 'v1') return `${this.cfg.endpoint}/openai/v1/chat/completions`;
    return `${this.cfg.endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(v)}`;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const deployment = (req.light && this.cfg.subagentDeployment) || this.cfg.deployment;
    const body: Record<string, unknown> = {
      model: deployment,
      messages: req.messages.map(toWire),
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: req.maxCompletionTokens ?? this.opts.maxCompletionTokens,
    };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = 'auto';
    }
    if (this.opts.reasoningEffort && this.opts.reasoningEffort !== 'default') {
      body.reasoning_effort = this.opts.reasoningEffort;
    }
    const hasImages = req.messages.some((m) => m.images?.length);
    const payload = JSON.stringify(body);
    const base = this.opts.retryBaseMs ?? 1500;

    let refreshed = false;
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (req.signal?.aborted) throw new AbortError();
      let res: Response;
      try {
        res = await fetch(this.url(deployment), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await this.auth.headers(false)) },
          body: payload,
          signal: req.signal,
        });
      } catch (e) {
        if (req.signal?.aborted) throw new AbortError();
        if ((e as Error).message?.startsWith('Service principal') || (e as Error).message?.startsWith('Could not reach the Microsoft')) throw e;
        lastError = `Could not reach ${this.cfg.endpoint} (${describeNetworkError(e)})`;
        await sleep(backoff(base, attempt), req.signal);
        continue;
      }

      if (res.ok && res.body) {
        try {
          return await readStream(res.body, req);
        } catch (e) {
          if (req.signal?.aborted || e instanceof AbortError) throw new AbortError();
          if (e instanceof StreamBrokenError && !e.emittedText) {
            lastError = e.message;
            await sleep(backoff(base, attempt), req.signal);
            continue;
          }
          throw e;
        }
      }

      const text = await res.text().catch(() => '');
      const message = extractError(text) || res.statusText;
      if (res.status === 401 && !refreshed && !this.cfg.apiKey) {
        refreshed = true;
        await this.auth.headers(true);
        continue;
      }
      if (res.status === 400 && hasImages && /image|vision|multimodal|content type|content part/i.test(text)) {
        throw new Error(`Deployment "${deployment}" did not accept the attached image. It may not support image input. Remove the image or use a deployment that does. ${message}`);
      }
      if (res.status === 400 && /context_length|maximum context|too many tokens|context window/i.test(text)) {
        throw new ContextLengthError(message);
      }
      if (RETRYABLE.has(res.status)) {
        lastError = `${res.status} ${message}`;
        const retryAfter = Number(res.headers.get('retry-after-ms')) || Number(res.headers.get('retry-after')) * 1000;
        await sleep(Math.min(retryAfter || backoff(base, attempt), 60000), req.signal);
        continue;
      }
      throw new Error(friendlyHttpError(res.status, message, deployment));
    }
    throw new Error(`The model request failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}`);
  }
}

class StreamBrokenError extends Error {
  constructor(
    message: string,
    readonly emittedText: boolean,
  ) {
    super(message);
  }
}

async function readStream(body: ReadableStream<Uint8Array>, req: ChatRequest): Promise<ChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason = '';
  const calls: ToolCall[] = [];
  const usage = { input: 0, cachedInput: 0, output: 0 };
  let done = false;

  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      done = true;
      return;
    }
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw new Error(chunk.error.message || 'The model returned an error mid-stream.');
    if (chunk.usage) {
      usage.input = chunk.usage.prompt_tokens ?? 0;
      usage.output = chunk.usage.completion_tokens ?? 0;
      usage.cachedInput = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta;
    if (!d) return;
    if (typeof d.content === 'string' && d.content) {
      content += d.content;
      req.onText?.(d.content);
    }
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? 0;
      calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].function.name += tc.function.name;
      if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
    }
  };

  try {
    while (!done) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, nl).replace(/\r$/, ''));
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.trim()) handle(buffer.trim());
  } catch (e) {
    if (req.signal?.aborted) throw new AbortError();
    if ((e as Error).name === 'AbortError') throw new AbortError();
    if (!finishReason) throw new StreamBrokenError(`The connection dropped mid-reply (${describeNetworkError(e)})`, content.length > 0);
    throw e;
  } finally {
    reader.cancel().catch(() => undefined);
  }
  if (!finishReason && !done) {
    throw new StreamBrokenError('The reply ended before the model finished.', content.length > 0);
  }
  if (finishReason === 'content_filter' && !content && !calls.length) {
    throw new Error("The reply was blocked by the deployment's content filter.");
  }
  return { content, toolCalls: calls.filter((c) => c && c.function.name), finishReason, usage };
}

function extractError(text: string): string {
  try {
    const j = JSON.parse(text);
    return j?.error?.message || j?.message || '';
  } catch {
    return text.slice(0, 300);
  }
}

function friendlyHttpError(status: number, message: string, deployment: string): string {
  if (status === 401) return `Azure rejected the credentials (401). Check the client secret and that the service principal has the "Cognitive Services OpenAI User" role. ${message}`;
  if (status === 403) return `Azure refused access (403). The service principal may lack a role on this resource, or a network rule blocks this machine. ${message}`;
  if (status === 404) return `Deployment "${deployment}" was not found (404). Check AZURE_OPENAI_CHAT_DEPLOYMENT_NAME, the endpoint and OPENAI_API_VERSION. ${message}`;
  return `Azure OpenAI error ${status}: ${message}`;
}

const backoff = (base: number, attempt: number): number =>
  Math.min(base * 2 ** (attempt - 1), 30000) * (0.75 + Math.random() * 0.5);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Converts a stored message to the API shape: attached images become image parts. */
export function toWire(m: ChatMessage): Record<string, unknown> {
  const { images, ...rest } = m;
  if (!images?.length || m.role !== 'user') return rest;
  return {
    ...rest,
    content: [
      { type: 'text', text: m.content || 'See the attached image.' },
      ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ],
  };
}

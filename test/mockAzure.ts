import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Script {
  status?: number;
  headers?: Record<string, string>;
  errorMessage?: string;
  content?: string;
  toolCalls?: Array<{ name: string; args: unknown; rawArgs?: string }>;
  finish?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export type Responder = (body: any, n: number) => Script;

/** A local stand-in for the Microsoft token endpoint and an Azure OpenAI chat deployment. */
export class MockAzure {
  server!: http.Server;
  url = '';
  tokenCalls = 0;
  chatCalls = 0;
  requests: any[] = [];
  authHeaders: string[] = [];
  responder: Responder = () => ({ content: 'ok' });

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => this.route(req, res, raw));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections?.();
    return new Promise((r) => this.server.close(() => r()));
  }

  reset(): void {
    this.tokenCalls = 0;
    this.chatCalls = 0;
    this.requests = [];
    this.authHeaders = [];
    this.responder = () => ({ content: 'ok' });
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse, raw: string): void {
    const url = req.url ?? '';
    if (url.includes('/oauth2/v2.0/token')) {
      this.tokenCalls++;
      const form = new URLSearchParams(raw);
      if (form.get('client_secret') !== 'test-secret') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: `token-${this.tokenCalls}`, expires_in: 3600, token_type: 'Bearer' }));
      return;
    }
    if (url.includes('/chat/completions')) {
      const n = ++this.chatCalls;
      const body = JSON.parse(raw);
      this.requests.push(body);
      this.authHeaders.push(String(req.headers.authorization ?? ''));
      const s = this.responder(body, n);
      if (s.status && s.status !== 200) {
        res.writeHead(s.status, { 'Content-Type': 'application/json', ...s.headers });
        res.end(JSON.stringify({ error: { message: s.errorMessage ?? 'mock error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const write = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const text = s.content ?? '';
      for (let i = 0; i < text.length; i += 7) {
        write({ choices: [{ index: 0, delta: { content: text.slice(i, i + 7) } }] });
      }
      (s.toolCalls ?? []).forEach((tc, index) => {
        const args = tc.rawArgs ?? JSON.stringify(tc.args);
        const mid = Math.floor(args.length / 2);
        write({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${n}_${index}`, type: 'function', function: { name: tc.name, arguments: '' } }] } }] });
        write({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(0, mid) } }] } }] });
        write({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(mid) } }] } }] });
      });
      write({ choices: [{ index: 0, delta: {}, finish_reason: s.finish ?? (s.toolCalls?.length ? 'tool_calls' : 'stop') }] });
      write({ choices: [], usage: s.usage ?? { prompt_tokens: 100, completion_tokens: 10 } });
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404);
    res.end();
  }
}

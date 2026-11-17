import type { ConnectionConfig } from './env';

/** Supplies request headers: an API key, or a cached service-principal bearer token. */
export class AuthProvider {
  private token = '';
  private expiresAt = 0;
  private pending: Promise<string> | undefined;

  constructor(private readonly cfg: ConnectionConfig) {}

  async headers(forceRefresh = false): Promise<Record<string, string>> {
    if (this.cfg.apiKey) return { 'api-key': this.cfg.apiKey };
    return { Authorization: `Bearer ${await this.getToken(forceRefresh)}` };
  }

  private getToken(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && this.token && Date.now() < this.expiresAt) return Promise.resolve(this.token);
    // Concurrent callers (parallel sub-agents) share one token request.
    this.pending ??= this.fetchToken().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    const { tenantId, clientId, clientSecret, scope, authorityHost } = this.cfg;
    const url = `${authorityHost}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    });
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (e) {
      throw new Error(`Could not reach the Microsoft sign-in service (${describeNetworkError(e)}).`);
    }
    const text = await res.text();
    let json: { access_token?: string; expires_in?: number; error_description?: string; error?: string } = {};
    try {
      json = JSON.parse(text);
    } catch {
      // Leave json empty; reported below.
    }
    if (!res.ok || !json.access_token) {
      const why = (json.error_description || json.error || text || res.statusText).split('\n')[0].slice(0, 300);
      throw new Error(`Service principal sign-in failed (${res.status}): ${why}`);
    }
    this.token = json.access_token;
    // Renew two minutes early so a long request never carries a token about to expire.
    this.expiresAt = Date.now() + Math.max(30, (json.expires_in ?? 3600) - 120) * 1000;
    return this.token;
  }
}

export function describeNetworkError(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  return err?.cause?.code || err?.cause?.message || err?.message || 'network error';
}

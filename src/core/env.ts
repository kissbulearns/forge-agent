import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ConnectionConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  apiKey: string;
  endpoint: string;
  apiVersion: string;
  deployment: string;
  subagentDeployment: string;
  /** Normally https://login.microsoftonline.com. Overridable for sovereign clouds and tests. */
  authorityHost: string;
  /** File the values were read from, if any. */
  source?: string;
}

/** Parses KEY = "value" lines. Tolerates spaces around '=', quotes, comments and 'export'. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[m[1]] = value;
  }
  return out;
}

export const userEnvPath = (): string => path.join(os.homedir(), '.forge-agent', '.env');

export interface LoadOptions {
  explicitFile?: string;
  workspaceRoot?: string;
  overrides?: Partial<Pick<ConnectionConfig, 'endpoint' | 'apiVersion' | 'deployment' | 'subagentDeployment'>>;
}

/**
 * Resolves the connection. Order: explicit file, else ~/.forge-agent/.env, else workspace .env.
 * Values are never copied into process.env, so commands the agent runs cannot read them.
 */
export function loadConnection(opts: LoadOptions = {}): ConnectionConfig {
  const candidates = opts.explicitFile
    ? [opts.explicitFile.replace(/^~(?=$|[\\/])/, os.homedir())]
    : [userEnvPath(), ...(opts.workspaceRoot ? [path.join(opts.workspaceRoot, '.env')] : [])];

  let vars: Record<string, string> = {};
  let source: string | undefined;
  for (const file of candidates) {
    try {
      const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
      if (parsed.AZURE_OPENAI_ENDPOINT || parsed.CLIENT_ID || parsed.AZURE_OPENAI_API_KEY) {
        vars = parsed;
        source = file;
        break;
      }
    } catch {
      // Missing or unreadable: try the next candidate.
    }
  }

  const pick = (...keys: string[]): string => {
    for (const k of keys) if (vars[k]) return vars[k];
    return '';
  };
  const o = opts.overrides ?? {};
  return {
    tenantId: pick('TENANT_ID', 'AZURE_TENANT_ID'),
    clientId: pick('CLIENT_ID', 'AZURE_CLIENT_ID'),
    clientSecret: pick('CLIENT_SECRET', 'AZURE_CLIENT_SECRET'),
    scope: pick('SCOPE') || 'https://cognitiveservices.azure.com/.default',
    apiKey: pick('AZURE_OPENAI_API_KEY'),
    endpoint: (o.endpoint || pick('AZURE_OPENAI_ENDPOINT')).replace(/\/+$/, ''),
    apiVersion: o.apiVersion || pick('OPENAI_API_VERSION', 'AZURE_OPENAI_API_VERSION'),
    deployment: o.deployment || pick('AZURE_OPENAI_CHAT_DEPLOYMENT_NAME', 'AZURE_OPENAI_DEPLOYMENT'),
    subagentDeployment: o.subagentDeployment || pick('AZURE_OPENAI_SUBAGENT_DEPLOYMENT_NAME'),
    authorityHost: (pick('AZURE_AUTHORITY_HOST') || 'https://login.microsoftonline.com').replace(/\/+$/, ''),
    source,
  };
}

/** Names of the settings still missing, in the user's own vocabulary. Empty means ready. */
export function missingSettings(c: ConnectionConfig): string[] {
  const missing: string[] = [];
  if (!c.endpoint) missing.push('AZURE_OPENAI_ENDPOINT');
  if (!c.deployment) missing.push('AZURE_OPENAI_CHAT_DEPLOYMENT_NAME');
  if (!c.apiVersion) missing.push('OPENAI_API_VERSION');
  if (!c.apiKey) {
    if (!c.tenantId) missing.push('TENANT_ID');
    if (!c.clientId) missing.push('CLIENT_ID');
    if (!c.clientSecret) missing.push('CLIENT_SECRET');
  }
  return missing;
}

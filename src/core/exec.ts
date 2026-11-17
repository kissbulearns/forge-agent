import { spawn } from 'node:child_process';
import type { CommandResult } from './types';

const MAX_OUTPUT = 400_000;

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  shell?: string;
  onOutput?: (chunk: string) => void;
}

/** Runs a shell command, streaming combined output. Kills the whole process tree on stop or timeout. */
export function execCommand(command: string, opts: ExecOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', SF_AUTOUPDATE_DISABLE: 'true', SF_DISABLE_TELEMETRY: 'true', CI: '1' };
    let child;
    try {
      child = spawn(command, {
        cwd: opts.cwd,
        shell: opts.shell || true,
        env,
        detached: !win,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ exitCode: null, output: `Could not start the command: ${(e as Error).message}`, timedOut: false });
      return;
    }

    let output = '';
    let dropped = 0;
    let timedOut = false;
    let settled = false;

    const onData = (buf: Buffer) => {
      const text = buf.toString('utf8');
      if (output.length < MAX_OUTPUT) output += text;
      else dropped += text.length;
      opts.onOutput?.(text);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const kill = () => {
      if (!child.pid) return;
      try {
        if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => kill();
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      if (dropped) output += `\n[... ${dropped} more characters of output dropped ...]`;
      resolve({ exitCode, output, timedOut });
    };
    child.on('error', (e) => {
      output += `\n${e.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

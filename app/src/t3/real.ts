// The real adapters behind the T3 seams. Tests never load them with a live T3: they fake the seams.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { T3Error, type Address, type Cli, type Connect, type Http } from './seams.ts';

export const T3_HOME = process.env.T3CODE_HOME ?? join(homedir(), '.t3');
export const SERVER_RUNTIME = join(T3_HOME, 'userdata', 'server-runtime.json');
export const T3_CLI = join(T3_HOME, 'bin', 't3.cmd');

/** T3's origin from server-runtime.json, read on every call as T3's CLI reads it: T3 may come
 *  back on another port. */
export function runtimeAddress(path = SERVER_RUNTIME): Address {
  return async () => {
    let origin: unknown;
    try {
      origin = JSON.parse(await readFile(path, 'utf8'))?.origin;
    } catch (e) {
      throw new T3Error(`T3's server isn't running (${path}: ${(e as Error).name})`);
    }
    if (typeof origin !== 'string' || !origin) throw new T3Error(`T3's server isn't running (${path} names no origin)`);
    return origin.replace(/\/+$/, '');
  };
}

export const fetchHttp: Http = async (url, request) => {
  const r = await fetch(url, { ...request, signal: AbortSignal.timeout(30_000) });
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: r.status, headers, text: await r.text() };
};

const CMD_SPECIALS = /["%^&|<>!\r\n]/;

/** `t3.cmd` is a batch file, so it runs through cmd.exe: arguments with cmd specials are
 *  refused, and ones with spaces are quoted (docs/t3.md, The CLI). */
export function t3Cli(path = T3_CLI): Cli {
  return (args) => {
    for (const a of args) if (CMD_SPECIALS.test(a)) throw new T3Error(`refusing a t3 argument with a cmd.exe special: ${a}`);
    const line = [path, ...args].map((a) => (/[\s]/.test(a) ? `"${a}"` : a)).join(' ');
    return new Promise((resolve) => {
      execFile('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true, timeout: 60_000 },
        (error, stdout, stderr) => {
          // a t3 that can't start or is killed has no exit code: -1, never a t3 exit code
          const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
          const why = error && typeof error.code !== 'number' ? `${error.message}\n` : '';
          resolve({ code, stdout: String(stdout), stderr: why + String(stderr) });
        });
    });
  };
}

/** Node's WebSocket (undici), which takes headers on the upgrade. */
export const nodeConnect: Connect = (url, headers, on) => {
  const Ws = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
  const ws = new Ws(url, { headers });
  let opened = false;
  let error = '';
  ws.onopen = () => { opened = true; on.open(); };
  ws.onmessage = (e) => on.message(typeof e.data === 'string' ? e.data : Buffer.from(e.data as ArrayBuffer).toString());
  ws.onerror = (e) => { error = (e as ErrorEvent).message ?? ''; };
  ws.onclose = (e) => on.closed(opened, e.reason || error || `code ${e.code}`);
  return { send: (t) => ws.send(t), close: () => ws.close() };
};

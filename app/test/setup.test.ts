// The Setup page's checks (#162; #68 story 16): T3 Code installed, running, reachable and signed
// in; at least one provider connected; gh installed and signed in; T3's Resume after usage
// limits off. Each problem names how to fix it. T3 is the fake behind the seams, gh a fake run.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Gh } from '../src/github.ts';
import { checkSetup, type SetupDoors, type SetupReport } from '../src/setup.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { runtimeAddress } from '../src/t3/real.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { FakeT3 } from './fake-t3.ts';

const snapshot = JSON.parse(await readFile(new URL('./fixtures/server-config.json', import.meta.url), 'utf8'));
const SIGNED_IN = JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, host: 'github.com', login: 'ana-k', tokenSource: 'keyring' }] } });

let dir: string;
let t3: FakeT3;
let runtime: string;
let gh: { code: number; stdout: string; stderr: string };
let ghArgs: string[][];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-setup-'));
  t3 = new FakeT3();
  t3.serverConfig = structuredClone(snapshot);
  t3.serverConfig.config.settings.autoResumeLimitedThreads = false;
  runtime = join(dir, 'server-runtime.json');
  await writeFile(runtime, JSON.stringify({ origin: t3.origin }));
  gh = { code: 0, stdout: SIGNED_IN, stderr: '' };
  ghArgs = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function doors(over: Partial<SetupDoors> = {}): SetupDoors {
  const address = runtimeAddress(runtime);
  const fakeGh: Gh = async (args) => { ghArgs.push(args); return gh; };
  return {
    t3Installed: async () => true,
    address,
    ws: new T3Ws(address, t3.cli, t3.http, t3.connect),
    mcp: new T3Mcp(address, t3.cli, t3.http),
    gh: fakeGh,
    ...over,
  };
}
const check = (r: SetupReport, id: string) => r.checks.find((c) => c.id === id)!;

describe('Setup, with everything in place', () => {
  test('every check passes, the connected providers listed and the gh account named', async () => {
    const r = await checkSetup(doors());
    expect(r.checks.map((c) => [c.id, c.state])).toEqual([
      ['t3', 'ok'], ['providers', 'ok'], ['github', 'ok'], ['resume', 'ok'],
    ]);
    expect(r.ok).toBe(true);
    expect(check(r, 'providers').items).toEqual(['Codex', 'Claude', 'Claude (reviews, no tools)']);
    expect(check(r, 'github').summary).toContain('ana-k');
    expect(check(r, 't3').summary).toContain('0.1.9');
    expect(ghArgs).toEqual([['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']]);
    // the app signed in both ways: the WebSocket and MCP
    expect(t3.toolCalls.map((c) => c.tool)).toContain('t3_project_list');
  });
});

describe('Setup names what is missing and how to fix it', () => {
  test("T3 not installed", async () => {
    const r = await checkSetup(doors({ t3Installed: async () => false }));
    expect(check(r, 't3')).toMatchObject({ state: 'bad', summary: "T3 Code isn't installed." });
    expect(check(r, 't3').fix).toMatch(/Install T3 Code/);
    expect(r.ok).toBe(false);
  });

  test('T3 down: its providers and settings wait on it, gh is still checked', async () => {
    await rm(runtime);
    const r = await checkSetup(doors());
    expect(check(r, 't3')).toMatchObject({ state: 'bad', summary: "T3 Code isn't running." });
    expect(check(r, 't3').fix).toMatch(/Open T3 Code/);
    expect(check(r, 't3').detail).toMatch(/server-runtime\.json/);
    expect(check(r, 'providers').state).toBe('waiting');
    expect(check(r, 'resume').state).toBe('waiting');
    expect(check(r, 'github').state).toBe('ok');
  });

  test("T3 running but not answering at its address", async () => {
    t3.port = 4000; // the runtime file names the old port: nothing answers there
    const r = await checkSetup(doors());
    expect(check(r, 't3').state).toBe('bad');
    expect(check(r, 't3').summary).toBe("T3 Code isn't answering at http://127.0.0.1:3773.");
    expect(check(r, 't3').fix).toMatch(/Restart T3 Code/);
  });

  test("T3 refusing the sign-in", async () => {
    const cli = t3.cli;
    t3.cli = async (args) => (args[1] === 'pairing' ? { code: 1, stdout: '', stderr: 'pairing is switched off' } : cli(args));
    const r = await checkSetup(doors());
    expect(check(r, 't3')).toMatchObject({ state: 'bad', summary: "The runner couldn't sign in to T3 Code." });
    expect(check(r, 't3').detail).toMatch(/pairing is switched off/);
  });

  test('no provider connected', async () => {
    for (const p of t3.serverConfig.config.providers) { p.status = 'error'; p.message = `${p.displayName} is not signed in.`; }
    t3.serverConfig.config.providers.at(-1).enabled = false;
    const r = await checkSetup(doors());
    expect(check(r, 'providers')).toMatchObject({ state: 'bad', summary: 'No provider is connected in T3 Code.' });
    expect(check(r, 'providers').fix).toMatch(/switch on a provider and sign in/);
    expect(check(r, 'providers').detail).toBe('Codex: Codex is not signed in.\nClaude: Claude is not signed in.\nClaude (reviews, no tools): Claude (reviews, no tools) is not signed in.');
    expect(check(r, 't3').state).toBe('ok');
  });

  test("T3's Resume after usage limits on", async () => {
    t3.serverConfig.config.settings.autoResumeLimitedThreads = true;
    const r = await checkSetup(doors());
    expect(check(r, 'resume').state).toBe('bad');
    expect(check(r, 'resume').fix).toMatch(/turn off Resume after usage limits/);
  });

  test("a T3 without the setting passes it", async () => {
    delete t3.serverConfig.config.settings.autoResumeLimitedThreads;
    const r = await checkSetup(doors());
    expect(check(r, 'resume')).toMatchObject({ state: 'ok', summary: "This T3 Code doesn't have the setting, so nothing races the runner." });
  });

  test('gh signed out', async () => {
    gh = { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n' };
    const r = await checkSetup(doors());
    expect(check(r, 'github')).toMatchObject({ state: 'bad', summary: "gh isn't signed in to GitHub." });
    expect(check(r, 'github').fix).toMatch(/gh auth login/);
    expect(check(r, 'github').detail).toMatch(/not logged into any GitHub hosts/);
  });

  test("gh's token no longer works", async () => {
    gh = { code: 1, stdout: JSON.stringify({ hosts: { 'github.com': [{ state: 'error', active: true, host: 'github.com', login: 'ana-k', error: 'HTTP 401: Bad credentials' }] } }), stderr: '' };
    const r = await checkSetup(doors());
    expect(check(r, 'github')).toMatchObject({ state: 'bad', summary: "gh's sign-in as ana-k no longer works.", detail: 'HTTP 401: Bad credentials' });
  });

  test('gh not installed', async () => {
    gh = { code: -1, stdout: '', stderr: 'spawn gh ENOENT\n' };
    const r = await checkSetup(doors());
    expect(check(r, 'github')).toMatchObject({ state: 'bad', summary: "GitHub's CLI, gh, isn't installed." });
    expect(check(r, 'github').fix).toMatch(/cli\.github\.com/);
  });
});

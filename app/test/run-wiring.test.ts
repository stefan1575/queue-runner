// The run loop as the app wires it (`src/run-wiring.ts`, #219): the served repos read once at
// start, as Python reads config.toml, and the run loop's own job log in the state folder.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GitHubError } from '../src/github.ts';
import { ConfigError, firstCatalog, JOB_LOG, jobLog, readRepos, waitForRepos } from '../src/run-wiring.ts';
import type { RepoChoice } from '../src/settings.ts';
import { T3Catalog } from '../src/t3/catalog-source.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-wiring-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Project = { id: string; title: string; folder: string; remote: string | null | Error };

/** T3's project list over MCP and gh's answers, each project's remote and each repo's default
 *  branch (an Error: gh failed). */
function doors(projects: Project[], bases: Record<string, string | Error>) {
  const calls: string[] = [];
  const mcp = { call: async (name: string) => {
    calls.push(name);
    return { projects: projects.map((p) => ({ id: p.id, title: p.title, workspaceRoot: p.folder })), nextCursor: null };
  } };
  const github = {
    remoteOf: async (folder: string) => {
      const r = projects.find((p) => p.folder === folder)!.remote;
      if (r instanceof Error) throw r;
      return r === null ? null : { nameWithOwner: r, url: `https://github.com/${r}` };
    },
    defaultBranch: async (repo: string) => {
      calls.push(`base ${repo}`);
      const b = bases[repo];
      if (b === undefined || b instanceof Error) throw b ?? new GitHubError('not found');
      return b;
    },
  };
  return { mcp, github: github as any, calls };
}

const choice = (o: Partial<RepoChoice> = {}): RepoChoice => ({ served: true, merge: 'me', seen: true, ...o });

describe('the config', () => {
  test("the served repos are named by their GitHub owner/name, on their base, merged by whom Settings says, in T3's order", async () => {
    const d = doors([
      { id: 'p1', title: 'Widget app', folder: 'C:/code/widget', remote: 'owner/widget' },
      { id: 'p2', title: 'Off', folder: 'C:/code/off', remote: 'owner/off' },
      { id: 'p3', title: 'Local', folder: 'C:/code/local', remote: null },
      { id: 'p4', title: 'Docs', folder: 'C:/code/docs', remote: 'owner/docs' },
    ], { 'owner/widget': 'main', 'owner/docs': 'trunk' });
    const saved = { p1: choice({ merge: 'runner' }), p2: choice({ served: false }), p3: choice(), p4: choice() };
    expect(await readRepos(d.mcp, d.github, saved, () => {})).toEqual([
      { name: 'owner/widget', github: 'owner/widget', path: 'C:/code/widget', base: 'main', merge: 'runner' },
      { name: 'owner/docs', github: 'owner/docs', path: 'C:/code/docs', base: 'trunk', merge: 'me' },
    ]);
    // a repo not served has its base read never
    expect(d.calls.filter((c) => c.startsWith('base')).sort()).toEqual(['base owner/docs', 'base owner/widget']);
  });

  test('a remote two served projects share is served from the first, and the other is said', async () => {
    const d = doors([
      { id: 'p1', title: 'a', folder: 'C:/one/a', remote: 'owner/a' },
      { id: 'p2', title: 'a', folder: 'C:/two/a', remote: 'owner/a' },
    ], { 'owner/a': 'main' });
    const said: string[] = [];
    const repos = await readRepos(d.mcp, d.github, { p1: choice(), p2: choice() }, (l) => said.push(l));
    expect(repos.map((r) => r.path)).toEqual(['C:/one/a']);
    expect(said).toEqual(["C:/two/a isn't served: C:/one/a serves owner/a already"]);
  });

  test("a served repo whose remote or base gh can't read fails the read: the loop doesn't start on part of them", async () => {
    const remote = doors([{ id: 'p1', title: 'a', folder: 'C:/a', remote: new GitHubError('HTTP 401') }], {});
    await expect(readRepos(remote.mcp, remote.github, { p1: choice() }, () => {}))
      .rejects.toEqual(new ConfigError("a: gh couldn't read its GitHub remote (HTTP 401)"));
    const base = doors([{ id: 'p1', title: 'a', folder: 'C:/a', remote: 'owner/a' }], { 'owner/a': new GitHubError('offline') });
    await expect(readRepos(base.mcp, base.github, { p1: choice() }, () => {}))
      .rejects.toEqual(new ConfigError("owner/a: its base branch couldn't be read (offline)"));
    // a repo not served is no part of it
    const off = doors([{ id: 'p1', title: 'a', folder: 'C:/a', remote: new GitHubError('HTTP 401') }], {});
    expect(await readRepos(off.mcp, off.github, { p1: choice({ served: false }) }, () => {})).toEqual([]);
  });

  test('the desktop app tries the read again every 30 seconds until it reads them, saying why once', async () => {
    const said: string[] = [];
    const slept: number[] = [];
    let tries = 0;
    const repos = await waitForRepos(async () => {
      tries += 1;
      if (tries < 3) throw new ConfigError('owner/a: its base branch couldn\'t be read (offline)');
      return [{ name: 'owner/a', github: 'owner/a', path: 'C:/a', base: 'main', merge: 'me' }];
    }, (l) => said.push(l), async (s) => { slept.push(s); });
    expect([repos.length, slept]).toEqual([1, [30, 30]]);
    expect(said).toEqual(["Waiting to read the served repos: owner/a: its base branch couldn't be read (offline)", 'The served repos are read']);
  });

  test("--once's wait for T3's models ends when T3 refuses the stream, with why (#255 F12)", async () => {
    const ws = { subscribe: () => ({ close: () => {}, done: Promise.reject(new Error('T3 refused the WebSocket')) }) };
    const catalog = T3Catalog.start(ws as any, 60_000);
    try {
      let got: string | null | 'still waiting' = 'still waiting';
      void firstCatalog(catalog).then((why) => { got = why; });
      for (let i = 0; i < 10; i++) await Promise.resolve();   // the refusal and the wait's answer settle
      expect(got).toBe('T3 refused the WebSocket');
      expect(await firstCatalog(catalog)).toBe('T3 refused the WebSocket');   // already failed: at once
    } finally {
      catalog.stop();
    }
  });

  test("the run loop's job log is its own file, and the desktop app's old jobs.jsonl is left unread (#255 F4)", async () => {
    // an old-format log with a build still open, its repo a T3 project id
    const old = join(dir, 'jobs.jsonl');
    const line = { event: 'start', id: 'j1', kind: 'build', repo: 'p-a', github: 'owner/a', issue: 4, branch: 'b', title: 't', at: '2026-11-20T00:00:00Z' };
    await writeFile(old, `${JSON.stringify(line)}\n`);
    const log = jobLog(dir);
    expect(log.path).toBe(join(dir, JOB_LOG));
    expect(JOB_LOG).not.toBe('jobs.jsonl');
    expect(log.jobs()).toEqual([]);
  });
});

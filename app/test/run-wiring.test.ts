// The run loop as the app wires it (`src/run-wiring.ts`, #219): the projects served at start, read
// as Python reads config.toml (one that can't be read joins once it reads, review 1 of #261, F4),
// and the run loop's own job log in the state folder.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { run } from '../src/app.ts';
import { GitHubError } from '../src/github.ts';
import { IDLE, Runner } from '../src/run.ts';
import { firstCatalog, JOB_LOG, jobLog, joinWhenRead, runConfig, ServedRepos, waitForRepos } from '../src/run-wiring.ts';
import type { RepoChoice } from '../src/settings.ts';
import { JobLog } from '../src/state.ts';
import { T3Catalog } from '../src/t3/catalog-source.ts';
import { T3Error } from '../src/t3/seams.ts';
import { FakeGit, FakeGitHubWithPulls } from './fakes.ts';
import { FakeT3 } from './fakes-t3.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-wiring-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Project = { id: string; title: string; folder: string; remote: string | null | Error };

/** T3's project list over MCP and gh's answers, each project's remote and each repo's default
 *  branch (an Error: gh failed), and which folders are there (`gone`: missing), each changeable
 *  between reads. */
function doors(projects: Project[], bases: Record<string, string | Error>) {
  const calls: string[] = [];
  const gone = new Set<string>();
  const mcp = { call: async (name: string) => {
    calls.push(name);
    return { projects: projects.map((p) => ({ id: p.id, title: p.title, workspaceRoot: p.folder })), nextCursor: null };
  } };
  const github = {
    remoteOf: async (folder: string) => {
      if (gone.has(folder)) return null;   // as GhGitHub: a folder that's gone has no remote
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
  const exists = (folder: string) => !gone.has(folder);
  return { mcp, github: github as any, calls, gone, exists, projects, bases };
}

const choice = (o: Partial<RepoChoice> = {}): RepoChoice => ({ served: true, merge: 'me', seen: true, ...o });

/** The served repos read through `d`, what they say into `said`. */
const read = (d: ReturnType<typeof doors>, saved: Record<string, RepoChoice>, said: string[] = []) =>
  ServedRepos.read(d.mcp, d.github, saved, (l) => said.push(l), d.exists);

describe('the config', () => {
  test("the served repos are named by their GitHub owner/name, on their base, merged by whom Settings says, in T3's order", async () => {
    const d = doors([
      { id: 'p1', title: 'Widget app', folder: 'C:/code/widget', remote: 'owner/widget' },
      { id: 'p2', title: 'Off', folder: 'C:/code/off', remote: 'owner/off' },
      { id: 'p4', title: 'Docs', folder: 'C:/code/docs', remote: 'owner/docs' },
    ], { 'owner/widget': 'main', 'owner/docs': 'trunk' });
    const saved = { p1: choice({ merge: 'runner' }), p2: choice({ served: false }), p4: choice() };
    const said: string[] = [];
    const served = await read(d, saved, said);
    expect(served.repos).toEqual([
      { name: 'owner/widget', github: 'owner/widget', path: 'C:/code/widget', base: 'main', merge: 'runner' },
      { name: 'owner/docs', github: 'owner/docs', path: 'C:/code/docs', base: 'trunk', merge: 'me' },
    ]);
    expect([served.unread.size, said]).toEqual([0, []]);
    // a repo not served has its base read never
    expect(d.calls.filter((c) => c.startsWith('base')).sort()).toEqual(['base owner/docs', 'base owner/widget']);
  });

  test('a remote two served projects share is served from the first, and the other is said', async () => {
    const d = doors([
      { id: 'p1', title: 'a', folder: 'C:/one/a', remote: 'owner/a' },
      { id: 'p2', title: 'a', folder: 'C:/two/a', remote: 'owner/a' },
    ], { 'owner/a': 'main' });
    const said: string[] = [];
    const served = await read(d, { p1: choice(), p2: choice() }, said);
    expect(served.repos.map((r) => r.path)).toEqual(['C:/one/a']);
    expect(served.unread.size).toBe(0);
    expect(said).toEqual(["C:/two/a isn't served: C:/one/a serves owner/a already"]);
  });

  test("a served repo whose remote or base can't be read, or that has no remote, is named in one line; the others are served (review 1 of #261, F4)", async () => {
    const d = doors([
      { id: 'p1', title: 'a', folder: 'C:/a', remote: new GitHubError('HTTP 401') },
      { id: 'p2', title: 'b', folder: 'C:/b', remote: 'owner/b' },
      { id: 'p3', title: 'c', folder: 'C:/c', remote: 'owner/c' },
      { id: 'p4', title: 'd', folder: 'C:/d', remote: null },
      { id: 'p5', title: 'off', folder: 'C:/off', remote: new GitHubError('HTTP 401') },
    ], { 'owner/b': new GitHubError('offline'), 'owner/c': 'main' });
    const said: string[] = [];
    const served = await read(d, { p1: choice(), p2: choice(), p3: choice(), p4: choice(), p5: choice({ served: false }) }, said);
    expect(served.repos.map((r) => r.name)).toEqual(['owner/c']);
    expect(said).toEqual([
      "a isn't served until it's read: gh couldn't read its GitHub remote (HTTP 401)",
      "b isn't served until it's read: its base branch couldn't be read (offline)",
      "d isn't served until it's read: C:/d has no GitHub remote",
    ]);
    // a repo not served is no part of it; a name gh read is kept, for the jobs open there
    expect(served.names()).toEqual([null, 'owner/b', null]);
  });

  test('a served repo that reads later joins, said once; a reason is said again only when it changes (review 1 of #261, F4)', async () => {
    const d = doors([{ id: 'p1', title: 'a', folder: 'C:/a', remote: new GitHubError('HTTP 401') }], { 'owner/a': new GitHubError('offline') });
    const said: string[] = [];
    const served = await read(d, { p1: choice({ merge: 'runner' }) }, said);
    expect(await served.retry()).toEqual([]);   // the same reason: not said again
    d.projects[0]!.remote = 'owner/a';
    expect(await served.retry()).toEqual([]);   // a new reason
    expect(await served.retry()).toEqual([]);
    d.bases['owner/a'] = 'main';
    expect(await served.retry()).toEqual([{ name: 'owner/a', github: 'owner/a', path: 'C:/a', base: 'main', merge: 'runner' }]);
    expect([served.repos.length, served.unread.size]).toEqual([1, 0]);
    expect(said).toEqual([
      "a isn't served until it's read: gh couldn't read its GitHub remote (HTTP 401)",
      "a isn't served until it's read: its base branch couldn't be read (offline)",
      'a is read: owner/a joins the loop',
    ]);
  });

  test("a served project whose folder is missing is named, and joins once it's back (review 1 of #261, F4)", async () => {
    const d = doors([{ id: 'p1', title: 'a', folder: 'C:/a', remote: 'owner/a' }], { 'owner/a': 'main' });
    d.gone.add('C:/a');
    const said: string[] = [];
    const served = await read(d, { p1: choice() }, said);
    expect(served.repos).toEqual([]);
    expect(said).toEqual(["a isn't served until it's read: its folder C:/a is missing"]);
    d.gone.delete('C:/a');
    expect((await served.retry()).map((r) => r.name)).toEqual(['owner/a']);
    expect(said.at(-1)).toBe('a is read: owner/a joins the loop');
  });

  test('a repo that reads later on a remote served already is said and dropped', async () => {
    const d = doors([
      { id: 'p1', title: 'a', folder: 'C:/one/a', remote: 'owner/a' },
      { id: 'p2', title: 'a2', folder: 'C:/two/a', remote: new GitHubError('HTTP 401') },
    ], { 'owner/a': 'main' });
    const said: string[] = [];
    const served = await read(d, { p1: choice(), p2: choice() }, said);
    d.projects[1]!.remote = 'owner/a';
    expect(await served.retry()).toEqual([]);
    expect([served.repos.length, served.unread.size]).toEqual([1, 0]);
    expect(said.at(-1)).toBe("C:/two/a isn't served: C:/one/a serves owner/a already");
  });

  test("the desktop app tries T3's project list again every 30 seconds until it reads, saying why once", async () => {
    const said: string[] = [];
    const slept: number[] = [];
    let tries = 0;
    const d = doors([{ id: 'p1', title: 'a', folder: 'C:/a', remote: 'owner/a' }], { 'owner/a': 'main' });
    const served = await waitForRepos(async () => {
      tries += 1;
      if (tries < 3) throw new T3Error('T3 is down');
      return read(d, { p1: choice() });
    }, (l) => said.push(l), async (s) => { slept.push(s); });
    expect([served.repos.length, slept]).toEqual([1, [30, 30]]);
    expect(said).toEqual(["Waiting to read T3's projects: T3 is down", "T3's projects are read"]);
  });

  test('the desktop app reads an unread repo again every 30 seconds, and it joins the loop once it reads (review 1 of #261, F4)', async () => {
    const d = doors([{ id: 'p1', title: 'a', folder: 'C:/a', remote: 'owner/a' }], { 'owner/a': new GitHubError('offline') });
    const served = await read(d, { p1: choice() });
    const slept: number[] = [];
    const joined: string[] = [];
    await joinWhenRead(served, (r) => joined.push(r.name), async (s) => {
      slept.push(s);
      if (slept.length === 2) d.bases['owner/a'] = 'main';
    });
    expect([slept, joined]).toEqual([[30, 30], ['owner/a']]);
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

describe('repos are independent, as in Python (review 1 of #261, F4)', () => {
  /** Two served repos, owner/a and owner/b, owner/b unreadable at start (`spoil`), and a build each
   *  that a stopped runner left open, its thread ended in T3; the runner on what read, as
   *  `main.ts` and the desktop app make it, saying into `said`. */
  async function two(spoil: (d: ReturnType<typeof doors>) => void) {
    const d = doors([
      { id: 'pa', title: 'a', folder: 'C:/a', remote: 'owner/a' },
      { id: 'pb', title: 'b', folder: 'C:/b', remote: 'owner/b' },
    ], { 'owner/a': 'main', 'owner/b': 'main' });
    spoil(d);
    const jobs = new JobLog(join(dir, JOB_LOG));
    const t3 = new FakeT3();
    for (const repo of ['owner/a', 'owner/b']) {
      const job = jobs.started({ kind: 'build', repo, issue: 4, branch: 'claude/a-ticket-4', title: `Queue runner build: ${repo}#4` });
      t3.add(`mcp:${repo}`, job.title, 'completed');
    }
    const said: string[] = [];
    const make = async (out: (line: string) => void) => {
      const served = await ServedRepos.read(d.mcp, d.github, { pa: choice(), pb: choice() }, out, d.exists);
      const runner = new Runner(runConfig([...served.repos], dir, 60), {
        github: new FakeGitHubWithPulls() as any, t3, git: new FakeGit() as any, jobs, out, log_line: () => {},
        unread: () => served.names(),
      });
      return { served, runner };
    };
    const outcome = (repo: string) => jobs.jobs().find((j) => j.repo === repo)!.outcome;
    return { d, jobs, said, make, outcome };
  }

  test("one repo's read fails at start: the other starts and settles its finished build in the same pass, and the failed one joins once it reads", async () => {
    const w = await two((d) => { d.bases['owner/b'] = new GitHubError('offline'); });
    const { served, runner } = await w.make((l) => w.said.push(l));
    expect(await runner.run_pass()).toBe(IDLE);
    expect(w.outcome('owner/a')).toBe('done-no-pr');
    expect(w.outcome('owner/b')).toBeNull();   // waits for its repo: no KeyError, not settled in its place
    expect(await runner.run_pass()).toBe(IDLE);   // said once
    expect(w.said.filter((l) => /^b |owner\/b/.test(l))).toEqual([
      "b isn't served until it's read: its base branch couldn't be read (offline)",
      'build owner/b#4 waits for owner/b to be read',
    ]);
    w.d.bases['owner/b'] = 'main';
    for (const repo of await served.retry()) runner.join(repo);
    expect(await runner.run_pass()).toBe(IDLE);
    expect(w.outcome('owner/b')).toBe('done-no-pr');
    expect(runner.config.repos.map((r) => r.name)).toEqual(['owner/a', 'owner/b']);
  });

  test("a served repo whose folder is missing is named, its job waits, and it joins once the folder is back", async () => {
    const w = await two((d) => { d.gone.add('C:/b'); });
    const { served, runner } = await w.make((l) => w.said.push(l));
    await runner.run_pass();
    expect([w.outcome('owner/a'), w.outcome('owner/b')]).toEqual(['done-no-pr', null]);
    expect(w.said).toContain("b isn't served until it's read: its folder C:/b is missing");
    w.d.gone.delete('C:/b');
    for (const repo of await served.retry()) runner.join(repo);
    await runner.run_pass();
    expect(w.outcome('owner/b')).toBe('done-no-pr');
  });

  test('--once with one unreadable repo runs the other and names it', async () => {
    const w = await two((d) => { d.projects[1]!.remote = new GitHubError('HTTP 401'); });
    let printed = '';
    const code = await run(['--once'], {
      mcp: null as any, ws: null as any, github: null as any,
      runner: async (out) => (await w.make(out)).runner,
    }, (s) => { printed += s; });
    expect(code).toBe(0);
    expect([w.outcome('owner/a'), w.outcome('owner/b')]).toEqual(['done-no-pr', null]);
    expect(printed).toContain("b isn't served until it's read: gh couldn't read its GitHub remote (HTTP 401)\n");
    expect(printed).toContain('build owner/a#4 ended: done-no-pr');
  });

  test("once every served repo has read, a job open in a repo the config doesn't have waits for nothing, as in Python", async () => {
    const w = await two(() => {});
    const { runner } = await w.make(() => {});
    runner.config = runConfig(runner.config.repos.filter((r) => r.name === 'owner/a'), dir, 60);
    await runner.run_pass();
    // Python's self.repos.get: no repo, so no project to find its thread in
    expect(w.outcome('owner/b')).toBe('not-started');
  });
});

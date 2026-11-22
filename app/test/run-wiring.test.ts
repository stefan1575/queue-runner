// The run loop as the app wires it (`src/run-wiring.ts`, #219): the projects served at start, each
// read on its own and taken by the planner at a pass's start (review 1 of #261, F4; review 2, F9
// and F10), and the run loop's own job log in the state folder.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { run } from '../src/app.ts';
import { GitHubError } from '../src/github.ts';
import { BUSY, IDLE, Runner, STARTED } from '../src/run.ts';
import { firstCatalog, JOB_LOG, jobLog, runConfig, ServedRepos, waitForRepos } from '../src/run-wiring.ts';
import type { RepoChoice } from '../src/settings.ts';
import { JobLog } from '../src/state.ts';
import { T3Catalog } from '../src/t3/catalog-source.ts';
import { T3Error } from '../src/t3/seams.ts';
import { FakeGit, FakeGitHubWithPulls, issue } from './fakes.ts';
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
 *  branch (an Error: gh failed; `held`: answered once its promise settles; `hang`: never answered),
 *  and which folders are there (`gone`: missing), each changeable between reads. */
function doors(projects: Project[], bases: Record<string, string | Error>) {
  const calls: string[] = [];
  const gone = new Set<string>();
  const held = new Map<string, Promise<void>>();
  const hang = new Set<string>();
  const mcp = { call: async (name: string) => {
    calls.push(name);
    return { projects: projects.map((p) => ({ id: p.id, title: p.title, workspaceRoot: p.folder })), nextCursor: null };
  } };
  const github = {
    remoteOf: async (folder: string) => {
      calls.push(`remote ${folder}`);
      if (gone.has(folder)) return null;   // as GhGitHub: a folder that's gone has no remote
      const r = projects.find((p) => p.folder === folder)!.remote;
      if (r instanceof Error) throw r;
      return r === null ? null : { nameWithOwner: r, url: `https://github.com/${r}` };
    },
    defaultBranch: async (repo: string) => {
      calls.push(`base ${repo}`);
      if (hang.has(repo)) await new Promise(() => {});
      await held.get(repo);
      const b = bases[repo];
      if (b === undefined || b instanceof Error) throw b ?? new GitHubError('not found');
      return b;
    },
  };
  const exists = (folder: string) => !gone.has(folder);
  return { mcp, github: github as any, calls, gone, held, hang, exists, projects, bases };
}

const choice = (o: Partial<RepoChoice> = {}): RepoChoice => ({ served: true, merge: 'me', seen: true, ...o });

/** The served repos listed through `d`, saying into `said` (`sleep`: the wait before a failed read
 *  is tried again, in the desktop app). */
const list = (d: ReturnType<typeof doors>, saved: Record<string, RepoChoice>, said: string[] = [],
  sleep: (s: number) => Promise<void> = async () => {}) =>
  ServedRepos.list(d.mcp, d.github, saved, (l) => said.push(l), d.exists, sleep);

/** The served repos read once through `d`, as `--once` reads them, and taken, as its pass takes them. */
async function read(d: ReturnType<typeof doors>, saved: Record<string, RepoChoice>, said: string[] = []): Promise<ServedRepos> {
  const served = await list(d, saved, said);
  await served.read_once();
  served.take();
  return served;
}

/** Each unread repo read once more, and the repos a pass takes then. */
async function again(served: ServedRepos): Promise<string[]> {
  await served.read_once();
  return served.take().repos.map((r) => r.name);
}

/** Until the microtasks queued now have run (a fake's answer, and what it sets going). */
const settled = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

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
    // a repo not served has its remote and base read never
    expect(d.calls.filter((c) => !c.startsWith('t3')).sort()).toEqual(['base owner/docs', 'base owner/widget', 'remote C:/code/docs', 'remote C:/code/widget']);
  });

  test("listing T3's projects reads no repo: each served one is unread until its read ends and a pass takes it", async () => {
    const d = doors([{ id: 'p1', title: 'a', folder: 'C:/a', remote: 'owner/a' }], { 'owner/a': 'main' });
    const served = await list(d, { p1: choice() });
    expect([d.calls, served.take()]).toEqual([['t3_project_list'], { repos: [], unread: [null] }]);
    await served.read_once();
    expect(served.names()).toEqual([null]);   // read, and not taken yet: still unread
    expect(served.take()).toEqual({ repos: [{ name: 'owner/a', github: 'owner/a', path: 'C:/a', base: 'main', merge: 'me' }], unread: [] });
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
    // each read says its own, as it ends
    expect(said.sort()).toEqual([
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
    expect(await again(served)).toEqual([]);   // the same reason: not said again
    d.projects[0]!.remote = 'owner/a';
    expect(await again(served)).toEqual([]);   // a new reason
    expect(await again(served)).toEqual([]);
    d.bases['owner/a'] = 'main';
    expect(await again(served)).toEqual(['owner/a']);
    expect(served.repos).toEqual([{ name: 'owner/a', github: 'owner/a', path: 'C:/a', base: 'main', merge: 'runner' }]);
    expect(served.unread.size).toBe(0);
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
    expect(await again(served)).toEqual(['owner/a']);
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
    expect(await again(served)).toEqual(['owner/a']);
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
      return list(d, { p1: choice() });
    }, (l) => said.push(l), async (s) => { slept.push(s); });
    expect([served.unread.size, slept]).toEqual([1, [30, 30]]);
    expect(said).toEqual(["Waiting to read T3's projects: T3 is down", "T3's projects are read"]);
  });

  test('the desktop app tries a failed read again 30 seconds after it fails, one at a time, and a read that ends wakes the next pass (review 2 of #261, F9)', async () => {
    const d = doors([{ id: 'p1', title: 'a', folder: 'C:/a', remote: 'owner/a' }], { 'owner/a': new GitHubError('offline') });
    const slept: number[] = [];
    let woke = 0;
    const served = await list(d, { p1: choice() }, [], async (s) => {
      slept.push(s);
      if (slept.length === 2) d.bases['owner/a'] = 'main';
    });
    served.start(() => { woke += 1; });
    await settled();
    expect([slept, woke]).toEqual([[30, 30], 1]);
    // three reads, one after another: each after the last one's wait
    expect(d.calls.filter((c) => c === 'base owner/a').length).toBe(3);
    expect(served.take().repos.map((r) => r.name)).toEqual(['owner/a']);
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

describe('repos are independent, as in Python (review 1 of #261, F4; review 2, F9 and F10)', () => {
  /** Two served repos, owner/a and owner/b (`spoil` sets what reads), and a build each that a
   *  stopped runner left open, its thread ended in T3 (`ids`: the job log has its thread's id); the
   *  runner on the served repos, taken at each pass's start, as `main.ts` and the desktop app make
   *  it, saying into `said`. */
  async function two(spoil: (d: ReturnType<typeof doors>) => void, ids = false) {
    const d = doors([
      { id: 'pa', title: 'a', folder: 'C:/a', remote: 'owner/a' },
      { id: 'pb', title: 'b', folder: 'C:/b', remote: 'owner/b' },
    ], { 'owner/a': 'main', 'owner/b': 'main' });
    spoil(d);
    const jobs = new JobLog(join(dir, JOB_LOG));
    const t3 = new FakeT3();
    for (const repo of ['owner/a', 'owner/b']) {
      const job = jobs.started({ kind: 'build', repo, issue: 4, branch: 'claude/a-ticket-4', title: `Queue runner build: ${repo}#4`,
        ...(ids ? { thread_id: `mcp:${repo}` } : {}) });
      t3.add(`mcp:${repo}`, job.title, 'completed');
    }
    const said: string[] = [];
    let github: any = new FakeGitHubWithPulls();
    /** `--once`'s: each repo read once before the pass. */
    const make = async (out: (line: string) => void) => {
      const served = await ServedRepos.list(d.mcp, d.github, { pa: choice(), pb: choice() }, out, d.exists);
      await served.read_once();
      return { served, runner: runner(served, out) };
    };
    const runner = (served: ServedRepos, out: (line: string) => void) => new Runner(runConfig([], dir, 60), {
      github, t3, git: new FakeGit() as any, jobs, out, log_line: () => {}, served: () => served.take(),
      job_choice: () => ({ provider: 'claudeAgent', model: 'claude-opus-5-5', effort: null }),
    });
    const outcome = (repo: string) => jobs.jobs().find((j) => j.repo === repo && j.issue === 4)!.outcome;
    return { d, jobs, t3, said, make, runner, outcome, list: () => list(d, { pa: choice(), pb: choice() }, said),
      issues: (g: any) => { github = g; } };
  }

  test("one repo's read fails at start: the other starts and settles its finished build in the same pass, and the failed one joins once it reads", async () => {
    const w = await two((d) => { d.bases['owner/b'] = new GitHubError('offline'); });
    const served = await w.list();
    await served.read_once();
    const runner = w.runner(served, (l) => w.said.push(l));
    // owner/b's job has no thread id: without its repo's folder, its thread is an unknown, which
    // counts as running (review 2 of #261, F11)
    expect(await runner.run_pass()).toBe(BUSY);
    expect(w.outcome('owner/a')).toBe('done-no-pr');
    expect(w.outcome('owner/b')).toBeNull();   // waits for its repo: no KeyError, not settled in its place
    expect(await runner.run_pass()).toBe(BUSY);   // said once
    expect(w.said.filter((l) => /^b |owner\/b/.test(l))).toEqual([
      "b isn't served until it's read: its base branch couldn't be read (offline)",
      'build owner/b#4 waits for owner/b to be read',
    ]);
    w.d.bases['owner/b'] = 'main';
    await served.read_once();
    expect(await runner.run_pass()).toBe(IDLE);
    expect(w.outcome('owner/b')).toBe('done-no-pr');
    expect(runner.config.repos.map((r) => r.name)).toEqual(['owner/a', 'owner/b']);
  });

  test("one repo's read hangs while the other settles and builds (review 2 of #261, F9)", async () => {
    const w = await two((d) => { d.hang.add('owner/b'); });   // gh never answers for owner/b's base
    w.issues(new FakeGitHubWithPulls({ issues: [issue(5)] }));
    w.t3.outcomes.push([0, 'completed']);
    const served = await w.list();
    let woke = 0;
    const runner = w.runner(served, (l) => w.said.push(l));
    served.start(() => { woke += 1; runner.wake(); });
    await settled();
    expect(woke).toBe(1);   // owner/a's read ended: owner/b's, still running, holds it back nowhere
    expect(await runner.run_pass()).toBe(STARTED);
    expect(w.outcome('owner/a')).toBe('done-no-pr');
    expect(w.t3.starts.map((s) => [s.project, s.title])).toEqual([['C:/a', 'Queue runner build: owner/a#5']]);
    expect(w.outcome('owner/b')).toBeNull();
    expect([runner.config.repos.map((r) => r.name), served.names()]).toEqual([['owner/a'], [null]]);
  });

  test('a repo whose read ends mid-pass joins at the next pass, and this pass goes on without it (review 2 of #261, F10)', async () => {
    let release!: () => void;
    const w = await two((d) => { d.held.set('owner/b', new Promise<void>((r) => { release = r; })); }, true);
    const served = await w.list();
    const runner = w.runner(served, (l) => w.said.push(l));
    served.start(() => runner.wake());
    await settled();   // owner/a has read, owner/b's base is still being read
    // owner/b's read ends while this pass settles owner/a's job
    const show = w.t3.show.bind(w.t3);
    w.t3.show = async (id: string) => {
      if (id === 'mcp:owner/a') {
        release();
        await settled();
      }
      return show(id);
    };
    await runner.run_pass();   // no KeyError: owner/b is still unread for the whole pass
    expect([w.outcome('owner/a'), w.outcome('owner/b')]).toEqual(['done-no-pr', null]);
    expect(runner.config.repos.map((r) => r.name)).toEqual(['owner/a']);
    await runner.run_pass();
    expect(w.outcome('owner/b')).toBe('done-no-pr');
    expect(runner.config.repos.map((r) => r.name)).toEqual(['owner/a', 'owner/b']);
  });

  test("a served repo whose folder is missing is named, its job waits, and it joins once the folder is back", async () => {
    const w = await two((d) => { d.gone.add('C:/b'); });
    const served = await w.list();
    await served.read_once();
    const runner = w.runner(served, (l) => w.said.push(l));
    await runner.run_pass();
    expect([w.outcome('owner/a'), w.outcome('owner/b')]).toEqual(['done-no-pr', null]);
    expect(w.said).toContain("b isn't served until it's read: its folder C:/b is missing");
    w.d.gone.delete('C:/b');
    await served.read_once();
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
    const { served } = await w.make(() => {});
    const a = served.take().repos.filter((r) => r.name === 'owner/a');
    const runner = w.runner(served, () => {});
    runner.served = () => ({ repos: a, unread: [] });
    await runner.run_pass();
    // Python's self.repos.get: no repo, so no project to find its thread in
    expect(w.outcome('owner/b')).toBe('not-started');
  });
});

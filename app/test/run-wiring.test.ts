// The run loop as the app wires it (`src/run-wiring.ts`, #219): the projects served at start, each
// read once from its own git folder with no network call (Stefan's decision on #261), and the run
// loop's own job log in the state folder.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { run } from '../src/app.ts';
import { readFolder, type FolderRead } from '../src/repo-folder.ts';
import { BUSY, IDLE, Runner, STARTED } from '../src/run.ts';
import { firstCatalog, JOB_LOG, jobLog, runConfig, servedRepos, waitForRepos, type Served } from '../src/run-wiring.ts';
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

type Project = { id: string; title: string; folder: string };

/** T3's project list over MCP, and what each folder reads as (`reads`, by folder; changeable). */
function doors(projects: Project[], reads: Record<string, FolderRead>) {
  const calls: string[] = [];
  const mcp = { call: async (name: string) => {
    calls.push(name);
    return { projects: projects.map((p) => ({ id: p.id, title: p.title, workspaceRoot: p.folder })), nextCursor: null };
  } };
  const read = async (folder: string): Promise<FolderRead> => {
    calls.push(`read ${folder}`);
    return reads[folder]!;
  };
  return { mcp, read, calls, reads };
}

const choice = (o: Partial<RepoChoice> = {}): RepoChoice => ({ served: true, merge: 'me', seen: true, ...o });
const ok = (github: string, base = 'main'): FolderRead => ({ github, base });

describe('the config', () => {
  test("the served repos are named by their GitHub owner/name, on their base, merged by whom Settings says, in T3's order", async () => {
    const d = doors([
      { id: 'p1', title: 'Widget app', folder: 'C:/code/widget' },
      { id: 'p2', title: 'Off', folder: 'C:/code/off' },
      { id: 'p4', title: 'Docs', folder: 'C:/code/docs' },
    ], { 'C:/code/widget': ok('owner/widget'), 'C:/code/off': ok('owner/off'), 'C:/code/docs': ok('owner/docs', 'trunk') });
    const said: string[] = [];
    const served = await servedRepos(d.mcp, { p1: choice({ merge: 'runner' }), p2: choice({ served: false }), p4: choice() },
      (l) => said.push(l), d.read);
    expect(served).toEqual({ repos: [
      { name: 'owner/widget', github: 'owner/widget', path: 'C:/code/widget', base: 'main', merge: 'runner' },
      { name: 'owner/docs', github: 'owner/docs', path: 'C:/code/docs', base: 'trunk', merge: 'me' },
    ], unread: [] });
    expect(said).toEqual([]);
    // a repo not served has its folder read never
    expect(d.calls).toEqual(['t3_project_list', 'read C:/code/widget', 'read C:/code/docs']);
  });

  test('each folder is read by local git, its owner/name from its origin remote and its base from origin/HEAD, with no GitHub call', async () => {
    const ran: string[][] = [];
    const git = async (args: string[]): Promise<[number, string, string]> => {
      ran.push(args);
      const a = args[1] === 'C:/a';
      if (args.includes('get-url')) return [0, a ? 'https://github.com/owner/a.git\n' : 'git@github.com:owner/b.git\n', ''];
      return [0, a ? 'origin/main\n' : 'origin/trunk\n', ''];
    };
    const d = doors([{ id: 'pa', title: 'a', folder: 'C:/a' }, { id: 'pb', title: 'b', folder: 'C:/b' }], {});
    // `servedRepos` takes no GitHub door at all: the read is the folder's
    const served = await servedRepos(d.mcp, { pa: choice(), pb: choice() }, () => {}, (f) => readFolder(f, git, () => true));
    expect(served.repos.map((r) => [r.github, r.base])).toEqual([['owner/a', 'main'], ['owner/b', 'trunk']]);
    expect(ran.map((a) => a.slice(2).join(' ')).sort()).toEqual([
      'remote get-url origin', 'remote get-url origin',
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD', 'symbolic-ref --quiet --short refs/remotes/origin/HEAD',
    ]);
  });

  test('a remote two served projects share is served from the first, and the other is said', async () => {
    const d = doors([{ id: 'p1', title: 'a', folder: 'C:/one/a' }, { id: 'p2', title: 'a', folder: 'C:/two/a' }],
      { 'C:/one/a': ok('owner/a'), 'C:/two/a': ok('owner/a') });
    const said: string[] = [];
    const served = await servedRepos(d.mcp, { p1: choice(), p2: choice() }, (l) => said.push(l), d.read);
    expect([served.repos.map((r) => r.path), served.unread]).toEqual([['C:/one/a'], []]);
    expect(said).toEqual(["C:/two/a isn't served: C:/one/a serves owner/a already"]);
  });

  test("GitHub names aren't case-sensitive: clones that differ only in case are one repo, and a case-only remote edit keeps the repo's name (review 1 of #262, F2)", async () => {
    const d = doors([{ id: 'p1', title: 'a', folder: 'C:/one/a' }, { id: 'p2', title: 'a', folder: 'C:/two/a' }],
      { 'C:/one/a': ok('Owner/Repo'), 'C:/two/a': ok('owner/repo') });
    const said: string[] = [];
    const served = await servedRepos(d.mcp, { p1: choice(), p2: choice() }, (l) => said.push(l), d.read);
    // named in lowercase, served from the first; GitHub calls keep its remote's spelling
    expect(served.repos.map((r) => [r.name, r.github, r.path])).toEqual([['owner/repo', 'Owner/Repo', 'C:/one/a']]);
    expect(said).toEqual(["C:/two/a isn't served: C:/one/a serves owner/repo already"]);
    // the same folder after a case-only edit of its remote: the same name, so its jobs still match
    const edited = doors([{ id: 'p1', title: 'a', folder: 'C:/one/a' }], { 'C:/one/a': ok('OWNER/repo') });
    expect((await servedRepos(edited.mcp, { p1: choice() }, () => {}, edited.read)).repos[0]!.name).toBe('owner/repo');
    // and an unread folder's name, for the jobs open there
    const unread = doors([{ id: 'p1', title: 'a', folder: 'C:/one/a' }], { 'C:/one/a': { github: 'Owner/Repo', reason: 'its origin/HEAD is missing' } });
    expect((await servedRepos(unread.mcp, { p1: choice() }, () => {}, unread.read)).unread).toEqual(['owner/repo']);
  });

  test("a served repo whose folder can't be read is named in one line and left out; the others are served", async () => {
    const d = doors([
      { id: 'p1', title: 'a', folder: 'C:/a' },
      { id: 'p2', title: 'b', folder: 'C:/b' },
      { id: 'p3', title: 'c', folder: 'C:/c' },
    ], {
      'C:/a': { github: null, reason: 'its folder C:/a is missing' },
      'C:/b': { github: 'owner/b', reason: 'its origin/HEAD is missing' },
      'C:/c': ok('owner/c'),
    });
    const said: string[] = [];
    const served = await servedRepos(d.mcp, { p1: choice(), p2: choice(), p3: choice() }, (l) => said.push(l), d.read);
    expect(served.repos.map((r) => r.name)).toEqual(['owner/c']);
    expect(said).toEqual(["a isn't served: its folder C:/a is missing", "b isn't served: its origin/HEAD is missing"]);
    // a name the folder gave is kept, for the jobs open there
    expect(served.unread).toEqual([null, 'owner/b']);
  });

  test("the desktop app tries T3's project list again every 30 seconds until it reads, saying why once", async () => {
    const said: string[] = [];
    const slept: number[] = [];
    let tries = 0;
    const d = doors([{ id: 'p1', title: 'a', folder: 'C:/a' }], { 'C:/a': ok('owner/a') });
    const served = await waitForRepos(async () => {
      tries += 1;
      if (tries < 3) throw new T3Error('T3 is down');
      return servedRepos(d.mcp, { p1: choice() }, () => {}, d.read);
    }, (l) => said.push(l), async (s) => { slept.push(s); });
    expect([served.repos.length, slept]).toEqual([1, [30, 30]]);
    expect(said).toEqual(["Waiting to read T3's projects: T3 is down", "T3's projects are read"]);
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

describe("repos are independent, as in Python: a folder that can't be read fails only its own repo's work (Stefan's decision on #261)", () => {
  /** Two served repos, owner/a and owner/b (`spoil` sets what their folders read as), and a build
   *  each that a stopped runner left open, its thread ended in T3; the runner on the served repos
   *  read once, as `main.ts` and the desktop app make it. */
  async function two(spoil: (reads: Record<string, FolderRead>) => void) {
    const d = doors([{ id: 'pa', title: 'a', folder: 'C:/a' }, { id: 'pb', title: 'b', folder: 'C:/b' }],
      { 'C:/a': ok('owner/a'), 'C:/b': ok('owner/b') });
    spoil(d.reads);
    const jobs = new JobLog(join(dir, JOB_LOG));
    const t3 = new FakeT3();
    for (const repo of ['owner/a', 'owner/b']) {
      const job = jobs.started({ kind: 'build', repo, issue: 4, branch: 'claude/a-ticket-4', title: `Queue runner build: ${repo}#4`,
        thread_id: `mcp:${repo}` });
      t3.add(`mcp:${repo}`, job.title, 'completed');
    }
    const said: string[] = [];
    let github: any = new FakeGitHubWithPulls();
    const make = async (out: (line: string) => void) => {
      const served: Served = await servedRepos(d.mcp, { pa: choice(), pb: choice() }, out, d.read);
      return new Runner(runConfig(served.repos, dir, 60), {
        github, t3, git: new FakeGit() as any, jobs, out, log_line: () => {}, unread: served.unread,
        job_choice: () => ({ provider: 'claudeAgent', model: 'claude-opus-5-5', effort: null }),
      });
    };
    const outcome = (repo: string) => jobs.jobs().find((j) => j.repo === repo && j.issue === 4)!.outcome;
    return { d, jobs, t3, said, make, outcome, issues: (g: any) => { github = g; } };
  }

  test("one repo's folder can't be read: it's named, the other settles and builds in the same pass, and a later start records its job's end", async () => {
    const w = await two((r) => { r['C:/b'] = { github: 'owner/b', reason: 'its origin/HEAD is missing' }; });
    w.issues(new FakeGitHubWithPulls({ issues: [issue(5)] }));
    w.t3.outcomes.push([0, 'completed']);
    const runner = await w.make((l) => w.said.push(l));
    expect(await runner.run_pass()).toBe(STARTED);
    expect(w.outcome('owner/a')).toBe('done-no-pr');
    expect(w.t3.starts.map((s) => [s.project, s.title])).toEqual([['C:/a', 'Queue runner build: owner/a#5']]);
    expect(w.outcome('owner/b')).toBeNull();   // counts as running: not settled, no KeyError
    expect(await runner.run_pass()).toBe(BUSY);   // and it's said once
    expect(w.said.filter((l) => /^b |owner\/b/.test(l))).toEqual([
      "b isn't served: its origin/HEAD is missing",
      "build owner/b#4 waits for owner/b's folder to be read at a later start; it counts as running till then",
    ]);
    // the next start, with the folder read
    w.d.reads['C:/b'] = ok('owner/b');
    w.issues(new FakeGitHubWithPulls());
    const later = await w.make(() => {});
    expect(await later.run_pass()).toBe(IDLE);
    expect(w.outcome('owner/b')).toBe('done-no-pr');
    expect(later.config.repos.map((r) => r.name)).toEqual(['owner/a', 'owner/b']);
  });

  test("a job open in a repo whose name was never read counts as running, and fails no other repo's pass", async () => {
    const w = await two((r) => { r['C:/b'] = { github: null, reason: 'its folder C:/b is missing' }; });
    const runner = await w.make((l) => w.said.push(l));
    expect(await runner.run_pass()).toBe(BUSY);
    expect([w.outcome('owner/a'), w.outcome('owner/b')]).toEqual(['done-no-pr', null]);
    expect(w.said).toContain("b isn't served: its folder C:/b is missing");
  });

  test('--once with one unreadable repo runs the other and names it', async () => {
    const w = await two((r) => { r['C:/b'] = { github: null, reason: "git can't read its origin remote (No such remote 'origin')" }; });
    let printed = '';
    const code = await run(['--once'], {
      mcp: null as any, ws: null as any, github: null as any, runner: (out) => w.make(out),
    }, (s) => { printed += s; });
    expect(code).toBe(0);
    expect([w.outcome('owner/a'), w.outcome('owner/b')]).toEqual(['done-no-pr', null]);
    expect(printed).toContain("b isn't served: git can't read its origin remote (No such remote 'origin')\n");
    expect(printed).toContain('build owner/a#4 ended: done-no-pr');
  });

  test("once every served repo has read, a job open in a repo the config doesn't have waits for nothing, as in Python", async () => {
    const w = await two(() => {});
    w.jobs.started({ kind: 'build', repo: 'owner/gone', issue: 9, branch: 'claude/x-9', title: 'Queue runner build: owner/gone#9' });
    const runner = await w.make(() => {});
    await runner.run_pass();
    // Python's self.repos.get: no repo, so no project to find its thread in
    expect(w.jobs.jobs().find((j) => j.repo === 'owner/gone')!.outcome).toBe('not-started');
  });
});

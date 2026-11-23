// Repos side by side (#50): each working repo gets its own Claude job at once, the usage gate
// counting the jobs still running. GitHub, T3 and Sol are faked; every file is in a temp folder.
// Ported from `tests/test_side_by_side.py` case for case (#219); the cases waiting on a later port
// are `it.todo`, named as in Python, under the ticket that turns them on. The config file is
// `settings.toml` (docs/app.md, Test it).
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { main } from '../src/app.ts';
import { Usage, Window } from '../src/claude-usage.ts';
import type { Issue, PullRequest, Repo } from '../src/github-seam.ts';
import { CostBook } from '../src/job-gate.ts';
import { NoToaster, NoWaker } from '../src/later-parts.ts';
import { JobLog } from '../src/state.ts';
import type { RunResult } from '../src/t3-seam.ts';
import { FakeGit, FakeGitHubWithPulls, FakeUsage, issue } from './fakes.ts';
import { FakeT3, type Outcome } from './fakes-t3.ts';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const NOW = new Date('2026-11-15T12:00:00Z');
const WRITTEN = '2026-11-15T19:58:00+08:00';
const ROOM = new Usage(new Window(0, null), new Window(0, null));

class Done extends Error {}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

const temps: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Each repo's own ready issues, and the repos whose PRs were read, in order. */
class PerRepo extends FakeGitHubWithPulls {
  by_repo: Map<string, Issue[]>;
  read: string[] = [];

  constructor(by_repo: Record<string, Issue[]>) {
    super({
      issues: Object.values(by_repo).flat(),
      pulls_by_branch: Object.fromEntries(['claude/red-widget-4', 'claude/green-widget-5', 'claude/blue-widget-7']
        .map((b) => [b, { number: 12, url: 'https://github.com/owner/x/pull/12', state: 'open' }])),
    });
    this.by_repo = new Map(Object.entries(by_repo));
  }

  override async ready_issues(repo: Repo): Promise<Issue[]> {
    return [...(this.by_repo.get((repo as Repo & { name: string }).name) ?? [])];
  }

  override async open_pulls(repo: Repo): Promise<PullRequest[]> {
    this.read.push((repo as Repo & { name: string }).name);
    return [];
  }
}

function used(five: number, week = 10): Usage {
  const later = new Date(NOW.getTime() + 3 * HOUR);
  return new Usage(new Window(five, later), new Window(week, new Date(NOW.getTime() + 3 * DAY)));
}

/** Two served repos, `first` and `second` in config.toml's order, each with a ready issue. */
class Harness {
  readonly dir: string;
  readonly config: string;
  readonly state: string;
  readonly log: JobLog;
  gh: PerRepo;
  t3!: FakeT3;

  constructor() {
    const tmp = mkdtempSync(join(tmpdir(), 'qr-side-'));
    temps.push(tmp);
    this.dir = tmp.replaceAll('\\', '/');
    this.config = join(this.dir, 'settings.toml');
    const repos = ['first', 'second'].map((name) => `
[[repos]]
name = "${name}"
github = "owner/${name}"
path = "${this.dir}/${name}"
`).join('');
    writeFileSync(this.config, `state_dir = "${this.dir}/state"\nlog_dir = "${this.dir}/logs"\n`
      + `poll_seconds = 300\n${repos}`, 'utf8');
    this.state = join(this.dir, 'state');
    mkdirSync(this.state);
    this.log = new JobLog(join(this.state, 'jobs.jsonl'));
    this.gh = new PerRepo({ first: [issue(4, 'Red widget', 'Red.')], second: [issue(7, 'Blue widget', 'Blue.')] });
  }

  async run_main(args: string[], { passes = 1, t3 = null, usage = ROOM }: { passes?: number; t3?: FakeT3 | null; usage?: Usage } = {}):
    Promise<[number | null, string]> {
    let out = '';
    const slept: number[] = [];
    const sleep = async (s: number) => {
      slept.push(s);
      if (slept.length >= passes) throw new Done();
    };
    this.t3 = t3 ?? new FakeT3(Array(4).fill([0, 'completed']));
    let code: number | null;
    try {
      code = await main([...args, '--config', this.config], {
        github: this.gh, t3: this.t3, git: new FakeGit(), sleep, toaster: new NoToaster(),
        usage: new FakeUsage(usage), clock: () => NOW, waker: new NoWaker(),
      }, (s) => (out += s));
    } catch (e) {
      if (!(e instanceof Done)) throw e;
      code = null;
    }
    return [code, out];
  }

  put(data: unknown): void {
    writeFileSync(join(this.state, 'control.json'), typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  }

  built(): string[] {
    return this.t3.starts.map((s) => basename(String(s.project)));
  }

  /** The gate has learned that a `kind` job takes `five`% of 5 hours (three solo passes), so two fit
   *  side by side; the cautious default (a build's 60%) never lets two in. */
  learn(kind = 'build', five = 10, week = 2): void {
    const book = new CostBook(join(this.state, 'usage.jsonl'));
    for (let i = 0; i < 3; i += 1) book.record(kind, ['learned'], used(10, 10), used(10 + five, 10 + week));
  }

  /** Job-log records as a runner wrote them, with their own times. */
  write_events(...events: Record<string, unknown>[]): void {
    for (const e of events) appendFileSync(this.log.path, `${JSON.stringify(e)}\n`, 'utf8');
  }

  /** A build of `repo`'s issue `n` that ended at `ended` (it holds that issue). */
  earlier_build(repo: string, n: number, ended: string): void {
    const jid = `old-${repo}-${n}`;
    this.write_events(
      { event: 'start', job: jid, kind: 'build', repo, issue: n, branch: `claude/old-${n}`, title: `Queue runner build: ${repo}#${n}`,
        at: '2026-11-15T08:00:00+00:00' },
      { event: 'end', job: jid, at: ended, exit_code: 0, outcome: 'done', pr: { number: 90 + n, url: 'u', state: 'merged' } },
    );
  }

  runner_log(): string {
    return readFileSync(join(this.dir, 'logs', 'runner.log'), 'utf8');
  }
}

/** A T3 whose threads each wait until `n` have started: the test fails (the wait times out) unless
 *  the Claude jobs really run at the same time. */
class Together extends FakeT3 {
  private waiting: (() => void)[] = [];
  private readonly n: number;

  constructor(outcomes: Outcome[], n = 2) {
    super(outcomes);
    this.n = n;
  }

  override async start(...args: Parameters<FakeT3['start']>): Promise<RunResult> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('BrokenBarrierError')), 10_000);
      this.waiting.push(() => {
        clearTimeout(timer);
        resolve();
      });
      if (this.waiting.length === this.n) for (const go of this.waiting.splice(0)) go();
    });
    return super.start(...args);
  }
}

const completed = (n: number): Outcome[] => Array(n).fill([0, 'completed']);

/** #50: each working repo gets its own Claude job at once. */
describe('SideBySideTest', () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
    h.learn();
  });

  test('one pass starts a build in each repo and they run at the same time', async () => {
    const [code] = await h.run_main(['--once'], { t3: new Together(completed(2)) });
    expect(code).toBe(0);
    expect(h.built().sort()).toEqual(['first', 'second']);
    const done = new Set(h.log.jobs().map((j) => JSON.stringify([j.repo, j.issue, j.outcome])));
    expect(done).toEqual(new Set([JSON.stringify(['first', 4, 'done']), JSON.stringify(['second', 7, 'done'])]));
  });

  test('the loop runs them side by side too', async () => {
    await h.run_main([], { passes: 1, t3: new Together(completed(2)) });
    expect(h.built().sort()).toEqual(['first', 'second']);
  });

  test('a repo with a job running gets no other until it ends', async () => {
    let release!: () => void;
    let released = false;
    const released_p = new Promise<void>((r) => (release = () => {
      released = true;
      r();
    }));
    const planned: string[] = [];
    h.gh.by_repo.get('first')!.push(issue(5, 'Green widget', 'Green.'));
    const ready = h.gh.ready_issues.bind(h.gh);

    // the lane plans again once second's #7 has ended (no Sol lane reads the issues here: the app
    // has no reviewer until #222)
    h.gh.ready_issues = async (repo: Repo) => {
      planned.push((repo as Repo & { name: string }).name);
      if (planned.filter((n) => n === 'second').length === 2) release();
      return ready(repo);
    };

    /** first's #4 runs until the lane has planned again without it. */
    class FirstBlocks extends FakeT3 {
      override async start(...args: Parameters<FakeT3['start']>): Promise<RunResult> {
        const [project] = args;
        if (project.endsWith('first') && !released) await released_p;
        return super.start(...args);
      }
    }
    await h.run_main([], { t3: new FirstBlocks(completed(3)) });
    expect(released).toBe(true);
    const titles = h.t3.starts.map((s) => String(s.title));
    expect(titles.slice(0, 2).sort()).toEqual(['Queue runner build: first#4', 'Queue runner build: second#7']);
    expect(titles.slice(2)).toEqual(['Queue runner build: first#5']);   // once #4 had ended
    // The pass after #7 ended chose nothing in first, whose #4 still ran
    expect(planned.slice(0, 3)).toEqual(['first', 'second', 'second']);
  });

  test('a stopped repo gets none', async () => {
    h.put({ version: 1, written_at: WRITTEN, lanes: {}, repos: { first: { stop: 'after-job', at: WRITTEN } } });
    await h.run_main(['--once']);
    expect(h.built()).toEqual(['second']);
  });

  test('a job a dead runner left running holds only its own repo', async () => {
    h.write_events({
      event: 'start', job: 'dead', kind: 'build', repo: 'first', issue: 3, branch: 'claude/x-3',
      title: 'Queue runner build: first#3', at: '2026-11-15T11:00:00+00:00',
    });
    const t3 = new FakeT3([[0, 'completed']]);
    t3.add('mcp:dead', 'Queue runner build: first#3', 'running', '2026-11-15T11:00:01.000Z');
    await h.run_main(['--once'], { t3 });
    expect(h.built()).toEqual(['second']);
    expect(h.runner_log()).toContain('build first#3 is still running in');
  });
});

describe('RestartTest, turned on by serving itself (#237)', () => {
  it.todo('test_new_code_waits_for_the_running_jobs_and_starts_none_meanwhile');
});

/** The gate counts the jobs still running before it starts another; with room for only one more,
 *  the repo whose work has waited longest gets it, config.toml's order breaking a tie. */
describe('GateTest', () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  test('with room for one build the first in the config gets it on a tie', async () => {
    await h.run_main(['--once'], { usage: used(30) });   // 30 + 60 fits; 30 + 60 + 60 not
    expect(h.built()).toEqual(['first']);
    expect(h.runner_log()).toContain('Claude lane waits on second: build would fit alone, but the Claude job '
      + 'running (build first#4) is expected to take 60% of 5 hours, 15% of the '
      + 'week: it waits for one of them to end');
  });

  test('the repo whose work waited longest goes first', async () => {
    h.earlier_build('first', 1, '2026-11-15T11:30:00+00:00');
    h.earlier_build('second', 2, '2026-11-15T09:00:00+00:00');
    await h.run_main(['--once'], { usage: used(30) });
    expect(h.built()).toEqual(['second']);
    h.earlier_build('second', 3, '2026-11-15T11:50:00+00:00');
    rmSync(h.log.path);   // afresh: now first has waited longer
    h.earlier_build('first', 1, '2026-11-15T09:00:00+00:00');
    h.earlier_build('second', 2, '2026-11-15T11:30:00+00:00');
    await h.run_main(['--once'], { usage: used(30) });
    expect(h.built()).toEqual(['first']);
  });

  test('two jobs at once teach the learned costs nothing', async () => {
    h.learn();
    await h.run_main(['--once'], { t3: new Together(completed(2)) });
    const records = readFileSync(join(h.state, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line)).slice(3);   // after the three learned
    expect(records).toHaveLength(2);
    const shared = new Map(records.map((r) => [r.jobs[0], r.shared_with]));
    expect([...shared.values()].every((v) => Array.isArray(v) && v.length)).toBe(true);
    expect([...shared.values()].flat().sort()).toEqual(['build first#4', 'build second#7']);
  });

  test('one job alone still teaches', async () => {
    h.gh.by_repo.set('second', []);
    await h.run_main(['--once']);
    const records = readFileSync(join(h.state, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty('shared_with');
    expect(records[0].kind).toBe('build');
  });
});

describe('GateTest, turned on by decisions (#226)', () => {
  it.todo('test_a_job_that_does_not_fit_leaves_room_for_a_later_one_that_does');
});

describe('LimitTest, turned on by limit recovery (#227)', () => {
  it.todo('test_both_jobs_cut_off_are_recovered_each_in_its_repo');
});

describe('DryRunAndGateTest, turned on by the dry run (#238)', () => {
  it.todo('test_the_dry_run_lists_each_repos_job');
  it.todo('test_a_stopped_repo_has_no_job_in_it');
  it.todo('test_a_repo_with_a_job_running_lists_none');
  it.todo('test_a_repo_with_nothing_says_so_and_the_other_still_lists_its_job');
});

describe('DryRunAndGateTest, turned on by --gate (#229)', () => {
  it.todo('test_gate_says_how_many_could_start');
  it.todo('test_gate_counts_the_jobs_running');
});

describe('SnapshotTest, turned on by the snapshot (#230)', () => {
  it.todo('test_it_shows_both_jobs_while_they_run');
});

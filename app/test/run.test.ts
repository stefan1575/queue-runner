// The run loop, ported from `tests/test_run.py`, `tests/test_side_by_side.py`, `tests/test_gating.py`
// and `tests/test_usage_budget.py` case for case (#219), with GitHub, T3 and git faked (`fakes.ts`,
// `fakes-t3.ts`), a fixed clock, and every file in a temp folder removed after its test.
//
// Python's cases go through `cli.main`; these go through the app's command line (`src/app.ts`:
// `--once`, `--release`) on a Runner made for each call, as `main` makes one, and through
// `Runner.run_forever` for the continuous mode, which the desktop app runs. Python's usage gate reads
// Claude's usage endpoint; the app's reads T3's readings of each provider (`src/usage-gate.ts`), so
// the fake here is T3's reading (`T3Usage`), and what the gate says is the app's text. A case that
// needs a part ported later is pending (`test.todo`), named for the ticket that turns it on.
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { run } from '../src/app.ts';
import { CostLog } from '../src/cost-log.ts';
import type { UsageRecord } from '../src/costs.ts';
import { DEFAULT_JOBS, type Catalog, type ModelChoice } from '../src/jobs.ts';
import { BUSY, GATED, IDLE, local_minute, Runner, Start, STARTED, type Config, type Did, type Gate, type KnownRepo, type Repo } from '../src/run.ts';
import { LOCK_FILE, runner_lock } from '../src/runner-lock.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.ts';
import { JobLog } from '../src/state.ts';
import type { CatalogSource, CatalogState } from '../src/t3/catalog-source.ts';
import { RunResult, T3Error, Thread } from '../src/t3-seam.ts';
import type { ProviderUsage } from '../src/usage.ts';
import { UsageGate } from '../src/usage-gate.ts';
import { FakeGit, FakeGitHubWithPulls, issue } from './fakes.ts';
import { FakeT3, type Outcome } from './fakes-t3.ts';

const CLAUDE: ModelChoice = { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'high' };
const CATALOG: Catalog = {
  providers: [{ id: 'claudeAgent', label: 'Claude', models: [{
    id: 'claude-opus-5-5', label: 'Opus 5.5', isDefault: true, effortOption: 'effort',
    efforts: [{ id: 'high', label: 'High' }], defaultEffort: 'high',
  }] }],
  t3Default: null,
};
const FAR = '2099-01-01T00:00:00.000Z';
const PR = { number: 12, url: 'https://github.com/owner/first/pull/12', state: 'open' };

/** A reading of the provider's two windows: percent used and when each resets (Python's
 *  `Usage(Window(five, reset), Window(week, reset))`). */
type Read = { five: number; week: number; five_reset?: Date | null; week_reset?: Date | null } | 'none';

/** T3's reading of the provider's usage, as the gate sees it (`CatalogSource`): `reads` in turn,
 *  one more each time T3 reads again (`read_again`), the last one kept. A reading is taken now
 *  (the clock's time) unless T3 read it at a set time (`read_at`). */
class T3Usage implements CatalogSource {
  reads: Read[];
  at = 0;
  read_at: Date | null = null;
  private listeners = new Set<(s: CatalogState) => void>();
  private clock: () => Date;

  constructor(clock: () => Date, ...reads: Read[]) {
    this.clock = clock;
    this.reads = reads.length ? reads : [{ five: 0, week: 0, five_reset: null, week_reset: new Date(FAR) }];
  }

  current(): CatalogState {
    const r = this.reads[Math.min(this.at, this.reads.length - 1)]!;
    const checkedAt = r === 'none' ? null : (this.read_at ?? this.clock()).toISOString();
    const usage: ProviderUsage = {
      provider: 'claudeAgent', driver: 'claudeAgent', account: 'claude-login', label: 'Claude', name: 'Claude',
      checkedAt, resetCredits: null, unavailable: null,
      windows: r === 'none' ? [] : [
        { id: 'five_hour', kind: 'session', label: 'Session', usedPercent: r.five, resetsAt: r.five_reset?.toISOString() ?? null, minutes: 300 },
        { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: r.week, resetsAt: r.week_reset?.toISOString() ?? null, minutes: 10_080 },
      ],
    };
    return { catalog: CATALOG, usage: [usage] };
  }

  onChange(listener: (s: CatalogState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** T3 read the usage again (at `at`, or now): the next reading, told to the gate. */
  read_again(at: Date | null = null, next: Read | null = null): void {
    if (next !== null) this.reads.push(next);
    this.at += 1;
    this.read_at = at;
    for (const l of this.listeners) l(this.current());
  }
}

class Stop extends Error {}

let dir: string;
beforeEach(async () => {
  dir = (await mkdtemp(join(tmpdir(), 'qr-run-'))).replaceAll('\\', '/');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A served repo in the test's folder. */
const served = (name: string, path: string, github: string | null = `owner/${name}`): Repo => ({ name, github, path, base: 'main', merge: 'me' });

/** The config, the job log and the command line, with GitHub, T3, git and T3's usage faked (Python's
 *  `RunHarness`): each call makes its Runner and its gate afresh, as `cli.main` does. */
class Harness {
  repos: Repo[];
  poll_seconds: number;
  now: Date;
  log: JobLog;
  settings: Settings = { ...DEFAULT_SETTINGS, jobs: { ...DEFAULT_JOBS, default: CLAUDE } };
  usage: T3Usage;
  gate: UsageGate | null = null;
  lines: string[] = [];
  runner: Runner | null = null;
  /** `Config.lookup`, as the app wires it (`repoLookup`); none: a job's repo is a served one. */
  lookup: Config['lookup'] | null = null;

  constructor(repos: Repo[], poll_seconds: number, now: Date) {
    this.repos = repos;
    this.poll_seconds = poll_seconds;
    this.now = now;
    this.log = new JobLog(join(dir, 'state', 'jobs.jsonl'), () => this.now);
    this.usage = new T3Usage(() => this.now);
  }

  get config(): Config {
    const h = this;
    return { get repos() { return h.repos; }, state_dir: join(dir, 'state'), poll_seconds: this.poll_seconds,
      ...(this.lookup ? { lookup: this.lookup } : {}) };
  }

  async make(github: any, t3: any, git: any = new FakeGit()): Promise<Runner> {
    this.gate = new UsageGate(this.usage, () => this.settings, await CostLog.open(join(dir, 'state', 'usage.jsonl')), () => this.now);
    this.runner = new Runner(this.config, {
      github, t3, git, jobs: this.log, gate: this.gate, now: () => this.now,
      out: () => {}, log_line: (l) => this.lines.push(l), user: async () => 'the user',
    });
    return this.runner;
  }

  /** `main(args)` through the app's command line: its exit code and what it printed. */
  async run_main(args: string[], github: any, t3: any, git: any = new FakeGit()): Promise<[number, string]> {
    let printed = '';
    const code = await run(args, { mcp: null as any, ws: null as any, github: null as any, runner: async (out) => {
      const r = await this.make(github, t3, git);
      r.out = out;
      return r;
    }, lock: () => runner_lock(join(dir, 'state')),
    release: async () => ({ jobs: this.log, log_line: (l) => this.lines.push(l) }) }, (s) => { printed += s; });
    return [code, printed];
  }

  /** The continuous mode (`main([])`): passes until `sleep` stops it. */
  async forever(github: any, t3: any, sleep: (s: number) => Promise<void>, git: any = new FakeGit()): Promise<void> {
    const r = await this.make(github, t3, git);
    await r.run_forever(sleep);
  }

  runner_log(): string {
    return this.lines.join('\n');
  }
}

// --- tests/test_run.py ----------------------------------------------------------------------------

describe('RunTest', () => {
  const NOW = new Date('2026-11-08T07:34:00Z');
  let h: Harness;
  beforeEach(() => {
    h = new Harness([served('first', dir)], 60, NOW);
  });

  test('test_once_starts_the_picked_build_in_a_t3_worktree_and_records_it', async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4, 'Red widget', 'Make it red.')], pulls_by_branch: { 'claude/red-widget-4': PR } });
    const t3 = new FakeT3([[0, 'completed']]);
    const git = new FakeGit({ commits: { 'claude/red-widget-4': [{ sha: 'abc1234', subject: 'Red' }] } });
    const [code, out] = await h.run_main(['--once'], gh, t3, git);

    expect(code).toBe(0);
    const [start] = t3.starts;
    expect([t3.starts.length, start!.project, start!.worktree, start!.branch]).toEqual([1, dir, 'origin/main', 'claude/red-widget-4']);
    expect([start!.provider, start!.model]).toEqual(['claudeAgent', 'claude-opus-5-5']);
    expect(String(start!.message).startsWith('Build GitHub issue #4 in owner/first')).toBe(true);
    expect(git.fetches).toEqual([[dir, 'main']]);

    const [job, ...rest] = h.log.jobs();
    expect(rest).toEqual([]);
    expect([job!.kind, job!.repo, job!.issue, job!.branch]).toEqual(['build', 'first', 4, 'claude/red-widget-4']);
    expect([job!.thread_id, job!.exit_code, job!.outcome]).toEqual(['mcp:t1', 0, 'done']);
    expect(job!.link!.startsWith('https://app.t3.codes/')).toBe(true);
    expect(job!.pr).toEqual(PR);
    expect(job!.commits).toEqual([{ sha: 'abc1234', subject: 'Red' }]);
    expect(job!.worktree).toBe('C:/t3/worktrees/mcp:t1');
    expect(h.runner_log()).toContain('build first#4 ended: done');
    expect(out).toContain('owner/first#4');
  });

  test('test_a_completed_build_without_a_pr_is_recorded_as_such', async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)] });
    await h.run_main(['--once'], gh, new FakeT3([[0, 'completed']]));
    expect(h.log.jobs()[0]!.outcome).toBe('done-no-pr');
  });

  // a decision on the failure comes between the two builds
  test.todo('test_a_failed_run_is_recorded_and_its_issue_not_picked_again (decisions, #226)');
  // a decision on its question
  test.todo('test_a_run_waiting_for_an_answer_holds_its_issue (decisions, #226)');

  test('test_a_waiting_job_is_recorded_done_once_its_thread_completes', async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)], pulls_by_branch: { 'claude/a-ticket-4': PR } });
    const t3 = new FakeT3([[2, 'waiting']]);
    await h.run_main(['--once'], gh, t3);
    t3.set_status('mcp:t1', 'completed');   // the user answered it in T3
    await h.run_main(['--once'], gh, t3);
    const jobs = h.log.jobs();
    expect(jobs.length).toBe(1);
    expect([jobs[0]!.exit_code, jobs[0]!.outcome, jobs[0]!.pr]).toEqual([0, 'done', PR]);
    expect(t3.starts.length).toBe(1);
  });

  test('test_t3_failing_before_any_thread_exists_is_retried_next_pass', async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)] });
    const t3 = new FakeT3([new T3Error('T3 Code server is not running'), [0, 'completed']]);
    await h.run_main(['--once'], gh, t3);
    expect(h.log.jobs()[0]!.outcome).toBe('not-started');
    expect(h.log.jobs()[0]!.error).toContain('server is not running');
    await h.run_main(['--once'], gh, t3);
    expect(h.log.jobs().map((j) => j.outcome)).toEqual(['not-started', 'done-no-pr']);
  });

  test('test_t3_failing_after_its_thread_started_leaves_the_job_open_for_the_next_pass', async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)], pulls_by_branch: { 'claude/a-ticket-4': PR } });

    class LostWait extends FakeT3 {
      override async start(...args: Parameters<FakeT3['start']>): Promise<RunResult> {
        await super.start(...args);   // the thread exists and runs on
        throw new T3Error('T3 Code server is unreachable');
      }
    }

    const t3 = new LostWait([[0, 'running']]);
    await h.run_main(['--once'], gh, t3);
    expect(h.log.open_jobs().map((j) => j.issue)).toEqual([4]);
    t3.set_status('mcp:t1', 'completed');
    await h.run_main(['--once'], gh, t3);
    const jobs = h.log.jobs();
    expect(jobs.length).toBe(1);
    expect([jobs[0]!.thread_id, jobs[0]!.exit_code, jobs[0]!.outcome]).toEqual(['mcp:t1', 0, 'done']);
  });

  test('test_a_job_still_running_from_a_dead_runner_blocks_a_second_claude_job', async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4), issue(5)], pulls_by_branch: { 'claude/a-ticket-4': PR } });
    const job = h.log.started({ kind: 'build', repo: 'first', issue: 4, branch: 'claude/a-ticket-4', title: 'Queue runner build: first#4' });
    const t3 = new FakeT3([[0, 'completed']]);
    t3.add('mcp:old', job.title, 'running');
    const [, out] = await h.run_main(['--once'], gh, t3);
    expect(t3.starts).toEqual([]);
    expect(out).toContain('still running');
    t3.set_status('mcp:old', 'completed');
    await h.run_main(['--once'], gh, t3);
    expect(t3.starts.map((s) => s.branch)).toEqual(['claude/a-ticket-5']);
    expect(h.log.jobs()[0]!.thread_id).toBe('mcp:old');
  });

  test('test_an_open_job_whose_thread_never_started_is_closed', async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)] });
    h.log.started({ kind: 'build', repo: 'first', issue: 4, branch: 'claude/a-ticket-4', title: 'Queue runner build: first#4' });
    await h.run_main(['--once'], gh, new FakeT3([[0, 'completed']]));
    expect(h.log.jobs().map((j) => j.outcome)).toEqual(['not-started', 'done-no-pr']);
  });

  test('test_a_leftover_local_branch_holds_the_issue_without_starting_a_thread', async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)] });
    const t3 = new FakeT3();
    await h.run_main(['--once'], gh, t3, new FakeGit({ branches: ['claude/a-ticket-4'] }));
    expect(t3.starts).toEqual([]);
    expect(h.log.jobs()[0]!.outcome).toBe('branch-exists');
    expect(h.log.held_issues('first')).toEqual(new Set([4]));
  });

  test('test_release_lets_a_held_issue_be_picked_again', async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)] });
    const t3 = new FakeT3([[1, 'failed'], [0, 'completed']]);
    await h.run_main(['--once'], gh, t3);
    const [code] = await h.run_main(['--release', 'first#4'], gh, t3);
    expect(code).toBe(0);
    await h.run_main(['--once'], gh, t3);
    expect(t3.starts.length).toBe(2);
  });

  test.todo('test_dry_run_skips_held_issues (the dry run, #238)');
  test.todo('test_dry_run_names_a_pending_decision_first_with_its_brief (the dry run, #238)');

  test('test_continuous_mode_runs_pass_after_pass_and_sleeps_when_idle', async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)], pulls_by_branch: { 'claude/a-ticket-4': PR } });
    const t3 = new FakeT3([[0, 'completed']]);
    const sleeps: number[] = [];
    const sleep = async (s: number) => {
      sleeps.push(s);
      if (sleeps.length === 2) throw new Stop();
    };
    await expect(h.forever(gh, t3, sleep)).rejects.toBeInstanceOf(Stop);
    expect(t3.starts.length).toBe(1);   // the job, then two idle passes
    expect(sleeps).toEqual([60, 60]);
  });

  test('test_a_failing_pass_is_logged_and_the_loop_goes_on', async () => {
    class Broken extends FakeGitHubWithPulls {
      override async ready_issues(): Promise<never> {
        throw new Error('GitHub is down');
      }
    }
    const sleeps: number[] = [];
    const sleep = async (s: number) => {
      sleeps.push(s);
      throw new Stop();
    };
    await expect(h.forever(new Broken(), new FakeT3(), sleep)).rejects.toBeInstanceOf(Stop);
    expect(h.runner_log()).toContain('GitHub is down');
  });

  test('test_a_waiting_thread_t3_cannot_read_counts_as_busy', async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4), issue(5)] });
    const t3 = new FakeT3([[2, 'waiting'], [0, 'completed']]);
    await h.run_main(['--once'], gh, t3);
    t3.threads.delete('mcp:t1');   // T3 can't say whether the user's answer set it running again
    await h.run_main(['--once'], gh, t3);
    expect(t3.starts.length).toBe(1);
  });

  test('test_a_failed_build_records_the_pr_it_opened', async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)], pulls_by_branch: { 'claude/a-ticket-4': PR } });
    await h.run_main(['--once'], gh, new FakeT3([[1, 'interrupted']]));
    const jobs = h.log.jobs();
    expect(jobs.length).toBe(1);
    expect([jobs[0]!.outcome, jobs[0]!.pr]).toEqual(['failed', PR]);
  });

  test('test_continuous_mode_pauses_after_a_build_that_never_started', async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)] });
    const t3 = new FakeT3([new T3Error('T3 Code server is not running')]);
    const sleeps: number[] = [];
    const sleep = async (s: number) => {
      sleeps.push(s);
      throw new Stop();
    };
    await expect(h.forever(gh, t3, sleep)).rejects.toBeInstanceOf(Stop);
    expect([t3.starts.length, sleeps]).toEqual([1, [60]]);
  });

  test('test_a_second_runner_exits_while_one_holds_the_lock', async () => {
    // the desktop app's run loop holds the state folder's lock (`runner_lock`), as Python's runner holds runner.lock
    const release = runner_lock(join(dir, 'state'));
    try {
      const t3 = new FakeT3();
      const [code, out] = await h.run_main(['--once'], new FakeGitHubWithPulls({ issues: [issue(4)] }), t3);
      expect(code).toBe(3);
      expect(out).toContain('already running');
      expect([t3.starts, h.log.jobs()]).toEqual([[], []]);
    } finally {
      release();
    }
  });

  // --- #219's review 1 (F1, F2, F3, F6, F8) ------------------------------------------------

  test("--once frees the lock when its pass ends, and a lock its process left behind is taken over", async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)] });
    await h.run_main(['--once'], gh, new FakeT3([[0, 'completed']]));
    await expect(readFile(join(dir, 'state', LOCK_FILE), 'utf8')).rejects.toThrow();   // freed
    await writeFile(join(dir, 'state', LOCK_FILE), '999999999');   // a process that has gone
    const release = runner_lock(join(dir, 'state'), 42, (pid) => pid === 42);
    expect(await readFile(join(dir, 'state', LOCK_FILE), 'utf8')).toBe('42');
    expect(() => runner_lock(join(dir, 'state'), 43, (pid) => pid === 42)).toThrow(/pid 42/);
    release();
    runner_lock(join(dir, 'state'), 43, () => true)();
  });

  test('a left-over build in a repo whose base is not read yet is looked up, not closed, and nothing starts there', async () => {
    const repo = h.repos[0]!;
    h.repos = [];   // after a restart: its base isn't read, so it's not among the served repos yet
    h.lookup = (name): KnownRepo | undefined => (name === repo.name ? { ...repo, base: null } : undefined);
    const gh = new FakeGitHubWithPulls({ issues: [issue(5)] });
    const job = h.log.started({ kind: 'build', repo: 'first', issue: 4, branch: 'claude/a-ticket-4', title: 'Queue runner build: first#4' });
    const t3 = new FakeT3([[0, 'completed']]);
    t3.add('mcp:old', job.title, 'running');
    await h.run_main(['--once'], gh, t3);
    expect([h.log.open_jobs().map((j) => j.id), t3.starts]).toEqual([[job.id], []]);
    t3.set_status('mcp:old', 'completed');   // it ended while the base is still unread: recorded later
    const [, out] = await h.run_main(['--once'], gh, t3);
    expect(out).toContain("it's recorded once first's base is read");
    expect([h.log.open_jobs().map((j) => j.id), t3.starts]).toEqual([[job.id], []]);
    h.lookup = (name) => (name === repo.name ? repo : undefined);   // the base is read now
    h.repos = [repo];
    await h.run_main(['--once'], gh, t3);
    expect(h.log.jobs().map((j) => [j.issue, j.thread_id ?? null, j.outcome])).toEqual([[4, 'mcp:old', 'done-no-pr'], [5, 'mcp:t1', 'done-no-pr']]);
  });

  test("a waiting build the user's answer ran to its end is recorded only once its repo's base is read", async () => {
    const gh = new FakeGitHubWithPulls({ issues: [issue(4), issue(5)] });
    const t3 = new FakeT3([[2, 'waiting'], [0, 'completed']]);
    await h.run_main(['--once'], gh, t3);
    const repo = h.repos[0]!;
    h.repos = [];
    h.lookup = (name) => (name === repo.name ? { ...repo, base: null } : undefined);
    t3.set_status('mcp:t1', 'completed');   // answered in T3 and ended, after a restart
    await h.run_main(['--once'], gh, t3);
    expect([h.log.waiting_jobs().length, t3.starts.length]).toEqual([1, 1]);
    h.lookup = (name) => (name === repo.name ? repo : undefined);
    await h.run_main(['--once'], gh, t3);
    expect(h.log.jobs().map((j) => j.outcome)).toEqual(['done-no-pr']);
  });

  test("a left-over build is left open while the app hasn't read its repos", async () => {
    h.repos = [];
    h.lookup = () => null;   // the repos (or this one's remote) aren't read yet
    h.log.started({ kind: 'build', repo: 'first', issue: 4, branch: 'claude/a-ticket-4', title: 'Queue runner build: first#4' });
    const t3 = new FakeT3();
    const [, out] = await h.run_main(['--once'], new FakeGitHubWithPulls({ issues: [issue(5)] }), t3);
    expect(out).toContain("first isn't read yet");
    expect([h.log.open_jobs().length, t3.starts]).toEqual([1, []]);
  });

  test('a build in a repo switched off Served while it runs is still recorded and settled', async () => {
    const repo = h.repos[0]!;
    h.lookup = (name) => (name === repo.name ? repo : undefined);   // the app still knows it
    class SwitchedOff extends FakeT3 {
      override async start(...args: Parameters<FakeT3['start']>) {
        h.repos = [];   // switched off Served mid-build
        return super.start(...args);
      }
    }
    const t3 = new SwitchedOff([[0, 'completed']]);
    await h.run_main(['--once'], new FakeGitHubWithPulls({ issues: [issue(4)], pulls_by_branch: { 'claude/a-ticket-4': PR } }), t3);
    const [job] = h.log.jobs();
    expect([job!.outcome, job!.thread_id]).toEqual(['done', 'mcp:t1']);
    expect(t3.settles).toEqual(['mcp:t1']);
  });

  test("a left-over build counts on the model it was launched on, and its end is told on that model", async () => {
    const SOL: ModelChoice = { provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' };
    h.repos = [served('first', dir), served('second', dir)];
    const job = h.log.started({ kind: 'build', repo: 'first', issue: 4, branch: 'claude/a-ticket-4', title: 'Queue runner build: first#4', choice: SOL });
    const t3 = new FakeT3();
    t3.add('mcp:old', job.title, 'running');
    const calls: unknown[][] = [];
    const gate: Gate = {
      pick: (id, kind, elsewhere) => { calls.push(['pick', id, elsewhere]); return { fits: false, until: null, hold: { why: 'reading', provider: 'Claude', checkedAt: null, stale: 'none' } }; },
      started: () => {}, finished: () => {}, dropped: () => {}, forget: () => {},
      job_ended: (kind, key, choice) => { calls.push(['job_ended', kind, key, choice]); },
    };
    const r = new Runner(h.config, { github: new FakeGitHubWithPulls({ issues: [issue(5)] }) as any, t3, git: new FakeGit() as any, jobs: h.log, gate,
      now: () => h.now, out: () => {}, log_line: () => {} });
    await r.run_pass();
    expect(calls).toEqual([['pick', 'build second#5', [{ id: 'build first#4', kind: 'build', choice: SOL }]]]);
    t3.set_status('mcp:old', 'completed');
    calls.length = 0;
    await r.run_pass();
    expect(calls[0]).toEqual(['job_ended', 'build', null, SOL]);
  });

  test('a build records the model it was launched on', async () => {
    await h.run_main(['--once'], new FakeGitHubWithPulls({ issues: [issue(4)] }), new FakeT3([[0, 'completed']]));
    expect(h.log.jobs()[0]!.choice).toEqual(CLAUDE);
  });

  test('--release takes a repo named with spaces, from the job log alone', async () => {
    h.repos = [served('queue-runner sandbox GitHub', dir)];
    h.log.started({ kind: 'build', repo: 'queue-runner sandbox GitHub', issue: 4, branch: 'claude/a-ticket-4', title: 't' });
    // `--release` makes no Runner: no T3 project list, no catalog
    const [code, out] = await h.run_main(['--release', 'queue-runner sandbox GitHub#4'], null, null);
    expect([code, h.runner]).toEqual([0, null]);
    expect(out).toContain('Released queue-runner sandbox GitHub#4');
    expect(h.log.held_issues('queue-runner sandbox GitHub')).toEqual(new Set());
    const [bad, said] = await h.run_main(['--release', 'nowhere#4'], null, null);
    expect([bad, said]).toEqual([2, '--release takes NAME#N with NAME a repo the job log has jobs in.\n']);
  });

  // --- the Sol lane alongside: the reviews ticket's ---
  test.todo('test_once_runs_a_build_and_a_review_alongside (reviews, #222)');
  test.todo('test_an_open_review_is_the_sol_lanes_to_settle_not_the_claude_lanes (reviews, #222)');
  test.todo('test_review_one_pr_now (reviews, #222)');
  test.todo('test_dry_run_also_says_which_prs_sol_would_review (the dry run, #238)');
  test.todo('test_dry_run_prints_the_fix_brief_for_a_blocking_pr_and_starts_nothing (the dry run, #238)');
});

describe('LimitRecoveryTest (limit recovery, #227)', () => {
  test.todo('test_a_limit_stop_is_recorded_with_its_resume_time_and_context');
  test.todo('test_nothing_else_starts_until_ten_minutes_after_the_reset');
  test.todo('test_a_warm_thread_is_continued_in_place_at_any_size');
  test.todo('test_the_stop_records_its_last_request_and_a_dry_run_says_the_choice');
  test.todo('test_a_cold_thread_under_120k_tokens_is_continued_in_place');
  test.todo('test_a_small_thread_is_continued_in_place_after_the_reset');
  test.todo('test_a_cold_big_thread_restarts_fresh_on_its_branch_at_its_newest_commit');
  test.todo('test_any_other_failure_is_not_a_limit_stop');
  test.todo('test_the_runner_warns_at_start_if_t3_resumes_limited_threads_itself');
  test.todo('test_t3s_record_of_another_failure_wins_over_a_limit_message');
  test.todo('test_an_earlier_runs_limit_message_doesnt_make_a_later_failure_a_limit_stop');
  test.todo('test_a_restart_that_cant_be_made_holds_the_job_and_isnt_tried_again');
  test.todo('test_claude_codes_limit_message_is_enough_when_t3_recorded_nothing');
});

// --- tests/test_side_by_side.py ---------------------------------------------------------------------

const SIDE_NOW = new Date('2026-11-15T12:00:00Z');

/** Each repo's own ready issues, and the repos whose PRs were read, in order. */
class PerRepo extends FakeGitHubWithPulls {
  by_repo: Map<string, ReturnType<typeof issue>[]>;
  read: string[] = [];
  constructor(by_repo: Record<string, ReturnType<typeof issue>[]>) {
    super({ issues: Object.values(by_repo).flat(), pulls_by_branch: Object.fromEntries(
      ['claude/red-widget-4', 'claude/green-widget-5', 'claude/blue-widget-7'].map((b) => [b, { number: 12, url: 'https://github.com/owner/x/pull/12', state: 'open' }])) });
    this.by_repo = new Map(Object.entries(by_repo));
  }

  override async ready_issues(repo: { github: string }): Promise<ReturnType<typeof issue>[]> {
    return [...(this.by_repo.get((repo as unknown as Repo).name) ?? [])];
  }

  override async open_pulls(repo: { github: string }) {
    this.read.push((repo as unknown as Repo).name);
    return [];
  }
}

/** A T3 whose threads each wait until `n` have started: the test fails (it never ends) unless the
 *  builder jobs really run at the same time. */
class Together extends FakeT3 {
  private arrived = 0;
  private n: number;
  private all!: () => void;
  private gate = new Promise<void>((r) => { this.all = r; });
  constructor(outcomes: Outcome[], n = 2) {
    super(outcomes);
    this.n = n;
  }

  override async start(...args: Parameters<FakeT3['start']>): Promise<RunResult> {
    this.arrived += 1;
    if (this.arrived >= this.n) this.all();
    await this.gate;
    return super.start(...args);
  }
}

/** Two served repos, `first` and `second` in that order, each with a ready issue (Python's
 *  `Harness`). */
class SideHarness extends Harness {
  gh: PerRepo;
  t3: FakeT3 = new FakeT3();

  constructor() {
    super([served('first', `${dir}/first`), served('second', `${dir}/second`)], 300, SIDE_NOW);
    this.gh = new PerRepo({ first: [issue(4, 'Red widget', 'Red.')], second: [issue(7, 'Blue widget', 'Blue.')] });
  }

  async once(t3: FakeT3 = new FakeT3(Array(4).fill([0, 'completed']))): Promise<[number, string]> {
    this.t3 = t3;
    return this.run_main(['--once'], this.gh, t3);
  }

  built(): string[] {
    return this.t3.starts.map((s) => String(s.project).split('/').at(-1)!);
  }

  /** The gate has learned that a `kind` job takes `five`% of 5 hours (three solo passes), so two
   *  fit side by side; the cautious default (a build's 60%) never lets two in. */
  async learn(kind: 'build' | 'fix' = 'build', five = 10, week = 2): Promise<void> {
    await mkdir(join(dir, 'state'), { recursive: true });
    const record = (i: number): UsageRecord => ({
      ...CLAUDE, kind, at: SIDE_NOW.toISOString(), job: `learned-${i}`,
      before: { checkedAt: SIDE_NOW.toISOString(), windows: {} }, after: null, spent: { five_hour: five, seven_day: week },
    });
    for (let i = 0; i < 3; i += 1) await appendFile(join(dir, 'state', 'usage.jsonl'), `${JSON.stringify(record(i))}\n`);
  }

  /** Job-log records as a runner wrote them, with their own times. */
  async write_events(...events: Record<string, unknown>[]): Promise<void> {
    await mkdir(join(dir, 'state'), { recursive: true });
    for (const e of events) await appendFile(this.log.path, `${JSON.stringify(e)}\n`);
  }

  /** A build of `repo`'s issue `n` that ended at `ended` (it holds that issue). */
  earlier_build(repo: string, n: number, ended: string): Promise<void> {
    const jid = `old-${repo}-${n}`;
    return this.write_events(
      { event: 'start', job: jid, kind: 'build', repo, issue: n, branch: `claude/old-${n}`, title: `Queue runner build: ${repo}#${n}`, at: '2026-11-15T08:00:00+00:00' },
      { event: 'end', job: jid, at: ended, exit_code: 0, outcome: 'done', pr: { number: 90 + n, url: 'u', state: 'merged' } },
    );
  }

  /** The cost records after the three learned, once T3 has read usage after the jobs ended. */
  async measured(): Promise<UsageRecord[]> {
    this.now = new Date(this.now.getTime() + 60_000);
    this.usage.read_again();
    await this.gate!.settled();
    const text = await readFile(join(dir, 'state', 'usage.jsonl'), 'utf8');
    return text.trim().split('\n').map((l) => JSON.parse(l)).filter((r) => !String(r.job).startsWith('learned-'));
  }
}

/** A reading `five`% into a 5-hour window resetting in 3 hours, `week`% into a week resetting in 3
 *  days (Python's `used`). */
const used = (five: number, week = 10): Read => ({
  five, week, five_reset: new Date(SIDE_NOW.getTime() + 3 * 3_600_000), week_reset: new Date(SIDE_NOW.getTime() + 3 * 86_400_000),
});

describe('SideBySideTest', () => {
  let h: SideHarness;
  beforeEach(async () => {
    h = new SideHarness();
    await h.learn();
  });

  test('test_one_pass_starts_a_build_in_each_repo_and_they_run_at_the_same_time', async () => {
    const [code] = await h.once(new Together([[0, 'completed'], [0, 'completed']]));
    expect(code).toBe(0);
    expect(h.built().sort()).toEqual(['first', 'second']);
    const done = new Set(h.log.jobs().map((j) => `${j.repo} ${j.issue} ${j.outcome}`));
    expect(done).toEqual(new Set(['first 4 done', 'second 7 done']));
  });

  test('test_the_loop_runs_them_side_by_side_too', async () => {
    h.t3 = new Together([[0, 'completed'], [0, 'completed']]);
    await expect(h.forever(h.gh, h.t3, async () => { throw new Stop(); })).rejects.toBeInstanceOf(Stop);
    expect(h.built().sort()).toEqual(['first', 'second']);
  });

  test('test_a_repo_with_a_job_running_gets_no_other_until_it_ends', async () => {
    let release!: () => void;
    let released = false;
    const go = new Promise<void>((r) => { release = () => { released = true; r(); }; });
    const planned: string[] = [];
    h.gh.by_repo.get('first')!.push(issue(5, 'Green widget', 'Green.'));
    const ready = h.gh.ready_issues.bind(h.gh);
    // the lane plans again once second's #7 has ended (the reviewer lane reads no ready issues)
    h.gh.ready_issues = async (repo) => {
      planned.push((repo as unknown as Repo).name);
      if (planned.filter((n) => n === 'second').length === 2) release();
      return ready(repo);
    };

    /** first's #4 runs until the lane has planned again without it. */
    class FirstBlocks extends FakeT3 {
      override async start(...args: Parameters<FakeT3['start']>): Promise<RunResult> {
        if (args[0].endsWith('first') && !released) await go;
        return super.start(...args);
      }
    }
    h.t3 = new FirstBlocks(Array(3).fill([0, 'completed']));
    await expect(h.forever(h.gh, h.t3, async () => { throw new Stop(); })).rejects.toBeInstanceOf(Stop);
    expect(released).toBe(true);
    const titles = h.t3.starts.map((s) => s.title);
    expect(titles.slice(0, 2).sort()).toEqual(['Queue runner build: first#4', 'Queue runner build: second#7']);
    expect(titles.slice(2)).toEqual(['Queue runner build: first#5']);   // once #4 had ended
    // The pass after #7 ended chose nothing in first, whose #4 still ran
    expect(planned.slice(0, 3)).toEqual(['first', 'second', 'second']);
  });

  test.todo('test_a_stopped_repo_gets_none (the switches, #229)');

  test('test_a_job_a_dead_runner_left_running_holds_only_its_own_repo', async () => {
    await h.write_events({ event: 'start', job: 'dead', kind: 'build', repo: 'first', issue: 3, branch: 'claude/x-3',
      title: 'Queue runner build: first#3', at: '2026-11-15T11:00:00+00:00' });
    const t3 = new FakeT3([[0, 'completed']]);
    t3.add('mcp:dead', 'Queue runner build: first#3', 'running', '2026-11-15T11:00:01.000Z');
    await h.once(t3);
    expect(h.built()).toEqual(['second']);
    expect(h.runner_log()).toContain('build first#3 is still running in');
  });
});

describe('RestartTest (serving itself, #237)', () => {
  test.todo('test_new_code_waits_for_the_running_jobs_and_starts_none_meanwhile');
});

describe('GateTest', () => {
  let h: SideHarness;
  beforeEach(() => {
    h = new SideHarness();
  });

  test('test_with_room_for_one_build_the_first_in_config_toml_gets_it_on_a_tie', async () => {
    h.usage = new T3Usage(() => h.now, used(30));   // 30 + 60 fits; 30 + 60 + 60 not
    await h.once();
    expect(h.built()).toEqual(['first']);
    // the app's gate names the window and the job running there
    expect(h.runner_log()).toContain("Builder lane waits on second: Claude's 5-hour window would fit this build alone, "
      + 'but the jobs running there (build first#4) are expected to take 60%');
  });

  test('test_the_repo_whose_work_waited_longest_goes_first', async () => {
    await h.earlier_build('first', 1, '2026-11-15T11:30:00+00:00');
    await h.earlier_build('second', 2, '2026-11-15T09:00:00+00:00');
    h.usage = new T3Usage(() => h.now, used(30));
    await h.once();
    expect(h.built()).toEqual(['second']);
    await h.earlier_build('second', 3, '2026-11-15T11:50:00+00:00');
    await rm(h.log.path);   // afresh: now first has waited longer
    await h.earlier_build('first', 1, '2026-11-15T09:00:00+00:00');
    await h.earlier_build('second', 2, '2026-11-15T11:30:00+00:00');
    await h.once();
    expect(h.built()).toEqual(['first']);
  });

  // first (the tie's winner) has a build the gate holds; second's job that fits is a decision
  test.todo('test_a_job_that_does_not_fit_leaves_room_for_a_later_one_that_does (decisions, #226)');

  test('test_two_jobs_at_once_teach_the_learned_costs_nothing', async () => {
    await h.learn();
    await h.once(new Together([[0, 'completed'], [0, 'completed']]));
    const records = await h.measured();
    expect(records.length).toBe(2);
    const shared = new Map(records.map((r) => [r.job, r.sharedWith]));
    expect([...shared.values()].every((v) => v?.length)).toBe(true);
    expect([...shared.values()].flatMap((v) => v!).sort()).toEqual(['build first#4', 'build second#7']);
  });

  test('test_one_job_alone_still_teaches', async () => {
    h.gh.by_repo.set('second', []);
    await h.once();
    const records = await h.measured();
    expect(records.length).toBe(1);
    expect(records[0]!.sharedWith).toBeUndefined();
    expect(records[0]!.kind).toBe('build');
  });
});

describe('LimitTest (limit recovery, #227)', () => {
  test.todo('test_both_jobs_cut_off_are_recovered_each_in_its_repo');
});

describe('DryRunAndGateTest (the dry run, #238)', () => {
  test.todo('test_the_dry_run_lists_each_repos_job');
  test.todo('test_a_stopped_repo_has_no_job_in_it');
  test.todo('test_a_repo_with_a_job_running_lists_none');
  test.todo('test_a_repo_with_nothing_says_so_and_the_other_still_lists_its_job');
  test.todo('test_gate_says_how_many_could_start');
  test.todo('test_gate_counts_the_jobs_running');
});

describe('SnapshotTest (the snapshot, #230)', () => {
  test.todo('test_it_shows_both_jobs_while_they_run');
});

describe('OldOrderTest (the switches, #229)', () => {
  test.todo('test_an_old_order_is_ignored_without_a_word');
  test.todo('test_its_stops_still_stand');
  test.todo('test_the_snapshot_keeps_config_tomls_order');
  test.todo('test_a_write_drops_it');
});

// --- tests/test_gating.py -------------------------------------------------------------------------

describe('GatingTest', () => {
  const NOW = new Date('2026-11-10T12:00:00Z');
  const FIVE_RESET = new Date(NOW.getTime() + 2 * 3_600_000);
  const WEEK_RESET = new Date(NOW.getTime() + 3 * 86_400_000);
  const usage = (five: number, week: number): Read => ({ five, week, five_reset: FIVE_RESET, week_reset: WEEK_RESET });
  const gh = () => new FakeGitHubWithPulls({ issues: [issue(4, 'Red widget', 'Make it red.')], pulls_by_branch: { 'claude/red-widget-4': PR } });
  let h: Harness;
  beforeEach(() => {
    h = new Harness([served('first', dir)], 300, NOW);
  });

  test('test_a_build_that_wont_fit_the_five_hour_window_waits_and_says_until_when', async () => {
    h.usage = new T3Usage(() => h.now, usage(80, 20));
    const t3 = new FakeT3([[0, 'completed']]);
    await h.run_main(['--once'], gh(), t3);
    expect(t3.starts).toEqual([]);
    expect(h.log.jobs()).toEqual([]);
    expect(h.runner_log()).toContain('Builder lane waits');
    expect(h.runner_log()).toContain(`resets at ${local_minute(FIVE_RESET)}`);
  });

  test('test_a_build_that_fits_starts_and_records_usage_before_and_after', async () => {
    h.usage = new T3Usage(() => h.now, usage(10, 20), usage(35, 24));
    const t3 = new FakeT3([[0, 'completed']]);
    await h.run_main(['--once'], gh(), t3);
    expect(t3.starts.length).toBe(1);
    expect(h.log.jobs().length).toBe(1);
    h.now = new Date(NOW.getTime() + 600_000);
    h.usage.read_again();   // T3's next reading, after the job ended
    await h.gate!.settled();
    const records: UsageRecord[] = (await readFile(join(dir, 'state', 'usage.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(records.length).toBe(1);
    // the app's gate keeps one record per job, under the label it let the job in by
    expect([records[0]!.kind, records[0]!.job]).toEqual(['build', 'build first#4']);
    expect(records[0]!.before.windows.five_hour!.used).toBe(10);
    expect(records[0]!.spent).toEqual({ five_hour: 25, seven_day: 4 });
  });

  // test_a_short_job_still_teaches_its_cost_the_after_read_waits_for_the_budget is left out: the
  // five-minute budget on Claude's usage endpoint (T3 reads usage now).

  test('test_unreadable_usage_starts_nothing_and_says_why', async () => {
    h.usage = new T3Usage(() => h.now, 'none');
    const t3 = new FakeT3([[0, 'completed']]);
    await h.run_main(['--once'], gh(), t3);
    expect(t3.starts).toEqual([]);
    expect(h.runner_log()).toContain("T3 has no reading of Claude's usage yet");
  });

  test.todo('test_pause_and_resume_work_between_passes (the switches, #229)');

  // test_a_changed_reserve_holds_the_week_back is left out: gate.json's reserve (the app's Your
  // share replaces it).

  test('test_the_continuous_mode_sleeps_no_longer_than_until_the_reset', async () => {
    h.usage = new T3Usage(() => h.now, { five: 80, week: 20, five_reset: new Date(NOW.getTime() + 30_000), week_reset: WEEK_RESET });
    const slept: number[] = [];
    await expect(h.forever(gh(), new FakeT3([[0, 'completed']]), async (s) => { slept.push(s); throw new Stop(); }))
      .rejects.toBeInstanceOf(Stop);
    expect(slept[0]).toBeLessThan(300);
  });

  test('test_a_wait_that_has_passed_doesnt_shorten_a_later_idle_pause', async () => {
    h.usage = new T3Usage(() => h.now, usage(80, 20), usage(0, 20));
    const slept: number[] = [];
    const t3 = new FakeT3([[0, 'completed']]);
    const sleep = async (s: number) => {
      slept.push(s);
      h.now = new Date(FIVE_RESET.getTime() + 3_600_000);   // the reset came and went
      h.usage.read_again();
      if (slept.length === 2) throw new Stop();
    };
    // gated, then the build starts, then nothing to start
    await expect(h.forever(gh(), t3, sleep)).rejects.toBeInstanceOf(Stop);
    expect(t3.starts.length).toBe(1);
    expect(slept[1]).toBe(300);
  });

  // test_gate_prints_the_windows_and_each_kind is left out: `--gate` (the app's Usage page shows
  // each provider's windows).
});

// --- tests/test_usage_budget.py -------------------------------------------------------------------

// TimelineTest, BudgetTest, FailedCallTest, AfterJobTest and MeasuredRaceTest are left out: they
// test the five-minute budget on Claude's usage endpoint and its cached reading, and T3 reads usage
// now.

describe('EndedElsewhereTest', () => {
  // A builder thread that ends outside a measured pass (PR 67's review 1, F1): a stopped runner's
  // job settled, or a waiting job the user answered that has since ended. The next check decides
  // only on a reading T3 took after the runner saw it end, as after a measured job.
  const SGT = 8 * 3_600_000;
  /** 2026-11-16 at h:m:s in Singapore, as the Python cases' clock. */
  const t = (hh: number, mm: number, ss = 0) => new Date(Date.UTC(2026, 10, 16, hh, mm, ss) - SGT);
  let h: Harness;
  let t3: FakeT3;
  let r: Runner;
  let five: number;
  const gh = new FakeGitHubWithPulls({ issues: [issue(5)] });

  beforeEach(async () => {
    h = new Harness([served('queue-runner', 'C:/qr', 'stefan1575/queue-runner')], 300, t(14, 1, 49));
    five = 38;
    h.usage = new T3Usage(() => h.now);
    t3 = new FakeT3([[0, 'completed']]);
    r = await h.make(gh, t3);
  });

  /** T3 reads the usage now: `five`% of 5 hours. */
  const tick = () => h.usage.read_again(h.now, { five, week: 10, five_reset: t(18, 0), week_reset: t(23, 0) });

  /** A build left open by a stopped runner, its thread in T3 (if `status`). */
  const a_build = (status: string | null = null) => {
    const job = h.log.started({ kind: 'build', repo: 'queue-runner', issue: 4, branch: 'claude/a-ticket-4', title: 'Queue runner build: queue-runner#4' });
    if (status) t3.add('mcp:old', job.title, status);
    return job;
  };

  /** A build waiting on the user, its end record naming the run that asked (#85). */
  const a_waiting_build = () => {
    const job = a_build();
    h.log.ended(job.id, { exit_code: 2, outcome: 'waiting', thread_id: 'mcp:w', run_id: 'run:mcp:w:1' });
    t3.add('mcp:w', job.title, 'waiting');
    return job;
  };

  /** The user answered the thread in T3: a newer run, now `status`. */
  const ran_again = (thread_id: string, status: string) => {
    t3.threads.set(thread_id, new Thread({ ...t3.threads.get(thread_id)!, status, latest_run_id: `run:${thread_id}:2` }));
  };

  /** The pass after the job ended: held on the reading from before it, until T3 reads again (the
   *  app's gate has no time for that: T3 reads on its own); then it decides on the new reading (90%
   *  used: a build won't fit). */
  const assert_held_until_the_next_read = async () => {
    expect(await r.run_pass()).toBe(GATED);
    expect(t3.starts).toEqual([]);
    expect(r.builder_wait!.reason).toContain('since the last job there ended');
    expect(r.gate_until).toBeNull();
    h.now = t(14, 6, 49);
    tick();
    expect(await r.run_pass()).toBe(GATED);
    expect(h.gate!.pick('build queue-runner#5', 'build')).toMatchObject({ fits: false, hold: { why: 'window' } });
    expect(t3.starts).toEqual([]);
  };

  test('test_a_dead_runners_job_that_ends_holds_the_next_job_for_a_reading_after_it', async () => {
    a_build('running');
    five = 10;
    tick();                                    // 14:01:49: 10% while the job runs
    expect(await r.run_pass()).toBe(BUSY);
    h.now = t(14, 2, 49);
    five = 90;                                 // what the job spent
    t3.set_status('mcp:old', 'completed');
    await assert_held_until_the_next_read();
  });

  test('test_a_dead_runners_job_found_ended_on_the_first_pass_counts_too', async () => {
    a_build('completed');
    five = 10;
    tick();                                    // read before the pass settled it
    h.now = t(14, 2, 49);
    five = 90;
    await assert_held_until_the_next_read();
  });

  test('test_a_waiting_job_answered_and_ended_since_holds_the_next_job_too', async () => {
    const job = a_build();
    h.log.ended(job.id, { exit_code: 2, outcome: 'waiting', thread_id: 'mcp:w' });
    t3.add('mcp:w', job.title, 'running');     // the user answered it in T3
    five = 10;
    tick();
    expect(await r.run_pass()).toBe(BUSY);
    h.now = t(14, 2, 49);
    five = 90;
    t3.set_status('mcp:w', 'completed');
    await assert_held_until_the_next_read();
  });

  test('test_a_waiting_job_that_ran_on_stefans_answer_and_asks_again_holds_the_next_job', async () => {
    a_waiting_build();
    ran_again('mcp:w', 'running');             // the user answered it in T3
    five = 10;
    tick();
    expect(await r.run_pass()).toBe(BUSY);
    h.now = t(14, 2, 49);
    five = 90;
    t3.set_status('mcp:w', 'waiting');         // it ran, and asks again
    await assert_held_until_the_next_read();
    expect(h.log.jobs()[0]!.outcome).toBe('waiting');
  });

  test('test_a_waiting_job_still_on_the_run_that_asked_holds_nothing', async () => {
    a_waiting_build();                         // the user hasn't answered
    tick();
    h.now = t(14, 2, 49);
    // no run since it asked: nothing ended, so the build goes on the 14:01:49 reading
    expect(await r.run_pass()).toBe(STARTED);
    expect(t3.starts.length).toBe(1);
  });

  test('test_a_run_on_stefans_answer_is_told_to_the_gate_once', async () => {
    a_waiting_build();
    ran_again('mcp:w', 'waiting');
    five = 10;
    tick();
    h.now = t(14, 2, 49);
    five = 90;
    await assert_held_until_the_next_read();   // its next pass decides on 14:06:49's
    h.now = t(14, 8);
    expect(await r.run_pass()).toBe(GATED);
    // the same run: not told again, so 14:06:49's reading stands and holds it on its window
    expect(r.builder_wait!.reason).toContain("Claude's 5-hour window resets at");
  });

  test('test_a_run_on_stefans_answer_no_pass_saw_running_holds_the_next_job', async () => {
    a_waiting_build();
    five = 10;
    tick();
    h.now = t(14, 2, 49);
    five = 90;
    ran_again('mcp:w', 'waiting');             // ran and asked again, all between passes
    await assert_held_until_the_next_read();
    expect(h.log.jobs()[0]!.outcome).toBe('waiting');
  });

  // test_a_dead_runners_live_run_settled_holds_the_next_job_too is left out: the live steps are
  // dropped from the port.

  test('test_jobs_settled_that_never_reached_a_thread_hold_nothing', async () => {
    a_build();                                 // no thread in T3: not-started (the live run's half is dropped)
    tick();
    h.now = t(14, 2, 49);
    expect(await r.run_pass()).toBe(STARTED);  // a build, on the 14:01:49 reading
    expect(t3.starts.length).toBe(1);
  });

  test.todo('test_a_decision_thread_whose_retry_never_reached_the_job_holds_the_next_job (decisions, #226)');

  test('test_a_pass_whose_job_reached_no_thread_holds_nothing', async () => {
    tick();
    const run_ = async (): Promise<Did> => {   // T3 down: the build never started
      const job = a_build();
      h.log.ended(job.id, { exit_code: null, outcome: 'not-started', error: 'T3 is down' });
      return IDLE;
    };
    r.choose = async () => [new Start({ repo: 'queue-runner', kind: 'build', then: null, run: run_, label: 'build queue-runner#5' })];
    await r.run_pass();
    delete (r as Partial<Runner>).choose;
    h.now = t(14, 2, 49);
    expect(await r.run_pass()).toBe(STARTED);  // the next build goes on the same reading
  });
});

describe('DeadFallbackReviewTest (reviews, #222)', () => {
  // A stopped runner's fallback review whose thread runs on in T3 (PR 67's review 2, F2). Python's
  // class also runs EndedElsewhereTest's cases (but its first two) with a reviewer set.
  test.todo('test_the_sol_lane_keeps_it_open_while_its_thread_runs_then_counts_it_failed');
  test.todo('test_a_dead_runners_review_thread_whose_settle_fails_is_said_and_counted');
  test.todo('test_the_claude_lane_seeing_it_end_first_tells_the_gate_once');
  test.todo('test_the_sol_lanes_own_review_now_runs_beside_the_claude_lane');
  test.todo('test_a_review_that_never_started_a_thread_is_counted_failed_and_holds_nothing');
  test.todo('test_t3_unreadable_keeps_both_lanes_off_it');
  test.todo("EndedElsewhereTest's cases with a reviewer set");
});

// The run loop through its command line: `--once`, the continuous mode and `--release`, with
// GitHub, T3 and git faked. Ported from `tests/test_run.py` case for case (#219). The config file
// is `settings.toml` in the test's temp folder: a file named as the runner's is refused in a test
// (docs/app.md, Test it), and `load_config` reads any path. Time is the fake clock's, where Python's
// test runs on the real one; the cases waiting on a later port are `it.todo`, named as in Python,
// under the ticket that turns them on.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { main } from '../src/app.ts';
import { NoToaster, NoWaker } from '../src/later-parts.ts';
import { runner_lock } from '../src/lock.ts';
import { JobLog } from '../src/state.ts';
import { Message, RunResult, T3Error } from '../src/t3-seam.ts';
import { FakeGit, FakeGitHubWithPulls, FakeUsage, issue } from './fakes.ts';
import { FakeT3, type Outcome } from './fakes-t3.ts';

const PR = { number: 12, url: 'https://github.com/owner/first/pull/12', state: 'open' };

class Stop extends Error {}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-23T04:00:00Z') });
});

const harnesses: Harness[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const h of harnesses.splice(0)) rmSync(h.tmp, { recursive: true, force: true });
});

/** A config, a job log and `main` with GitHub, T3 and git faked. */
class Harness {
  readonly tmp: string;
  readonly dir: string;
  readonly config: string;
  readonly log: JobLog;

  constructor() {
    this.tmp = mkdtempSync(join(tmpdir(), 'qr-run-'));
    harnesses.push(this);
    this.dir = this.tmp.replaceAll('\\', '/');
    this.config = join(this.dir, 'settings.toml');
    writeFileSync(this.config, `
state_dir = "${this.dir}/state"
log_dir = "${this.dir}/logs"
poll_seconds = 60

[claude]
provider = "claudeAgent"
model = "claude-opus-5-5"

[[repos]]
name = "first"
github = "owner/first"
path = "${this.dir}"
`, 'utf8');
    this.log = new JobLog(join(this.dir, 'state', 'jobs.jsonl'));
  }

  async run_main(args: string[], github: FakeGitHubWithPulls, t3: FakeT3, git: FakeGit | null = null,
    sleep: ((s: number) => Promise<void>) | null = null): Promise<[number, string]> {
    let out = '';
    const code = await main([...args, '--config', this.config], {
      github, t3, git: git ?? new FakeGit(), sleep: sleep ?? (async () => {}), toaster: new NoToaster(),
      usage: new FakeUsage(), waker: new NoWaker(),
    }, (s) => (out += s));
    return [code, out];
  }

  runner_log(): string {
    return readFileSync(join(this.dir, 'logs', 'runner.log'), 'utf8');
  }
}

describe('RunTest', () => {
  test('once starts the picked build in a t3 worktree and records it', async () => {
    const h = new Harness();
    const gh = new FakeGitHubWithPulls({ issues: [issue(4, 'Red widget', 'Make it red.')], pulls_by_branch: { 'claude/red-widget-4': PR } });
    const t3 = new FakeT3([[0, 'completed']]);
    const git = new FakeGit({ commits: { 'claude/red-widget-4': [{ sha: 'abc1234', subject: 'Red' }] } });
    const [code, out] = await h.run_main(['--once'], gh, t3, git);

    expect(code).toBe(0);
    expect(t3.starts).toHaveLength(1);
    const [start] = t3.starts;
    expect([start!.project, start!.worktree, start!.branch]).toEqual([normalize(h.dir), 'origin/main', 'claude/red-widget-4']);
    expect([start!.provider, start!.model]).toEqual(['claudeAgent', 'claude-opus-5-5']);
    expect(String(start!.message).startsWith('Build GitHub issue #4 in owner/first')).toBe(true);
    expect(git.fetches).toEqual([[normalize(h.dir), 'main']]);

    const jobs = h.log.jobs();
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect([job!.kind, job!.repo, job!.issue, job!.branch]).toEqual(['build', 'first', 4, 'claude/red-widget-4']);
    expect([job!.thread_id, job!.exit_code, job!.outcome]).toEqual(['mcp:t1', 0, 'done']);
    expect(job!.link!.startsWith('https://app.t3.codes/')).toBe(true);
    expect(job!.pr).toEqual(PR);
    expect(job!.commits).toEqual([{ sha: 'abc1234', subject: 'Red' }]);
    expect(job!.worktree).toBe('C:/t3/worktrees/mcp:t1');
    expect(h.runner_log()).toContain('build first#4 ended: done');
    expect(out).toContain('owner/first#4');
  });

  test('a completed build without a pr is recorded as such', async () => {
    const h = new Harness();
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)] });
    await h.run_main(['--once'], gh, new FakeT3([[0, 'completed']]));
    expect(h.log.jobs()[0]!.outcome).toBe('done-no-pr');
  });

  test('a waiting job is recorded done once its thread completes', async () => {
    const h = new Harness();
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)], pulls_by_branch: { 'claude/a-ticket-4': PR } });
    const t3 = new FakeT3([[2, 'waiting']]);
    await h.run_main(['--once'], gh, t3);
    t3.set_status('mcp:t1', 'completed');   // Stefan answered it in T3
    await h.run_main(['--once'], gh, t3);
    const jobs = h.log.jobs();
    expect(jobs).toHaveLength(1);
    expect([jobs[0]!.exit_code, jobs[0]!.outcome, jobs[0]!.pr]).toEqual([0, 'done', PR]);
    expect(t3.starts).toHaveLength(1);
  });

  test('t3 failing before any thread exists is retried next pass', async () => {
    const h = new Harness();
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)] });
    const t3 = new FakeT3([new T3Error('T3 Code server is not running'), [0, 'completed']]);
    await h.run_main(['--once'], gh, t3);
    expect(h.log.jobs()[0]!.outcome).toBe('not-started');
    expect(h.log.jobs()[0]!.error).toContain('server is not running');
    await h.run_main(['--once'], gh, t3);
    expect(h.log.jobs().map((j) => j.outcome)).toEqual(['not-started', 'done-no-pr']);
  });

  test('t3 failing after its thread started leaves the job open for the next pass', async () => {
    const h = new Harness();
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
    expect(jobs).toHaveLength(1);
    expect([jobs[0]!.thread_id, jobs[0]!.exit_code, jobs[0]!.outcome]).toEqual(['mcp:t1', 0, 'done']);
  });

  test('a job still running from a dead runner blocks a second claude job', async () => {
    const h = new Harness();
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

  test('an open job whose thread never started is closed', async () => {
    const h = new Harness();
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)] });
    h.log.started({ kind: 'build', repo: 'first', issue: 4, branch: 'claude/a-ticket-4', title: 'Queue runner build: first#4' });
    const t3 = new FakeT3([[0, 'completed']]);
    await h.run_main(['--once'], gh, t3);
    expect(h.log.jobs().map((j) => j.outcome)).toEqual(['not-started', 'done-no-pr']);
  });

  test('a leftover local branch holds the issue without starting a thread', async () => {
    const h = new Harness();
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)] });
    const t3 = new FakeT3();
    await h.run_main(['--once'], gh, t3, new FakeGit({ branches: ['claude/a-ticket-4'] }));
    expect(t3.starts).toEqual([]);
    expect(h.log.jobs()[0]!.outcome).toBe('branch-exists');
    expect(h.log.held_issues('first')).toEqual(new Set([4]));
  });

  test('release lets a held issue be picked again', async () => {
    const h = new Harness();
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)] });
    const t3 = new FakeT3([[1, 'failed'], [0, 'completed']]);
    await h.run_main(['--once'], gh, t3);
    const [code] = await h.run_main(['--release', 'first#4'], gh, t3);
    expect(code).toBe(0);
    await h.run_main(['--once'], gh, t3);
    expect(t3.starts).toHaveLength(2);
  });

  test('continuous mode runs pass after pass and sleeps when idle', async () => {
    const h = new Harness();
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)], pulls_by_branch: { 'claude/a-ticket-4': PR } });
    const t3 = new FakeT3([[0, 'completed']]);
    const sleeps: number[] = [];

    const sleep = async (seconds: number) => {
      sleeps.push(seconds);
      if (sleeps.length === 2) throw new Stop();
    };

    await expect(h.run_main([], gh, t3, null, sleep)).rejects.toThrow(Stop);
    expect(t3.starts).toHaveLength(1);   // the job, then two idle passes
    expect(sleeps).toEqual([60, 60]);
  });

  test('a failing pass is logged and the loop goes on', async () => {
    const h = new Harness();
    class Broken extends FakeGitHubWithPulls {
      override async ready_issues(): Promise<never> {
        throw new Error('GitHub is down');
      }
    }

    const sleeps: number[] = [];

    const sleep = async (seconds: number) => {
      sleeps.push(seconds);
      throw new Stop();
    };

    await expect(h.run_main([], new Broken(), new FakeT3(), null, sleep)).rejects.toThrow(Stop);
    expect(h.runner_log()).toContain('GitHub is down');
  });

  test('a waiting thread t3 cannot read counts as busy', async () => {
    const h = new Harness();
    const gh = new FakeGitHubWithPulls({ issues: [issue(4), issue(5)] });
    const t3 = new FakeT3([[2, 'waiting'], [0, 'completed']]);
    await h.run_main(['--once'], gh, t3);
    t3.threads.delete('mcp:t1');   // T3 can't say whether Stefan's answer set it running again
    await h.run_main(['--once'], gh, t3);
    expect(t3.starts).toHaveLength(1);
  });

  test('a failed build records the pr it opened', async () => {
    const h = new Harness();
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)], pulls_by_branch: { 'claude/a-ticket-4': PR } });
    await h.run_main(['--once'], gh, new FakeT3([[1, 'interrupted']]));
    const jobs = h.log.jobs();
    expect(jobs).toHaveLength(1);
    expect([jobs[0]!.outcome, jobs[0]!.pr]).toEqual(['failed', PR]);
  });

  test('continuous mode pauses after a build that never started', async () => {
    const h = new Harness();
    const gh = new FakeGitHubWithPulls({ issues: [issue(4)] });
    const t3 = new FakeT3([new T3Error('T3 Code server is not running')] as Outcome[]);
    const sleeps: number[] = [];

    const sleep = async (seconds: number) => {
      sleeps.push(seconds);
      throw new Stop();
    };

    await expect(h.run_main([], gh, t3, null, sleep)).rejects.toThrow(Stop);
    expect([t3.starts.length, sleeps]).toEqual([1, [60]]);
  });

  test('a second runner exits while one holds the lock', async () => {
    const h = new Harness();
    const lock = runner_lock(join(h.dir, 'state'));
    let code: number, out: string;
    try {
      [code, out] = await h.run_main(['--once'], new FakeGitHubWithPulls({ issues: [issue(4)] }), new FakeT3());
    } finally {
      lock[Symbol.dispose]();
    }
    expect(code).toBe(3);
    expect(out).toContain('already running');
  });
});

// A failed or waiting build's next pass is a decision on it (`decisions.py`).
describe('RunTest, turned on by decisions (#226)', () => {
  it.todo('test_a_failed_run_is_recorded_and_its_issue_not_picked_again');
  it.todo('test_a_run_waiting_for_an_answer_holds_its_issue');
});

describe('RunTest, turned on by the dry run (#238)', () => {
  it.todo('test_dry_run_skips_held_issues');
  it.todo('test_dry_run_names_a_pending_decision_first_with_its_brief');
  it.todo('test_dry_run_also_says_which_prs_sol_would_review');
  it.todo('test_dry_run_prints_the_fix_brief_for_a_blocking_pr_and_starts_nothing');
});

describe('RunTest, turned on by reviews (#222)', () => {
  it.todo('test_once_runs_a_build_and_a_review_alongside');
  it.todo('test_an_open_review_is_the_sol_lanes_to_settle_not_the_claude_lanes');
  it.todo('test_review_one_pr_now');
});

// What a failed run's end record says of a usage limit, read from what the run said, as Python's
// Runner reads it with no T3Store (`limits` None); the rest waits on #227.
const LIMIT_SAID = "You've hit your weekly limit · resets Nov 9, 7pm (Asia/Singapore)";

describe('LimitRecoveryTest', () => {
  test('any other failure is not a limit stop', async () => {
    const h = new Harness();
    const t3 = new FakeT3([[1, 'failed']]);
    t3.messages.set('mcp:t1', [new Message('assistant', 'The type checker keeps failing.')]);
    await h.run_main(['--once'], new FakeGitHubWithPulls({ issues: [issue(4), issue(5)] }), t3);
    expect(h.log.jobs()[0]!.outcome).toBe('failed');
  });

  test("an earlier run's limit message doesn't make a later failure a limit stop", async () => {
    const h = new Harness();
    const t3 = new FakeT3([[1, 'failed']]);
    t3.messages.set('mcp:t1', [new Message('assistant', LIMIT_SAID, 'run:mcp:t1:0')]);
    await h.run_main(['--once'], new FakeGitHubWithPulls({ issues: [issue(4), issue(5)] }), t3);   // this run is run:mcp:t1:1 and said nothing
    expect(h.log.jobs()[0]!.outcome).toBe('failed');
  });

  test("claude code's limit message is enough when t3 recorded nothing", async () => {
    const h = new Harness();
    const t3 = new FakeT3([[1, 'failed']]);
    t3.messages.set('mcp:t1', [new Message('assistant', LIMIT_SAID)]);
    await h.run_main(['--once'], new FakeGitHubWithPulls({ issues: [issue(4), issue(5)] }), t3);
    const job = h.log.jobs()[0]!;
    expect([job.outcome, job.context]).toEqual(['usage-limit', null]);
  });
});

describe('LimitRecoveryTest, turned on by limit recovery (#227)', () => {
  it.todo('test_a_limit_stop_is_recorded_with_its_resume_time_and_context');
  it.todo('test_nothing_else_starts_until_ten_minutes_after_the_reset');
  it.todo('test_a_warm_thread_is_continued_in_place_at_any_size');
  it.todo('test_the_stop_records_its_last_request_and_a_dry_run_says_the_choice');
  it.todo('test_a_cold_thread_under_120k_tokens_is_continued_in_place');
  it.todo('test_a_small_thread_is_continued_in_place_after_the_reset');
  it.todo('test_a_cold_big_thread_restarts_fresh_on_its_branch_at_its_newest_commit');
  it.todo('test_the_runner_warns_at_start_if_t3_resumes_limited_threads_itself');
  it.todo('test_t3s_record_of_another_failure_wins_over_a_limit_message');
  it.todo('test_a_restart_that_cant_be_made_holds_the_job_and_isnt_tried_again');
});

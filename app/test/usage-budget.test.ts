// Claude's usage read as T3 Code reads it (issue 66): one cached reading, at most one call to the
// endpoint every 5 minutes whoever asks (the gate, its after-job read, the snapshot's read), and a
// failed call keeps the last good reading. Ported from `tests/test_usage_budget.py` case for case
// (#219).
//
// Wired as the command line wires them: one `CachedUsage` (`app.ts`'s `_gate`) is the gate's reader,
// around a real `OAuthUsage` on `StubEndpoint`, which answers 429 when it's asked within a minute
// of its last call, as the real one does. Nothing calls Anthropic. Python's harness also builds the
// dashboard's snapshot on the same reader; the snapshot is ported in #230, so `tick()` here is what
// the publisher's 30-second write does to Claude's reader when no Refresh is asked
// (`Snapshots.facts(fresh=True)`: `read_if_due(READ_EVERY)`). The cases that press Refresh or read
// the snapshot wait for #230, and the rest of the cases waiting on a later port are `it.todo`,
// named as in Python, under the ticket that turns them on.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { _gate } from '../src/app.ts';
import { Config, Repo } from '../src/config.ts';
import { FIVE_HOUR, type Gate, UNREADABLE } from '../src/job-gate.ts';
import { BUSY, GATED, Runner, Start, STARTED } from '../src/run.ts';
import { JobLog } from '../src/state.ts';
import { Thread } from '../src/t3-seam.ts';
import { FakeGit, FakeGitHubWithPulls, issue, StubEndpoint } from './fakes.ts';
import { FakeT3 } from './fakes-t3.ts';

const MINUTE = 60_000;
const QR = new Repo({ name: 'queue-runner', github: 'stefan1575/queue-runner', path: 'C:/qr' });
const READ_EVERY = 300;   // `snapshot.READ_EVERY`: the snapshot reads usage itself no more often than this

/** 2026-11-16 at h:m:s in Singapore (+08:00). */
function t(h: number, m: number, s = 0): Date {
  return new Date(Date.UTC(2026, 10, 16, h - 8, m, s));
}

class Clock {
  t = t(14, 1, 49);
  readonly call = () => this.t;

  at(h: number, m: number, s = 0): void {
    this.t = t(h, m, s);
  }

  tick({ minutes = 0, seconds = 0 }: { minutes?: number; seconds?: number }): void {
    this.t = new Date(this.t.getTime() + minutes * MINUTE + seconds * 1000);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: t(14, 1, 49) });
});

const temps: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

class Harness {
  readonly tmp: string;
  readonly state: string;
  readonly config: Config;
  readonly clock = new Clock();
  readonly endpoint: StubEndpoint;
  readonly slept: number[] = [];
  readonly gate: Gate;

  constructor() {
    this.tmp = mkdtempSync(join(tmpdir(), 'qr-budget-'));
    temps.push(this.tmp);
    this.state = join(this.tmp, 'state');
    mkdirSync(this.state);
    this.config = new Config({ repos: [QR], state_dir: this.state, log_dir: join(this.tmp, 'logs') });
    this.endpoint = new StubEndpoint(this.clock.call);
    this.gate = _gate(this.config, this.endpoint.oauth(this.tmp), this.clock.call, (s) => this.sleep(s));
  }

  /** `wall_sleep`, on the test's clock. */
  async sleep(seconds: number): Promise<void> {
    this.slept.push(seconds);
    this.clock.tick({ seconds });
  }

  /** The publisher's own 30-second write, as it reads Claude's usage. */
  async tick(): Promise<void> {
    await this.gate.reader.read_if_due(READ_EVERY);
  }

  /** A Claude job that checks, runs `minutes` and is measured, as the run loop's worker does. */
  async job(minutes: number) {
    const verdict = await this.gate.check('fix');
    expect(verdict.go, verdict.text).toBe(true);
    this.clock.tick({ minutes });
    await this.gate.measured('fix', [], verdict.usage!);
    return verdict;
  }

  statuses(): number[] {
    return this.endpoint.calls.map(([, s]) => s);
  }
}

describe('TimelineTest, turned on by the snapshot (#230)', () => {
  it.todo('test_stefans_refresh_on_2026_11_16');
});

describe('BudgetTest, turned on by the snapshot (#230)', () => {
  it.todo('test_all_four_callers_ask_the_endpoint_at_most_once_every_five_minutes');
});

describe('FailedCallTest, turned on by the snapshot (#230)', () => {
  it.todo('test_a_429_beside_a_recent_reading_taken_after_the_last_job_lets_the_gate_go');
  it.todo('test_a_reading_past_thirty_minutes_with_failing_calls_holds_the_lane_and_the_card_says_so');
});

describe('AfterJobTest', () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  test('the next check uses the after read', async () => {
    await h.tick();
    h.clock.tick({ minutes: 1 });
    h.endpoint.five = 50;
    await h.job(10);
    const verdict = await h.gate.check('fix');
    expect(verdict.go, verdict.text).toBe(true);
    expect(verdict.usage!.five_hour.used).toBe(50);
    expect(h.endpoint.calls).toHaveLength(2);
  });

  test('a failed after read holds the next check until the endpoint may be asked', async () => {
    await h.tick();
    h.clock.tick({ minutes: 1 });
    const verdict = await h.gate.check('fix');
    h.clock.tick({ minutes: 10 });
    h.endpoint.fail = 429;
    const ended = h.clock.t;
    await h.gate.measured('fix', [], verdict.usage!);
    h.clock.tick({ minutes: 1 });
    const held = await h.gate.check('fix');   // the reading is from before the job
    expect([held.go, held.why]).toEqual([false, UNREADABLE]);
    expect(held.text).toContain('before the last Claude job ended');
    expect(held.until).toEqual(new Date(ended.getTime() + 5 * MINUTE));   // gate_until
    h.endpoint.fail = null;
    h.clock.t = held.until!;
    expect((await h.gate.check('fix')).go).toBe(true);
  });

  test('a job under five minutes waits for the budget then reads', async () => {
    await h.tick();   // read at 14:01:49
    await h.job(2);
    expect(h.slept).toEqual([180]);
    expect(h.endpoint.calls).toEqual([[t(14, 1, 49), 200], [t(14, 6, 49), 200]]);
    const recs = readFileSync(h.gate.book.path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toHaveProperty('after');   // Python's rec['after']: the key there, and not None
    expect(recs[0].after).not.toBeNull();
    expect(recs[0]).not.toHaveProperty('error');
  });

  test('a reading another caller took after the job ended serves the after read', async () => {
    await h.tick();
    const verdict = await h.gate.check('fix');
    h.clock.tick({ minutes: 2 });
    h.endpoint.five = 44;

    h.gate.sleep = async (seconds) => {   // the publisher reads while it waits
      h.clock.tick({ seconds });
      await h.tick();
    };
    await h.gate.measured('fix', [], verdict.usage!);
    expect(h.statuses()).toEqual([200, 200]);   // no second call after the wait
    expect((await h.gate.check('fix')).usage!.five_hour.used).toBe(44);
  });
});

/** A Claude thread that ends outside a measured pass (PR 67's review 1, F1): a dead runner's job
 *  settled, a waiting job Stefan answered that has since ended, or a decision thread whose retry
 *  never reached its job. The next check decides only on a reading taken after the runner saw it
 *  end, as after a measured job. */
class EndedElsewhere extends Harness {
  readonly log: JobLog;
  readonly t3 = new FakeT3([[0, 'completed']]);
  readonly gh = new FakeGitHubWithPulls({ issues: [issue(5)] });
  r: Runner;

  constructor() {
    super();
    this.log = new JobLog(join(this.state, 'jobs.jsonl'));
    this.r = new Runner(this.config, {
      github: this.gh, t3: this.t3, git: new FakeGit(), out: () => {}, log_line: () => {}, gate: this.gate, now: this.clock.call,
    });
  }

  /** A build left open by a dead runner, its thread in T3 (if `status`). */
  a_build(status: string | null = null) {
    const job = this.log.started({ kind: 'build', repo: 'queue-runner', issue: 4, branch: 'claude/a-ticket-4',
      title: 'Queue runner build: queue-runner#4' });
    if (status) this.t3.add('mcp:old', job.title, status);
    return job;
  }

  /** The pass after the job ended: held on the reading from before it, until the endpoint may be
   *  asked again; then it decides on the new reading (90% used: a build won't fit). */
  async assert_held_until_the_next_read(): Promise<void> {
    expect(await this.r.run_pass()).toBe(GATED);
    expect(this.t3.starts).toEqual([]);
    expect(this.r.claude_wait!.reason).toContain('before the last Claude job ended');
    expect(this.r.gate_until).toEqual(t(14, 6, 49));
    this.clock.t = this.r.gate_until!;
    expect(await this.r.run_pass()).toBe(GATED);
    expect((await this.gate.check('build')).why).toBe(FIVE_HOUR);
    expect(this.t3.starts).toEqual([]);
  }

  /** A build waiting on Stefan, its end record naming the run that asked (#85). */
  a_waiting_build() {
    const job = this.a_build();
    this.log.ended(job.id, { exit_code: 2, outcome: 'waiting', thread_id: 'mcp:w', run_id: 'run:mcp:w:1' });
    this.t3.add('mcp:w', job.title, 'waiting');
    return job;
  }

  /** Stefan answered the thread in T3: a newer run, now `status`. */
  ran_again(thread_id: string, status: string): void {
    const was = this.t3.threads.get(thread_id)!;
    this.t3.threads.set(thread_id, new Thread({ ...was, status, latest_run_id: `run:${thread_id}:2` }));
  }
}

describe('EndedElsewhereTest', () => {
  let h: EndedElsewhere;
  beforeEach(() => {
    h = new EndedElsewhere();
  });

  test('jobs settled that never reached a thread hold nothing', async () => {
    h.a_build();   // no thread in T3: not-started
    await h.tick();
    h.clock.at(14, 2, 49);
    expect(await h.r.run_pass()).toBe(STARTED);   // a build, on the 14:01:49 reading
    expect(h.t3.starts).toHaveLength(1);
  });

  test('a decision thread whose retry never reached the job holds the next job', async () => {
    // Decider.act: the decision thread ran, then continuing the job failed, so the pass returns
    // idle and isn't measured; the decision's thread still spent usage.
    await h.tick();
    h.endpoint.five = 90;

    const run = async () => {
      const job = h.log.started({ kind: 'decision', repo: 'queue-runner', issue: 4, branch: null,
        title: 'Queue runner decision: queue-runner#4' });
      h.clock.at(14, 2, 49);
      h.log.ended(job.id, { exit_code: 0, outcome: 'retry', thread_id: 'mcp:d' });
      h.log.ended(job.id, { exit_code: 0, outcome: 'not-started', error: 'the earlier job was not continued' });
      return 'idle';
    };
    const r = h.r as Runner & { choose: Runner['choose'] };
    r.choose = async () => [new Start('queue-runner', 'decision', null, run, 'decision queue-runner#4')];   // one repo's job (#50)
    expect(await h.r.run_pass()).toBe('idle');
    delete (r as Partial<Runner>).choose;
    await h.assert_held_until_the_next_read();
  });

  test('a pass whose job reached no thread holds nothing', async () => {
    await h.tick();

    const run = async () => {   // T3 down: the build never started
      const job = h.a_build();
      h.log.ended(job.id, { exit_code: null, outcome: 'not-started', error: 'T3 is down' });
      return 'idle';
    };
    const r = h.r as Runner & { choose: Runner['choose'] };
    r.choose = async () => [new Start('queue-runner', 'build', null, run, 'build queue-runner#5')];
    await h.r.run_pass();
    delete (r as Partial<Runner>).choose;
    h.clock.at(14, 2, 49);
    expect(await h.r.run_pass()).toBe(STARTED);   // the next build goes on the same reading
  });
});

// Python's runner chooses a decision on the waiting build's question here (`decisions.py`), whose
// cost with the build it may continue doesn't fit beside 38%, so nothing starts; without it the
// build of #5 would start and be measured.
describe('EndedElsewhereTest, turned on by decisions (#226)', () => {
  // Python's next job in each is a decision on the build, which the gate holds; until #226 the
  // runner holds that repo instead, so the gate is never asked (review 1 of PR #276).
  it.todo('test_a_dead_runners_job_that_ends_holds_the_next_job_for_a_reading_after_it');
  it.todo('test_a_dead_runners_job_found_ended_on_the_first_pass_counts_too');
  it.todo('test_a_waiting_job_answered_and_ended_since_holds_the_next_job_too');
  it.todo('test_a_waiting_job_that_ran_on_stefans_answer_and_asks_again_holds_the_next_job');
  it.todo('test_a_waiting_job_still_on_the_run_that_asked_holds_nothing');
  it.todo('test_a_run_on_stefans_answer_is_told_to_the_gate_once');
  it.todo('test_a_run_on_stefans_answer_no_pass_saw_running_holds_the_next_job');
});

// A dead runner's Opus fallback review (PR 67's review 2, F2): its own cases, and
// EndedElsewhereTest's run again with a reviewer (all but the two dead-build cases it sets aside).
describe('DeadFallbackReviewTest, turned on by reviews (#222)', () => {
  it.todo('test_the_sol_lane_keeps_it_open_while_its_thread_runs_then_counts_it_failed');
  it.todo('test_a_dead_runners_review_thread_whose_settle_fails_is_said_and_counted');
  it.todo('test_the_claude_lane_seeing_it_end_first_tells_the_gate_once');
  it.todo('test_the_sol_lanes_own_review_now_runs_beside_the_claude_lane');
  it.todo('test_a_review_that_never_started_a_thread_is_counted_failed_and_holds_nothing');
  it.todo('test_t3_unreadable_keeps_both_lanes_off_it');
  it.todo('test_a_waiting_job_answered_and_ended_since_holds_the_next_job_too');
  it.todo('test_a_waiting_job_that_ran_on_stefans_answer_and_asks_again_holds_the_next_job');
  it.todo('test_a_waiting_job_still_on_the_run_that_asked_holds_nothing');
  it.todo('test_a_run_on_stefans_answer_is_told_to_the_gate_once');
  it.todo('test_a_run_on_stefans_answer_no_pass_saw_running_holds_the_next_job');
  it.todo('test_jobs_settled_that_never_reached_a_thread_hold_nothing');
  it.todo('test_a_decision_thread_whose_retry_never_reached_the_job_holds_the_next_job');
  it.todo('test_a_pass_whose_job_reached_no_thread_holds_nothing');
});

/** PR 67's review 2, a nit: the other lane telling the gate a job ended while this job's after-read
 *  is under way doesn't cost this job its sample. */
describe('MeasuredRaceTest', () => {
  test("a job ended in the other lane mid read keeps this job's reading", async () => {
    const h = new Harness();
    await h.tick();   // 14:01:49
    const verdict = await h.gate.check('fix');
    h.clock.tick({ minutes: 10 });   // a 10-minute job: no budget wait
    const read = h.gate.reader.read.bind(h.gate.reader);

    h.gate.reader.read = async () => {
      const got = await read();
      h.clock.tick({ seconds: 1 });
      h.gate.job_ended('the-sol-lanes-fallback-review');
      return got;
    };
    await h.gate.measured('fix', ['j1'], verdict.usage!);
    const lines = readFileSync(join(h.state, 'usage.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    const last = JSON.parse(lines.at(-1)!);
    expect(last, JSON.stringify(last)).toHaveProperty('after');   // Python's last['after']
    expect(last.after, JSON.stringify(last)).not.toBeNull();
  });
});

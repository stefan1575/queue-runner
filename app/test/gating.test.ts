// The usage gate in the run loop and Stefan's knob, through the command line, with a fixed clock and
// fake usage. Ported from `tests/test_gating.py` case for case (#219); the cases waiting on a later
// port are `it.todo`, named as in Python, under the ticket that turns them on. The config file is
// `settings.toml` (docs/app.md, Test it).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { main } from '../src/app.ts';
import { type Endpoint, local_minutes, Usage, UsageError, Window } from '../src/claude-usage.ts';
import { NoToaster, NoWaker } from '../src/later-parts.ts';
import { JobLog } from '../src/state.ts';
import { FakeGit, FakeGitHubWithPulls, FakeUsage, issue, StubEndpoint } from './fakes.ts';
import { FakeT3 } from './fakes-t3.ts';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const NOW = new Date('2026-11-10T12:00:00Z');
const FIVE_RESET = new Date(NOW.getTime() + 2 * HOUR);
const WEEK_RESET = new Date(NOW.getTime() + 3 * DAY);
const PR = { number: 12, url: 'https://github.com/owner/first/pull/12', state: 'open' };

function usage(five: number, week: number): Usage {
  return new Usage(new Window(five, FIVE_RESET), new Window(week, WEEK_RESET));
}

class Done extends Error {}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

const temps: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

class Harness {
  readonly dir: string;
  readonly config: string;
  readonly log: JobLog;
  now = NOW;
  t3!: FakeT3;

  constructor() {
    const tmp = mkdtempSync(join(tmpdir(), 'qr-gating-'));
    temps.push(tmp);
    this.dir = tmp.replaceAll('\\', '/');
    this.config = join(this.dir, 'settings.toml');
    writeFileSync(this.config, `
state_dir = "${this.dir}/state"
log_dir = "${this.dir}/logs"
poll_seconds = 300

[[repos]]
name = "first"
github = "owner/first"
path = "${this.dir}"
`, 'utf8');
    this.log = new JobLog(join(this.dir, 'state', 'jobs.jsonl'));
  }

  async run_main(args: string[], usage_reader: Endpoint<Usage>, t3: FakeT3 | null = null,
    sleep: ((s: number) => Promise<void>) | null = null): Promise<[number, string]> {
    let out = '';
    const gh = new FakeGitHubWithPulls({ issues: [issue(4, 'Red widget', 'Make it red.')], pulls_by_branch: { 'claude/red-widget-4': PR } });
    this.t3 = t3 ?? new FakeT3([[0, 'completed']]);
    const code = await main([...args, '--config', this.config], {
      github: gh, t3: this.t3, git: new FakeGit(), sleep: sleep ?? (async () => {}), toaster: new NoToaster(),
      usage: usage_reader, clock: () => this.now, waker: new NoWaker(),
    }, (s) => (out += s));
    return [code, out];
  }

  runner_log(): string {
    return readFileSync(join(this.dir, 'logs', 'runner.log'), 'utf8');
  }

  usage_records(): Record<string, any>[] {
    return readFileSync(join(this.dir, 'state', 'usage.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
}

describe('GatingTest', () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  test("a build that won't fit the five hour window waits and says until when", async () => {
    await h.run_main(['--once'], new FakeUsage(usage(80, 20)));
    expect(h.t3.starts).toEqual([]);
    expect(h.log.jobs()).toEqual([]);
    const log = h.runner_log();
    expect(log).toContain('Claude lane waits');
    expect(log).toContain('80%');
    expect(log).toContain(local_minutes(FIVE_RESET));
  });

  test('a build that fits starts and records usage before and after', async () => {
    await h.run_main(['--once'], new FakeUsage(usage(10, 20), usage(35, 24)));
    expect(h.t3.starts).toHaveLength(1);
    const jobs = h.log.jobs();
    expect(jobs).toHaveLength(1);
    const recs = h.usage_records();
    expect(recs).toHaveLength(1);
    expect([recs[0]!.kind, recs[0]!.jobs]).toEqual(['build', [jobs[0]!.id]]);
    expect(recs[0]!.before.five_hour.used).toBe(10);
    expect(recs[0]!.spent).toEqual({ five_hour: 25, seven_day: 4 });
  });

  test('a short job still teaches its cost the after read waits for the budget', async () => {
    // Issue 66: the endpoint is asked once every 5 minutes, so a job under that waits for the
    // budget on the wall clock before its after-read.
    const endpoint = new StubEndpoint(() => h.now, 10, 20, 60, [FIVE_RESET, WEEK_RESET]);
    const slept: number[] = [];

    const sleep = async (seconds: number) => {
      slept.push(seconds);
      [endpoint.five, endpoint.week] = [35, 24];
      h.now = new Date(h.now.getTime() + seconds * 1000);
    };
    await h.run_main(['--once'], endpoint.oauth(h.dir), null, sleep);
    expect(h.t3.starts).toHaveLength(1);
    expect(slept).toEqual([300]);
    expect(endpoint.calls).toEqual([[NOW, 200], [new Date(NOW.getTime() + 5 * MINUTE), 200]]);
    const recs = h.usage_records();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.spent).toEqual({ five_hour: 25, seven_day: 4 });
    expect(h.runner_log()).toContain("Reading Claude's usage after the job at");
  });

  test('unreadable usage starts nothing and says why', async () => {
    await h.run_main(['--once'], new FakeUsage(new UsageError('the usage endpoint answered HTTP 401')));
    expect(h.t3.starts).toEqual([]);
    expect(h.runner_log()).toContain('HTTP 401');
  });

  test('a changed reserve holds the week back', async () => {
    const [code, out] = await h.run_main(['--reserve', '30'], new FakeUsage());
    expect(code).toBe(0);
    expect(out).toContain('30%');
    await h.run_main(['--once'], new FakeUsage(usage(0, 60)));
    expect(h.t3.starts).toEqual([]);
    expect(h.runner_log()).toContain('weekly reserve holds');
    expect((await h.run_main(['--reserve', '150'], new FakeUsage()))[0]).toBe(2);
  });

  test('the continuous mode sleeps no longer than until the reset', async () => {
    const soon = new Usage(new Window(80, new Date(NOW.getTime() + 30_000)), new Window(20, WEEK_RESET));
    const slept: number[] = [];

    const sleep = async (s: number) => {
      slept.push(s);
      throw new Done();
    };
    await expect(h.run_main([], new FakeUsage(soon), null, sleep)).rejects.toThrow(Done);
    expect(slept[0]).toBeLessThan(300);
  });

  test("a wait that has passed doesn't shorten a later idle pause", async () => {
    const slept: number[] = [];

    const sleep = async (s: number) => {
      slept.push(s);
      h.now = new Date(FIVE_RESET.getTime() + HOUR);   // the reset came and went
      if (slept.length === 2) throw new Done();
    };
    // gated, then the build starts, then nothing to start
    await expect(h.run_main([], new FakeUsage(usage(80, 20), usage(0, 20)), null, sleep)).rejects.toThrow(Done);
    expect(h.t3.starts).toHaveLength(1);
    expect(slept[1]).toBe(300);
  });
});

describe('GatingTest, turned on by the switches (#229)', () => {
  it.todo('test_pause_and_resume_work_between_passes');
});

describe('GatingTest, turned on by --gate (#229)', () => {
  it.todo('test_gate_prints_the_windows_and_each_kind');
});

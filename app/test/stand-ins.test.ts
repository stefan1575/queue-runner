// The stand-ins for parts later tickets port (`src/later-parts.ts`), each against a job log or
// control.json as Python writes it: a stand-in may do less than Python, never something Python
// wouldn't (review 1 of PR #276). Where Python would start a part not ported yet, the runner holds
// that repo for the pass: it starts nothing there, records nothing, and says why once.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { main } from '../src/app.ts';
import { NoToaster, NoWaker } from '../src/later-parts.ts';
import { JobLog } from '../src/state.ts';
import { Message } from '../src/t3-seam.ts';
import { FakeGit, FakeGitHubWithPulls, FakeUsage, issue } from './fakes.ts';
import { FakeT3 } from './fakes-t3.ts';

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-23T04:00:00Z') });
});

const tmps: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** A config with one repo and its job log, and `--once` through `main` with the rest faked. */
class Harness {
  readonly dir: string;
  readonly config: string;
  readonly state: string;
  readonly log: JobLog;

  constructor() {
    const tmp = mkdtempSync(join(tmpdir(), 'qr-stand-ins-'));
    tmps.push(tmp);
    this.dir = tmp.replaceAll('\\', '/');
    this.config = join(this.dir, 'settings.toml');
    this.state = join(this.dir, 'state');
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
    mkdirSync(this.state, { recursive: true });
    this.log = new JobLog(join(this.state, 'jobs.jsonl'));
  }

  async once(github: FakeGitHubWithPulls, t3: FakeT3): Promise<[number, string]> {
    let out = '';
    const code = await main(['--once', '--config', this.config], {
      github, t3, git: new FakeGit(), sleep: async () => {}, toaster: new NoToaster(),
      usage: new FakeUsage(), waker: new NoWaker(),
    }, (s) => (out += s));
    return [code, out];
  }

  /** A build Python's runner recorded, ended as `outcome` on thread `thread_id`. */
  a_build(n: number, outcome: string, thread_id: string, fields: Record<string, unknown> = {}) {
    const job = this.log.started({ kind: 'build', repo: 'first', issue: n, branch: `claude/a-ticket-${n}`,
      title: `Queue runner build: first#${n}` });
    this.log.ended(job.id, { exit_code: outcome === 'waiting' ? 2 : 1, outcome, thread_id, run_id: `run:${thread_id}:1`, ...fields });
    return job;
  }

  runner_log(): string {
    return readFileSync(join(this.dir, 'logs', 'runner.log'), 'utf8');
  }
}

describe('decisions (#226)', () => {
  test('a waiting build holds its repo where Python starts a decision, and no other build starts', async () => {
    const h = new Harness();
    const job = h.a_build(4, 'waiting', 'mcp:w');
    const t3 = new FakeT3();
    t3.add('mcp:w', job.title, 'waiting');
    const [code, out] = await h.once(new FakeGitHubWithPulls({ issues: [issue(4), issue(5)] }), t3);
    expect(code).toBe(0);
    expect(t3.starts).toEqual([]);
    expect(h.log.jobs()).toHaveLength(1);
    expect(out).toContain('decision first#4 (waiting): decisions are ported in #226, so nothing else starts in first meanwhile');
  });

  test('a failed build holds its repo the same way', async () => {
    const h = new Harness();
    h.a_build(4, 'failed', 'mcp:f');
    const t3 = new FakeT3();
    const [, out] = await h.once(new FakeGitHubWithPulls({ issues: [issue(5)] }), t3);
    expect(t3.starts).toEqual([]);
    expect(out).toContain('decision first#4 (failed)');
  });

  test('a case is said once while it holds', async () => {
    const h = new Harness();
    h.a_build(4, 'done-no-pr', 'mcp:d');
    const gh = new FakeGitHubWithPulls({ issues: [issue(5)] });
    await h.once(gh, new FakeT3());
    await h.once(gh, new FakeT3());
    expect(h.runner_log().match(/decision first#4 \(no-pr\)/g)).toHaveLength(2);   // once per runner
  });

  test('a decided case holds nothing: the next build starts', async () => {
    const h = new Harness();
    const old = h.a_build(4, 'failed', 'mcp:f');
    const d = h.log.started({ kind: 'decision', repo: 'first', issue: 4, branch: null, title: 'Queue runner decision: first#4', about: old.id });
    h.log.ended(d.id, { exit_code: 0, outcome: 'close', thread_id: 'mcp:d' });
    const t3 = new FakeT3([[0, 'completed']]);
    await h.once(new FakeGitHubWithPulls({ issues: [issue(5)] }), t3);
    expect(t3.starts).toHaveLength(1);
  });
});

describe('limit recovery (#227)', () => {
  test("a run stopped on Claude's rate limit is recorded usage-limit, and holds every repo until it may resume", async () => {
    const h = new Harness();
    const t3 = new FakeT3([[1, 'failed']]);
    t3.messages.set('mcp:t1', [new Message('assistant', 'Claude API rate limit reached')]);
    const gh = new FakeGitHubWithPulls({ issues: [issue(4), issue(5)] });
    await h.once(gh, t3);
    const job = h.log.jobs()[0]!;
    expect([job.outcome, job.context]).toEqual(['usage-limit', null]);
    expect(job.resume_at).toBe('2026-11-23T09:15:00+00:00');   // 5h05m from the stop, then 10 minutes
    const [, out] = await h.once(gh, t3);
    expect(t3.starts).toHaveLength(1);   // issue 5 waits too: the limit is the account's
    expect(out).toContain('Claude lane waits: build first#4 was cut off by a usage limit');
  });

  test('a usage-limit job due to resume holds its repo: nothing starts, nothing is recorded, nothing throws', async () => {
    const h = new Harness();
    h.a_build(4, 'usage-limit', 'mcp:l', { resume_at: '2026-11-23T03:00:00+00:00' });   // as Python wrote it
    const t3 = new FakeT3([[0, 'completed']]);
    const [code, out] = await h.once(new FakeGitHubWithPulls({ issues: [issue(5)] }), t3);
    expect(code).toBe(0);
    expect(t3.starts).toEqual([]);
    expect(h.log.jobs()).toHaveLength(1);
    expect(out).toContain('build first#4 was cut off by a usage limit and may resume: limit recovery is ported in #227');
    expect(h.runner_log()).not.toContain('failed');
  });
});

// The job log, ported from `tests/test_state.py` case for case (#214): what ran and what's open,
// read back the way a restarted runner reads it.
import { appendFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type EndFields, type Job, JobLog, when } from '../src/state.ts';

let dir: string;
let path: string;
let clock: Date;
// The log's clock: each read a second on, so a later record has a later stamp.
const now = () => (clock = new Date(clock.getTime() + 1000));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-state-'));
  path = join(dir, 'state', 'jobs.jsonl');
  clock = new Date('2026-11-21T02:00:00Z');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const open = () => new JobLog(path, now);

function start(log: JobLog, issue = 4, repo = 'first'): Job {
  return log.started({ kind: 'build', repo, issue, branch: `claude/x-${issue}`, title: `Queue runner build: ${repo}#${issue}` });
}

function end(log: JobLog, job: Job, exit_code: number | null = 0, outcome = 'done', extra: EndFields = {}): void {
  const fields = {
    thread_id: 'mcp:t1', link: 'https://app.t3.codes/threads/x/mcp%3At1',
    run_id: 'run:1', status: 'completed', commits: [], pr: null, worktree: null, error: null, ...extra,
  };
  log.ended(job.id, { exit_code, outcome, ...fields });
}

describe('JobLogTest', () => {
  test('a started job is open after a restart', () => {
    const job = start(open());
    const reopened = open();
    expect(reopened.open_jobs().map((j) => j.id)).toEqual([job.id]);
    expect(reopened.held_issues('first')).toEqual(new Set([4]));
  });

  test('an ended job keeps its record', () => {
    const log = open();
    const job = start(log);
    end(log, job, 0, 'done', {
      commits: [{ sha: 'abc', subject: 'Add a line' }],
      pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'open' },
    });
    const [done, ...rest] = open().jobs();
    expect(rest).toEqual([]);
    expect(open().open_jobs()).toEqual([]);
    expect([done!.kind, done!.repo, done!.issue, done!.thread_id, done!.exit_code, done!.outcome])
      .toEqual(['build', 'first', 4, 'mcp:t1', 0, 'done']);
    expect(done!.pr!.number).toBe(7);
    expect((done!.commits[0] as { subject: string }).subject).toBe('Add a line');
    expect(done!.started_at <= done!.ended_at!).toBe(true);
  });

  test('a failed or waiting job holds its issue until released', () => {
    const log = open();
    end(log, start(log, 4), 1, 'failed', { status: 'interrupted' });
    end(log, start(log, 5), 2, 'waiting', { status: 'waiting' });
    expect(open().held_issues('first')).toEqual(new Set([4, 5]));
    expect(open().waiting_jobs().map((j) => j.issue)).toEqual([5]);
    log.released('first', 4);
    expect(open().held_issues('first')).toEqual(new Set([5]));
  });

  test('a job that never started a thread holds nothing', () => {
    const log = open();
    end(log, start(log), 1, 'not-started', { thread_id: null, status: null, error: 'T3 server not running' });
    expect(open().held_issues('first')).toEqual(new Set());
  });

  test('holds are per repo', () => {
    const log = open();
    start(log, 4, 'first');
    expect(open().held_issues('second')).toEqual(new Set());
  });

  test('a later end record updates the job', () => {
    const log = open();
    const job = start(log, 5);
    end(log, job, 2, 'waiting', { status: 'waiting' });
    end(log, job, 0, 'done');
    const [j, ...rest] = open().jobs();
    expect(rest).toEqual([]);
    expect(j!.outcome).toBe('done');
    expect(open().waiting_jobs()).toEqual([]);
  });

  test('an issue started again after release is held again', () => {
    const log = open();
    end(log, start(log, 4), 1, 'failed');
    log.released('first', 4);
    start(log, 4);
    expect(open().held_issues('first')).toEqual(new Set([4]));
  });

  test('a record torn by a crash is dropped and later records still read', () => {
    const log = open();
    const job = start(log, 4);
    appendFileSync(path, `{"event": "end", "job": "${job.id}", "exit`, 'utf8');   // the crash
    expect(open().open_jobs().map((j) => j.id)).toEqual([job.id]);
    start(open(), 5);
    expect(open().open_jobs().map((j) => j.issue)).toEqual([4, 5]);
  });

  test('a broken record mid log is an error', () => {
    const log = open();
    start(log, 4);
    appendFileSync(path, 'not json\n', 'utf8');
    start(log, 5);
    expect(() => open().jobs()).toThrow(SyntaxError);
  });

  test('a record torn inside a multibyte character is dropped', () => {
    const log = open();
    const job = start(log, 4);
    appendFileSync(path, Buffer.from([...Buffer.from('{"event": "end", "error": "caf'), 0xc3]));   // the crash, mid-character
    expect(open().open_jobs().map((j) => j.id)).toEqual([job.id]);
  });

  test('a released waiting job stays released when its issue is built again', () => {
    const log = open();
    end(log, start(log, 4), 2, 'waiting', { status: 'waiting' });
    log.released('first', 4);
    end(log, start(log, 4), 0, 'done');
    expect(open().waiting_jobs()).toEqual([]);
  });
});

describe('WhenTest', () => {
  test('a stamp keeps its offset', () => {
    expect(when('2026-11-16T05:40:00Z')).toEqual(new Date(Date.UTC(2026, 10, 16, 5, 40)));
  });

  test('a stamp with no offset is local time and compares with any aware time', () => {
    // The wake sync raised on one (TypeError: offset-naive and offset-aware) on 2026-11-16.
    const t = when('2026-11-16T13:40:00');
    expect(t).toEqual(new Date(2026, 10, 16, 13, 40));
    expect(typeof (t > new Date('2026-11-21T02:00:00Z'))).toBe('boolean');
  });
});

// The job log (#154): `jobs.jsonl`, read back on the next start; which issues it holds and when
// each repo's last job ended.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { JobLog, JobLogError, type JobStart } from '../src/job-log.ts';

let dir: string;
let file: string;
let now = new Date('2026-11-19T10:00:00Z');
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-jobs-'));
  file = join(dir, 'state', 'jobs.jsonl');
  now = new Date('2026-11-19T10:00:00Z');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const start = (issue: number, repo = 'p1'): JobStart => ({
  kind: 'build', repo, github: 'o/r', issue, branch: `claude/x-${issue}`, base: 'origin/main', title: `Queue runner build: r#${issue}`,
  choice: { provider: 'a', model: 'm', effort: null }, onFallback: false,
});

describe('JobLog', () => {
  test('a stop is written once per PR, head and cause, and read back on the next open (#157)', async () => {
    const log = await JobLog.open(file, () => now);
    const stop = { cause: 'conflict' as const, repo: 'p1', github: 'o/r', pr: 4, sha: 'a'.repeat(40), why: 'no push', link: null };
    const first = await log.stopped(stop);
    expect(await log.stopped({ ...stop, why: 'said again' })).toEqual(first);
    await log.stopped({ ...stop, sha: 'b'.repeat(40) });
    const again = await JobLog.open(file);
    expect(again.stops().map((s) => [s.sha[0], s.why])).toEqual([['a', 'no push'], ['b', 'no push']]);
    expect(again.stopOn('p1', 4, 'a'.repeat(40), 'conflict')).toMatchObject({ why: 'no push', at: '2026-11-19T10:00:00.000Z' });
  });

  test('a start, its thread and its end are read back on the next open', async () => {
    const log = await JobLog.open(file, () => now);
    const job = await log.started(start(1));
    await log.thread(job.id, { threadId: 't1', runId: 'r1', link: 'l1' });
    expect(log.open().map((j) => j.id)).toEqual([job.id]);
    now = new Date('2026-11-19T11:00:00Z');
    await log.ended(job.id, { outcome: 'done', status: 'completed', pr: { number: 5, url: 'u', state: 'open' } });
    const again = await JobLog.open(file);
    expect(again.get(job.id)).toMatchObject({ issue: 1, threadId: 't1', runId: 'r1', end: { outcome: 'done', at: '2026-11-19T11:00:00.000Z', pr: { number: 5 } } });
    expect(again.open()).toEqual([]);
  });

  test('every build that started holds its issue, but not-started; only in its own repo', async () => {
    const log = await JobLog.open(file);
    await log.started(start(1));
    await log.ended((await log.started(start(2))).id, { outcome: 'failed' });
    await log.ended((await log.started(start(3))).id, { outcome: 'not-started', error: 'T3 down' });
    await log.ended((await log.started(start(4))).id, { outcome: 'branch-exists' });
    await log.started(start(9, 'p2'));
    expect([...log.heldIssues('p1')].sort()).toEqual([1, 2, 4]);
  });

  test('a job that needs the user holds its repo and its issue until the answer, read back on the next open', async () => {
    const log = await JobLog.open(file, () => now);
    const job = await log.started(start(1));
    await log.ended(job.id, { outcome: 'needs-user', error: 'its launch was sent and its answer lost' });
    await log.started(start(2, 'p2'));
    expect(log.needingUser('p1').map((j) => j.id)).toEqual([job.id]);
    expect(log.needingUser('p2')).toEqual([]);
    expect((await JobLog.open(file)).needingUser('p1').map((j) => j.id)).toEqual([job.id]);
    now = new Date('2026-11-19T11:00:00Z');
    await log.answered(job.id);
    const again = await JobLog.open(file);
    expect(again.needingUser('p1')).toEqual([]);
    expect(again.get(job.id)).toMatchObject({ answeredAt: '2026-11-19T11:00:00.000Z', end: { outcome: 'needs-user' } });
    expect(again.heldIssues('p1')).toEqual(new Set([1]));
  });

  test("a repo's last end, a not-started aside", async () => {
    const log = await JobLog.open(file, () => now);
    expect(log.lastEnded('p1')).toBeNull();
    const a = await log.started(start(1));
    now = new Date('2026-11-19T12:00:00Z');
    await log.ended(a.id, { outcome: 'done' });
    now = new Date('2026-11-19T13:00:00Z');
    await log.ended((await log.started(start(2))).id, { outcome: 'not-started' });
    expect(log.lastEnded('p1')).toBe('2026-11-19T12:00:00.000Z');
  });

  test('a torn last line is cut off; a bad line before others is an error', async () => {
    const log = await JobLog.open(file);
    await log.started(start(1));
    await writeFile(file, `${await readFile(file, 'utf8')}{"event":"st`);
    expect((await JobLog.open(file)).jobs()).toHaveLength(1);
    expect((await readFile(file, 'utf8')).endsWith('\n')).toBe(true);
    await writeFile(file, `nonsense\n${await readFile(file, 'utf8')}`);
    await expect(JobLog.open(file)).rejects.toThrow(JobLogError);
  });
});

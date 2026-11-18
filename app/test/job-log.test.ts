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

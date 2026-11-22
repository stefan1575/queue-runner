// Expected costs, learned per provider, model, effort and kind from the app's own records (#153).
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CostLog, CostLogError } from '../src/cost-log.ts';
import { DEFAULT_COSTS, expectedCost, spentOf, type CostKey, type UsageRecord } from '../src/costs.ts';

const WINDOWS = [{ id: 'five_hour', kind: 'session' as const }, { id: 'seven_day', kind: 'weekly' as const }];
const opusMedium: CostKey = { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'medium', kind: 'build' };

let n = 0;
const rec = (key: CostKey, five: number | null, week: number | null, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  ...key, at: `2026-11-19T0${n}:00:00Z`, job: `job-${++n}`,
  before: { checkedAt: null, windows: {} }, after: { checkedAt: null, windows: {} },
  spent: { five_hour: five, seven_day: week }, ...extra,
});

let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

describe('learned costs', () => {
  test('the cautious default until three records measured a window, then the largest of the last five', () => {
    expect(expectedCost([], opusMedium, WINDOWS).cost).toEqual({ five_hour: 60, seven_day: 15 });
    const two = [rec(opusMedium, 4, 1), rec(opusMedium, 6, 2)];
    expect(expectedCost(two, opusMedium, WINDOWS).cost).toEqual({ five_hour: 60, seven_day: 15 });
    // a window that reset mid-job measured nothing for it
    const records = [rec(opusMedium, 9, 1), ...two, rec(opusMedium, 3, null), rec(opusMedium, 5, 1), rec(opusMedium, 2, 1)];
    expect(expectedCost(records, opusMedium, WINDOWS)).toEqual({ cost: { five_hour: 6, seven_day: 2 }, learned: { five_hour: true, seven_day: true } });
  });

  test("learned costs for one model and effort don't set another's", () => {
    const records = [1, 2, 3].map(() => rec(opusMedium, 4, 1));
    expect(expectedCost(records, opusMedium, WINDOWS).cost).toEqual({ five_hour: 4, seven_day: 1 });
    expect(expectedCost(records, { ...opusMedium, effort: 'high' }, WINDOWS).cost).toEqual({ five_hour: 60, seven_day: 15 });
    expect(expectedCost(records, { ...opusMedium, model: 'claude-sonnet-5-5' }, WINDOWS).cost).toEqual({ five_hour: 60, seven_day: 15 });
    expect(expectedCost(records, { ...opusMedium, provider: 'claudeReviewer' }, WINDOWS).cost).toEqual({ five_hour: 60, seven_day: 15 });
    expect(expectedCost(records, { ...opusMedium, kind: 'review' }, WINDOWS).cost).toEqual({ five_hour: DEFAULT_COSTS.review.session, seven_day: DEFAULT_COSTS.review.long });
  });

  test('a job that ran beside another on the same login teaches nothing', () => {
    const records = [1, 2, 3].map(() => rec(opusMedium, 4, 1, { sharedWith: ['review other#2'] }));
    expect(expectedCost(records, opusMedium, WINDOWS).learned).toEqual({ five_hour: false, seven_day: false });
  });

  test("what a job spent: the difference, the whole reading for a window it started, nothing for one that reset", () => {
    const at = '2026-11-19T14:00:00Z', later = '2026-11-19T19:00:00Z';
    const before = { checkedAt: null, windows: { a: { used: 40, resetsAt: at }, b: { used: 0, resetsAt: null }, c: { used: 90, resetsAt: at } } };
    const after = { checkedAt: null, windows: { a: { used: 44, resetsAt: '2026-11-19T14:05:00Z' }, b: { used: 3, resetsAt: later }, c: { used: 2, resetsAt: later } } };
    expect(spentOf(before, after)).toEqual({ a: 4, b: 3, c: null });
  });

  test('records are appended to usage.jsonl and read back; a torn last line is cut off', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qr-costs-'));
    const file = join(dir, 'usage.jsonl');
    const r = rec(opusMedium, 4, 1);
    await writeFile(file, `${JSON.stringify(r)}\n{"kind":"bu`);
    const log = await CostLog.open(file);
    expect(log.records()).toEqual([r]);
    const r2 = rec(opusMedium, 5, 1);
    await log.append(r2);
    expect((await CostLog.open(file)).records()).toEqual([r, r2]);
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(r)}\n${JSON.stringify(r2)}\n`);
  });

  test('a record whose write fails is kept nowhere, and a torn tail left since the log was opened is cut before the next append (review 2 of #261, F12)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qr-costs-'));
    const file = join(dir, 'usage.jsonl');
    const log = await CostLog.open(file);
    // the write fails on the file itself: it's a folder now
    await mkdir(file);
    await expect(log.append(rec(opusMedium, 4, 1))).rejects.toThrow();
    expect(log.records()).toEqual([]);   // the gate learns nothing from it
    await rm(file, { recursive: true });
    // a write cut off partway (as the failed one might have been), then a sound one
    const r = rec(opusMedium, 5, 1);
    await writeFile(file, '{"kind":"bu');
    await log.append(r);
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(r)}\n`);
    expect(log.records()).toEqual([r]);
  });

  test('a last record whose newline was lost is cut off before it is parsed, never learned from (review 3 of #261, F19)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qr-costs-'));
    const file = join(dir, 'usage.jsonl');
    const r = rec(opusMedium, 4, 1);
    // the torn record parses whole: only its newline was lost
    await writeFile(file, `${JSON.stringify(r)}\n${JSON.stringify(rec(opusMedium, 50, 1))}`);
    expect((await CostLog.open(file)).records()).toEqual([r]);
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(r)}\n`);
    expect((await CostLog.open(file)).records()).toEqual([r]);   // the same before a reopen and after
  });

  test('a bad line before the last is an error', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qr-costs-'));
    const file = join(dir, 'usage.jsonl');
    await writeFile(file, `nope\n${JSON.stringify(rec(opusMedium, 4, 1))}\n`);
    await expect(CostLog.open(file)).rejects.toThrow(CostLogError);
  });
});

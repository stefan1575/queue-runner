// The usage gate, ported from `tests/test_gate.py` case for case (#263): whether a Claude job
// starts now, with fixed clocks and fake usage.
import { appendFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Usage, Window } from '../src/claude-usage.ts';
import { Cost, CostBook, decide, FITS, FIVE_HOUR, Gate, Knob, read_knob, RELEASED, RESERVE, RUNNING, Running, WEEKLY, write_knob } from '../src/job-gate.ts';
import { FakeUsage } from './fakes.ts';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const NOW = new Date('2026-11-10T12:00:00Z');
const at = (t: Date, ms: number) => new Date(t.getTime() + ms);
const FIVE_RESET = at(NOW, 2 * HOUR);
const WEEK_RESET = at(NOW, 3 * DAY);

function usage(five: number, week: number, five_reset: Date | null = FIVE_RESET, week_reset: Date | null = WEEK_RESET): Usage {
  return new Usage(new Window(five, five_reset), new Window(week, week_reset));
}

const BUILD = new Cost(40, 10);

const dirs: string[] = [];
async function tempdir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'qr-gate-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('DecideTest', () => {
  test('a job that fits both windows starts', () => {
    const v = decide(usage(50, 70), 'build', BUILD, new Knob(), NOW);
    expect([v.go, v.why]).toEqual([true, FITS]);
  });

  test("a job that won't fit the five hour window waits for its reset", () => {
    const v = decide(usage(61, 20), 'build', BUILD, new Knob(), NOW);
    expect([v.go, v.why]).toEqual([false, FIVE_HOUR]);
    expect(v.until!.getTime()).toBeGreaterThanOrEqual(FIVE_RESET.getTime());
    expect(v.until!.getTime()).toBeLessThan(at(FIVE_RESET, 10 * MINUTE).getTime());
    expect(v.text).toContain('61%');
  });

  test('a fresh five hour window takes any job', () => {
    const v = decide(usage(0, 20, null), 'build', new Cost(120, 10), new Knob(), NOW);
    expect(v.go).toBe(true);
  });

  test('the weekly reserve holds until a day before the weekly reset', () => {
    const v = decide(usage(10, 86), 'build', BUILD, new Knob(5), NOW);
    expect([v.go, v.why]).toEqual([false, RESERVE]);
    expect(v.until).toEqual(at(WEEK_RESET, -DAY));
    expect(v.text).toContain('5%');
  });

  test('a changed reserve moves the line', () => {
    expect(decide(usage(10, 86), 'build', BUILD, new Knob(2), NOW).go).toBe(true);
    expect(decide(usage(10, 70), 'build', BUILD, new Knob(25), NOW).go).toBe(false);
  });

  test('inside the last 24 hours the reserve is released', () => {
    const late = at(WEEK_RESET, -23 * HOUR);
    const v = decide(usage(10, 86, at(late, HOUR)), 'build', BUILD, new Knob(5), late);
    expect([v.go, v.why]).toEqual([true, RELEASED]);
  });

  test('a week with no room even without the reserve waits for the weekly reset', () => {
    const v = decide(usage(10, 95), 'build', BUILD, new Knob(5), NOW);
    expect([v.go, v.why]).toEqual([false, WEEKLY]);
    expect(v.until!.getTime()).toBeGreaterThanOrEqual(WEEK_RESET.getTime());
  });

  // Stopping the Claude lane is control.json's, read before the gate (tests/test_switch.py).
});

describe('KnobTest', () => {
  test('the knob defaults to a 5 percent reserve and keeps what is set', async () => {
    const d = await tempdir();
    expect(read_knob(d)).toEqual(new Knob(5.0));
    write_knob(d, new Knob(12.5));
    expect(read_knob(d)).toEqual(new Knob(12.5));
  });
});

const snap = usage;

describe('CostBookTest', () => {
  let book: CostBook;
  const setUp = async () => {
    book = new CostBook(join(await tempdir(), 'usage.jsonl'));
  };

  test('a kind with few records gets the cautious default', async () => {
    await setUp();
    const def = book.expected('build');
    book.record('build', ['j1'], snap(10, 10), snap(15, 11));
    book.record('build', ['j2'], snap(15, 11), snap(20, 12));
    expect(book.expected('build')).toEqual(def);
    expect(def.five_hour).toBeGreaterThanOrEqual(40);
  });

  test('with a few records the cost is the largest recent one', async () => {
    await setUp();
    for (const [before, after] of [[10, 15], [15, 27], [27, 34]] as const) book.record('fix', [], snap(before, 10), snap(after, 12));
    expect(book.expected('fix')).toEqual(new Cost(12, 2));
    expect(book.expected('build')).toEqual(new CostBook(book.path).expected('build'));
  });

  test('a window that reset mid job gives no sample for it', async () => {
    await setUp();
    const later = at(FIVE_RESET, 5 * HOUR);
    for (let i = 0; i < 3; i++) book.record('decision', [], snap(90, 10), snap(3, 11, later));
    const cost = book.expected('decision');
    expect(cost.seven_day).toBe(1);
    expect(cost.five_hour).toBe(CostBook.default('decision').five_hour);
  });

  test('a window that started mid job counts from zero', async () => {
    await setUp();
    for (let i = 0; i < 3; i++) book.record('decision', [], snap(0, 10, null), snap(4, 10));
    expect(book.expected('decision').five_hour).toBe(4);
  });
});

describe('GateCheckTest', () => {
  const gate = async (...reads: Usage[]) => new Gate(await tempdir(), new FakeUsage(...reads), () => NOW);

  test('a decision that may continue a build must fit both', async () => {
    const g = await gate(usage(30, 10));
    expect((await g.check('decision')).go).toBe(true);
    const v = await g.check('decision', 'build');
    expect([v.go, v.why]).toEqual([false, FIVE_HOUR]);
    expect(v.text).toContain('the build it may continue');
  });

  test('a weekly reset already past is not waited on', () => {
    const v = decide(usage(10, 99, FIVE_RESET, at(NOW, -30 * MINUTE)), 'build', BUILD, new Knob(), NOW);
    expect([v.go, v.why, v.until]).toEqual([false, WEEKLY, null]);
  });

  test('a torn last record is ignored and cut off by the next', async () => {
    const book = new CostBook(join(await tempdir(), 'usage.jsonl'));
    for (let i = 0; i < 3; i++) book.record('fix', [], snap(10, 10), snap(20, 12));
    appendFileSync(book.path, '{"kind": "fix", "spe', 'utf8');
    expect(book.expected('fix')).toEqual(new Cost(10, 2));
    book.record('fix', [], snap(10, 10), snap(40, 12));
    expect(book.expected('fix')).toEqual(new Cost(30, 2));
  });
});

describe('RunningJobsTest', () => {
  // #50: each repo runs its own Claude job at once, so a job starts only when its cost fits after
  // the cost of every Claude job still running.

  test('a job that fits alone waits beside running jobs until one ends', () => {
    const running = new Running().plus('build first#4', BUILD);
    const v = decide(usage(30, 10), 'build', BUILD, new Knob(), NOW, running);
    expect([v.go, v.why, v.until]).toEqual([false, RUNNING, null]);
    expect(v.text).toContain('build would fit alone, but the Claude job running (build first#4) is '
      + 'expected to take 40% of 5 hours, 10% of the week: it waits for one of them to end');
  });

  test('a job that fits beside them starts and says so', () => {
    const running = new Running().plus('fix first#12', new Cost(20, 5)).plus('decision second#3', new Cost(5, 1));
    const v = decide(usage(30, 10), 'build', BUILD, new Knob(), NOW, running);
    expect([v.go, v.why]).toEqual([true, FITS]);
    expect(v.text).toContain('the 2 Claude jobs running (fix first#12, decision second#3) are expected '
      + 'to take 25% of 5 hours, 6% of the week, and it fits beside them');
  });

  test('one that does not fit alone waits for the reset as before', () => {
    const v = decide(usage(70, 10), 'build', BUILD, new Knob(), NOW, new Running().plus('x', BUILD));
    expect([v.why, v.until]).toEqual([FIVE_HOUR, at(FIVE_RESET, 2 * MINUTE)]);
  });

  test('a fresh window takes any job only while nothing runs', () => {
    const big = new Cost(70, 5);
    expect(decide(usage(0, 0, null), 'build', big, new Knob(), NOW).go).toBe(true);
    const v = decide(usage(0, 0, null), 'build', big, new Knob(), NOW, new Running().plus('build first#4', big));
    expect(v.why).toBe(RUNNING);
  });

  test('the reserve counts the running jobs too', () => {
    const v = decide(usage(10, 80), 'build', BUILD, new Knob(5), NOW, new Running().plus('build first#4', BUILD));
    expect(decide(usage(10, 80), 'build', BUILD, new Knob(5), NOW).go).toBe(true);
    expect(v.why).toBe(RUNNING);
  });

  test("the gate counts each running job's expected cost and what it may continue", async () => {
    const gate = new Gate(await tempdir(), new FakeUsage(usage(0, 10), usage(0, 10)), () => NOW);
    const running = gate.running([['decision first#3', 'decision', 'build']]);
    expect(running.cost).toEqual(CostBook.default('decision').add(CostBook.default('build')));
    expect((await gate.check('decision')).go).toBe(true);
    const v = await gate.check('build', null, [['decision first#3', 'decision', 'build']]);
    expect(v.go).toBe(false);   // 15 + 60 + 60 of 5 hours
  });

  test('a pass shared with another job teaches nothing', async () => {
    const book = new CostBook(join(await tempdir(), 'usage.jsonl'));
    for (let i = 0; i < 3; i++) book.record('fix', ['f'], snap(10, 10), snap(50, 20), null, ['b']);
    expect(book.expected('fix')).toEqual(CostBook.default('fix'));
    expect(book.learned('fix')).toBe(false);
    for (let i = 0; i < 3; i++) book.record('fix', ['f'], snap(10, 10), snap(20, 12));
    expect(book.expected('fix')).toEqual(new Cost(10, 2));
  });
});

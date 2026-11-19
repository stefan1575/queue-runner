// #202: a test gets time from a fake clock, never the machine's, so a slow CI runner never turns
// main red (docs/app.md, Test it). This fails a test file that reads the real clock or runs on
// real timers, and names the test that does; `no-real-settings.test.ts` does the same for the
// user's home.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { realTimeUses } from './real-time.ts';

const HERE = import.meta.dirname;
const SELF = ['no-real-time.test.ts', 'real-time.ts'];

describe('no test runs on the real clock', () => {
  it.each([
    ['Date.now', "const t = Date.now();"],
    ['a Date of now', "const t = new Date();"],
    ['a Date of now with no parentheses', "const t = new Date;"],
    ['a Date of now as a string', "const s = Date();"],
    ['performance.now', "const t = performance.now();"],
    ['process.hrtime', "const t = process.hrtime.bigint();"],
    ['process.uptime', "const t = process.uptime();"],
    ['a real wait', "await new Promise((r) => setTimeout(r, 1200));"],
    ['a real interval', "const i = setInterval(tick, 50);"],
    ['setImmediate', "await new Promise((r) => setImmediate(r));"],
    ["Node's timers", "import { setTimeout as sleep } from 'node:timers/promises';"],
    ["Node's timers without node:", "import { setInterval } from \"timers\";"],
    ['a timer over two lines', "const t = globalThis\n  .setTimeout(f, 10);"],
  ])('finds a test that uses %s', (_, source) => {
    expect(realTimeUses(source)).not.toEqual([]);
  });

  it('names the test the use is in, at the line it is on', () => {
    const source = [
      "describe('the poll', () => {",
      "  test('reads again later', async () => {",
      "    await new Promise((r) => setTimeout(r, 500));",
      "  });",
      "});",
      "const stamp = () => Date.now();",
    ].join('\n');
    expect(realTimeUses(source)).toEqual([
      "3: in test 'the poll > reads again later': a real timer (use vi.useFakeTimers or a seam the test runs): await new Promise((r) => setTimeout(r, 500));",
      "6: outside any test: the real clock (use vi.useFakeTimers or pass a clock): const stamp = () => Date.now();",
    ]);
  });

  it('passes a test whose time is its own', () => {
    const source = [
      "const now = new Date('2026-11-18T19:05:00Z');",
      "const gate = new UsageGate(source, settings, log, () => now);",
      "// comments may say Date.now() and setTimeout(r, 1200)",
      "const s = 'a string may say setInterval too';",
      "const seen = { setTimeoutCalls: 0 }; const myDate = new Dates();",
      "await vi.waitFor(() => expect(seen).toEqual([]));",
    ].join('\n');
    expect(realTimeUses(source)).toEqual([]);
  });

  it('passes a file that installs the fake clock', () => {
    const source = [
      "beforeEach(() => { vi.useFakeTimers(); });",
      "afterEach(() => { vi.useRealTimers(); });",
      "test('ticks', async () => { setTimeout(f, 500); await vi.advanceTimersByTimeAsync(500); expect(Date.now()).toBe(500); });",
    ].join('\n');
    expect(realTimeUses(source)).toEqual([]);
  });

  it('passes a describe or test that installs the fake clock, and only that one', () => {
    const source = [
      "describe('on the fake clock', () => {",
      "  beforeEach(() => { vi.useFakeTimers(); });",
      "  test('ticks', () => { setTimeout(f, 500); });",
      "});",
      "test('its own fake clock', () => { vi.useFakeTimers(); expect(Date.now()).toBe(0); });",
      "describe('on the real clock', () => {",
      "  test('waits', async () => { await new Promise((r) => setTimeout(r, 500)); });",
      "});",
    ].join('\n');
    expect(realTimeUses(source)).toEqual([
      "7: in test 'on the real clock > waits': a real timer (use vi.useFakeTimers or a seam the test runs): test('waits', async () => { await new Promise((r) => setTimeout(r, 500)); });",
    ]);
  });

  it("passes the app's tests", () => {
    const names = readdirSync(HERE, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts') && !SELF.includes(name));
    expect(names).toContain('time-format.test.ts');
    const found = names.flatMap((name) => realTimeUses(readFileSync(join(HERE, name), 'utf8')).map((hit) => `${name}:${hit}`));
    expect(found).toEqual([]);
  });
});

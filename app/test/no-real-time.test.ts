// #202: a test gets time from a fake clock, never the machine's, so a slow CI runner never turns
// main red (docs/app.md, Test it). This fails a test file that reads the real clock or runs on
// real timers, and names the test that does; `no-real-settings.test.ts` does the same for the
// user's home.
import { describe, expect, it } from 'vitest';
import { appTestFiles, hitsInAppTests } from './app-test-files.ts';
import { realTimeUses } from './real-time.ts';

const SELF = ['test/no-real-time.test.ts', 'test/real-time.ts'];

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

  it('excuses only what a toFake list fakes', () => {
    const source = [
      "test('the retry', () => {",
      "  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });",
      "  setTimeout(f, 500);",
      "  const t = Date.now();",
      "  const d = new Date();",
      "  const p = performance.now();",
      "  setInterval(f, 50);",
      "});",
      "test('on Date only', () => {",
      "  vi.useFakeTimers({ toFake: ['Date'] });",
      "  const t = Date.now();",
      "  setTimeout(f, 500);",
      "});",
    ].join('\n');
    expect(realTimeUses(source).map((hit) => hit.split(':')[0])).toEqual(['4', '5', '6', '7', '12']);
  });

  it('excuses nothing a fake clock never fakes, or one that follows the real clock', () => {
    const source = [
      "beforeEach(() => { vi.useFakeTimers(); });",
      "test('uptime', () => { const u = process.uptime(); });",
      "test('node timers', async () => { const { setTimeout: sleep } = await import('node:timers/promises'); });",
      "test('advancing', () => { vi.useFakeTimers({ shouldAdvanceTime: true }); });",
      "describe('advancing with the real clock', () => {",
      "  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });",
      "  test('ticks', () => { setTimeout(f, 500); });",
      "});",
      "test('a config the check cannot read', () => { vi.useFakeTimers(config); expect(Date.now()).toBe(0); });",
    ].join('\n');
    // The file's own fake clock fakes everything, so only what nothing fakes is a use.
    expect(realTimeUses(source).map((hit) => hit.split(':')[0])).toEqual(['2', '3']);
    const alone = source.split('\n').slice(3).join('\n');
    expect(realTimeUses(alone).map((hit) => hit.split(':')[0])).toEqual(['4', '6']);
  });

  it('reads a renderer test as JSX', () => {
    const source = [
      "test('the stamp', () => {",
      "  render(<p>it's {String(Date.now())}</p>);",
      "});",
    ].join('\n');
    expect(realTimeUses(source, 'renderer/test/page.test.tsx')).toEqual([
      "2: in test 'the stamp': the real clock (use vi.useFakeTimers or pass a clock): render(<p>it's {String(Date.now())}</p>);",
    ]);
  });

  it("reads every app test file, the renderer's included", () => {
    const files = appTestFiles();
    expect(files).toContain('test/time-format.test.ts');
    expect(files).toContain('renderer/test/models-page.test.tsx');
    expect(files).toContain('test/fake-t3.ts');
    expect(files.filter((f) => f.includes('node_modules'))).toEqual([]);
  });

  it("passes the app's tests", () => {
    expect(hitsInAppTests(SELF, realTimeUses)).toEqual([]);
  });
});

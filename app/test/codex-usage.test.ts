// ChatGPT's usage and reset credits through `codex app-server`, ported from
// `tests/test_codex_usage.py` case for case (#263), as T3 reads them: `account/rateLimits/read`.
// The responses are real ones (2026-11-16, ids and the account replaced; the Python tests' own,
// `tests/fixtures/codex`); the app server is `fixtures/codex/fake-app-server.mjs`, run by this
// Node, so no test starts Codex or reads a login.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CodexUsage, CodexUsageError, LimitWindow, Limits, parse } from '../src/codex-usage.ts';

const HERE = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'codex');
const WITH = join(HERE, 'rate-limits-read.json');
const WITHOUT = join(HERE, 'rate-limits-read-no-resets.json');
const FAKE = join(import.meta.dirname, 'fixtures', 'codex', 'fake-app-server.mjs');
const NOW = new Date('2026-11-16T04:00:00Z');

const result = (path: string): any => JSON.parse(readFileSync(path, 'utf8')).result;
const at = (epoch: number) => new Date(epoch * 1000);

/** `assertRaises(CodexUsageError)`: the error it throws. */
async function raises(f: () => unknown): Promise<CodexUsageError> {
  try {
    await f();
  } catch (e) {
    expect(e).toBeInstanceOf(CodexUsageError);
    return e as CodexUsageError;
  }
  throw new Error('CodexUsageError not raised');
}

describe('ParseTest', () => {
  test('the plan its windows and its reset credits', () => {
    const limits = parse(result(WITH));
    expect(limits).toEqual(new Limits('plus', [new LimitWindow(300, 35.0, at(1794764804)), new LimitWindow(10080, 28.0, at(1795212739))], 3));
  });

  test('a response without reset credits has none', () => {
    expect(parse(result(WITHOUT)).resets).toBeNull();
  });

  test("codex's own bucket is read first", () => {
    const data = result(WITH);
    data.rateLimits.primary.usedPercent = 99;
    expect(parse(data).windows[0]!.used).toBe(35.0);
    delete data.rateLimitsByLimitId;
    expect(parse(data).windows[0]!.used).toBe(99.0);
  });

  test("a window without its length takes its place's", () => {
    const data = result(WITH);
    delete data.rateLimitsByLimitId;
    data.rateLimits.primary.windowDurationMins = null;
    data.rateLimits.secondary.resetsAt = null;
    const limits = parse(data);
    expect(limits.windows).toEqual([new LimitWindow(300, 35.0, at(1794764804)), new LimitWindow(10080, 28.0, null)]);
  });

  test('a negative count is none left', () => {
    const data = result(WITH);
    data.rateLimitResetCredits.availableCount = -2;
    expect(parse(data).resets).toBe(0);
  });

  describe('no window at all is an error', () => {
    test.each([[{}], [{ rateLimits: {} }], [{ rateLimits: { primary: { usedPercent: 'x' } } }], [[]]])('data=%j', async (data) => {
      await raises(() => parse(data));
    });
  });
});

describe('ReadTest', () => {
  const codex = (fixture = WITH, how: string[] = [], timeout = 10) =>
    new CodexUsage({ command: [process.execPath, FAKE, fixture, ...how], timeout, clock: () => NOW });

  test('it asks after initializing and says when it read', async () => {
    const [when, limits] = await codex(WITH, ['--before-init']).read();
    expect([when, limits.plan, limits.resets]).toEqual([NOW, 'plus', 3]);
  });

  test('an error answer is an error that names it', async () => {
    const e = await raises(() => codex(WITH, ['--error']).read());
    expect(e.message).toContain('not signed in');
  });

  test('no answer in time is an error', async () => {
    const e = await raises(() => codex(WITH, ['--silent'], 1).read());
    expect(e.message).toContain('did not answer');
  });

  test('no codex is an error', async () => {
    await raises(() => new CodexUsage({ command: [join(HERE, 'no-such-codex.exe')], clock: () => NOW }).read());
    await raises(() => new CodexUsage({ command: null, find: () => null, clock: () => NOW }).read());
  });
});

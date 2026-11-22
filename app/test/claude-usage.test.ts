// Claude's usage windows, ported from `tests/test_usage.py` case for case (#263): parsed from a real
// `api/oauth/usage` response (saved 2026-11-10), and the one reader with its 5-minute budget. The
// fixtures are the Python tests' own (`tests/fixtures/usage`).
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CachedUsage, OAuthUsage, parse, type Request, Usage, UsageError } from '../src/claude-usage.ts';
import { StubEndpoint } from './fakes.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'usage');
const FIXTURE = join(FIXTURES, 'oauth-usage.json');
const MINUTE = 60_000;

const dirs: string[] = [];
async function tempdir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'qr-usage-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** `assertRaises(UsageError)`: the error it throws. */
async function raises(f: () => unknown): Promise<UsageError> {
  try {
    await f();
  } catch (e) {
    expect(e).toBeInstanceOf(UsageError);
    return e as UsageError;
  }
  throw new Error('UsageError not raised');
}

describe('ParseTest', () => {
  test('reads the five hour and weekly windows from a real response', () => {
    const usage = parse(readFileSync(FIXTURE));
    expect(usage.five_hour.used).toBe(80.0);
    // A `Date` holds milliseconds: Python's 21:20:00.473393 is 21:20:00.473.
    expect(usage.five_hour.resets_at).toEqual(new Date('2026-11-09T21:20:00.473Z'));
    expect(usage.seven_day.used).toBe(22.0);
    expect(usage.seven_day.resets_at).toEqual(new Date('2026-11-16T11:00:00.473Z'));
  });

  test('a window not started is unused with no reset', () => {
    const usage = parse(JSON.stringify({ five_hour: null, seven_day: { utilization: 3, resets_at: null } }));
    expect([usage.five_hour.used, usage.five_hour.resets_at]).toEqual([0.0, null]);
    expect([usage.seven_day.used, usage.seven_day.resets_at]).toEqual([3.0, null]);
  });

  test('a response without the windows is an error', async () => {
    for (const body of ['not json', '[]', '{"five_hour": {"resets_at": null}}']) await raises(() => parse(body));
  });

  test('a record round trips', () => {
    const usage = parse(readFileSync(FIXTURE));
    expect(Usage.from_record(JSON.parse(JSON.stringify(usage.record())))).toEqual(usage);
  });
});

const RESETS = join(FIXTURES, 'oauth-usage-resets.json');
const ON_THE_16TH = new Date('2026-11-16T04:00:00Z');

describe('ResetsTest', () => {
  // Reset credits, from the response's `cedar_ember` block as T3 counts them
  // (`claudeResetCreditsToContract`; the block as read on 2026-11-16).
  const block = (): any => JSON.parse(readFileSync(RESETS, 'utf8'));

  test('every usable grant counts its resets left', () => {
    const usage = parse(readFileSync(RESETS), ON_THE_16TH);
    expect(usage.resets).toBe(2);
    expect(usage.five_hour.used).toBe(80.0);   // the windows are read as before
  });

  test('a response without the block has no resets', () => {
    expect(parse(readFileSync(FIXTURE)).resets).toBeNull();
  });

  test('an account not eligible has no resets', () => {
    const data = block();
    data.cedar_ember.eligible = false;
    expect(parse(JSON.stringify(data), ON_THE_16TH).resets).toBeNull();
  });

  describe("a paused unusable or ended grant doesn't count", () => {
    test.each([
      [{ paused: true }], [{ usable_now: false }], [{ ends_at: '2026-11-01T00:00:00+00:00' }],
      [{ resets_left: -1 }], [{ id: 'Not An Id!' }],
    ])('change=%o', (change) => {
      const data = block();
      Object.assign(data.cedar_ember.grants[1], change);
      expect(parse(JSON.stringify(data), ON_THE_16TH).resets).toBe(1);
    });
  });

  test('with no next grant usable none are left', () => {
    const data = block();
    data.cedar_ember.next_grant_id = null;
    expect(parse(JSON.stringify(data), ON_THE_16TH).resets).toBe(0);
    data.cedar_ember.grants[0].paused = true;   // the next one itself
    data.cedar_ember.next_grant_id = 'full-reset-2611';
    expect(parse(JSON.stringify(data), ON_THE_16TH).resets).toBe(0);
  });

  test('the read asks for the block as T3 does', async () => {
    const seen: string[] = [];
    const fetch = async (request: Request) => {
      seen.push(request.full_url);
      return readFileSync(RESETS);
    };
    const d = await tempdir();
    writeFileSync(join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-fake' } }));
    const usage = await new OAuthUsage(d, fetch, () => ON_THE_16TH).read();
    expect(seen).toEqual(['https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1']);
    expect(usage.resets).toBe(2);
  });
});

describe('LoginTest', () => {
  test('no login says where it looked and never the token', async () => {
    const d = await tempdir();
    let e = await raises(() => new OAuthUsage(d).read());
    expect(e.message).toContain('.credentials.json');
    writeFileSync(join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-secret-123', expiresAt: 1000 } }));
    const boom = async (): Promise<string> => {
      const err = new Error('boom');
      err.name = 'OSError';
      throw err;
    };
    e = await raises(() => new OAuthUsage(d, boom).read());
    expect(e.message).not.toContain('sk-secret-123');
    expect(e.message).toContain('expired');
  });
});

class Clock {
  t: Date;
  constructor(t = new Date('2026-11-16T06:01:49Z')) {
    this.t = t;
  }
  readonly now = () => this.t;
  tick(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

describe('CachedUsageTest', () => {
  // One reading, one budget (issue 66): the endpoint is asked at most once every 5 minutes,
  // failed calls counted, and a failed call keeps the last good reading.
  let dir: string;
  let clock: Clock;
  let endpoint: StubEndpoint;
  let heard: [boolean, string | null][];
  let usage: CachedUsage;
  beforeEach(async () => {
    dir = await tempdir();
    clock = new Clock();
    endpoint = new StubEndpoint(clock.now);
    heard = [];
    usage = new CachedUsage(endpoint.oauth(dir), clock.now, (ok, note) => heard.push([ok, note]));
  });

  test('inside the budget the cached reading is given back with its time', async () => {
    const first = clock.now();
    expect(await usage.due(300)).toBe(true);
    expect((await usage.read()).five_hour.used).toBe(38);
    clock.tick(30_000);
    endpoint.five = 50;
    expect(await usage.due(0)).toBe(false);
    expect((await usage.read()).five_hour.used).toBe(38);   // cached: no call
    expect(endpoint.calls.length).toBe(1);
    const r = (await usage.reading())!;
    expect([r.at, r.error, r.next_at]).toEqual([first, null, new Date(first.getTime() + 5 * MINUTE)]);
    expect(await usage.wait_seconds()).toBe(270);
    clock.tick(270_000);
    expect(await usage.next_call_at()).toBeNull();
    expect((await usage.read()).five_hour.used).toBe(50);
    expect(endpoint.calls.map(([, s]) => s)).toEqual([200, 200]);
    expect(heard).toEqual([[true, null], [true, null]]);
  });

  test('a failed call keeps the last good reading and counts against the budget', async () => {
    const first = clock.now();
    await usage.read();
    clock.tick(5 * MINUTE);
    endpoint.fail = 429;
    expect((await usage.read()).five_hour.used).toBe(38);   // the last good value
    const r = (await usage.reading())!;
    expect([r.at, r.error, r.login]).toEqual([first, 'the usage endpoint answered HTTP 429', false]);
    expect(r.failing(clock.now())).toBe(false);   // a recent reading stands
    expect(r.next_at).toEqual(new Date(clock.now().getTime() + 5 * MINUTE));
    clock.tick(MINUTE);
    await usage.read();
    expect(endpoint.calls.length).toBe(2);   // no retry inside the budget
    expect(heard[heard.length - 1]).toEqual([false, 'the usage endpoint answered HTTP 429']);
  });

  test('a reading past thirty minutes with failing calls is failing', async () => {
    await usage.read();
    endpoint.fail = 429;
    for (let i = 0; i < 6; i++) {
      clock.tick(5 * MINUTE);
      await usage.read();
    }
    expect((await usage.reading())!.failing(clock.now())).toBe(false);   // 30 minutes: not past
    clock.tick(1000);
    expect((await usage.reading())!.failing(clock.now())).toBe(true);
  });

  test("a login that can't be read asks nothing and is failing once it lasts", async () => {
    await usage.read();
    rmSync(join(dir, '.credentials.json'));
    clock.tick(5 * MINUTE);
    await usage.read();
    const r = (await usage.reading())!;
    expect(r.login).toBe(true);
    expect(r.since).toEqual(clock.now());
    expect(r.failing(clock.now())).toBe(false);   // reconnecting: not shown yet
    expect(r.failing(new Date(clock.now().getTime() + 10 * MINUTE))).toBe(true);
    expect(r.next_at).toBeNull();   // it spent no call: the next read may ask at once
    expect(endpoint.calls.length).toBe(1);
  });

  test("http 401 is the login's trouble", async () => {
    await usage.read();
    clock.tick(5 * MINUTE);
    endpoint.fail = 401;
    await usage.read();
    const r = (await usage.reading())!;
    expect(r.login).toBe(true);
    expect(r.failing(new Date(clock.now().getTime() + 10 * MINUTE))).toBe(true);
  });

  test('a 401 after the pc wakes is not shown once the next read answers', async () => {
    // Stefan, 2026-11-17: the token expired while the PC slept, a Claude Code session refreshed
    // it four minutes after it woke, and the next read answered.
    await usage.read();
    clock.tick(6 * 60 * MINUTE);
    endpoint.fail = 401;
    await usage.read();
    expect((await usage.reading())!.failing(clock.now())).toBe(false);
    clock.tick(5 * MINUTE);
    endpoint.fail = null;
    await usage.read();
    const r = (await usage.reading())!;
    expect([r.error, r.since]).toEqual([null, null]);
  });

  test('with no good reading a read raises the error', async () => {
    endpoint.fail = 429;
    const e = await raises(() => usage.read());
    expect(e.message).toContain('HTTP 429');
    expect((await usage.reading())!.failing(clock.now())).toBe(false);   // reconnecting
    expect((await usage.reading())!.failing(new Date(clock.now().getTime() + 10 * MINUTE))).toBe(true);
    expect(await new CachedUsage(endpoint.oauth(dir), clock.now).reading()).toBeNull();
  });
});

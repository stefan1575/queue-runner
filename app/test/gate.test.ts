// The usage gate's decision (#153): a job starts only when its expected cost fits each of its
// provider's windows, beside the jobs already running on that login, leaving your share.
import { describe, expect, test } from 'vitest';
import { checkJob, holdText, type GateInput } from '../src/gate.ts';
import type { ProviderUsage, UsageWindow } from '../src/usage.ts';

const NOW = new Date('2026-11-19T12:00:00Z');
const win = (id: string, kind: UsageWindow['kind'], used: number, resetsAt: string, label = kind === 'session' ? 'Session' : 'Weekly'): UsageWindow =>
  ({ id, kind, label, usedPercent: used, resetsAt, minutes: kind === 'session' ? 300 : 10080 });
const claude = (five: number, week: number, extra: UsageWindow[] = []): ProviderUsage => ({
  provider: 'claudeAgent', driver: 'claudeAgent', account: 'claudeAgent:w1', label: 'Claude', name: 'Claude',
  checkedAt: '2026-11-19T11:58:00Z', resetCredits: null, unavailable: null,
  windows: [win('five_hour', 'session', five, '2026-11-19T14:20:00Z'), win('seven_day', 'weekly', week, '2026-11-23T11:00:00Z'), ...extra],
});
const job = { id: 'build a#1', kind: 'build' as const, choice: { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'medium' } };
const input = (usage: ProviderUsage | undefined, more: Partial<GateInput> = {}): GateInput => ({
  job, usage, model: { id: 'claude-opus-5-5', label: 'Opus 5.5' }, running: [], shares: {}, records: [], now: NOW, lastEnd: null, ...more,
});
const fmt = (d: Date) => d.toISOString().slice(11, 16);

describe('the usage gate', () => {
  test("a build fits while its windows have room for its expected cost", () => {
    expect(checkJob(input(claude(30, 50)))).toMatchObject({ fits: true, cost: { five_hour: 60, seven_day: 15 } });
  });

  test("a build waits for the 5-hour window's reset when it won't fit, and says so", () => {
    const v = checkJob(input(claude(46, 50)));
    expect(v.fits).toBe(false);
    if (v.fits) return;
    expect(v.until?.toISOString()).toBe('2026-11-19T14:22:00.000Z');
    expect(holdText(v.hold, fmt)).toBe("Claude's 5-hour window resets at 14:20; this build needs about 60%");
  });

  test('a window with nothing used takes any job', () => {
    expect(checkJob(input(claude(0, 50))).fits).toBe(true);
  });

  test('a job that fits alone but not beside the jobs running on its login waits for them', () => {
    const running = [{ id: 'review a#2', account: 'claudeAgent:w1', cost: { five_hour: 15, seven_day: 4 } }];
    const v = checkJob(input(claude(30, 50), { running }));
    expect(v).toMatchObject({ fits: false, until: null, hold: { why: 'running', jobs: ['review a#2'] } });
    if (!v.fits) expect(holdText(v.hold, fmt)).toBe("Claude's 5-hour window would fit this build alone, but the jobs running there (review a#2) are expected to take 15%");
    // a job running on another provider's login holds nothing here
    expect(checkJob(input(claude(30, 50), { running: [{ ...running[0]!, account: 'codex:w2' }] })).fits).toBe(true);
  });

  test('your share of the week holds until its release, then frees', () => {
    const shares = { 'claudeAgent/seven_day': { percent: 5, releaseHours: 24 } };
    const v = checkJob(input(claude(10, 82), { shares }));
    expect(v).toMatchObject({ fits: false, hold: { why: 'share', kept: 5 } });
    if (!v.fits) {
      expect(v.until?.toISOString()).toBe('2026-11-22T11:00:00.000Z');
      expect(holdText(v.hold, fmt)).toBe("5% of Claude's week is kept for you until 11:00; this build needs about 15%");
    }
    const released = new Date('2026-11-22T11:00:00Z');
    expect(checkJob(input({ ...claude(10, 82), checkedAt: '2026-11-22T10:59:00Z' }, { shares, now: released })).fits).toBe(true);
    // no room even with the share released: it waits for the week's reset
    const full = checkJob(input(claude(10, 90), { shares }));
    expect(full).toMatchObject({ fits: false, hold: { why: 'window' } });
    if (!full.fits) expect(full.until?.toISOString()).toBe('2026-11-23T11:02:00.000Z');
  });

  test("a window for another family of models doesn't hold this one", () => {
    const fable = win('seven_day_fable', 'weekly', 99, '2026-11-23T11:00:00Z', 'Weekly · Fable');
    expect(checkJob(input(claude(10, 50, [fable]))).fits).toBe(true);
    const v = checkJob(input(claude(10, 50, [fable]), { model: { id: 'claude-fable-5-2', label: 'Fable 5.2' } }));
    expect(v).toMatchObject({ fits: false, hold: { window: "Claude's Fable week" } });
  });

  test('no reading to decide on: none, one from before the last job there ended, or one over 30 minutes old', () => {
    expect(checkJob(input(undefined))).toMatchObject({ fits: false, until: null, hold: { why: 'reading' } });
    const before = checkJob(input(claude(10, 10), { lastEnd: new Date('2026-11-19T11:59:00Z') }));
    expect(before).toMatchObject({ fits: false, hold: { why: 'reading' } });
    if (!before.fits) expect(holdText(before.hold, fmt)).toBe("T3 hasn't read Claude's usage since the last job there ended (last read 11:58)");
    expect(checkJob(input(claude(10, 10), { now: new Date('2026-11-19T12:29:00Z') })).fits).toBe(false);
  });

  test("a provider T3 reads no usage for isn't gated", () => {
    const none: ProviderUsage = { ...claude(0, 0), windows: [], unavailable: 'unsupported', checkedAt: null };
    expect(checkJob(input(none))).toMatchObject({ fits: true, ungated: true });
  });
});

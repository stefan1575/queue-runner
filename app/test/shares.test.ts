// Your share (#153): a percent of each provider's weekly windows kept for you until its release.
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { checkShares, DEFAULT_SHARE, heldPercent, releaseAt, shareRows } from '../src/shares.ts';
import { usageFromProviders } from '../src/usage.ts';

const snapshot = JSON.parse(await readFile(new URL('./fixtures/server-config.json', import.meta.url), 'utf8'));
const usage = usageFromProviders(snapshot.config.providers);

describe('your share', () => {
  test('one row per provider per weekly window, 0% kept until 24 hours before the reset by default', () => {
    const rows = shareRows(usage, { 'claudeAgent/seven_day': { percent: 5, releaseHours: 24 } });
    expect(rows.map((r) => [r.key, r.title, r.enforced, r.share.percent])).toEqual([
      ['codex/secondary', "Codex's week", true, 0],
      ['claudeAgent/seven_day', "Claude's week", true, 5],
      ['claudeAgent/seven_day_fable', "Claude's Fable week", true, 0],
    ]);
    expect(rows[0]!.share).toEqual(DEFAULT_SHARE);
    expect(DEFAULT_SHARE).toEqual({ percent: 0, releaseHours: 24 });
  });

  test("a provider T3 reads no usage for shows one row it can't enforce", () => {
    const rows = shareRows(usageFromProviders([{ instanceId: 'x1', driver: 'x', displayName: 'Ex', status: 'ready' }]), {});
    expect(rows).toEqual([{ key: 'x/weekly', title: "Ex's week", resetsAt: null, enforced: false, share: DEFAULT_SHARE }]);
  });

  test('each share holds until its own release time, then frees', () => {
    const share = { percent: 5, releaseHours: 24 };
    const week = { resetsAt: '2026-11-23T11:00:00.000Z' };
    expect(releaseAt(share, week.resetsAt)?.toISOString()).toBe('2026-11-22T11:00:00.000Z');
    expect(heldPercent(share, week, new Date('2026-11-22T10:59:00Z'))).toBe(5);
    expect(heldPercent(share, week, new Date('2026-11-22T11:00:00Z'))).toBe(0);
    // another window, another release
    expect(heldPercent({ percent: 10, releaseHours: 48 }, { resetsAt: '2026-11-24T14:00:00Z' }, new Date('2026-11-22T13:00:00Z'))).toBe(10);
    expect(heldPercent({ percent: 10, releaseHours: 48 }, { resetsAt: '2026-11-24T14:00:00Z' }, new Date('2026-11-22T14:00:00Z'))).toBe(0);
  });

  test('the setting takes whole percents and hours up to a week, keyed by driver and window', () => {
    expect(checkShares({ 'a/w': { percent: 5, releaseHours: 24 } })).toEqual({ 'a/w': { percent: 5, releaseHours: 24 } });
    for (const bad of [[], { w: { percent: 5, releaseHours: 24 } }, { 'a/w': { percent: 101, releaseHours: 24 } },
      { 'a/w': { percent: 1.5, releaseHours: 24 } }, { 'a/w': { percent: 5, releaseHours: 169 } }, { 'a/w': { percent: 5 } }]) {
      expect(checkShares(bad)).toBeUndefined();
    }
  });
});

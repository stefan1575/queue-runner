// Each provider's usage windows, read from T3's server config (#153; docs/app.md, Usage).
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { usageFromProviders, windowCounts, windowName } from '../src/usage.ts';

const snapshot = JSON.parse(await readFile(new URL('./fixtures/server-config.json', import.meta.url), 'utf8'));

describe("T3's usage windows", () => {
  test('each connected provider, its windows and resets, and which login they belong to', () => {
    const usage = usageFromProviders(snapshot.config.providers);
    expect(usage.map((u) => u.provider)).toEqual(['codex', 'claudeAgent', 'claudeReviewer']);
    const claude = usage[1]!;
    expect(claude.windows.map((w) => [w.id, w.kind, w.usedPercent])).toEqual([
      ['five_hour', 'session', 46], ['seven_day', 'weekly', 36], ['seven_day_fable', 'weekly', 11],
    ]);
    expect(claude.windows[0]!.resetsAt).toBe('2026-11-18T20:40:00.140Z');
    expect(claude.unavailable).toBeNull();
    // two instances on one login share an account; another provider has its own
    expect(usage[2]!.account).toBe(claude.account);
    expect(usage[0]!.account).not.toBe(claude.account);
    expect(usage[0]!.resetCredits).toBe(2);
    // the login's name is its instances' shortest
    expect(usage.map((u) => u.name)).toEqual(['Codex', 'Claude', 'Claude']);
  });

  test("a provider T3 can't read usage for has no windows and says why", () => {
    const usage = usageFromProviders([
      { instanceId: 'a', driver: 'x', status: 'ready', usageLimits: { checkedAt: '2026-11-18T00:00:00Z', windows: [], unavailable: { reason: 'unsupported' } } },
      { instanceId: 'b', driver: 'x', status: 'ready' },
      { instanceId: 'c', driver: 'x', status: 'disabled', usageLimits: { windows: [] } },
    ]);
    expect(usage.map((u) => [u.provider, u.unavailable, u.account])).toEqual([['a', 'unsupported', 'x:a'], ['b', 'unsupported', 'x:b']]);
  });

  test("a window for one family of models counts only that family's", () => {
    const fam = { label: 'Weekly · Fable' }, all = { label: 'Weekly' };
    expect(windowCounts(fam, { id: 'claude-fable-5-2', label: 'Fable 5.2' })).toBe(true);
    expect(windowCounts(fam, { id: 'claude-opus-5-5', label: 'Opus 5.5' })).toBe(false);
    expect(windowCounts(all, { id: 'claude-opus-5-5' })).toBe(true);
  });

  test('windows as a person says them', () => {
    expect(windowName('Claude', { kind: 'session', label: 'Session', minutes: 300 })).toBe("Claude's 5-hour window");
    expect(windowName('Claude', { kind: 'weekly', label: 'Weekly', minutes: 10080 })).toBe("Claude's week");
    expect(windowName('Claude', { kind: 'weekly', label: 'Weekly · Fable', minutes: 10080 })).toBe("Claude's Fable week");
    expect(windowName('Codex', { kind: 'other', label: 'Credits', minutes: null })).toBe("Codex's Credits window");
  });
});

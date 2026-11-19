// The usage gate on fake T3's usage events (#153): each job waits for room in the provider it runs
// on, beside the jobs running on that provider's login, and a kind with a fallback runs on it
// while its own provider is out.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CostLog } from '../src/cost-log.ts';
import { holdText } from '../src/gate.ts';
import { DEFAULT_JOBS, type Jobs, type ModelChoice } from '../src/jobs.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.ts';
import { T3Catalog, type CatalogSource, type CatalogState } from '../src/t3/catalog-source.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { usageFromProviders } from '../src/usage.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { UsageGate } from '../src/usage-gate.ts';
import { FakeT3 } from './fake-t3.ts';

const snapshot = JSON.parse(await readFile(new URL('./fixtures/server-config.json', import.meta.url), 'utf8'));
const OPUS: ModelChoice = { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'medium' };
const SOL: ModelChoice = { provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' };
// the fixture's readings: Claude's at 18:59:58 (5-hour 46%, resets 20:40), Codex's at 19:04:14
// (5-hour 100%, resets 20:52:50)
let now = new Date('2026-11-18T19:05:00Z');
let dir: string;
let t3: FakeT3;
let source: T3Catalog;
let settings: Settings;
let gate: UsageGate;
let providers: any[];

beforeEach(async () => {
  now = new Date('2026-11-18T19:05:00Z');
  dir = await mkdtemp(join(tmpdir(), 'qr-gate-'));
  t3 = new FakeT3();
  t3.serverConfig = snapshot;
  providers = structuredClone(snapshot.config.providers);
  // T3's address is the fake's own, so `until` waits on nothing but the fake (#202 F2); the cost
  // log is on disk, and each test awaits its writes (`gate.settled()`).
  source = T3Catalog.start(new T3Ws(t3.address, t3.cli, t3.http, t3.connect), 10);
  settings = { ...DEFAULT_SETTINGS };
  gate = new UsageGate(source, () => settings, await CostLog.open(join(dir, 'usage.jsonl')), () => now);
  await until(() => source.current().usage.length > 0);
});
afterEach(async () => {
  source.stop();
  await gate.settled();
  await rm(dir, { recursive: true, force: true });
});

const until = (f: () => boolean) => vi.waitFor(() => { if (!f()) throw new Error('not yet'); }, { timeout: 2000, interval: 5 });
const jobs = (part: Partial<Jobs>) => { settings = { ...settings, jobs: { ...DEFAULT_JOBS, ...part } }; };
const window = (instance: string, id: string) => providers.find((p) => p.instanceId === instance).usageLimits.windows.find((w: any) => w.id === id);
/** T3 read new usage at `checkedAt` and told the app. */
async function t3Reads(checkedAt: string, change: () => void) {
  change();
  for (const p of providers) if (p.usageLimits) p.usageLimits.checkedAt = checkedAt;
  t3.pushConfig('providerStatuses', { providers: structuredClone(providers) });
  await until(() => source.current().usage.every((u) => u.checkedAt === checkedAt));
}
const hhmm = (d: Date) => d.toISOString().slice(11, 16);

describe('every job waits for room in its own provider', () => {
  test("a build waits while its provider's 5-hour window won't fit it, and starts while another provider's is full", async () => {
    jobs({ build: { own: SOL, fallback: null } });
    const onSol = gate.pick('build a#1', 'build');
    expect(onSol).toMatchObject({ fits: false, hold: { why: 'window', window: "Codex's 5-hour window" } });
    if (!onSol.fits) expect(onSol.until?.toISOString()).toBe('2026-11-18T20:54:50.000Z');

    jobs({ build: { own: OPUS, fallback: null } });
    const held = gate.pick('build a#1', 'build');
    expect(held.fits).toBe(false);
    if (!held.fits) expect(holdText(held.hold, hhmm)).toBe("Claude's 5-hour window resets at 20:40; this build needs about 60%");
    expect(gate.holds().get('build a#1')?.hold).toEqual(held.fits ? null : held.hold);

    // T3 reads Claude's window lower; Codex's is still full
    await t3Reads('2026-11-18T19:06:00Z', () => { window('claudeAgent', 'five_hour').usedPercent = 30; });
    now = new Date('2026-11-18T19:06:30Z');
    expect(gate.pick('build a#1', 'build')).toMatchObject({ fits: true, choice: OPUS, onFallback: false });
    expect(gate.holds().has('build a#1')).toBe(false);
  });

  test("a review is held by its own provider's window and the jobs running there, not by another provider's", async () => {
    jobs({ review: { own: SOL, fallback: null } });
    await t3Reads('2026-11-18T19:06:00Z', () => { window('codex', 'primary').usedPercent = 30; window('claudeAgent', 'five_hour').usedPercent = 99; });
    now = new Date('2026-11-18T19:06:30Z');
    // Claude's window nearly full and a build running there: neither holds a review on Codex
    gate.started({ id: 'build a#1', kind: 'build', choice: OPUS }, { five_hour: 60, seven_day: 15 });
    expect(gate.pick('review a#2', 'review')).toMatchObject({ fits: true, choice: SOL });
    // a build running on Codex leaves no room beside it
    gate.started({ id: 'build b#3', kind: 'build', choice: SOL }, { primary: 60, secondary: 15 });
    const held = gate.pick('review a#2', 'review');
    expect(held).toMatchObject({ fits: false, until: null, hold: { why: 'running', jobs: ['build b#3'] } });
    gate.finished('build b#3');
    await t3Reads('2026-11-18T19:30:00Z', () => { window('codex', 'primary').usedPercent = 40; });
    now = new Date('2026-11-18T19:30:30Z');
    expect(gate.pick('review a#2', 'review')).toMatchObject({ fits: true, choice: SOL });
  });

  test("a kind with a fallback runs on it while its provider is out; without one it waits for the reset", async () => {
    await t3Reads('2026-11-18T19:06:00Z', () => { window('claudeAgent', 'five_hour').usedPercent = 10; });
    now = new Date('2026-11-18T19:06:30Z');
    jobs({ build: { own: SOL, fallback: OPUS } });
    expect(gate.pick('build a#1', 'build')).toMatchObject({ fits: true, choice: OPUS, onFallback: true });
    jobs({ build: { own: SOL, fallback: null } });
    const held = gate.pick('build a#1', 'build');
    expect(held).toMatchObject({ fits: false, hold: { why: 'window', window: "Codex's 5-hour window" } });
    if (!held.fits) expect(held.until?.toISOString()).toBe('2026-11-18T20:54:50.000Z');
  });

  test("a job's cost is measured on T3's first reading after it ends, and the next job of its kind waits for that reading", async () => {
    await t3Reads('2026-11-18T19:06:00Z', () => { window('claudeAgent', 'five_hour').usedPercent = 10; });
    now = new Date('2026-11-18T19:06:30Z');
    const job = { id: 'build a#1', kind: 'build' as const, choice: OPUS };
    gate.started(job, { five_hour: 60, seven_day: 15 });
    now = new Date('2026-11-18T19:40:00Z');
    gate.finished(job.id);
    expect(gate.check({ ...job, id: 'build a#2' })).toMatchObject({ fits: false, hold: { why: 'reading', stale: 'before-end' } });
    await t3Reads('2026-11-18T19:41:00Z', () => { window('claudeAgent', 'five_hour').usedPercent = 14; window('claudeAgent', 'seven_day').usedPercent = 37; });
    now = new Date('2026-11-18T19:41:10Z');
    await gate.settled();
    const lines = (await readFile(join(dir, 'usage.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'medium', kind: 'build', job: 'build a#1', spent: { five_hour: 4, seven_day: 1, seven_day_fable: 0 } });
    expect(gate.check({ ...job, id: 'build a#2' }).fits).toBe(true);
  });
});

describe('jobs started before T3 names their login (#154 F10)', () => {
  /** A source T3 hasn't answered yet: no catalog, no usage, until `answer`. */
  function coldSource() {
    let state: CatalogState = { catalog: null, usage: [] };
    const listeners = new Set<(s: CatalogState) => void>();
    const cold: CatalogSource = { current: () => state, onChange: (l) => { listeners.add(l); return () => listeners.delete(l); } };
    const answer = (used: number, emit = true, checkedAt = '2026-11-18T19:04:30.000Z') => {
      const ps = structuredClone(snapshot.config.providers);
      for (const p of ps) if (p.usageLimits) { p.usageLimits.checkedAt = checkedAt; for (const w of p.usageLimits.windows) w.usedPercent = used; }
      state = { catalog: catalogFromConfig({ ...snapshot.config, providers: ps }), usage: usageFromProviders(ps) };
      if (emit) for (const l of listeners) l(state);
    };
    return { cold, answer };
  }
  const BEFORE = { checkedAt: '2026-11-18T19:00:00.000Z', windows: {} };

  test.each([['tells the gate', true], ['is only asked', false]])(
    "a build reserved before T3's first catalog counts against its real login once T3 %s", async (_, emit) => {
      jobs({ build: { own: OPUS, fallback: null } });
      const { cold, answer } = coldSource();
      const g = new UsageGate(cold, () => settings, await CostLog.open(join(dir, 'cold.jsonl')), () => now);
      g.started({ id: 'recovered', kind: 'build', choice: OPUS }, { five_hour: 60, seven_day: 15 }, BEFORE);
      answer(25, emit);
      // 25% used and the recovered build holding 60%: no room for another 60% build beside it
      expect(g.pick('build b#2', 'build')).toMatchObject({ fits: false, hold: { why: 'running', jobs: ['recovered'] } });
    });

  test('two builds reserved before the catalog are counted beside each other, and one that ended then holds the next reading', async () => {
    jobs({ build: { own: OPUS, fallback: null } });
    const { cold, answer } = coldSource();
    const costs = join(dir, 'cold.jsonl');
    const g = new UsageGate(cold, () => settings, await CostLog.open(costs), () => now);
    g.started({ id: 'one', kind: 'build', choice: OPUS }, { five_hour: 10 }, BEFORE);
    g.started({ id: 'two', kind: 'build', choice: OPUS }, { five_hour: 10 }, BEFORE);
    now = new Date('2026-11-18T19:06:00Z');
    g.finished('one');
    // T3's first answer reads usage from before 'one' ended: it decides nothing on that login
    answer(0);
    expect(g.check({ id: 'three', kind: 'build', choice: OPUS })).toMatchObject({ fits: false, hold: { why: 'reading', stale: 'before-end' } });
    now = new Date('2026-11-18T19:20:00Z');
    g.finished('two');
    answer(20, true, '2026-11-18T19:30:00.000Z');
    await g.settled();
    const records = (await CostLog.open(costs)).records();
    expect(records.map((r) => [r.job, r.sharedWith])).toEqual([['one', ['two']], ['two', ['one']]]);
  });
});

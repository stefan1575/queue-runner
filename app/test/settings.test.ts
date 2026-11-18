// The settings the window edits: kept in the state folder, saved the moment they change, and read
// back on the next start. Only the state folder's location is in a machine file (#36, Fixed).
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_JOBS } from '../src/jobs.ts';
import { DEFAULT_SETTINGS, SettingsError, SettingsStore } from '../src/settings.ts';
import { stateFolder } from '../src/state-folder.ts';

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});
async function temp() {
  const d = await mkdtemp(join(tmpdir(), 'qr-settings-'));
  dirs.push(d);
  return d;
}

describe('the state folder', () => {
  test('a first start writes the default into the machine file and uses it', async () => {
    const d = await temp();
    const machine = join(d, 'machine.json');
    expect(stateFolder(machine, join(d, 'state'))).toBe(join(d, 'state'));
    expect(JSON.parse(await readFile(machine, 'utf8'))).toEqual({ stateFolder: join(d, 'state') });
  });

  test('the machine file says where it is', async () => {
    const d = await temp();
    const machine = join(d, 'machine.json');
    await writeFile(machine, JSON.stringify({ stateFolder: join(d, 'elsewhere') }));
    expect(stateFolder(machine, join(d, 'state'))).toBe(join(d, 'elsewhere'));
  });

  test("a machine file that can't be read stops the start rather than moving the state", async () => {
    const d = await temp();
    const machine = join(d, 'machine.json');
    await writeFile(machine, '{not json');
    expect(() => stateFolder(machine, join(d, 'state'))).toThrow(/machine\.json/);
  });
});

describe('the settings', () => {
  test('a new install has the defaults', async () => {
    const store = await SettingsStore.open(await temp());
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ name: null, dateStyle: 'month-first', startWithWindows: true, jobs: DEFAULT_JOBS, shares: {}, repos: null });
  });

  test('a change is saved at once and survives a restart', async () => {
    const folder = await temp();
    const store = await SettingsStore.open(folder);
    await store.set({ name: 'Ana' });
    await store.set({ dateStyle: 'iso' });
    await store.set({ startWithWindows: false });
    const again = await SettingsStore.open(folder);
    expect(again.get()).toEqual({ ...DEFAULT_SETTINGS, name: 'Ana', dateStyle: 'iso', startWithWindows: false });
  });

  test('each change is told to the listeners', async () => {
    const store = await SettingsStore.open(await temp());
    const seen: unknown[] = [];
    store.onChange((s) => seen.push(s));
    await store.set({ dateStyle: 'day-first' });
    expect(seen).toEqual([{ ...DEFAULT_SETTINGS, dateStyle: 'day-first' }]);
  });

  test('a blank name goes back to the GitHub account name', async () => {
    const store = await SettingsStore.open(await temp());
    await store.set({ name: '  Ana  ' });
    expect(store.get().name).toBe('Ana');
    await store.set({ name: '   ' });
    expect(store.get().name).toBeNull();
  });

  test('a value the page never offers is refused and nothing is saved', async () => {
    const folder = await temp();
    const store = await SettingsStore.open(folder);
    await expect(store.set({ dateStyle: 'sideways' } as any)).rejects.toThrow(SettingsError);
    await expect(store.set({ startWithWindows: 'yes' } as any)).rejects.toThrow(SettingsError);
    await expect(store.set({ colour: 'red' } as any)).rejects.toThrow(SettingsError);
    expect((await SettingsStore.open(folder)).get()).toEqual(DEFAULT_SETTINGS);
  });

  // A change whose write fails is not kept: the next change saves on top of what's on disk, so a
  // refused Start with Windows never reaches the file or the logon entry later (PR #174, F2).
  test("a change whose write fails isn't kept, and a later change doesn't save it", async () => {
    const folder = await temp();
    const store = await SettingsStore.open(folder);
    await store.set({ startWithWindows: false });
    const seen: unknown[] = [];
    store.onChange((s) => seen.push(s));
    // A folder where the write's temp file goes makes that write fail.
    await mkdir(join(folder, 'settings.json.tmp'));
    await expect(store.set({ startWithWindows: true })).rejects.toThrow();
    expect(store.get().startWithWindows).toBe(false);
    expect(seen).toEqual([]);
    await rm(join(folder, 'settings.json.tmp'), { recursive: true });
    await store.set({ name: 'Ana' });
    expect(store.get()).toEqual({ ...DEFAULT_SETTINGS, name: 'Ana', startWithWindows: false });
    expect((await SettingsStore.open(folder)).get()).toEqual({ ...DEFAULT_SETTINGS, name: 'Ana', startWithWindows: false });
    expect(seen).toEqual([{ ...DEFAULT_SETTINGS, name: 'Ana', startWithWindows: false }]);
  });

  // Changes made together each land on the one before, in order, whichever write is slower.
  test('changes made at once each build on the last, and the file ends on all of them', async () => {
    const folder = await temp();
    const store = await SettingsStore.open(folder);
    await Promise.all([store.set({ name: 'Ana' }), store.set({ dateStyle: 'iso' }), store.set({ startWithWindows: false })]);
    const all = { ...DEFAULT_SETTINGS, name: 'Ana', dateStyle: 'iso', startWithWindows: false };
    expect(store.get()).toEqual(all);
    expect((await SettingsStore.open(folder)).get()).toEqual(all);
  });

  // A new install follows T3's default for every kind; a choice is kept from then on (#152).
  test("each kind's model is saved and survives a restart, and a malformed one is refused", async () => {
    const folder = await temp();
    const store = await SettingsStore.open(folder);
    expect(store.get().jobs.default).toBeNull();
    const pick = { provider: 'p', model: 'm', effort: 'e' };
    const jobs = { ...DEFAULT_JOBS, default: pick, review: { own: { ...pick, effort: 'f' }, fallback: pick } };
    await store.set({ jobs });
    expect((await SettingsStore.open(folder)).get().jobs).toEqual(jobs);
    await expect(store.set({ jobs: { ...jobs, default: { provider: 'p' } } } as any)).rejects.toThrow(SettingsError);
    expect((await SettingsStore.open(folder)).get().jobs).toEqual(jobs);
  });

  // Your share (#153): nothing kept until a row is set.
  test('your share of a window is saved and survives a restart, and a malformed one is refused', async () => {
    const folder = await temp();
    const store = await SettingsStore.open(folder);
    expect(store.get().shares).toEqual({});
    const shares = { 'p/week': { percent: 5, releaseHours: 24 } };
    await store.set({ shares });
    expect((await SettingsStore.open(folder)).get().shares).toEqual(shares);
    await expect(store.set({ shares: { 'p/week': { percent: -1, releaseHours: 24 } } })).rejects.toThrow(SettingsError);
    expect(store.get().shares).toEqual(shares);
  });

  test('a file with a bad value keeps the rest and defaults that one', async () => {
    const folder = await temp();
    await writeFile(join(folder, 'settings.json'), JSON.stringify({ name: 'Ana', dateStyle: 'sideways' }));
    expect((await SettingsStore.open(folder)).get()).toEqual({ ...DEFAULT_SETTINGS, name: 'Ana' });
  });

  // Each repo's choices (#151), by T3 project id: whether it's served, who merges, and whether
  // its "New" mark has been seen. A change made from what's saved when its turn comes.
  test("a repo's choices survive a restart, and a bad entry is dropped alone", async () => {
    const folder = await temp();
    const store = await SettingsStore.open(folder);
    await store.update((s) => ({ repos: { ...s.repos, p1: { served: true, merge: 'runner', seen: true } } }));
    await store.update((s) => ({ repos: { ...s.repos, p2: { served: false, merge: 'me', seen: false } } }));
    expect((await SettingsStore.open(folder)).get().repos).toEqual({
      p1: { served: true, merge: 'runner', seen: true }, p2: { served: false, merge: 'me', seen: false },
    });
    await writeFile(join(folder, 'settings.json'), JSON.stringify({ repos: { p1: { served: true, merge: 'runner', seen: true }, p2: { merge: 'sideways' } } }));
    expect((await SettingsStore.open(folder)).get().repos).toEqual({ p1: { served: true, merge: 'runner', seen: true } });
  });

  test('a change with a bad repo entry is refused whole, not trimmed', async () => {
    const store = await SettingsStore.open(await temp());
    await store.update(() => ({ repos: { p1: { served: true, merge: 'runner', seen: true } } }));
    await expect(store.update((s) => ({ repos: { ...s.repos, p2: { served: 'yes', merge: 'me', seen: true } as never } }))).rejects.toThrow(SettingsError);
    expect(store.get().repos).toEqual({ p1: { served: true, merge: 'runner', seen: true } });
  });
});

// The settings the window edits: kept in the state folder, saved the moment they change, and read
// back on the next start. Only the state folder's location is in a machine file (#36, Fixed).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
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
    expect(DEFAULT_SETTINGS).toEqual({ name: null, dateStyle: 'month-first', startWithWindows: true });
  });

  test('a change is saved at once and survives a restart', async () => {
    const folder = await temp();
    const store = await SettingsStore.open(folder);
    await store.set({ name: 'Ana' });
    await store.set({ dateStyle: 'iso' });
    await store.set({ startWithWindows: false });
    const again = await SettingsStore.open(folder);
    expect(again.get()).toEqual({ name: 'Ana', dateStyle: 'iso', startWithWindows: false });
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

  test('a file with a bad value keeps the rest and defaults that one', async () => {
    const folder = await temp();
    await writeFile(join(folder, 'settings.json'), JSON.stringify({ name: 'Ana', dateStyle: 'sideways' }));
    expect((await SettingsStore.open(folder)).get()).toEqual({ ...DEFAULT_SETTINGS, name: 'Ana' });
  });
});

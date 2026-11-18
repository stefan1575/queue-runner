// What the window shows (#150): the settings, the `gh` account the name comes from, and T3's Time
// format, kept up to date as any of them changes.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { briefName, RunnerView, type TimeFormatSource, type View } from '../src/desktop/view.ts';
import type { TimeFormat } from '../src/display.ts';
import { GhGitHub, GitHubError, type Gh } from '../src/github.ts';
import type { ProviderUsage } from '../src/usage.ts';
import type { Catalog } from '../src/jobs.ts';
import { SettingsStore } from '../src/settings.ts';
import type { CatalogSource, CatalogState } from '../src/t3/catalog-source.ts';

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});
async function store() {
  const d = await mkdtemp(join(tmpdir(), 'qr-view-'));
  dirs.push(d);
  return SettingsStore.open(d);
}

class FakeTimeFormat implements TimeFormatSource {
  format: TimeFormat = 'locale';
  private listeners = new Set<(f: TimeFormat) => void>();
  current() { return this.format; }
  onChange(l: (f: TimeFormat) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  /** T3's Time format changed. */
  change(f: TimeFormat) { this.format = f; for (const l of this.listeners) l(f); }
}

class FakeCatalog implements CatalogSource {
  state: CatalogState = { catalog: null, usage: [] };
  private listeners = new Set<(s: CatalogState) => void>();
  current() { return this.state; }
  onChange(l: (s: CatalogState) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  change(s: CatalogState) { this.state = s; for (const l of this.listeners) l(s); }
}

const account = (login: string, name: string | null) => ({ account: async () => ({ login, name }) });

describe("the gh account's name", () => {
  test('gh api user gives the login and the name', async () => {
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify({ login: 'ana-k', name: 'Ana K', id: 1 }), stderr: '' };
    };
    expect(await new GhGitHub(gh).account()).toEqual({ login: 'ana-k', name: 'Ana K' });
    expect(calls).toEqual([['api', 'user']]);
  });

  test('an account with no name set has a null name', async () => {
    const gh: Gh = async () => ({ code: 0, stdout: JSON.stringify({ login: 'ana-k', name: null }), stderr: '' });
    expect(await new GhGitHub(gh).account()).toEqual({ login: 'ana-k', name: null });
  });

  test('gh not signed in is a GitHubError with what gh said', async () => {
    const gh: Gh = async () => ({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' });
    await expect(new GhGitHub(gh).account()).rejects.toThrow(GitHubError);
    await expect(new GhGitHub(gh).account()).rejects.toThrow(/gh api user failed \(4\): To get started/);
  });
});

describe('the view', () => {
  test('the name for the briefs is yours, else the account name, else its login', async () => {
    const view = await RunnerView.start(await store(), account('ana-k', 'Ana K'), new FakeTimeFormat(), new FakeCatalog());
    expect(briefName(view.get())).toBe('Ana K');
    await view.set({ name: 'Ana' });
    expect(briefName(view.get())).toBe('Ana');
    const noName = await RunnerView.start(await store(), account('ana-k', null), new FakeTimeFormat(), new FakeCatalog());
    expect(briefName(noName.get())).toBe('ana-k');
  });

  test("gh failing leaves the name yours to type, and says why", async () => {
    const failing = { account: async () => { throw new GitHubError('gh api user failed (4): not signed in'); } };
    const view = await RunnerView.start(await store(), failing, new FakeTimeFormat(), new FakeCatalog());
    expect(view.get().account).toBeNull();
    expect(view.get().accountError).toBe('gh api user failed (4): not signed in');
    expect(briefName(view.get())).toBeNull();
  });

  test("the clock follows T3's Time format, and a change in T3 changes the window's", async () => {
    const t3 = new FakeTimeFormat();
    t3.format = '24-hour';
    const view = await RunnerView.start(await store(), account('ana-k', null), t3, new FakeCatalog());
    expect(view.get().timeFormat).toBe('24-hour');
    const seen: View[] = [];
    view.onChange((v) => seen.push(v));
    t3.change('12-hour');
    expect(view.get().timeFormat).toBe('12-hour');
    expect(seen.map((v) => v.timeFormat)).toEqual(['12-hour']);
  });

  test('a saved change reaches the window', async () => {
    const view = await RunnerView.start(await store(), account('ana-k', null), new FakeTimeFormat(), new FakeCatalog());
    const seen: View[] = [];
    view.onChange((v) => seen.push(v));
    await view.set({ dateStyle: 'iso' });
    expect(seen.map((v) => v.settings.dateStyle)).toEqual(['iso']);
  });

  test("T3's catalog and usage reach the window, and so does why T3 can't be asked, until it can", async () => {
    const t3 = new FakeCatalog();
    const view = await RunnerView.start(await store(), account('ana-k', null), new FakeTimeFormat(), t3);
    expect(view.get().catalog).toBeNull();
    expect(view.get().usage).toEqual([]);
    const catalog: Catalog = { providers: [{ id: 'p', label: 'P', models: [] }], t3Default: null };
    const usage: ProviderUsage[] = [{ provider: 'p', driver: 'p', account: 'p:p', label: 'P', name: 'P', checkedAt: null, windows: [], resetCredits: null, unavailable: 'unsupported' }];
    t3.change({ catalog, usage });
    expect(view.get()).toMatchObject({ catalog, usage });
    t3.change({ catalog, usage, error: 'T3 is down' });
    expect(view.get()).toMatchObject({ catalog, catalogError: 'T3 is down' });
    t3.change({ catalog, usage });
    expect(view.get()).not.toHaveProperty('catalogError');
  });
});

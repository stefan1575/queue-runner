// What the window shows (#150): the settings, the `gh` account the name comes from, and T3's Time
// format, kept up to date as any of them changes.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { briefName, RunnerView, type RepoSource, type TimeFormatSource, type View } from '../src/desktop/view.ts';
import { NotEmpty, RepoError, type Repo } from '../src/repos.ts';
import { SettingsError } from '../src/settings.ts';
import type { TimeFormat } from '../src/display.ts';
import { GhGitHub, GitHubError, type Gh } from '../src/github.ts';
import { SettingsStore } from '../src/settings.ts';

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

/** Repositories, faked: a list, and a refusal for each thing asked. */
class FakeRepos implements RepoSource {
  repos: Repo[] | null = null;
  why: string | null = null;
  asked: unknown[] = [];
  refuse: Error | null = null;
  private listeners = new Set<() => void>();
  list() { return this.repos; }
  error() { return this.why; }
  onChange(l: () => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  change(repos: Repo[] | null, why: string | null = null) { this.repos = repos; this.why = why; for (const l of this.listeners) l(); }
  private async ask(...a: unknown[]) { this.asked.push(a); if (this.refuse) throw this.refuse; }
  setServed(id: string, on: boolean) { return this.ask('serve', id, on); }
  setMerge(id: string, merge: string) { return this.ask('merge', id, merge); }
  seen(ids: string[]) { return this.ask('seen', ids); }
  check() { return this.ask('check'); }
  async add() { await this.ask('add'); return 'C:/blog'; }
  remove(id: string, withThreads?: boolean) { return this.ask('remove', id, withThreads); }
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
    const view = await RunnerView.start(await store(), account('ana-k', 'Ana K'), new FakeTimeFormat(), new FakeRepos());
    expect(briefName(view.get())).toBe('Ana K');
    await view.set({ name: 'Ana' });
    expect(briefName(view.get())).toBe('Ana');
    const noName = await RunnerView.start(await store(), account('ana-k', null), new FakeTimeFormat(), new FakeRepos());
    expect(briefName(noName.get())).toBe('ana-k');
  });

  test("gh failing leaves the name yours to type, and says why", async () => {
    const failing = { account: async () => { throw new GitHubError('gh api user failed (4): not signed in'); } };
    const view = await RunnerView.start(await store(), failing, new FakeTimeFormat(), new FakeRepos());
    expect(view.get().account).toBeNull();
    expect(view.get().accountError).toBe('gh api user failed (4): not signed in');
    expect(briefName(view.get())).toBeNull();
  });

  test("the clock follows T3's Time format, and a change in T3 changes the window's", async () => {
    const t3 = new FakeTimeFormat();
    t3.format = '24-hour';
    const view = await RunnerView.start(await store(), account('ana-k', null), t3, new FakeRepos());
    expect(view.get().timeFormat).toBe('24-hour');
    const seen: View[] = [];
    view.onChange((v) => seen.push(v));
    t3.change('12-hour');
    expect(view.get().timeFormat).toBe('12-hour');
    expect(seen.map((v) => v.timeFormat)).toEqual(['12-hour']);
  });

  test('a saved change reaches the window', async () => {
    const view = await RunnerView.start(await store(), account('ana-k', null), new FakeTimeFormat(), new FakeRepos());
    const seen: View[] = [];
    view.onChange((v) => seen.push(v));
    await view.set({ dateStyle: 'iso' });
    expect(seen.map((v) => v.settings.dateStyle)).toEqual(['iso']);
  });
});

describe('repositories in the view', () => {
  const repo: Repo = { id: 'p1', title: 'sandbox', folder: 'C:/sandbox', github: 'ana/sandbox', checking: false, served: false, merge: 'me', isNew: true };

  test("the view holds T3's projects and why they can't be had, kept up to date", async () => {
    const repos = new FakeRepos();
    const view = await RunnerView.start(await store(), account('ana-k', null), new FakeTimeFormat(), repos);
    expect(view.get()).toMatchObject({ repos: null, reposError: null });
    const seen: View[] = [];
    view.onChange((v) => seen.push(v));
    repos.change([repo]);
    repos.change([repo], "T3's server isn't running");
    expect(seen.map((v) => [v.repos?.length, v.reposError])).toEqual([[1, null], [1, "T3's server isn't running"]]);
  });

  test('what the window asks reaches Repositories, and a refusal comes back as words', async () => {
    const repos = new FakeRepos();
    const view = await RunnerView.start(await store(), account('ana-k', null), new FakeTimeFormat(), repos);
    expect(await view.repo({ do: 'add' })).toEqual({ added: 'C:/blog' });
    expect(await view.repo({ do: 'serve', id: 'p1', on: true })).toEqual({});
    expect(await view.repo({ do: 'merge', id: 'p1', merge: 'runner' })).toEqual({});
    expect(await view.repo({ do: 'seen', ids: ['p1'] })).toEqual({});
    expect(await view.repo({ do: 'check' })).toEqual({});
    expect(repos.asked).toEqual([['add'], ['serve', 'p1', true], ['merge', 'p1', 'runner'], ['seen', ['p1']], ['check']]);
    repos.refuse = new RepoError('sandbox has no GitHub remote');
    expect(await view.repo({ do: 'serve', id: 'p1', on: true })).toEqual({ error: 'sandbox has no GitHub remote' });
    repos.refuse = new NotEmpty('sandbox still has threads in T3.');
    expect(await view.repo({ do: 'remove', id: 'p1' })).toEqual({ error: 'sandbox still has threads in T3.', notEmpty: true });
  });

  test('an action with a field of the wrong kind is refused before Repositories hears of it', async () => {
    const repos = new FakeRepos();
    const view = await RunnerView.start(await store(), account('ana-k', null), new FakeTimeFormat(), repos);
    const bad = [
      { do: 'serve', id: 'p1', on: 'yes' }, { do: 'serve', on: true }, { do: 'merge', id: 'p1', merge: 'sideways' },
      { do: 'seen', ids: 'p1' }, { do: 'remove', id: 7 }, { do: 'remove', id: 'p1', withThreads: 'please' }, { do: 'explode' }, null,
    ];
    for (const a of bad) expect((await view.repo(a as never)).error).toMatch(/something unknown/);
    expect(repos.asked).toEqual([]);
  });

  test("a repo's choices can't be saved as a plain setting, past what switching one on does", async () => {
    const view = await RunnerView.start(await store(), account('ana-k', null), new FakeTimeFormat(), new FakeRepos());
    await expect(view.set({ repos: { p1: { served: true, merge: 'runner', seen: true } } })).rejects.toThrow(SettingsError);
  });
});

// Repositories (#151): the runner's repos are T3's projects, kept in step both ways from T3's
// events, each switched on before the runner touches it. The fake T3 behind the real MCP and
// WebSocket clients, GitHub faked, settings in a temp folder.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhGitHub, GitHubError, type GitHub, type GitHubLabels, type Label } from '../src/github.ts';
import { NotEmpty, RepoError, Repositories, RUNNER_LABELS } from '../src/repos.ts';
import { SettingsStore } from '../src/settings.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { T3ProjectFeed } from '../src/t3/project-feed.ts';
import { runtimeAddress } from '../src/t3/real.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { FakeT3 } from './fake-t3.ts';

/** GitHub: each folder's remote, and each repo's labels. */
class FakeGitHub implements GitHub, GitHubLabels {
  remotes: Record<string, string> = {};
  labels: Record<string, string[]> = {};
  created: { repo: string; label: Label }[] = [];
  failLabels = false;
  /** gh failing on remotes, as when it isn't signed in. */
  failRemotes = false;
  remoteReads = 0;
  async remoteOf(folder: string) {
    this.remoteReads++;
    if (this.failRemotes) throw new GitHubError('gh repo view failed (4): not signed in');
    const r = this.remotes[folder];
    return r ? { nameWithOwner: r, url: `https://github.com/${r}` } : null;
  }
  async labelNames(repo: string) {
    if (this.failLabels) throw new GitHubError('gh label list failed (4): not signed in');
    return [...(this.labels[repo] ?? [])];
  }
  async createLabel(repo: string, label: Label) {
    this.created.push({ repo, label });
    (this.labels[repo] ??= []).push(label.name);
  }
}

let dir: string;
let t3: FakeT3;
let github: FakeGitHub;
let picked: string | null;
let stops: (() => void)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-repos-'));
  t3 = new FakeT3();
  t3.projects = [
    { id: 'p1', title: 'sandbox', workspaceRoot: 'C:/sandbox' },
    { id: 'p2', title: 'notes', workspaceRoot: 'C:/notes' },
  ];
  github = new FakeGitHub();
  github.remotes = { 'C:/sandbox': 'ana/sandbox', 'C:/blog': 'ana/blog' };
  picked = null;
  await writeFile(join(dir, 'server-runtime.json'), JSON.stringify({ origin: t3.origin }));
});
afterEach(async () => {
  for (const s of stops) s();
  stops = [];
  await rm(dir, { recursive: true, force: true });
});

async function start(state = join(dir, 'state')) {
  const address = runtimeAddress(join(dir, 'server-runtime.json'));
  const feed = T3ProjectFeed.start(new T3Ws(address, t3.cli, t3.http, t3.connect), () => () => {});
  stops.push(() => feed.stop());
  const settings = await SettingsStore.open(state);
  const repos = Repositories.start({
    feed, github, settings, mcp: new T3Mcp(address, t3.cli, t3.http), pickFolder: async () => picked,
  });
  // T3 has answered, every remote is read and the choices are saved, or T3 said why not
  await vi.waitFor(() => expect(repos.error() !== null
    || (repos.list()?.every((r) => !r.checking) && Object.keys(settings.get().repos ?? {}).length === t3.projects.length)).toBe(true));
  return { repos, settings };
}
const row = (repos: Repositories, id: string) => repos.list()?.find((r) => r.id === id);
const t3Calls = () => t3.toolCalls.filter((c) => c.tool !== 't3_project_list');

describe('in step with T3', () => {
  test('on a new install every project arrives off, with "I merge", and none is marked New', async () => {
    const { repos } = await start();
    expect(repos.list()).toEqual([
      { id: 'p1', title: 'sandbox', folder: 'C:/sandbox', github: 'ana/sandbox', checking: false, served: false, merge: 'me', isNew: false },
      { id: 'p2', title: 'notes', folder: 'C:/notes', github: null, checking: false, served: false, merge: 'me', isNew: false },
    ]);
  });

  test('a project added in T3 appears switched off and New; one removed in T3 disappears', async () => {
    const { repos, settings } = await start();
    t3.addProject({ id: 'p3', title: 'blog', workspaceRoot: 'C:/blog' });
    await vi.waitFor(() => expect(row(repos, 'p3')).toMatchObject({ github: 'ana/blog', served: false, merge: 'me', isNew: true }));
    t3.removeProject('p1');
    await vi.waitFor(() => expect(Object.keys(settings.get().repos ?? {})).toEqual(['p2', 'p3']));
    expect(repos.list()?.map((r) => r.id)).toEqual(['p2', 'p3']);
  });

  test('a New mark goes once it has been looked at, and stays gone after a restart', async () => {
    const { repos } = await start();
    t3.addProject({ id: 'p3', title: 'blog', workspaceRoot: 'C:/blog' });
    await vi.waitFor(() => expect(row(repos, 'p3')?.isNew).toBe(true));
    await repos.seen(['p3']);
    expect(row(repos, 'p3')?.isNew).toBe(false);
    stops.forEach((s) => s());
    const again = await start();
    expect(row(again.repos, 'p3')?.isNew).toBe(false);
  });

  test("T3 down shows no list and says why", async () => {
    await rm(join(dir, 'server-runtime.json'));
    const { repos } = await start();
    expect(repos.list()).toBeNull();
    expect(repos.error()).toMatch(/T3's server isn't running/);
  });
});

describe('adding and removing here', () => {
  test("adding a folder creates a T3 project from it, which arrives off and isn't marked New", async () => {
    const { repos } = await start();
    picked = 'C:/blog';
    expect(await repos.add()).toBe('C:/blog');
    await vi.waitFor(() => expect(repos.list()?.find((r) => r.folder === 'C:/blog')?.checking).toBe(false));
    expect(t3Calls()).toEqual([{ tool: 't3_project_create', args: { title: 'blog', workspaceRoot: 'C:/blog' } }]);
    const added = repos.list()?.find((r) => r.folder === 'C:/blog');
    expect(added).toMatchObject({ title: 'blog', github: 'ana/blog', served: false, merge: 'me', isNew: false });
  });

  test('a folder picker closed with no folder adds nothing', async () => {
    const { repos } = await start();
    expect(await repos.add()).toBeNull();
    expect(t3Calls()).toEqual([]);
  });

  test("a folder that's already a T3 project is refused with T3's reason", async () => {
    const { repos } = await start();
    picked = 'C:/sandbox';
    await expect(repos.add()).rejects.toThrow(/already registered/);
  });

  test('removing removes only the T3 project: no thread, folder or GitHub call besides', async () => {
    const { repos } = await start();
    const ghBefore = github.created.length;
    await repos.remove('p1');
    await vi.waitFor(() => expect(row(repos, 'p1')).toBeUndefined());
    expect(t3Calls()).toEqual([{ tool: 't3_project_delete', args: { projectId: 'p1' } }]);
    expect(repos.list()?.map((r) => r.id)).toEqual(['p2']);
    expect(github.created.length).toBe(ghBefore);
  });

  test("a project with threads isn't removed until you say its threads go too", async () => {
    t3.threads.p1 = 3;
    const { repos } = await start();
    await expect(repos.remove('p1')).rejects.toThrow(NotEmpty);
    expect(row(repos, 'p1')).toBeDefined();
    await repos.remove('p1', true);
    await vi.waitFor(() => expect(row(repos, 'p1')).toBeUndefined());
    expect(t3Calls().at(-1)).toEqual({ tool: 't3_project_delete', args: { projectId: 'p1', force: true } });
    expect(row(repos, 'p1')).toBeUndefined();
  });
});

describe('served', () => {
  test("a project with no GitHub remote can't be switched on, and says why", async () => {
    const { repos, settings } = await start();
    await expect(repos.setServed('p2', true)).rejects.toThrow(RepoError);
    await expect(repos.setServed('p2', true)).rejects.toThrow(/no GitHub remote/);
    expect(row(repos, 'p2')?.served).toBe(false);
    expect(settings.get().repos?.p2?.served).toBe(false);
  });

  test("switching on creates the runner's labels where they're missing, and nothing else", async () => {
    github.labels['ana/sandbox'] = ['bug', 'needs-info'];
    const { repos } = await start();
    await repos.setServed('p1', true);
    expect(github.created.map((c) => [c.repo, c.label.name])).toEqual([
      ['ana/sandbox', 'ready-for-agent'], ['ana/sandbox', 'ready-to-merge'],
    ]);
    expect(row(repos, 'p1')?.served).toBe(true);
    expect(RUNNER_LABELS.map((l) => l.name)).toEqual(['ready-for-agent', 'needs-info', 'ready-to-merge']);
  });

  test('labels are made only on switching on: not when all are there, not on off, not on who merges', async () => {
    github.labels['ana/sandbox'] = ['ready-for-agent', 'needs-info', 'ready-to-merge'];
    const { repos } = await start();
    await repos.setServed('p1', true);
    await repos.setMerge('p1', 'runner');
    await repos.setServed('p1', false);
    expect(github.created).toEqual([]);
  });

  test("gh failing on the labels leaves the repo off and says why", async () => {
    github.failLabels = true;
    const { repos } = await start();
    await expect(repos.setServed('p1', true)).rejects.toThrow(/gh label list failed/);
    expect(row(repos, 'p1')?.served).toBe(false);
  });
});

describe('a GitHub remote read again', () => {
  test("gh failing at the start doesn't stick: the next T3 event reads it again, and a served repo is served once it can be read", async () => {
    const state = join(dir, 'state');
    const first = await start(state);
    await first.repos.setServed('p1', true);
    stops.forEach((s) => s());
    stops = [];
    github.failRemotes = true;
    const { repos } = await start(state);
    expect(row(repos, 'p1')).toMatchObject({ github: null, served: false, remoteError: expect.stringMatching(/not signed in/) });
    github.failRemotes = false;
    t3.addProject({ id: 'p3', title: 'blog', workspaceRoot: 'C:/blog' });
    await vi.waitFor(() => expect(row(repos, 'p1')).toMatchObject({ github: 'ana/sandbox', served: true }));
    expect(row(repos, 'p1')?.remoteError).toBeUndefined();
  });

  test('a folder that gains a GitHub remote after the start shows it once the remotes are checked again', async () => {
    const { repos } = await start();
    expect(row(repos, 'p2')?.github).toBeNull();
    github.remotes['C:/notes'] = 'ana/notes';
    await repos.check();
    expect(row(repos, 'p2')).toMatchObject({ github: 'ana/notes', checking: false });
    await repos.setServed('p2', true);
    expect(row(repos, 'p2')?.served).toBe(true);
  });

  test('a remote that goes is gone after the next check, and the repo shows as not served', async () => {
    const { repos } = await start();
    await repos.setServed('p1', true);
    delete github.remotes['C:/sandbox'];
    await repos.check();
    expect(row(repos, 'p1')).toMatchObject({ github: null, served: false });
  });

  test('reading again keeps what was last known on show, rather than going back to checking', async () => {
    const { repos } = await start();
    const waiting: (() => void)[] = [];
    const read = github.remoteOf.bind(github);
    github.remoteOf = async (folder) => { await new Promise<void>((r) => waiting.push(r)); return read(folder); };
    const checked = repos.check();
    expect(row(repos, 'p1')).toMatchObject({ github: 'ana/sandbox', checking: false });
    await vi.waitFor(() => expect(waiting.length).toBe(2));
    waiting.forEach((r) => r());
    await checked;
  });
});

describe('who merges', () => {
  test('defaults to "I merge" and a change survives a restart', async () => {
    const state = join(dir, 'state');
    const { repos } = await start(state);
    expect(row(repos, 'p1')?.merge).toBe('me');
    await repos.setServed('p1', true);
    await repos.setMerge('p1', 'runner');
    stops.forEach((s) => s());
    const again = await start(state);
    expect(row(again.repos, 'p1')).toMatchObject({ served: true, merge: 'runner' });
  });
});

describe('labels through gh', () => {
  test('lists and creates with gh, and a label made meanwhile is left as it is', async () => {
    const calls: string[][] = [];
    const gh = new GhGitHub(async (args) => {
      calls.push(args);
      if (args[1] === 'list') return { code: 0, stdout: '[{"name":"bug"}]', stderr: '' };
      return { code: 1, stdout: '', stderr: 'label with name "needs-info" already exists; use `--force` to update its color and description\n' };
    });
    expect(await gh.labelNames('ana/sandbox')).toEqual(['bug']);
    await gh.createLabel('ana/sandbox', RUNNER_LABELS[1]!);
    expect(calls).toEqual([
      ['label', 'list', '--repo', 'ana/sandbox', '--json', 'name', '--limit', '1000'],
      ['label', 'create', 'needs-info', '--repo', 'ana/sandbox', '--color', RUNNER_LABELS[1]!.color, '--description', RUNNER_LABELS[1]!.description],
    ]);
  });
});

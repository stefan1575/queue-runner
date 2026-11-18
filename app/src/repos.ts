// Repositories (#151; #68 stories 21 to 23 and 25): the runner's repos are T3's projects, kept in
// step both ways. A project added or removed in T3 shows up or goes here, from T3's events; one
// added here is a folder picked on this PC, made a T3 project; one removed here asks first and
// removes the T3 project only, never the folder and never anything on GitHub. Each is switched on
// (Served) before the runner touches it; switching one on creates the runner's labels where
// they're missing. The base branch is GitHub's default and the folder is the T3 project's:
// neither is a setting.
import { win32 } from 'node:path';
import { GitHubError, type GitHub, type GitHubLabels, type Label } from './github.ts';
import type { Merger, RepoChoice, SettingsStore } from './settings.ts';
import type { T3Mcp } from './t3/mcp.ts';
import type { ProjectFeed, T3Project } from './t3/project-feed.ts';

/** A repo as the window shows it. */
export type Repo = {
  id: string;
  title: string;
  folder: string;
  /** `owner/name` on GitHub, or null when the folder has none (or gh couldn't say: `remoteError`). */
  github: string | null;
  remoteError?: string;
  /** Its GitHub remote is still being read. */
  checking: boolean;
  served: boolean;
  merge: Merger;
  /** New from T3, not yet looked at. */
  isNew: boolean;
};

/** The labels the runner works with, created when a repo is switched on. */
export const RUNNER_LABELS: Label[] = [
  { name: 'ready-for-agent', color: '0e8a16', description: 'Ready for the runner to build' },
  { name: 'needs-info', color: 'd876e3', description: 'Waiting on you for more information' },
  { name: 'ready-to-merge', color: '1d76db', description: 'A clean PR, ready to merge' },
];

/** Something a repo can't do, said as the window shows it. */
export class RepoError extends Error {}

/** T3 keeps a project that still has threads unless they go too. */
export class NotEmpty extends RepoError {}

const OFF: RepoChoice = { served: false, merge: 'me', seen: true };
const same = (a: string, b: string) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

type Remote = { github: string | null; error?: string } | 'checking';

export class Repositories {
  private feed: ProjectFeed;
  private github: GitHub & GitHubLabels;
  private settings: SettingsStore;
  private mcp: Pick<T3Mcp, 'call'>;
  private pickFolder: () => Promise<string | null>;
  private remotes = new Map<string, Remote>();
  /** Folders added here, whose projects aren't New when T3 tells of them. */
  private addedHere: string[] = [];
  private listeners = new Set<() => void>();

  private constructor(o: RepositoriesDoors) {
    this.feed = o.feed;
    this.github = o.github;
    this.settings = o.settings;
    this.mcp = o.mcp;
    this.pickFolder = o.pickFolder;
  }

  static start(o: RepositoriesDoors): Repositories {
    const repos = new Repositories(o);
    o.feed.onChange(() => repos.sync());
    o.settings.onChange(() => repos.tell());
    repos.sync();
    return repos;
  }

  /** Every T3 project with its choices, or null until T3 has first answered. */
  list(): Repo[] | null {
    const projects = this.feed.current();
    if (!projects) return null;
    const saved = this.settings.get().repos ?? {};
    return projects.map((p) => {
      const choice = saved[p.id] ?? OFF;
      const remote = this.remotes.get(p.folder) ?? 'checking';
      const known = remote === 'checking' ? { github: null } : remote;
      return {
        id: p.id, title: p.title, folder: p.folder, github: known.github,
        ...(known.error ? { remoteError: known.error } : {}),
        checking: remote === 'checking',
        served: choice.served && known.github !== null, merge: choice.merge, isNew: !choice.seen,
      };
    });
  }

  /** Why T3's projects can't be had (T3 not running, refused), or null. */
  error(): string | null {
    return this.feed.error();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Switches a repo on or off. On needs a GitHub remote, read again now, and creates the
   *  runner's labels where they're missing first: a label gh can't make leaves it off. */
  async setServed(id: string, served: boolean): Promise<void> {
    const p = this.project(id);
    if (served) {
      const remote = await this.readRemote(p.folder);
      if (remote.error) throw new RepoError(`${p.title}: GitHub couldn't be read (${remote.error})`);
      if (!remote.github) throw new RepoError(`${p.title} has no GitHub remote, so the runner can't serve it`);
      const there = new Set(await this.github.labelNames(remote.github));
      for (const label of RUNNER_LABELS) {
        if (!there.has(label.name)) await this.github.createLabel(remote.github, label);
      }
    }
    await this.choose(id, { served });
  }

  async setMerge(id: string, merge: Merger): Promise<void> {
    this.project(id);
    await this.choose(id, { merge });
  }

  /** These repos' New marks have been looked at. */
  async seen(ids: string[]): Promise<void> {
    const saved = this.settings.get().repos ?? {};
    if (!ids.some((id) => saved[id] && !saved[id].seen)) return;
    await this.settings.update((s) => {
      const repos = { ...s.repos };
      for (const id of ids) if (repos[id]) repos[id] = { ...repos[id], seen: true };
      return { repos };
    });
  }

  /** Opens the folder picker and makes the folder a T3 project, named after the folder. It
   *  arrives through T3's events, off. Returns the folder, or null when none was picked. */
  async add(): Promise<string | null> {
    const folder = await this.pickFolder();
    if (!folder) return null;
    this.addedHere.push(folder);
    try {
      await this.mcp.call('t3_project_create', { title: win32.basename(folder), workspaceRoot: folder });
    } catch (e) {
      this.addedHere = this.addedHere.filter((f) => f !== folder);
      throw e;
    }
    return folder;
  }

  /** Removes the T3 project, nothing else: not the folder, not anything on GitHub. A project
   *  with threads is a NotEmpty unless `withThreads` says they go too. */
  async remove(id: string, withThreads = false): Promise<void> {
    const p = this.project(id);
    try {
      await this.mcp.call('t3_project_delete', withThreads ? { projectId: id, force: true } : { projectId: id });
    } catch (e) {
      if (!withThreads && /is not empty/.test((e as Error).message)) {
        throw new NotEmpty(`${p.title} still has threads in T3. Removing it deletes them too.`);
      }
      throw e;
    }
  }

  private project(id: string): T3Project {
    const p = this.feed.current()?.find((x) => x.id === id);
    if (!p) throw new RepoError(`T3 has no project ${id}`);
    return p;
  }

  private async choose(id: string, change: Partial<RepoChoice>) {
    await this.settings.update((s) => ({ repos: { ...s.repos, [id]: { ...(s.repos?.[id] ?? OFF), ...change } } }));
  }

  /** Keeps the saved choices in step with T3's projects (a new one arrives off, and New unless
   *  added here or seen on a new install; a removed one's choices go), and reads new folders'
   *  remotes. */
  private sync() {
    const projects = this.feed.current();
    this.tell();
    if (!projects) return;
    const reconcile = (repos: Record<string, RepoChoice> | null) => {
      const next: Record<string, RepoChoice> = {};
      let changed = repos === null;
      for (const p of projects) {
        const had = repos?.[p.id];
        if (had) { next[p.id] = had; continue; }
        changed = true;
        next[p.id] = { ...OFF, seen: repos === null || this.addedHere.some((f) => same(f, p.folder)) };
      }
      if (Object.keys(repos ?? {}).length !== projects.length) changed = true;
      return changed ? next : null;
    };
    if (reconcile(this.settings.get().repos) !== null) {
      // worked out again when its write comes, from what's saved then
      void this.settings.update((s) => {
        const next = reconcile(s.repos);
        return next ? { repos: next } : {};
      }).then(() => {
        this.addedHere = this.addedHere.filter((f) => !projects.some((p) => same(f, p.folder)));
      }, () => {});
    }
    for (const p of projects) {
      if (!this.remotes.has(p.folder)) void this.readRemote(p.folder);
    }
  }

  private async readRemote(folder: string): Promise<{ github: string | null; error?: string }> {
    if (!this.remotes.has(folder)) this.remotes.set(folder, 'checking');
    let got: { github: string | null; error?: string };
    try {
      got = { github: (await this.github.remoteOf(folder))?.nameWithOwner ?? null };
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      got = { github: null, error: e.message };
    }
    this.remotes.set(folder, got);
    this.tell();
    return got;
  }

  private tell() {
    for (const l of this.listeners) l();
  }
}

export type RepositoriesDoors = {
  feed: ProjectFeed;
  github: GitHub & GitHubLabels;
  settings: SettingsStore;
  mcp: Pick<T3Mcp, 'call'>;
  /** Windows' folder picker: the folder chosen, or null when it was closed. */
  pickFolder: () => Promise<string | null>;
};

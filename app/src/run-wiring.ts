// The run loop as the app wires it (#219): Python's `Config` and `Repo` from the app's Settings and
// T3's projects, the projects served at start as Python reads config.toml (a repo that can't be
// read joins once it reads), and the ported seams with the
// app's usage gate around them. The desktop app (`src/desktop/electron.ts`) runs it continuously;
// the command line (`src/app.ts`) runs one pass (`--once`) or releases a held issue (`--release`).
// A Settings or Repositories change while the loop runs is taken up at the app's next start.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { CostLog } from './cost-log.ts';
import { GitCli } from './git-seam.ts';
import { GitHubError, type GitHub as AppGitHub, type GitHubWork, type Remote } from './github.ts';
import { GhCli } from './github-seam.ts';
import { kindModels, model } from './jobs.ts';
import { listProjects } from './projects.ts';
import { Runner, wall_sleep, type Config, type Repo } from './run.ts';
import type { Merger, RepoChoice, Settings } from './settings.ts';
import { JobLog } from './state.ts';
import type { CatalogSource } from './t3/catalog-source.ts';
import type { T3Mcp } from './t3/mcp.ts';
import { T3Server } from './t3-seam.ts';
import { UsageGate } from './usage-gate.ts';

/** Python's `config.poll_seconds` default: the pause after an idle pass. */
export const POLL_SECONDS = 300;
/** Reading T3's projects, and a served repo that hasn't read, in the desktop app: how often to
 *  try again (Python's `T3_RETRY`, its wait for T3's server at logon). */
export const CONFIG_RETRY = 30;

/** The run loop's job log in the state folder, in Python's format (`src/state.ts`). Its own file:
 *  the desktop app's `jobs.jsonl` from before the port is `src/job-log.ts`'s format (a job's repo
 *  named by T3 project id, its thread in a record of its own), which this log can't read, so it's
 *  left in place, unread. */
export const JOB_LOG = 'run-loop-jobs.jsonl';

/** A served project that hasn't read yet: its T3 project, who merges it, why it hasn't read (said
 *  once, and again only when that changes) and its GitHub `owner/name` once that's known (its base
 *  branch is what failed), else null. */
export type Unread = { id: string; title: string; folder: string; merge: Merger; name: string | null; reason: string };

/** A served project's GitHub remote as T3's listing read it: the remote, null (none), or why gh
 *  couldn't say. */
type RemoteRead = { remote: Remote | null; failure?: string };

/** The served repos as Python's config.toml names them: each T3 project Settings switched to
 *  Served, with a GitHub remote, named by its GitHub `owner/name`, in its folder, on its base (its
 *  default branch on GitHub, read now) and merged by whom Settings says, in T3's order of projects
 *  (which breaks a tie between repos' work, as config.toml's order does). A remote two served
 *  projects share is served from the first, and the others are said.
 *
 *  Repos are independent, as in Python, whose config needs no network: a served project whose
 *  folder is missing, whose remote gh can't read (or that has none) or whose base can't be read is
 *  named in one line and kept in `unread`, and `retry` reads it again; the others are `repos`.
 *  Only the projects served at start are read: a Settings change while the loop runs is #260's. */
export class ServedRepos {
  /** The repos read, in T3's order at start and then in the order they read. */
  readonly repos: Repo[] = [];
  readonly unread = new Map<string, Unread>();
  private github: AppGitHub & Pick<GitHubWork, 'defaultBranch'>;
  private exists: (folder: string) => boolean;
  private say: (line: string) => void;

  constructor(github: AppGitHub & Pick<GitHubWork, 'defaultBranch'>, say: (line: string) => void,
    exists: (folder: string) => boolean = existsSync) {
    this.github = github;
    this.say = say;
    this.exists = exists;
  }

  /** T3's projects, and each served one read. T3's list failing throws: no repo is read then. */
  static async read(mcp: Pick<T3Mcp, 'call'>, github: AppGitHub & Pick<GitHubWork, 'defaultBranch'>,
    saved: Record<string, RepoChoice> | null, say: (line: string) => void,
    exists: (folder: string) => boolean = existsSync): Promise<ServedRepos> {
    const repos = new ServedRepos(github, say, exists);
    const projects = (await listProjects(mcp, github)).filter((p) => saved?.[p.id]?.served);
    const reads = await Promise.all(projects.map((p) => {
      const project = { id: p.id, title: p.title, folder: p.folder, merge: saved![p.id]!.merge, name: null, reason: '' };
      return repos._base(project, repos._remote(project, p));
    }));
    reads.forEach((r, i) => repos._settle(r, projects[i]!.id));
    return repos;
  }

  /** The GitHub `owner/name` of each served repo not read yet, null where it isn't known. */
  names(): (string | null)[] {
    return [...this.unread.values()].map((u) => u.name);
  }

  /** Each served repo not read yet, read again: those that read now, to join the loop. */
  async retry(): Promise<Repo[]> {
    const joined: Repo[] = [];
    for (const u of [...this.unread.values()]) {
      let remote: RemoteRead;
      try {
        remote = { remote: this.exists(u.folder) ? await this.github.remoteOf(u.folder) : null };
      } catch (e) {
        if (!(e instanceof GitHubError)) throw e;
        remote = { remote: null, failure: e.message };
      }
      const r = this._settle(await this._base(u, this._remote(u, remote)), u.id);
      if (r) joined.push(r);
    }
    return joined;
  }

  /** The project's remote: its `owner/name`, or an Unread (why not). */
  private _remote(u: Unread, read: RemoteRead): string | Unread | null {
    if (!this.exists(u.folder)) return { ...u, reason: `its folder ${u.folder} is missing` };
    if (read.failure !== undefined) return { ...u, reason: `gh couldn't read its GitHub remote (${read.failure})` };
    if (!read.remote) return { ...u, reason: `${u.folder} has no GitHub remote` };
    return read.remote.nameWithOwner;
  }

  /** The repo, read on its base; or an Unread. */
  private async _base(u: Unread, remote: string | Unread | null): Promise<Repo | Unread> {
    if (typeof remote !== 'string') return remote!;
    try {
      const base = await this.github.defaultBranch(remote);
      return { name: remote, github: remote, path: u.folder, base, merge: u.merge };
    } catch (e) {
      return { ...u, name: remote, reason: `its base branch couldn't be read (${(e as Error).message})` };
    }
  }

  /** A read's end, said: the repo when it joins now, else null. A remote an earlier project serves,
   *  or waits to serve on its base, isn't served from this one. */
  private _settle(r: Repo | Unread, id: string): Repo | null {
    const was = this.unread.get(id);
    if (r.name !== null) {
      const by = this.repos.find((x) => x.name === r.name)?.path
        ?? [...this.unread.values()].find((x) => x.id !== id && x.name === r.name)?.folder;
      if (by !== undefined) {
        this.say(`${'base' in r ? r.path : r.folder} isn't served: ${by} serves ${r.name} already`);
        this.unread.delete(id);
        return null;
      }
    }
    if ('base' in r) {
      this.repos.push(r);
      this.unread.delete(id);
      if (was) this.say(`${was.title} is read: ${r.name} joins the loop`);
      return r;
    }
    if (r.reason !== was?.reason) this.say(`${r.title} isn't served until it's read: ${r.reason}`);
    this.unread.set(id, r);
    return null;
  }
}

/** `ServedRepos.read` until T3 lists its projects, saying why it waits once, and again only when
 *  that changes, as Python's `wait_for_t3` waits for T3's server at logon. */
export async function waitForRepos(read: () => Promise<ServedRepos>, say: (line: string) => void,
  sleep: (seconds: number) => Promise<void> = (s) => wall_sleep(s)): Promise<ServedRepos> {
  let said: string | null = null;
  for (;;) {
    try {
      const repos = await read();
      if (said !== null) say("T3's projects are read");
      return repos;
    } catch (e) {
      const text = (e as Error).message;
      if (text !== said) say(`Waiting to read T3's projects: ${text}`);
      said = text;
      await sleep(CONFIG_RETRY);
    }
  }
}

/** The desktop app's served repos not read at start, read again every `CONFIG_RETRY` seconds until
 *  each has read (or isn't served: its remote is served from another project), each joining the
 *  loop (`join`) once it reads. */
export async function joinWhenRead(served: ServedRepos, join: (repo: Repo) => void,
  sleep: (seconds: number) => Promise<void> = (s) => wall_sleep(s)): Promise<void> {
  while (served.unread.size) {
    await sleep(CONFIG_RETRY);
    for (const repo of await served.retry()) join(repo);
  }
}

/** The run loop's Config: the served repos, the state folder and the pause after an idle pass. */
export function runConfig(repos: readonly Repo[], state_dir: string, poll_seconds = POLL_SECONDS): Config {
  return { repos, state_dir, poll_seconds };
}

/** The run loop's job log in `state`. */
export function jobLog(state: string): JobLog {
  return new JobLog(join(state, JOB_LOG));
}

export type Wiring = {
  config: Config;
  state: string;
  settings: () => Settings;
  catalog: CatalogSource;
  mcp: Pick<T3Mcp, 'call'>;
  /** The user's name for the brief. */
  user: () => Promise<string>;
  out: (line: string) => void;
  log_line: (line: string) => void;
  /** The served repos not read yet, by GitHub `owner/name` (null: not known): a job open in one
   *  waits for it (`ServedRepos.names`). */
  unread?: () => readonly (string | null)[];
};

/** The Runner on T3's server, gh and git, its job log and the usage gate's records in the state
 *  folder. */
export async function makeRunner(w: Wiring): Promise<Runner> {
  const catalog = () => w.catalog.current().catalog;
  const gate = new UsageGate(w.catalog, w.settings, await CostLog.open(join(w.state, 'usage.jsonl')));
  const effortOption = (provider: string, id: string) => {
    const c = catalog();
    return c ? model(c, { provider, model: id })?.effortOption ?? null : null;
  };
  return new Runner(w.config, {
    github: new GhCli(), t3: new T3Server(w.mcp, effortOption), git: new GitCli(),
    jobs: jobLog(w.state), gate, out: w.out, log_line: w.log_line,
    job_choice: (kind) => { const c = catalog(); return c ? kindModels(w.settings().jobs, kind, c).choice : null; },
    user: w.user, exists: existsSync, unread: w.unread,
  });
}

/** Until T3 has named its providers and models, or has failed to (the gate decides nothing before):
 *  null once it has, else why it couldn't be read. The source asks again later; the desktop app
 *  doesn't wait on this, and `--once` runs its pass on what it could read (the gate holds every
 *  start while T3's models are unread), as Python's `--once` runs on past a failed T3 read. */
export function firstCatalog(source: CatalogSource): Promise<string | null> {
  const now = source.current();
  if (now.catalog) return Promise.resolve(null);
  if (now.error) return Promise.resolve(now.error);
  return new Promise((resolve) => {
    const off = source.onChange((s) => {
      if (!s.catalog && !s.error) return;
      off();
      resolve(s.catalog ? null : s.error!);
    });
  });
}

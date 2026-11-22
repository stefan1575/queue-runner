// The run loop as the app wires it (#219): Python's `Config` and `Repo` from the app's Settings and
// T3's projects, the projects served at start as Python reads config.toml (each repo read on its
// own, joining at the pass after it reads), and the ported seams with the app's usage gate around
// them. The desktop app (`src/desktop/electron.ts`) runs it continuously;
// the command line (`src/app.ts`) runs one pass (`--once`) or releases a held issue (`--release`).
// A Settings or Repositories change while the loop runs is taken up at the app's next start.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { CostLog } from './cost-log.ts';
import { GitCli } from './git-seam.ts';
import { GitHubError, type GitHub as AppGitHub, type GitHubWork, type Remote } from './github.ts';
import { GhCli } from './github-seam.ts';
import { kindModels, model } from './jobs.ts';
import { t3Projects } from './projects.ts';
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

/** A served project not read yet: its T3 project, who merges it, why it hasn't read ('' while its
 *  first read runs) and its GitHub `owner/name` once that's known (its base branch is what failed),
 *  else null. */
export type Unread = { id: string; title: string; folder: string; merge: Merger; name: string | null; reason: string };

/** The repos as the planner has them at a pass's start: the served repos that read, in T3's order,
 *  and each one not read yet by its GitHub `owner/name` (null where that isn't known). */
export type Served = { repos: readonly Repo[]; unread: readonly (string | null)[] };

/** The served repos as Python's config.toml names them: each T3 project Settings switched to
 *  Served, with a GitHub remote, named by its GitHub `owner/name`, in its folder, on its base (its
 *  default branch on GitHub, read when the repo is read) and merged by whom Settings says, in T3's
 *  order of projects (which breaks a tie between repos' work, as config.toml's order does). A
 *  remote two served projects share is served from the one that reads first, and the other is
 *  said; one an unread project already names waits for that one.
 *
 *  Repos are independent, as in Python, whose config needs no network: each served repo's read
 *  (its folder, its remote, its base) is its own, at most one in flight per repo, and one that
 *  fails is named in one line and, in the desktop app (`start`), tried again `CONFIG_RETRY` seconds
 *  after it failed. A read that ends is kept until the planner takes it at a pass's start
 *  (`take`), so a repo is always either unread or in the planner's repos, never in neither. Only
 *  the projects served at start are read: a Settings change while the loop runs is #260's. */
export class ServedRepos {
  /** The served projects, in T3's order. */
  private projects: Unread[];
  private read_ = new Map<string, Repo>();
  /** Each served project the planner hasn't taken as read (one dropped, its remote served from
   *  another project, is in neither). */
  readonly unread = new Map<string, Unread>();
  /** The reads that ended and that the planner hasn't taken yet, by project. */
  private ended = new Map<string, Repo | Unread>();
  private reading = new Set<string>();
  private dropped = new Set<string>();
  /** The reason said last for each project, so it's said again only when it changes. */
  private said = new Map<string, string>();
  private github: AppGitHub & Pick<GitHubWork, 'defaultBranch'>;
  private exists: (folder: string) => boolean;
  private say: (line: string) => void;
  private sleep: (seconds: number) => Promise<void>;

  private constructor(projects: Unread[], github: AppGitHub & Pick<GitHubWork, 'defaultBranch'>, say: (line: string) => void,
    exists: (folder: string) => boolean, sleep: (seconds: number) => Promise<void>) {
    this.projects = projects;
    for (const p of projects) this.unread.set(p.id, p);
    this.github = github;
    this.say = say;
    this.exists = exists;
    this.sleep = sleep;
  }

  /** T3's projects, each one served unread until it's read (`read_once`, `start`). T3's list
   *  failing throws. No repo's remote or base is read here. */
  static async list(mcp: Pick<T3Mcp, 'call'>, github: AppGitHub & Pick<GitHubWork, 'defaultBranch'>,
    saved: Record<string, RepoChoice> | null, say: (line: string) => void,
    exists: (folder: string) => boolean = existsSync,
    sleep: (seconds: number) => Promise<void> = (s) => wall_sleep(s)): Promise<ServedRepos> {
    const projects = (await t3Projects(mcp)).filter((p) => saved?.[p.id]?.served)
      .map((p): Unread => ({ id: p.id, title: p.title, folder: p.folder, merge: saved![p.id]!.merge, name: null, reason: '' }));
    return new ServedRepos(projects, github, say, exists, sleep);
  }

  /** The served repos taken as read, in T3's order. */
  get repos(): Repo[] {
    return this.projects.flatMap((p) => this.read_.get(p.id) ?? []);
  }

  /** The GitHub `owner/name` of each served repo not taken as read, null where it isn't known. */
  names(): (string | null)[] {
    return [...this.unread.values()].map((u) => u.name);
  }

  /** `--once`: each unread repo read once, side by side, none waiting for another's. */
  async read_once(): Promise<void> {
    await Promise.all([...this.unread.values()].filter((u) => !this.reading.has(u.id)).map((u) => this._read_one(u)));
  }

  /** The desktop app: each unread repo's read on its own, tried again `CONFIG_RETRY` seconds after
   *  each failure until it reads. A read that ends with the repo read calls `wake`, so the next pass
   *  comes sooner, as T3's events bring it (#68); it carries nothing, since the pass takes it. */
  start(wake: () => void): void {
    for (const u of this.unread.values()) {
      if (!this.reading.has(u.id)) void this._keep_reading(u, wake);
    }
  }

  private async _keep_reading(u: Unread, wake: () => void): Promise<void> {
    while (!this.dropped.has(u.id)) {
      if ('base' in await this._read_one(u)) {
        wake();
        return;
      }
      await this.sleep(CONFIG_RETRY);
    }
  }

  /** One read of the repo, kept for the planner to take; a failure is said once per reason. */
  private async _read_one(u: Unread): Promise<Repo | Unread> {
    this.reading.add(u.id);
    let r: Repo | Unread;
    try {
      r = await this._read(u);
    } catch (e) {   // anything else the folder or gh throws: the repo stays unread
      r = { ...u, reason: e instanceof Error ? e.message : String(e) };
    } finally {
      this.reading.delete(u.id);
    }
    this.ended.set(u.id, r);
    if (!('base' in r) && r.reason !== this.said.get(u.id)) {
      this.say(`${r.title} isn't served until it's read: ${r.reason}`);
      this.said.set(u.id, r.reason);
    }
    return r;
  }

  /** The repo, read: its folder, its remote and its base; or an Unread (why not). */
  private async _read(u: Unread): Promise<Repo | Unread> {
    if (!this.exists(u.folder)) return { ...u, reason: `its folder ${u.folder} is missing` };
    let remote: Remote | null;
    try {
      remote = await this.github.remoteOf(u.folder);
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      return { ...u, reason: `gh couldn't read its GitHub remote (${e.message})` };
    }
    if (!remote) return { ...u, reason: `${u.folder} has no GitHub remote` };
    const name = remote.nameWithOwner;
    try {
      const base = await this.github.defaultBranch(name);
      return { name, github: name, path: u.folder, base, merge: u.merge };
    } catch (e) {
      return { ...u, name, reason: `its base branch couldn't be read (${(e as Error).message})` };
    }
  }

  /** The planner's, at a pass's start: the reads that ended since the last pass taken in, in T3's
   *  order, and the repos as they stand now. A repo that read joins; one on a remote another
   *  project serves, or waits to serve on its base, isn't served from this one, and is said. */
  take(): Served {
    for (const p of this.projects) {
      const r = this.ended.get(p.id);
      if (r === undefined) continue;
      this.ended.delete(p.id);
      if (r.name !== null) {
        const by = this.repos.find((x) => x.name === r.name)?.path
          ?? [...this.unread.values()].find((x) => x.id !== p.id && x.name === r.name)?.folder;
        if (by !== undefined) {
          this.say(`${'base' in r ? r.path : r.folder} isn't served: ${by} serves ${r.name} already`);
          this.unread.delete(p.id);
          this.dropped.add(p.id);
          continue;
        }
      }
      if ('base' in r) {
        this.read_.set(p.id, r);
        this.unread.delete(p.id);
        if (this.said.has(p.id)) this.say(`${p.title} is read: ${r.name} joins the loop`);
      } else this.unread.set(p.id, r);
    }
    return { repos: this.repos, unread: this.names() };
  }
}

/** `ServedRepos.list` until T3 lists its projects, saying why it waits once, and again only when
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
  /** The served repos at a pass's start (`ServedRepos.take`): the planner's repo list each pass,
   *  and those not read yet, for the jobs open there. */
  served?: () => Served;
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
    user: w.user, exists: existsSync, served: w.served,
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

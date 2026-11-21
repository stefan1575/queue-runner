// The run loop as the app wires it (#219): Python's `Config` and `Repo` from the app's Settings and
// Repositories, and the ported seams with the app's usage gate around them. The desktop app
// (`src/desktop/electron.ts`) runs it continuously; the command line (`src/app.ts`) runs one pass
// (`--once`) or releases a held issue (`--release`).
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { CostLog } from './cost-log.ts';
import { GitCli } from './git-seam.ts';
import { GhCli } from './github-seam.ts';
import { kindModels, model } from './jobs.ts';
import type { Repo as AppRepo } from './repos.ts';
import { Runner, type Config, type KnownRepo, type Repo } from './run.ts';
import type { Settings } from './settings.ts';
import { JobLog } from './state.ts';
import type { CatalogSource } from './t3/catalog-source.ts';
import type { T3Mcp } from './t3/mcp.ts';
import { T3Server } from './t3-seam.ts';
import { UsageGate } from './usage-gate.ts';

/** Python's `config.poll_seconds` default: the pause after an idle pass. */
export const POLL_SECONDS = 300;

/** The run loop's job log in the state folder, in Python's format (`src/state.ts`). Its own file:
 *  the desktop app's `jobs.jsonl` from before the port is `src/job-log.ts`'s format (a job's repo
 *  named by T3 project id, its thread in a record of its own), which this log can't read, so it's
 *  left in place, unread. */
export const JOB_LOG = 'run-loop-jobs.jsonl';

/** Each served repo's base: its default branch on GitHub, read once (Python's `Repo.base`, which
 *  config.toml names). A repo whose base isn't read yet is left out of the pass, and read again for
 *  the next one; a read that fails is said once, until it changes. */
export class Bases {
  private known = new Map<string, string>();
  private reading = new Map<string, Promise<void>>();
  private said = new Map<string, string>();
  private read: (github: string) => Promise<string>;
  private say: (line: string) => void;

  constructor(read: (github: string) => Promise<string>, say: (line: string) => void) {
    this.read = read;
    this.say = say;
  }

  /** The base of `github` if it's read, starting a read when it isn't (a repo not served is read
   *  only when a job there needs it). */
  of(github: string): string | null {
    const base = this.known.get(github);
    if (base === undefined) void this.load([github]);
    return base ?? null;
  }

  /** Reads the bases not read yet (the command line's pass waits for them). */
  async load(githubs: Iterable<string>): Promise<void> {
    await Promise.all([...githubs].filter((g) => !this.known.has(g)).map((g) => {
      const under = this.reading.get(g);
      if (under) return under;
      const r = this.read(g).then((base) => {
        this.known.set(g, base);
        this.said.delete(g);
      }, (e) => {
        const text = `${g}: its base branch couldn't be read (${(e as Error).message}); it gets no job until it can`;
        if (this.said.get(g) !== text) this.say(text);
        this.said.set(g, text);
      }).finally(() => this.reading.delete(g));
      this.reading.set(g, r);
      return r;
    }));
  }
}

/** The titles two or more of T3's projects share. The run loop names a repo by its T3 project's
 *  title (Python's `Repo.name`, which config.toml names once each), so a shared title can't say
 *  which repo a job is in: those projects aren't served, and a job naming that title is left
 *  undecided, until one is renamed. Said once each time the shared titles change. */
export class SharedTitles {
  private said = '';
  private say: (line: string) => void;

  constructor(say: (line: string) => void) {
    this.say = say;
  }

  /** The shared titles in `list`, saying them when they've changed. */
  check(list: AppRepo[] | null): Set<string> {
    const shared = sharedTitles(list);
    const text = [...shared].sort().map((t) => {
      const same = (list ?? []).filter((r) => r.title === t);
      return `${same.length} T3 projects are titled "${t}" (${same.map((r) => r.folder).join(', ')}): none of them is served until all but one are renamed, as the run loop names a repo by its title`;
    }).join('\n');
    if (text !== this.said && text) this.say(text);
    this.said = text;
    return shared;
  }
}

/** The titles two or more projects in `list` share. */
export function sharedTitles(list: AppRepo[] | null): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const r of list ?? []) (seen.has(r.title) ? shared : seen).add(r.title);
  return shared;
}

/** The served repos (switched to Served, with a GitHub remote, a title no other project has), as
 *  the run loop's Repos: each named by its T3 project's title, in its folder, on its base, merged by
 *  whom Settings says. */
export function servedRepos(list: AppRepo[] | null, bases: Bases, titles: SharedTitles): Repo[] {
  const shared = titles.check(list);
  return (list ?? []).filter((r) => r.served && r.github && !shared.has(r.title)).flatMap((r) => {
    const base = bases.of(r.github!);
    return base === null ? [] : [{ name: r.title, github: r.github, path: r.folder, base, merge: r.merge }];
  });
}

/** A job's own repo by name, served or not (`Config.lookup`): a repo switched off Served still
 *  finishes its work. Null while the app can't say (its repos, or that repo's remote, not read
 *  yet, or two projects share that title); its base null until it's read. */
export function repoLookup(list: () => AppRepo[] | null, bases: Bases): (name: string) => KnownRepo | null | undefined {
  return (name) => {
    const all = list();
    if (all === null) return null;
    const found = all.filter((r) => r.title === name);
    if (found.length > 1 || found.some((r) => r.checking)) return null;
    const r = found.find((x) => x.github);
    if (!r) return undefined;
    return { name: r.title, github: r.github, path: r.folder, base: bases.of(r.github!), merge: r.merge };
  };
}

/** The run loop's Config: the served repos, read each time they're asked for, and a job's own repo
 *  looked up by name. */
export function runConfig(repos: () => Repo[], state_dir: string, lookup?: Config['lookup'], poll_seconds = POLL_SECONDS): Config {
  return { get repos() { return repos(); }, state_dir, poll_seconds, ...(lookup ? { lookup } : {}) };
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
    user: w.user, exists: existsSync,
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

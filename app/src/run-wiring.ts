// The run loop as the app wires it (#219): Python's `Config` and `Repo` from the app's Settings and
// T3's projects, read once at start as Python reads config.toml, and the ported seams with the
// app's usage gate around them. The desktop app (`src/desktop/electron.ts`) runs it continuously;
// the command line (`src/app.ts`) runs one pass (`--once`) or releases a held issue (`--release`).
// A Settings or Repositories change while the loop runs is taken up at the app's next start.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { CostLog } from './cost-log.ts';
import { GitCli } from './git-seam.ts';
import type { GitHub as AppGitHub, GitHubWork } from './github.ts';
import { GhCli } from './github-seam.ts';
import { kindModels, model } from './jobs.ts';
import { listProjects } from './projects.ts';
import { Runner, wall_sleep, type Config, type Repo } from './run.ts';
import type { RepoChoice, Settings } from './settings.ts';
import { JobLog } from './state.ts';
import type { CatalogSource } from './t3/catalog-source.ts';
import type { T3Mcp } from './t3/mcp.ts';
import { T3Server } from './t3-seam.ts';
import { UsageGate } from './usage-gate.ts';

/** Python's `config.poll_seconds` default: the pause after an idle pass. */
export const POLL_SECONDS = 300;
/** Reading the served repos at the desktop app's start: how often to try again (Python's
 *  `T3_RETRY`, its wait for T3's server at logon). */
export const CONFIG_RETRY = 30;

/** The run loop's job log in the state folder, in Python's format (`src/state.ts`). Its own file:
 *  the desktop app's `jobs.jsonl` from before the port is `src/job-log.ts`'s format (a job's repo
 *  named by T3 project id, its thread in a record of its own), which this log can't read, so it's
 *  left in place, unread. */
export const JOB_LOG = 'run-loop-jobs.jsonl';

/** The served repos couldn't all be read (T3's projects, a served repo's GitHub remote or its base
 *  branch): the run loop doesn't start on part of them. */
export class ConfigError extends Error {}

/** The served repos as Python's config.toml names them: each T3 project Settings switched to
 *  Served, with a GitHub remote, named by its GitHub `owner/name`, in its folder, on its base (its
 *  default branch on GitHub, read now) and merged by whom Settings says, in T3's order of projects
 *  (which breaks a tie between repos' work, as config.toml's order does). A remote two served
 *  projects share is served from the first, and the others are said. */
export async function readRepos(mcp: Pick<T3Mcp, 'call'>, github: AppGitHub & Pick<GitHubWork, 'defaultBranch'>,
  saved: Record<string, RepoChoice> | null, say: (line: string) => void): Promise<Repo[]> {
  const projects = await listProjects(mcp, github);
  const served = projects.filter((p) => saved?.[p.id]?.served);
  const failed = served.filter((p) => p.failure);
  if (failed.length) throw new ConfigError(failed.map((p) => `${p.title}: gh couldn't read its GitHub remote (${p.failure})`).join('; '));
  const first = new Map<string, (typeof served)[number]>();
  for (const p of served) {
    if (!p.remote) continue;
    const other = first.get(p.remote.nameWithOwner);
    if (other) say(`${p.folder} isn't served: ${other.folder} serves ${p.remote.nameWithOwner} already`);
    else first.set(p.remote.nameWithOwner, p);
  }
  return Promise.all([...first].map(async ([github_, p]): Promise<Repo> => {
    let base: string;
    try {
      base = await github.defaultBranch(github_);
    } catch (e) {
      throw new ConfigError(`${github_}: its base branch couldn't be read (${(e as Error).message})`);
    }
    return { name: github_, github: github_, path: p.folder, base, merge: saved![p.id]!.merge };
  }));
}

/** `readRepos` until it reads them, saying why it waits once, and again only when that changes,
 *  as Python's `wait_for_t3` waits for T3's server at logon. */
export async function waitForRepos(read: () => Promise<Repo[]>, say: (line: string) => void,
  sleep: (seconds: number) => Promise<void> = (s) => wall_sleep(s)): Promise<Repo[]> {
  let said: string | null = null;
  for (;;) {
    try {
      const repos = await read();
      if (said !== null) say('The served repos are read');
      return repos;
    } catch (e) {
      const text = (e as Error).message;
      if (text !== said) say(`Waiting to read the served repos: ${text}`);
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

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
import { Runner, type Config, type Repo } from './run.ts';
import type { Settings } from './settings.ts';
import { JobLog } from './state.ts';
import type { CatalogSource } from './t3/catalog-source.ts';
import type { T3Mcp } from './t3/mcp.ts';
import { T3Server } from './t3-seam.ts';
import { UsageGate } from './usage-gate.ts';

/** Python's `config.poll_seconds` default: the pause after an idle pass. */
export const POLL_SECONDS = 300;

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

  /** The base of `github` if it's read, starting a read when it isn't. */
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

/** The served repos (switched to Served, with a GitHub remote), as the run loop's Repos: each named
 *  by its T3 project's title, in its folder, on its base. */
export function servedRepos(list: AppRepo[] | null, bases: Bases): Repo[] {
  return (list ?? []).filter((r) => r.served && r.github).flatMap((r) => {
    const base = bases.of(r.github!);
    return base === null ? [] : [{ name: r.title, github: r.github, path: r.folder, base }];
  });
}

/** The run loop's Config: the served repos, read each time they're asked for. */
export function runConfig(repos: () => Repo[], state_dir: string, poll_seconds = POLL_SECONDS): Config {
  return { get repos() { return repos(); }, state_dir, poll_seconds };
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
    jobs: new JobLog(join(w.state, 'jobs.jsonl')), gate, out: w.out, log_line: w.log_line,
    job_choice: (kind) => { const c = catalog(); return c ? kindModels(w.settings().jobs, kind, c).choice : null; },
    user: w.user, exists: existsSync,
  });
}

/** Until T3 has named its providers and models: the gate decides nothing before. */
export function firstCatalog(source: CatalogSource): Promise<void> {
  if (source.current().catalog) return Promise.resolve();
  return new Promise((resolve) => {
    const off = source.onChange((s) => {
      if (!s.catalog) return;
      off();
      resolve();
    });
  });
}

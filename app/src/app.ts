// The command line: `--list` prints every T3 project with its GitHub remote and changes nothing.
// It exits 1 when gh failed for any project (each such project says what gh said). `--once` runs
// one pass of each lane (`Runner.run_once`, as `cli.py` has it), under the state folder's
// one-run-loop lock the desktop app holds too, on the served repos whose folders read at its start (each
// one that can't is named, and its open jobs count as running), and
// `--release NAME#N` lets the picker take a held issue again, NAME a repo's GitHub `owner/name` the
// job log has jobs in, from the job log alone (#219).
import type { GitHub } from './github.ts';
import { formatProjects, listProjects } from './projects.ts';
import type { Runner } from './run.ts';
import { RunnerBusy } from './runner-lock.ts';
import type { JobLog } from './state.ts';
import type { T3Mcp } from './t3/mcp.ts';
import type { T3Ws } from './t3/ws.ts';

/** `runner` makes the run loop's Runner, saying what it says through `out` (`--once`); `lock` takes
 *  the state folder's one-run-loop lock (`runner_lock`: its release, or RunnerBusy); `release` opens
 *  the job log and the app's log line (`--release`), with no T3 or GitHub. */
export type Doors = { mcp: Pick<T3Mcp, 'call'>; ws: Pick<T3Ws, 'first'>; github: GitHub;
  runner?: (out: (line: string) => void) => Promise<Runner>;
  lock?: () => () => void;
  release?: () => Promise<{ jobs: JobLog; log_line: (line: string) => void }> };

/** The exit code while another run loop holds the lock (Python's `EXIT_LOCKED`). */
export const EXIT_LOCKED = 3;

const USAGE = 'usage: pnpm --dir app start -- --list | --once | --release NAME#N\n';

/** NAME#N from the command line (`cli._repo_ref`): [repo name, N], or null when NAME isn't a repo
 *  the job log has jobs in (a held issue's repo always is). NAME is the repo's GitHub `owner/name`,
 *  as the run loop names it (Python's `[\w.-]+` name, with its owner). */
function repo_ref(value: string, jobs: JobLog): [string, number] | null {
  const m = /^([\w.-]+(?:\/[\w.-]+)?)#([0-9]+)$/.exec(value);
  if (!m || !jobs.jobs().some((j) => j.repo === m[1])) return null;
  return [m[1]!, Number(m[2])];
}

export async function run(argv: string[], doors: Doors, out: (s: string) => void): Promise<number> {
  const args = argv.filter((a) => a !== '--');
  const line = (l: string) => out(`${l}\n`);
  if (args.length === 1 && args[0] === '--once' && doors.runner) {
    let release = () => {};
    try {
      if (doors.lock) release = doors.lock();
    } catch (e) {
      if (!(e instanceof RunnerBusy)) throw e;
      out(`A queue runner is already running (${e.message}).\n`);
      return EXIT_LOCKED;
    }
    try {
      const runner = await doors.runner(line);
      await runner.run_once();
    } finally {
      release();
    }
    return 0;
  }
  if (args.length === 2 && args[0] === '--release' && doors.release) {
    const { jobs, log_line } = await doors.release();
    const ref = repo_ref(args[1]!, jobs);
    if (ref === null) {
      out('--release takes NAME#N with NAME a repo (its GitHub owner/name) the job log has jobs in.\n');

      return 2;
    }
    jobs.released(ref[0], ref[1]);
    log_line(`released ${args[1]}`);
    out(`Released ${args[1]}: the picker may take it again, the reviewer lane may review it again if its reviews failed, and a PR stopped for the user is back in the loop.\n`);
    return 0;
  }
  if (args.length !== 1 || args[0] !== '--list') {
    out(USAGE);
    return 2;
  }
  // The WebSocket is opened on every start, so a sign-in it refuses shows at once.
  const [config, projects] = await Promise.all([
    doors.ws.first('subscribeServerConfig', {}),
    listProjects(doors.mcp, doors.github),
  ]);
  const env = config?.config?.environment;
  out(`T3 ${env?.serverVersion ?? '?'} on ${env?.label ?? '?'}\n\n`);
  out(formatProjects(projects));
  // a project gh couldn't answer for is a failed list, not one with no remote
  return projects.some((p) => p.failure) ? 1 : 0;
}

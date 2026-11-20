// The command line: `--list` prints every T3 project with its GitHub remote and changes nothing.
// It exits 1 when gh failed for any project (each such project says what gh said). `--once` runs
// one pass of each lane (`Runner.run_once`, as `cli.py` has it) and `--release NAME#N` lets the
// picker take a held issue again, NAME a served repo (#219).
import type { GitHub } from './github.ts';
import { formatProjects, listProjects } from './projects.ts';
import type { Runner } from './run.ts';
import type { T3Mcp } from './t3/mcp.ts';
import type { T3Ws } from './t3/ws.ts';

/** `runner` makes the run loop's Runner, saying what it says through `out` (`--once`, `--release`). */
export type Doors = { mcp: Pick<T3Mcp, 'call'>; ws: Pick<T3Ws, 'first'>; github: GitHub;
  runner?: (out: (line: string) => void) => Promise<Runner> };

const USAGE = 'usage: pnpm --dir app start -- --list | --once | --release NAME#N\n';

/** NAME#N from the command line (`cli._repo_ref`): [repo name, N], or null when NAME isn't a served
 *  repo. Python's `\w` reads Unicode letters and digits, as this does. */
function repo_ref(value: string, runner: Runner): [string, number] | null {
  const m = /^([\p{L}\p{N}_.-]+)#(\p{Nd}+)$/u.exec(value);
  if (!m || !runner.config.repos.some((r) => r.name === m[1])) return null;
  return [m[1]!, Number(m[2])];
}

export async function run(argv: string[], doors: Doors, out: (s: string) => void): Promise<number> {
  const args = argv.filter((a) => a !== '--');
  const line = (l: string) => out(`${l}\n`);
  if (args.length === 1 && args[0] === '--once' && doors.runner) {
    const runner = await doors.runner(line);
    await runner.run_once();
    return 0;
  }
  if (args.length === 2 && args[0] === '--release' && doors.runner) {
    const runner = await doors.runner(line);
    const ref = repo_ref(args[1]!, runner);
    if (ref === null) {
      out('--release takes NAME#N with NAME one of the served repos.\n');
      return 2;
    }
    runner.jobs.released(ref[0], ref[1]);
    runner.log_line(`released ${args[1]}`);
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

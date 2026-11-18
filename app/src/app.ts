// The command line: `--list` prints every T3 project with its GitHub remote and changes nothing.
// It exits 1 when gh failed for any project (each such project says what gh said).
import type { GitHub } from './github.ts';
import { formatProjects, listProjects } from './projects.ts';
import type { T3Mcp } from './t3/mcp.ts';
import type { T3Ws } from './t3/ws.ts';

export type Doors = { mcp: Pick<T3Mcp, 'call'>; ws: Pick<T3Ws, 'first'>; github: GitHub };

const USAGE = 'usage: pnpm --dir app start -- --list\n';

export async function run(argv: string[], doors: Doors, out: (s: string) => void): Promise<number> {
  const args = argv.filter((a) => a !== '--');
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

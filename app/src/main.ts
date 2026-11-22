import { run } from './app.ts';
import { GitCli } from './git-seam.ts';
import { GhCli } from './github-seam.ts';
import { GhGitHub } from './github.ts';
import { model } from './jobs.ts';
import { catalogFromConfig } from './t3/catalog.ts';
import { T3Error } from './t3/seams.ts';
import { T3Mcp } from './t3/mcp.ts';
import { T3Ws } from './t3/ws.ts';
import { fetchHttp, nodeConnect, runtimeAddress, t3Cli } from './t3/real.ts';
import { T3Server } from './t3-seam.ts';

const address = runtimeAddress();
const cli = t3Cli();
const doors = {
  mcp: new T3Mcp(address, cli, fetchHttp),
  ws: new T3Ws(address, cli, fetchHttp, nodeConnect),
  github: new GhGitHub(),
};
// The run loop's T3 (`src/t3-seam.ts`): each model's effort option is the one T3's catalog names,
// read on the loop's first call to T3 that finds it up. Until then each call fails as T3 being down
// fails it in Python, so the loop waits for T3 at logon (`wait_for_t3`) as Python's does.
let server: T3Server | null = null;
const seam = async (): Promise<T3Server> => {
  if (server === null) {
    const catalog = catalogFromConfig((await doors.ws.first('subscribeServerConfig', {})).config);
    server = new T3Server(doors.mcp, (provider, m) => model(catalog, { provider, model: m })?.effortOption ?? null);
  }
  return server;
};
const t3 = {
  start: async (...a: Parameters<T3Server['start']>) => (await seam()).start(...a),
  show: async (...a: Parameters<T3Server['show']>) => (await seam()).show(...a),
  list: async (...a: Parameters<T3Server['list']>) => (await seam()).list(...a),
  settle: async (...a: Parameters<T3Server['settle']>) => (await seam()).settle(...a),
};
const out = (s: string) => process.stdout.write(s);
try {
  process.exitCode = await run(process.argv.slice(2), doors, out, { github: new GhCli(), git: new GitCli(), t3 });
} catch (e) {
  if (!(e instanceof T3Error)) throw e;
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
}

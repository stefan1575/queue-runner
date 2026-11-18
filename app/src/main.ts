import { run } from './app.ts';
import { GhGitHub } from './github.ts';
import { T3Error } from './t3/seams.ts';
import { T3Mcp } from './t3/mcp.ts';
import { T3Ws } from './t3/ws.ts';
import { fetchHttp, nodeConnect, runtimeAddress, t3Cli } from './t3/real.ts';

const address = runtimeAddress();
const cli = t3Cli();
const doors = {
  mcp: new T3Mcp(address, cli, fetchHttp),
  ws: new T3Ws(address, cli, fetchHttp, nodeConnect),
  github: new GhGitHub(),
};
try {
  process.exitCode = await run(process.argv.slice(2), doors, (s) => process.stdout.write(s));
} catch (e) {
  if (!(e instanceof T3Error)) throw e;
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
}

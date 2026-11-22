import { join } from 'node:path';
import { run } from './app.ts';
import { GhGitHub } from './github.ts';
import { firstCatalog, jobLog, makeRunner, runConfig, servedRepos } from './run-wiring.ts';
import { runner_lock } from './runner-lock.ts';
import { SettingsStore } from './settings.ts';
import { APP_DATA_NAME, savedStateFolder } from './state-folder.ts';
import { T3Catalog } from './t3/catalog-source.ts';
import { T3Error } from './t3/seams.ts';
import { T3Mcp } from './t3/mcp.ts';
import { T3Ws } from './t3/ws.ts';
import { fetchHttp, nodeConnect, runtimeAddress, t3Cli } from './t3/real.ts';

const address = runtimeAddress();
const cli = t3Cli();
const mcp = new T3Mcp(address, cli, fetchHttp);
const ws = new T3Ws(address, cli, fetchHttp, nodeConnect);
const github = new GhGitHub();
const started: { catalog: T3Catalog | null } = { catalog: null };

/** The desktop app's own state folder. */
const stateDir = () => savedStateFolder(join(process.env.APPDATA ?? '', APP_DATA_NAME, 'machine.json'));
const stamp = (line: string) => console.error(`${new Date().toISOString()} ${line}`);

/** The run loop on the desktop app's own state folder and settings, its served repos read now from
 *  their folders, as Python reads config.toml (`--once`). What it says goes to the output and the
 *  app's log line. A served repo whose folder can't be read is named and does no work, and a job
 *  open there counts as running; T3's projects not listing throws T3Error, and the pass doesn't
 *  run. */
async function runner(out: (line: string) => void) {
  const state = stateDir();
  const settings = await SettingsStore.open(state);
  const catalog = T3Catalog.start(ws);
  started.catalog = catalog;
  // the served repos' folders read while T3 names its models
  const [served, unread] = await Promise.all([servedRepos(mcp, settings.get().repos, out), firstCatalog(catalog)]);
  if (unread !== null) out(`T3's providers and models couldn't be read (${unread}); the usage gate starts no job this pass`);
  return makeRunner({
    config: runConfig(served.repos, state), state, settings: () => settings.get(), catalog, mcp,
    user: async () => settings.get().name ?? 'the user', out, log_line: stamp, unread: served.unread,
  });
}

try {
  process.exitCode = await run(process.argv.slice(2), {
    mcp, ws, github, runner, lock: () => runner_lock(stateDir()),
    release: async () => ({ jobs: jobLog(stateDir()), log_line: stamp }),
  }, (s) => process.stdout.write(s));
} catch (e) {
  if (!(e instanceof T3Error)) throw e;
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
} finally {
  started.catalog?.stop();
}

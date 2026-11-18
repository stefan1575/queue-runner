// Live check of the app's sign-in (#149), against the real T3. The app acts on no project: it
// reads the project list and the server config and touches no thread. The one thread this check
// touches is the runner client's, in the "queue-runner sandbox" project only (the Python helper
// refuses any other, as scripts/live_mcp.py does).
//
//     pnpm --dir app live:sign-in
//
// 1. Starts today's runner's own MCP client (scripts/live_runner_settle.py, Python): it signs in
//    as the runner does and launches an idle thread in the sandbox project, and notes its session
//    and the runner's others (label "Queue runner").
// 2. Starts the app twice (MCP and WebSocket sign-in each time): the app's older sessions are
//    revoked, the runner's stay active.
// 3. Has that runner client settle its thread with the token it signed in with before the app
//    did: the settle must work without signing in again (#149: a settle by the Python runner
//    still works afterwards).
// 4. Records what T3's /ws does with an MCP token (refused) and with the app's client session
//    (subscribeServerConfig: the frames it sent).
// 5. Revokes the app's own sessions (the runner client revokes its own).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { listProjects } from '../src/projects.ts';
import { GhGitHub } from '../src/github.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { fetchHttp, nodeConnect, runtimeAddress, t3Cli } from '../src/t3/real.ts';
import { LABEL, signInMcp } from '../src/t3/sign-in.ts';
import { T3Ws } from '../src/t3/ws.ts';

const RUNNER_LABEL = 'Queue runner';
const address = runtimeAddress();
const cli = t3Cli();
let good = true;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  good &&= ok;
};
const sessions = async (label: string): Promise<any[]> =>
  JSON.parse((await cli(['auth', 'session', 'list', '--json'])).stdout)
    .filter((s: any) => s?.client?.label === label);

// Today's runner, signed in before the app: one JSON line when it has signed in, one after it settled.
const helper = fileURLToPath(new URL('../../scripts/live_runner_settle.py', import.meta.url));
const python = spawn('python3', [helper], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: python.stdout })[Symbol.asyncIterator]();
const said = async () => {
  const next = await lines.next();
  if (next.done) throw new Error('the runner client ended without saying anything (its error is above)');
  return JSON.parse(next.value);
};
const signedIn = await said();
console.log(`runner client: session ${signedIn.session}, idle thread ${signedIn.thread}`);

const runner = await sessions(RUNNER_LABEL);
console.log(`today's runner: ${runner.map((s) => `${s.subject} ${s.sessionId}`).join(', ') || 'no session'}`);

for (const start of [1, 2]) {
  const ws = new T3Ws(address, cli, fetchHttp, nodeConnect);
  const mcp = new T3Mcp(address, cli, fetchHttp);
  const [config, projects] = await Promise.all([
    ws.first('subscribeServerConfig', {}), listProjects(mcp, new GhGitHub()),
  ]);
  const failed = projects.filter((p) => p.failure);
  check(`app start ${start}: listed projects and read the server config`,
    projects.length > 0 && failed.length === 0 && config?.type === 'snapshot',
    `${projects.length} projects, ${projects.filter((p) => p.remote).length} on GitHub, gh failed for ${failed.length}`
      + failed.map((p) => `; ${p.failure}`).join(''));
}
const app = await sessions(LABEL);
check('the app holds one session of each kind', app.length === 2, app.map((s) => s.subject).join(', '));
const still = new Set((await sessions(RUNNER_LABEL)).map((s) => s.sessionId));
check("today's runner keeps its sessions", runner.every((s) => still.has(s.sessionId)),
  runner.map((s) => s.sessionId).join(', ') || 'none to keep');
python.stdin.write('settle\n');
const settle = await said();
check('a settle by the runner, with the token it held before the app signed in, still works',
  settle.settled && !settle.signedInAgain && !settle.error,
  `settled=${settle.settled}, signed in again=${settle.signedInAgain}${settle.error ? `, ${settle.error}` : ''}`);
python.stdin.end();

// What /ws does with each token
const origin = await address();
const wsUrl = `${origin.replace(/^http/, 'ws')}/ws?orchestrationProtocol=2`;
const opens = (token: string) => new Promise<string>((resolve) => {
  const s = nodeConnect(wsUrl, { authorization: `Bearer ${token}` }, {
    open: () => { s.close(); resolve('opened'); }, message: () => {}, closed: (o, r) => { if (!o) resolve(`refused (${r})`); },
  });
});
const mcpToken = await signInMcp(origin, cli, fetchHttp);
const withMcp = await opens(mcpToken);
check('/ws refuses an MCP client session', withMcp !== 'opened', withMcp);

const frames: string[] = [];
const ws = new T3Ws(address, cli, fetchHttp, (url, headers, on) => nodeConnect(url, headers, {
  ...on, message: (t) => { frames.push(t); on.message(t); },
}));
const config = await ws.first('subscribeServerConfig', {});
const first = JSON.parse(frames[0] ?? '{}');
check('subscribeServerConfig answered with a snapshot chunk', first._tag === 'Chunk' && config.type === 'snapshot',
  `${frames.length} frame(s), first ${frames[0]?.length ?? 0} bytes, values ${first.values?.map((v: any) => `${v.type} v${v.version}`).join(', ')}, config keys: ${Object.keys(config.config ?? {}).join(', ')}`);

for (const s of await sessions(LABEL)) await cli(['auth', 'session', 'revoke', s.sessionId]);
check("the app's sessions revoked", (await sessions(LABEL)).length === 0);
process.exitCode = good ? 0 : 1;

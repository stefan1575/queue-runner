// Live check of the one launch (#152), against the real T3, in the "queue-runner sandbox" project
// only (it refuses to run without it, and never names another). Costs one tiny thread per
// provider kind: it launches, through launchJob, one thread on each connected provider whose
// effort option T3 names differently (one per driver), each at an effort that isn't its model's
// default, so a launch that dropped the effort can't pass. Then it reads the effort back from T3's
// run record (the WebSocket's `orchestration.getThreadProjection`: its run's `modelSelection`;
// MCP's `t3_thread_read` names the model but not the effort) and archives the thread.
//
//     pnpm --dir app live:launch                              # each driver's first provider, its default model
//     pnpm --dir app live:launch -- --run <instance>:<model>  # these instead (repeatable)
//
// Threads run in the sandbox project's own folder (no worktree), asked to reply one word with no tools.
import { DEFAULT_JOBS, defaultModelOf, model, type Catalog, type ModelChoice } from '../src/jobs.ts';
import { launchJob } from '../src/launch.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { fetchHttp, nodeConnect, runtimeAddress, t3Cli } from '../src/t3/real.ts';
import { T3Ws } from '../src/t3/ws.ts';

const SANDBOX = 'queue-runner sandbox';
const BRIEF = 'Reply with the single word: ok. Do not run any tools.';

const address = runtimeAddress();
const cli = t3Cli();
const mcp = new T3Mcp(address, cli, fetchHttp);
const ws = new T3Ws(address, cli, fetchHttp, nodeConnect);
let good = true;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  good &&= ok;
};

const projects: any[] = (await mcp.call('t3_project_list', { cursor: 0, limit: 100 })).projects;
const sandbox = projects.filter((p) => p.title === SANDBOX);
if (sandbox.length !== 1) throw new Error(`expected one T3 project called "${SANDBOX}", found ${sandbox.length}: refusing`);
const projectId: string = sandbox[0].id;

const catalog: Catalog = catalogFromConfig((await ws.first('subscribeServerConfig', { workspaceSnapshotsOnDemand: true })).config);

/** A choice at an effort that isn't the model's default. */
function offDefault(provider: string, modelId: string): ModelChoice {
  const m = model(catalog, { provider, model: modelId });
  if (!m) throw new Error(`T3 has no model ${modelId} on ${provider}`);
  const effort = m.efforts.find((e) => e.id !== m.defaultEffort)?.id ?? null;
  return { provider, model: m.id, effort };
}

const asked = process.argv.flatMap((a, i) => (process.argv[i - 1] === '--run' ? [a] : []));
const runs: ModelChoice[] = asked.length
  ? asked.map((r) => { const [p, ...m] = r.split(':'); return offDefault(p!, m.join(':')); })
  : catalog.providers
      .filter((p, i, all) => {
        const option = defaultModelOf(p)?.effortOption;
        return option && all.findIndex((q) => defaultModelOf(q)?.effortOption === option) === i;
      })
      .map((p) => offDefault(p.id, defaultModelOf(p)!.id));
console.log(`T3 connects ${catalog.providers.map((p) => p.id).join(', ')}; launching ${runs.length} thread(s)`);

for (const choice of runs) {
  const option = model(catalog, choice)!.effortOption;
  const launched = await launchJob(mcp, { ...DEFAULT_JOBS, default: choice }, catalog, {
    kind: 'ask', projectId, title: `Queue runner app launch check (${choice.model} at ${choice.effort})`, brief: BRIEF,
  });
  console.log(`${choice.provider} ${choice.model}: launched ${launched.threadId} asking ${option}=${choice.effort}`);
  for (;;) {
    const waited = await mcp.call('t3_thread_wait', { threadId: launched.threadId, timeoutMs: 20000 });
    if (!waited?.timedOut) { console.log(`  run ended: ${JSON.stringify(waited).slice(0, 300)}`); break; }
  }
  const projection = await ws.request('orchestration.getThreadProjection', { threadId: launched.threadId });
  const run = (projection?.runs ?? []).find((r: any) => (r?.id ?? r?.runId) === launched.runId) ?? projection?.runs?.at(-1);
  const sel = run?.modelSelection;
  console.log(`  T3's run ${run?.id ?? run?.runId ?? '?'} (${run?.status ?? '?'}): ${JSON.stringify(sel)}`);
  check(`${choice.provider} ${choice.model}'s run completed`, run?.status === 'completed', run?.status);
  check(`${choice.provider} ${choice.model}'s run is at ${choice.effort}, under ${option}`,
    sel?.instanceId === choice.provider && sel?.model === choice.model
      && JSON.stringify(sel?.options) === JSON.stringify([{ id: option, value: choice.effort }]),
    `read back ${JSON.stringify(sel?.options)}`);
  await mcp.call('t3_thread_organize', { threadId: launched.threadId, action: 'archive' }).catch((e: Error) => console.log(`  archive failed: ${e.message}`));
}

console.log(good ? 'all ok' : 'FAILED');
process.exit(good ? 0 : 1);

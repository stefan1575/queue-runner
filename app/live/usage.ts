// Live check of the usage the gate reads (#153), against the real T3. It acts on no project: it
// only subscribes to T3's server config, prints each connected provider's usage windows as the
// app reads them (`usageFromProviders`), then each `providerStatuses` event that changes one, for
// the minutes asked (5 by default; T3 reads each provider's usage about every 5 minutes).
//
//     pnpm --dir app live:usage [-- --minutes N]
import { usageFromProviders, windowName, type ProviderUsage } from '../src/usage.ts';
import { fetchHttp, nodeConnect, runtimeAddress, t3Cli } from '../src/t3/real.ts';
import { T3Ws } from '../src/t3/ws.ts';

const at = process.argv.indexOf('--minutes');
const minutes = at > 0 ? Number(process.argv[at + 1]) : 5;
const ws = new T3Ws(runtimeAddress(), t3Cli(), fetchHttp, nodeConnect);

const line = (u: ProviderUsage) => {
  const windows = u.windows.map((w) => `${windowName(u.name, w)} (${w.id}) ${w.usedPercent}%, resets ${w.resetsAt ?? '-'}`);
  return `${u.provider} [${u.driver}, login ${u.account.split(':')[0]}:…] read ${u.checkedAt ?? 'never'}: ${windows.join('; ') || `no windows (${u.unavailable})`}${u.resetCredits !== null ? `; ${u.resetCredits} reset credit(s)` : ''}`;
};

let last = new Map<string, string>();
let events = 0;
const sub = ws.subscribe('subscribeServerConfig', { workspaceSnapshotsOnDemand: true }, (v) => {
  const providers = v?.type === 'snapshot' ? v.config?.providers : v?.type === 'providerStatuses' ? v.payload?.providers : undefined;
  if (!providers) return;
  events += 1;
  const now = new Map(usageFromProviders(providers).map((u) => [u.provider, line(u)]));
  for (const [id, text] of now) if (last.get(id) !== text) console.log(`${new Date().toISOString()} ${v.type}: ${text}`);
  last = now;
});
setTimeout(() => sub.close(), minutes * 60_000);
await sub.done;
console.log(`${events} snapshot or providerStatuses value(s) in ${minutes} minute(s)`);

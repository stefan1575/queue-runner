// Usage in full: both providers with reset times, and what the runner expects each kind of job to cost
// before it starts one (the usage gate's learned costs).
import { ProviderName } from "@/components/Brand";
import { Section, UsageBar } from "@/components/ui";
import { useStore } from "@/store";

const COSTS: [string, number, number, string][] = [
  ["Build", 60, 15, "default"],
  ["Fix round", 34, 8, "learned from 5"],
  ["Decision", 15, 4, "default"],
  ["Live steps", 20, 5, "default"],
];

export function UsagePage() {
  const { world } = useStore();
  const { claude, chatgpt } = world.usage;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Section title={<ProviderName p="claude" />}>
        <div className="space-y-2.5">
          <UsageBar label="Session" used={claude.five.used} resets={claude.five.resets} showReset />
          <UsageBar label="Weekly" used={claude.week.used} resets={claude.week.resets} reserve={world.runner.reserve} showReset />
          {claude.scoped?.map((s) => <UsageBar key={s.label} label={`Weekly · ${s.label}`} used={s.used} resets={s.resets} showReset />)}
        </div>
        <p className="mt-3 text-[14px] text-mute">The runner keeps {world.runner.reserve}% of the week for you until 24 hours before it resets ({claude.releaseAt}). Read at {claude.readAt}.</p>
      </Section>
      <Section title={<ProviderName p="chatgpt" />}>
        <div className="space-y-2.5">
          <UsageBar label="Session" used={chatgpt.five.used} resets={chatgpt.five.resets} showReset />
          <UsageBar label="Weekly" used={chatgpt.week.used} resets={chatgpt.week.resets} showReset />
        </div>
        <p className="mt-3 text-[14px] text-mute">Sol's reviews aren't held back by usage; when ChatGPT runs out, the next review waits for its reset. Read at {chatgpt.readAt}.</p>
      </Section>
      <Section title="What a Claude job is expected to cost" className="xl:col-span-2" flush>
        <table className="w-full text-[14.5px]">
          <thead className="text-left text-[13.5px] text-mute">
            <tr className="border-b border-line-2"><th className="px-4 py-2 font-medium">Job</th><th className="px-4 py-2 text-right font-medium">Of the session</th><th className="px-4 py-2 text-right font-medium">Of the week</th><th className="px-4 py-2 font-medium">From</th></tr>
          </thead>
          <tbody>
            {COSTS.map(([k, s, w, from]) => (
              <tr key={k} className="border-b border-line-2 last:border-0">
                <td className="px-4 py-2.5 font-medium">{k}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{s}%</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{w}%</td>
                <td className="px-4 py-2.5 text-mute">{from}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-line-2 px-4 py-3 text-[14px] text-mute">A job starts only if the session has room for its cost and the week still leaves your share.</p>
      </Section>
    </div>
  );
}

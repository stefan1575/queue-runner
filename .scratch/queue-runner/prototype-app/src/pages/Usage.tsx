// Claude's two windows, the reserve and the gate's expected costs. Sol gets availability only: the
// runner has no Sol meter to show.
import { Chip, Meter, Panel } from "@/components/ui";
import { useStore } from "@/store";

export function Usage() {
  const { world } = useStore();
  const u = world.usage;
  const reserve = world.runner.reserve;
  return (
    <div className="max-w-[1000px] space-y-5">
      {!u.readable && (
        <div className="rounded-xl border border-bad/25 bg-bad-soft px-4 py-3">
          <p className="font-semibold text-bad">Can't read Claude's usage</p>
          <p className="mt-0.5 text-[13.5px] text-ink-2">{u.error}. No Claude job starts until it can. Running Claude Code once refreshes the login; the runner reads it again each pass.</p>
        </div>
      )}
      <div className="grid gap-5 md:grid-cols-2">
        <Panel title="Claude · 5-hour window" aside={`read ${u.readAt}`}>
          <Big value={u.five.used} />
          <Meter value={u.five.used} label="5-hour window" />
          <p className="mt-2 text-[13px] text-mute">Resets at {u.five.resets}. A job starts only if the window's used share plus its expected cost stays at or under 100%.</p>
        </Panel>
        <Panel title="Claude · this week" aside={`read ${u.readAt}`}>
          <Big value={u.week.used} />
          <Meter value={u.week.used} reserve={reserve} label="Week" />
          <p className="mt-2 text-[13px] text-mute">
            Resets {u.week.resets}. The last <b className="font-semibold text-you">{reserve}%</b> stays yours until <b className="font-semibold text-ink-2">{u.week.releaseAt}</b>, 24 hours before the reset; after that jobs may use it.
          </p>
        </Panel>
      </div>

      <Panel title="What the gate expects each job to cost" aside="share of each window" pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[460px] text-[13.5px]">
            <thead>
              <tr className="border-b border-line-2 text-left text-[12.5px] text-mute">
                <th className="px-4 py-2 font-medium sm:px-5">Job kind</th>
                <th className="px-3 py-2 text-right font-medium">5-hour</th>
                <th className="px-3 py-2 text-right font-medium">Week</th>
                <th className="px-4 py-2 font-medium sm:px-5">From</th>
              </tr>
            </thead>
            <tbody>
              {u.costs.map((c) => (
                <tr key={c.kind} className="border-b border-line-2 last:border-0">
                  <td className="px-4 py-2 font-medium sm:px-5">{c.kind}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.five}%</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.week}%</td>
                  <td className="px-4 py-2 text-mute sm:px-5">{c.source === "learned" ? `largest of the last 5 (${c.n} jobs)` : `cautious default (${c.n} of 3 jobs needed)`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line-2 px-4 py-3 text-[12.5px] text-mute sm:px-5">
          Measured as the window's change before and after each job, in whole percents. Your own Claude sessions in the same window count too, so these err high.
        </p>
      </Panel>

      <Panel title="Sol">
        <div className="flex flex-wrap items-center gap-3">
          {u.sol.available ? <Chip tone="ok">Available</Chip> : <Chip tone="warn">Out of usage until {u.sol.until}</Chip>}
          <p className="text-[13.5px] text-ink-2">
            {u.sol.available
              ? "Sol isn't gated and keeps no reserve. When it runs out, the review counts for nothing and the PR is reviewed afresh once Sol is back."
              : `${u.sol.source}. Reviews and merges wait until then.`}
          </p>
        </div>
      </Panel>
    </div>
  );
}

function Big({ value }: { value: number | null }) {
  return (
    <p className="mb-3 flex items-baseline gap-1.5">
      <span className="text-[34px] font-semibold leading-none tracking-[-0.03em] tabular-nums">{value === null ? "–" : value}</span>
      <span className="text-[14px] text-mute">{value === null ? "unknown" : "% used"}</span>
    </p>
  );
}

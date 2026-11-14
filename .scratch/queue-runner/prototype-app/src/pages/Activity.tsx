import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { A, Chip, Empty } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useScoped, useStore } from "@/store";
import type { ActivityRow } from "@/data/types";

const WHO: Record<ActivityRow["actor"], [string, string]> = {
  claude: ["Claude", "bg-builder"],
  sol: ["Sol", "bg-reviewer"],
  runner: ["Runner", "bg-ink-2"],
  you: ["You", "bg-you"],
  github: ["GitHub", "bg-faint"],
};

export function ActivityList({ rows, showRepo, expandable }: { rows: ActivityRow[]; showRepo: boolean; expandable?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!rows.length) return <div className="p-4 sm:p-5"><Empty title="No activity in this scope yet" /></div>;
  let day = "";
  return (
    <ul>
      {rows.map((r, i) => {
        const header = r.day !== day ? (day = r.day) : null;
        return (
          <li key={i}>
            {header && <p className="border-b border-line-2 bg-page/70 px-4 py-1.5 text-[12px] font-medium text-mute sm:px-5">{header}</p>}
            <div className="border-b border-line-2 last:border-0">
              <button type="button" disabled={!expandable} onClick={() => setOpen(open === i ? null : i)} className={cn("flex w-full items-start gap-3 px-4 py-2.5 text-left sm:px-5", expandable && "hover:bg-page")}>
                <span className="w-11 shrink-0 pt-px text-[12.5px] tabular-nums text-mute">{r.at}</span>
                <span className={cn("mt-[7px] size-2 shrink-0 rounded-full", WHO[r.actor][1])} title={WHO[r.actor][0]} />
                <span className="min-w-0 flex-1 text-[13.5px]">
                  {r.text}
                  {showRepo && <span className="ml-2 text-[12.5px] text-mute">{r.repo}</span>}
                </span>
                {expandable && <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-faint transition-transform", open === i && "rotate-90")} />}
              </button>
              {expandable && open === i && (
                <dl className="mx-4 mb-3 grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 rounded-lg bg-page px-3 py-2 text-[12.5px] sm:mx-5 sm:ml-[84px]">
                  <dt className="text-mute">Who</dt><dd>{WHO[r.actor][0]}</dd>
                  <dt className="text-mute">Job kind</dt><dd>{r.kind}</dd>
                  <dt className="text-mute">Outcome</dt><dd><code className="font-mono">{r.outcome}</code> <span className="text-mute">as in jobs.jsonl</span></dd>
                  {r.href && <><dt className="text-mute">Item</dt><dd><A to={r.href} className="font-medium underline-offset-2 hover:underline">{r.ref} history</A></dd></>}
                </dl>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const FILTERS = [["all", "All"], ["claude", "Claude"], ["sol", "Sol"], ["you", "You"], ["runner", "Runner"]] as const;

export function Activity() {
  const { repo } = useStore();
  const { activity } = useScoped();
  const [f, setF] = useState<string>("all");
  const rows = activity.filter((r) => f === "all" || r.actor === f);
  return (
    <div className="max-w-[860px] space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line bg-surface p-0.5 text-[13px]" role="group" aria-label="Who">
          {FILTERS.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={f === k} onClick={() => setF(k)} className={cn("rounded-md px-3 py-1 font-medium", f === k ? "bg-ink text-white" : "text-mute hover:text-ink")}>{l}</button>
          ))}
        </div>
        <Chip className="ml-auto">{rows.length} events</Chip>
      </div>
      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <ActivityList rows={rows} showRepo={repo === null} expandable />
      </section>
      <p className="text-[12.5px] text-mute">A failed attempt stays here even when a later one recovered it. Click a row for the job log's own outcome.</p>
    </div>
  );
}

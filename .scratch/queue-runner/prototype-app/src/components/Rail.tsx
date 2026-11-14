// The always-visible right side: both providers' usage, how the runner is connected, and what
// happened since you last looked (the one question an activity feed answers for you).
import { ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";
import { cn } from "@/lib/cn";
import { useScoped, useStore } from "@/store";
import type { DigestRow } from "@/data/types";
import { Dot, Section, UsageBar } from "./ui";

export function Rail() {
  return (
    <div className="space-y-2">
      <Usage />
      <SinceYouLooked />
      <Connections />
    </div>
  );
}

function Usage() {
  const { world } = useStore();
  const { claude, chatgpt } = world.usage;
  return (
    <Section title="Usage" aside={<span className="text-[11.5px] text-faint">account-wide</span>}>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <p className="flex items-baseline gap-1.5 text-[12.5px]"><span className="font-semibold text-builder">Claude</span><span className="text-faint">builds · read {claude.readAt}</span></p>
          {claude.error && <p className="text-[12px] text-bad">{claude.error}</p>}
          <UsageBar label="5h" used={claude.five.used} resets={claude.five.resets} color="bg-builder" />
          <UsageBar label="Week" used={claude.week.used} resets={claude.week.resets} reserve={world.runner.reserve} color="bg-builder" />
          <p className="text-[11.5px] text-mute">Your {world.runner.reserve}% opens to the runner {claude.releaseAt}</p>
        </div>
        <div className="space-y-1.5 border-t border-line-2 pt-2.5">
          <p className="flex items-baseline gap-1.5 text-[12.5px]"><span className="font-semibold text-reviewer">ChatGPT</span><span className="text-faint">Sol's reviews · read {chatgpt.readAt}</span></p>
          <UsageBar label="5h" used={chatgpt.five.used} resets={chatgpt.five.resets} color="bg-reviewer" />
          <UsageBar label="Week" used={chatgpt.week.used} resets={chatgpt.week.resets} color="bg-reviewer" />
        </div>
      </div>
    </Section>
  );
}

const GROUP: Record<DigestRow["group"], string> = { merged: "merged", reviewed: "reviewed", built: "built", stopped: "stopped for you", recovered: "recovered" };
const ACTOR_DOT: Record<DigestRow["actor"], string> = { claude: "bg-builder", sol: "bg-reviewer", runner: "bg-ink-2", you: "bg-you", github: "bg-faint" };

function SinceYouLooked() {
  const { world, openPr, repo } = useStore();
  const { digest } = useScoped();
  const [all, setAll] = useState(false);
  const counts = Object.entries(digest.reduce<Record<string, number>>((m, r) => ((m[r.group] = (m[r.group] ?? 0) + 1), m), {}));
  const rows = all ? digest : digest.slice(0, 5);
  return (
    <Section title={`Since ${world.digest.since}`} aside={<span className="text-[11.5px] text-faint">your last visit</span>} flush>
      <p className="px-3 pt-2 text-[12.5px] text-ink-2">
        {counts.length ? counts.map(([g, n], i) => <span key={g}>{i > 0 && ", "}<b className="font-semibold">{n}</b> {GROUP[g as DigestRow["group"]]}</span>) : "Nothing happened."}
      </p>
      <ul className="py-1.5">
        {rows.map((r, i) => (
          <li key={i}>
            <button type="button" disabled={!r.pr} onClick={() => r.pr && openPr(r.repo, r.pr)} className="flex w-full items-start gap-2 px-3 py-1 text-left text-[12.5px] enabled:hover:bg-sunk">
              <span className="w-9 shrink-0 tabular-nums text-faint">{r.at}</span>
              <Dot className={cn("mt-[5px]", ACTOR_DOT[r.actor])} />
              <span className="min-w-0 flex-1">{r.text}{repo === null && <span className="text-faint"> · {r.repo}</span>}</span>
            </button>
          </li>
        ))}
      </ul>
      {digest.length > 5 && (
        <button type="button" onClick={() => setAll(!all)} className="w-full border-t border-line-2 py-1.5 text-[12px] font-medium text-mute hover:text-ink">{all ? "Fewer" : `All ${digest.length}`}</button>
      )}
    </Section>
  );
}

function Connections() {
  const { world } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Section title="Connections" flush>
      <ul className="divide-y divide-line-2">
        {world.connections.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-sunk">
              <Dot className={c.ok ? "bg-ok" : "bg-bad"} />
              <span className="text-[12.5px] font-medium">{c.name}</span>
              <span className="truncate text-[12px] text-faint">{c.role}</span>
              <span className={cn("ml-auto truncate text-[12px]", c.ok ? "text-mute" : "font-medium text-bad")}>{c.status}</span>
              <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", open === c.id && "rotate-90")} />
            </button>
            {open === c.id && (
              <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-0.5 px-3 pb-2 pl-7 text-[12px]">
                {c.how.map(([k, v]) => <Fragment key={k}><dt className="text-faint">{k}</dt><dd className="break-words font-mono text-[11.5px] text-ink-2">{v}</dd></Fragment>)}
              </dl>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

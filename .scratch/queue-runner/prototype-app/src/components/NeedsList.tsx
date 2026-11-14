// Needs you as a list: one row per ask, most urgent first; click a row for the why and the reply words.
// Opening its link doesn't clear it: the runner does, once it sees the answer.
import { ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { useScoped, useStore } from "@/store";
import type { Ask } from "@/data/types";
import { Section } from "./ui";

const KIND: Record<Ask["kind"], string> = { merge: "Merge", decide: "Decide", answer: "Answer", live: "Live", repair: "Repair" };

export function NeedsList() {
  const { world, repo, setRepo } = useStore();
  const { asks, otherAsks } = useScoped();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Section
      title="Needs you"
      count={asks.length}
      flush
      className={asks.length ? "border-you-line" : undefined}
      aside={repo && otherAsks.length > 0 && (
        <button type="button" onClick={() => setRepo(null)} className="rounded px-1.5 text-[12px] font-medium text-you hover:bg-you-soft">+{otherAsks.length} in other repos</button>
      )}
    >
      {asks.length === 0 ? (
        <p className="px-3 py-2.5 text-[12.5px] text-mute">{world.runner.github.ok ? "Nothing. The runner carries on by itself." : "Nothing seen, but GitHub is unreadable: some may be missing."}</p>
      ) : (
        <ul className="divide-y divide-line-2">
          {asks.map((a) => <Row key={a.id} a={a} open={open === a.id} toggle={() => setOpen(open === a.id ? null : a.id)} showRepo={repo === null} />)}
        </ul>
      )}
    </Section>
  );
}

function Row({ a, open, toggle, showRepo }: { a: Ask; open: boolean; toggle: () => void; showRepo: boolean }) {
  const { opened, markOpened, openPr } = useStore();
  return (
    <li>
      <div className="flex min-h-10 items-center gap-2 pl-3 pr-2">
        <button type="button" onClick={toggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left">
          <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
          <span className="w-12 shrink-0 text-[12px] font-semibold text-you">{KIND[a.kind]}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{a.title}</span>
          <span className="hidden shrink-0 text-[12px] text-mute sm:inline">{showRepo ? `${a.repo} ` : ""}{a.ref}</span>
          {a.unblocks ? <span className="hidden shrink-0 text-[12px] text-mute md:inline">· unblocks {a.unblocks}</span> : null}
          <span className="w-8 shrink-0 text-right text-[12px] tabular-nums text-faint">{a.since}</span>
        </button>
        <button
          type="button"
          onClick={() => { markOpened(a.id); toast(`Would open: ${a.action}`, { description: "Stays in Needs you until the runner sees your answer." }); }}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-you px-2.5 text-[12.5px] font-medium text-white hover:brightness-110"
        >
          {a.action}<ExternalLink className="size-3 opacity-75" />
        </button>
      </div>
      {open && (
        <div className="space-y-2 pb-3 pl-[34px] pr-3 text-[12.5px]">
          <ul className="space-y-0.5 text-ink-2">{a.why.map((w) => <li key={w}>{w}</li>)}</ul>
          {a.options && (
            <div className="flex flex-wrap gap-1.5">
              {a.options.map((o) => (
                <span key={o.label} title={o.means} className={cn("rounded border px-1.5 py-0.5", o.recommended ? "border-you-line bg-you-soft" : "border-line")}>
                  <code className="font-mono font-semibold">{o.label}</code> <span className="text-mute">{o.means}</span>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-3 text-mute">
            {a.pr && <button type="button" onClick={() => openPr(a.repo, a.pr!)} className="font-medium text-ink hover:underline">PR history</button>}
            {opened.has(a.id) && <span>Opened; still open until answered.</span>}
          </div>
        </div>
      )}
    </li>
  );
}

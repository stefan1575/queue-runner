// A PR's history in a drawer: current head and what happens next, then the timeline grouped by the
// head each step acted on, so every review is tied to its commit.
import * as Dialog from "@radix-ui/react-dialog";
import { Check, CircleDashed, GitCommitHorizontal, X } from "lucide-react";
import { KIND_ICON } from "@/components/Lanes";
import { Chip, Sha } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useStore } from "@/store";
import type { PR, TEvent } from "@/data/types";

const ACTOR: Record<TEvent["actor"], [string, string]> = {
  claude: ["Claude", "bg-builder"],
  sol: ["Sol", "bg-reviewer"],
  runner: ["Runner", "bg-ink-2"],
  you: ["You", "bg-you"],
  github: ["GitHub", "bg-faint"],
};

export function PrDrawer() {
  const { world, pr: sel, closePr } = useStore();
  const pr = sel && world.prs.find((p) => p.repo === sel[0] && p.n === sel[1]);
  return (
    <Dialog.Root open={!!sel} onOpenChange={(o) => !o && closePr()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <Dialog.Content className="sheet-in fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col overflow-y-auto border-l border-line bg-surface shadow-2xl" aria-describedby={undefined}>
          {pr ? <Body pr={pr} /> : <div className="p-4"><Dialog.Title>Not in this demo state</Dialog.Title></div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Body({ pr }: { pr: PR }) {
  const { world } = useStore();
  const repo = world.repos.find((r) => r.id === pr.repo)!;
  const groups: { sha: string; events: TEvent[] }[] = [];
  for (const e of pr.timeline) {
    const last = groups[groups.length - 1];
    if (last && last.sha === e.sha) last.events.push(e);
    else groups.push({ sha: e.sha ?? "", events: [e] });
  }
  const heads = [...new Set(pr.timeline.filter((e) => e.kind !== "live" && e.kind !== "merge").map((e) => e.sha))];

  return (
    <>
      <div className="sticky top-0 z-10 border-b border-line bg-surface px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] text-mute">{pr.repo} · PR #{pr.n} · closes #{pr.issue}</p>
            <Dialog.Title className="truncate text-[17.5px] font-semibold">{pr.title}</Dialog.Title>
          </div>
          <Dialog.Close className="rounded p-1 text-faint hover:bg-sunk hover:text-ink" aria-label="Close"><X className="size-4" /></Dialog.Close>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[14.5px]">
          {pr.held ? <Chip tone="you">Held</Chip> : <Chip>{pr.gate ?? pr.phase.replace("-", " ")}</Chip>}
          {pr.live && <Chip tone={pr.live === "live" ? "ok" : pr.live === "needs-attention" ? "you" : "info"}>{pr.live === "pending" ? "live steps after merge" : pr.live === "needs-attention" ? "live needs you" : pr.live}</Chip>}
          <span className="text-mute">head <Sha className="text-ink-2">{pr.head}</Sha></span>
          <span className="truncate font-mono text-[14px] text-faint">{pr.branch}</span>
        </div>
        <p className={cn("mt-2 rounded-md px-2.5 py-1.5 text-[15px]", pr.held ? "bg-you-soft text-ink" : "bg-sunk text-ink-2")}>
          {pr.held && <b className="font-semibold text-you">{pr.held}. </b>}{pr.next}
        </p>
      </div>

      {pr.phase === "ready" && <Gate pr={pr} merge={repo.merge} />}

      <ol className="px-4 py-3">
        {groups.map((g, gi) => {
          const merged = g.events.every((e) => e.kind === "live");
          const current = g.sha === pr.head && !merged;
          return (
            <li key={gi} className="relative pb-3 last:pb-0">
              {gi < groups.length - 1 && <span className="absolute bottom-0 left-[9px] top-5 w-px bg-line" aria-hidden />}
              <div className="flex items-center gap-2">
                <span className={cn("relative z-10 flex size-[19px] items-center justify-center rounded-full border", current ? "border-ink bg-ink text-surface" : "border-line bg-surface text-faint")}>
                  <GitCommitHorizontal className="size-3" />
                </span>
                <Sha className={cn("text-[14.5px]", current && "font-semibold text-ink")}>{g.sha}</Sha>
                <span className="text-[14px] text-faint">{merged ? "merge commit" : `head ${heads.indexOf(g.sha) + 1}${current ? " · current" : ""}`}</span>
              </div>
              <ul className="ml-[27px] mt-1 space-y-1">{g.events.map((e, i) => <Event key={i} e={e} />)}</ul>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function Event({ e }: { e: TEvent }) {
  const Icon = (KIND_ICON as Record<string, typeof Check>)[e.kind];
  const [name, dot] = ACTOR[e.actor];
  const text = e.tone === "bad" ? "text-bad" : e.tone === "ok" ? "text-ok" : e.tone === "you" ? "text-you" : e.tone === "warn" ? "text-warn" : "text-ink";
  return (
    <li className="rounded-md border border-line-2 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 text-[15px]">
        <span className={cn("size-1.5 rounded-full", dot, e.running && "live-dot")} />
        <span className="text-mute">{name}</span>
        {Icon && <Icon className="size-3 text-faint" />}
        <span className={cn("min-w-0 truncate font-medium", text)}>{e.title}</span>
        <span className="ml-auto shrink-0 text-[14px] text-faint">{e.at}</span>
      </div>
      {e.detail && <p className="mt-0.5 text-[14.5px] text-mute">{e.detail}</p>}
      {e.findings && (
        <ul className="mt-1 space-y-0.5">
          {e.findings.map((f) => (
            <li key={f.id} className="flex items-baseline gap-1.5 text-[14.5px]">
              <code className="font-mono text-[13.5px] font-semibold">{f.id}</code>
              <span className="min-w-0 flex-1 truncate text-ink-2" title={`${f.text}${f.where ? ` (${f.where})` : ""}`}>{f.text}</span>
              <Chip tone={f.status === "open" ? "bad" : f.status === "fixed" ? "ok" : "info"} className="h-4 px-1 text-[10.5px]">{f.status}</Chip>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Gate({ pr, merge }: { pr: PR; merge: "stefan" | "runner" }) {
  const pending = pr.gate?.includes("checks");
  const items: [string, boolean][] = [
    [`Clean on ${pr.head}`, true],
    [`Checks passed on ${pr.head}`, !pending],
    ["No conflict", true],
    ["Nothing said since", true],
    ["No job writing to it", true],
  ];
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 border-b border-line-2 px-4 py-2 text-[14.5px]">
      <span className="font-medium">{merge === "stefan" ? "You merge when:" : "Runner merges when:"}</span>
      {items.map(([t, ok]) => (
        <span key={t} className={cn("inline-flex items-center gap-1", ok ? "text-mute" : "font-medium text-warn")}>
          {ok ? <Check className="size-3 text-ok" /> : <CircleDashed className="size-3" />}{t}
        </span>
      ))}
    </div>
  );
}

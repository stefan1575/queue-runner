// The two lanes, side by side: what each is doing, what it does next, the gates that decide whether
// it may start its next job, and your stop/resume control. A job (build, fix round, review...) is the
// smallest unit the runner has, so "after this job" is the gentle stop.
import * as Popover from "@radix-ui/react-popover";
import { Check, CirclePause, Hammer, MessageSquareText, Play, Rocket, ScanSearch, Split, Wrench, X, GitPullRequest } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { useStore } from "@/store";
import type { JobKind, Lane } from "@/data/types";
import { Button, Chip, Dot, Sha } from "./ui";

export const KIND_ICON: Record<JobKind, typeof Hammer> = { build: Hammer, fix: Wrench, conflict: Split, decision: MessageSquareText, live: Rocket, review: ScanSearch, merge: GitPullRequest };
const KIND_WORD: Record<JobKind, string> = { build: "Build", fix: "Fix round", conflict: "Conflict round", decision: "Decision", live: "Live steps", review: "Review", merge: "Merge" };

const STATUS: Record<Lane["status"], [string, Parameters<typeof Chip>[0]["tone"]]> = {
  working: ["Working", "ok"],
  idle: ["Idle", "info"],
  waiting: ["Waiting", "warn"],
  stopping: ["Stopping after this job", "you"],
  stopped: ["Stopped by you", "you"],
  unavailable: ["Unavailable", "bad"],
};

export function Lanes() {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      <LaneRow which="claude" role="Builder" who="Claude" unit="job" />
      <LaneRow which="sol" role="Reviewer" who="Sol" unit="review" />
    </div>
  );
}

function LaneRow({ which, role, who, unit }: { which: "claude" | "sol"; role: string; who: string; unit: string }) {
  const { world, setWorld, openPr } = useStore();
  const lane = world[which];
  const Icon = lane.job ? KIND_ICON[lane.job.kind] : null;
  const color = which === "claude" ? "text-builder" : "text-reviewer";
  const bar = which === "claude" ? "bg-builder" : "bg-reviewer";
  const [label, tone] = STATUS[lane.status];
  const stale = world.runner.process === "stopped";

  return (
    <section className="relative min-w-0 overflow-hidden rounded-lg border border-line bg-surface" aria-label={`${role} lane`}>
      <span className={cn("absolute inset-y-0 left-0 w-[3px]", lane.status === "working" || lane.status === "stopping" ? bar : "bg-line")} />
      <div className="flex h-9 items-center gap-2 border-b border-line-2 pl-3.5 pr-2">
        <span className="text-[13px] font-semibold">{role}</span>
        <span className={cn("text-[12.5px] font-medium", color)}>{who}</span>
        <Chip tone={tone} className="ml-1">{stale ? "Last known · " : ""}{label}{lane.until ? ` until ${lane.until}` : ""}</Chip>
        <div className="ml-auto"><StopMenu which={which} lane={lane} unit={unit} setWorld={setWorld} /></div>
      </div>
      <div className="space-y-2 py-2.5 pl-3.5 pr-3">
        <div className="flex items-start gap-2.5">
          <span className={cn("mt-px flex size-6 shrink-0 items-center justify-center rounded", lane.job ? (which === "claude" ? "bg-builder-soft" : "bg-reviewer-soft") : "bg-sunk")}>
            {Icon ? <Icon className={cn("size-3.5", color)} /> : <Dot className="bg-faint" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium" title={lane.headline}>{lane.headline}</p>
            {lane.job && (
              <p className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-mute">
                <span>{KIND_WORD[lane.job.kind]}</span>·<span>{lane.job.repo}</span>
                {lane.job.sha && <Sha>{lane.job.sha}</Sha>}·<span className="tabular-nums">{lane.job.minutes} min</span>
                {lane.job.pr && <button type="button" onClick={() => openPr(lane.job!.repo, lane.job!.pr!)} className="font-medium text-ink hover:underline">PR history</button>}
                {lane.job.thread && <button type="button" onClick={() => toast("Would open the T3 thread", { description: lane.job!.thread })} className="font-medium text-ink hover:underline">Thread</button>}
              </p>
            )}
          </div>
        </div>
        <p className="truncate text-[12px] text-mute" title={lane.next}><span className="text-faint">Next </span>{lane.next}</p>
        <div className="flex flex-wrap gap-1">
          {lane.gates.map((g) => (
            <span key={g.label} title={g.note} className={cn("inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11.5px]", g.ok ? "bg-sunk text-mute" : "bg-warn-soft font-medium text-warn")}>
              {g.ok ? <Check className="size-3" /> : <X className="size-3" />}
              {!g.ok && g.label === "Not stopped" ? g.note : g.label}
              {!g.ok && g.note && g.label !== "Not stopped" && <span className="font-normal">: {g.note}</span>}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function StopMenu({ which, lane, unit, setWorld }: { which: "claude" | "sol"; lane: Lane; unit: string; setWorld: ReturnType<typeof useStore>["setWorld"] }) {
  const [open, setOpen] = useState(false);
  const name = which === "claude" ? "Claude" : "Sol";
  const setGate = (l: Lane, ok: boolean, note?: string) => { const g = l.gates.find((x) => x.label === "Not stopped"); if (g) { g.ok = ok; g.note = note; } };

  if (lane.status === "stopped" || lane.status === "stopping") {
    return (
      <Button onClick={() => {
        setWorld((w) => { const l = w[which]; l.status = l.job ? "working" : "idle"; if (!l.job) { l.headline = "Looking for its next job"; } setGate(l, true); });
        toast(`${name} resumed`);
      }}><Play className="size-3.5" />Resume</Button>
    );
  }
  const can = lane.status === "working";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-mute hover:bg-sunk hover:text-ink data-[state=open]:bg-sunk">
        <CirclePause className="size-3.5" />Stop
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} className="z-50 w-64 rounded-lg border border-line bg-surface p-1 shadow-lg">
          <MenuItem title={`After this ${unit}`} sub={can ? `${lane.job?.ref} finishes, then nothing new starts` : "Nothing new starts"} onClick={() => {
            setWorld((w) => { const l = w[which]; if (l.job) { l.status = "stopping"; l.next = "Then stops"; } else { l.status = "stopped"; l.headline = "Stopped by you"; } setGate(l, false, `Stopped by you`); });
            setOpen(false); toast(`${name} stops after this ${unit}`);
          }} />
          <MenuItem danger title="Now" sub={can ? (which === "claude" ? `Interrupts ${lane.job?.ref}'s thread; its branch stays` : `Cuts the review off; ${lane.job?.ref} is reviewed afresh later`) : "Nothing is running"} disabled={!can} onClick={() => {
            setWorld((w) => { const l = w[which]; l.status = "stopped"; l.headline = `Stopped by you during ${l.job?.ref}`; l.next = which === "claude" ? "Resume continues the same thread" : "Resume reviews the PR afresh"; l.job = undefined; setGate(l, false, "Stopped by you"); });
            setOpen(false); toast(`${name} stopped`);
          }} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function MenuItem({ title, sub, onClick, danger, disabled }: { title: string; sub: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-sunk disabled:opacity-45 disabled:hover:bg-transparent">
      <span className={cn("block text-[13px] font-medium", danger && "text-bad")}>{title}</span>
      <span className="block text-[12px] text-mute">{sub}</span>
    </button>
  );
}

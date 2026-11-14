import { ArrowUpRight, CornerDownRight, ExternalLink, GitPullRequest, Hammer, MessageSquareText, Rocket, ScanSearch, Split, Wrench } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { useStore } from "@/store";
import type { Ask, Issue, JobKind, Lane, PR } from "@/data/types";
import { A, Button, Chip, Sha } from "./ui";

export const KIND_ICON: Record<JobKind, typeof Hammer> = {
  build: Hammer,
  fix: Wrench,
  conflict: Split,
  decision: MessageSquareText,
  live: Rocket,
  review: ScanSearch,
  merge: GitPullRequest,
};
const KIND_WORD: Record<JobKind, string> = { build: "Build", fix: "Fix round", conflict: "Conflict round", decision: "Decision", live: "Live steps", review: "Review", merge: "Merge" };

const STATUS_WORD: Record<Lane["status"], string> = { working: "Working", idle: "Idle", waiting: "Waiting", paused: "Paused", unavailable: "Unavailable" };

export function LaneCard({ role, model, lane, color, paused, stale }: { role: string; model: string; lane: Lane; color: "builder" | "reviewer"; paused?: boolean; stale?: boolean }) {
  const Icon = lane.job ? KIND_ICON[lane.job.kind] : null;
  const accent = color === "builder" ? "text-builder" : "text-reviewer";
  const soft = color === "builder" ? "bg-builder-soft" : "bg-reviewer-soft";
  const bar = color === "builder" ? "bg-builder" : "bg-reviewer";
  const statusTone = lane.status === "working" ? (color === "builder" ? "run" : "ok") : lane.status === "waiting" ? "warn" : lane.status === "unavailable" ? "bad" : "info";
  return (
    <section className="relative min-w-0 overflow-hidden rounded-xl border border-line bg-surface" aria-label={`${role} lane`}>
      <div className={cn("absolute inset-y-0 left-0 w-1", lane.status === "working" ? bar : "bg-line")} />
      <div className="py-4 pl-5 pr-4 sm:pr-5">
        <div className="flex items-center gap-2">
          <h3 className="text-[15px] font-semibold tracking-tight">{role}</h3>
          <span className={cn("text-[13px] font-medium", accent)}>{model}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {paused && <Chip tone="you">New jobs paused</Chip>}
            <Chip tone={statusTone}>{stale ? "Last known: " : ""}{STATUS_WORD[lane.status]}{lane.until ? ` until ${lane.until}` : ""}</Chip>
          </span>
        </div>
        <div className="mt-3 flex items-start gap-3">
          <span className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg", lane.job ? soft : "bg-line-2")}>
            {Icon ? <Icon className={cn("size-[18px]", accent)} /> : <span className="size-2 rounded-full bg-faint" />}
          </span>
          <div className="min-w-0">
            <p className="text-[15.5px] font-medium leading-snug">{lane.headline}</p>
            {lane.job && (
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-mute">
                <span>{KIND_WORD[lane.job.kind]}</span>
                <span className="text-faint">in</span>
                <span className="text-ink-2">{lane.job.repo}</span>
                {lane.job.sha && <Sha>{lane.job.sha}</Sha>}
                <span className="text-faint">·</span>
                <span>since {lane.job.since}, {lane.job.elapsed}</span>
              </p>
            )}
          </div>
        </div>
        <p className="mt-3 flex gap-2 border-t border-line-2 pt-3 text-[13px] text-ink-2">
          <CornerDownRight className="mt-0.5 size-3.5 shrink-0 text-faint" />
          <span>{lane.next}</span>
        </p>
        {lane.job && (
          <div className="mt-3 flex flex-wrap gap-2">
            {lane.job.href && <A to={lane.job.href} className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2.5 text-[12.5px] font-medium hover:bg-page">Open {lane.job.ref}</A>}
            {lane.job.thread && (
              <button type="button" onClick={() => toast("Would open the T3 thread", { description: lane.job!.thread })} className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2.5 text-[12.5px] font-medium hover:bg-page">
                Thread in T3 <ArrowUpRight className="size-3.5 text-faint" />
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const ASK_WORD: Record<Ask["kind"], string> = { merge: "Merge", decide: "Decide", answer: "Answer", live: "Finish live steps", repair: "Repair" };

export function AskCard({ ask, compact }: { ask: Ask; compact?: boolean }) {
  const { opened, markOpened, path } = useStore();
  const wasOpened = opened.has(ask.id);
  const open = () => {
    markOpened(ask.id);
    toast(`Would open ${ask.action.where}`, { description: "The ask stays here until the runner sees your answer or merge." });
  };
  return (
    <article className="min-w-0 rounded-xl border border-you-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-you-line/60 bg-you-soft/50 px-4 py-2 text-[12.5px] sm:px-5">
        <span className="font-semibold text-you">{ASK_WORD[ask.kind]}</span>
        <span className="text-ink-2">{ask.repo}</span>
        {ask.prHref ? <A to={ask.prHref} className="font-medium text-ink underline-offset-2 hover:underline">{ask.ref}</A> : <span className="font-medium">{ask.ref}</span>}
        <span className="ml-auto text-mute">{ask.since} ago</span>
      </div>
      <div className="px-4 py-4 sm:px-5">
        <h3 className="text-[15.5px] font-semibold leading-snug tracking-tight">{ask.title}</h3>
        <ul className="mt-2 space-y-1 text-[13.5px] text-ink-2">
          {ask.why.slice(0, compact ? 1 : undefined).map((w) => (
            <li key={w} className="flex gap-2"><span className="mt-[9px] size-1 shrink-0 rounded-full bg-faint" />{w}</li>
          ))}
        </ul>
        {!compact && ask.options && (
          <div className="mt-3 overflow-hidden rounded-lg border border-line">
            <p className="border-b border-line-2 bg-page px-3 py-1.5 text-[12.5px] text-mute">Start your reply with one of these; the runner reads the first words.</p>
            {ask.options.map((o) => (
              <div key={o.label} className="flex gap-3 border-b border-line-2 px-3 py-2 last:border-0">
                <code className="w-14 shrink-0 font-mono text-[12.5px] font-semibold">{o.label}</code>
                <span className="text-[13px] text-ink-2">{o.means}{o.recommended && <span className="ml-1.5 text-you">· the note recommends this</span>}</span>
              </div>
            ))}
          </div>
        )}
        {!compact && ask.blocks && <p className="mt-3 text-[13px] text-mute">Holding up: <span className="text-ink-2">{ask.blocks.join(", ")}</span></p>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="you" onClick={open}>{ask.action.label} <ExternalLink className="size-3.5 opacity-80" /></Button>
          {ask.prHref && !compact && path !== ask.prHref && <A to={ask.prHref} className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium text-mute hover:bg-line-2 hover:text-ink">PR history</A>}
          {wasOpened && <span className="text-[12.5px] text-mute">Opened. Still open until the runner sees your {ask.kind === "merge" ? "merge" : "answer"}.</span>}
        </div>
      </div>
    </article>
  );
}

const ISSUE_CHIP: Record<Issue["state"], [string, Parameters<typeof Chip>[0]["tone"]]> = {
  ready: ["Ready", "ok"],
  "in-progress": ["In progress", "run"],
  blocked: ["Blocked", "info"],
  held: ["Held", "you"],
  "not-ready": ["Not ready", "info"],
  done: ["Done", "info"],
};

export function IssueRow({ issue, position, onOpen, showRepo }: { issue: Issue; position?: number; onOpen: (i: Issue) => void; showRepo: boolean }) {
  const { world } = useStore();
  const [label, tone] = ISSUE_CHIP[issue.state];
  const blockers = (issue.blockedBy ?? []).map((k) => {
    const [r, n] = k.split("#");
    return world.issues.find((i) => i.repo === r && i.n === Number(n));
  });
  return (
    <button type="button" onClick={() => onOpen(issue)} className="flex w-full min-w-0 items-start gap-3 px-4 py-3 text-left hover:bg-page sm:px-5">
      <span className={cn("mt-px flex size-6 shrink-0 items-center justify-center rounded-md text-[12px] font-semibold tabular-nums", position ? "bg-ink text-white" : "bg-line-2 text-faint")}>
        {position ?? "–"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{issue.title}</span>
          <span className="text-[12.5px] text-mute">{showRepo ? `${issue.repo} ` : ""}#{issue.n}</span>
        </span>
        {(issue.reason || blockers.length > 0) && (
          <span className="mt-0.5 block text-[13px] text-mute">
            {blockers.length > 0 ? <>Waits on {blockers.map((b, i) => <span key={i}>{i > 0 && " and "}<span className="text-ink-2">#{b?.n} {b?.title}</span>{b?.state === "held" ? " (waiting on you)" : ""}</span>)}</> : issue.reason}
          </span>
        )}
      </span>
      <Chip tone={tone} className="mt-0.5">{label}</Chip>
    </button>
  );
}

export function PhaseChip({ pr }: { pr: PR }) {
  if (pr.held) return <Chip tone="you">Held</Chip>;
  const m: Record<PR["phase"], [string, Parameters<typeof Chip>[0]["tone"]]> = {
    building: ["Building", "run"],
    "awaiting-review": ["Awaiting review", "info"],
    reviewing: ["Reviewing", "ok"],
    fixing: ["Fixing", "run"],
    ready: [pr.gate ?? "Ready", pr.gate?.startsWith("Ready for your") ? "you" : "ok"],
    merging: ["Merging", "ok"],
    merged: ["Merged", "info"],
    closed: ["Closed", "info"],
  };
  const [l, t] = m[pr.phase];
  return <Chip tone={t}>{l}</Chip>;
}

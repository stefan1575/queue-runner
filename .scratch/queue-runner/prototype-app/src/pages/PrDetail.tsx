// A PR's story: identity and current head, what happens next, the one human action, then the
// timeline, grouped by the head each step acted on, so every review is tied to its commit.
import { Check, CircleDashed, ExternalLink, GitCommitHorizontal } from "lucide-react";
import { toast } from "sonner";
import { AskCard, KIND_ICON, PhaseChip } from "@/components/domain";
import { A, Button, Chip, Panel, Sha } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useStore } from "@/store";
import type { PR, TEvent } from "@/data/types";

const ACTOR: Record<TEvent["actor"], { name: string; dot: string }> = {
  claude: { name: "Claude", dot: "bg-builder" },
  sol: { name: "Sol", dot: "bg-reviewer" },
  runner: { name: "Runner", dot: "bg-ink-2" },
  you: { name: "You", dot: "bg-you" },
  github: { name: "GitHub", dot: "bg-faint" },
};

const LIVE_WORD: Record<NonNullable<PR["live"]>, [string, Parameters<typeof Chip>[0]["tone"]]> = {
  "not-required": ["No live steps", "info"],
  pending: ["Live steps after merge", "info"],
  running: ["Live steps running", "run"],
  live: ["Live", "ok"],
  "needs-attention": ["Live needs you", "you"],
  unknown: ["Live state unknown", "warn"],
  assumed: ["Live, assumed at first sight", "info"],
};

export function PrDetail({ repo, n }: { repo: string; n: number }) {
  const { world, setWorld } = useStore();
  const pr = world.prs.find((p) => p.repo === repo && p.n === n);
  if (!pr) return <Panel><p>No PR #{n} in {repo} in this demo state.</p></Panel>;
  const r = world.repos.find((x) => x.id === repo)!;
  const ask = world.asks.find((a) => a.id === pr.ask);

  // Group the timeline by head, in order.
  const groups: { sha: string; events: TEvent[] }[] = [];
  for (const e of pr.timeline) {
    const last = groups[groups.length - 1];
    if (last && last.sha === e.sha) last.events.push(e);
    else groups.push({ sha: e.sha ?? "", events: [e] });
  }
  const headShas = [...new Set(pr.timeline.filter((e) => e.kind !== "live").map((e) => e.sha))];

  const release = () => {
    setWorld((w) => {
      const p = w.prs.find((x) => x.repo === repo && x.n === n)!;
      p.held = undefined;
      p.next = `Released. Sol reviews ${p.head} on its next pass, as usual.`;
      p.timeline.push({ at: "Sat 14:41", actor: "you", kind: "hold", sha: p.head, tone: "info", title: `You released it (--release ${repo}#${n})` });
      return w;
    });
    toast.success(`Released PR #${n}`, { description: "It goes back through the normal checks; nothing is forced." });
  };

  return (
    <div className="max-w-[1100px] space-y-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-mute">
        <PhaseChip pr={pr} />
        {pr.live && <Chip tone={LIVE_WORD[pr.live][1]}>{LIVE_WORD[pr.live][0]}</Chip>}
        <span>head <Sha>{pr.head}</Sha></span>
        <span className="truncate font-mono text-[12px]">{pr.branch}</span>
        <span>{pr.commits} commits · {pr.files} files</span>
        <span>closes #{pr.issue}</span>
        <button type="button" onClick={() => toast("Would open the PR on GitHub")} className="inline-flex items-center gap-1 font-medium text-ink hover:underline">GitHub <ExternalLink className="size-3.5" /></button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          <section className={cn("rounded-xl border px-4 py-3.5 sm:px-5", pr.held ? "border-you-line bg-you-soft/50" : "border-line bg-surface")}>
            <p className="text-[12.5px] font-medium text-mute">{pr.held ? "Held" : "What happens next"}</p>
            {pr.held && <p className="mt-0.5 font-semibold text-you">{pr.held}</p>}
            <p className="mt-0.5 text-[14.5px] text-ink">{pr.next}</p>
            {pr.held && !ask && <Button className="mt-3" onClick={release}>Release hold</Button>}
          </section>

          {ask && <AskCard ask={ask} />}

          <Panel title="Timeline" aside={`${headShas.length} ${headShas.length === 1 ? "head" : "heads"}`}>
            <ol className="relative">
              {groups.map((g, gi) => {
                const isMerge = g.events.every((e) => e.kind === "live");
                const current = g.sha === pr.head && !isMerge;
                const headNo = headShas.indexOf(g.sha) + 1;
                return (
                  <li key={gi} className="relative pb-5 last:pb-0">
                    {gi < groups.length - 1 && <span className="absolute bottom-0 left-[13px] top-7 w-px bg-line" aria-hidden />}
                    <div className="flex items-center gap-3">
                      <span className={cn("relative z-10 flex size-[27px] items-center justify-center rounded-full border-2", current ? "border-ink bg-ink text-white" : "border-line bg-surface text-mute")}>
                        <GitCommitHorizontal className="size-3.5" />
                      </span>
                      <Sha className={cn("text-[12.5px]", current && "bg-ink text-white")}>{g.sha}</Sha>
                      <span className="text-[12.5px] text-mute">{isMerge ? "merge commit" : current ? `head ${headNo} · current` : `head ${headNo}`}</span>
                    </div>
                    <ul className="ml-[13px] mt-2 space-y-2 border-l border-transparent pl-6">
                      {g.events.map((e, ei) => <EventRow key={ei} e={e} />)}
                    </ul>
                  </li>
                );
              })}
            </ol>
          </Panel>
        </div>

        <aside className="space-y-5">
          {(pr.phase === "ready" || pr.phase === "merged") && <MergeGate pr={pr} merge={r.merge} />}
          <Panel title="Repository">
            <dl className="space-y-1.5 text-[13px]">
              <Row k="Repo">{r.github}</Row>
              <Row k="Merges">{r.merge === "stefan" ? "You merge; the runner marks it ready" : "The runner, once clean and green"}</Row>
              <Row k="Live steps">{r.liveDoc ? <code className="font-mono text-[12px]">{r.liveDoc}</code> : "None"}</Row>
            </dl>
          </Panel>
          <p className="px-1 text-[12.5px] text-mute">
            <A to="/queue" className="font-medium text-ink hover:underline">Back to the queue</A>
          </p>
        </aside>
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="flex gap-3"><dt className="w-20 shrink-0 text-mute">{k}</dt><dd className="min-w-0 break-words">{children}</dd></div>;
}

function EventRow({ e }: { e: TEvent }) {
  const Icon = (KIND_ICON as Record<string, typeof Check>)[e.kind];
  const a = ACTOR[e.actor];
  const toneText = e.tone === "bad" ? "text-bad" : e.tone === "ok" ? "text-ok" : e.tone === "you" ? "text-you" : e.tone === "warn" ? "text-warn" : e.tone === "run" ? "text-builder" : "text-ink";
  return (
    <li className="rounded-lg border border-line-2 bg-page/60 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={cn("size-2 rounded-full", a.dot, e.running && "live-dot")} />
        <span className="text-[12.5px] font-medium text-ink-2">{a.name}</span>
        {Icon && <Icon className="size-3.5 text-faint" />}
        <span className={cn("text-[13.5px] font-medium", toneText)}>{e.title}</span>
        <span className="ml-auto text-[12px] text-mute">{e.at}</span>
      </div>
      {e.detail && <p className="mt-1 text-[13px] text-ink-2">{e.detail}</p>}
      {e.findings && (
        <ul className="mt-2 divide-y divide-line-2 overflow-hidden rounded-md border border-line-2 bg-surface">
          {e.findings.map((f) => (
            <li key={f.id} className="flex flex-wrap items-baseline gap-x-2 px-2.5 py-1.5 text-[12.5px]">
              <code className="font-mono font-semibold">{f.id}</code>
              <span className={cn(f.sev === "Important" ? "text-bad" : "text-mute")}>{f.sev}</span>
              <span className="min-w-0 flex-1 text-ink-2">{f.text}{f.where && <> </>}{f.where && <span className=" font-mono text-[11.5px] text-mute">{f.where}</span>}</span>
              <Chip tone={f.status === "open" ? "bad" : f.status === "fixed" ? "ok" : "info"}>{f.status}</Chip>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function MergeGate({ pr, merge }: { pr: PR; merge: "stefan" | "runner" }) {
  const checksPending = pr.gate?.includes("checks");
  const merged = pr.phase === "merged";
  const items: [string, boolean][] = [
    [`Sol's newest review is clean on ${pr.head}`, true],
    [`Checks passed on ${pr.head}`, !checksPending],
    ["No conflict with main", true],
    ["Nothing said on it since that review", true],
    ["No Claude job writing to it, no live run open", true],
  ];
  return (
    <Panel title={merged ? "Merged" : "Merge gate"} aside={merged ? undefined : merge === "stefan" ? "you merge" : "runner merges"}>
      {merged ? (
        <p className="text-[13px] text-ink-2">{pr.timeline.find((e) => e.kind === "merge")?.title ?? "Merged"}. Merged and live are tracked apart: live is in the timeline.</p>
      ) : (
        <ul className="space-y-1.5 text-[13px]">
          {items.map(([t, ok]) => (
            <li key={t} className="flex gap-2">
              {ok ? <Check className="mt-0.5 size-4 shrink-0 text-ok" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-warn" />}
              <span className={ok ? "text-ink-2" : "font-medium text-warn"}>{t}{!ok && " (running)"}</span>
            </li>
          ))}
        </ul>
      )}
      {!merged && (
        <p className="mt-3 border-t border-line-2 pt-3 text-[12.5px] text-mute">
          Checked again just before {merge === "stefan" ? "marking it ready" : "merging"}. A new push resets it: the new head needs its own clean review.
        </p>
      )}
    </Panel>
  );
}

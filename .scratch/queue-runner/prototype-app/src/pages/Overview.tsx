import { CornerDownRight } from "lucide-react";
import { AskCard, IssueRow, LaneCard, PhaseChip } from "@/components/domain";
import { A, Empty, Panel, Sha } from "@/components/ui";
import { ActivityList } from "./Activity";
import { useScoped, useStore } from "@/store";
import { useState } from "react";
import { IssueDrawer } from "./Queue";
import type { Issue } from "@/data/types";

export function Overview() {
  const { world, repo } = useStore();
  const { asks, issues, prs, activity } = useScoped();
  const [drawer, setDrawer] = useState<Issue | null>(null);
  const stale = world.runner.connection === "stale";
  const ready = issues.filter((i) => i.state === "ready");
  const blocked = issues.filter((i) => i.state === "blocked" || i.state === "held");
  const open = prs.filter((p) => p.phase !== "merged" && p.phase !== "closed");
  const showRepo = repo === null;

  return (
    <div className="max-w-[1180px] space-y-6">
      <section aria-labelledby="needs-you">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="needs-you" className="text-[17px] font-semibold tracking-tight">
            {asks.length ? `${asks.length} ${asks.length === 1 ? "thing needs" : "things need"} you` : "Nothing needs you"}
          </h2>
          {asks.length > 0 && <A to="/needs-you" className="text-[13px] font-medium text-mute hover:text-ink">Open Needs you</A>}
        </div>
        {asks.length ? (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr))]">
            {asks.map((a) => <AskCard key={a.id} ask={a} compact />)}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-line bg-surface/60 px-5 py-4 text-[13.5px] text-mute">
            {world.runner.github.ok
              ? "The runner is working through the queue on its own. Merges, questions and decisions show up here when it can't go on without you."
              : "None that the runner could see: GitHub is unreadable, so some may be missing."}
          </div>
        )}
      </section>

      <section aria-label="Running now" className="grid gap-3 lg:grid-cols-2">
        <LaneCard role="Builder" model="Claude" color="builder" lane={world.claude} paused={world.runner.claudePaused} stale={stale} />
        <LaneCard role="Reviewer" model="Sol" color="reviewer" lane={world.sol} stale={stale} />
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Panel
          title="Up next"
          aside={<A to="/queue" className="font-medium hover:text-ink">Whole queue</A>}
          pad={false}
        >
          {world.nextClaude && (
            <div className="flex gap-2 border-b border-line-2 bg-builder-soft/50 px-4 py-2.5 text-[13px] sm:px-5">
              <CornerDownRight className="mt-0.5 size-3.5 shrink-0 text-builder" />
              <span>
                <span className="font-medium text-builder">Next Claude job: </span>
                {world.nextClaude.href ? <A to={world.nextClaude.href} className="underline-offset-2 hover:underline">{world.nextClaude.text}</A> : world.nextClaude.text}
              </span>
            </div>
          )}
          <p className="px-4 pb-1 pt-3 text-[12.5px] text-mute sm:px-5">Builds after that, in priority order</p>
          {ready.length ? (
            <div className="divide-y divide-line-2">{ready.slice(0, 4).map((i, k) => <IssueRow key={`${i.repo}${i.n}`} issue={i} position={k + 1} onOpen={setDrawer} showRepo={showRepo} />)}</div>
          ) : (
            <div className="px-4 pb-4 sm:px-5"><Empty title="Nothing ready to build">Mark an issue ready-for-agent and the runner picks it up on its next pass.</Empty></div>
          )}
          {blocked.length > 0 && (
            <>
              <p className="border-t border-line-2 px-4 pb-1 pt-3 text-[12.5px] text-mute sm:px-5">Blocked or held</p>
              <div className="divide-y divide-line-2">{blocked.slice(0, 3).map((i) => <IssueRow key={`${i.repo}${i.n}`} issue={i} onOpen={setDrawer} showRepo={showRepo} />)}</div>
            </>
          )}
        </Panel>

        <Panel title="Open pull requests" aside={`${open.length}`} pad={false}>
          {open.length ? (
            <div className="divide-y divide-line-2">
              {open.map((p) => (
                <A key={`${p.repo}${p.n}`} to={`/pr/${p.repo}/${p.n}`} className="block px-4 py-3 hover:bg-page sm:px-5">
                  <span className="flex items-start gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{p.title}</span>
                        <span className="text-[12.5px] text-mute">{showRepo ? `${p.repo} ` : ""}PR #{p.n}</span>
                      </span>
                      <span className="mt-0.5 block text-[13px] text-mute">{p.held ?? p.next}</span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <PhaseChip pr={p} />
                      <Sha>{p.head}</Sha>
                    </span>
                  </span>
                </A>
              ))}
            </div>
          ) : (
            <div className="p-4 sm:p-5"><Empty title="No open pull requests" /></div>
          )}
        </Panel>
      </div>

      <Panel title="Recent" aside={<A to="/activity" className="font-medium hover:text-ink">All activity</A>} pad={false}>
        <ActivityList rows={activity.slice(0, 6)} showRepo={showRepo} />
      </Panel>

      {drawer && <IssueDrawer issue={drawer} onClose={() => setDrawer(null)} onOpen={setDrawer} />}
    </div>
  );
}

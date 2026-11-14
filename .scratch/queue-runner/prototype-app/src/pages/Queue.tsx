import * as Dialog from "@radix-ui/react-dialog";
import { CornerDownRight, X } from "lucide-react";
import { useState } from "react";
import { IssueRow, PhaseChip } from "@/components/domain";
import { A, Chip, Empty, Panel, Sha } from "@/components/ui";
import { cn } from "@/lib/cn";
import { navigate, useUrl } from "@/lib/router";
import { useScoped, useStore } from "@/store";
import type { Issue } from "@/data/types";

type View = "list" | "board" | "tree";

export function Queue() {
  const { world, repo } = useStore();
  const { issues, prs } = useScoped();
  const { params } = useUrl();
  const view = (params.get("view") as View) ?? "list";
  const [drawer, setDrawer] = useState<Issue | null>(null);
  const showRepo = repo === null;

  // Build candidates follow repo priority, then issue number (the picker's order).
  const order = (i: Issue) => world.repos.findIndex((r) => r.id === i.repo) * 10000 + i.n;
  const by = (s: Issue["state"]) => issues.filter((i) => i.state === s).sort((a, b) => order(a) - order(b));
  const ready = by("ready");
  const sections: [string, string, Issue[]][] = [
    ["In progress", "A build is running, or its PR is in review, fixing or waiting to merge.", by("in-progress")],
    ["Held", "Another build won't start until you answer or release it.", by("held")],
    ["Blocked", "Waits on another issue to close.", by("blocked")],
    ["Not ready", "Not marked ready-for-agent, or a spec whose children are the work.", by("not-ready")],
  ];

  return (
    <div className="max-w-[1180px] space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {world.nextClaude ? (
          <p className="flex min-w-0 gap-2 text-[13.5px]">
            <CornerDownRight className="mt-0.5 size-4 shrink-0 text-builder" />
            <span><span className="font-medium text-builder">Next Claude job: </span>{world.nextClaude.href ? <A to={world.nextClaude.href} className="underline-offset-2 hover:underline">{world.nextClaude.text}</A> : world.nextClaude.text}</span>
          </p>
        ) : <span />}
        <div className="flex rounded-lg border border-line bg-surface p-0.5 text-[13px]" role="group" aria-label="Queue view">
          {(["list", "board", "tree"] as View[]).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => navigate(null, { view: v === "list" ? null : v }, true)}
              className={cn("rounded-md px-3 py-1 font-medium capitalize", view === v ? "bg-ink text-white" : "text-mute hover:text-ink")}>{v}</button>
          ))}
        </div>
      </div>

      {view === "list" && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="space-y-5">
            <Panel title="Build candidates, in priority order" aside={`${ready.length}`} pad={false}>
              <p className="px-4 pt-3 text-[12.5px] text-mute sm:px-5">
                Decisions, live steps and fix rounds go first; then the first repo with a ready issue gets the next build. Change repo order in Settings.
              </p>
              {ready.length ? (
                <div className="mt-1 divide-y divide-line-2">{ready.map((i, k) => <IssueRow key={`${i.repo}${i.n}`} issue={i} position={k + 1} onOpen={setDrawer} showRepo={showRepo} />)}</div>
              ) : (
                <div className="px-4 pb-4 pt-2 sm:px-5"><Empty title="Nothing ready to build">Mark an issue ready-for-agent, with its blockers closed, and it shows here.</Empty></div>
              )}
            </Panel>
            {sections.map(([t, hint, list]) => list.length > 0 && (
              <Panel key={t} title={t} aside={`${list.length}`} pad={false}>
                <p className="px-4 pt-3 text-[12.5px] text-mute sm:px-5">{hint}</p>
                <div className="mt-1 divide-y divide-line-2">{list.map((i) => <IssueRow key={`${i.repo}${i.n}`} issue={i} onOpen={setDrawer} showRepo={showRepo} />)}</div>
              </Panel>
            ))}
          </div>
          <Panel title="Pull requests" aside={`${prs.length}`} pad={false} className="self-start">
            <div className="divide-y divide-line-2">
              {prs.map((p) => (
                <A key={`${p.repo}${p.n}`} to={`/pr/${p.repo}/${p.n}`} className="flex items-start gap-3 px-4 py-3 hover:bg-page sm:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{p.title}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-mute">{showRepo && <span>{p.repo}</span>}<span>PR #{p.n}</span><Sha>{p.head}</Sha></span>
                  </span>
                  <PhaseChip pr={p} />
                </A>
              ))}
            </div>
          </Panel>
        </div>
      )}

      {view === "board" && (
        <div className="-mx-4 overflow-x-auto px-4 pb-2 md:-mx-8 md:px-8">
          <div className="grid min-w-[900px] grid-cols-5 gap-3">
            {([["Ready", ready], ...sections.map(([t, , l]) => [t, l] as const)] as [string, Issue[]][]).map(([t, list]) => (
              <div key={t} className="rounded-xl bg-line-2/70 p-2">
                <div className="flex justify-between px-1.5 pb-2 pt-1 text-[13px] font-semibold">{t}<span className="font-normal text-mute">{list.length}</span></div>
                <div className="space-y-2">
                  {list.map((i) => (
                    <button key={`${i.repo}${i.n}`} type="button" onClick={() => setDrawer(i)} className="block w-full rounded-lg border border-line bg-surface p-2.5 text-left hover:border-faint">
                      <span className="block text-[13.5px] font-medium leading-snug">{i.title}</span>
                      <span className="mt-1 block text-[12px] text-mute">{showRepo ? `${i.repo} ` : ""}#{i.n}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === "tree" && <Tree issues={issues} onOpen={setDrawer} />}

      {drawer && <IssueDrawer issue={drawer} onClose={() => setDrawer(null)} onOpen={setDrawer} />}
    </div>
  );
}

function Tree({ issues, onOpen }: { issues: Issue[]; onOpen: (i: Issue) => void }) {
  const key = (i: Issue) => `${i.repo}#${i.n}`;
  const kids = (i: Issue) => issues.filter((x) => (x.blockedBy ?? []).includes(key(i)));
  const roots = issues.filter((i) => !(i.blockedBy ?? []).length && kids(i).length > 0);
  const node = (i: Issue, depth: number, path: string): React.ReactNode => (
    <li key={path}>
      <button type="button" onClick={() => onOpen(i)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-page">
        <span className="font-medium">{i.title}</span><span className="text-[12.5px] text-mute">#{i.n}</span>
        {(i.blockedBy ?? []).length > 1 && <Chip className="ml-1">also under {(i.blockedBy ?? []).length - 1} other</Chip>}
      </button>
      {kids(i).length > 0 && <ul className="ml-4 border-l border-line pl-3">{kids(i).map((k) => node(k, depth + 1, `${path}>${key(k)}`))}</ul>}
    </li>
  );
  return (
    <Panel title="What waits on what">
      <p className="mb-3 text-[13px] text-mute">Each issue sits under what it waits on. One with two blockers shows under both. Issues with no blockers and nothing waiting on them aren't shown.</p>
      {roots.length ? <ul>{roots.map((r) => node(r, 0, key(r)))}</ul> : <Empty title="Nothing waits on anything" />}
    </Panel>
  );
}

export function IssueDrawer({ issue, onClose, onOpen }: { issue: Issue; onClose: () => void; onOpen: (i: Issue) => void }) {
  const { world } = useStore();
  const k = `${issue.repo}#${issue.n}`;
  const find = (s: string) => { const [r, n] = s.split("#"); return world.issues.find((i) => i.repo === r && i.n === Number(n)); };
  const waits = (issue.blockedBy ?? []).map(find).filter(Boolean) as Issue[];
  const unblocks = world.issues.filter((i) => (i.blockedBy ?? []).includes(k));
  const row = (i: Issue) => (
    <button key={`${i.repo}${i.n}`} type="button" onClick={() => onOpen(i)} className="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-left hover:bg-page">
      <span className="min-w-0 flex-1 truncate font-medium">{i.title}</span><span className="text-[12.5px] text-mute">#{i.n}</span>
    </button>
  );
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/25" />
        <Dialog.Content className="sheet-in fixed inset-y-0 right-0 z-50 flex w-[min(440px,100vw)] flex-col gap-5 overflow-y-auto bg-surface p-5 shadow-2xl sm:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[12.5px] text-mute">{issue.repo} #{issue.n}</p>
              <Dialog.Title className="mt-0.5 text-[18px] font-semibold leading-snug tracking-tight">{issue.title}</Dialog.Title>
            </div>
            <Dialog.Close className="rounded-md p-1 text-faint hover:bg-line-2 hover:text-ink" aria-label="Close"><X className="size-4" /></Dialog.Close>
          </div>
          <Dialog.Description className="text-[13.5px] text-ink-2">{issue.reason ?? (issue.state === "ready" ? "Ready: every blocker is closed and it's marked ready-for-agent." : issue.state === "blocked" ? "Blocked until what it waits on closes." : "")}</Dialog.Description>
          {issue.pr && <A to={`/pr/${issue.repo}/${issue.pr}`} className="inline-flex h-8 w-fit items-center rounded-lg bg-ink px-3 text-[13px] font-medium text-white">Open PR #{issue.pr} history</A>}
          <div><h3 className="mb-2 text-[13px] font-semibold">Waits on</h3><div className="space-y-1.5">{waits.length ? waits.map(row) : <p className="text-[13px] text-mute">Nothing</p>}</div></div>
          <div><h3 className="mb-2 text-[13px] font-semibold">Unblocks</h3><div className="space-y-1.5">{unblocks.length ? unblocks.map(row) : <p className="text-[13px] text-mute">Nothing yet</p>}</div></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

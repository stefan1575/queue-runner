// The work itself, three ways: List (the order the runner takes it), Board (where each item is),
// Graph (what blocks what, top-down: do the top first). Features on top show where to push.
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { navigate, useUrl } from "@/lib/router";
import { useScoped, useStore } from "@/store";
import type { Feature, Issue, IssueState } from "@/data/types";
import { Chip, RepoTag, Section } from "./ui";

type View = "list" | "board" | "graph";

const STATE: Record<IssueState, [string, Parameters<typeof Chip>[0]["tone"]]> = {
  ready: ["Ready", "ok"],
  building: ["Building", "run"],
  review: ["In review", "info"],
  fixing: ["Fixing", "run"],
  you: ["Needs you", "you"],
  merge: ["To merge", "you"],
  blocked: ["Blocked", "info"],
  "not-ready": ["Not ready", "info"],
  done: ["Done", "info"],
};
const FEATURE_COLORS = ["#7357c9", "#1a8a7d", "#6b7d1f", "#56677a", "#8a5a3c", "#9c4f96"];

const key = (i: Issue) => `${i.repo}#${i.n}`;

// Graph facts shared by every view.
function useModel() {
  const { world, repo } = useStore();
  const { issues, features } = useScoped();
  return useMemo(() => {
    const byKey = new Map(world.issues.map((i) => [key(i), i]));
    const dependents = new Map<string, string[]>();
    for (const i of world.issues) for (const b of i.blockedBy ?? []) dependents.set(b, [...(dependents.get(b) ?? []), key(i)]);
    const unblocks = (k: string) => {
      const seen = new Set<string>();
      const walk = (x: string) => (dependents.get(x) ?? []).forEach((d) => { if (!seen.has(d) && byKey.get(d)?.state !== "done") { seen.add(d); walk(d); } });
      walk(k);
      return seen.size;
    };
    const waitsOn = (i: Issue) => (i.blockedBy ?? []).map((b) => byKey.get(b)!).filter((b) => b && b.state !== "done");
    const repoRank = (r: string) => world.repos.findIndex((x) => x.id === r);
    const order = (a: Issue, b: Issue) => repoRank(a.repo) - repoRank(b.repo) || a.n - b.n;
    const featureOf = (i: Issue) => features.find((f) => f.id === i.feature) ?? features.find((f) => f.id === `${i.repo}:none`);
    const color = (f?: Feature) => (f && f.n ? FEATURE_COLORS[world.features.filter((x) => x.n).indexOf(f) % FEATURE_COLORS.length] : "var(--c-faint)");
    return { issues, features, byKey, dependents, unblocks, waitsOn, order, featureOf, color, showRepo: repo === null };
  }, [world, repo, issues, features]);
}
type Model = ReturnType<typeof useModel>;

export function Work() {
  const { params } = useUrl();
  const view = (params.get("view") as View) ?? "list";
  const m = useModel();
  return (
    <Section
      title="Work"
      count={m.issues.filter((i) => i.state !== "done").length}
      flush
      aside={
        <div className="flex rounded-md bg-sunk p-0.5" role="group" aria-label="View">
          {(["list", "board", "graph"] as View[]).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => navigate(null, { view: v === "list" ? null : v }, true)}
              className={cn("rounded px-2.5 py-0.5 text-[13.5px] font-medium capitalize", view === v ? "bg-surface text-ink shadow-sm" : "text-mute hover:text-ink")}>{v}</button>
          ))}
        </div>
      }
    >
      <Features m={m} />
      {view === "list" && <List m={m} />}
      {view === "board" && <Board m={m} />}
      {view === "graph" && <Graph m={m} />}
    </Section>
  );
}

function Features({ m }: { m: Model }) {
  const rows = m.features.filter((f) => f.n).map((f) => {
    const its = m.issues.filter((i) => i.feature === f.id);
    const c = (s: IssueState[]) => its.filter((i) => s.includes(i.state)).length;
    const next = its.filter((i) => i.state === "ready").sort((a, b) => m.unblocks(key(b)) - m.unblocks(key(a)))[0];
    const you = its.find((i) => i.state === "you" || i.state === "merge");
    return { f, total: its.length, done: c(["done"]), moving: c(["building", "review", "fixing"]), you: c(["you", "merge"]), ready: c(["ready"]), blocked: c(["blocked", "not-ready"]), next, youItem: you };
  });
  if (!rows.length) return null;
  return (
    <div className="border-b border-line-2 px-3 py-2">
      <table className="w-full text-[14px]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.f.id} className="h-8">
              <td className="w-0 whitespace-nowrap pr-3">
                <span className="mr-1.5 inline-block size-2 rounded-sm" style={{ background: m.color(r.f) }} />
                <span className="font-medium">{r.f.title}</span>
                {m.showRepo && <span className="ml-1.5 hidden text-faint sm:inline">{r.f.repo}</span>}
              </td>
              <td className="w-[38%] pr-3">
                <div className="flex h-1.5 overflow-hidden rounded-full bg-sunk" title={`${r.done} done, ${r.moving} moving, ${r.you} need you, ${r.ready} ready, ${r.blocked} blocked`}>
                  <span className="bg-ok" style={{ width: `${(r.done / r.total) * 100}%` }} />
                  <span className="bg-run" style={{ width: `${(r.moving / r.total) * 100}%` }} />
                  <span className="bg-you" style={{ width: `${(r.you / r.total) * 100}%` }} />
                  <span className="bg-ok/40" style={{ width: `${(r.ready / r.total) * 100}%` }} />
                </div>
              </td>
              <td className="w-0 whitespace-nowrap pr-3 text-right tabular-nums text-mute">{r.done}/{r.total}</td>
              <td className="hidden truncate text-mute sm:table-cell">
                {r.youItem ? <span className="text-you">You: #{r.youItem.n} {r.youItem.title}</span>
                  : r.next ? <>Next: <span className="text-ink-2">#{r.next.n}</span>{m.unblocks(key(r.next)) > 0 && <> unblocks {m.unblocks(key(r.next))}</>}</>
                  : r.moving ? "Moving" : "Waiting on other work"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ List
const GROUPS: [string, IssueState[]][] = [
  ["Build next, in order", ["ready"]],
  ["Moving", ["building", "review", "fixing"]],
  ["Waiting on you", ["you", "merge"]],
  ["Blocked", ["blocked"]],
  ["Not ready", ["not-ready"]],
];

function List({ m }: { m: Model }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] table-fixed text-[14px]">
        <thead>
          <tr className="h-8 border-b border-line-2 text-left text-[13px] text-faint">
            <th className="w-9 pl-3 font-medium">#</th>
            <th className="font-medium">Item</th>
            <th className="w-36 font-medium">Feature</th>
            <th className="w-24 font-medium">State</th>
            <th className="w-24 font-medium">Waits on</th>
            <th className="w-20 pr-3 text-right font-medium" title="Open items that can't start until this is done">Unblocks</th>
          </tr>
        </thead>
        {GROUPS.map(([label, states]) => {
          const list = m.issues.filter((i) => states.includes(i.state)).sort(m.order);
          if (!list.length) return null;
          return (
            <tbody key={label}>
              <tr><td colSpan={6} className="bg-page/60 px-3 pb-0.5 pt-2 text-[13px] font-medium text-mute">{label} <span className="text-faint">{list.length}</span></td></tr>
              {list.map((i, k) => <ListRow key={key(i)} i={i} pos={states[0] === "ready" ? k + 1 : undefined} m={m} />)}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

function ListRow({ i, pos, m }: { i: Issue; pos?: number; m: Model }) {
  const { openPr } = useStore();
  const f = m.featureOf(i);
  const [label, tone] = STATE[i.state];
  const u = m.unblocks(key(i));
  const waits = m.waitsOn(i);
  return (
    <tr onClick={() => i.pr && openPr(i.repo, i.pr)} className={cn("h-11 border-b border-line-2 last:border-0", i.pr && "cursor-pointer hover:bg-sunk")}>
      <td className="pl-3 tabular-nums text-faint">{pos ?? ""}</td>
      <td className="pr-3">
        <span className="flex min-w-0 items-center gap-2" title={i.reason}>
          {m.showRepo && <RepoTag repo={i.repo} />}
          <span className="truncate font-medium">{i.title}</span>
          <span className="shrink-0 text-faint">#{i.n}{i.pr ? ` · PR #${i.pr}` : ""}</span>
        </span>
      </td>
      <td className="truncate pr-3 text-mute">{f?.n ? <><span className="mr-1 inline-block size-2 rounded-sm" style={{ background: m.color(f) }} />{f.title}</> : <span className="text-faint">–</span>}</td>
      <td className="whitespace-nowrap pr-3"><Chip tone={tone}>{label}</Chip></td>
      <td className="whitespace-nowrap pr-3 text-mute">{waits.length ? waits.map((w) => `#${w.n}`).join(", ") : <span className="text-faint">–</span>}</td>
      <td className={cn("pr-3 text-right tabular-nums", u >= 2 ? "font-semibold text-ink" : "text-mute")}>{u || <span className="text-faint">–</span>}</td>
    </tr>
  );
}

// ------------------------------------------------------------------ Board
const COLUMNS: [string, IssueState[]][] = [
  ["Ready", ["ready"]],
  ["Building", ["building"]],
  ["In review", ["review"]],
  ["Fixing", ["fixing"]],
  ["Needs you", ["you", "merge"]],
  ["Blocked", ["blocked"]],
];

function Board({ m }: { m: Model }) {
  const { openPr } = useStore();
  return (
    <div className="overflow-x-auto p-2">
      <div className="grid min-w-[880px] grid-cols-6 gap-2">
        {COLUMNS.map(([label, states]) => {
          const list = m.issues.filter((i) => states.includes(i.state)).sort(m.order);
          return (
            <div key={label} className="rounded-md bg-sunk/70 p-1.5">
              <p className="flex justify-between px-1 pb-1.5 text-[13.5px] font-semibold">{label}<span className="font-normal text-mute">{list.length}</span></p>
              <div className="space-y-1.5">
                {list.map((i) => {
                  const f = m.featureOf(i);
                  const u = m.unblocks(key(i));
                  return (
                    <button key={key(i)} type="button" onClick={() => i.pr && openPr(i.repo, i.pr)}
                      className="block w-full rounded border border-line bg-surface px-2 py-1.5 text-left hover:border-faint" style={{ borderLeft: `3px solid ${m.color(f)}` }}>
                      <span className="line-clamp-2 text-[14px] font-medium leading-snug">{i.title}</span>
                      <span className="mt-0.5 flex gap-1.5 text-[13px] text-mute">
                        {m.showRepo && <span className="font-medium text-ink-2">{i.repo}</span>}
                        <span>#{i.n}</span>
                        {i.pr && <span>PR #{i.pr}</span>}
                        {u > 0 && <span className="ml-auto">unblocks {u}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Graph
// A layered dependency graph: blockers above what they block, so the top row is where to start.
const NW = 176, NH = 50, GX = 16, GY = 34;

function Graph({ m }: { m: Model }) {
  const { openPr } = useStore();
  const [sel, setSel] = useState<string | null>(null);

  // Split into connected groups and lay each out as its own pyramid, so lines don't cross groups.
  const { groups, loose } = useMemo(() => {
    const inScope = new Set(m.issues.map(key));
    const adj = new Map<string, Set<string>>();
    const add = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a)!.add(b); };
    for (const i of m.issues) for (const b of i.blockedBy ?? []) if (inScope.has(b)) { add(b, key(i)); add(key(i), b); }
    const seen = new Set<string>();
    const comps: string[][] = [];
    for (const k of adj.keys()) {
      if (seen.has(k)) continue;
      const c: string[] = [];
      const stack = [k];
      while (stack.length) { const x = stack.pop()!; if (seen.has(x)) continue; seen.add(x); c.push(x); adj.get(x)!.forEach((y) => stack.push(y)); }
      comps.push(c);
    }
    const groups = comps.map((c) => {
      const set = new Set(c);
      const layer = new Map<string, number>();
      const depth = (k: string): number => {
        if (layer.has(k)) return layer.get(k)!;
        const d = Math.max(0, ...(m.byKey.get(k)!.blockedBy ?? []).filter((b) => set.has(b)).map((b) => depth(b) + 1));
        layer.set(k, d);
        return d;
      };
      c.forEach(depth);
      const layers: string[][] = [];
      for (const k of c) (layers[layer.get(k)!] ??= []).push(k);
      layers.forEach((l) => l.sort((a, b) => m.order(m.byKey.get(a)!, m.byKey.get(b)!)));
      const widest = Math.max(...layers.map((l) => l.length));
      const width = widest * NW + (widest - 1) * GX;
      const pos = new Map<string, { x: number; y: number }>();
      layers.forEach((l, d) => {
        const off = (width - (l.length * NW + (l.length - 1) * GX)) / 2;
        l.forEach((k, i) => pos.set(k, { x: off + i * (NW + GX), y: d * (NH + GY) }));
      });
      const edges: [string, string][] = [];
      for (const k of c) for (const b of m.byKey.get(k)!.blockedBy ?? []) if (set.has(b)) edges.push([b, k]);
      const feats = c.map((k) => m.featureOf(m.byKey.get(k)!)).filter((f) => f?.n);
      const feature = feats.sort((a, b) => feats.filter((x) => x === b).length - feats.filter((x) => x === a).length)[0];
      const open = c.filter((k) => m.byKey.get(k)!.state !== "done").length;
      return { pos, edges, width, height: layers.length * (NH + GY) - GY, feature, open, first: Math.min(...c.map((k) => m.byKey.get(k)!.n)) };
    }).sort((a, b) => b.open - a.open || a.first - b.first);
    const loose = m.issues.filter((i) => !adj.has(key(i)) && i.state !== "done" && i.state !== "not-ready").sort(m.order);
    return { groups, loose };
  }, [m]);

  const related = useMemo(() => {
    if (!sel) return null;
    const s = new Set([sel]);
    const up = (k: string) => (m.byKey.get(k)?.blockedBy ?? []).forEach((b) => { if (!s.has(b)) { s.add(b); up(b); } });
    const down = (k: string) => (m.dependents.get(k) ?? []).forEach((d) => { if (!s.has(d)) { s.add(d); down(d); } });
    up(sel); down(sel);
    return s;
  }, [sel, m]);

  return (
    <div className="p-3">
      {groups.length === 0 ? (
        <p className="text-[14px] text-mute">Nothing here waits on anything.</p>
      ) : (
        <div className="flex flex-wrap gap-x-8 gap-y-5">
          {groups.map((g, gi) => (
            <div key={gi} className="max-w-full overflow-x-auto">
              <p className="mb-1.5 flex items-center gap-1.5 text-[13.5px] font-medium text-ink-2">
                <span className="inline-block size-2 rounded-sm" style={{ background: m.color(g.feature) }} />
                {g.feature?.title ?? "Linked work"}
                <span className="font-normal text-faint">{g.open} open</span>
              </p>
              <div className="relative" style={{ width: g.width, height: g.height }}>
                <svg className="pointer-events-none absolute inset-0" width={g.width} height={g.height} aria-hidden>
                  {g.edges.map(([a, b]) => {
                    const p = g.pos.get(a)!, q = g.pos.get(b)!;
                    const x1 = p.x + NW / 2, y1 = p.y + NH, x2 = q.x + NW / 2, y2 = q.y;
                    const on = !related || (related.has(a) && related.has(b));
                    return <path key={a + b} d={`M${x1},${y1} C${x1},${y1 + GY / 1.4} ${x2},${y2 - GY / 1.4} ${x2},${y2}`} fill="none" stroke={on ? "var(--c-faint)" : "var(--c-line-2)"} strokeWidth={on && related ? 1.6 : 1.1} />;
                  })}
                </svg>
                {[...g.pos.entries()].map(([k, p]) => {
                  const i = m.byKey.get(k)!;
                  const f = m.featureOf(i);
                  const u = m.unblocks(k);
                  const [label, tone] = STATE[i.state];
                  const dim = related && !related.has(k);
                  return (
                    <button key={k} type="button" onClick={() => setSel(sel === k ? null : k)} onDoubleClick={() => i.pr && openPr(i.repo, i.pr)}
                      className={cn("absolute flex flex-col justify-between rounded-md border bg-surface px-2 py-1 text-left transition-opacity", sel === k ? "border-ink shadow-md" : "border-line hover:border-faint", dim && "opacity-30", i.state === "done" && "bg-sunk")}
                      style={{ left: p.x, top: p.y, width: NW, height: NH, borderLeft: `3px solid ${m.color(f)}` }}
                      title={`${i.title}${i.reason ? ` · ${i.reason}` : ""}${i.pr ? " · double-click for PR history" : ""}`}
                    >
                      <span className={cn("truncate text-[13.5px] font-medium leading-tight", i.state === "done" && "text-mute line-through")}>{i.title}</span>
                      <span className="flex items-center gap-1 text-[12.5px] text-mute">
                        <span>#{i.n}</span>
                        <Chip tone={tone} className="h-4 px-1 text-[10.5px]">{label}</Chip>
                        {u > 0 && <span className={cn("ml-auto", u >= 2 && i.state === "ready" ? "font-semibold text-ok" : "")}>unblocks {u}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {loose.length > 0 && (
        <p className="mt-3 border-t border-line-2 pt-2 text-[13.5px] text-mute">
          No dependencies: {loose.map((i, n) => <span key={key(i)}>{n > 0 && ", "}<span className="text-ink-2">#{i.n} {i.title}</span></span>)}
        </p>
      )}
    </div>
  );
}

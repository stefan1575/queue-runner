// PROTOTYPE (throwaway): the settings state shared by the three layouts. In memory, one copy per
// data set (Stefan's setup, a new install), kept across variant switches and page changes; a reload
// resets it. Every change is diffed against what the runner would store, so the bar can show it.
import { useEffect, useState, useSyncExternalStore } from "react";
import { useUrl } from "@/lib/router";
import { initial, stored, T3_PROVIDERS, type Effort, type ProviderId, type RepoRow, type RoleId, type Saved, type TimeFormat } from "./model";

export type DataSet = "stefan" | "new";
export const DATA_SETS: { id: DataSet; label: string }[] = [
  { id: "stefan", label: "Stefan's setup" },
  { id: "new", label: "New install" },
];
export interface Change { at: number; path: string; from: string; to: string }

const data: Record<DataSet, Saved> = { stefan: initial(false), new: initial(true) };
const logs: Record<DataSet, Change[]> = { stefan: [], new: [] };
// T3's Time format: read, never stored. The bar can flip it to show the page following T3.
let timeFormat: TimeFormat = "12-hour";
let version = 0;
const subs = new Set<() => void>();
const emit = () => { version++; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

// Leaf paths of the stored JSON, so a change reads as "roles.builder.effort: medium → high".
function leaves(v: unknown, path: string, out: Map<string, string>) {
  if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, path ? `${path}.${k}` : k, out);
  else out.set(path, JSON.stringify(v));
}
function diff(a: Saved, b: Saved): Change[] {
  const x = new Map<string, string>(), y = new Map<string, string>();
  leaves(stored(a), "", x); leaves(stored(b), "", y);
  const at = Date.now(), out: Change[] = [];
  // A null that became an object (a role chosen for the first time) shows as its new values only.
  const grew = (m: Map<string, string>, k: string) => [...m.keys()].some((p) => p.startsWith(`${k}.`));
  for (const k of new Set([...x.keys(), ...y.keys()])) {
    if (x.get(k) === y.get(k) || (!y.has(k) && grew(y, k)) || (!x.has(k) && grew(x, k))) continue;
    out.push({ at, path: k, from: x.get(k) ?? "none", to: y.get(k) ?? "removed" });
  }
  return out;
}

function update(ds: DataSet, f: (d: Saved) => void) {
  const next = structuredClone(data[ds]);
  f(next);
  const changes = diff(data[ds], next);
  data[ds] = next;
  if (changes.length) logs[ds] = [...changes, ...logs[ds]].slice(0, 40);
  emit();
}

export function useDataSet(): DataSet {
  return useUrl().params.get("data") === "new" ? "new" : "stefan";
}

type RolePatch = { provider?: ProviderId; model?: string; effort?: Effort };

export function useSettings() {
  const ds = useDataSet();
  useSyncExternalStore(subscribe, () => version);
  const s = data[ds];
  const set = (f: (d: Saved) => void) => update(ds, f);
  return {
    ds,
    s,
    log: logs[ds],
    savedAt: logs[ds][0]?.at ?? null,
    timeFormat,
    setTimeFormat: (f: TimeFormat) => { timeFormat = f; emit(); },
    set,
    reset: () => { data[ds] = initial(ds === "new"); logs[ds] = []; emit(); },
    // A role is provider → model → effort: a new provider starts on its default model, and keeps
    // the effort when it offers that one.
    setRole: (which: RoleId, patch: RolePatch) =>
      set((d) => {
        const r = d.roles[which];
        if (patch.provider && patch.provider !== r.provider) {
          const p = T3_PROVIDERS[patch.provider];
          Object.assign(r, { provider: patch.provider, model: p.default.model, effort: p.efforts.includes(r.effort) ? r.effort : p.default.effort });
        }
        if (patch.model) r.model = patch.model;
        if (patch.effort) r.effort = patch.effort;
        r.chosen = true;
      }),
    // Keeping T3's default is a choice too: it stops the nudge and pins the role.
    keepRole: (which: RoleId) => set((d) => { d.roles[which].chosen = true; }),
    setShare: (id: string, patch: { percent?: number; releaseHours?: number }) =>
      set((d) => { Object.assign(d.shares.find((x) => x.id === id)!, patch); }),
    // Touching a repo's row is what makes it stop being "new".
    setRepo: (name: string, patch: Partial<Pick<RepoRow, "served" | "merge">>) =>
      set((d) => { const r = d.repos.find((x) => x.name === name)!; Object.assign(r, patch); delete r.newFromT3; }),
    removeRepo: (name: string) => set((d) => { d.repos = d.repos.filter((x) => x.name !== name); }),
    // A folder added here becomes a T3 project too. It arrives off like any other.
    addRepo: (p: { name: string; github: string | null; path: string }) =>
      set((d) => { if (!d.repos.some((r) => r.name === p.name)) d.repos.push({ ...p, served: false, merge: "me" }); }),
  };
}
export type Settings = ReturnType<typeof useSettings>;

// What still wants a choice, for the nudges: roles left on T3's default, repos new from T3, and
// (a new install) nothing served yet.
export function nudges(s: Saved) {
  const roles = (Object.keys(s.roles) as RoleId[]).filter((k) => !s.roles[k].chosen);
  const newRepos = s.repos.filter((r) => r.newFromT3).map((r) => r.name);
  const noneServed = !s.repos.some((r) => r.served);
  return { roles, newRepos, noneServed };
}

// The current time, for the date previews.
export function useNow(everyMs = 15_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), everyMs); return () => clearInterval(t); }, [everyMs]);
  return now;
}

// Search params without the router's sticky list, so variant, data and section survive each other.
export function setParams(set: Record<string, string | null>) {
  const url = new URL(location.href);
  for (const [k, v] of Object.entries(set)) { if (v === null) url.searchParams.delete(k); else url.searchParams.set(k, v); }
  history.replaceState(null, "", url.pathname + url.search);
  dispatchEvent(new PopStateEvent("popstate"));
}

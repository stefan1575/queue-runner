// A tiny router: the page is the path, the scope and the prototype's switches are search params,
// so a view can be bookmarked and back works.
import { useEffect, useSyncExternalStore } from "react";

const subscribe = (fn: () => void) => {
  addEventListener("popstate", fn);
  return () => removeEventListener("popstate", fn);
};
const snap = () => location.pathname + location.search;

export function useUrl() {
  const s = useSyncExternalStore(subscribe, snap);
  const url = new URL(s, location.origin);
  return { path: url.pathname, params: url.searchParams };
}

// Navigate to a path, keeping the sticky params (repo, demo, picker) unless overridden.
export function navigate(path: string | null, set: Record<string, string | null> = {}, replace = false) {
  const cur = new URL(location.href);
  const next = new URL(path ?? cur.pathname, location.origin);
  for (const k of ["repo", "demo", "picker"]) {
    const v = cur.searchParams.get(k);
    if (v !== null) next.searchParams.set(k, v);
  }
  for (const [k, v] of Object.entries(set)) {
    if (v === null) next.searchParams.delete(k);
    else next.searchParams.set(k, v);
  }
  const href = next.pathname + next.search;
  if (replace) history.replaceState(null, "", href);
  else history.pushState(null, "", href);
  dispatchEvent(new PopStateEvent("popstate"));
  if (path !== null && !replace) document.getElementById("main")?.scrollTo({ top: 0 });
}

export function useScrollTopOn(key: string) {
  useEffect(() => { document.getElementById("main")?.scrollTo({ top: 0 }); }, [key]);
}

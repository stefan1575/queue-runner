// PROTOTYPE (throwaway): the floating bar that isn't part of any design. It switches the layout
// (arrows, or the ← → keys outside a field), switches the data set, and shows what the runner would
// store (a drawer over the sidebar), with the last change marked. Inverted colours so it never reads as the page. Dev only.
import { Braces, ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { stored, T3_SNOOZE, TIME_FORMATS } from "./model";
import { DATA_SETS, setParams, type Settings } from "./state";

export interface VariantInfo { key: string; name: string }

interface Line { text: string; path: string; leaf: boolean }
const flat = (v: unknown) => v !== null && typeof v === "object" && Object.values(v).every((x) => x === null || typeof x !== "object") && JSON.stringify(v).length <= 22;
// The stored JSON as lines that know their path, so a changed value can be marked. A small object
// of plain values stays on one line.
function lines(v: unknown, path = "", depth = 0, key?: string, comma = false, out: Line[] = []): Line[] {
  const pad = "  ".repeat(depth), k = key !== undefined ? `${JSON.stringify(key)}: ` : "", c = comma ? "," : "";
  if (v === null || typeof v !== "object") out.push({ text: `${pad}${k}${JSON.stringify(v)}${c}`, path, leaf: true });
  else if (flat(v)) out.push({ text: `${pad}${k}{ ${Object.entries(v).map(([a, b]) => `${JSON.stringify(a)}: ${JSON.stringify(b)}`).join(", ")} }${c}`, path, leaf: true });
  else {
    const es = Object.entries(v);
    out.push({ text: `${pad}${k}{`, path, leaf: false });
    es.forEach(([a, b], i) => lines(b, path ? `${path}.${a}` : a, depth + 1, a, i < es.length - 1, out));
    out.push({ text: `${pad}}${c}`, path, leaf: false });
  }
  return out;
}

export function PrototypeBar({ variants, current, st }: { variants: VariantInfo[]; current: VariantInfo; st: Settings }) {
  const [open, setOpen] = useState(false);
  const i = variants.findIndex((v) => v.key === current.key);
  const step = (by: number) => setParams({ variant: variants[(i + by + variants.length) % variants.length].key });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable], [role=dialog], [role=menu], [role=listbox]")) return;
      e.preventDefault();
      step(e.key === "ArrowRight" ? 1 : -1);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  // Keep the value that just changed in view.
  const pre = useRef<HTMLPreElement>(null);
  const stamp = st.log[0] ? `${st.log[0].at}${st.log[0].path}` : "";
  useEffect(() => { pre.current?.querySelector("[data-hot]")?.scrollIntoView({ block: "nearest" }); }, [stamp, open]);

  if (!import.meta.env.DEV) return null;

  const newest = st.log.filter((c) => c.at === st.log[0]?.at);
  const hot = (l: Line) => l.leaf && newest.some((c) => c.path === l.path || c.path.startsWith(`${l.path}.`));
  const last = st.log[0];
  const pill = "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[14.5px] font-medium";

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex flex-col items-center gap-2 px-3 font-sans">
      {/* Over the app's sidebar, so the page and what it stores can be watched side by side. */}
      {open && (
        <div className="pointer-events-auto fixed inset-y-0 left-0 z-40 flex w-[280px] max-w-[88vw] flex-col bg-ink text-page shadow-2xl">
          <div className="flex items-center gap-1 border-b border-page/15 py-2 pl-3.5 pr-2">
            <div className="min-w-0 flex-1">
              <b className="block text-[14.5px] font-semibold leading-tight">What the runner would store</b>
              <span className="text-[13px] opacity-60">{DATA_SETS.find((d) => d.id === st.ds)?.label}</span>
            </div>
            <button type="button" onClick={st.reset} className="rounded-full p-1.5 hover:bg-page/15" aria-label="Reset this data set" title="Put this data set back as it loaded"><RotateCcw className="size-4" /></button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-full p-1.5 hover:bg-page/15" aria-label="Close"><X className="size-4" /></button>
          </div>
          <div className="border-b border-page/15 px-3.5 py-2.5 text-[13px]">
            <div className="mb-1 font-semibold opacity-60">Last changes</div>
            {st.log.length === 0 && <p className="opacity-60">Change a setting and it shows here, one line per stored value.</p>}
            <ul className="space-y-1">
              {st.log.slice(0, 4).map((c, n) => (
                <li key={n} className={cn("break-words font-mono text-[12px] leading-snug", c.at !== last?.at && "opacity-55")}>
                  {c.path}<br /><span className="opacity-70">{c.from} → </span>{c.to}
                </li>
              ))}
            </ul>
          </div>
          <pre ref={pre} className="min-h-0 flex-1 overflow-auto px-3.5 py-2.5 font-mono text-[12px] leading-[1.55]">
            {lines(stored(st.s)).map((l, n) => <div key={n} data-hot={hot(l) || undefined} className={cn(hot(l) && "-mx-1.5 rounded bg-page/25 px-1.5 font-medium")}>{l.text}</div>)}
          </pre>
          <div className="border-t border-page/15 px-3.5 py-2.5 text-[13px]">
            <div className="mb-1 font-semibold opacity-60">Read from T3, not stored</div>
            <div className="flex items-center gap-2">
              Time format
              <span className="inline-flex rounded-full bg-page/15 p-0.5">
                {TIME_FORMATS.map((f) => (
                  <button key={f.id} type="button" aria-pressed={st.timeFormat === f.id} onClick={() => st.setTimeFormat(f.id)}
                    className={cn("rounded-full px-1.5 py-0.5 text-[12.5px] font-medium", st.timeFormat === f.id ? "bg-page text-ink" : "hover:bg-page/15")}>{f.label}</button>
                ))}
              </span>
            </div>
            <div className="mt-1.5 opacity-70">Snooze options: {T3_SNOOZE.join(", ")}</div>
          </div>
        </div>
      )}

      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-1 gap-y-1 rounded-[22px] bg-ink p-1.5 text-page shadow-2xl ring-1 ring-black/20">
        <span className="pl-2 pr-1 text-[12px] font-bold uppercase tracking-[0.08em] opacity-55">Prototype</span>
        <button type="button" onClick={() => step(-1)} className="rounded-full p-1.5 hover:bg-page/15" aria-label="Previous layout" title="Previous layout (←)"><ChevronLeft className="size-[18px]" /></button>
        <span className="min-w-[188px] text-center text-[15px]"><b className="font-semibold">{current.key}</b> · {current.name}</span>
        <button type="button" onClick={() => step(1)} className="rounded-full p-1.5 hover:bg-page/15" aria-label="Next layout" title="Next layout (→)"><ChevronRight className="size-[18px]" /></button>

        <span className="mx-1 h-5 w-px bg-page/20" />
        <span className="inline-flex rounded-full bg-page/15 p-0.5" role="group" aria-label="Data set">
          {DATA_SETS.map((d) => (
            <button key={d.id} type="button" aria-pressed={st.ds === d.id} onClick={() => setParams({ data: d.id === "stefan" ? null : d.id })}
              className={cn("rounded-full px-2.5 py-1 text-[14.5px] font-medium", st.ds === d.id ? "bg-page text-ink" : "hover:bg-page/15")}>{d.label}</button>
          ))}
        </span>

        <span className="mx-1 h-5 w-px bg-page/20" />
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={cn(pill, "max-w-[320px]", open ? "bg-page text-ink" : "hover:bg-page/15")} title="What the runner would store">
          <Braces className="size-4 shrink-0" />
          {last
            ? <span key={`${last.at}${last.path}`} className="truncate font-mono text-[13px]">{last.path.split(".").slice(-2).join(".")} → {last.to}{newest.length > 1 ? ` +${newest.length - 1}` : ""}</span>
            : "Stored JSON"}
        </button>
      </div>
    </div>
  );
}

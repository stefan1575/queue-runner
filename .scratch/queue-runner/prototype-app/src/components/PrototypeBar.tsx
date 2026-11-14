// The prototype's own controls, clearly not part of the design: the demo state and where the repo
// picker sits. Both live in the URL, so a state can be linked.
import { ChevronDown, ChevronUp, FlaskConical } from "lucide-react";
import { useState } from "react";
import { DEMOS, DEMO_GROUPS } from "@/data/fixtures";
import { cn } from "@/lib/cn";
import { useStore } from "@/store";

export function PrototypeBar() {
  const { demo, setDemo } = useStore();
  const [min, setMin] = useState(false);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-30 flex justify-start md:justify-center px-3">
      <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-2xl bg-[#1d1b26] px-2 py-1.5 text-[12.5px] text-white shadow-[0_10px_30px_-6px_rgba(0,0,0,.45)] ring-1 ring-white/10">
        <span className="flex shrink-0 items-center gap-1.5 pl-1.5 font-medium text-[#c9c3ff]"><FlaskConical className="size-3.5" />{min ? "Prototype" : <span className="hidden sm:inline">Prototype</span>}</span>
        {!min && (
          <>
            <label className="sr-only" htmlFor="demo">Demo state</label>
            <select id="demo" value={demo} onChange={(e) => setDemo(e.target.value)} className="h-7 min-w-0 max-w-[52vw] rounded-lg bg-white/10 px-2 text-white outline-none hover:bg-white/15 sm:max-w-none [&>optgroup]:text-ink [&>optgroup>option]:text-ink">
              {DEMO_GROUPS.map((g) => (
                <optgroup key={g} label={g}>
                  {Object.entries(DEMOS).filter(([, d]) => d.group === g).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}
                </optgroup>
              ))}
            </select>
          </>
        )}
        <button type="button" onClick={() => setMin(!min)} className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white" aria-label={min ? "Show prototype controls" : "Hide prototype controls"}>
          {min ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      </div>
    </div>
  );
}

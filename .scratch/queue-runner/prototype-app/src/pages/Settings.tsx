import * as Switch from "@radix-ui/react-switch";
import { ArrowDown, ArrowUp, Minus, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button, Panel } from "@/components/ui";
import { useStore } from "@/store";

export function Settings() {
  const { world, setWorld } = useStore();
  const paused = world.runner.claudePaused;
  const reserve = world.runner.reserve;

  const move = (i: number, d: -1 | 1) => {
    setWorld((w) => {
      const [r] = w.repos.splice(i, 1);
      w.repos.splice(i + d, 0, r);
      return w;
    });
    toast(`Moved ${world.repos[i].id} to priority ${i + 1 + d}`, { description: "Prototype: config.toml wasn't changed." });
  };

  return (
    <div className="max-w-[780px] space-y-5">
      <Panel title="Claude jobs">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <label htmlFor="pause" className="font-medium">Pause new Claude jobs</label>
            <p className="mt-0.5 text-[13px] text-mute">
              No build, fix round, decision or live steps start while paused. A job already running finishes. Sol keeps reviewing, and clean PRs still merge.
            </p>
          </div>
          <Switch.Root
            id="pause"
            checked={paused}
            onCheckedChange={(v) => {
              setWorld((w) => { w.runner.claudePaused = v; return w; });
              toast(v ? "Paused new Claude jobs" : "Resumed Claude jobs", { description: v ? "Same as --pause." : "Same as --resume." });
            }}
            className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full bg-line transition-colors data-[state=checked]:bg-you"
          >
            <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[22px]" />
          </Switch.Root>
        </div>
        <div className="mt-5 flex flex-wrap items-start gap-4 border-t border-line-2 pt-5">
          <div className="min-w-0 flex-1 basis-64">
            <p className="font-medium">Weekly reserve</p>
            <p className="mt-0.5 text-[13px] text-mute">
              The share of Claude's week kept for your own sessions. It opens to the runner 24 hours before the weekly reset ({world.usage.week.releaseAt}).
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-line p-0.5">
            <Button variant="ghost" className="size-8 px-0" onClick={() => setWorld((w) => { w.runner.reserve = Math.max(0, reserve - 1); return w; })} disabled={reserve <= 0}><Minus className="size-4" /><span className="sr-only">Less</span></Button>
            <span className="w-12 text-center text-[15px] font-semibold tabular-nums">{reserve}%</span>
            <Button variant="ghost" className="size-8 px-0" onClick={() => setWorld((w) => { w.runner.reserve = Math.min(50, reserve + 1); return w; })}><Plus className="size-4" /><span className="sr-only">More</span></Button>
          </div>
        </div>
      </Panel>

      <Panel title="Repositories, in priority order" pad={false}>
        <p className="px-4 pt-3 text-[13px] text-mute sm:px-5">
          After decisions, live steps and fix rounds, the first repo here with a ready issue gets the next build. A repo low on the list can wait while those above it have work.
        </p>
        <ol className="mt-2 divide-y divide-line-2">
          {world.repos.map((r, i) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-line-2 text-[12.5px] font-semibold tabular-nums">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{r.github}</p>
                <p className="truncate text-[12.5px] text-mute">
                  {r.path} · base {r.base} · {r.merge === "stefan" ? "you merge" : "runner merges"}{r.liveDoc ? " · live steps" : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" className="size-8 px-0" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" /><span className="sr-only">Move {r.id} up</span></Button>
                <Button variant="ghost" className="size-8 px-0" disabled={i === world.repos.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" /><span className="sr-only">Move {r.id} down</span></Button>
              </div>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}

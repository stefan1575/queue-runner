// Activity: a plain log, newest first. Every line carries its day and time, so nothing depends on
// remembering when you last looked.
import { Bot, GitMerge, User } from "lucide-react";
import { useState } from "react";
import { ClaudeMark, OpenAIMark } from "@/components/Brand";
import { RepoTag, Section } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useScoped, useStore } from "@/store";
import type { DigestRow, Tone } from "@/data/types";

const FILTERS: [string, DigestRow["group"][] | null][] = [
  ["Everything", null],
  ["Built", ["built"]],
  ["Reviewed", ["reviewed"]],
  ["Merged", ["merged"]],
  ["Stopped", ["stopped"]],
  ["Recovered", ["recovered"]],
];

const TONE: Record<Tone, string> = { ok: "bg-ok", warn: "bg-run", bad: "bg-bad", info: "bg-faint", run: "bg-run", you: "bg-you" };

function Actor({ a }: { a: DigestRow["actor"] }) {
  const box = "flex size-7 shrink-0 items-center justify-center rounded-lg bg-sunk";
  if (a === "claude") return <span className={box} title="Claude"><ClaudeMark className="size-4" /></span>;
  if (a === "sol") return <span className={box} title="ChatGPT (Sol)"><OpenAIMark className="size-4" /></span>;
  if (a === "you") return <span className={box} title="You"><User className="size-4 text-you" /></span>;
  if (a === "github") return <span className={box} title="GitHub"><GitMerge className="size-4 text-mute" /></span>;
  return <span className={box} title="Runner"><Bot className="size-4 text-mute" /></span>;
}

export function ActivityPage() {
  const { repo, openPr } = useStore();
  const { digest } = useScoped();
  const [f, setF] = useState(0);
  const rows = digest.filter((r) => !FILTERS[f][1] || FILTERS[f][1]!.includes(r.group));
  const days = [...new Set(rows.map((r) => r.day))];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {FILTERS.map(([label], i) => (
          <button key={label} type="button" aria-pressed={f === i} onClick={() => setF(i)}
            className={cn("h-9 rounded-full border px-3.5 text-[14px] font-medium", f === i ? "border-ink bg-ink text-page" : "border-line bg-surface text-ink-2 hover:border-faint")}>{label}</button>
        ))}
      </div>
      {days.length === 0 && <p className="text-mute">Nothing of this kind in the log.</p>}
      {days.map((d) => (
        <Section key={d} title={d} count={rows.filter((r) => r.day === d).length} flush>
          <ol className="divide-y divide-line-2">
            {rows.filter((r) => r.day === d).map((r, i) => (
              <li key={i}>
                <button type="button" disabled={!r.pr} onClick={() => r.pr && openPr(r.repo, r.pr)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left enabled:hover:bg-sunk">
                  <span className="w-12 shrink-0 tabular-nums text-mute">{r.at}</span>
                  <Actor a={r.actor} />
                  <span className={cn("size-2 shrink-0 rounded-full", TONE[r.tone])} />
                  <span className="min-w-0 flex-1">{r.text}</span>
                  {repo === null && <RepoTag repo={r.repo} />}
                </button>
              </li>
            ))}
          </ol>
        </Section>
      ))}
    </div>
  );
}

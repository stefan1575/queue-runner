import { AskCard } from "@/components/domain";
import { useScoped, useStore } from "@/store";

export function NeedsYou() {
  const { world } = useStore();
  const { asks } = useScoped();
  return (
    <div className="max-w-[780px] space-y-4">
      {asks.length ? (
        asks.map((a) => <AskCard key={a.id} ask={a} />)
      ) : (
        <div className="rounded-xl border border-line bg-surface px-5 py-6">
          <p className="text-[16px] font-semibold">Nothing needs you</p>
          <p className="mt-1 max-w-prose text-mute">
            {world.runner.github.ok
              ? "Merges, questions and decisions land here when the runner can't go on without you. Waiting for usage, checks or a free lane never does."
              : "None that the runner could see. GitHub is unreadable, so a new ask may be missing until it answers."}
          </p>
        </div>
      )}
      <p className="text-[12.5px] text-mute">
        An ask leaves this list when the runner sees it answered: you merged, replied, closed its needs-info issue, or released it. Opening its link doesn't clear it.
      </p>
    </div>
  );
}

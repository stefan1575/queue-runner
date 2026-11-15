// The floating usage card, after T3's: fixed on the right, so it stays in view as the page scrolls.
// On narrow windows it hides behind a button in the top bar.
import { Gauge, X } from "lucide-react";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/cn";
import { useStore } from "@/store";
import type { Meter } from "@/data/types";
import { ProviderName, type Provider } from "./Brand";
import { UsageBar } from "./ui";

export function UsageBlock({ p, m, reserve, release }: { p: Provider; m: Meter; reserve?: number; release?: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <ProviderName p={p} className="text-[16px]" />
        <span className="text-[13.5px] text-faint">read {m.readAt}</span>
      </div>
      {m.error && <p className="text-[14.5px] text-bad">{m.error}</p>}
      <UsageBar label="Session" used={m.five.used} resets={m.five.resets} />
      <UsageBar label="Weekly" used={m.week.used} resets={m.week.resets} reserve={reserve} />
      {m.scoped?.map((s) => <UsageBar key={s.label} label={`Weekly · ${s.label}`} used={s.used} resets={s.resets} />)}
      {reserve !== undefined && release && <p className="text-[14px] text-mute">Your {reserve}% of the week opens to the runner {release}.</p>}
    </div>
  );
}

export function UsageCard({ onClose, className }: { onClose?: () => void; className?: string }) {
  const { world } = useStore();
  const { claude, chatgpt } = world.usage;
  return (
    <aside aria-label="Usage" className={cn("w-[320px] rounded-2xl border border-line bg-surface p-4 shadow-[0_16px_40px_-12px_rgba(0,0,0,.35)]", className)}>
      <div className="mb-3 flex items-center gap-2">
        <Gauge className="size-4 text-faint" />
        <span className="text-[15px] font-semibold">Usage</span>
        <button type="button" onClick={() => navigate("/usage")} className="ml-auto rounded-md px-1.5 text-[14px] text-mute hover:bg-sunk hover:text-ink">Details</button>
        {onClose && <button type="button" onClick={onClose} aria-label="Close usage" className="rounded-md p-1 text-faint hover:bg-sunk hover:text-ink"><X className="size-4" /></button>}
      </div>
      <UsageBlock p="claude" m={claude} reserve={world.runner.reserve} release={claude.releaseAt} />
      <div className="my-4 border-t border-line-2" />
      <UsageBlock p="chatgpt" m={chatgpt} />
    </aside>
  );
}

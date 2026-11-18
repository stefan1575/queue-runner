// PROTOTYPE (throwaway): Settings and Usage open as pop-ups over the app, not as pages (Stefan,
// 2026-11-16). The page you were on stays behind, dimmed; the X, Escape or a click outside closes.
import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

export const BACKDROP = "fixed inset-0 z-[36] bg-black/55 px-3 py-3 sm:px-[5vw] sm:py-[4vh]";

// Escape closes the pop-up, unless a field has focus or a menu or dialog of its own is open.
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]")) return;
      if (document.querySelector("[data-radix-popper-content-wrapper], [role=dialog][data-state=open]")) return;
      onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
}

export function Popup({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  return (
    <div className={BACKDROP} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="region" aria-label={title} className="mx-auto flex max-h-full w-full max-w-[1240px] flex-col overflow-hidden rounded-2xl border border-line bg-page shadow-2xl">
        <header className="flex h-[54px] shrink-0 items-center border-b border-line pl-6 pr-2">
          <b className="text-[17px] font-semibold">{title}</b>
          <button type="button" onClick={onClose} className="ml-auto grid size-9 place-items-center rounded-lg text-mute hover:bg-sunk hover:text-ink" aria-label={`Close ${title.toLowerCase()}`} title="Close"><X className="size-[18px]" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">{children}</div>
      </div>
    </div>
  );
}

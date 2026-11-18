// The sidebar, as #36's prototype has it: the repo switcher on top, and a footer row where T3 Code
// has its own: Settings, Usage and Setup on the left, Update on the right. Setup carries a red mark
// while a check wants fixing (#162), standing in for Health's link until Health is built. Usage stays greyed until #35
// settles its page, Update until updates are specced. The switcher lists the served repositories
// (Settings / Repositories); picking one waits for the pages that show a repo's work.
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronsUpDown, CircleArrowUp, ClipboardCheck, FolderGit2, Gauge, Layers, Settings } from 'lucide-react';
import type { View } from '../../src/desktop/view.ts';
import type { Repo } from '../../src/repos.ts';
import { cn } from './cn.ts';
import { toFix } from './Setup.tsx';

export function Sidebar({ onSettings, settingsOpen, repos, onSetup, setupOpen, view }: {
  onSettings: () => void; settingsOpen: boolean; repos: Repo[] | null; onSetup: () => void; setupOpen: boolean; view: View | null;
}) {
  const bad = toFix(view);
  return (
    <div className="flex h-full flex-col">
      <div className="p-3"><RepoSwitcher served={(repos ?? []).filter((r) => r.served)} /></div>
      <div className="flex-1" />
      <div className="flex items-center gap-1 border-t border-line px-3 py-2">
        <button type="button" onClick={onSettings} aria-label="Settings" title="Settings" aria-expanded={settingsOpen}
          className={cn('grid size-9 place-items-center rounded-lg', settingsOpen ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-ink-2 hover:bg-surface/60 hover:text-ink')}>
          <Settings className="size-[18px]" />
        </button>
        <button type="button" disabled aria-label="Usage" title="Usage: coming soon" className="grid size-9 cursor-not-allowed place-items-center rounded-lg text-faint opacity-60">
          <Gauge className="size-[18px]" />
        </button>
        <button type="button" onClick={onSetup} aria-label={bad ? `Setup: ${bad} to fix` : 'Setup'} title={bad ? `Setup: ${bad} to fix` : 'Setup'} aria-expanded={setupOpen}
          className={cn('relative grid size-9 place-items-center rounded-lg', setupOpen ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-ink-2 hover:bg-surface/60 hover:text-ink')}>
          <ClipboardCheck className="size-[18px]" />
          {bad > 0 && <span data-mark className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-bad ring-2 ring-side" />}
        </button>
        <button type="button" disabled aria-label="Update" title="Updates: coming soon" className="ml-auto grid size-9 cursor-not-allowed place-items-center rounded-lg text-faint opacity-60">
          <CircleArrowUp className="size-[18px]" />
        </button>
      </div>
    </div>
  );
}

function RepoSwitcher({ served }: { served: Repo[] }) {
  return (
    <Popover.Root>
      <Popover.Trigger aria-label="Repository: All repositories"
        className="flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-surface/70 data-[state=open]:bg-surface">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-ink text-page"><Layers className="size-[18px]" /></span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[16px] font-semibold">All repositories</span>
          <span className="block truncate text-[14px] text-mute">{served.length} served</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-faint" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-50 w-[min(320px,calc(100vw-32px))] overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-[0_12px_32px_-8px_rgba(21,23,28,.22)]">
          <div className="flex items-center gap-2.5 rounded-lg bg-sunk px-2 py-1.5">
            <span className="flex size-6 items-center justify-center rounded-md bg-ink text-page"><Layers className="size-3.5" /></span>
            <span className="flex-1 text-[16px] font-medium">All repositories</span>
            <Check className="size-4 text-ink" />
          </div>
          {served.length === 0
            ? <p className="px-2 pb-1 pt-2.5 text-[14.5px] text-mute">No repository is served yet. Switch them on in Settings → Repositories, and they show here.</p>
            : served.map((r) => (
              <div key={r.id} className="flex items-center gap-2.5 px-2 py-1.5" title={r.github ?? r.folder}>
                <span className="flex size-6 items-center justify-center rounded-md bg-sunk text-ink-2"><FolderGit2 className="size-3.5" /></span>
                <span className="min-w-0 flex-1 truncate text-[16px]">{r.title}</span>
              </div>
            ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

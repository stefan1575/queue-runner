// Settings / Repositories (#151), as #36's prototype lays it out: one row per T3 project, its name
// with a "New" or "No GitHub remote" mark, its GitHub repo and folder under it, then who merges,
// Served, and Remove. "Add folder" in the header opens Windows' folder dialog. Removing asks
// first, and asks again when T3 says the project still has threads.
import { FolderPlus, LoaderCircle, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RepoAction, RepoResult, View } from '../../src/desktop/view.ts';
import type { Repo } from '../../src/repos.ts';
import type { Merger } from '../../src/settings.ts';
import { cn } from './cn.ts';
import { Pick, Toggle } from './controls.tsx';
import { runner } from './runner.ts';

export const BTN = 'inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 text-[15px] font-medium hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-45';
const NUDGE = 'rounded-lg border border-you-line bg-you-soft text-you';

/** What a repo action came to: the error to show, or null when it went through. */
export type Done = (error: string | null) => void;

async function ask(action: RepoAction): Promise<RepoResult> {
  try {
    return await runner().repo(action);
  } catch (e) {
    return { error: (e as Error).message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') };
  }
}

function Chip({ tone, title, children }: { tone: 'you' | 'warn' | 'bad'; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={cn('inline-flex h-6 items-center gap-1 rounded-md px-2 text-[13.5px] font-medium',
      tone === 'you' && 'bg-you-soft text-you', tone === 'warn' && 'bg-warn-soft text-warn', tone === 'bad' && 'bg-bad-soft text-bad')}>
      {children}
    </span>
  );
}

export function AddRepo({ onDone }: { onDone: Done }) {
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const r = await ask({ do: 'add' });
    setBusy(false);
    if (r.error) onDone(r.error);
    else if (r.added) onDone(null);
  };
  return (
    <button type="button" onClick={add} disabled={busy} className={BTN}>
      {busy ? <LoaderCircle className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}Add folder
    </button>
  );
}

export function RepoRow({ repo: r, onDone }: { repo: Repo; onDone: Done }) {
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const act = async (action: RepoAction) => {
    setBusy(true);
    const res = await ask(action);
    setBusy(false);
    onDone(res.error ?? null);
  };
  const desc = r.checking ? `${r.folder} · reading its GitHub remote…`
    : r.remoteError ? `${r.folder} · GitHub couldn't be read: ${r.remoteError}`
    : r.github ? `${r.github} · ${r.folder}` : `${r.folder} · can't be served until it has a GitHub remote`;
  return (
    <div className="px-5 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-2.5 lg:flex-nowrap">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[16px] font-medium leading-snug">
            {r.title}
            {r.isNew && <Chip tone="you" title="Added in T3 Code since you last looked">New from T3</Chip>}
            {!r.checking && !r.github && !r.remoteError && <Chip tone="warn" title="The runner works through GitHub issues and pull requests"><TriangleAlert className="size-3.5" />No GitHub remote</Chip>}
            {r.remoteError && <Chip tone="bad"><TriangleAlert className="size-3.5" />gh failed</Chip>}
          </div>
          <div className="mt-1 max-w-[72ch] truncate text-[14px] leading-normal text-mute" title={desc}>{desc}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Pick<Merger> className="w-[172px]" label={`Who merges ${r.title}`} value={r.merge} disabled={!r.served || busy}
            options={[{ id: 'me', label: 'I merge' }, { id: 'runner', label: 'Runner merges' }]}
            onChange={(merge) => act({ do: 'merge', id: r.id, merge })} />
          <span className="grid w-[60px] place-items-center" title={r.served ? 'Served' : r.github ? 'Not served' : "Can't be served"}>
            {busy ? <LoaderCircle className="size-5 animate-spin text-mute" aria-label="Working" />
              : <Toggle label={`Serve ${r.title}`} checked={r.served} disabled={!r.github} onChange={(on) => act({ do: 'serve', id: r.id, on })} />}
          </span>
          <button type="button" onClick={() => setRemoving(true)} aria-label={`Remove ${r.title}`} title="Remove"
            className="grid size-9 place-items-center rounded-lg text-faint hover:bg-sunk hover:text-ink"><Trash2 className="size-4" /></button>
        </div>
      </div>
      {removing && <RemoveDialog repo={r} onClose={() => setRemoving(false)} onDone={onDone} />}
    </div>
  );
}

/** Asks before removing; T3 refusing a project with threads asks again, naming what goes. */
function RemoveDialog({ repo: r, onClose, onDone }: { repo: Repo; onClose: () => void; onDone: Done }) {
  const [threads, setThreads] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const remove = async () => {
    setBusy(true);
    const res = await ask({ do: 'remove', id: r.id, withThreads: threads !== null });
    setBusy(false);
    if (res.notEmpty) return setThreads(res.error ?? '');
    onDone(res.error ?? null);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="remove-title"
        className="w-[min(480px,92vw)] rounded-xl border border-line bg-surface p-5 shadow-2xl">
        <h2 id="remove-title" className="text-[18px] font-semibold">Remove {r.title}?</h2>
        <div className="mt-2 space-y-2 text-[15.5px] text-ink-2">
          {threads === null ? (
            <>
              <p>It leaves the runner and T3 Code: projects sync both ways, so it goes from T3's project list too.</p>
              <p>Nothing else is deleted. The folder at <code className="font-mono text-[14.5px]">{r.folder}</code>{r.github ? <> and everything on GitHub (<code className="font-mono text-[14.5px]">{r.github}</code>)</> : null} stay as they are.</p>
              {r.github && <p className="text-mute">To only stop the runner working on it, switch Served off instead.</p>}
            </>
          ) : (
            <p>{threads} The folder{r.github ? ' and everything on GitHub' : ''} still stay as they are.</p>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={first} type="button" className={BTN} onClick={onClose}>Cancel</button>
          <button type="button" disabled={busy} className={cn(BTN, 'border-bad/40 text-bad hover:bg-bad-soft')} onClick={remove}>
            {busy && <LoaderCircle className="size-4 animate-spin" />}{threads === null ? 'Remove' : 'Remove with its threads'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The page: a nudge while nothing is served, then every repo. The New marks shown here count as
 *  looked at once the page goes away. */
export function ReposPage({ view, onDone }: { view: View; onDone: Done }) {
  const shown = useRef(new Set<string>());
  for (const r of view.repos ?? []) if (r.isNew) shown.current.add(r.id);
  useEffect(() => () => {
    if (shown.current.size) void ask({ do: 'seen', ids: [...shown.current] });
  }, []);
  if (!view.repos) {
    return <p className="px-1 text-[15px] text-mute">{view.reposError ? <>T3 Code isn't answering, so its projects can't be listed: {view.reposError}</> : "Reading T3 Code's projects…"}</p>;
  }
  return (
    <>
      {view.reposError && <p className="mb-4 rounded-lg border border-line px-4 py-2.5 text-[14.5px] text-mute">T3 Code stopped answering, so this list may be behind: {view.reposError}</p>}
      {!view.repos.some((r) => r.served) && <div className={cn(NUDGE, 'mb-4 px-4 py-2.5 text-[14.5px]')}>The runner isn't serving any repository yet, so it has nothing to do. Switch on the ones it should work on.</div>}
      {view.repos.length === 0
        ? <p className="px-1 text-[15px] text-mute">T3 Code has no projects. Add a folder to make one.</p>
        : <RepoCard>{view.repos.map((r) => <RepoRow key={r.id} repo={r} onDone={onDone} />)}</RepoCard>}
    </>
  );
}

const RepoCard = ({ children }: { children: ReactNode }) => (
  <div className="divide-y divide-line-2 rounded-xl border border-line-2 bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">{children}</div>
);

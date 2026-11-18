// Settings, as #36's layout prototype settled it (variant B, round 3: T3 Code's own settings): a
// pop-up over the page, dimmed behind, closed by its X, Escape or a click outside. The page list
// on the left with Search and "/" on top, a "Settings / Page" header, one page at a time, each
// setting a row in a bordered card (a medium title over a smaller grey line, the control on the
// right). A change saves the moment it's made; there's no Save button.
import { CalendarClock, Check, Cpu, Monitor, Search, User, X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { View } from '../../src/desktop/view.ts';
import { DATE_STYLES, clock, formatDate, isTwelveHour, TIME_FORMATS, type DateStyle } from '../../src/display.ts';
import type { SettingsPatch } from '../../src/settings.ts';
import { JOB_KINDS, type JobKind } from '../../src/jobs.ts';
import { PAGES, searchSettings, settingEntries, wantsChoice, type PageId, type SettingId } from '../../src/settings-search.ts';
import type { Open } from './App.tsx';
import { cn } from './cn.ts';
import { NameField, Pick, Toggle } from './controls.tsx';
import { defaultRow, kindRow } from './Models.tsx';
import { runner, useNow } from './runner.ts';

const ICONS: Record<PageId, LucideIcon> = { name: User, models: Cpu, display: CalendarClock, machine: Monitor };

function Row({ title, desc, children, below }: { title: ReactNode; desc?: ReactNode; children?: ReactNode; below?: ReactNode }) {
  return (
    <div className="px-5 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-2.5 lg:flex-nowrap">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[16px] font-medium leading-snug">{title}</div>
          {desc && <div className="mt-1 max-w-[72ch] text-pretty text-[14px] leading-normal text-mute">{desc}</div>}
        </div>
        {children && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>}
      </div>
      {below}
    </div>
  );
}
const Card = ({ children }: { children: ReactNode }) => (
  <div className="divide-y divide-line-2 rounded-xl border border-line-2 bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">{children}</div>
);

export function Settings({ view, open, onOpen, onClose }: { view: View; open: NonNullable<Open>; onOpen: (o: Open) => void; onClose: () => void }) {
  const now = useNow();
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const q = open.query.trim();
  const page = PAGES.find((p) => p.id === open.page) ?? PAGES[0]!;
  const hits = q ? searchSettings(view, now, q) : [];
  const tf = view.timeFormat;
  const { settings: s, account } = view;

  const save = (patch: SettingsPatch) => {
    setError(null);
    runner().set(patch).then(() => setSavedAt(new Date()), (e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')));
  };

  // T3's colours and type, for as long as Settings is open.
  useEffect(() => {
    document.documentElement.classList.add('t3-skin');
    dialog.current?.focus();
    return () => document.documentElement.classList.remove('t3-skin');
  }, []);
  useEffect(() => { pane.current?.scrollTo({ top: 0 }); }, [page.id, q]);

  // "/" jumps to the search box, as in T3; Escape closes (a search box with words clears first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const inField = (e.target as HTMLElement | null)?.closest('input, textarea, [contenteditable]');
      if (e.key === '/' && !inField) { e.preventDefault(); box.current?.focus(); }
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const wants = wantsChoice(view);
  const rows: Record<SettingId, ReactNode> = {
    name: (
      <Row title="Your name" desc={account
        ? <>The runner uses it in the briefs it writes. From your GitHub account, {account.login}, unless you type another.</>
        : <>The runner uses it in the briefs it writes. GitHub couldn't say who you are ({view.accountError}), so type it here.</>}>
        <NameField value={s.name} fallback={account?.name ?? account?.login ?? null} onSave={(name) => save({ name })} />
      </Row>
    ),
    'job-default': defaultRow(view, save, Row),
    ...(Object.fromEntries(JOB_KINDS.map((k) => [`job-${k.id}`, kindRow(k.id, view, save, Row)])) as Record<`job-${JobKind}`, ReactNode>),
    date: (
      <Row title="Date style" desc={<>How dates are written across the app. In tight spots: {formatDate(now, s.dateStyle, tf, true)}.</>}>
        <Pick<DateStyle> className="w-[380px]" label="Date style" value={s.dateStyle}
          options={DATE_STYLES.map((d) => ({ id: d.id, label: formatDate(now, d.id, tf), hint: d.label }))}
          onChange={(dateStyle) => save({ dateStyle })} />
      </Row>
    ),
    clock: (
      <Row title="Clock" desc={<>{isTwelveHour(tf) ? '12-hour' : '24-hour'}, because T3 Code's Time format is {TIME_FORMATS.find((f) => f.id === tf)?.label}. Both apps read the same. Change it in T3 Code: Settings → General → Time format.</>}>
        <span className="text-[15.5px] tabular-nums text-ink-2">{clock(now, tf)}</span>
      </Row>
    ),
    startup: (
      <Row title="Start with Windows" desc="The runner starts in the tray when you sign in.">
        <Toggle label="Start with Windows" checked={s.startWithWindows} onChange={(startWithWindows) => save({ startWithWindows })} />
      </Row>
    ),
  };
  const onPage = (id: PageId) => settingEntries(view, now).filter((e) => e.page === id).map((e) => e.id);

  return (
    <div className="fixed inset-0 z-[36] bg-black/55 px-3 pb-[78px] pt-3 sm:px-[5vw] sm:pt-[4vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Settings"
        className="mx-auto flex h-full w-full max-w-[1560px] overflow-hidden rounded-2xl border border-line-2 bg-page shadow-2xl outline-none">
        <aside className="flex w-[272px] shrink-0 flex-col border-r border-line-2 bg-side max-md:w-[58px]">
          <label className="flex h-[54px] shrink-0 items-center gap-2.5 px-5 max-md:justify-center max-md:px-0">
            <Search className="size-[18px] shrink-0 text-mute" />
            <input ref={box} value={open.query} onChange={(e) => onOpen({ ...open, query: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Escape' && open.query) { e.preventDefault(); onOpen({ ...open, query: '' }); e.currentTarget.blur(); } }}
              placeholder="Search" aria-label="Search settings" className="min-w-0 flex-1 bg-transparent text-[16px] font-medium outline-none placeholder:text-mute max-md:hidden" />
            {q ? <button type="button" onClick={() => { onOpen({ ...open, query: '' }); box.current?.focus(); }} className="rounded p-1 text-mute hover:text-ink max-md:hidden" aria-label="Clear search"><X className="size-4" /></button>
              : <kbd className="rounded-md bg-sunk px-2 py-0.5 font-mono text-[13px] text-mute max-md:hidden">/</kbd>}
          </label>
          <nav aria-label="Settings pages" className="flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-3">
            {PAGES.map((p) => {
              const Icon = ICONS[p.id];
              const count = hits.filter((h) => h.page === p.id).length, on = !q && p.id === page.id, want = !q ? wants[p.id] : undefined;
              return (
                <button key={p.id} type="button" aria-current={on ? 'page' : undefined} title={p.label} onClick={() => onOpen({ page: p.id, query: '' })}
                  className={cn('flex h-[38px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[16px] font-medium max-md:justify-center max-md:px-0', on ? 'bg-sunk text-ink' : 'text-mute hover:bg-sunk/70 hover:text-ink', q && !count && 'opacity-40')}>
                  <Icon className="size-[18px] shrink-0 opacity-80" />
                  <span className="flex-1 max-md:hidden">{p.label}</span>
                  {q && count > 0 && <span className="text-[13.5px] tabular-nums max-md:hidden">{count}</span>}
                  {want ? <span className="rounded-full bg-you px-1.5 text-[12.5px] font-semibold leading-5 text-white tabular-nums max-md:hidden" title="Wants a choice">{want}</span> : null}
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[54px] shrink-0 items-center gap-2.5 border-b border-line-2 pl-6 pr-2 text-[16px]">
            <span className="text-mute">Settings</span>
            <span className="text-faint">/</span>
            <b className="truncate font-semibold">{q ? 'Search' : page.label}</b>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <span className={cn('inline-flex items-center gap-1.5 text-[14.5px] max-sm:hidden', error ? 'text-bad' : 'text-mute')} role="status" aria-live="polite">
                {error ? <>Not saved: {error}</> : savedAt ? <><Check className="size-4 text-ok" />Saved {clock(savedAt, tf)}</> : 'Changes save as you make them'}
              </span>
              <button type="button" onClick={onClose} className="grid size-9 place-items-center rounded-lg text-mute hover:bg-sunk hover:text-ink" aria-label="Close settings" title="Close"><X className="size-[18px]" /></button>
            </div>
          </header>

          <div ref={pane} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1000px] space-y-8 px-5 py-8 sm:px-8">
              {q ? (
                <>
                  {hits.length === 0 && <p className="px-1 text-[15px] text-mute">Nothing matches "{q}". Try what a setting does or what it's set to: "logon", "briefs", "clock", your name, or a date like "nov 19".</p>}
                  {PAGES.filter((p) => hits.some((h) => h.page === p.id)).map((p) => (
                    <section key={p.id}>
                      <h2 className="px-5 pb-2.5 text-[18.5px] font-semibold">
                        <button type="button" onClick={() => onOpen({ page: p.id, query: '' })} className="hover:underline">{p.label}</button>
                      </h2>
                      <Card>{hits.filter((h) => h.page === p.id).map((h) => <div key={h.id}>{rows[h.id]}</div>)}</Card>
                    </section>
                  ))}
                </>
              ) : (
                <section aria-label={page.label}>
                  <Card>{onPage(page.id).map((id) => <div key={id}>{rows[id]}</div>)}</Card>
                </section>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

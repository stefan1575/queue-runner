// The Setup page (#162; #68 story 16): what the runner needs before it can work, each check
// passed or what's missing with how to fix it. A pop-up over the page like Settings, in the
// window's own look, closed by its X, Escape or a click outside. Check again asks the main
// process to run the checks again; the new report arrives with the view.
import { CircleCheck, CircleDashed, CircleX, RotateCw, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { View } from '../../src/desktop/view.ts';
import { clock } from '../../src/display.ts';
import type { SetupCheck } from '../../src/setup.ts';
import { cn } from './cn.ts';
import { runner } from './runner.ts';

/** How many checks want fixing in the last report. */
export const toFix = (view: View | null) => view?.setup.report?.checks.filter((c) => c.state === 'bad').length ?? 0;

/** A fix's words, with `backticked` commands as code. */
function withCode(text: string): ReactNode[] {
  return text.split(/`([^`]+)`/).map((part, i) => (i % 2
    ? <code key={i} className="rounded bg-surface px-1.5 py-px font-mono text-[14px] text-ink ring-1 ring-line">{part}</code>
    : part));
}

const ICON = {
  ok: <CircleCheck className="size-[22px] text-ok" aria-label="Passed" />,
  bad: <CircleX className="size-[22px] text-bad" aria-label="Missing" />,
  waiting: <CircleDashed className="size-[22px] text-faint" aria-label="Not checked yet" />,
};

function CheckRow({ check }: { check: SetupCheck }) {
  return (
    <li data-check-state={check.state} className="flex gap-4 px-5 py-4">
      <span className="mt-0.5 shrink-0">{ICON[check.state]}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[16px] font-semibold leading-snug">{check.label}</div>
        <div className={cn('mt-0.5 text-[15px] leading-normal', check.state === 'waiting' ? 'text-mute' : 'text-ink-2')}>{check.summary}</div>
        {check.items && check.items.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`${check.label} connected`}>
            {check.items.map((it) => (
              <li key={it} className="rounded-md bg-sunk px-2 py-0.5 text-[14px] text-ink-2 ring-1 ring-line">{it}</li>
            ))}
          </ul>
        )}
        {check.state === 'bad' && check.fix && (
          <div className="mt-2.5 rounded-lg bg-bad-soft px-3.5 py-2.5 text-[15px] leading-normal">
            <span className="font-semibold text-bad">How to fix: </span>{withCode(check.fix)}
          </div>
        )}
        {check.detail && (
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[13.5px] leading-normal text-mute">{check.detail}</pre>
        )}
      </div>
    </li>
  );
}

export function Setup({ view, onClose }: { view: View; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState(false);
  const { report, checking, error } = view.setup;
  const busy = checking || asking;
  const bad = toFix(view);

  useEffect(() => { dialog.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const again = () => {
    setAsking(true);
    runner().checkSetup().finally(() => setAsking(false));
  };

  return (
    <div className="fixed inset-0 z-[36] overflow-y-auto bg-black/55 px-3 py-3 sm:px-[5vw] sm:py-[6vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Setup"
        className="mx-auto w-full max-w-[760px] overflow-hidden rounded-2xl border border-line bg-page shadow-2xl outline-none">
        <header className="flex items-start gap-3 border-b border-line px-6 py-5">
          <div className="min-w-0 flex-1">
            <h1 className="text-[21px] font-semibold leading-tight">Setup</h1>
            <p className="mt-1 text-[15px] text-mute">What the runner needs from this PC before it can work.</p>
          </div>
          <button type="button" onClick={again} disabled={busy}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-[15px] font-medium hover:bg-sunk disabled:cursor-default disabled:opacity-70">
            <RotateCw className={cn('size-4', busy && 'animate-spin')} />{busy ? 'Checking…' : 'Check again'}
          </button>
          <button type="button" onClick={onClose} aria-label="Close setup" title="Close"
            className="grid size-9 shrink-0 place-items-center rounded-lg text-mute hover:bg-sunk hover:text-ink"><X className="size-[18px]" /></button>
        </header>

        <div className="px-6 py-5">
          <div role="status" aria-live="polite" className="mb-3.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className={cn('text-[16px] font-semibold', !report ? 'text-mute' : report.ok ? 'text-ok' : 'text-bad')}>
              {!report ? (error ? `The checks couldn't run: ${error}` : 'Checking…')
                : report.ok ? 'Everything the runner needs is in place.'
                  : bad === 1 ? '1 thing to fix' : `${bad} things to fix`}
            </span>
            {report && <span className="text-[14px] text-mute">Checked {clock(new Date(report.at), view.timeFormat)}</span>}
          </div>
          {error && report && <p className="mb-3.5 rounded-lg bg-bad-soft px-3.5 py-2.5 text-[15px] text-bad">The checks couldn't run: {error}</p>}
          {report && (
            <ul className="divide-y divide-line-2 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
              {report.checks.map((c) => <CheckRow key={c.id} check={c} />)}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

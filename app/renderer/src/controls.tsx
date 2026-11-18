// The small controls Settings uses, from #36's prototype: a menu, a switch and the name field.
import * as Popover from '@radix-ui/react-popover';
import * as Switch from '@radix-ui/react-switch';
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn.ts';

export interface Opt<T extends string> { id: T; label: string; hint?: string; node?: ReactNode }

const BOX = 'inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 text-[15.5px] hover:bg-sunk data-[state=open]:bg-sunk disabled:cursor-not-allowed disabled:opacity-50';

export function Pick<T extends string>({ value, options, onChange, label, className, disabled }: {
  value: T; options: Opt<T>[]; onChange: (v: T) => void; label: string; className?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.id === value);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger disabled={disabled} aria-label={`${label}: ${cur?.label ?? value}`} className={cn(BOX, className)}>
        <span className="min-w-0 truncate">{cur?.node ?? cur?.label ?? value}</span>
        <ChevronDown className="ml-auto size-4 shrink-0 text-faint" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="z-50 min-w-[max(190px,var(--radix-popover-trigger-width))] max-w-[min(420px,92vw)] rounded-lg border border-line bg-surface p-1 shadow-lg">
          {options.map((o) => (
            <button key={o.id} type="button" onClick={() => { setOpen(false); if (o.id !== value) onChange(o.id); }}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[15.5px] hover:bg-sunk">
              <Check className={cn('mt-[3px] size-4 shrink-0', o.id === value ? 'text-ink' : 'invisible')} />
              <span className="min-w-0">
                <span className={cn('block', o.id === value && 'font-semibold')}>{o.node ?? o.label}</span>
                {o.hint && <span className="block text-[14px] text-mute">{o.hint}</span>}
              </span>
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Switch.Root checked={checked} onCheckedChange={onChange} aria-label={label}
      className="relative h-6 w-[42px] shrink-0 rounded-full bg-faint transition-colors data-[state=checked]:bg-on disabled:cursor-not-allowed disabled:opacity-40">
      <Switch.Thumb className="block size-[18px] translate-x-[3px] rounded-full bg-surface shadow transition-transform data-[state=checked]:translate-x-[21px]" />
    </Switch.Root>
  );
}

/** The name saves when you leave the field or press Enter, not on every key, and when the field
 *  goes away with typing not yet saved (Settings closed by a click on the backdrop, which takes
 *  the field away before it hears a blur). Emptied, it goes back to the GitHub account's name
 *  (`fallback`). Escape puts back what was saved. */
export function NameField({ value, fallback, onSave }: { value: string | null; fallback: string | null; onSave: (name: string | null) => void }) {
  const shown = value ?? fallback ?? '';
  const [text, setText] = useState(shown);
  // Typing not yet saved; the commit on going away reads it after the last render.
  const typed = useRef<string | null>(null);
  useEffect(() => { typed.current = null; setText(shown); }, [shown]);
  const commit = () => {
    if (typed.current === null) return;
    const t = typed.current.trim();
    typed.current = null;
    if (!t) { if (value !== null) onSave(null); else setText(shown); return; }
    if (t !== shown || (value === null && t !== fallback)) onSave(t);
  };
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => () => latest.current(), []);
  return (
    <input
      aria-label="Your name" value={text} spellCheck={false} autoComplete="off" placeholder={fallback ?? 'Your name'}
      onChange={(e) => { typed.current = e.target.value; setText(e.target.value); }} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.preventDefault(); typed.current = null; setText(shown); } }}
      className="h-9 w-[240px] max-w-full rounded-lg border border-line bg-surface px-3 text-[15.5px] placeholder:text-faint"
    />
  );
}

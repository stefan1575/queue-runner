// The Models page (#152, #36's Roles page with #120's kinds): Default, then one row per kind of
// job, each showing "Follows Default" until it's set, with its fallback beside its model. The
// choices are T3's (its connected providers, their models, each model's efforts). A role's three
// dropdowns keep their width, so changing the provider moves nothing (#36). A new install follows
// T3's default, with a nudge to choose; choosing or "Keep this" pins it.
import { Plus, Undo2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { View } from '../../src/desktop/view.ts';
import {
  defaultModel, JOB_KINDS, kindModels, model, withModel, withProvider,
  type Catalog, type JobKind, type Jobs, type ModelChoice,
} from '../../src/jobs.ts';
import type { SettingsPatch } from '../../src/settings.ts';
import { cn } from './cn.ts';
import { Pick } from './controls.tsx';

const NUDGE = 'rounded-lg border border-you-line bg-you-soft text-you';
const ICON_BTN = 'grid size-9 shrink-0 place-items-center rounded-lg text-mute hover:bg-sunk hover:text-ink';
const NO_EFFORT = '-';

export function Chip({ children, you }: { children: ReactNode; you?: boolean }) {
  return <span className={cn('rounded-md px-1.5 py-0.5 text-[13px] font-medium', you ? 'bg-you-soft text-you' : 'bg-sunk text-mute')}>{children}</span>;
}

/** A provider, a model and an effort, each from T3, each at a fixed width. */
export function ModelPicks({ label, value, catalog, onChange }: { label: string; value: ModelChoice; catalog: Catalog; onChange: (c: ModelChoice) => void }) {
  const p = catalog.providers.find((x) => x.id === value.provider);
  const m = model(catalog, value);
  const efforts = m?.efforts ?? [];
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Pick className="w-[168px]" label={`${label} provider`} value={value.provider}
        options={catalog.providers.map((x) => ({ id: x.id, label: x.label }))}
        onChange={(id) => onChange(withProvider(value, id, catalog))} />
      <Pick className="w-[196px]" label={`${label} model`} value={value.model}
        options={(p?.models ?? []).map((x) => ({ id: x.id, label: x.label }))}
        onChange={(id) => onChange(withModel(value, id, catalog))} />
      <Pick className="w-[132px]" label={`${label} effort`} value={value.effort ?? NO_EFFORT} disabled={!efforts.length}
        options={efforts.length ? efforts : [{ id: NO_EFFORT, label: 'No effort' }]}
        onChange={(effort) => onChange({ ...value, effort })} />
    </span>
  );
}

/** A first fallback: another provider's default model, if T3 has another. */
function firstFallback(from: ModelChoice, catalog: Catalog): ModelChoice {
  const other = catalog.providers.find((p) => p.id !== from.provider);
  return other ? withProvider(from, other.id, catalog) : from;
}

type Props = { view: View; save: (patch: SettingsPatch) => void };

/** Why there's nothing to choose from yet, or null when there is. */
export function catalogNote(view: View): ReactNode {
  if (!view.catalog) return view.catalogError ? <>T3 Code can't be asked for its models: {view.catalogError}</> : <>Asking T3 Code for its models…</>;
  if (!view.catalog.providers.length) return <>T3 Code has no provider connected. Connect one in T3 Code: Settings → Providers.</>;
  return null;
}

export function defaultRow(view: View, save: Props['save'], Row: RowFn): ReactNode {
  const jobs = view.settings.jobs;
  const c = view.catalog;
  const note = catalogNote(view);
  const d = c && !note ? defaultModel(jobs, c) : null;
  const set = (choice: ModelChoice) => save({ jobs: { ...jobs, default: choice } });
  return (
    <Row title={<>Default{d?.followsT3 && <Chip you>T3's default</Chip>}</>}
      desc={<>Every kind of job below runs on this unless it has its own.{view.catalogError && c ? ` T3 Code can't be asked right now (${view.catalogError}); these are its last answer.` : ''}{note && <> {note}</>}</>}
      below={d?.followsT3 && d.choice && (
        <div className={cn(NUDGE, 'mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-[14.5px]')}>
          <span className="flex-1">Not your choice yet: this is T3 Code's default model. Pick the model you want doing the jobs, or keep this one.</span>
          <button type="button" onClick={() => set(d.choice!)} className="h-8 rounded-md bg-on px-2.5 font-medium text-white">Keep this</button>
        </div>
      )}>
      {c && d?.choice && (
        // the kinds' undo slot, empty, so Default's dropdowns line up with theirs
        <span className="inline-flex items-center gap-1">
          <ModelPicks label="Default" value={d.choice} catalog={c} onChange={set} /><span className="size-9 shrink-0" />
        </span>
      )}
    </Row>
  );
}

export function kindRow(kind: JobKind, view: View, save: Props['save'], Row: RowFn): ReactNode {
  const k = JOB_KINDS.find((x) => x.id === kind)!;
  const jobs = view.settings.jobs;
  const c = view.catalog;
  const ready = c && !catalogNote(view);
  const m = ready ? kindModels(jobs, kind, c) : null;
  const put = (part: Partial<Jobs[JobKind]>) => save({ jobs: { ...jobs, [kind]: { ...jobs[kind], ...part } } });
  return (
    <Row title={<>{k.label}{m?.followsDefault && <Chip>Follows Default</Chip>}</>} desc={k.does}>
      {c && m?.choice && (
        <div className="flex flex-col items-end gap-2">
          <span className="inline-flex items-center gap-1">
            <ModelPicks label={k.label} value={m.choice} catalog={c} onChange={(own) => put({ own })} />
            <button type="button" onClick={() => put({ own: null })} title="Follow Default" aria-label={`${k.label}: follow Default`}
              className={cn(ICON_BTN, m.followsDefault && 'invisible')}><Undo2 className="size-4" /></button>
          </span>
          <span className="inline-flex items-center gap-1">
            {m.fallback ? (
              <>
                <span className="mr-1 text-[14px] text-mute">Fallback</span>
                <ModelPicks label={`${k.label} fallback`} value={m.fallback} catalog={c} onChange={(fallback) => put({ fallback })} />
                <button type="button" onClick={() => put({ fallback: null })} title="No fallback" aria-label={`${k.label}: no fallback`} className={ICON_BTN}><X className="size-4" /></button>
              </>
            ) : (
              <button type="button" onClick={() => put({ fallback: firstFallback(m.choice!, c) })}
                className="mr-10 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[14px] text-mute hover:bg-sunk hover:text-ink">
                <Plus className="size-4" />Add a fallback for when {c.providers.find((p) => p.id === m.choice!.provider)?.label ?? m.choice.provider} is out of usage
              </button>
            )}
          </span>
        </div>
      )}
    </Row>
  );
}

export type RowFn = (props: { title: ReactNode; desc?: ReactNode; children?: ReactNode; below?: ReactNode; dim?: boolean }) => ReactNode;

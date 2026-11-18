// The Your share page (#153, #36's "Your share of each plan"): one row per provider per weekly
// window, each keeping a percent for you (0% by default) until some hours before the window
// resets (24 by default). The windows are T3's; a provider T3 reads no usage for shows its row
// greyed, "Coming soon", since the runner can't keep a share of what it can't read.
import type { ReactNode } from 'react';
import type { View } from '../../src/desktop/view.ts';
import { formatDate } from '../../src/display.ts';
import type { SettingsPatch } from '../../src/settings.ts';
import { MAX_RELEASE_HOURS, releaseAt, type ShareRow } from '../../src/shares.ts';
import { cn } from './cn.ts';
import { NumberField } from './controls.tsx';
import { Chip, type RowFn } from './Models.tsx';

/** Why there are no rows yet, or null when T3 has answered. */
export function usageNote(view: View): ReactNode {
  if (view.usage.length) return null;
  if (!view.catalog) return view.catalogError ? <>T3 Code can't be asked for its usage: {view.catalogError}</> : <>Asking T3 Code for its usage…</>;
  return <>T3 Code has no provider connected. Connect one in T3 Code: Settings → Providers.</>;
}

export function shareRow(r: ShareRow, view: View, save: (patch: SettingsPatch) => void, Row: RowFn): ReactNode {
  const { settings: s, timeFormat: tf } = view;
  const when = (d: Date) => formatDate(d, s.dateStyle, tf, true);
  const put = (part: Partial<ShareRow['share']>) => save({ shares: { ...s.shares, [r.key]: { ...r.share, ...part } } });
  const released = releaseAt(r.share, r.resetsAt);
  const desc = !r.enforced
    ? <>T3 Code doesn't read this provider's usage yet, so the runner can't keep a share of it.</>
    : <>{r.resetsAt ? <>Resets {when(new Date(r.resetsAt))}. </> : null}{r.share.percent === 0
      ? 'Nothing is kept: the runner may use all of it.'
      : <>The runner stops at {100 - r.share.percent}% used{released ? <>, then may use the rest from {when(released)}</> : null}.</>}</>;
  return (
    <Row dim={!r.enforced} title={<>{r.title}{!r.enforced && <Chip>Coming soon</Chip>}</>} desc={desc}>
      <span className={cn('flex items-center gap-2 text-[15px]', !r.enforced && 'opacity-55')}>
        Keep<NumberField label={`Percent of ${r.title} kept`} value={r.share.percent} min={0} max={100} disabled={!r.enforced} onSave={(percent) => put({ percent })} />%
        <span className={cn('flex items-center gap-2 pl-2', r.enforced && r.share.percent === 0 && 'opacity-55')}>
          until<NumberField label={`Hours before ${r.title} resets`} value={r.share.releaseHours} min={0} max={MAX_RELEASE_HOURS} disabled={!r.enforced} onSave={(releaseHours) => put({ releaseHours })} />hours before the reset
        </span>
      </span>
    </Row>
  );
}

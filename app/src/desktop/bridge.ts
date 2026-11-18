// What the preload script gives the window (`window.runner`): the runner's view, its changes,
// and saving a setting. The window has no other door to the main process.
import type { SettingsPatch } from '../settings.ts';
import type { View } from './view.ts';

export type Bridge = {
  view(): Promise<View>;
  /** Saves one change; rejects with the reason when the main process refuses it. */
  set(patch: SettingsPatch): Promise<View>;
  /** Every new view, as the main process sends it. Returns the way to stop listening. */
  onView(listener: (view: View) => void): () => void;
};

export const CHANNELS = { view: 'runner:view', set: 'runner:set', changed: 'runner:changed' } as const;

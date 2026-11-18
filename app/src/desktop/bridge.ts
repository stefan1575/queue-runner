// What the preload script gives the window (`window.runner`): the runner's view, its changes,
// and saving a setting. The window has no other door to the main process.
import type { SettingsPatch } from '../settings.ts';
import type { RepoAction, RepoResult, View } from './view.ts';

export type Bridge = {
  view(): Promise<View>;
  /** Saves one change; rejects with the reason when the main process refuses it. */
  set(patch: SettingsPatch): Promise<View>;
  /** Asks something of Repositories (switch one on, add one, ...); says how it went. */
  repo(action: RepoAction): Promise<RepoResult>;
  /** Runs Setup's checks again (#162); the view carries the new report. */
  checkSetup(): Promise<View>;
  /** Every new view, as the main process sends it. Returns the way to stop listening. */
  onView(listener: (view: View) => void): () => void;
};

export const CHANNELS = { view: 'runner:view', set: 'runner:set', repo: 'runner:repo', setup: 'runner:setup', changed: 'runner:changed' } as const;

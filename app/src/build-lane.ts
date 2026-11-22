// What's left of the app's build lane (#154) after its port (#219: `src/run.ts`): the repo type the
// old review, fix, merge and conflict lanes still take. It goes with the last of them (#224).
import type { Merger } from './settings.ts';

/** A repo the old lanes work in: a served T3 project. `github` is null only for a live check's
 *  sandbox, which has no GitHub. `merge` says who merges its clean PRs (#156): the app, or the
 *  user (the default). */
export type BuildRepo = { id: string; title: string; folder: string; github: string | null; merge?: Merger };

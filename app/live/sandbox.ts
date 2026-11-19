// The live review check's repo (#155 F18, F21): the one T3 project whose folder is a clone of the
// GitHub sandbox, found by that remote and not by its title, so it never meets the build check's
// "queue-runner sandbox" (a local bare origin; its own setup). On this machine it's "queue-runner
// sandbox GitHub". Its folder is the repo's. A review's checkout is a worktree of that folder, because T3 binds
// `existing_worktree` only to a path in the project's own `git worktree list` (its launch's
// `assertProjectWorktree`, checked against the installed server 2026-11-19); a checkout of a
// clone elsewhere is refused before any review starts.
import type { GitHub } from '../src/github.ts';
import { listProjects } from '../src/projects.ts';
import type { T3Mcp } from '../src/t3/mcp.ts';

export const SANDBOX_GITHUB = 'stefan1575/queue-runner-sandbox';

/** The one T3 project cloned from the GitHub sandbox, as a repo to review in, or throws (refusing)
 *  for none or several. */
export async function sandboxRepo(mcp: Pick<T3Mcp, 'call'>, github: Pick<GitHub, 'remoteOf'>): Promise<{ id: string; title: string; folder: string; github: string }> {
  const found = (await listProjects(mcp, github as GitHub)).filter((p) => p.remote?.nameWithOwner === SANDBOX_GITHUB);
  if (found.length !== 1) {
    const which = found.map((p) => ` (${p.title} at ${p.folder})`).join(',');
    throw new Error(`expected one T3 project whose folder is a clone of ${SANDBOX_GITHUB}, found ${found.length}${which}: refusing`);
  }
  const p = found[0]!;
  return { id: p.id, title: 'queue-runner-sandbox', folder: p.folder, github: SANDBOX_GITHUB };
}

/** What the check says when the review never started: T3's refusal, said plainly. */
export function notStartedLine(end: { outcome: string; error?: string | null } | null | undefined): string | null {
  if (end?.outcome !== 'not-started') return null;
  return `T3 didn't start the review: ${end.error ?? 'no reason given'}`;
}

// The cap (#158): a PR that isn't getting clean stops spending and comes back to the user for a
// rethink, with a decision thread's Approach note. "Review 3 still blocking": the loop gets
// CAP - 1 rounds on a PR, and when the next would be one more (a fix round for review CAP's
// blocking verdict, or any round the loop would start) it stops instead. Every round counts: a fix
// round for a blocking review, a fix round for a check that failed again after its re-run, a
// conflict round (one that couldn't resolve its conflict included). The count starts again from
// the user's answer to the PR's last stop, so after it the loop gets CAP - 1 more.
//
// **The number is arbitrary and lives here only.** Every lane asks `capReached`.
import type { JobLog } from './job-log.ts';

/** The review that, still blocking, comes to the user with an Approach note instead of a fix round. */
export const CAP = 3;

/** The PR's rounds since the user last answered a stop on it: fix and conflict rounds that ran or
 *  run (one that started no thread, or needs the user, ran nothing). */
export function roundsSinceAnswer(log: JobLog, repo: string, pr: number): number {
  const since = log.lastAnswer(repo, pr)?.answered!.at ?? '';
  return log.jobs().filter((j) => j.repo === repo && j.issue === pr && (j.kind === 'fix' || j.kind === 'conflict')
    && j.startedAt > since && j.end?.outcome !== 'not-started' && j.end?.outcome !== 'needs-user').length;
}

/** Whether another round on the PR would pass the cap: CAP - 1 have run since the user's last answer. */
export const capReached = (log: JobLog, repo: string, pr: number) => roundsSinceAnswer(log, repo, pr) >= CAP - 1;

/** Why a cap stop is filed, for the user. */
export const capText = (rounds: number, what: string) =>
  `${rounds} round${rounds === 1 ? '' : 's'} since your last answer and ${what}: the PR stops here for a rethink (the cap is review ${CAP} still blocking)`;

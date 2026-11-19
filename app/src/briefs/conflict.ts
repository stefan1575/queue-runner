// The conflict brief (#157): today's `queue_runner/templates/conflict.md`, ported. A PR whose head
// conflicts with its base gets a fresh thread that merges the base in, resolves the conflict and
// pushes; a fresh reviewer then reviews the new head. Built from sources, never a handoff file: the
// PR's commits and files and what landed on the base since, from git; the earlier threads' links
// from the job log. Self-contained (docs/app.md, Rules), and Before you push comes from `rules.ts`.
// What is the user's to decide is this brief's own: a conflict it can't resolve is never pushed
// half done (the shared rule says to push what you have), it ends without a push.
import { ASK_BLOCK, BEFORE_YOU_PUSH, directionFirst } from './rules.ts';

/** A conflict brief lists at most this many of the base's new commits, as today's does. */
export const BASE_COMMITS = 30;

/** Where the round works: the PR's own worktree (`worktree`), or a new worktree at H on the local
 *  branch `work`, pushing to the PR's branch (`new`). */
export type ConflictWhere = { kind: 'worktree' } | { kind: 'new'; work: string };

export type ConflictBriefInput = {
  /** `owner/name`. */
  github: string;
  number: number;
  title: string;
  /** The PR's head, which conflicts. */
  sha: string;
  branch: string;
  base: string;
  user: string;
  where: ConflictWhere;
  agentsFile: 'AGENTS.md' | 'CLAUDE.md' | null;
  body: string;
  closes: string[];
  commits: { sha: string; subject: string }[];
  /** What landed on the base since the PR left it, oldest first. */
  landed: { sha: string; subject: string }[];
  diffstat: string;
  threads: { kind: string; startedAt: string; outcome: string; link: string }[];
  /** What the user said when they answered the PR's stop (#158 F9): told first. */
  direction?: string | null;
};

const TEMPLATE = `Conflict round on PR #$number in $github: $title

The queue runner started this job because the PR's head $sha7 conflicts with \`$base\`, so it can't
merge. Merge \`$base\` in, resolve the conflict, and push. $user isn't watching it live. Everything
you need is below or in the repo. There are no handoff files.
$direction
## Where you are

$where
- $agents

## What to do

1. \`git fetch origin $base\`, then \`git merge origin/$base\`. Merge, don't rebase: the PR's
   commits and their review comments stay as they are, and nothing needs a force-push.
2. Resolve each conflict so that both sides' intent survives: what the PR does, and what landed
   on \`$base\` since. Read the commits below that touch the same files to see why they changed.
   Where the two can't both hold (one removes what the other builds on), that is $user's call:
   see the last point.
3. Run the repo's checks and tests (its \`AGENTS.md\` says which) on the merged result and fix
   what the merge broke, in the PR's change only.
4. Commit the merge, with a message that names the conflicted files and how each was resolved,
   go through Before you push (below), then push: \`git push origin HEAD:$branch\`. A fresh
   reviewer reviews the new head.

## The PR

$body

It closes: $closes

### Its commits (\`$base..$sha7\`)

$commits

### Files it changes

\`\`\`
$diffstat
\`\`\`

### Landed on \`$base\` since the PR left it

$landed

Read the whole change with \`git diff origin/$base...HEAD\`, and the PR's comments with
\`gh pr view $number --repo $github --comments\`.

## Earlier threads on this PR

$threads

## How to work

- Don't add features or fix review findings in this round: only the merge, its conflicts, and
  what the merge broke. A fresh reviewer reviews the result.
- Don't merge the PR, review it, set statuses or edit its \`## Review\` table: the runner does
  those.
- Don't schedule, watch or wait on anything (no scheduled tasks, PR watches, wake-ups or
  monitors). The runner does the waiting.
- **If you can't resolve it** (the two sides' intent can't both hold, or it needs a choice only
  $user can make): don't push. Abort the merge (\`git merge --abort\`), comment on the PR
  (\`gh pr comment $number --repo $github\`) naming the conflicted files and the choice, and end
  your turn. ${ASK_BLOCK}

${BEFORE_YOU_PUSH}`;

function where(i: ConflictBriefInput): string {
  const reject = `If the push is rejected because \`${i.branch}\` moved, don't force-push: say so on the PR and end your turn.`;
  if (i.where.kind === 'new') {
    return `- Repo: \`${i.github}\`, in a fresh T3 worktree at the PR's head \`${i.sha}\` on a local branch \`${i.where.work}\`. The PR's own branch is \`${i.branch}\`, merging into \`${i.base}\`.\n`
      + `- **Push to the PR's branch, not to \`${i.where.work}\`:** \`git push origin HEAD:${i.branch}\`. ${reject}`;
  }
  return `- Repo: \`${i.github}\`, in the PR's own worktree on its branch \`${i.branch}\`, merging into \`${i.base}\`.\n`
    + `- First \`git fetch origin\` and check \`HEAD\` is at the PR's head \`${i.sha}\` (\`git log -1\`). If it's behind, \`git merge --ff-only origin/${i.branch}\`; if it can't fast-forward, say so on the PR and end your turn.\n`
    + `- Push to \`${i.branch}\`: \`git push origin HEAD:${i.branch}\`. ${reject}`;
}

function agentsPointer(file: ConflictBriefInput['agentsFile']): string {
  return file
    ? `Read the repo's \`${file}\` first, and the docs it points to for what you touch.`
    : "The repo has no `AGENTS.md`; follow its README and existing conventions.";
}

const line = (c: { sha: string; subject: string }) => `- \`${c.sha.slice(0, 7)}\` ${c.subject}`;

/** Fills the template: each `$name` once, with nothing in a filled value read again. */
export function conflictBrief(i: ConflictBriefInput): string {
  const shown = i.landed.slice(-BASE_COMMITS);
  const older = i.landed.length - shown.length;
  const values: Record<string, string> = {
    direction: directionFirst(i.user, i.direction),
    number: String(i.number), github: i.github, title: i.title, sha7: i.sha.slice(0, 7),
    base: i.base, branch: i.branch, user: i.user, where: where(i), agents: agentsPointer(i.agentsFile),
    body: i.body.trim() || '(The PR has no description.)',
    closes: i.closes.join(', ') || 'no issue',
    commits: i.commits.map(line).join('\n') || 'None.',
    diffstat: i.diffstat.trimEnd() || '(none)',
    landed: (older ? `(${older} older ones not shown)\n` : '') + (shown.map(line).join('\n') || 'None found.'),
    threads: i.threads.map((t) => `- ${t.kind} job, ${t.startedAt.slice(0, 16)}, ended ${t.outcome}: ${t.link}`).join('\n') || 'None started by the runner.',
  };
  return TEMPLATE.replace(/\$([a-z0-9]+)/g, (whole, name: string) => values[name] ?? whole);
}

/** The template as it is, unfilled: the tests hold it to the brief rules. */
export const CONFLICT_TEMPLATE = TEMPLATE;

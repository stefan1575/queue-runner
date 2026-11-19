// The fix brief (#156): today's `queue_runner/templates/fix.md`, ported. A fix round goes back to
// the thread that wrote the PR (its builder, or the fresh fixer that took over), so it starts with
// what that thread knows; a fresh fixer gets the same brief, saying why it was called in. Built
// from sources, never a handoff file: the findings, classes and earlier declines from the ledger
// in the PR's newest review comment, the branch's commits and the files it changes from git, the
// earlier threads' links from the job log. Self-contained (docs/app.md, Rules), and the rules other
// briefs share (Before you push, the screenshots, what is the user's to decide) come from
// `rules.ts`, written there once.
import { STATUSES, type Finding } from '../review/ledger.ts';
import { openLine } from './review.ts';
import { BEFORE_YOU_PUSH, directionFirst, SCREENSHOTS, USERS_TO_DECIDE_ON_PR } from './rules.ts';

/** Where the round works: in the thread that wrote the PR (`thread`), a fresh fixer in the PR's
 *  own worktree (`worktree`), or a fresh fixer in a new worktree at H on the local branch `work`,
 *  pushing to the PR's branch (`new`). */
export type FixWhere = { kind: 'thread' } | { kind: 'worktree' } | { kind: 'new'; work: string };

export type FixBriefInput = {
  /** `owner/name`. */
  github: string;
  number: number;
  title: string;
  /** The blocking review's round, and the head it reviewed; null for a round on a check that
   *  failed again after its re-run (#158), whose names and logs are `checks`. */
  round: number | null;
  checks?: { name: string; log: string }[];
  /** What the user said when they answered the PR's stop (#158): told first, before anything else. */
  direction?: string | null;
  sha: string;
  branch: string;
  base: string;
  user: string;
  where: FixWhere;
  /** Why a fresh fixer was called in, or null for a round sent to the thread that wrote the PR. */
  fresh: string | null;
  agentsFile: 'AGENTS.md' | 'CLAUDE.md' | null;
  reviewLink: string | null;
  /** The PR's findings as the blocking review left them. */
  findings: Finding[];
  body: string;
  closes: string[];
  commits: { sha: string; subject: string }[];
  diffstat: string;
  threads: { kind: string; startedAt: string; outcome: string; link: string }[];
};

const TEMPLATE = `Fix round on PR #$number in $github: $title

The queue runner started this round because $because.
$user isn't watching it live. Everything you need is below or in the repo. There are no handoff
files.
$direction
$who

## Where you are

$where
- $agents

$found

## The PR

$body

It closes: $closes

### Its commits (\`$base..$sha7\`)

$commits

### Files it changes

\`\`\`
$diffstat
\`\`\`

Read the whole change with \`git diff origin/$base...HEAD\`, and the review comments with
\`gh pr view $number --repo $github --comments\`.

## Earlier threads on this PR

$threads

## How to work

- For each Important finding: before fixing it, write its cause in one line in the commit message:
  what in the code lets the failure happen, not the scenario the review describes. Write a failing
  test first where one fits. Fix the cause, and add a test for a second case of it besides the
  review's scenario where one fits, then fix every other case of its class. A fix that only
  adjusts a value or a format (a precision, a pattern, a timeout, an indentation) rather than
  removing the cause says in the commit message why the cause can't recur.
- If a finding is wrong, decline it: comment on the PR (\`gh pr comment $number --repo $github\`)
  naming the finding's ID, the reason and the evidence. The best evidence is a test, committed
  and pushed, that passes now and would fail if the finding were right. The reviewer reconsiders
  a decline once, in the next review.
- **A missing or wrong screenshot finding:** shoot the screen the finding names (Screenshots,
  below), open the new after shots once to check they show it, add them to the PR body, and push
  (an empty commit if the code didn't change, so there is a new head to review). If the screen
  can't be captured, say so on the PR and end your turn.
- Commit after every step, with the decision in the commit message: what you chose and why. A
  usage limit can cut this thread off at any point, and the next job starts from your commits.
- A failed check: find its cause in the log below and fix that, with a test where one fits. If it's
  a flaky test, make it reliable rather than skipping it; if the failure isn't the PR's (the base
  fails it too), say so on the PR with the evidence and end your turn.
- When every finding is fixed or declined, go through Before you push (below), then end the round
  by pushing to \`$branch\`. A round that ends without a push isn't reviewed again: the PR waits
  for $user. A fresh reviewer reviews the new head.
- Don't merge, set statuses or edit the PR's \`## Review\` table: the runner does those.
- Don't schedule, watch or wait on anything (no scheduled tasks, PR watches, wake-ups or
  monitors). The runner does the waiting.
${USERS_TO_DECIDE_ON_PR}

${SCREENSHOTS}

${BEFORE_YOU_PUSH}`;

function where(i: FixBriefInput): string {
  const at = `the PR's head \`${i.sha}\``;
  const reject = `If the push is rejected because \`${i.branch}\` moved, don't force-push: say so on the PR and end your turn.`;
  if (i.where.kind === 'new') {
    return `- Repo: \`${i.github}\`, in a fresh T3 worktree at ${at} on a local branch \`${i.where.work}\`. The PR's own branch is \`${i.branch}\`, merging into \`${i.base}\`.\n`
      + `- **Push to the PR's branch, not to \`${i.where.work}\`:** \`git push origin HEAD:${i.branch}\`. ${reject}`;
  }
  const mine = i.where.kind === 'thread' ? 'your worktree' : "the PR's own worktree";
  return `- Repo: \`${i.github}\`, in ${mine} on the PR's branch \`${i.branch}\`, merging into \`${i.base}\`.\n`
    + `- First \`git fetch origin\` and check \`HEAD\` is at ${at} (\`git log -1\`). If it's behind, \`git merge --ff-only origin/${i.branch}\`; if it can't fast-forward, say so on the PR and end your turn.\n`
    + `- Push to \`${i.branch}\`: \`git push origin HEAD:${i.branch}\`. ${reject}`;
}

function agentsPointer(file: FixBriefInput['agentsFile']): string {
  return file
    ? `Read the repo's \`${file}\` first, and the docs it points to for what you touch.`
    : "The repo has no `AGENTS.md`; follow its README and existing conventions.";
}

const REVIEW_FOUND = `## What review $round found

The review: $review

### Important (each one blocks the merge)

$important

**Classes to fix:** $classes. Fix every case of each class in the PR's change, not only the line
cited: look for the same kind of problem everywhere the PR touches.

### Nits (optional)

$nits

### Settled in earlier reviews

$settled`;

/** How much of each failed check's log the brief carries: its end, where the failure is. */
export const LOG_CHARS = 6000;

function checksFound(i: FixBriefInput): string {
  const logs = (i.checks ?? []).map((c) => {
    const log = c.log.length > LOG_CHARS ? `(the first ${c.log.length - LOG_CHARS} characters left out)\n${c.log.slice(-LOG_CHARS)}` : c.log;
    return `### ${c.name}\n\n\`\`\`\n${log.trimEnd() || '(GitHub gave no log for it)'}\n\`\`\``;
  });
  return `## What failed\n\nEach check below failed on \`${i.sha.slice(0, 7)}\`, and failed again after its one re-run. Its failing log:\n\n`
    + (logs.join('\n\n') || 'No log could be read.');
}


/** Fills the template: each `$name` once, with nothing in a filled value read again. */
export function fixBrief(i: FixBriefInput): string {
  const important = i.findings.filter((f) => f.tag === 'important' && (f.status === 'open' || f.status === 'decline-kept'));
  const nits = i.findings.filter((f) => f.tag === 'nit' && (f.status === 'open' || f.status === 'decline-kept'));
  const settled = i.findings.filter((f) => f.status === 'fixed' || f.status === 'decline-accepted');
  const classes = [...new Set(important.map((f) => f.class.trim()).filter(Boolean))];
  const found: Record<string, string> = {
    round: String(i.round), review: i.reviewLink ?? `review ${i.round} on the PR`,
    important: important.map(openLine).join('\n') || 'None.',
    classes: classes.map((c) => `"${c}"`).join('; ') || 'none named',
    nits: nits.map(openLine).join('\n') || 'None.',
    settled: settled.map((f) => `- **${f.id}** · ${f.class || 'no class'} · ${(STATUSES as Record<string, string>)[f.status]!.toLowerCase()}`).join('\n') || 'None.',
  };
  const checks = i.round === null;
  const values: Record<string, string> = {
    because: checks
      ? `checks on the PR's head ${i.sha.slice(0, 7)} failed, and failed again after their one re-run (${(i.checks ?? []).map((c) => c.name).join(', ') || 'no name given'})`
      : `review ${i.round} of the PR's head ${i.sha.slice(0, 7)} is blocking`,
    direction: directionFirst(i.user, i.direction),
    found: checks ? checksFound(i) : REVIEW_FOUND.replace(/\$([a-z]+)/g, (whole, name: string) => found[name] ?? whole),
    number: String(i.number), github: i.github, title: i.title, sha7: i.sha.slice(0, 7),
    base: i.base, branch: i.branch, user: i.user,
    who: i.fresh
      ? `You're a fresh fixer, called in for this round: ${i.fresh}. Read the change and ${checks ? 'what failed' : 'the review'} below before you start.`
      : `This round comes back to the thread that wrote the PR, so you start with what you know of it. Read ${checks ? 'what failed' : 'the review'} below afresh all the same.`,
    where: where(i), agents: agentsPointer(i.agentsFile),
    body: i.body.trim() || '(The PR has no description.)',
    closes: i.closes.join(', ') || 'no issue',
    commits: i.commits.map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.subject}`).join('\n') || 'None.',
    diffstat: i.diffstat.trimEnd() || '(none)',
    threads: i.threads.map((t) => `- ${t.kind} job, ${t.startedAt.slice(0, 16)}, ended ${t.outcome}: ${t.link}`).join('\n') || 'None started by the runner.',
  };
  return TEMPLATE.replace(/\$([a-z0-9]+)/g, (whole, name: string) => values[name] ?? whole);
}

/** The template as it is, unfilled, with its review section: the tests hold it to the brief rules. */
export const FIX_TEMPLATE = `${TEMPLATE}\n\n${REVIEW_FOUND}`;

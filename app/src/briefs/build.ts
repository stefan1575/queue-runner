// The build brief (#154): today's `queue_runner/templates/build.md`, ported. Self-contained (docs/app.md,
// Rules): it names no skill, starts no slash command and points at nothing outside the repo, so any
// provider in T3 can run it. The user's name comes from Settings in place of "Stefan". The rules
// other briefs share (Before you push, the screenshots, what is the user's to decide) come from
// `rules.ts`, written there once.
import type { Comment } from '../github.ts';
import { BEFORE_YOU_PUSH, SCREENSHOTS, USERS_TO_DECIDE } from './rules.ts';

export type BuildBriefInput = {
  /** `owner/name`. */
  github: string;
  number: number;
  title: string;
  body: string;
  comments: Comment[];
  branch: string;
  /** `origin/<base>`. */
  base: string;
  /** The repo's agent instructions file at its root, or null when it has none. */
  agentsFile: 'AGENTS.md' | 'CLAUDE.md' | null;
  /** The user's name (Settings, Name; else the gh account's). */
  user: string;
};

const TEMPLATE = `Build GitHub issue #$number in $github: $title

The queue runner started this job; $user isn't watching it live. Everything you need is below or
in the repo. There are no handoff files.

## Where you are

- Repo: \`$github\`, in a T3 worktree on branch \`$branch\`, made from \`$base\`.
- $agents

## The issue: #$number $title

$body

## Comments on the issue

$comments

## How to work

- Write a failing test first where one fits, then only the code that makes it pass. One test at
  a time.
- Run the typecheck and the tests you touch as you go, and the full test suite once at the end.
- Commit after every step, with the decision in the commit message: what you chose and why. A
  usage limit can cut this thread off at any point, and the next job starts from your commits.
- If the change alters what a person sees, take the before screenshots first, before you change
  anything (see Screenshots below).
- When the issue is done, go through Before you push (below), then push \`$branch\` and
  open the PR with the body below, with \`Closes #$number\` in it. Where the repo's own rules ask
  for more, add it. Then end your turn.
- Don't schedule, watch or wait on anything (no scheduled tasks, PR watches, wake-ups or
  monitors). The runner does the waiting.
${USERS_TO_DECIDE}

## The PR body

Keep it short, with no preamble.

\`\`\`markdown
## Summary

<the smallest sketch that makes the change clear: pseudocode, a call tree, a file tree or a diff>

## Evidence

Visible: <yes, what changes on screen | no, why nothing does>

| Before | After |
|---|---|
| <screenshot, or the test failing> | <screenshot, or the test passing> |

## Merge Danger

**Door:** <one-way (hard to undo) or two-way (easy to roll back)>

**Blast radius:** <a word or two: what could break>
\`\`\`

${SCREENSHOTS}

${BEFORE_YOU_PUSH}`;

function agentsPointer(file: BuildBriefInput['agentsFile']): string {
  return file
    ? `Read the repo's \`${file}\` first, and the docs it points to for what you touch.`
    : "The repo has no `AGENTS.md`; follow its README and existing conventions.";
}

function comments(list: Comment[]): string {
  if (!list.length) return 'No comments.';
  return list.map((c) => `**${c.author}**, ${c.createdAt}:\n\n${c.body.trim()}`).join('\n\n');
}

/** Fills the template: each `$name` once, with nothing in a filled value read again. */
export function buildBrief(i: BuildBriefInput): string {
  const values: Record<string, string> = {
    number: String(i.number), github: i.github, title: i.title, branch: i.branch, base: i.base,
    agents: agentsPointer(i.agentsFile), body: i.body.trim() || '(The issue has no body.)',
    comments: comments(i.comments), user: i.user,
  };
  return TEMPLATE.replace(/\$([a-z]+)/g, (whole, name: string) => values[name] ?? whole);
}

/** The template as it is, unfilled: the tests hold it to the brief rules. */
export const BUILD_TEMPLATE = TEMPLATE;

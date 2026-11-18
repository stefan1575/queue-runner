// The build brief (#154): today's `queue_runner/templates/build.md`, ported. Self-contained (docs/app.md,
// Rules): it names no skill, starts no slash command and points at nothing outside the repo, so any
// provider in T3 can run it. The user's name comes from Settings in place of "Stefan". Today's
// brief names the runner's own screenshot script by its path; the app has no such script beside a
// served repo, so the brief says in words what it did (shoot, compare, publish to `evidence`).
import type { Comment } from '../github.ts';

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
- When the issue is done, push \`$branch\` and open the PR with the body below, with
  \`Closes #$number\` in it. Where the repo's own rules ask for more, add it. Don't review your own
  work: the runner has the PR reviewed. Then end your turn.
- Don't schedule, watch or wait on anything (no scheduled tasks, PR watches, wake-ups or
  monitors). The runner does the waiting.
- If something only $user can decide stops you: commit and push what you have, comment the
  question on the issue, swap its \`ready-for-agent\` label for \`needs-info\`, and end your turn.

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

## Screenshots

A screenshot lets a reader see a change instead of taking your word for it, and leaves a record
of how the screen got this way. Take them when the issue changes what a person looks at;
behaviour is proved by its tests. They are enough when someone reading only the PR can see the
change the issue asked for: a before and an after of it (a new screen has no before).

The repo's docs say how to render each of its states. A change that shows only in the app's own
data, not in a sample state it can render, is shot from that data: the repo's docs say how to
build it and shoot it (a sample page shot instead is the same before and after). Open your after
shots once, when the work is done, to check they show what you built; the reviewer looks at them
all, and an image costs tokens on every later turn.

Name the files \`before-<state>-<page>.png\` and \`after-<state>-<page>.png\`, at 1440x900 unless
the repo's docs say otherwise, and keep them out of the commits. Before publishing, compare each
before with its after: if their bytes are the same, the shot missed the change, so reshoot what
the change touches, or write \`Screenshot owed: <why>\` for that state.

Publish them once the PR is open, on the repo's \`evidence\` branch on \`origin\`, in the folder
\`pr-<the PR's number>/\`: that folder is the only one the review reads. Commit them there without
touching your branch or working tree: with a temporary index (\`GIT_INDEX_FILE\`), read the tree of
\`origin/evidence\` if it exists, add each file (\`git hash-object -w\`, \`git update-index --add
--cacheinfo\`), \`git write-tree\`, \`git commit-tree\` with \`origin/evidence\` as its parent, and
push that commit to \`refs/heads/evidence\`; if the push is refused because another job published
first, fetch and build it again on top. Link each file in the Evidence table as
\`![<file name without .png>](https://github.com/$github/blob/<that commit>/pr-<the PR's number>/<file>?raw=true)\`
(\`gh pr edit <number> --body-file ...\`). If the screen can't be captured, write
\`Screenshot owed: <why>\` there instead.`;

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

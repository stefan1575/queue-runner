// The rules more than one brief needs, each written once (#154): the build brief and the fix brief
// (#156) fill in the same ones. A brief file never writes one
// out itself (`test/brief.test.ts`). A rule may name `$user` or `$github`: it goes into a
// template before the template is filled, so they're filled with the rest.
//
// The Before you push list is today's `templates/check.md` (closed PR #196, its builder-checks
// branch): reviews kept blocking on the same few
// causes, so the agent reads its own diff against it once before it pushes.

export const BEFORE_YOU_PUSH = `## Before you push

Don't run a review (no review pass, no second agent): the runner has the PR reviewed. But reviews
keep blocking on the same few causes, so before you push, read your diff against this list once
and fix what you find, with a test for each:

- **The issue:** every case and acceptance criterion it names is done and tested, and whatever
  calls what you changed still gets what it expects (trace the callers).
- **Lists:** every list read from GitHub, a database or an API is read to its last page.
- **Checked earlier, used later:** a setting, switch or state checked before a slow step (a
  fetch, a launch, any I/O) is checked again just before the step it guards, and a choice made
  when the job was let in is the one used, not looked up again.
- **Failures:** a read or write that can fail for a moment is tried again later, never taken as
  "none", "done" or "gone"; a failed read never replaces good data already held.
- **A crash between steps:** a restart after any step (recorded but not yet done, done but not
  yet recorded) leaves something the next start finds and finishes or undoes.
- **Putting back:** whatever the change alters outside its own state (a file, a window, a
  label, a setting) is put back on every way out, failures included.
- **Screenshots:** if the issue changes what a person sees, your after shots show it.`;

/** What stops the agent for the user, and how it hands the question over. */
export const USERS_TO_DECIDE = `- If something only $user can decide stops you: commit and push what you have, comment the
  question on the issue, swap its \`ready-for-agent\` label for \`needs-info\`, and end your turn.`;

/** The user's answer to the PR's stop, first in every brief of a round it leads to (#158 F9): a
 *  fix round's and a conflict round's alike. Empty with no answer to tell. */
export function directionFirst(user: string, answer: string | null | undefined): string {
  if (!answer?.trim()) return '';
  const quoted = answer.trim().split('\n').map((l) => `> ${l}`).join('\n');
  return `\n## Direction first\n\n${user} answered the PR's stop, and this round starts from it:\n\n${quoted}\n`;
}

/** How an agent on a PR hands a question to the user (#158 F2): the runner reads only this block in
 *  its last reply, and files the question as a stop that holds the PR until they answer. */
export const ASK_BLOCK = `End that last reply with the question alone in a fenced block tagged \`queue-runner-question\`:
  the runner reads only that block, puts it to $user as a stop, and holds the PR until they answer.`;

/** The same, for a job on a PR (a fix round): the question goes on the PR. */
export const USERS_TO_DECIDE_ON_PR = `- If something only $user can decide stops you: push what you have, comment the question on the
  PR, and end your turn. ${ASK_BLOCK}`;

/** When to take screenshots, and how to publish them where the review reads them. Today's brief
 *  names the runner's own screenshot script by its path; the app has no such script beside a
 *  served repo, so this says in words what it did (compare, publish to \`evidence\`). */
export const SCREENSHOTS = `## Screenshots

A screenshot lets a reader see a change instead of taking your word for it, and leaves a record
of how the screen got this way, and they're how you check your own work. Take them when the
issue changes what a person looks at; behaviour is proved by its tests. Output that is only text
(what a command prints, a log line, a GitHub comment or label) has no screenshots: its tests
show it. They are enough when someone reading only the PR can see the change the issue asked
for: a before and an after of it (a new screen has no before).

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

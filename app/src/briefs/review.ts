// The review brief (#155): today's `queue_runner/templates/review.md` and the brief the Python
// reviewer builds around it (`review.Reviewer._brief`), ported. Self-contained (docs/app.md,
// Rules): no skill, no slash command, nothing outside the repo but the run folder the app writes
// the review's inputs to. A review runs as a T3 thread in the project's folder, since T3 starts a
// thread in a project folder or a worktree it makes itself; the opening tells it to work in the
// app's checkout of H instead, as today's fallback review's does. It has no outside tools
// (docs/reviews.md): its provider instance is set up without them, and the brief asks for none.
import { OPEN, TAGS, norm, state, type Comment, type Finding, type Review } from '../review/ledger.ts';

export type ReviewBriefInput = {
  /** `owner/name`. */
  github: string;
  number: number; title: string; branch: string; base: string;
  /** H, the commit reviewed. */
  sha: string;
  round: number;
  /** The PR's reviews so far, oldest first. */
  earlier: Review[];
  /** The last reviewed commit isn't in H's history (a force-push). */
  gone: boolean;
  /** The checkout of H and the run folder holding the inputs, as `/`-paths. */
  checkout: string; runDir: string; projectFolder: string;
  /** The brief's list of the inputs in the run folder. */
  files: string[];
  hasAgents: boolean;
  /** The repo's `REVIEW.md` at H, or null. */
  guidelines: string | null;
  /** What the reviewer can run: the dependencies' note (src/review/deps.ts). */
  tests: string;
  /** Replies on the PR since the last review (people's, not the runner's). */
  since: Comment[];
};

const TEMPLATE = `## First: where you are

You review this PR. Where the brief below says "this workdir", it means \`$checkout\`: a throwaway
checkout of the PR's head the queue runner made. Run every command there (\`cd $checkout\` first)
and read the repo there. This thread starts in the repo's own clone (\`$project\`): change nothing
in it, and change nothing outside the workdir but tests you add there. Don't post on GitHub, push,
comment or open anything there: the queue runner posts your reply as the review comment. Your
reply is the review, and its last sol-findings block is its verdict. Ask nothing: nobody is there
to answer. Run tests in the foreground and wait for them: a review has no outside tools, so
nothing waits on a background run for you.

# Review PR #$number: $title

Repo: $github. This workdir is a checkout of the PR's head, exactly $sha ($short). The PR merges
\`$branch\` into \`$base\`. Whoever wrote it, it merges only once your review is clean. GitHub isn't
reachable from here, so everything you need is in this workdir and in \`$rundir\`:
$files

Review independently (the only files you change are tests you add to show a problem):
1. **Correctness:** does the change do what it claims? Does anything else in the repo depend on what
   it changes? Trace the callers.
2. **Spec fit:** does it do what the issue asks, and is anything it asks missing?
3. **Standards:** does it follow this repo's $agents and \`docs/agents/\`?
4. **Tests:** do the tests cover the behaviour it changes? $tests
5. **Screenshots:** a screenshot lets a reader see a change instead of taking the builder's word
   for it, and leaves a record of how the screen got this way. Behaviour is proved by its tests;
   screenshots are for a ticket that changes what a person looks at. You are their reader: look
   at each shot the PR gives. They are enough when, reading only the PR, you can see the change
   the ticket asked for, and the shots show what the PR says. When you can't, that is
   **important** (\`rule\`: "a visible change needs screenshots"): name the screen you need to see.
$again$guide
Tag every finding:
- **important** blocks the merge. It needs \`file\` and \`line\`, plus either a \`scenario\` (a failure
  concrete enough to become a failing test: this input or state, this wrong result) or a \`cost\` and
  a \`rule\` (the named later cost, and the spec line or documented standard it breaks). A finding
  without that evidence is a nit at most.
- **nit** never blocks. Give at most five.
- **pre-existing** is a problem in code this PR didn't change; it is filed as a follow-up issue.
  One that loses or exposes data is important instead.
\`class\` names the cause: what in the code lets the failure happen, not what goes wrong (for
example "log records matched by comparing timestamps written at different precisions", not
"recovery event loses timestamp precision"), so the fix removes the cause and covers every case
of it, not only the one you cite. Cite file and line as repo-relative paths
(\`src/lib/parse.ts:74\`): your reply is posted as a comment on the PR.

Write your review first: what you found, with evidence, then what you covered and what you
couldn't check. Then, last of all, end your reply with exactly one fenced block tagged
\`sol-findings\`, holding every $fresh finding as JSON (an empty list if there are none)$statuses.
IDs are short: F1, F2, ...

\`\`\`sol-findings
{"findings": [{"id": "$nextid", "tag": "important", "class": "...", "file": "src/lib/parse.ts", "line": 74, "scenario": "...", "cost": "", "rule": ""}]$example}
\`\`\`

The verdict is read from this block, not from your prose: clean when no important finding with
its evidence is open$scope. A reply without a readable block counts as a failed review.
`;

/** The template as it is, unfilled: the tests hold it to the brief rules. */
export const REVIEW_TEMPLATE = TEMPLATE;

export const said = (c: Comment) =>
  `---\n**${c.author}**, ${c.createdAt}${c.path ? ` on \`${c.path}:${c.line}\`` : ''}:\n\n${(c.body ?? '').trim()}\n`;

function openLine(f: Finding): string {
  const at = f.file && f.line ? `\`${f.file}:${f.line}\`` : f.file ? `\`${f.file}\`` : 'no file';
  const why = f.scenario ? `Scenario: ${f.scenario}` : f.cost ? `Cost: ${f.cost}${f.rule ? ` (rule: ${f.rule})` : ''}` : '';
  const s = f.status === 'open' ? 'open' : 'decline kept open';
  return `- **${f.id}** · ${TAGS[f.tag]} · ${f.class || 'no class'} · ${at} · ${s}, raised in review ${f.raised}${why ? `\n  ${why}` : ''}`;
}

export function reviewBrief(i: ReviewBriefInput): string {
  const prior = state(i.earlier);
  const last = i.earlier.at(-1)?.sha ?? null;
  let again = '';
  let guide = '';
  if (i.round > 1) {
    const scope = i.gone
      ? `The commit you last reviewed${last ? `, ${last.slice(0, 7)},` : ''} isn't in this branch's history any more (a force-push), so \`change.diff\` is the PR's whole diff: review all of it. Your comment will say so.`
      : `You last reviewed ${last?.slice(0, 7)}. \`change.diff\` is the change since then: review only that. \`full.diff\` is the PR's whole diff: read it, and the rest of the checkout, only to understand the change. (If the base was merged in since, \`change.diff\` has its changes too; review only the PR's own.)`;
    const used = prior.map((f) => f.id).join(', ') || 'none';
    const classes = [...new Set(prior.filter((f) => norm(f.class)).map((f) => f.class))];
    const named = classes.length
      ? `${classes.map((c) => `"${c}"`).join('; ')}. When a new finding is the same kind of problem as one of these, give it that class name, word for word, so a kind that keeps coming back can be seen`
      : 'none';
    again = `6. **This is review ${i.round}.** ${scope}\n`
      + "7. **Your earlier findings.** Each one still open is listed below, with the replies posted on the PR since your last review. Give every one a status in the block's `earlier` list: `fixed`, `open` (still open), `decline-accepted` or `decline-kept`. A decline is a reply that names the finding's ID, gives the reason, and attaches the evidence (the test that wouldn't fail). You get one reply on each: accept it, or keep it open and say in your review what it misses. Repeat nothing already posted: an open finding's status covers it, so don't list it again in `findings`. If a finding that was closed comes back, list it in `findings` with its old ID. "
      + `Give a new finding an ID not used before (used so far: ${used}).\n`
      + `8. **Classes raised so far:** ${named}.\n`;
  }
  if (i.guidelines !== null) {
    guide = `\n## This repo's review guidelines (\`REVIEW.md\`)\n\nThey decide what counts as Important here, what never to report and what to always check.\n\n${i.guidelines.trim()}\n`;
  }
  if (i.round > 1) {
    const open = prior.filter((f) => OPEN.includes(f.status));
    guide += `\n## Your open findings\n\n${open.map(openLine).join('\n') || 'None.'}\n`
      + `\n## Replies on the PR since your last review\n\n${i.since.map(said).join('') || 'None.\n'}`;
  }
  if (guide) guide += '\n## Your reply\n';
  const values: Record<string, string> = {
    checkout: i.checkout, project: i.projectFolder, number: String(i.number), title: i.title, github: i.github,
    sha: i.sha, short: i.sha.slice(0, 7), branch: i.branch, base: i.base, rundir: i.runDir,
    files: i.files.map((f) => `- ${f}`).join('\n'),
    agents: i.hasAgents ? '`AGENTS.md`' : 'conventions (it has no `AGENTS.md`)',
    tests: i.tests, again, guide, fresh: i.round > 1 ? 'new' : '',
    statuses: i.round > 1 ? ', and a status for each earlier open finding in `earlier`' : '',
    nextid: `F${prior.length + 1}`,
    example: i.round > 1 ? ', "earlier": [{"id": "F1", "status": "fixed"}]' : '',
    scope: i.round > 1 ? ', new or earlier' : '',
  };
  return TEMPLATE.replace(/\$([a-z]+)/g, (whole, name: string) => values[name] ?? whole).replace('every  finding', 'every finding');
}

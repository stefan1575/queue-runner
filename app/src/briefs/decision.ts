// The decision brief (#158): today's `queue_runner/templates/decision.md`, ported. A decision thread
// is a fresh thread with one narrow question and the state it needs; it changes nothing, and
// answers in a fixed format the app reads (`readDecision`) and acts on once, or turns into a stop.
// Each source is clipped, so a decision costs about one fresh-thread call. Self-contained
// (docs/app.md, Rules).

/** The answer's format version. */
export const DECISION_VERSION = 1;
/** Each source's length in the brief. */
export const SOURCE_CHARS = 3000;

/** A question the app asks a decision thread: what it's about and which actions it allows, each
 *  with the fields it must fill (non-empty strings) and what they're for. */
export type Question = {
  kind: string;
  /** What's asked, for the thread. */
  text: string;
  actions: Record<string, Record<string, string>>;
  example: Record<string, string>;
};

/** At the cap (src/cap.ts): the PR isn't getting clean, and the user gets an Approach note. */
export const APPROACH_NOTE: Question = {
  kind: 'approach-note',
  text: `This PR reached the cap: round after round, reviews keep blocking it, so the loop stops spending
on it and $user rethinks it. Write $user an Approach note: is the approach wrong or overbuilt, what
would change, and do you recommend reworking it, fixing on, or holding it? Ground it in the review
history and signals below (a class of problem that keeps coming back, a finding that reopened, a
decline the reviewer kept), not in the latest review alone.`,
  actions: {
    'approach-note': {
      note: 'the note, in Markdown, for the PR: what keeps going wrong, whether the approach is wrong or overbuilt, what would change',
      recommend: 'one of `rework`, `fix on` or `hold`',
    },
    stop: { question: 'what $user has to decide instead, with your recommendation' },
  },
  example: { action: 'approach-note', note: 'Each round fixes one caller of the cache and the review finds the next...', recommend: 'rework' },
};

const TEMPLATE = `Queue runner decision: $subject

The queue runner, an app with no AI in it, runs $user's fixed build-and-review flow. It reached a
case the flow doesn't settle and asks you one question. Answer it from the sources below. You may
read the repo and run read-only \`gh\` and \`git\` commands, but change nothing: don't edit files,
commit, push, comment, label, close or start anything, and don't schedule, watch or wait on
anything. The runner acts on your answer, once.

## The question

$question

## Sources

$sources

## Your answer

End your reply with exactly one fenced block tagged \`queue-runner-decision\` holding one JSON object
with \`"version": $version\` and an \`action\`. The runner reads only that block; what you write above
it is for the record. The actions this question allows:

$actions

For example:

\`\`\`queue-runner-decision
$example
\`\`\`

Choose \`stop\` when the choice changes what the app does or how its parts connect (that's $user's),
or when the sources don't settle it; put in \`question\` what $user has to decide, with your
recommendation. An answer the runner can't read, or an action not listed here, is a stop.`;

const clip = (s: string) => (s.length > SOURCE_CHARS ? `${s.slice(0, SOURCE_CHARS)}\n(clipped at ${SOURCE_CHARS} characters)` : s);

export type DecisionBriefInput = { subject: string; user: string; question: Question; sources: { title: string; text: string }[] };

export function decisionBrief(i: DecisionBriefInput): string {
  const user = (s: string) => s.replace(/\$user/g, i.user);
  const values: Record<string, string> = {
    subject: i.subject,
    question: user(i.question.text),
    sources: i.sources.map((s) => `### ${s.title}\n\n${clip(s.text.trim() || '(none)')}`).join('\n\n'),
    version: String(DECISION_VERSION),
    actions: Object.entries(i.question.actions).map(([a, fields]) =>
      `- \`${a}\`: ${Object.entries(fields).map(([f, what]) => `\`${f}\` (${user(what)})`).join(', ')}`).join('\n'),
    example: JSON.stringify({ version: DECISION_VERSION, ...i.question.example }),
    user: i.user,
  };
  return TEMPLATE.replace(/\$([a-z]+)/g, (whole, name: string) => values[name] ?? whole);
}

/** The block's action and its fields, or why it can't be acted on (which is a stop). */
export type Decided = { action: string; fields: Record<string, string> } | { error: string };

const FENCE = /^[ \t]*```+[ \t]*queue-runner-decision[ \t]*\r?\n([\s\S]*?)^[ \t]*```+[ \t]*$/gm;

/** The reply's last `queue-runner-decision` block, checked against what the question allows. */
export function readDecision(reply: string, q: Question): Decided {
  const blocks = [...reply.matchAll(FENCE)].map((m) => m[1]!);
  if (!blocks.length) return { error: 'its reply has no queue-runner-decision block' };
  let data: any;
  try {
    data = JSON.parse(blocks.at(-1)!);
  } catch (e) {
    return { error: `its queue-runner-decision block isn't valid JSON (${(e as Error).message})` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { error: 'its queue-runner-decision block is not one JSON object' };
  if (data.version !== DECISION_VERSION) return { error: `its answer is version ${JSON.stringify(data.version)}, not ${DECISION_VERSION}` };
  const fields = q.actions[data.action];
  if (!fields) return { error: `its action ${JSON.stringify(data.action)} isn't one this question allows (${Object.keys(q.actions).join(', ')})` };
  const out: Record<string, string> = {};
  for (const f of Object.keys(fields)) {
    if (typeof data[f] !== 'string' || !data[f].trim()) return { error: `its ${data.action} has no ${f}` };
    out[f] = data[f].trim();
  }
  return { action: data.action, fields: out };
}

/** The template as it is, unfilled: the tests hold it to the brief rules. */
export const DECISION_TEMPLATE = TEMPLATE;

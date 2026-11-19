// The one launch for every kind of job (#152): a full-access T3 thread through T3's MCP
// (`t3_thread_launch`, docs/t3.md) on a provider instance, model and effort. The effort goes under
// the option id T3 gave for that model, which is its driver's own (docs/app.md, Job models).
// **The launch runs on the choice it's given**, the one the usage gate let in (its own model or
// its fallback, `src/usage-gate.ts`), never on the settings read again: a setting changed between
// the gate's answer and the launch would put the job on a model nobody let in.
//
// **A review has no outside tools** (docs/reviews.md): the app can't see an instance's tools
// without naming its driver, so the user names the instances set up without them
// (`toolFreeInstances`, src/settings.ts), and a review launches only on one of those, never on
// the instance builds run on. That is checked here, at the one launch every review goes through
// (the lane and the live check alike), and it fails closed: no list, or an instance not on it,
// launches nothing.
import { model, usable, type Catalog, type JobKind, type ModelChoice } from './jobs.ts';
import type { T3Mcp } from './t3/mcp.ts';

/** Nothing to launch on: the choice's provider or model isn't one T3 runs now. */
export class JobError extends Error {}

export type Job = {
  kind: JobKind;
  projectId: string;
  title: string;
  /** The message the thread starts with. */
  brief: string;
  /** A new worktree T3 makes from `baseRef` on a new branch; without one (or `worktreePath`), the
   *  project's folder. */
  worktree?: { baseRef: string; branch: string };
  /** A worktree of the project's repo that exists already, the thread's working folder (T3's
   *  `existing_worktree`): a review's detached checkout of H. */
  worktreePath?: string;
  /** What it runs on: the choice the gate let in. */
  choice: ModelChoice;
  /** A review's: the instances set up without outside tools, and the one builds run on. A review
   *  on one not listed, or on the build's, launches nothing. */
  toolFree?: readonly string[];
  buildInstance?: string | null;
};

export type Launched = { threadId: string; runId: string | null; link: string | null; choice: ModelChoice };

/** T3's model selection for a choice: `{instanceId, model, options}`, the effort under its option. */
export function modelSelection(choice: ModelChoice, catalog: Catalog) {
  const option = model(catalog, choice)?.effortOption;
  return {
    instanceId: choice.provider, model: choice.model,
    options: option && choice.effort !== null ? [{ id: option, value: choice.effort }] : [],
  };
}

/** Why a review won't run on `instance` (named `label` to the user), or null when it may: the
 *  instance must be one the user named as set up without outside tools (`toolFree`, their saved
 *  `toolFreeInstances`, never inferred from the review's own choice), and never the one builds
 *  run on (`buildInstance`), which has their tools whatever the list says. The lane, launchJob
 *  and the live check all ask this. */
export function noToolsRefusal(instance: string, toolFree: readonly string[], buildInstance: string | null, label = instance): string | null {
  if (!toolFree.includes(instance)) return `the review would run on ${label}, which isn't one of the instances set up without outside tools (toolFreeInstances in the settings; docs/reviews.md)`;
  if (instance === buildInstance) return `the review would run on ${label}, the instance builds run on, which has their tools: a review needs an instance set up without outside tools (docs/reviews.md)`;
  return null;
}

export async function launchJob(mcp: Pick<T3Mcp, 'call'>, catalog: Catalog, job: Job): Promise<Launched> {
  if (job.kind === 'review') {
    const why = noToolsRefusal(job.choice.provider, job.toolFree ?? [], job.buildInstance ?? null);
    if (why) throw new JobError(why);
  }
  const choice = usable(job.choice, catalog);
  // never another model in its place: a choice T3 can't run now launches nothing
  if (!choice || choice.effort !== job.choice.effort) {
    throw new JobError(`T3 can't run ${job.choice.provider} ${job.choice.model}${job.choice.effort ? ` at ${job.choice.effort}` : ''} now`);
  }
  const launched = await mcp.call('t3_thread_launch', {
    projectId: job.projectId, title: job.title, message: job.brief, runtimeMode: 'full-access',
    modelSelection: modelSelection(choice, catalog),
    ...(job.worktree ? { workspaceStrategy: { type: 'worktree', ...job.worktree } }
      : job.worktreePath ? { workspaceStrategy: { type: 'existing_worktree', worktreePath: job.worktreePath } } : {}),
  });
  return { threadId: launched?.threadId, runId: launched?.runId ?? null, link: launched?.link ?? null, choice };
}

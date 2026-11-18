// The one launch for every kind of job (#152): a full-access T3 thread through T3's MCP
// (`t3_thread_launch`, docs/t3.md) on the kind's provider instance, model and effort, as
// Settings gives them (`src/jobs.ts`). The effort goes under the option id T3 gave for that
// model, which is its driver's own (docs/app.md, Job models). Which of a kind's two models a job
// runs on (its own or, while that provider is out of usage, its fallback) is the caller's to say.
import { kindModels, model, type Catalog, type JobKind, type Jobs, type ModelChoice } from './jobs.ts';
import type { T3Mcp } from './t3/mcp.ts';

/** Nothing to launch on: no provider connected, or a fallback asked of a kind that has none. */
export class JobError extends Error {}

export type Job = {
  kind: JobKind;
  projectId: string;
  title: string;
  /** The message the thread starts with. */
  brief: string;
  /** A new worktree T3 makes from `baseRef` on a new branch; without one, the project's folder. */
  worktree?: { baseRef: string; branch: string };
  /** Run on the kind's fallback (its own provider is out of usage). */
  onFallback?: boolean;
  /** Run on this model, as the usage gate let the job in on it: Settings isn't read again, so a
   *  change made since can't move the job onto a model the gate never checked. */
  choice?: ModelChoice;
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

export async function launchJob(mcp: Pick<T3Mcp, 'call'>, jobs: Jobs, catalog: Catalog, job: Job): Promise<Launched> {
  const models = job.choice ? null : kindModels(jobs, job.kind, catalog);
  const choice = job.choice ?? (job.onFallback ? models!.fallback : models!.choice);
  if (!choice) {
    throw new JobError(job.onFallback ? `${job.kind} has no fallback T3 can run` : 'T3 has no provider connected');
  }
  const launched = await mcp.call('t3_thread_launch', {
    projectId: job.projectId, title: job.title, message: job.brief, runtimeMode: 'full-access',
    modelSelection: modelSelection(choice, catalog),
    ...(job.worktree ? { workspaceStrategy: { type: 'worktree', ...job.worktree } } : {}),
  });
  return { threadId: launched?.threadId, runId: launched?.runId ?? null, link: launched?.link ?? null, choice };
}

// A job's T3 thread when the job log never got its id (today's `t3.find_job_thread`, ported): an
// app that stopped after T3 accepted the launch but before `log.thread()` was written leaves a
// job open with no thread, though the thread may run on. T3's shell (`orchestration.subscribeShell`,
// docs/app.md, The WebSocket API) lists every thread with its `projectId`, `title`, `createdAt` and
// `latestRunId` (seen live 2026-11-19, T3 0.1.9): the job's is the newest in its project with its
// title, made no earlier than 5 seconds before the job's start record.
import type { JobThread } from '../job-log.ts';
import type { Retry } from './project-feed.ts';
import type { T3Ws } from './ws.ts';

/** The slack before the start record: the record is written just before the launch, on another clock. */
const SLACK_MS = 5_000;

export async function findJobThread(ws: Pick<T3Ws, 'first'>, job: { repo: string; title: string; startedAt: string }): Promise<JobThread | null> {
  const shell = await ws.first('orchestration.subscribeShell', {});
  const since = Date.parse(job.startedAt) - SLACK_MS;
  const all: any[] = [...(shell?.snapshot?.threads ?? []), ...(shell?.snapshot?.archivedThreads ?? [])];
  const found = all.filter((t) => t?.projectId === job.repo && t?.title === job.title && typeof t?.id === 'string'
    && Date.parse(t?.createdAt) >= since);
  if (!found.length) return null;
  const newest = found.reduce((a, b) => (Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a));
  return { threadId: newest.id, runId: typeof newest.latestRunId === 'string' ? newest.latestRunId : null, link: null };
}

/** The open job's thread: the one the log names, else the one T3's shell shows for it, else null
 *  (T3 never made one). A shell that can't be read is asked again after `retry`'s wait, never
 *  taken as "no thread": a thread that runs on would be left to run beside a second job. Undefined
 *  once `stopped()`, the job left open as it is. Found, it's written to the log. */
export async function openJobThread(
  ws: Pick<T3Ws, 'first'>, log: { thread(id: string, t: JobThread): Promise<unknown> },
  job: { id: string; repo: string; title: string; startedAt: string } & Partial<JobThread>,
  retry: Retry, stopped: () => boolean, say: (line: string) => void,
): Promise<JobThread | null | undefined> {
  if (job.threadId) return { threadId: job.threadId, runId: job.runId ?? null, link: job.link ?? null };
  for (;;) {
    if (stopped()) return undefined;
    try {
      const found = await findJobThread(ws, job);
      if (found) {
        await log.thread(job.id, found);
        say(`${job.title}: the app stopped before it logged its thread; T3 has it as ${found.threadId}`);
      }
      return found;
    } catch (e) {
      say(`${job.title}: T3's threads couldn't be read to find its thread (${(e as Error).message}); asking again`);
      await new Promise<void>((done) => { retry(done); });
    }
  }
}

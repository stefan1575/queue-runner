// A job's T3 thread when the job log never got its id (today's `t3.find_job_thread`, ported): an
// app that stopped after T3 accepted the launch but before `log.thread()` was written leaves a
// job open with no thread, though the thread may run on. **The thread is known by the job's
// mark**, never by its title: launchJob heads the job's message with `jobMark(job.id)`
// (src/launch.ts), and a title is shared by every job on the same PR or ticket, so a later thread
// with the same title is never taken for this one. T3's shell (`orchestration.subscribeShell`,
// docs/app.md, The WebSocket API) lists every thread with its `projectId`, `title`, `createdAt`
// and `latestRunId` (seen live 2026-11-19, T3 0.1.9); those narrow the threads to read, made no
// earlier than 5 seconds before the job's start record, and each one's first message
// (`t3_thread_read`, its first item a `user_message`, seen live 2026-11-19) says whose it is.
import { jobMark } from '../launch.ts';
import type { JobThread } from '../job-log.ts';
import type { T3Mcp } from './mcp.ts';
import type { Retry } from './project-feed.ts';
import type { T3Ws } from './ws.ts';

/** The slack before the start record: the record is written just before the launch, on another clock. */
const SLACK_MS = 5_000;

/** The thread's first message, its start (the mark heads it, so the start is enough). */
async function firstMessage(mcp: Pick<T3Mcp, 'call'>, threadId: string): Promise<string> {
  const page = (await mcp.call('t3_thread_read', { threadId, view: 'messages', limit: 1, runLimit: 1, maxCharsPerItem: 2000 })) ?? {};
  const first = (Array.isArray(page.items) ? page.items : [])[0];
  return first?.type === 'user_message' ? String(first.text ?? '') : '';
}

export async function findJobThread(ws: Pick<T3Ws, 'first'>, mcp: Pick<T3Mcp, 'call'>, job: { id: string; repo: string; title: string; startedAt: string }): Promise<JobThread | null> {
  const shell = await ws.first('orchestration.subscribeShell', {});
  const since = Date.parse(job.startedAt) - SLACK_MS;
  const all: any[] = [...(shell?.snapshot?.threads ?? []), ...(shell?.snapshot?.archivedThreads ?? [])];
  const mark = jobMark(job.id);
  const maybe = all.filter((t) => t?.projectId === job.repo && t?.title === job.title && typeof t?.id === 'string'
    && Date.parse(t?.createdAt) >= since).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const t of maybe) {
    if (!(await firstMessage(mcp, t.id)).startsWith(mark)) continue; // another job's, whatever its title
    return { threadId: t.id, runId: typeof t.latestRunId === 'string' ? t.latestRunId : null, link: null };
  }
  return null;
}

/** The open job's thread: the one the log names, else the one T3 has with the job's mark, else
 *  null (T3 never made one). Threads that can't be read are asked again after `retry`'s wait,
 *  never taken as "no thread": a thread that runs on would be left to run beside a second job.
 *  Undefined once `stopped()`, the job left open as it is. Found, it's written to the log. */
export async function openJobThread(
  ws: Pick<T3Ws, 'first'>, mcp: Pick<T3Mcp, 'call'>, log: { thread(id: string, t: JobThread): Promise<unknown> },
  job: { id: string; repo: string; title: string; startedAt: string } & Partial<JobThread>,
  retry: Retry, stopped: () => boolean, say: (line: string) => void,
): Promise<JobThread | null | undefined> {
  if (job.threadId) return { threadId: job.threadId, runId: job.runId ?? null, link: job.link ?? null };
  for (;;) {
    if (stopped()) return undefined;
    try {
      const found = await findJobThread(ws, mcp, job);
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

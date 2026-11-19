// Settling a job's thread once its end is recorded (#68 story 5), for every lane (#154 built it for
// builds; #155's reviews share it). The app settles only threads it launched: the thread id is the
// one its own launch saved, never one found by title, branch or project. The settle is recorded
// with a `settled` line in the job log, so a job whose end was recorded and whose thread wasn't
// settled yet (an app that stopped between the two, or a settle that failed) is settled on the
// next pass (`JobLog.toSettle`), and never twice.
import type { Job, JobLog } from './job-log.ts';
import type { T3Mcp } from './t3/mcp.ts';

export class ThreadSettler {
  private mcp: Pick<T3Mcp, 'call'>;
  private log: JobLog;
  private say: (line: string) => void;
  /** Settles under way, by job id. */
  private under = new Map<string, Promise<void>>();

  constructor(mcp: Pick<T3Mcp, 'call'>, log: JobLog, say: (line: string) => void) {
    this.mcp = mcp;
    this.log = log;
    this.say = say;
  }

  /** Settles a thread this app launched, and records it; once at a time per job, and not again
   *  once recorded. A failure is said, never raised: a thread left in the sidebar stops no lane,
   *  and the next pass tries it again. */
  settle(job: Job): Promise<void> {
    const under = this.under.get(job.id);
    if (under) return under;
    if (!job.threadId || this.log.get(job.id)?.settledAt) return Promise.resolve();
    const s = this.once(job).finally(() => this.under.delete(job.id));
    this.under.set(job.id, s);
    return s;
  }

  /** Each ended job of `kind` whose thread isn't settled yet, settled on its own. */
  owed(kind: Job['kind']): void {
    for (const job of this.log.toSettle()) if (job.kind === kind) void this.settle(job);
  }

  /** The settles under way (the tests wait on them). */
  pending(): Promise<void>[] {
    return [...this.under.values()];
  }

  private async once(job: Job) {
    try {
      await this.mcp.call('t3_thread_organize', { threadId: job.threadId, action: 'settle' });
    } catch (e) {
      this.say(`${job.title}: settling its thread ${job.threadId} failed (${(e as Error).message}); left as it is, tried again next pass`);
      return;
    }
    try {
      await this.log.settled(job.id);
    } catch (e) {
      this.say(`${job.title}: its settle couldn't be recorded (${(e as Error).message}); it's settled again next pass`);
    }
  }
}

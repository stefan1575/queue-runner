// One writer per PR (#158 F6): the one reservation every lane that writes to a PR's branch takes
// before it starts preparing a job (a fix round, a check's fix round, a conflict round, a build
// carried on), so two lanes, each passing every minute, never both prepare a writer for one branch.
// The job log's `writes` says who writes once a job is started; this covers the time before that,
// from the lane's decision through its fetch, its brief and the gate. `otherWriter` asks the log
// again just before the launch or send. The reservation lives in the process: after a restart the
// log's open jobs are the writers.
import { writes, type Job, type JobLog } from './job-log.ts';

export class Writers {
  private held = new Map<string, string>();

  private key(repo: string, branch: string) {
    return `${repo}\n${branch}`;
  }

  /** Reserves the branch for `who`: null when it's theirs now, else who holds it. */
  claim(repo: string, branch: string, who: string): string | null {
    const k = this.key(repo, branch);
    const holder = this.held.get(k);
    if (holder !== undefined && holder !== who) return holder;
    this.held.set(k, who);
    return null;
  }

  /** Gives the branch back, if `who` holds it. */
  release(repo: string, branch: string, who: string): void {
    const k = this.key(repo, branch);
    if (this.held.get(k) === who) this.held.delete(k);
  }

  holder(repo: string, branch: string): string | undefined {
    return this.held.get(this.key(repo, branch));
  }
}

/** Another job of the app's writing to the branch, besides `job`: asked just before a launch or a
 *  send, after the slow steps. */
export const otherWriter = (log: JobLog, job: Pick<Job, 'id' | 'repo' | 'branch'>): Job | undefined =>
  log.jobs().find((j) => j.id !== job.id && j.repo === job.repo && j.kind !== 'review' && j.kind !== 'decision' && j.branch === job.branch && writes(j));

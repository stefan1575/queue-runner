// The checks lane (#158; today's #93 re-run and #98/#199 base holds in `queue_runner/stops.py`,
// ported): a failed check never reaches the user. No model runs here, so the gate never counts it;
// each step is a `step` line in the job log.
//
//   a check failed on the PR's head H
//   ->  the base's own tip fails every one of those checks too: the failure is the base's. H is
//       held (`base-hold`, the tip it was seen on), and once the base's tip moves the PR is brought
//       up to date with it (GitHub's update-branch, naming H: `update`), so its checks run again on
//       a new head. GitHub refusing (a conflict) is the conflict lane's.
//   ->  else it's the PR's: each GitHub Actions run with a failed check is re-run once per head
//       (`rerun`, its start written before GitHub is asked). A check a re-run can't reach (a commit
//       status, another app's), a run already past its first attempt, a re-run GitHub refused, or a
//       re-run whose attempt ended failed again: `check-failed`, which the fix lane gives a fix round
//       with the failing log (src/fix-lane.ts). A pass on the re-run is the checks passing.
//
// A PR with a stop open, or a job writing to its branch, is left alone. A read that fails is said
// and tried again next pass, never taken as "passed" or "failed".
import type { BuildRepo } from './build-lane.ts';
import type { GitHubChecks, GitHubMerge, GitHubReview, ReviewPull } from './github.ts';
import { writes, type JobLog, type Step } from './job-log.ts';

export type ChecksLaneDoors = {
  repos: () => BuildRepo[];
  github: Pick<GitHubReview, 'pullsToReview' | 'checks'> & Pick<GitHubMerge, 'branchHead'>
    & Pick<GitHubChecks, 'failedRuns' | 'run' | 'rerunFailed' | 'updateBranch'>;
  log: JobLog;
  say: (line: string) => void;
  /** Checks that failed again got recorded (the fix lane passes). */
  failedAgain?: () => void;
  /** A PR was brought up to date with its base (the review and conflict lanes pass). */
  updated?: () => void;
};

const PASSED = new Set(['success', 'neutral', 'skipped']);

export class ChecksLane {
  private d: ChecksLaneDoors;
  private why = new Map<string, string | null>();
  private passing: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(doors: ChecksLaneDoors) {
    this.d = doors;
  }

  stop() {
    this.stopped = true;
  }

  async idle(): Promise<void> {
    while (this.passing) await this.passing;
  }

  pass(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.passing) {
      this.again = true;
      return this.passing;
    }
    this.passing = (async () => {
      do {
        this.again = false;
        await this.passOnce();
      } while (this.again && !this.stopped);
    })().finally(() => { this.passing = null; });
    return this.passing;
  }

  private note(key: string, name: string, why: string | null) {
    if (why && this.why.get(key) !== why) this.d.say(`${name}: ${why}`);
    this.why.set(key, why);
  }

  private async passOnce() {
    for (const repo of this.d.repos()) {
      if (this.stopped) return;
      if (!repo.github) continue;
      let pulls: ReviewPull[];
      try {
        pulls = (await this.d.github.pullsToReview(repo.github)).sort((a, b) => a.number - b.number);
      } catch (e) {
        this.d.say(`${repo.title}: GitHub couldn't be read for checks (${(e as Error).message})`);
        continue;
      }
      for (const pr of pulls) {
        if (this.stopped) return;
        const key = `${repo.github}#${pr.number}`;
        const name = `checks ${repo.title}#${pr.number}`;
        try {
          this.note(key, name, await this.onePr(repo, pr));
        } catch (e) {
          this.note(key, name, `GitHub couldn't be read (${(e as Error).message}); tried again next pass`);
        }
      }
    }
  }

  private steps(repo: BuildRepo, pr: ReviewPull, kind: Step['kind']): Step[] {
    return this.d.log.steps().filter((s) => s.kind === kind && s.repo === repo.id && s.pr === pr.number && s.sha === pr.headSha);
  }

  private step(repo: BuildRepo, pr: ReviewPull, kind: Step['kind'], part: Partial<Step> = {}) {
    return this.d.log.stepStarted({ kind, repo: repo.id, github: repo.github!, pr: pr.number, branch: pr.branch, sha: pr.headSha, ...part });
  }

  /** What happened to the PR's failed checks this pass, said once, or null for nothing to say. */
  private async onePr(repo: BuildRepo, pr: ReviewPull): Promise<string | null> {
    const github = repo.github!;
    const h7 = pr.headSha.slice(0, 7);
    if (this.d.log.openStops(repo.id, pr.number).length) return null;
    if (this.d.log.jobs().some((j) => j.repo === repo.id && j.kind !== 'review' && j.branch === pr.branch && writes(j))) return null;
    // held on the base's failure: once the base's tip moves, the PR is brought up to date with it
    const hold = this.steps(repo, pr, 'base-hold').at(-1);
    const tip = hold || (await this.d.github.checks(github, pr.headSha)).state === 'failed' ? await this.d.github.branchHead(github, pr.base) : null;
    if (hold && tip !== hold.baseSha) {
      if (this.steps(repo, pr, 'update').some((s) => s.baseSha === tip)) return null;
      const answer = await this.d.github.updateBranch(github, pr.number, pr.headSha);
      const st = await this.step(repo, pr, 'update', { baseSha: tip! });
      await this.d.log.stepEnded(st.id, { outcome: answer === 'updated' ? 'updated' : 'refused' });
      if (answer === 'updated') this.d.updated?.();
      return answer === 'updated' ? `${pr.base} moved to ${tip!.slice(0, 7)}: ${h7} brought up to date with it, its checks run again`
        : `${pr.base} moved to ${tip!.slice(0, 7)}, and GitHub refused to bring ${h7} up to date with it (a conflict: the conflict round's)`;
    }
    const checks = await this.d.github.checks(github, pr.headSha);
    if (checks.state !== 'failed') return null;
    if (this.steps(repo, pr, 'check-failed').length) return null; // its fix round's (src/fix-lane.ts)
    // the base fails the same checks: the base's, not the PR's
    const base = await this.d.github.checks(github, tip!);
    if (checks.failed.every((n) => base.failed.includes(n))) {
      if (!hold || hold.baseSha !== tip) await this.step(repo, pr, 'base-hold', { baseSha: tip!, failed: checks.failed });
      return `${checks.failed.join(', ')} fail${checks.failed.length === 1 ? 's' : ''} on ${pr.base} at ${tip!.slice(0, 7)} too: ${h7} waits, and is brought up to date once ${pr.base} moves`;
    }
    // the PR's own: each Actions run re-run once on H, then a fix round for what fails again
    const runs = await this.d.github.failedRuns(github, pr.headSha);
    const again: { name: string; run: number }[] = [];
    let waiting = false;
    for (const name of checks.failed) {
      const id = runs[name];
      if (!id) { again.push({ name, run: 0 }); continue; } // no run to re-run: a status, another app's
      const rerun = this.d.log.steps().filter((s) => s.kind === 'rerun' && s.repo === repo.id && s.pr === pr.number && s.sha === pr.headSha && s.run === id).at(-1);
      const run = await this.d.github.run(github, id);
      if (!rerun) {
        // a run re-run by hand already: its failure stands
        if (run.attempt > 1) { again.push({ name, run: id }); continue; }
        await this.rerun(repo, pr, id, run.attempt);
        waiting = true;
        continue;
      }
      if (!rerun.end) {
        // the app stopped between writing the re-run and GitHub's answer: GitHub says whether it took
        if (run.attempt > rerun.attempt!) await this.d.log.stepEnded(rerun.id, { outcome: 'rerun' });
        else await this.rerun(repo, pr, id, run.attempt, rerun);
        waiting = true;
        continue;
      }
      if (rerun.end.outcome === 'failed') { again.push({ name, run: id }); continue; }
      if (run.attempt <= rerun.attempt! || run.status !== 'completed') { waiting = true; continue; }
      if (!PASSED.has(String(run.conclusion))) again.push({ name, run: id });
    }
    if (waiting) return `${checks.failed.join(', ')} failed on ${h7}: re-run once, waiting for it`;
    if (!again.length) return null;
    await this.step(repo, pr, 'check-failed', { failed: again.map((a) => a.name), runs: again.map((a) => a.run) });
    this.d.failedAgain?.();
    return `${again.map((a) => a.name).join(', ')} failed again on ${h7} after the re-run: a fix round with the failing log`;
  }

  /** Re-runs a run's failed jobs, its step written first; GitHub refusing ends it failed, so it never loops. */
  private async rerun(repo: BuildRepo, pr: ReviewPull, id: number, attempt: number, started?: Step) {
    const st = started ?? await this.step(repo, pr, 'rerun', { run: id, attempt });
    try {
      await this.d.github.rerunFailed(repo.github!, id);
    } catch (e) {
      await this.d.log.stepEnded(st.id, { outcome: 'failed', error: (e as Error).message });
      return;
    }
    await this.d.log.stepEnded(st.id, { outcome: 'rerun' });
  }
}

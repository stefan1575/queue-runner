"""Stops for Stefan (ticket 06; `docs/flow.md`, Stops), in the Sol lane.

When the loop has to come to Stefan, the runner files the stop: one `needs-info` issue per PR
(opened, or a comment on the one still open), a comment on the PR that records the stop and links
the issue, and a toast whose click opens the issue. Then it leaves the PR alone (no review, fix
round or merge) until Stefan answers: he closes the issue, or replies on the PR or the issue
(a decision on his reply comes first, `decisions.py`), or `--release NAME#PR`.

The kinds (KINDS): a review that stopped (a new Important finding in an earlier class, a fixed
finding reopening, a decline Sol kept), a failed check on H (a failed GitHub Actions check is
re-run once per head first, and is a stop only if it fails again: issue #93; a failed commit
status can't be re-run and stops at once), a conflict on H that a conflict round
couldn't resolve, that came back on the base its last round merged, or that came back after 5
rounds (issue #91; a conflict first gets a conflict round,
`fix.py`), and a fix round that ended without pushing (H was reviewed already): each found here,
and filed once per head H. Two
come from decisions (`decisions.py`): review 3 or later still blocking (`approach-note`, filed
with the Approach note a decision thread wrote) and a decision thread's own question
(`decision`).

**The base's own failure** (issue #98): before a failed check on H is a stop (or is re-run), the
runner reads the checks on the head of the repo's base branch (`main`). When every check that
failed on H fails there too, by name, the failure is the base's: the PR gets no stop, and is held
on H (a `base-hold` job, `held`), saying `not now, main fails <checks> too`. The repo gets one stop
of its own instead, the first time the base is seen red: a `needs-info` issue "main fails its
checks" (a `base` job, `filed`, with the checks, the base's head and its runs). While it's open, no
build starts in the repo (`run.py`); fix rounds, conflict rounds and decisions go on. It's the one
stop that resolves itself: once the base's checks pass, each held PR still at its held head is
brought up to date with GitHub's update-branch (no AI; one GitHub refuses, a conflict, is left to
the conflict round; one GitHub failed to answer, or with a Claude job writing to it, is tried
again next pass), and the runner closes the issue. A hold is checked again each pass: a check
failing on H that the base doesn't fail ends it, and the failure is the PR's own. A base with no checks yet isn't red; while
the stop is open and the base's new head is still running its checks, its last failing checks
count. A check that fails on H but passes on the base is the PR's, as before. Only a PR into the
repo's own base (`base` in config.toml) is compared: a stacked PR's failure is its own.

Filing is an automated post in the repo's own issues and PRs, which needs no go-ahead
(`docs/flow.md`, Who runs it).
"""
import datetime
import json
import os

from .ledger import RUNNER_MARK, STOP_MARK, said_since
from .state import NOT_SENT, NOT_STARTED, REVIEWED
from .toast import NoToaster

NEEDS_INFO = 'needs-info'
CONFLICT = 'conflict'   # a fix job's `cause` for a conflict round (ticket 15)
# A PR conflicting again after this many conflict rounds since the last release: a stop, since
# main keeps moving under it and each round costs usage (issue #91).
MAX_CONFLICT_ROUNDS = 5
# A conflict round on H that ended so, with the PR still at H and conflicting: it couldn't
# resolve it. (`failed` and `waiting` get a decision first, `usage-limit` a restart.)
UNRESOLVED = ('no-push', 'head-unknown', 'branch-exists')
# A job re-running a failed Actions check on H once before it's a stop (issue #93).
RERUN = 'rerun'
# The repo's base branch fails its checks: one stop for the repo, not one per PR (issue #98).
BASE = 'base'
# A PR held on H because every check that failed on it fails on the base too (issue #98):
# `held`, then `updated` (brought up to date with the base once it passed), `update-failed` (GitHub
# refused, a conflict: the conflict round's) or `moved` (its head moved, or it closed, meanwhile).
BASE_HOLD = 'base-hold'
# A PR stopped for a failed check on H, updated from its base once the base moved, to be checked
# again on the new head (issue #199): `updated` (waiting on the new head's checks), then `passed`
# (the stop settled, its issue closed) or `failed-again` (the new head's own failed-check stop);
# `update-failed` (GitHub refused: a conflict), or `not-started` (GitHub didn't answer: tried
# again next pass). Once per PR and base head.
RECHECK = 'recheck'
# A failed-check stop's `answer` once the PR passed its checks after that update: the runner's
# answer, not Stefan's.
PASSED_AFTER_UPDATE = 'passed-after-update'
# An Actions run's conclusions that pass (as `github._PASSED`).
PASSED = ('success', 'neutral', 'skipped')
KINDS = {
    'review': 'Sol\'s review stopped the loop',
    'approach-note': 'Still blocking after review 3',
    'failed-check': 'A check failed',
    'conflict': 'It conflicts with its base',
    'no-push': 'The fix round pushed nothing',
    'decision': 'A decision needs you',
    'live': 'Merged, but not live yet',
    'live-todo': 'Live, with steps only you can do',
}
# A stop's `answer` when its PR was merged or closed on GitHub while it was filed (issue #88).
PR_CLOSED = 'pr-closed'
# Stops filed on a PR that's merged already (live runs): its merge answers nothing.
ON_MERGED = ('live', 'live-todo')
SIGNALS = {   # decide()'s stop signals, when the review's run folder can't say more
    'repeated-class': 'a new Important finding repeats an earlier class',
    'reopened': 'a fixed finding came back',
    'decline-kept': 'Sol kept a decline open',
}


def needs_info_mark(github: str, n: int) -> str:
    """The hidden line that ties a `needs-info` issue to its PR."""
    return f'<!-- queue-runner needs-info {github}#{n} -->'


def base_mark(github: str, branch: str) -> str:
    """The hidden line on the base stop's issue. It starts as a PR's `needs-info` mark does, so
    the work lists leave it out of the issues as theirs (`work.NEEDS_INFO_MARK`)."""
    return f'<!-- queue-runner needs-info {github} base {branch} -->'


def red_base(jobs, repo_name: str, branch: str | None = None):
    """The repo's base stop while its base fails its checks (issue #98), or None. While there's
    one, no build starts in the repo. It's the newest `base` job on the branch, `filed` or not
    filed yet (`failed`: its issue couldn't be filed, or still open: cut off while filing), so
    a red base holds builds back whether or not GitHub took the issue (review 1, F4)."""
    found = [j for j in jobs.jobs() if j.kind == BASE and j.repo == repo_name
             and (branch is None or j.branch == branch)]
    if found and (found[-1].open or found[-1].outcome in ('filed', 'failed')):
        return found[-1]
    return None


def base_hold(jobs, repo_name: str, pr):
    """The hold on this PR's head H because the base fails the same checks, or None."""
    holds = [j for j in jobs.on(BASE_HOLD, repo_name, pr.number, pr.head_sha)
             if j.outcome == 'held']
    return holds[-1] if holds else None


def refused(e: Exception) -> bool:
    """Whether GitHub refused a write (HTTP 422: a conflict, or the head moved), as against
    failing to answer (a 5xx, the network): only a refusal is final (review 1, F2)."""
    return '(HTTP 422)' in str(e)


def utc(stamp: str) -> str:
    """A job's local time as GitHub writes times (UTC, `Z`), so the two compare as text."""
    t = datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    return t.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def number_of(url: str) -> int:
    return int(url.rstrip('/').rsplit('/', 1)[-1])


def _run_link(run) -> str:
    """An Actions run's attempt, as a markdown link."""
    return f'[run {run.id}]({run.url}/attempts/{run.attempt})'


def _asked_on(job, run_id) -> int:
    """The attempt of `run_id` that had failed when the runner asked GitHub to re-run it."""
    return next((r['attempt'] for r in job.runs if r['id'] == run_id), 1)


def _signal_texts(review) -> str:
    """Why the review stopped, as decide() said it (from its decision.json), else by name."""
    try:
        with open(os.path.join(review.run_dir or '', 'decision.json'), encoding='utf-8') as f:
            texts = [s['text'] for s in json.load(f)['signals']]
    except (OSError, ValueError, KeyError, TypeError):
        texts = [SIGNALS.get(s, s) for s in review.signals]
    return '; '.join(texts) or 'it stopped for Stefan'


class Stopper:
    def __init__(self, config, *, github, jobs, say, toaster=None):
        self.config, self.github, self.jobs, self.say = config, github, jobs, say
        self.toaster = toaster or NoToaster()
        # Each repo's base as this pass read it: (its head, the checks failing there), or absent
        # when it isn't red (issue #98).
        self._red: dict[str, tuple[str, frozenset]] = {}
        self._said_base: dict[str, str] = {}

    # --- what stops ---------------------------------------------------------------------------

    def detect(self, repo, pr) -> list[tuple[str, str, str | None]]:
        """The stops on this PR's head H now: [(kind, why, link)], whether filed or not. A PR that a
        Claude job is writing to has none yet."""
        if self.jobs.writer(repo.name, pr.branch):
            return []
        n, h, h7 = pr.number, pr.head_sha, pr.head_sha[:7]
        found = []
        review = self.jobs.runner_review(repo.name, n, h)
        if review and review.outcome == 'stop':
            found.append(('review', f'review {review.round} on {h7}: {_signal_texts(review)}',
                          review.link))
        elif review and review.outcome == 'approach-note':
            # Review 3 or later still blocking: a decision thread writes the Approach note and
            # files the stop (decisions.py), `held` keeping the PR alone until then. Found here
            # only once that decision ended, in case filing it failed.
            d = self.jobs.decided(review.id)
            if d and not d.open and d.outcome in ('approach-note', 'stop'):
                found.append(('approach-note', d.reason or f'review {review.round} on {h7} is '
                              'still blocking', d.link))
        fixes = [j for j in self.jobs.on('fix', repo.name, n, h) if not j.open]
        if fixes and fixes[-1].outcome == 'no-push' and fixes[-1].cause != CONFLICT:
            # A conflict round's H was never reviewed: its no-push is a conflict stop (below).
            found.append(('no-push', f'the fix round after review {fixes[-1].round} ended '
                          f'without pushing, so the PR is still at {h7}, which was reviewed',
                          fixes[-1].link))
        checks = self.github.checks(repo, h)
        if (checks.state == 'failed' and not base_hold(self.jobs, repo.name, pr)
                and (why := self._failed_check(repo, pr, checks))):
            found.append(('failed-check', why, None))
        if self.github.has_conflict(repo, n) and (stop := conflict_stop(self.jobs, self.github, repo, pr)):
            found.append(('conflict', *stop))
        return found

    def _reruns(self, repo, pr) -> dict:
        """The runner's re-run of each Actions run on H, by run id: its newest that reached
        GitHub, or is still open (one that never did, `not-started`, holds nothing)."""
        out = {}
        for j in self.jobs.on(RERUN, repo.name, pr.number, pr.head_sha):
            if j.outcome != NOT_STARTED:
                out.update((r['id'], j) for r in j.runs)
        return out

    def _failed_check(self, repo, pr, checks) -> str | None:
        """Why a failed check on H is a stop, or None while a re-run is due or running (issue
        #93). Each failed Actions run is re-run once on H, on its own (PR #105's F1): a run
        failing after another passed its re-run still gets its own. A failed commit status
        can't be re-run; a run past its first attempt that the runner didn't re-run was re-run
        by hand; one the runner re-ran is a stop once its new attempt ended and didn't pass.
        The run's own conclusion decides, since check-runs can still list the old failure
        after the re-run passed (F4)."""
        h7 = pr.head_sha[:7]
        if not checks.runs:
            return f'a check failed on {h7} ({", ".join(checks.failed)})'
        # Each run that stops names only its own checks (PR #105's F5): check-runs may still
        # list another run's failure after its re-run passed.
        reruns, stops = self._reruns(repo, pr), []
        for run_id in checks.runs:
            job, run = reruns.get(run_id), self.github.workflow_run(repo, run_id)
            names = f'({", ".join(checks.failed_in(run_id))})'
            if job is None:
                if run.attempt > 1:
                    stops.append(f'{names} on attempt {run.attempt} of {_run_link(run)}, '
                                 're-run already')
            elif job.outcome == 'failed':
                stops.append(f'{names} and re-running it failed ({job.error})')
            elif (not job.open and run.status == 'completed'
                  and run.attempt > _asked_on(job, run_id) and run.conclusion not in PASSED):
                stops.append(f'{names} again after one re-run (attempt {run.attempt} of '
                             f'{_run_link(run)})')
        return f'a check failed on {h7} ' + '; '.join(stops) if stops else None

    def _settle_reruns(self, repo, pr, name) -> None:
        """A re-run left open was cut off with its runner (PR #105's F2): GitHub was asked if
        the run has moved past the attempt it recorded (`rerun`), else not (`not-started`, so
        this pass asks it)."""
        for job in self.jobs.on(RERUN, repo.name, pr.number):
            if not job.open:
                continue
            moved = all(self.github.workflow_run(repo, r['id']).attempt > r['attempt']
                        for r in job.runs)
            self.jobs.ended(job.id, exit_code=None, outcome=RERUN if moved else NOT_STARTED,
                            reason=job.reason, runs=job.runs)
            self.say(f'{name}: a re-run cut off with its runner '
                     + ('had reached GitHub' if moved else 'never reached GitHub: asked again'))

    def _said_passed(self, repo, pr, job, name) -> None:
        """Says on the PR, once, that a re-run passed, then records it (F3): a post that fails
        leaves the job `rerun`, so the next pass says it; one already on the PR (its record not
        written) isn't said again."""
        n, h, h7 = pr.number, pr.head_sha, pr.head_sha[:7]
        ids = ' '.join(str(r['id']) for r in job.runs)
        mark = f'{RUNNER_MARK}rerun passed sha={h} run={ids} -->'
        failed = ', '.join(f'attempt {r["attempt"]} of [run {r["id"]}]'
                           f'({r["url"]}/attempts/{r["attempt"]})' for r in job.runs)
        try:
            if not any(mark in c.body for c in self.github.issue_comments(repo, n)):
                self.github.post_comment(repo, n, (
                    f'**A check passed on a re-run.** {job.reason} failed on {h7} in {failed} '
                    'and passed on a re-run, so the loop carries on. If it keeps happening, '
                    f'the check is flaky.\n\n{mark}\n'))
        except Exception as e:
            self.say(f'{name}: saying the re-run passed on the PR failed ({e}); the next pass '
                     'says it')
            return
        self.jobs.ended(job.id, exit_code=None, outcome='passed', reason=job.reason,
                        runs=job.runs)
        self.say(f'{name}: {job.reason} passed on its re-run at {h7}')

    def retry_checks(self, repo, pr) -> None:
        """Issue #93: each failed Actions run on H that the runner hasn't re-run gets its failed
        jobs re-run, once per run and head, so a GitHub hiccup never reaches Stefan; once a
        re-run has passed, the PR says so in one line, so a flaky check stays visible."""
        if self.jobs.writer(repo.name, pr.branch) or base_hold(self.jobs, repo.name, pr):
            return   # the base fails the same checks: re-running them wastes a run (#98)
        n, h, h7 = pr.number, pr.head_sha, pr.head_sha[:7]
        name = f'stop {repo.name}#{n}'
        self._settle_reruns(repo, pr, name)
        reruns = self._reruns(repo, pr)
        for job in {j.id: j for j in reruns.values() if j.outcome == RERUN}.values():
            runs = [self.github.workflow_run(repo, r['id']) for r in job.runs]
            if all(r.status == 'completed' and r.attempt > _asked_on(job, r.id)
                   and r.conclusion in PASSED for r in runs):
                self._said_passed(repo, pr, job, name)
        checks = self.github.checks(repo, h)
        if checks.state != 'failed' or not checks.runs:
            return
        for run_id in checks.runs:
            if run_id in reruns:
                continue
            what = ', '.join(checks.failed_in(run_id))   # this run's own checks (F5)
            run = self.github.workflow_run(repo, run_id)
            if run.attempt > 1 or run.status != 'completed':
                continue   # re-run by hand (a stop), or GitHub is between attempts
            record = [{'id': run.id, 'attempt': run.attempt, 'url': run.url}]
            # The start record names the run before GitHub is asked, so a runner cut off in
            # between is settled from the run (F2).
            job = self.jobs.started(kind=RERUN, repo=repo.name, issue=n, branch=pr.branch,
                                    title=f'Queue runner rerun: {repo.name}#{n}', sha=h,
                                    reason=what, runs=record)
            try:
                self.github.rerun_failed(repo, run.id)
            except Exception as e:
                self.jobs.ended(job.id, exit_code=None, outcome='failed', reason=what,
                                runs=record, error=f'{type(e).__name__}: {e}')
                self.say(f'{name}: re-running run {run.id} failed ({e}): a stop')
                continue
            self.jobs.ended(job.id, exit_code=None, outcome=RERUN, reason=what, runs=record)
            self.say(f'{name}: {what} failed on {h7}; re-running the failed jobs of run '
                     f'{run.id} once before it is a stop')

    def new_stops(self, repo, pr) -> list[tuple[str, str, str | None]]:
        """The stops on H not filed yet. A conflict stop filed on H before a conflict round on
        H (before ticket 15 a conflict was always a stop, and a release lets a round try) doesn't
        count for the round's own stop."""
        return [s for s in self.detect(repo, pr)
                if not self.jobs.stopped(repo.name, pr.number, pr.head_sha, s[0])
                or (s[0] == CONFLICT and not self._conflict_filed_since_round(repo, pr))]

    def _conflict_filed_since_round(self, repo, pr) -> bool:
        rounds = rounds_on(self.jobs, repo.name, pr.number, pr.head_sha)
        if not rounds:
            return True
        pos = positions(self.jobs)
        return any(j.stop == CONFLICT and j.outcome in ('filed', 'answered')
                   and pos[j.id] > pos[rounds[-1].id]
                   for j in self.jobs.on('stop', repo.name, pr.number, pr.head_sha,
                                         released=True))

    def stop_pass(self, halted=lambda: False) -> None:
        """Each repo: the stops Stefan answered go back to the loop, then every open PR's new
        stops are filed. A repo Stefan stopped is left as it is (ticket 37), and once `halted()`
        says the reviewing lane was stopped, the repos after it (ticket 30)."""
        from .config import working
        for repo in working(self.config):
            if not repo.github:
                continue
            if halted():
                return
            self.answers(repo)
            self.base_pass(repo)
            try:
                prs = sorted(self.github.open_pulls(repo), key=lambda p: p.number)
            except Exception as e:   # GitHub down: the next pass tries again
                self.say(f'stops on {repo.name}: listing PRs failed ({type(e).__name__}: {e})')
                continue
            for pr in prs:
                self.check(repo, pr)

    def check(self, repo, pr) -> None:
        """Files each stop on the PR's head that isn't filed yet. GitHub failing is said; the
        next pass tries again."""
        try:
            self.recheck(repo, pr)
            self.hold_for_base(repo, pr)
            self.retry_checks(repo, pr)
            for kind, why, link in self.new_stops(repo, pr):
                self.file(repo, pr, kind, why, link,
                          base=self._base_head(repo, pr) if kind == 'failed-check' else None)
        except Exception as e:
            self.say(f'stop {repo.name}#{pr.number}: checking for stops failed '
                     f'({type(e).__name__}: {e})')

    # --- the base's own failure (issue #98) ---------------------------------------------------

    def base_pass(self, repo) -> None:
        """Reads the checks on the head of the repo's base: red, it files the repo's one base
        stop (once); passing, it brings the PRs held for it up to date and closes that stop.
        GitHub failing is said, and the base counts as not red this pass."""
        self._red.pop(repo.name, None)
        branch = repo.base
        try:
            sha = self.github.branch_head(repo, branch)
            checks = self.github.checks(repo, sha)
        except Exception as e:
            self.say_base(repo, f'{repo.name}: reading the checks on {branch} failed '
                          f'({type(e).__name__}: {e}); next pass')
            return
        stop = red_base(self.jobs, repo.name, branch)
        if checks.state == 'failed':
            self._red[repo.name] = (sha, frozenset(checks.failed))
            self.say_base(repo, f'{repo.name}: {branch} fails {", ".join(checks.failed)} at '
                          f'{sha[:7]}: no build starts from it, and a PR failing only those '
                          'is held, not stopped')
            if stop is None or stop.outcome != 'filed':   # none, or its issue not filed yet
                self._file_base(repo, branch, sha, checks)
        elif checks.state == 'passed':
            self._said_base.pop(repo.name, None)
            self._base_passed(repo, branch, sha, stop)
        elif stop is not None:   # its new head's checks are still running: still red
            self._red[repo.name] = (stop.sha, frozenset(stop.signals))

    def say_base(self, repo, line: str) -> None:
        if self._said_base.get(repo.name) != line:
            self._said_base[repo.name] = line
            self.say(line)

    def _file_base(self, repo, branch, sha, checks) -> None:
        """The repo's one base stop: a `needs-info` issue (or a comment on the open one), and a
        toast. 'failed' if the issue couldn't be filed: the next pass files it."""
        name, h7 = f'stop {repo.name} {branch}', sha[:7]
        names = ', '.join(checks.failed)
        runs = [f'https://github.com/{repo.github}/actions/runs/{r}' for r in checks.runs]
        where = ', '.join(f'[run {u.rsplit("/", 1)[-1]}]({u})' for u in runs) or (
            f'[the commit](https://github.com/{repo.github}/commit/{sha})')
        why = f'{names} on {h7}'
        job = self.jobs.started(kind=BASE, repo=repo.name, issue=None, branch=branch,
                                title=f'Queue runner base: {repo.name} {branch}', sha=sha,
                                reason=why)
        line = (f'**{branch} fails its checks**: {names} failed on {branch} at {h7} ({where}). '
                f'Every PR into {branch} inherits that, so a PR failing only those checks is '
                'held, not stopped, and no build starts from it.')
        mark = base_mark(repo.github, branch)
        try:
            had = next((i for i in self.github.open_issues(repo) if mark in i.body), None)
            if had:
                self.github.post_comment(repo, had.number, f'Red again: {line}\n\n'
                                         f'{RUNNER_MARK}base red sha={sha} -->\n')
                url = had.url
            else:
                url = self.github.create_issue(repo, f'{branch} fails its checks', (
                    f'{line}\n\nFix {branch} (a PR that makes these checks pass). Once they pass '
                    'on its head, the queue runner brings each held PR up to date with '
                    f'{branch} and closes this issue itself.\n\n'
                    "<sub>Filed by the queue runner from Stefan's PC.</sub>\n\n" + mark + '\n'),
                    [NEEDS_INFO])
        except Exception as e:   # still red (F4): `red_base` holds builds back meanwhile
            self.jobs.ended(job.id, exit_code=None, outcome='failed', reason=why,
                            signals=list(checks.failed), error=f'{type(e).__name__}: {e}')
            self.say(f'{name}: filing its needs-info issue failed ({e}); next pass')
            return
        self.jobs.ended(job.id, exit_code=None, outcome='filed', link=url, reason=why,
                        signals=list(checks.failed))
        self.say(f'{name}: {branch} fails its checks ({why}); filed {url}')
        try:
            self.toaster.toast(f'{repo.name}: {branch} fails its checks', f'{why}.'[:250], url,
                               tag=f'{repo.name}-base', button='Open the issue')
        except Exception as e:
            self.say(f'{name}: the toast failed: {e}')

    def _base_passed(self, repo, branch, sha, stop) -> None:
        """The base passes again: each PR held for it still at its held head is updated from
        the base (GitHub's update-branch), then the base stop is closed. A close that fails
        leaves the stop open, so the next pass closes it.

        A held PR with a Claude job writing to its branch (`JobLog.writer`) waits for that job
        (review 1, F3); an update GitHub refuses (HTTP 422: a conflict, or the head moved) is
        `update-failed`, left to the conflict round; any other failure (GitHub down) keeps the
        hold, and the next pass tries again (F2). Holds are read apart from the stop, so they
        are tried again after it's closed. A stop whose issue was never filed is closed with
        nothing posted (F4)."""
        holds = [j for j in self.jobs.jobs() if j.kind == BASE_HOLD and j.repo == repo.name
                 and j.outcome == 'held']
        updated = []
        for hold in holds:
            n, name = hold.issue, f'stop {repo.name}#{hold.issue}'
            try:
                pr = self.github.pull(repo, n)
            except Exception as e:
                self.say(f'{name}: reading it to update it from {branch} failed ({e}); next pass')
                continue
            if pr.state != 'open' or pr.head_sha != hold.sha:
                self.jobs.ended(hold.id, exit_code=None, outcome='moved', reason=hold.reason)
                continue
            if writer := self.jobs.writer(repo.name, pr.branch):
                self.say_hold(hold, f'{name}: {branch} passes again, but {writer.title} is '
                              'writing to the PR: it is updated once that job ends')
                continue
            try:
                self.github.update_branch(repo, n, hold.sha)
            except Exception as e:
                if not refused(e):   # GitHub down, not a refusal: tried again next pass
                    self.say_hold(hold, f'{name}: updating the PR from {branch} failed '
                                  f'({type(e).__name__}: {e}); next pass')
                    continue
                # a conflict: the conflict round's (fix.py)
                self.jobs.ended(hold.id, exit_code=None, outcome='update-failed',
                                reason=hold.reason, error=f'{type(e).__name__}: {e}')
                self.say(f'{name}: {branch} passes again, but GitHub would not update the PR '
                         f'from it ({e}); a conflict round comes first')
                continue
            self.jobs.ended(hold.id, exit_code=None, outcome='updated', reason=hold.reason)
            updated.append(n)
            self.say(f'{name}: {branch} passes again at {sha[:7]}: updated the PR from it')
        if stop is None:
            return
        if stop.outcome != 'filed':   # its issue was never filed: nothing to comment or close
            self.jobs.ended(stop.id, exit_code=None, outcome='closed', reason=stop.reason,
                            signals=stop.signals, head=sha)
            self.say(f'stop {repo.name} {branch}: {branch} passes again at {sha[:7]}')
            return
        prs = ', '.join(f'#{n}' for n in updated)
        try:
            n = number_of(stop.link)
            self.github.post_comment(repo, n, (
                f'**{branch} passes its checks again** at {sha[:7]}.'
                + (f' The queue runner updated {prs} from it.' if updated else '')
                + f' Closed by the queue runner.\n\n{RUNNER_MARK}base passed sha={sha} -->\n'))
            self.github.close_completed(repo, n)
        except Exception as e:
            self.say(f'stop {repo.name} {branch}: closing {stop.link} failed ({e}); next pass')
            return
        self.jobs.ended(stop.id, exit_code=None, outcome='closed', link=stop.link,
                        reason=stop.reason, signals=stop.signals, head=sha)
        self.say(f'stop {repo.name} {branch}: {branch} passes again at {sha[:7]}; closed '
                 f'{stop.link}')

    def say_hold(self, hold, line: str) -> None:
        """Said once per hold and line: a held PR waiting on something, pass after pass."""
        key = f'hold {hold.id}'
        if self._said_base.get(key) != line:
            self._said_base[key] = line
            self.say(line)

    def hold_for_base(self, repo, pr) -> None:
        """Holds the PR on H, with no stop, when every check that failed on H fails on the base
        too (issue #98): the failure is the base's. Said once per head.

        A hold is checked again on every pass while the base is red (review 1, F1): once a
        check fails on H that the base doesn't fail, the failure is the PR's own
        (`own-failure`), and once nothing fails on H any more there's nothing to hold
        (`cleared`). Either way the hold ends and the PR goes on as any other (#93's re-run,
        then a stop). Each pass judges H's failures as they are now, not as they were (review
        2, F5): once its own failure passes its re-run and H fails only what the base fails,
        it's held again."""
        red = self._red.get(repo.name)
        if red is None or (pr.base and pr.base != repo.base):
            return
        n, h7 = pr.number, pr.head_sha[:7]
        if hold := base_hold(self.jobs, repo.name, pr):
            checks = self.github.checks(repo, pr.head_sha)
            if checks.state == 'failed' and not set(checks.failed) <= red[1]:
                own = ', '.join(c for c in checks.failed if c not in red[1])
                self.jobs.ended(hold.id, exit_code=None, outcome='own-failure',
                                reason=hold.reason, error=f'{own} failed on {h7}, not on '
                                f'{repo.base}')
                self.say(f'stop {repo.name}#{n}: {own} failed on {h7} and not on {repo.base}: '
                         'no longer held, the failure is its own')
            elif checks.state in ('passed', 'none'):
                self.jobs.ended(hold.id, exit_code=None, outcome='cleared', reason=hold.reason)
                self.say(f'stop {repo.name}#{n}: nothing fails on {h7} any more: no longer held')
            return
        if self.jobs.writer(repo.name, pr.branch):
            return
        checks = self.github.checks(repo, pr.head_sha)
        if checks.state != 'failed' or not set(checks.failed) <= red[1]:
            return
        names = ', '.join(checks.failed)
        stop = red_base(self.jobs, repo.name, repo.base)
        job = self.jobs.started(kind=BASE_HOLD, repo=repo.name, issue=pr.number,
                                branch=pr.branch,
                                title=f'Queue runner base hold: {repo.name}#{pr.number}',
                                sha=pr.head_sha, about=stop.id if stop else None, reason=names)
        self.jobs.ended(job.id, exit_code=None, outcome='held', reason=names,
                        link=stop.link if stop else None)
        self.say(f'stop {repo.name}#{pr.number}: not now, {repo.base} fails {names} too: held '
                 f'at {pr.head_sha[:7]} until {repo.base} passes')

    # --- a failed check, checked again once the base moved (issue #199) ------------------------

    def _base_head(self, repo, pr) -> str | None:
        """The head of the PR's base now, or None when GitHub doesn't say."""
        try:
            return self.github.branch_head(repo, pr.base or repo.base)
        except Exception:
            return None

    def recheck(self, repo, pr) -> None:
        """Issue #199: a PR stopped for a failed check on H whose base has moved since is brought
        up to date with its base (GitHub's update-branch, as for a base hold), once per base
        head, so a failure the base has since fixed never waits on Stefan. Then the new head's
        checks decide: passing settles the stop (`_after_update`); failing is #93's re-run and
        then a stop, as on any head. Left alone, said once: a PR with another stop open, one that
        moved from H, a Claude job writing to it, a conflict (the conflict round's), a red base,
        or a base that hasn't moved. A stop filed before #199 has no base recorded: its base
        counts as moved, as a conflict round's record without one does."""
        n, h = pr.number, pr.head_sha
        name = f'stop {repo.name}#{n}'
        rechecks = self.jobs.on(RECHECK, repo.name, n)
        if rechecks and rechecks[-1].outcome == 'updated':
            self._after_update(repo, pr, rechecks[-1], name)
            return
        stops = self.jobs.open_stops(repo.name, n)
        failed = [s for s in stops if s.stop == 'failed-check']
        if not failed:
            return
        stop, branch = failed[-1], pr.base or repo.base
        key, h7 = f'recheck {repo.name}#{n}', h[:7]
        if others := [s for s in stops if s.stop != 'failed-check']:
            return self.say_once(key, f'{name}: not checked again on a newer {branch}: it has '
                                 f'another stop for Stefan ({others[-1].stop})')
        if stop.sha != h:
            return self.say_once(key, f'{name}: not checked again on a newer {branch}: it moved '
                                 f'from {stop.sha[:7]}, where it stopped, to {h7}')
        try:
            base = self.github.branch_head(repo, branch)
        except Exception as e:
            return self.say_once(key, f'{name}: reading {branch} to check it again failed ({e}); '
                                 'next pass')
        if stop.base == base:
            return self.say_once(key, f'{name}: not checked again: {branch} has not moved since '
                                 f'its check failed (still {base[:7]})')
        if any(j.base == base and j.outcome != NOT_STARTED for j in rechecks):
            return self.say_once(key, f'{name}: updated from {branch} at {base[:7]} and checked '
                                 'again already: left for Stefan')
        if branch == repo.base and repo.name in self._red:
            return self.say_once(key, f'{name}: not checked again yet: {branch} fails its own '
                                 'checks')
        if writer := self.jobs.writer(repo.name, pr.branch):
            return self.say_once(key, f'{name}: not checked again on {branch} at {base[:7]} yet: '
                                 f'{writer.title} is writing to the PR')
        if self.github.has_conflict(repo, n):
            return self.say_once(key, f'{name}: not checked again on {branch} at {base[:7]}: it '
                                 'conflicts, so a conflict round comes first')
        job = self.jobs.started(kind=RECHECK, repo=repo.name, issue=n, branch=pr.branch,
                                title=f'Queue runner recheck: {repo.name}#{n}', sha=h, base=base,
                                about=stop.id, reason=stop.reason)
        try:
            self.github.update_branch(repo, n, h)
        except Exception as e:
            how = 'update-failed' if refused(e) else NOT_STARTED
            self.jobs.ended(job.id, exit_code=None, outcome=how, link=stop.link,
                            reason=stop.reason, error=f'{type(e).__name__}: {e}')
            self.say(f'{name}: {branch} moved to {base[:7]}, but updating the PR from it failed '
                     f'({e}); ' + ('left for Stefan' if how == 'update-failed' else 'next pass'))
            return
        self.jobs.ended(job.id, exit_code=None, outcome='updated', link=stop.link,
                        reason=stop.reason)
        self.say(f'{name}: {branch} moved to {base[:7]} since its check failed on {h7}: updated '
                 'the PR from it, to check it again')

    def _after_update(self, repo, pr, job, name) -> None:
        """A recheck's update landed (the PR moved past H): its new head's checks passing settle
        the stop (a comment on its issue, the issue closed, the stop answered), so the PR goes
        back to review; a failed-check stop filed on the new head (after #93's re-run) ends the
        recheck. Pending, or failed with its re-run still going: the next pass looks again. A
        comment or close that fails is tried again next pass, the comment not posted twice."""
        h = pr.head_sha
        if h == job.sha:
            return   # GitHub hasn't made the new merge commit yet
        if self.jobs.stopped(repo.name, pr.number, h, 'failed-check'):
            self.jobs.ended(job.id, exit_code=None, outcome='failed-again', link=job.link,
                            reason=job.reason, head=h)
            self.say(f'{name}: a check fails on {h[:7]} too, after the update: left for Stefan')
            return
        if self.github.checks(repo, h).state != 'passed':
            return
        open_stops = self.jobs.open_stops(repo.name, pr.number)
        stops = [s for s in open_stops if s.stop == 'failed-check']
        branch, h7 = pr.base or repo.base, h[:7]
        if job.link and any(s.link == job.link for s in stops):
            i = number_of(job.link)
            mark = f'{RUNNER_MARK}recheck passed pr={pr.number} sha={h} -->'
            try:
                if not any(mark in c.body for c in self.github.issue_comments(repo, i)):
                    self.github.post_comment(repo, i, (
                        f'**{branch} moved, and the checks pass on the new head.** PR '
                        f'#{pr.number} stopped for a failed check on {job.sha[:7]}; once '
                        f'{branch} moved to {job.base[:7]}, the queue runner updated the PR '
                        f'from it, and its checks pass on {h7}. Closed by the queue runner; '
                        f'the PR is back in review.\n\n{mark}\n'))
                # Another kind of stop on the same issue (filed since) is still Stefan's.
                if not any(s.link == job.link for s in open_stops if s.stop != 'failed-check'):
                    self.github.close_completed(repo, i)
            except Exception as e:
                self.say(f'{name}: the checks pass on {h7}, but closing {job.link} failed ({e}); '
                         'next pass')
                return
        for s in stops:
            self.jobs.ended(s.id, exit_code=None, outcome='answered', link=s.link,
                            reason=s.reason, answer=PASSED_AFTER_UPDATE)
        self.jobs.ended(job.id, exit_code=None, outcome='passed', link=job.link,
                        reason=job.reason, head=h)
        self.say(f'{name}: the checks pass on {h7} after updating it from {branch}: its stop '
                 'is settled, and the PR is back in review')

    def say_once(self, key: str, line: str) -> None:
        """Said once per key and line: a PR left alone the same way, pass after pass."""
        if self._said_base.get(key) != line:
            self._said_base[key] = line
            self.say(line)

    # --- filing -------------------------------------------------------------------------------

    def file(self, repo, pr, kind: str, why: str, link: str | None = None,
             after: str | None = None, base: str | None = None) -> str:
        """Files one stop: the PR's `needs-info` issue (opened, or a comment on the open one),
        a comment on the PR, a toast. 'filed', or 'failed' if the issue couldn't be filed (then
        nothing counts, and the next pass files it). `base`, the head of the PR's base when a
        check failed, tells a recheck whether the base has moved since (issue #199)."""
        n, h, name = pr.number, pr.head_sha, f'stop {repo.name}#{pr.number}'
        job = self.jobs.started(kind='stop', repo=repo.name, issue=n, branch=pr.branch,
                                title=f'Queue runner stop: {repo.name}#{n}', sha=h, stop=kind,
                                base=base)
        line = f'**{KINDS[kind]}**: {why}.' + (f' ([details]({link}))' if link else '')
        try:
            url, opened = self._issue(repo, pr, line)
        except Exception as e:
            self.jobs.ended(job.id, exit_code=None, outcome='failed', reason=why,
                            error=f'{type(e).__name__}: {e}')
            self.say(f'{name}: filing the needs-info issue failed ({e}); next pass')
            return 'failed'
        self.say(f'{name}: {KINDS[kind].lower()} ({why}); '
                 + (f'filed {url}' if opened else f'added to {url}'))
        try:
            self.github.post_comment(repo, n, (
                f'**The {"queue runner" if after else "review loop"} stopped here for Stefan.** '
                f'{line}\n\nTracked in #{number_of(url)}. '
                + (after or 'The queue runner leaves this PR alone until that issue is closed or '
                   'Stefan replies here.') + '\n\n'
                f'{STOP_MARK}kind={kind} sha={h} issue={number_of(url)} -->\n'))
        except Exception as e:
            self.say(f'{name}: recording the stop on the PR failed: {e}')
        self.jobs.ended(job.id, exit_code=None, outcome='filed', link=url, reason=why)
        try:
            self.toaster.toast(f'{repo.name} PR #{n} needs you', f'{KINDS[kind]}: {why}.'[:250],
                               url, tag=f'{repo.name}-{n}-{kind}', button='Open the issue')
        except Exception as e:
            self.say(f'{name}: the toast failed: {e}')
        return 'filed'

    def _issue(self, repo, pr, line: str) -> tuple[str, bool]:
        """The PR's open `needs-info` issue with this stop added, or a new one: (url, opened)."""
        n = pr.number
        mark = needs_info_mark(repo.github, n)
        had = next((i for i in self.github.open_issues(repo) if mark in i.body), None)
        if had:
            self.github.post_comment(repo, had.number, f'Another stop on PR #{n}: {line}\n\n'
                                     f'{RUNNER_MARK}stop added -->\n')
            return had.url, False
        body = (f'The queue runner stopped the review loop on PR #{n} ({pr.url or pr.title}) '
                f'and left it for Stefan.\n\n- {line}\n\n'
                'Close this issue, or reply on the PR, and the runner takes the PR back. A later '
                'stop on the PR is added here as a comment.\n\n'
                "<sub>Filed by the queue runner from Stefan's PC.</sub>\n\n" + mark + '\n')
        title = f'PR #{n} needs Stefan' + (f': {pr.title}' if pr.title else '')
        return self.github.create_issue(repo, title, body, [NEEDS_INFO]), True

    # --- answers ------------------------------------------------------------------------------

    def file_on_issue(self, repo, n: int, why: str, link: str | None = None,
                      open_url: str | None = None, after: str | None = None) -> None:
        """A decision on a build (or on a thread waiting for an answer) stops for Stefan: the
        question goes on the issue or PR, which its job holds until `--release` (or the thread
        ends), and a toast opens `open_url` (default: that comment)."""
        name = f'stop {repo.name}#{n}'
        line = f'**{KINDS["decision"]}**: {why}' + (f' ([the decision]({link}))' if link else '')
        url = open_url
        after = after or f'The issue stays held until `--release {repo.name}#{n}`.'
        try:
            posted = self.github.post_comment(repo, n, (
                f'**The queue runner stopped here for Stefan.** {line}\n\n{after}\n\n'
                f'{STOP_MARK}kind=decision issue={n} -->\n'))
            url = url or posted
        except Exception as e:
            self.say(f'{name}: recording the stop on the issue failed: {e}')
        self.say(f'{name}: a decision needs Stefan ({why})')
        if not url:
            return
        try:
            self.toaster.toast(f'{repo.name} #{n} needs you', f'{KINDS["decision"]}: {why}'[:250],
                               url, tag=f'{repo.name}-{n}-decision', button='Open')
        except Exception as e:
            self.say(f'{name}: the toast failed: {e}')

    def answers(self, repo) -> None:
        """Each filed stop Stefan has since answered (its issue closed, or a reply on the PR or
        on the issue after it) is recorded `answered`, and the PR goes back to the loop: after a
        reply, through a decision on it (`decisions.py`). A PR merged or closed on GitHub
        answers its stops too (`pr-closed`, issue #88), once their issues are closed."""
        for n in sorted({j.issue for j in self.jobs.jobs()
                         if j.kind == 'stop' and j.repo == repo.name}):
            stops = self.jobs.open_stops(repo.name, n)
            if not stops:
                continue
            try:
                closed = {u for u in {j.link for j in stops if j.link}
                          if self.github.issue_state(repo.github, number_of(u)) == 'closed'}
                gone = (self.github.pull(repo, n).state
                        if any(j.stop not in ON_MERGED for j in stops) else 'open')
                said = (self.github.issue_comments(repo, n)
                        + self.github.review_replies(repo, n))
                on_issue = {u: self.github.issue_comments(repo, number_of(u))
                            for u in {j.link for j in stops if j.link} - closed}
            except Exception as e:
                self.say(f'stop {repo.name}#{n}: reading its answer failed ({e}); next pass')
                continue
            if gone != 'open' and not self._close_for_pr(repo, n, gone, stops, closed):
                continue
            for j in stops:
                how = ('issue-closed' if j.link in closed else
                       PR_CLOSED if gone != 'open' and j.stop not in ON_MERGED else
                       'replied' if said_since(said + on_issue.get(j.link, []),
                                               utc(j.started_at)) else None)
                if how:
                    self.jobs.ended(j.id, exit_code=None, outcome='answered', link=j.link,
                                    reason=j.reason, answer=how)
                    self.say(f'stop {repo.name}#{n}: answered ('
                             + ('its issue was closed); the PR is back in the loop'
                                if how == 'issue-closed' else
                                f'the PR was {gone} outside the runner); nothing left to do'
                                if how == PR_CLOSED else
                                'a reply); a decision on the reply comes first'))

    def _close_for_pr(self, repo, n: int, state: str, stops, closed) -> bool:
        """Issue #88: the PR was merged or closed on GitHub while its stops were filed, so
        there's nothing left for Stefan to decide. Each of their `needs-info` issues still open
        gets a one-line note and is closed (completed for a merge, not planned for a close),
        except one a `live` or `live-todo` stop shares: that work is still Stefan's, and closing
        its issue would answer it. False when GitHub failed: the stops stay filed and the next
        pass tries again, and a note already posted isn't posted twice."""
        mark = f'{RUNNER_MARK}stop pr-closed pr={n} -->'
        live = {j.link for j in stops if j.stop in ON_MERGED}
        for u in sorted({j.link for j in stops if j.link and j.stop not in ON_MERGED}
                        - closed - live):
            i = number_of(u)
            try:
                if not any(mark in c.body for c in self.github.issue_comments(repo, i)):
                    self.github.post_comment(repo, i, (
                        f'PR #{n} was {state} outside the queue runner, so nothing here waits '
                        f'on Stefan any more: closing this.\n\n{mark}\n'))
                if state == 'merged':
                    self.github.close_completed(repo, i)
                else:
                    self.github.close_not_planned(repo, i)
            except Exception as e:
                self.say(f'stop {repo.name}#{n}: the PR was {state}, but closing {u} failed '
                         f'({e}); next pass')
                return False
        return True


def held(jobs, repo, n: int) -> str | None:
    """Why a PR is left alone for Stefan, or None: a stop he hasn't answered, his reply not yet
    decided on, his `hold`, or review 3 or later still blocking without his answer (no further
    review or fix round without it). `--release NAME#PR` lets every one of them go."""
    stops = jobs.open_stops(repo.name, n)
    if stops:
        last = stops[-1]
        return (f'stopped for Stefan ({KINDS.get(last.stop, last.stop).lower()}): left alone '
                f'until {last.link} is closed, he replies, or --release {repo.name}#{n}')
    decisions = jobs.on('decision', repo.name, n)
    if any(d.outcome == 'hold' for d in decisions):
        return f'Stefan said hold: left alone until --release {repo.name}#{n}'
    if undecided_replies(jobs, repo, n):
        return 'Stefan replied to a stop: a decision on his reply comes first'
    r = approach_review(jobs, repo, n)
    if r is None:
        return None
    note = next((s for s in jobs.on('stop', repo.name, n, r.sha)
                 if s.stop == 'approach-note' and s.outcome in ('filed', 'answered')), None)
    if note is None:   # another stop's answer doesn't count: the note goes to Stefan first
        return f'review {r.round} is still blocking: its Approach note goes to Stefan first'
    pos = positions(jobs)
    if note.answer == 'issue-closed' or any(
            pos[d.id] > pos[note.id] and d.outcome in ('fix', 'carry-on') for d in decisions):
        return None
    return (f'review {r.round} is still blocking: no further review or fix round without '
            "Stefan's answer (rework, fix on or hold)")


def positions(jobs) -> dict[str, int]:
    """Each job's place in the log: which came after which."""
    return {j.id: i for i, j in enumerate(jobs.jobs())}


def approach_review(jobs, repo, n: int):
    """The runner's newest review of the PR (any head, not released), if it's an approach note:
    review 3 or later still blocking."""
    reviews = [j for j in jobs.on('review', repo.name, n) if j.outcome in REVIEWED]
    return reviews[-1] if reviews and reviews[-1].outcome == 'approach-note' else None


def undecided_replies(jobs, repo, n: int) -> list:
    """Stops on the PR Stefan answered by a reply that no decision has read yet, oldest first.
    One reply may answer several stops: a decision on the PR after a stop reads it too."""
    pos = positions(jobs)
    read = [pos[d.id] for d in jobs.on('decision', repo.name, n, released=True)
            if d.question == 'reply' and d.outcome != 'not-started']
    return [s for s in jobs.on('stop', repo.name, n)
            if s.outcome == 'answered' and s.answer == 'replied'
            and not any(p > pos[s.id] for p in read)]


def conflict_rounds(jobs, repo_name: str, n: int) -> list:
    """The PR's conflict rounds that ran or are running (a release settles them), oldest
    first."""
    return [j for j in jobs.on('fix', repo_name, n)
            if j.cause == CONFLICT and j.outcome not in (NOT_STARTED, NOT_SENT)]


def rounds_counted(rounds: list) -> list:
    """The conflict rounds that count toward MAX_CONFLICT_ROUNDS: a job that picks up an
    earlier one (`about`: a usage limit's recovery, or a decision's retry or answer, in place or
    fresh) carries on that round, so it isn't another (Sol's review 1 of PR #101)."""
    ids = {j.id for j in rounds}
    return [j for j in rounds if j.about not in ids]


def rounds_on(jobs, repo_name: str, n: int, sha: str) -> list:
    """The PR's fix rounds of any cause on head H that ran or are running, oldest first."""
    return [j for j in jobs.on('fix', repo_name, n, sha)
            if j.outcome not in (NOT_STARTED, NOT_SENT)]


def conflict_stop(jobs, github, repo, pr) -> tuple[str, str | None] | None:
    """Why a conflict on the PR's head H is a stop for Stefan, (why, link), or None while
    another conflict round may still resolve it (issue #91). A stop only when one wouldn't help:
    the newest round on H (a conflict round, or an ordinary fix round that couldn't start) ended
    without resolving it; or the PR conflicts again with the same base commit its last conflict
    round merged in (`base`; a record without one counts as a different base), so that round's
    push didn't resolve it, read against the base branch's own tip (`github.branch_head`; a
    PR's base.sha is refreshed lazily, issue #189: reading it failing raises, so the PR waits
    for the next pass); or it had MAX_CONFLICT_ROUNDS conflict rounds since the last
    release (a continued round is the round it carries on: `rounds_counted`), as main keeps moving under it. A conflict after main moved, below that, gets
    another round. An ordinary round's `no-push` is its own `no-push` stop."""
    h7 = pr.head_sha[:7]
    rounds = conflict_rounds(jobs, repo.name, pr.number)
    on_h = [j for j in rounds_on(jobs, repo.name, pr.number, pr.head_sha) if not j.open]
    last = on_h[-1] if on_h else None
    if last and last.outcome in UNRESOLVED and (last.cause == CONFLICT
                                                or last.outcome != 'no-push'):
        what = 'conflict round' if last.cause == CONFLICT else 'fix round'
        return (f'it conflicts with {pr.base} at {h7}, and the {what} on {h7} '
                f"couldn't resolve it (it ended {last.outcome})", last.link)
    count = len(rounds_counted(rounds))
    if count >= MAX_CONFLICT_ROUNDS:
        return (f'{count} conflict rounds, {pr.base} keeps moving under it: it conflicts '
                f'again at {h7}', rounds[-1].link)
    earlier = [j for j in rounds if j.sha != pr.head_sha]
    if earlier and earlier[-1].base and earlier[-1].base == github.branch_head(repo, pr.base):
        prev = earlier[-1]
        return (f'it conflicts with {pr.base} again at {h7}, though the conflict round on '
                f'{prev.sha[:7]} merged {pr.base} at {prev.base[:7]} and {pr.base} has not moved '
                'since', prev.link)
    return None

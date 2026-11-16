"""The Sol lane: adopt every open PR without a review on its newest commit, wait for that commit's
checks, and have Sol review that exact head H (`~/Code/docs/pr-review.md`, A round, steps 1-3).

The verdict comes from Sol's sol-findings ledger (`ledger.decide`). The comment and verdict go to
the review's run folder, then `post.GitHubPoster` posts them on the PR (ticket 04); `DryRunPoster`
posts nothing (the live check). One Sol job at a time: each review holds `<state_dir>/sol.lock`.
A clean review merges (`merge.Merger`) once the PR is read again; each pass first merges any PR
still waiting at a head the runner found clean.

While Sol is out of usage, stops and merges go on, and a review runs as an Opus thread in T3
instead, through Claude's usage gate (`fallback.py`, issue #69); once Sol's reset has passed,
reviews go to Sol again. When config.toml's `[review] provider` is "claude" (issue #76), every
review runs as that Opus thread, and Sol's usage plays no part.
"""
import dataclasses
import datetime
import json
import os
from importlib import resources
from string import Template

from .config import Config, Repo, working
from .fallback import OPUS_KINDS, WHO, chosen, gate_label
from .github import Comment, PullRequest
from .ledger import TAGS, OPEN, SolFailed, decide, next_round, norm, read_reviews, runner_post, \
    state
from .lock import RunnerBusy, runner_lock
from .merge import Merger
from .picker import closed_issues
from .post import GitHubPoster, PostFailed
from .sol import SolOutOfUsage
from .state import FAILED_REVIEW, OUT_OF_USAGE, REVIEWED, JobLog, when
from .stops import Stopper, held
from .t3 import T3Error, find_job_thread

STARTED, BUSY, IDLE = 'started', 'busy', 'idle'   # as run.py's lane results
MAX_FAILED = 2   # failed reviews on one head before the lane leaves it until a release or a push
RESUME_AFTER = datetime.timedelta(minutes=10)    # after Sol's reset
RETRY_UNKNOWN = datetime.timedelta(minutes=30)   # when Sol didn't say when
# The job log's outcome for each of decide()'s.
OUTCOMES = {'merge': 'clean', 'fix': 'blocking', 'stop': 'stop', 'approach-note': 'approach-note'}


def ran(sol) -> dict:
    """The end record's thread fields for a review the Opus fallback ran (its thread, run and
    effort read back); nothing for Sol's."""
    return dict(getattr(sol, 'record', None) or {})


def review_title(repo: Repo, number: int) -> str:
    return f'Queue runner review: {repo.name}#{number}'


class DryRunPoster:
    """Posts nothing (the live check): the comment and verdict are already in the run folder."""

    def __init__(self, say):
        self.say = say

    def post(self, repo: Repo, pr: PullRequest, decision: dict, run_dir: str) -> None:
        self.say(f'dry run: {repo.name}#{pr.number} review comment, verdict and sol-review '
                 f'status not posted; they are in {run_dir}')
        return None


def _template() -> Template:
    return Template(resources.files(__package__).joinpath('templates/review.md')
                    .read_text(encoding='utf-8'))


def _said(c: Comment) -> str:
    on = f' on `{c.path}:{c.line}`' if c.path else ''
    return f'---\n**{c.author}**, {c.created_at}{on}:\n\n{(c.body or "").strip()}\n'


def _open_line(f: dict) -> str:
    at = (f"`{f['file']}:{f['line']}`" if f['file'] and f['line'] else
          f"`{f['file']}`" if f['file'] else 'no file')
    why = (f"Scenario: {f['scenario']}" if f['scenario'] else
           f"Cost: {f['cost']}" + (f" (rule: {f['rule']})" if f['rule'] else '')
           if f['cost'] else '')
    s = 'open' if f['status'] == 'open' else 'decline kept open'
    return (f"- **{f['id']}** · {TAGS[f['tag']]} · {f['class'] or 'no class'} · {at} · {s}, "
            f"raised in review {f['raised']}" + (f'\n  {why}' if why else ''))


def _read(path: str) -> str | None:
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            return f.read()
    except OSError:
        return None


def _write(path: str, text: str) -> None:
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def _tests(prepared) -> str:
    """Step 4 of the brief: what Sol can run here (ticket 16)."""
    said = ('In your review, name each command you ran and quote its summary line (for example '
            "`Tests  301 passed (310)`), and say which checks you couldn't run.")
    if prepared and prepared.ready:
        return ('Node is on PATH and ' + prepared.note + ", so run the repo's tests here: "
                '`npm test`, and the other `package.json` scripts the change touches that need '
                'no network (the network is off); not browser tests (Playwright has no browser '
                'here; CI runs them). To confirm a suspected bug, add a test that '
                'fails and run it. The workdir is a throwaway copy of H, deleted afterwards. '
                + said + " A failure the change doesn't explain (one that only happens on "
                'Windows, say) is no finding: say so. CI runs too, and still gates the merge.')
    lead = ('The workdir is a throwaway copy of H, deleted afterwards: you may write in it to '
            "run the repo's checks (the network is off). ")
    if prepared and prepared.note:
        lead += (prepared.note[0].upper() + prepared.note[1:]
                 + ", so its JavaScript tests can't run here: say so. ")
    return lead + said


class Reviewer:
    def __init__(self, config: Config, *, github, git, sol, jobs: JobLog, say,
                 now=datetime.datetime.now, poster=None, merger=None, toaster=None, deps=None,
                 fallback=None, t3=None):
        self.config, self.github, self.git, self.sol, self.jobs = config, github, git, sol, jobs
        # fallback.OpusFallback: who reviews while Sol is out of usage (issue #69), or every time
        # config.toml says Claude reviews (issue #76); None has Sol review and waits for Sol's
        # reset (the CLI's --review, the live checks, most tests), whatever config.toml says.
        self.fallback = fallback
        self._said_gate: str | None = None
        # The review this Reviewer runs now (its job id), so the Claude lane can tell it from a
        # dead runner's fallback review whose thread runs on (PR 67's review 2, F2).
        self.live: str | None = None
        self._said_running: set[str] = set()
        # deps.Deps: the checkout's node_modules from a cache, so Sol can run the tests (ticket
        # 16); None installs nothing (the tests, live_merge.py).
        self.deps = deps
        self.say, self.now = say, now
        self.poster = poster or GitHubPoster(github, say)
        # A dry-run poster (the live check) merges nothing either, unless given a merger.
        self.merger = merger if merger is not None or poster is not None else Merger(
            config, github=github, git=git, jobs=jobs, say=say, toaster=toaster, t3=t3)
        # Stops are filed with the real posts only: a dry-run poster files none.
        self.stopper = Stopper(config, github=github, jobs=jobs, say=say,
                               toaster=toaster) if poster is None else None
        self._last_why: dict[tuple[str, int], str | None] = {}
        self._said_paused = None
        self.titles: dict[tuple[str, int], str] = {}   # the PRs it reviewed (the snapshot's)
        self._said_kept: set[str] = set()   # checkouts moved aside that can't be deleted yet

    # --- a pass ---------------------------------------------------------------------------

    def review_pass(self) -> str:
        """Reviews the first PR that needs one, lowest number first in each repo. STARTED if a
        review ran (whatever its outcome), BUSY if another Sol job holds the lock, IDLE if none
        was needed, or none may start: Sol is out of usage and there's no fallback, or the usage
        gate holds the Opus review back. Stops and merges go on either way."""
        try:
            with runner_lock(self.config.state_dir, 'sol.lock'):
                self.settle()
                if self.stopper:   # first: a PR stopped now neither merges nor is reviewed
                    self.stopper.stop_pass(halted=self.lane_stopped)
                if self.merger and not self.lane_stopped():
                    self.merger.merge_pass(halted=self.lane_stopped)
                for repo in working(self.config):   # a repo Stefan stopped: none (ticket 37)
                    if not repo.github:
                        continue
                    if self.lane_stopped():   # Stop asked during a merge: nothing after it
                        return IDLE
                    for pr, why in self._candidates(repo):
                        self._note(repo, pr, why)
                        if why is None:
                            who = self._who(gate_label(repo.name, pr.number))
                            return IDLE if who is None else self.review(repo, pr, by=who)
                return IDLE
        except RunnerBusy:
            return BUSY

    def review_one(self, repo: Repo, number: int) -> tuple[str, str | None]:
        """Reviews one PR now if it needs it: (lane result, why not)."""
        with runner_lock(self.config.state_dir, 'sol.lock'):
            self.settle()
            pr = next((p for p in self.github.open_pulls(repo) if p.number == number), None)
            if pr is None:
                return IDLE, f'#{number} is not an open PR in {repo.github}'
            why = self.why_not(repo, pr)
            if why:
                return IDLE, why
            if (who := self._who(gate_label(repo.name, pr.number))) is None:
                if self._opus_always():
                    return IDLE, f'the Opus review waits: {self._said_gate}'
                return IDLE, (f'Sol is out of usage until {self.jobs.sol_resume_at()}'
                              + (f', and the Opus fallback waits: {self._said_gate}'
                                 if self._said_gate else ''))
            return self.review(repo, pr, by=who), None

    def settle(self) -> None:
        """A review left open was cut off with its runner (the caller holds sol.lock, so no
        live one is open): it counts as failed. An Opus review's thread (the fallback, or
        config.toml's) may run on in T3 (PR 67's review 2, F2): it's found by its title, and while it runs the job stays open
        (the Claude lane is busy meanwhile: `Runner.settle`); once it has ended the review
        counts as failed, with its thread, and the gate is told a Claude job ended. A Reviewer
        that can't read T3 (no fallback: `--review`) leaves such a review to the runner's."""
        for job in self.jobs.open_jobs():
            if job.kind != 'review':
                continue
            name = f'review {job.repo}#{job.issue}'
            thread = None
            if job.reviewer in OPUS_KINDS:
                if self.fallback is None:
                    continue
                repo = next((r for r in self.config.repos if r.name == job.repo), None)
                try:
                    thread = find_job_thread(self.fallback.t3, job, repo.path if repo else None)
                except T3Error as e:
                    if job.id not in self._said_running:
                        self.say(f"{name}: cut off with its runner; T3 can't say whether its "
                                 f'Opus thread runs on ({e}): left open until it can')
                        self._said_running.add(job.id)
                    continue
                if thread is not None and thread.active and not thread.pending_requests:
                    if job.id not in self._said_running:
                        self.say(f'{name}: cut off with its runner, but its Opus thread runs on '
                                 f'in {thread.link}: counted as failed once it ends')
                        self._said_running.add(job.id)
                    continue
            ran_on = {'thread_id': thread.thread_id, 'run_id': thread.latest_run_id}                 if thread else {}
            self.jobs.ended(job.id, exit_code=None, outcome=FAILED_REVIEW,
                            error='The runner stopped mid-review.', **ran_on)
            self._said_running.discard(job.id)
            if thread is not None:   # a Claude thread ran and has ended
                self.fallback.thread_ended(job.id)
            self.say(f'{name}: cut off with its runner; counted as failed')
        if self.merger:
            self.merger.settle()

    def candidates(self, repo: Repo) -> list[tuple[PullRequest, str | None]]:
        """Every open PR and why it isn't reviewed now (None: it would be)."""
        return list(self._candidates(repo))

    def _candidates(self, repo):
        for pr in sorted(self.github.open_pulls(repo), key=lambda p: p.number):
            try:
                why = self.why_not(repo, pr)
            except Exception as e:   # GitHub failing on one PR leaves the others to go on
                why = f'reading it failed ({type(e).__name__}: {e})'
            yield pr, why

    def _paused(self) -> bool:
        """Whether Sol is out of usage now (its newest review said so, and the reset it named
        hasn't passed): said once per resume time."""
        resume = self.jobs.sol_resume_at()
        if resume and self.now().astimezone() < when(resume):
            if self._said_paused != resume:
                self.say(f'Sol is out of usage: no Sol review starts before {resume}'
                         + ('; reviews go to the Opus fallback meanwhile, through the usage '
                            'gate' if self.fallback else ''))
                self._said_paused = resume
            return True
        return False

    def _opus_always(self) -> bool:
        """config.toml has Claude review every PR (issue #76), and this Reviewer can start one."""
        return self.fallback is not None and chosen(self.config)

    def _who(self, label: str):
        """Who reviews now: Sol (('sol', None)), an Opus thread (('fallback', the gate's verdict,
        or None with no gate)) when config.toml says Claude reviews or while Sol is out of usage,
        or None: Sol is out and there's no fallback, or the usage gate holds the Opus review back
        (said once, until that changes). An Opus review let in counts among the Claude jobs
        running (`label`, `fallback.gate_label`) until `review` ends it."""
        always = self._opus_always()
        if not always and not self._paused():
            self._said_gate = None
            return 'sol', None
        if self.fallback is None:
            return None
        verdict = self.fallback.check(label)
        if verdict is not None and not verdict.go:
            if verdict.text != self._said_gate:
                what = 'Opus review' if always else 'Opus fallback review'
                self.say(f'{what} waits: {verdict.text}')
            self._said_gate = verdict.text
            return None
        self._said_gate = None
        if verdict is not None:
            self.say(f'Usage gate: {verdict.text}')
        return 'fallback', verdict

    def _note(self, repo: Repo, pr: PullRequest, why: str | None) -> None:
        """Says why a PR is left alone, once, not every pass."""
        key = (repo.name, pr.number)
        if why and self._last_why.get(key) != why:
            self.say(f'review {repo.name}#{pr.number}: not now, {why}')
        self._last_why[key] = why

    def why_not(self, repo: Repo, pr: PullRequest) -> str | None:
        """Why this PR isn't reviewed now, or None if it is: cheapest checks first."""
        h, h7 = pr.head_sha, pr.head_sha[:7]
        # One writer per PR: a waiting build or fix writes again once Stefan answers it, so it's
        # left alone until that job ends or is released.
        if job := self.jobs.writer(repo.name, pr.branch):
            return (f'its {job.kind} waits for an answer, and may write to the branch again'
                    if job.outcome == 'waiting' else
                    f'its {job.kind} was cut off by a usage limit and resumes after '
                    f'{job.resume_at}' if job.outcome == 'usage-limit' else
                    f'a {job.kind} job is still writing to its branch')
        if why := held(self.jobs, repo, pr.number):
            return why
        if any(j.open and j.reviewer in OPUS_KINDS and j.id != self.live
               for j in self.jobs.on('review', repo.name, pr.number)):
            return ("a stopped runner's Opus fallback review of it runs on in T3: counted as "
                    'failed once it ends')
        done = self.jobs.reviews_of(repo.name, pr.number, h)
        if ran := [j for j in done if j.outcome in REVIEWED]:
            return (f'the runner reviewed {h7} already (review {ran[-1].round}, '
                    f'{ran[-1].outcome})')
        if (failed := sum(j.outcome == FAILED_REVIEW for j in done)) >= MAX_FAILED:
            return (f'{failed} failed reviews on {h7}: left until a new head or '
                    f'--release {repo.name}#{pr.number}')
        for r in read_reviews(self.github.issue_comments(repo, pr.number)):
            if r['sha'] and h.startswith(r['sha']):
                return f'review {r["round"]} is on {h7} already ({r["verdict"]})'
        checks = self.github.checks(repo, h)
        if checks.state == 'pending':
            return f'checks still running on {h7} ({", ".join(checks.pending)})'
        if checks.state == 'none':
            return f'no checks reported on {h7} yet'
        if checks.state == 'failed':
            return f'a check failed on {h7} ({", ".join(checks.failed)}): a stop for Stefan'
        if self.github.has_conflict(repo, pr.number):
            return f'it conflicts with {pr.base}: a conflict round (or a stop) comes first'
        return None

    # --- a review -------------------------------------------------------------------------

    def _said_moved(self, name: str, moved: str | None) -> None:
        if moved:
            self.say(f"{name}: git couldn't delete the checkout, so it was moved aside to {moved}")

    def _sweep(self) -> None:
        """Deletes the checkouts moved aside, where it can; says once of each it can't."""
        kept = set(self.git.sweep_stale(self.config.checkouts_dir))
        for folder in sorted(kept - self._said_kept):
            self.say(f"{folder} can't be deleted yet: Sol's sandbox user owns folders in it "
                     f"(AGENTS.md, Sol runs tests). Kept; the next review tries again.")
        self._said_kept = kept

    def review(self, repo: Repo, pr: PullRequest, by=('sol', None)) -> str:
        """Reviews H by Sol, or with `by` ('fallback', the gate's verdict) by Opus in a T3
        thread (`fallback.py`), which is posted the same way, naming its reviewer and why."""
        try:
            return self._started(repo, pr, by)
        finally:
            if by[0] == 'fallback':   # no longer among the Claude jobs running (`_who`)
                self.fallback.ended(gate_label(repo.name, pr.number))

    def _started(self, repo: Repo, pr: PullRequest, by) -> str:
        n, h = pr.number, pr.head_sha
        self.titles[(repo.name, n)] = pr.title
        earlier = read_reviews(self.github.issue_comments(repo, n))
        rnd = next_round(earlier)
        opus = by[0] == 'fallback'
        sol = self.fallback.thread(repo, review_title(repo, n)) if opus else self.sol
        job = self.jobs.started(kind='review', repo=repo.name, issue=n, branch=pr.branch,
                                title=review_title(repo, n), sha=h, round=rnd,
                                reviewer=sol.kind if opus else None)
        self.live = job.id
        try:
            return self._review(repo, pr, by, job, earlier, rnd, opus, sol)
        finally:
            self.live = None

    def _review(self, repo, pr, by, job, earlier, rnd, opus, sol) -> str:
        n, h = pr.number, pr.head_sha
        who = WHO[sol.kind] if opus else 'Sol'
        run_dir = os.path.join(self.config.runs_dir,
                               f'{repo.name}-pr{n}-r{rnd}-{self.now():%Y%m%d-%H%M%S}')
        os.makedirs(run_dir, exist_ok=True)
        wt = os.path.join(self.config.checkouts_dir, f'{repo.name}-pr{n}')
        name = f'review {repo.name}#{n}'
        ref = None
        try:
            ref, fetched = self.git.fetch_pr(repo.path, n, pr.base)
            if fetched != h:
                self.jobs.ended(job.id, exit_code=None, outcome='head-moved', run_dir=run_dir,
                                error=f'Listed at {h[:7]}, fetched at {fetched[:7]}.')
                self.say(f'{name}: the head moved from {h[:7]} to {fetched[:7]}; next pass')
                return IDLE
            os.makedirs(self.config.checkouts_dir, exist_ok=True)
            self._sweep()
            self._said_moved(name, self.git.checkout(repo.path, ref, wt))
            prepared = self.deps.prepare(repo.name, wt) if self.deps else None
            if prepared and prepared.how:
                self.say(f'{name}: dependencies {prepared.how}'
                         + ('' if prepared.ready else f': {prepared.note}'))
            last = earlier[-1]['sha'] if earlier else None
            gone = rnd > 1 and not (last and self.git.is_ancestor(repo.path, last, h))
            files = self._inputs(repo, pr, rnd, last, gone, earlier, run_dir, wt)
            guidelines = _read(os.path.join(wt, 'REVIEW.md'))
            brief = self._brief(repo, pr, rnd, last, gone, earlier, run_dir, wt, files,
                                guidelines, prepared)
            brief_path = os.path.join(run_dir, 'brief.md')
            _write(brief_path, brief)
            self.say(f'{name}: {who} reviews {h[:7]} (review {rnd}) in {run_dir}')
            reply = sol.review(brief_path, os.path.join(run_dir, 'reply.md'), wt,
                                    os.path.join(run_dir, 'run.out'),
                                    writable=list(prepared.writable) if prepared else [])
            d = decide(repo.github, n, h, rnd, earlier, guidelines is not None, reply, wt,
                       run_dir, gone, reviewer=sol.label if opus else None)
        except SolOutOfUsage as e:
            resume = (e.back + RESUME_AFTER) if e.back else self.now() + RETRY_UNKNOWN
            self.jobs.ended(job.id, exit_code=None, outcome=OUT_OF_USAGE, run_dir=run_dir,
                            error=str(e),
                            resume_at=resume.astimezone().isoformat(timespec='seconds'))
            self.say(f'{name}: {e}; the Sol lane waits until {resume:%Y-%m-%d %H:%M}')
            return STARTED
        except Exception as e:   # SolFailed, or git or GitHub failing around it
            error = str(e) if isinstance(e, SolFailed) else f'{type(e).__name__}: {e}'
            _write(os.path.join(run_dir, 'failed.txt'), error + '\n')
            self.jobs.ended(job.id, exit_code=None, outcome=FAILED_REVIEW, run_dir=run_dir,
                            error=error, **ran(sol))
            self.say(f'{name}: review failed, nothing counts: {error}')
            return STARTED
        finally:
            self._said_moved(name, self.git.remove_checkout(repo.path, wt, ref))
            if opus and sol.ran:   # a thread ran: what it cost teaches the gate (as run.py's)
                self.fallback.measured([job.id], by[1], gate_label(repo.name, n))

        _write(os.path.join(run_dir, 'comment.md'), d['body'])
        _write(os.path.join(run_dir, 'decision.json'), json.dumps({
            'repo': repo.github, 'pr': n, 'round': rnd, 'sha': h, 'verdict': d['verdict'],
            'outcome': d['outcome'], 'signals': d['signals'], 'status': d['status'],
            'kept': d['kept'], 'unaddressed': d['unaddressed'],
            'issues': [{'id': i['id'], 'title': i['title']} for i in d['issues']],
            'findings': d['findings'], 'reviewer': d['reviewer']}, indent=2,
            ensure_ascii=False) + '\n')
        try:
            url = self.poster.post(repo, pr, d, run_dir)
        except PostFailed as e:   # nothing on the PR, so nothing counts: reviewed again later
            _write(os.path.join(run_dir, 'failed.txt'), f'{e}\n')
            self.jobs.ended(job.id, exit_code=None, outcome=FAILED_REVIEW, run_dir=run_dir,
                            verdict=d['verdict'], error=str(e), **ran(sol))
            self.say(f'{name}: review {rnd} on {h[:7]} was {d["verdict"]} but not posted, '
                     f'so it failed: {e}')
            return STARTED
        outcome = OUTCOMES[d['outcome']]
        self.jobs.ended(job.id, exit_code=None, outcome=outcome, verdict=d['verdict'],
                        signals=[s['signal'] for s in d['signals']], run_dir=run_dir, link=url,
                        **ran(sol))
        why = f' ({"; ".join(s["text"] for s in d["signals"])})' if d['signals'] else ''
        by_ = f' by {d["reviewer"]}' if d['reviewer'] else ''
        self.say(f'{name}: review {rnd} on {h[:7]} is {d["verdict"]}{by_}, next: '
                 f'{d["outcome"]}{why}')
        if self.stopped_now(repo):   # the review was the job: what follows waits for Resume
            what = repo.name if repo.name in self._repo_stops() else 'the reviewing lane'
            self.say(f'{name}: {what} was stopped during the review; '
                     + ('its merge' if outcome == 'clean' else 'what follows')
                     + ' waits until Stefan resumes it')
        elif outcome == 'clean' and self.merger:
            self.merger.try_merge(repo, pr)
        elif outcome in ('stop', 'approach-note') and self.stopper:
            self.stopper.check(repo, pr)
        return STARTED

    def stopped_now(self, repo: Repo) -> bool:
        """Whether Stefan has stopped the repo (ticket 37) or the reviewing lane (ticket 30), or
        control.json is unreadable, read now: a review running when he stopped it finishes, and
        nothing after it happens."""
        from . import control
        from .config import stopped
        switch = control.read(self.config.state_dir)
        return (repo.name in stopped(self.config) or switch.holds('sol')
                or switch.repo_stop(repo.name).stopped)

    def _repo_stops(self) -> set:
        from . import control
        from .config import stopped
        switch = control.read(self.config.state_dir)
        return stopped(self.config) | {n for n, s in switch.repos.items() if s.stopped}

    def lane_stopped(self) -> bool:
        """Whether the reviewing lane may start nothing now (control.json read now: Stefan's
        Stop, or the file unreadable): asked between its jobs, so the merge or review running
        finishes and nothing starts after it (ticket 30)."""
        from . import control
        return control.read(self.config.state_dir).holds('sol')

    def _inputs(self, repo, pr, rnd, last, gone, earlier, run_dir, wt) -> list[str]:
        """Writes Sol's inputs to the run folder; returns the brief's list of them."""
        h, path = pr.head_sha, repo.path
        full = self.git.diff(path, f'origin/{pr.base}', h, merge_base=True)
        if rnd > 1 and not gone:
            _write(os.path.join(run_dir, 'change.diff'), self.git.diff(path, last, h))
            _write(os.path.join(run_dir, 'full.diff'), full)
            files = [f'`change.diff`: the change since your last review, {last[:7]}..{h[:7]}',
                     f"`full.diff`: the PR's whole diff against `{pr.base}`, for context"]
        else:
            _write(os.path.join(run_dir, 'change.diff'), full)
            files = [f"`change.diff`: the PR's whole diff against `{pr.base}`"
                     + (' (the commit you last reviewed is gone)' if gone else '')]
        _write(os.path.join(run_dir, 'pr.md'),
               f'# PR #{pr.number}: {pr.title}\n\nMerges `{pr.branch}` into `{pr.base}`; head '
               f'{h}.\n\n{pr.body}\n')
        files.append("`pr.md`: the PR's description")
        here = repo.github.lower()
        for where, k in closed_issues(pr.body, here):
            issue = self.github.issue(where, k)
            comments = self.github.issue_comments(dataclasses.replace(repo, github=where), k)
            name = f'#{k}' if where == here else f'{where}#{k}'
            text = f'# Issue {name}: {issue.title}\n\n{issue.body}\n\n## Comments\n\n' + (
                ''.join(_said(c) for c in comments) or 'None.\n')
            # A GitHub owner name has no `_`, so owner_name keeps the two apart: a-b/c and a/b-c
            # don't share a file.
            file = (f'issue-{k}.md' if where == here else
                    f'issue-{where.replace("/", "_")}-{k}.md')
            _write(os.path.join(run_dir, file), text)
            files.append(f'`{file}`: the issue it closes (the ticket), with its comments')
        said = self._conversation(repo, pr)
        if said:
            _write(os.path.join(run_dir, 'conversation.md'),
                   f'# PR #{pr.number}: everything said on it so far\n\n'
                   + ''.join(_said(c) for c in said))
            files.append("`conversation.md`: the PR's comments, review threads and review "
                         'bodies so far, earlier Sol reviews and their ledgers included')
        if os.path.isfile(os.path.join(wt, 'AGENTS.md')):
            files.append("`AGENTS.md` in this workdir: the repo's rules; read it first, and the "
                         'docs it points to for what the PR touches')
        return files

    def _conversation(self, repo, pr) -> list[Comment]:
        said = self.github.issue_comments(repo, pr.number) + self.github.review_replies(
            repo, pr.number)
        return sorted(said, key=lambda c: c.created_at)

    def _brief(self, repo, pr, rnd, last, gone, earlier, run_dir, wt, files, guidelines,
               prepared=None) -> str:
        prior = state(earlier)
        again = guide = ''
        if rnd > 1:
            scope = (f"The commit you last reviewed{f', {last[:7]},' if last else ''} isn't in "
                     "this branch's history any more (a force-push), so `change.diff` is the "
                     "PR's whole diff: review all of it. Your comment will say so."
                     if gone else
                     f'You last reviewed {last[:7]}. `change.diff` is the change since then: '
                     "review only that. `full.diff` is the PR's whole diff: read it, and the rest "
                     'of the checkout, only to understand the change. (If the base was merged in '
                     "since, `change.diff` has its changes too; review only the PR's own.)")
            used = ', '.join(f['id'] for f in prior) or 'none'
            classes = list(dict.fromkeys(f['class'] for f in prior if norm(f['class'])))
            named = ('; '.join(f'"{c}"' for c in classes) + '. When a new finding is the same '
                     'kind of problem as one of these, give it that class name, word for word, '
                     'so a kind that keeps coming back can be seen' if classes else 'none')
            again = (f'5. **This is review {rnd}.** {scope}\n'
                     '6. **Your earlier findings.** Each one still open is listed below, with the '
                     'replies posted on the PR since your last review. Give every one a status in '
                     "the block's `earlier` list: `fixed`, `open` (still open), "
                     '`decline-accepted` or `decline-kept`. A decline is a reply that names the '
                     "finding's ID, gives the reason, and attaches the evidence (the test that "
                     "wouldn't fail). You get one reply on each: accept it, or keep it open and "
                     "say in your review what it misses. Repeat nothing already posted: an open "
                     "finding's status covers it, so don't list it again in `findings`. If a "
                     'finding that was closed comes back, list it in `findings` with its old ID. '
                     "Give a new finding an ID not used before (used so far: " + used + ').\n'
                     f'7. **Classes raised so far:** {named}.\n')
        if guidelines is not None:
            guide = ("\n## This repo's review guidelines (`REVIEW.md`)\n\nThey decide what counts "
                     'as Important here, what never to report and what to always check.\n\n'
                     f'{guidelines.strip()}\n')
        if rnd > 1:
            after = earlier[-1]['at']
            since = [c for c in self._conversation(repo, pr)
                     if c.created_at > after and not runner_post(c.body)]
            open_ = [f for f in prior if f['status'] in OPEN]
            guide += ('\n## Your open findings\n\n' + ('\n'.join(map(_open_line, open_))
                                                        or 'None.') + '\n'
                      '\n## Replies on the PR since your last review\n\n'
                      + (''.join(map(_said, since)) or 'None.\n'))
        if guide:
            guide += '\n## Your reply\n'
        has_agents = os.path.isfile(os.path.join(wt, 'AGENTS.md'))
        return _template().substitute(
            number=pr.number, title=pr.title, github=repo.github, sha=pr.head_sha,
            sha7=pr.head_sha[:7], branch=pr.branch, base=pr.base,
            rundir=run_dir.replace('\\', '/'), files='\n'.join(f'- {f}' for f in files),
            agents='`AGENTS.md`' if has_agents else 'conventions (it has no `AGENTS.md`)',
            tests=_tests(prepared), again=again, guide=guide, new='new ' if rnd > 1 else '',
            statuses=(', and a status for each earlier open finding in `earlier`'
                      if rnd > 1 else ''),
            next_id=f'F{len(prior) + 1}',
            example=', "earlier": [{"id": "F1", "status": "fixed"}]' if rnd > 1 else '',
            open_scope=', new or earlier' if rnd > 1 else '')

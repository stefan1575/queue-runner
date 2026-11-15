"""Merging a clean PR (ticket 05; `~/Code/docs/pr-review.md`, Merge), in the Sol lane.

A PR is merged once the runner's own newest review of its head H is `clean` (decide()'s `merge`
outcome; a clean review that stops for Stefan is `stop`, not `clean`). Just before merging, the
PR is read again: still open at H, not a draft, its newest review comment the clean one on H,
checks passed on H (`sol-review` not counted), no conflict, nothing said on it since that review
and no unresolved review thread, and no Claude job writing to its branch. Then it merges with the
expected head, so GitHub refuses if H moved in between, with a merge commit (Lovable syncs main).
A head that moved is left to the Sol lane, which reviews the new one. After the merge, the
worktrees of the PR's build and fix jobs are removed. The repo's live steps run later, in
the Claude lane (`live.py`).

A repo whose `config.toml` entry says `merge = "stefan"` (leads-dashboard, ticket 17) isn't merged
by the runner: once the same re-check passes, the PR is marked ready for Stefan instead, once per
head: the `ready-for-stefan` label and a toast that opens the PR (a `ready` job, `marked`). The
mark comes off (`unmarked`, the label removed) when the head moves or the re-check no longer
passes (a stop, a reply, a failed check...), so a new head is reviewed before it's ready again. When a marked PR is no
longer open, the next pass reads it: merged by Stefan, it gets a `merge` job `merged` and its
worktrees go, as after the runner's own merge; closed unmerged, the mark and the label come off. The live steps
read his merge from git as usual (`live.py`).

Merges are automated posts that need no go-ahead (`~/Code/global/CLAUDE.md`, Merge when the review is
clean).
"""
from .fix import fix_branch
from .ledger import newest_on, said_since
from .stops import held
from .state import JobLog
from .toast import NoToaster

MAX_FAILED = 2   # failed merges on one head before the runner leaves it until a release or a push
READY = 'ready-for-stefan'   # the label on a PR ready for Stefan to merge (merge = "stefan")


def merge_title(repo, number: int) -> str:
    return f'Queue runner merge: {repo.name}#{number}'


class Merger:
    def __init__(self, config, *, github, git, jobs: JobLog, say, toaster=None):
        self.config, self.github, self.git, self.jobs, self.say = config, github, git, jobs, say
        self.toaster = toaster or NoToaster()
        self._last_why: dict[tuple, str | None] = {}

    # --- which PRs ------------------------------------------------------------------------

    def clean_on_head(self, repo, pr) -> bool:
        """The runner's newest review of the PR's head says merge. Release doesn't undo it: the
        review stands on GitHub."""
        review = self.jobs.runner_review(repo.name, pr.number, pr.head_sha)
        return review is not None and review.outcome == 'clean' and not any(
            j.outcome == 'merged' for j in self.jobs.on('merge', repo.name, pr.number,
                                                         pr.head_sha))

    def candidates(self, repo):
        """Each open PR the runner would merge, and why not now (None: it would merge)."""
        for pr in sorted(self.github.open_pulls(repo), key=lambda p: p.number):
            if self.clean_on_head(repo, pr):
                try:
                    why = self.why_not(repo, pr.number, pr.head_sha)
                except Exception as e:
                    why = f'reading it failed ({type(e).__name__}: {e})'
                yield pr, why

    def why_not(self, repo, n: int, h: str, checks: bool = True) -> str | None:
        """The pre-merge re-check, read afresh: why the PR doesn't merge at H now, or None.
        Without `checks`, its checks aren't looked at (live.py: would it merge once they pass?)."""
        h7 = h[:7]
        pr = self.github.pull(repo, n)
        if pr.state != 'open':
            return f'it is {pr.state}'
        if pr.head_sha != h:
            return f'the head moved from {h7} to {pr.head_sha[:7]}: Sol reviews that first'
        if pr.draft:
            return 'it is a draft'
        if job := self.jobs.writer(repo.name, pr.branch):
            return f'a {job.kind} job is writing to {pr.branch}'
        # Stefan may merge while a live run is open: his merge goes in the next batch.
        if not repo.stefan_merges and (
                live := next((j for j in self.jobs.live(repo.name) if j.open), None)):
            return (f'the live run {live.id} is bringing {repo.base} live: merges wait for it, '
                    'so its batch stays the one it was given')
        if why := held(self.jobs, repo, n):
            return why
        if (failed := sum(j.outcome == 'failed' for j in self.jobs.on('merge', repo.name, n, h))) \
                >= MAX_FAILED:
            return f'{failed} merges failed on {h7}: left until a new head or --release'
        comments = self.github.issue_comments(repo, n)
        if not (last := newest_on(comments, h, 'clean')):
            return f'its newest review comment is not a clean review of {h7}'
        checks = self.github.checks(repo, h) if checks else None
        if checks and checks.state != 'passed':
            more = ', '.join(checks.failed or checks.pending)
            return f'checks on {h7} are {checks.state}' + (f' ({more})' if more else '')
        if pr.mergeable is False:
            return f'it conflicts with {pr.base}'
        if said := said_since(comments + self.github.review_replies(repo, n), last['at']):
            who = ', '.join(dict.fromkeys(c.author for c in said))
            return (f'{len(said)} repl{"y" if len(said) == 1 else "ies"} since the clean review '
                    f'({who}): Stefan reads {"it" if len(said) == 1 else "them"} first')
        if threads := self.github.open_threads(repo, n):
            return f'{threads} unresolved review thread{"s" * (threads != 1)}'
        return None

    # --- merging --------------------------------------------------------------------------

    def merge_pass(self) -> None:
        for repo in self.config.repos:
            if not repo.github:
                continue
            try:
                if repo.stefan_merges:
                    self.stefan_pass(repo)
                found = list(self.candidates(repo))
            except Exception as e:   # GitHub down: the next pass tries again
                self.say(f'merge pass on {repo.name} failed: {type(e).__name__}: {e}')
                continue
            for pr, why in found:
                self._merge(repo, pr, why)

    def try_merge(self, repo, pr) -> str | None:
        """Right after a clean review: merges now if the re-check passes."""
        try:
            why = self.why_not(repo, pr.number, pr.head_sha)
        except Exception as e:
            why = f'reading it failed ({type(e).__name__}: {e})'
        return self._merge(repo, pr, why)

    def _merge(self, repo, pr, why) -> str | None:
        n, h, name = pr.number, pr.head_sha, f'merge {repo.name}#{pr.number}'
        key = (repo.name, n)
        if why:
            if self._last_why.get(key) != why:
                self.say(f'{name}: not now, {why}')
            self._last_why[key] = why
            return None
        self._last_why.pop(key, None)
        if repo.stefan_merges:
            return self._mark_ready(repo, pr)
        job = self.jobs.started(kind='merge', repo=repo.name, issue=n, branch=pr.branch,
                                title=merge_title(repo, n), sha=h)
        try:
            merged = self.github.merge(repo, n, h)
        except Exception as e:
            error = f'{type(e).__name__}: {e}'
            try:
                now = self.github.pull(repo, n).head_sha
            except Exception:
                now = None
            if now and now != h:
                self.jobs.ended(job.id, exit_code=None, outcome='head-moved', error=error)
                self.say(f'{name}: the head moved from {h[:7]} to {now[:7]} before the merge; '
                         'Sol reviews the new head')
                return 'head-moved'
            self.jobs.ended(job.id, exit_code=None, outcome='failed', error=error)
            self.say(f'{name}: merge at {h[:7]} failed: {error}')
            return 'failed'
        self.jobs.ended(job.id, exit_code=None, outcome='merged', head=merged or None)
        self.say(f'{name}: merged at {h[:7]}' + (f' (merge commit {merged[:7]})' if merged else ''))
        self.remove_worktrees(repo, pr)
        return 'merged'

    # --- Stefan merges (merge = "stefan", ticket 17) ----------------------------------------

    def mark(self, repo, n: int):
        """The PR's newest `ready` job (any head), or None."""
        marks = self.jobs.on('ready', repo.name, n, released=True)
        return marks[-1] if marks else None

    def ready(self, repo, pr) -> bool:
        """Marked ready for Stefan on its head now."""
        last = self.mark(repo, pr.number)
        return bool(last and last.outcome == 'marked' and last.sha == pr.head_sha)

    def _ready_job(self, repo, n: int, branch, sha: str):
        return self.jobs.started(kind='ready', repo=repo.name, issue=n, branch=branch,
                                 title=f'Queue runner ready: {repo.name}#{n}', sha=sha)

    def _mark_ready(self, repo, pr) -> str:
        """Labels the PR ready for Stefan and toasts, once per head (again only after the mark
        came off). 'ready', or 'failed' if the label couldn't be added (the next pass tries)."""
        n, h, name = pr.number, pr.head_sha, f'ready {repo.name}#{pr.number}'
        if self.ready(repo, pr):
            return 'ready'
        job = self._ready_job(repo, n, pr.branch, h)
        try:
            if READY not in pr.labels:
                self.github.add_label(repo, n, READY)
        except Exception as e:
            error = f'{type(e).__name__}: {e}'
            self.jobs.ended(job.id, exit_code=None, outcome='failed', error=error)
            self.say(f'{name}: labelling it {READY} failed ({error}); next pass')
            return 'failed'
        self.jobs.ended(job.id, exit_code=None, outcome='marked')
        self.say(f'{name}: clean at {h[:7]} with its checks passed: labelled {READY}, for '
                 'Stefan to merge')
        done = f"Sol's review is clean on {h[:7]} and its checks passed."
        try:
            self.toaster.toast(f'{repo.name} PR #{n} is ready to merge',
                               (f'{pr.title}: {done}' if pr.title else done)[:250],
                               pr.url or f'https://github.com/{repo.github}/pull/{n}',
                               tag=f'{repo.name}-{n}-ready', button='Open the PR')
        except Exception as e:
            self.say(f'{name}: the toast failed: {e}')
        return 'ready'

    def stefan_pass(self, repo) -> None:
        """Marks come off PRs the merge re-check no longer passes; a marked PR gone from the open list
        is read: Stefan merged it, or it was closed."""
        prs = self.github.open_pulls(repo)
        for pr in prs:
            last = self.mark(repo, pr.number)
            if not (last and last.outcome == 'marked'):
                continue
            if pr.head_sha != last.sha:
                why = (f'the head moved from {last.sha[:7]} to {pr.head_sha[:7]}: Sol reviews '
                       'it first')
            elif not self.clean_on_head(repo, pr):
                why = f'its review of {pr.head_sha[:7]} is no longer clean'
            else:   # the merge re-check again: a stop, a reply, a failed check...
                why = self.why_not(repo, pr.number, pr.head_sha)
            if why:
                self._unmark(repo, pr, last, why)
        listed = {p.number for p in prs}
        for n in sorted({j.issue for j in self.jobs.jobs()
                         if j.kind == 'ready' and j.repo == repo.name} - listed):
            last = self.mark(repo, n)
            if last and last.outcome == 'marked' and not any(
                    j.outcome == 'merged' for j in self.jobs.on('merge', repo.name, n,
                                                                released=True)):
                self._gone(repo, n, last)

    def _unmark(self, repo, pr, last, why: str) -> None:
        n, key = pr.number, (repo.name, pr.number, 'unmark')
        try:
            if READY in pr.labels:
                self.github.remove_label(repo, n, READY)
        except Exception as e:   # left marked: the next pass tries again
            if self._last_why.get(key) != str(e):
                self.say(f'ready {repo.name}#{n}: no longer ready ({why}), but removing '
                         f'{READY} failed ({type(e).__name__}: {e}); next pass')
            self._last_why[key] = str(e)
            return
        self._last_why.pop(key, None)
        job = self._ready_job(repo, n, pr.branch, last.sha)
        self.jobs.ended(job.id, exit_code=None, outcome='unmarked', reason=why)
        self.say(f'ready {repo.name}#{n}: no longer ready for Stefan ({why}); {READY} removed')

    def _gone(self, repo, n: int, last) -> None:
        """A marked PR no longer open: Stefan's merge is recorded and its worktrees removed, or
        a PR closed unmerged loses its mark."""
        pr = self.github.pull(repo, n)
        if pr.state == 'merged':
            job = self.jobs.started(kind='merge', repo=repo.name, issue=n, branch=pr.branch,
                                    title=merge_title(repo, n), sha=last.sha)
            self.jobs.ended(job.id, exit_code=None, outcome='merged', reason='Stefan merged it')
            self.say(f'merge {repo.name}#{n}: Stefan merged it'
                     + ('' if pr.head_sha == last.sha else
                        f' (at {pr.head_sha[:7]}, not {last.sha[:7]}, which was ready)')
                     + '; its live steps follow')
            if READY in pr.labels:
                try:
                    self.github.remove_label(repo, n, READY)
                except Exception as e:
                    self.say(f'merge {repo.name}#{n}: removing {READY} failed: {e}')
            self.remove_worktrees(repo, pr)
        elif pr.state == 'closed':   # its label goes too, so a reopened PR isn't left ready
            self._unmark(repo, pr, last, 'closed without merging')

    def remove_worktrees(self, repo, pr) -> None:
        """The worktrees and local branches of the PR's build and fix jobs, once it merged."""
        for j in [j for j in self.jobs.pr_jobs(repo.name, pr.number, pr.branch)
                  if j.worktree]:
            branch = j.branch if j.kind == 'build' else fix_branch(pr.number, j.sha or '')
            try:
                gone = self.git.remove_worktree(repo.path, j.worktree, branch)
            except Exception as e:
                gone, why = False, f' ({type(e).__name__}: {e})'
            else:
                why = ''
            self.say(f'merge {repo.name}#{pr.number}: {j.kind} worktree {j.worktree} '
                     + ('removed' if gone else f'not removed{why}; remove it by hand'))

    def settle(self) -> None:
        """A merge left open was cut off with its runner: GitHub says whether it merged."""
        for job in self.jobs.open_jobs():
            if job.kind != 'merge':
                continue
            repo = next((r for r in self.config.repos if r.name == job.repo), None)
            try:
                pr = self.github.pull(repo, job.issue)
            except Exception as e:
                self.say(f'merge {job.repo}#{job.issue}: cut off with its runner, and GitHub '
                         f"can't say whether it merged ({e}); next pass")
                continue
            merged = pr.state == 'merged'
            self.jobs.ended(job.id, exit_code=None, outcome='merged' if merged else 'failed',
                            error=None if merged else 'The runner stopped mid-merge.')
            self.say(f'merge {job.repo}#{job.issue}: cut off with its runner; '
                     + ('it merged' if merged else 'it did not merge'))
            if merged:
                self.remove_worktrees(repo, pr)

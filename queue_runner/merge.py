"""Merging a clean PR (ticket 05; `~/.claude/docs/pr-review.md`, Merge), in the Sol lane.

A PR is merged once the runner's own newest review of its head H is `clean` (decide()'s `merge`
outcome; a clean review that stops for Stefan is `stop`, not `clean`). Just before merging, the
PR is read again: still open at H, not a draft, its newest review comment the clean one on H,
checks passed on H (`sol-review` not counted), no conflict, nothing said on it since that review
and no unresolved review thread, and no Claude job writing to its branch. Then it merges with the
expected head, so GitHub refuses if H moved in between, with a merge commit (Lovable syncs main).
A head that moved is left to the Sol lane, which reviews the new one. After the merge, the
worktrees of the PR's build and fix jobs are removed. The repo's live steps are ticket 11's.

Merges are automated posts that need no go-ahead (`~/.claude/CLAUDE.md`, Merge when the review is
clean).
"""
from .fix import fix_branch
from .github import OLD_LABELS
from .ledger import newest_on, said_since
from .stops import held
from .state import JobLog

MAX_FAILED = 2   # failed merges on one head before the runner leaves it until a release or a push


def merge_title(repo, number: int) -> str:
    return f'Queue runner merge: {repo.name}#{number}'


class Merger:
    def __init__(self, config, *, github, git, jobs: JobLog, say):
        self.config, self.github, self.git, self.jobs, self.say = config, github, git, jobs, say
        self._last_why: dict[tuple[str, int], str | None] = {}

    # --- which PRs ------------------------------------------------------------------------

    def clean_on_head(self, repo, pr) -> bool:
        """The runner's newest review of the PR's head says merge. Release doesn't undo it: the
        review stands on GitHub."""
        if any(lb in OLD_LABELS for lb in pr.labels):
            return False
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

    def why_not(self, repo, n: int, h: str) -> str | None:
        """The pre-merge re-check, read afresh: why the PR doesn't merge at H now, or None."""
        h7 = h[:7]
        pr = self.github.pull(repo, n)
        if pr.state != 'open':
            return f'it is {pr.state}'
        if pr.head_sha != h:
            return f'the head moved from {h7} to {pr.head_sha[:7]}: Sol reviews that first'
        if old := [lb for lb in pr.labels if lb in OLD_LABELS]:
            return f'labelled {old[0]}: the old sol-pr-review.py has it until the cutover'
        if pr.draft:
            return 'it is a draft'
        if job := self.jobs.writer(repo.name, pr.branch):
            return f'a {job.kind} job is writing to {pr.branch}'
        if why := held(self.jobs, repo, n):
            return why
        if (failed := sum(j.outcome == 'failed' for j in self.jobs.on('merge', repo.name, n, h))) \
                >= MAX_FAILED:
            return f'{failed} merges failed on {h7}: left until a new head or --release'
        comments = self.github.issue_comments(repo, n)
        if not (last := newest_on(comments, h, 'clean')):
            return f'its newest review comment is not a clean review of {h7}'
        checks = self.github.checks(repo, h)
        if checks.state != 'passed':
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

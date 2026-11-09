"""A fix round on a blocking PR (ticket 05; `~/.claude/docs/pr-review.md`, A round, step 5), in
the Claude lane.

A PR gets a fix round when the runner's own newest review of its head H is `blocking` (decide()'s
`fix` outcome; a stop or an approach note goes to Stefan instead) and that review is still the
PR's newest review comment. One round per head: once a round on H has ended, H gets no other,
whatever its outcome, until a `--release`. A round that pushes moves the head, and the Sol lane
reviews the new one; a round that ends without pushing leaves the PR at H, which was reviewed
already, so it waits for Stefan.

The brief is built from sources, never a handoff file: the findings, classes and earlier declines
from the ledger in the PR's newest review comment, the branch's commits and the files it changes
from git, and the earlier threads' links from the job log, as T3 gave them.
"""
from importlib import resources
from string import Template

from .brief import _agents_pointer
from .github import OLD_LABELS
from .ledger import OPEN, STATUSES, newest_on, norm, read_reviews, state
from .picker import closed_issues
from .state import NOT_SENT, NOT_STARTED, JobLog
from .stops import held, positions


def fix_branch(number: int, sha: str) -> str:
    """The local branch a fix round's T3 worktree is made on, from H. It never goes to origin:
    the round pushes to the PR's own branch."""
    return f'claude/fix-pr{number}-{sha[:7]}'


def fix_title(repo, number: int) -> str:
    return f'Queue runner fix: {repo.name}#{number}'


def _template() -> Template:
    return Template(resources.files(__package__).joinpath('templates/fix.md')
                    .read_text(encoding='utf-8'))


class Fixer:
    def __init__(self, config, *, github, git, jobs: JobLog):
        self.config, self.github, self.git, self.jobs = config, github, git, jobs

    def order(self, repo, pr):
        """A decision that ordered a fix round on the PR's head H (Stefan's `rework` or `fix on`,
        or a decision thread's `fix`), unless a release settled it: the newest, or None."""
        found = [d for d in self.jobs.on('decision', repo.name, pr.number, pr.head_sha)
                 if d.outcome == 'fix']
        return found[-1] if found else None

    def review_to_fix(self, repo, pr):
        """The runner's newest review of the PR's head, if it says fix, or if it stopped and a
        decision ordered a fix round since: else None."""
        if any(lb in OLD_LABELS for lb in pr.labels):
            return None
        review = self.jobs.runner_review(repo.name, pr.number, pr.head_sha)
        if review and (review.outcome == 'blocking' or (
                review.outcome in ('stop', 'approach-note') and self.order(repo, pr))):
            return review
        return None

    def why_not(self, repo, pr) -> str | None:
        """Why a PR whose head the runner found blocking gets no fix round now, or None."""
        h7 = pr.head_sha[:7]
        done = [j for j in self.jobs.on('fix', repo.name, pr.number, pr.head_sha)
                if j.outcome not in (NOT_STARTED, NOT_SENT)]   # no thread ran: try again
        if order := self.order(repo, pr):   # one more round on H, ordered after the last
            pos = positions(self.jobs)
            done = [j for j in done if pos[j.id] > pos[order.id]]
        if done:
            last = done[-1]
            if last.open:
                return 'its fix round is still running'
            if last.outcome == 'waiting':
                return 'its fix round waits for an answer'
            return (f'a fix round on {h7} ended {last.outcome} and the head is still {h7}: '
                    f'left for Stefan (or --release {repo.name}#{pr.number})')
        if job := self.jobs.writer(repo.name, pr.branch):
            return f'a {job.kind} job is writing to {pr.branch}'
        if why := held(self.jobs, repo, pr.number):
            return why
        if not newest_on(self.github.issue_comments(repo, pr.number), pr.head_sha, 'blocking'):
            return f'its newest review comment is not the blocking review of {h7}'
        return None

    def candidates(self, repo):
        """(PR, its blocking review job, why not now) for each open PR the runner found
        blocking, lowest number first."""
        for pr in sorted(self.github.open_pulls(repo), key=lambda p: p.number):
            review = self.review_to_fix(repo, pr)
            if review is None:
                continue
            try:
                why = self.why_not(repo, pr)
            except Exception as e:
                why = f'reading it failed ({type(e).__name__}: {e})'
            yield pr, review, why

    def brief(self, repo, pr, review) -> str:
        """The fix brief. Git must have H and `origin/<base>` (`fetch_pr`)."""
        from .review import _open_line
        h = pr.head_sha
        found = state(read_reviews(self.github.issue_comments(repo, pr.number)))
        important = [f for f in found if f['tag'] == 'important' and f['status'] in OPEN]
        nits = [f for f in found if f['tag'] == 'nit' and f['status'] in OPEN]
        settled = [f for f in found if f['status'] in ('fixed', 'decline-accepted')]
        classes = list(dict.fromkeys(f['class'] for f in important if norm(f['class'])))
        commits = self.git.log(repo.path, f'origin/{pr.base}', h)
        here = repo.github.lower()
        closes = [f'#{k}' if where == here else f'{where}#{k}'
                  for where, k in closed_issues(pr.body, here)]
        threads = [j for j in self.jobs.pr_jobs(repo.name, pr.number, pr.branch) if j.link]
        order = self.order(repo, pr)
        by = order and (order.link or "Stefan's reply on the PR")
        direction = '' if order is None else (
            f'## Direction first\n\nThe loop stopped on this head, and a decision ordered this '
            f'round ({by}). Follow it; it comes before the findings below.\n\n'
            f'{(order.reason or "").strip()}\n\n')
        return _template().substitute(
            direction=direction,
            number=pr.number, github=repo.github, title=pr.title, round=review.round,
            sha=h, sha7=h[:7], work=fix_branch(pr.number, h), branch=pr.branch, base=pr.base,
            agents=_agents_pointer(repo.path),
            review_link=review.link or f'review {review.round} on the PR',
            important='\n'.join(map(_open_line, important)) or 'None.',
            classes='; '.join(f'"{c}"' for c in classes) or 'none named',
            nits='\n'.join(map(_open_line, nits)) or 'None.',
            settled='\n'.join(f"- **{f['id']}** · {f['class'] or 'no class'} · "
                              f"{STATUSES[f['status']].lower()}" for f in settled) or 'None.',
            body=(pr.body or '').strip() or '(The PR has no description.)',
            closes=', '.join(closes) or 'no issue',
            commits='\n'.join(f"- `{c['sha'][:7]}` {c['subject']}" for c in commits) or 'None.',
            diffstat=self.git.diffstat(repo.path, f'origin/{pr.base}', h).rstrip() or '(none)',
            threads='\n'.join(f'- {j.kind} job, {j.started_at[:16]}, ended {j.outcome}: '
                              f'{j.link}' for j in threads) or 'None started by the runner.')

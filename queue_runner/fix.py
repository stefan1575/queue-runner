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

**A conflict round** (ticket 15): a PR with no blocking review whose head H conflicts with its base
gets a fix round too (`cause` `conflict`, `templates/conflict.md`): Claude merges the base in,
resolves the conflict and pushes, and Sol reviews the new head afresh. One conflicted PR at a time
in a repo, lowest number first: while another open PR that had a conflict round isn't stopped for
Stefan (`stops.held`), it's still on its way to merging, and the next waits, so each resolves
against the newest base. A round on H that couldn't resolve it, or a third conflict on the PR, is
a `conflict` stop instead (`stops.conflict_stop`).
"""
from importlib import resources
from string import Template

from .brief import _agents_pointer
from .ledger import OPEN, STATUSES, newest_on, norm, read_reviews, state
from .picker import closed_issues
from .state import NOT_SENT, NOT_STARTED, JobLog
from .stops import CONFLICT, conflict_rounds, conflict_stop, held, positions

BASE_COMMITS = 30   # a conflict brief lists at most this many of the base's new commits


def fix_branch(number: int, sha: str) -> str:
    """The local branch a fix round's T3 worktree is made on, from H. It never goes to origin:
    the round pushes to the PR's own branch."""
    return f'claude/fix-pr{number}-{sha[:7]}'


def fix_title(repo, number: int, cause: str | None = None) -> str:
    return f'Queue runner {"conflict" if cause == CONFLICT else "fix"}: {repo.name}#{number}'


def _template(name: str = 'fix') -> Template:
    return Template(resources.files(__package__).joinpath(f'templates/{name}.md')
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
        review = self.jobs.runner_review(repo.name, pr.number, pr.head_sha)
        if review and (review.outcome == 'blocking' or (
                review.outcome in ('stop', 'approach-note') and self.order(repo, pr))):
            return review
        return None

    def why_not(self, repo, pr) -> str | None:
        """Why a PR whose head the runner found blocking gets no fix round now, or None."""
        if why := self._busy(repo, pr):
            return why
        if not newest_on(self.github.issue_comments(repo, pr.number), pr.head_sha, 'blocking'):
            return f'its newest review comment is not the blocking review of {pr.head_sha[:7]}'
        return None

    def _busy(self, repo, pr) -> str | None:
        """What holds any round on the PR's head H: a round on H ran already (one per head), a
        Claude job writes to the PR, or it's held for Stefan."""
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
            if last.outcome == 'usage-limit':
                return f'its fix round was cut off by a usage limit; it resumes after {last.resume_at}'
            return (f'a fix round on {h7} ended {last.outcome} and the head is still {h7}: '
                    f'left for Stefan (or --release {repo.name}#{pr.number})')
        if job := self.jobs.writer(repo.name, pr.branch):
            return f'a {job.kind} job is writing to {pr.branch}'
        if why := held(self.jobs, repo, pr.number):
            return why
        return None

    def conflict_why_not(self, repo, pr, prs) -> str | None:
        """Why a PR that conflicts with its base gets no conflict round now, or None. `prs` is
        the repo's open PRs: one conflicted PR at a time."""
        if why := self._busy(repo, pr):
            return why
        if stop := conflict_stop(self.jobs, repo, pr):
            return f'{stop[0]}: a stop for Stefan'
        if other := self.resolving(repo, pr, prs):
            return (f"PR #{other.number} had a conflict round and hasn't merged or stopped yet: "
                    'one conflicted PR at a time')
        return None

    def resolving(self, repo, pr, prs):
        """Another open PR that had a conflict round and isn't stopped for Stefan: it's on its
        way to merging, so this one waits to resolve against the base it lands on."""
        return next((o for o in prs if o.number != pr.number
                     and conflict_rounds(self.jobs, repo.name, o.number)
                     and not held(self.jobs, repo, o.number)), None)

    def candidates(self, repo):
        """(PR, its blocking review job, why not now) for each open PR the runner found
        blocking, and (PR, None, why not now) for each with no blocking review that conflicts
        with its base (a conflict round), lowest number first. Only the first conflicted PR
        may go: the others wait for it."""
        prs = sorted(self.github.open_pulls(repo), key=lambda p: p.number)
        first = None   # the conflicted PR whose round goes first this pass
        for pr in prs:
            review = self.review_to_fix(repo, pr)
            try:
                if review is not None:
                    why = self.why_not(repo, pr)
                elif self.github.has_conflict(repo, pr.number):
                    why = self.conflict_why_not(repo, pr, prs)
                    if why is None and first is not None:
                        why = (f'PR #{first.number} resolves its conflict first: one conflicted '
                               'PR at a time')
                    elif why is None:
                        first = pr
                else:
                    continue
            except Exception as e:
                why = f'reading it failed ({type(e).__name__}: {e})'
            yield pr, review, why

    def brief(self, repo, pr, review) -> str:
        """The fix brief, or with no review a conflict round's. Git must have H and
        `origin/<base>` (`fetch_pr`)."""
        if review is None:
            return self.conflict_brief(repo, pr)
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

    def conflict_brief(self, repo, pr) -> str:
        """A conflict round's brief: merge the base into H, resolve, push. Git must have H and
        `origin/<base>` (`fetch_pr`)."""
        h = pr.head_sha
        base = f'origin/{pr.base}'
        commits = self.git.log(repo.path, base, h)
        landed = self.git.log(repo.path, h, base)
        shown = landed[-BASE_COMMITS:]
        here = repo.github.lower()
        closes = [f'#{k}' if where == here else f'{where}#{k}'
                  for where, k in closed_issues(pr.body, here)]
        threads = [j for j in self.jobs.pr_jobs(repo.name, pr.number, pr.branch) if j.link]
        older = len(landed) - len(shown)
        return _template('conflict').substitute(
            number=pr.number, github=repo.github, title=pr.title,
            sha=h, sha7=h[:7], work=fix_branch(pr.number, h), branch=pr.branch, base=pr.base,
            agents=_agents_pointer(repo.path),
            body=(pr.body or '').strip() or '(The PR has no description.)',
            closes=', '.join(closes) or 'no issue',
            commits='\n'.join(f"- `{c['sha'][:7]}` {c['subject']}" for c in commits) or 'None.',
            landed=(f'({older} older ones not shown)\n' if older else '')
            + ('\n'.join(f"- `{c['sha'][:7]}` {c['subject']}" for c in shown) or 'None found.'),
            diffstat=self.git.diffstat(repo.path, base, h).rstrip() or '(none)',
            threads='\n'.join(f'- {j.kind} job, {j.started_at[:16]}, ended {j.outcome}: '
                              f'{j.link}' for j in threads) or 'None started by the runner.')

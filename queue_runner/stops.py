"""Stops for Stefan (ticket 06; `~/.claude/docs/pr-review.md`, Stops), in the Sol lane.

When the loop has to come to Stefan, the runner files the stop: one `needs-info` issue per PR
(opened, or a comment on the one still open), a comment on the PR that records the stop and links
the issue, and a toast whose click opens the issue. Then it leaves the PR alone (no review, fix
round or merge) until Stefan answers: he closes the issue or replies on the PR (07's decision
thread will read the reply), or `--release NAME#PR`.

The kinds (KINDS): a review that stopped (a new Important finding in an earlier class, a fixed
finding reopening, a decline Sol kept), review 3 or later still blocking (`approach-note`; the
Approach note itself comes with ticket 07), a failed check or a conflict on H, and a fix round
that ended without pushing (H was reviewed already). Each kind is filed once per head H.

Filing is an automated post in the repo's own issues and PRs, which needs no go-ahead
(`~/.claude/CLAUDE.md`).
"""
import datetime
import json
import os

from .github import OLD_LABELS
from .ledger import STOP_MARK, said_since
from .toast import NoToaster

NEEDS_INFO = 'needs-info'
KINDS = {
    'review': 'Sol\'s review stopped the loop',
    'approach-note': 'Still blocking after review 3',
    'failed-check': 'A check failed',
    'conflict': 'It conflicts with its base',
    'no-push': 'The fix round pushed nothing',
}
SIGNALS = {   # decide()'s stop signals, when the review's run folder can't say more
    'repeated-class': 'a new Important finding repeats an earlier class',
    'reopened': 'a fixed finding came back',
    'decline-kept': 'Sol kept a decline open',
}


def needs_info_mark(github: str, n: int) -> str:
    """The hidden line that ties a `needs-info` issue to its PR."""
    return f'<!-- queue-runner needs-info {github}#{n} -->'


def _utc(stamp: str) -> str:
    """A job's local time as GitHub writes times (UTC, `Z`), so the two compare as text."""
    t = datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    return t.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _number(url: str) -> int:
    return int(url.rstrip('/').rsplit('/', 1)[-1])


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

    # --- what stops ---------------------------------------------------------------------------

    def detect(self, repo, pr) -> list[tuple[str, str, str | None]]:
        """The stops on this PR's head H now: [(kind, why, link)], whether filed or not. A PR the
        old script has, or that a Claude job is writing to, has none yet."""
        if any(lb in OLD_LABELS for lb in pr.labels) or self.jobs.writer(repo.name, pr.branch):
            return []
        n, h, h7 = pr.number, pr.head_sha, pr.head_sha[:7]
        found = []
        review = self.jobs.runner_review(repo.name, n, h)
        if review and review.outcome == 'stop':
            found.append(('review', f'review {review.round} on {h7}: {_signal_texts(review)}',
                          review.link))
        elif review and review.outcome == 'approach-note':
            found.append(('approach-note', f'review {review.round} on {h7} is still blocking; '
                          'no further review runs without your answer: rework, fix on or hold?',
                          review.link))
        fixes = [j for j in self.jobs.on('fix', repo.name, n, h) if not j.open]
        if fixes and fixes[-1].outcome == 'no-push':
            found.append(('no-push', f'the fix round after review {fixes[-1].round} ended '
                          f'without pushing, so the PR is still at {h7}, which was reviewed',
                          fixes[-1].link))
        checks = self.github.checks(repo, h)
        if checks.state == 'failed':
            found.append(('failed-check', f'a check failed on {h7} '
                          f'({", ".join(checks.failed)})', None))
        if self.github.has_conflict(repo, n):
            found.append(('conflict', f'it conflicts with {pr.base} at {h7}', None))
        return found

    def new_stops(self, repo, pr) -> list[tuple[str, str, str | None]]:
        """The stops on H not filed yet."""
        return [s for s in self.detect(repo, pr)
                if not self.jobs.stopped(repo.name, pr.number, pr.head_sha, s[0])]

    def stop_pass(self) -> None:
        """Each repo: the stops Stefan answered go back to the loop, then every open PR's new
        stops are filed."""
        for repo in self.config.repos:
            if not repo.github:
                continue
            self.answers(repo)
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
            for kind, why, link in self.new_stops(repo, pr):
                self.file(repo, pr, kind, why, link)
        except Exception as e:
            self.say(f'stop {repo.name}#{pr.number}: checking for stops failed '
                     f'({type(e).__name__}: {e})')

    # --- filing -------------------------------------------------------------------------------

    def file(self, repo, pr, kind: str, why: str, link: str | None = None) -> str:
        """Files one stop: the PR's `needs-info` issue (opened, or a comment on the open one),
        a comment on the PR, a toast. 'filed', or 'failed' if the issue couldn't be filed (then
        nothing counts, and the next pass files it)."""
        n, h, name = pr.number, pr.head_sha, f'stop {repo.name}#{pr.number}'
        job = self.jobs.started(kind='stop', repo=repo.name, issue=n, branch=pr.branch,
                                title=f'Queue runner stop: {repo.name}#{n}', sha=h, stop=kind)
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
                f'**The review loop stopped here for Stefan.** {line}\n\n'
                f'Tracked in #{_number(url)}. The queue runner leaves this PR alone until that '
                'issue is closed or Stefan replies here.\n\n'
                f'{STOP_MARK}kind={kind} sha={h} issue={_number(url)} -->\n'))
        except Exception as e:
            self.say(f'{name}: recording the stop on the PR failed: {e}')
        self.jobs.ended(job.id, exit_code=None, outcome='filed', link=url, reason=why)
        try:
            self.toaster.toast(f'{repo.name} PR #{n} needs you', f'{KINDS[kind]}: {why}.'[:250],
                               url, tag=f'{repo.name}-{n}', button='Open the issue')
        except Exception as e:
            self.say(f'{name}: the toast failed: {e}')
        return 'filed'

    def _issue(self, repo, pr, line: str) -> tuple[str, bool]:
        """The PR's open `needs-info` issue with this stop added, or a new one: (url, opened)."""
        n = pr.number
        mark = needs_info_mark(repo.github, n)
        had = next((i for i in self.github.open_issues(repo) if mark in i.body), None)
        if had:
            self.github.post_comment(repo, had.number, f'Another stop on PR #{n}: {line}')
            return had.url, False
        body = (f'The queue runner stopped the review loop on PR #{n} ({pr.url or pr.title}) '
                f'and left it for Stefan.\n\n- {line}\n\n'
                'Close this issue, or reply on the PR, and the runner takes the PR back. A later '
                'stop on the PR is added here as a comment.\n\n'
                "<sub>Filed by the queue runner from Stefan's PC.</sub>\n\n" + mark + '\n')
        title = f'PR #{n} needs Stefan' + (f': {pr.title}' if pr.title else '')
        return self.github.create_issue(repo, title, body, [NEEDS_INFO]), True

    # --- answers ------------------------------------------------------------------------------

    def answers(self, repo) -> None:
        """Each filed stop Stefan has since answered (its issue closed, or a reply on the PR
        after it) is recorded `answered`, and the PR goes back to the loop."""
        for n in sorted({j.issue for j in self.jobs.jobs()
                         if j.kind == 'stop' and j.repo == repo.name}):
            stops = self.jobs.open_stops(repo.name, n)
            if not stops:
                continue
            try:
                closed = {u for u in {j.link for j in stops if j.link}
                          if self.github.issue_state(repo.github, _number(u)) == 'closed'}
                said = (self.github.issue_comments(repo, n)
                        + self.github.review_replies(repo, n))
            except Exception as e:
                self.say(f'stop {repo.name}#{n}: reading its answer failed ({e}); next pass')
                continue
            for j in stops:
                how = ('issue-closed' if j.link in closed else
                       'replied' if said_since(said, _utc(j.started_at)) else None)
                if how:
                    self.jobs.ended(j.id, exit_code=None, outcome='answered', link=j.link,
                                    reason=j.reason, answer=how)
                    self.say(f'stop {repo.name}#{n}: answered ('
                             + ('its issue was closed' if how == 'issue-closed' else
                                'a reply on the PR') + f'); the PR is back in the loop')


def held(jobs, repo, n: int) -> str | None:
    """Why a PR is left alone for Stefan, or None."""
    stops = jobs.open_stops(repo.name, n)
    if not stops:
        return None
    last = stops[-1]
    return (f'stopped for Stefan ({KINDS.get(last.stop, last.stop).lower()}): left alone until '
            f'{last.link} is closed, he replies on the PR, or --release {repo.name}#{n}')

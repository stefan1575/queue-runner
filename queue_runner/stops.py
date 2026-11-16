"""Stops for Stefan (ticket 06; `~/Code/docs/pr-review.md`, Stops), in the Sol lane.

When the loop has to come to Stefan, the runner files the stop: one `needs-info` issue per PR
(opened, or a comment on the one still open), a comment on the PR that records the stop and links
the issue, and a toast whose click opens the issue. Then it leaves the PR alone (no review, fix
round or merge) until Stefan answers: he closes the issue, or replies on the PR or the issue
(a decision on his reply comes first, `decisions.py`), or `--release NAME#PR`.

The kinds (KINDS): a review that stopped (a new Important finding in an earlier class, a fixed
finding reopening, a decline Sol kept), a failed check on H, a conflict on H that a conflict round
couldn't resolve, that came back on the base its last round merged, or that came back after 5
rounds (issue #91; a conflict first gets a conflict round,
`fix.py`), and a fix round that ended without pushing (H was reviewed already): each found here,
and filed once per head H. Two
come from decisions (`decisions.py`): review 3 or later still blocking (`approach-note`, filed
with the Approach note a decision thread wrote) and a decision thread's own question
(`decision`).

Filing is an automated post in the repo's own issues and PRs, which needs no go-ahead
(`~/Code/global/CLAUDE.md`).
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
SIGNALS = {   # decide()'s stop signals, when the review's run folder can't say more
    'repeated-class': 'a new Important finding repeats an earlier class',
    'reopened': 'a fixed finding came back',
    'decline-kept': 'Sol kept a decline open',
}


def needs_info_mark(github: str, n: int) -> str:
    """The hidden line that ties a `needs-info` issue to its PR."""
    return f'<!-- queue-runner needs-info {github}#{n} -->'


def utc(stamp: str) -> str:
    """A job's local time as GitHub writes times (UTC, `Z`), so the two compare as text."""
    t = datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    return t.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def number_of(url: str) -> int:
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
        if checks.state == 'failed':
            found.append(('failed-check', f'a check failed on {h7} '
                          f'({", ".join(checks.failed)})', None))
        if self.github.has_conflict(repo, n) and (stop := conflict_stop(self.jobs, repo, pr)):
            found.append(('conflict', *stop))
        return found

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

    def file(self, repo, pr, kind: str, why: str, link: str | None = None,
             after: str | None = None) -> str:
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
        reply, through a decision on it (`decisions.py`)."""
        for n in sorted({j.issue for j in self.jobs.jobs()
                         if j.kind == 'stop' and j.repo == repo.name}):
            stops = self.jobs.open_stops(repo.name, n)
            if not stops:
                continue
            try:
                closed = {u for u in {j.link for j in stops if j.link}
                          if self.github.issue_state(repo.github, number_of(u)) == 'closed'}
                said = (self.github.issue_comments(repo, n)
                        + self.github.review_replies(repo, n))
                on_issue = {u: self.github.issue_comments(repo, number_of(u))
                            for u in {j.link for j in stops if j.link} - closed}
            except Exception as e:
                self.say(f'stop {repo.name}#{n}: reading its answer failed ({e}); next pass')
                continue
            for j in stops:
                how = ('issue-closed' if j.link in closed else
                       'replied' if said_since(said + on_issue.get(j.link, []),
                                               utc(j.started_at)) else None)
                if how:
                    self.jobs.ended(j.id, exit_code=None, outcome='answered', link=j.link,
                                    reason=j.reason, answer=how)
                    self.say(f'stop {repo.name}#{n}: answered ('
                             + ('its issue was closed); the PR is back in the loop'
                                if how == 'issue-closed' else
                                'a reply); a decision on the reply comes first'))


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


def conflict_stop(jobs, repo, pr) -> tuple[str, str | None] | None:
    """Why a conflict on the PR's head H is a stop for Stefan, (why, link), or None while
    another conflict round may still resolve it (issue #91). A stop only when one wouldn't help:
    the newest round on H (a conflict round, or an ordinary fix round that couldn't start) ended
    without resolving it; or the PR conflicts again with the same base commit its last conflict
    round merged in (`base`; a record without one counts as a different base), so that round's
    push didn't resolve it; or it had MAX_CONFLICT_ROUNDS conflict rounds since the last
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
    if earlier and earlier[-1].base and earlier[-1].base == pr.base_sha:
        prev = earlier[-1]
        return (f'it conflicts with {pr.base} again at {h7}, though the conflict round on '
                f'{prev.sha[:7]} merged {pr.base} at {prev.base[:7]} and {pr.base} has not moved '
                'since', prev.link)
    return None

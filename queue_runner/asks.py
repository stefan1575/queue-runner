"""The Inbox's asks, written from templates (ticket 31; the runner has no AI in it). `render` turns
the last collection (`inbox.Inbox`) and the job log into the snapshot's `asks` and `answered`, in
the shape `dashboard/sample.py` builds: each written to be picked up cold, a week later.

- `kind`: `broken` (a failed check, a base branch failing its checks:
  issue #98, one ask for the repo), `stuck` (a review stop, an approach
  note, a fix round that pushed nothing, a conflict a round couldn't resolve), `decision` (a
  decision's stop on a PR, a build a decision left to Stefan, a thread waiting for his answer)
  or `merge` (ready for him to merge). Listed in that
  order, oldest first inside a kind.
- `about` is the first prose of the issue a PR closes (its "What to build" or "Summary" when it
  has one), else of the PR or issue itself, clipped. `because` is the stop's own reason, with
  the findings still open. `timeline` is the job log on that PR or issue, oldest first: a whole
  sentence per step, with its time.
- Pure: everything comes in through the arguments.
"""
import datetime
import re

from .stops import KINDS, number_of

ORDER = ('broken', 'stuck', 'decision', 'merge')
KIND = {'review': 'stuck', 'approach-note': 'stuck', 'no-push': 'stuck', 'conflict': 'stuck',
        'decision': 'decision', 'failed-check': 'broken'}
REVIEWED = ('clean', 'blocking', 'stop', 'approach-note')
SKIPPED = ('not-started', 'not-sent')
ABOUT_MAX = 300
NOTE_MAX = 400
RECOMMEND = re.compile(r'recommends (rework|fix on|hold)\b')
ABOUT_HEADINGS = re.compile(r'^#{1,6}\s*(what to build|summary|what|why)\s*$', re.I)
NOT_PROSE = re.compile(r'^\s*(#|```|\||---|<|_generated|(closes|fixes|resolves|blocked by|'
                       r'parent|builds on|part of)\b|#\d+\s*$)', re.I)


_EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)


def _t(stamp: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))


def _iso(stamp: str | None) -> str | None:
    return _t(stamp).astimezone().isoformat(timespec='seconds') if stamp else None


def sentence(text: str) -> str:
    text = (text or '').strip()
    if not text:
        return ''
    return text[:1].upper() + text[1:] + ('' if text.endswith(('.', '!', '?')) else '.')


def clip(text: str, most: int) -> str:
    """At a sentence's end if one falls late enough, else at a word, with an ellipsis."""
    text = ' '.join(text.split())
    if len(text) <= most:
        return text
    cut = text[:most]
    end = max(cut.rfind('. '), cut.rfind('? '), cut.rfind('! '))
    if end >= most // 3:
        return cut[:end + 1]
    return cut[:cut.rfind(' ')].rstrip(',;:') + '…' if ' ' in cut else cut + '…'


def _paragraphs(body: str) -> list[tuple[str | None, str]]:
    """(the heading it's under, the paragraph) for each prose paragraph, in order."""
    body = re.sub(r'<!--.*?-->', '', body or '', flags=re.S)
    out, heading, para, fenced = [], None, [], False

    def flush():
        if para:
            out.append((heading, ' '.join(para)))
            para.clear()
    for line in body.splitlines():
        s = line.strip()
        if s.startswith('```'):
            flush()
            fenced = not fenced
            continue
        if fenced:
            continue
        if re.match(r'^#{1,6}\s', s):
            flush()
            heading = s
            continue
        if not s or NOT_PROSE.match(s) or re.match(r'^([-*+]|\d+\.)\s', s):
            flush()
            continue
        para.append(s)
    flush()
    return out


def plain(text: str) -> str:
    """Markdown's emphasis and code marks taken out, so a sentence reads as text."""
    text = re.sub(r'\*\*|__|`', '', text)
    return re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)   # a link's words


def first_prose(body: str, most: int) -> str:
    """The body's first prose paragraph, as plain text, clipped."""
    paras = _paragraphs(body)
    return clip(plain(paras[0][1]), most) if paras else ''


def about_text(*bodies: str) -> str:
    """What the work is: the first prose under a "What to build" or "Summary" heading in the
    first body that has prose, else that body's first prose paragraph, clipped."""
    for body in bodies:
        paras = _paragraphs(body)
        if not paras:
            continue
        under = next((p for h, p in paras if h and ABOUT_HEADINGS.match(h)), None)
        return clip(plain(under or paras[0][1]), ABOUT_MAX)
    return ''


def plural(n: int, one: str, many: str | None = None) -> str:
    return f'{n} {one if n == 1 else many or one + "s"}'


# --- the job log, read as a story ---------------------------------------------------------------

class Story:
    """The job log, as the steps of one PR or issue."""

    def __init__(self, jobs, releases, reviews):
        self.jobs, self.releases, self.reviews = jobs, releases, reviews

    def on(self, kind, repo, n):
        return [j for j in self.jobs if (j.kind, j.repo, j.issue) == (kind, repo, n)]

    def builds(self, repo, n, pr: bool):
        return [j for j in self.jobs if j.kind == 'build' and j.repo == repo and (
            (pr and isinstance(j.pr, dict) and j.pr.get('number') == n)
            or (not pr and j.issue == n))]

    def findings(self, review) -> list:
        return (self.reviews.get(review.id) or {}).get('findings') or []

    def problems(self, review) -> list[str]:
        """The kinds of Important problem this review raised, each once."""
        found = [f.get('class') or f.get('id') for f in self.findings(review)
                 if f.get('tag') == 'important' and f.get('raised') == review.round]
        return list(dict.fromkeys(c for c in found if c))

    def open_now(self, review) -> str:
        found = [f for f in self.findings(review)
                 if f.get('tag') == 'important' and f.get('status') == 'open']
        if not found:
            return ''
        return 'Open now: ' + '; '.join(f'{f["id"]}, {f.get("class") or "no class"}'
                                        for f in found) + '.'

    def fix_rounds(self, repo, n) -> int:
        return sum(1 for j in self.on('fix', repo, n)
                   if j.cause != 'conflict' and j.outcome == 'pushed')

    def steps(self, repo, n, pr: bool) -> list[dict]:
        pos = {j.id: i for i, j in enumerate(self.jobs)}
        events = []   # (when, its job's place in the log, the sentence)

        def add(at, j, text):
            if at and text:
                events.append((at, pos.get(j.id, len(pos)) if j else len(pos), text))
        for j in self.builds(repo, n, pr):
            add(j.started_at, j, self._build(j))
        if pr:
            for j in self.on('review', repo, n):
                if j.outcome in REVIEWED:
                    add(j.ended_at or j.started_at, j, self._review(j))
            for j in self.on('fix', repo, n):
                add(j.started_at, j, self._fix(j))
            for j in self.on('ready', repo, n):
                add(j.started_at, j, self._ready(j))
            for j in self.on('merge', repo, n):
                if j.outcome == 'merged':
                    add(j.ended_at or j.started_at, j, 'You merged it.'
                        if 'Stefan' in (j.reason or '') else 'The runner merged it.')
        for j in self.on('decision', repo, n):
            # A decision that writes a note or stops files its stop before it ends: told at its
            # start, so it reads before the stop it filed.
            add(j.started_at if j.outcome in ('approach-note', 'stop') else
                j.ended_at or j.started_at, j, self._decision(j))
        for j in self.on('stop', repo, n):
            if j.outcome in ('filed', 'answered'):
                add(j.started_at, j, self._stop(j))
            if j.outcome == 'answered':
                add(j.ended_at, j, f'You closed needs-info issue #{number_of(j.link)}.'
                    if j.answer == 'issue-closed' and j.link else 'You decided in T3.'
                    if j.answer == 'thread' else 'Its PR was merged or closed on GitHub, so the stop had nothing left to decide.'
                    if j.answer == 'pr-closed' else 'You replied.')
        for j in self.on('ask', repo, n):   # a thread Stefan opened to decide in (ticket 35)
            if j.outcome == 'opened':   # or a fresh one in place of a stale one (#72)
                add(j.ended_at or j.started_at, j,
                    'Its question went cold, so you opened a fresh thread in T3 to answer it.'
                    if j.question == 'waiting' else
                    'Its thread went cold, so you opened a fresh one in T3 to decide it.'
                    if j.resume else 'You opened a thread in T3 to decide it.')
        if not pr:   # a base stop's own issue (#98)
            for j in self.jobs:
                if j.kind == 'base' and j.repo == repo and j.link and number_of(j.link) == n:
                    add(j.started_at, j, f'{j.branch} failed its checks ({j.reason}), so the '
                        'runner filed this issue and stopped starting builds.')
                    held = [h for h in self.jobs if h.kind == 'base-hold' and h.about == j.id]
                    for h in held:
                        add(h.started_at, h, f'PR #{h.issue} failed only {h.reason}, as '
                            f'{j.branch} does, so it was held, not stopped.')
        for r_repo, r_n, at in self.releases:
            if (r_repo, r_n) == (repo, n):
                add(at, None, f'You released it (--release {repo}#{n}), so the runner took it '
                    'up again.')
        events.sort(key=lambda e: (_t(e[0]), e[1]))   # a tie goes to the job written first
        return [{'at': _iso(at), 'text': text} for at, _, text in events]

    @staticmethod
    def _build(j) -> str | None:
        n, out = j.issue, j.outcome
        pr = j.pr.get('number') if isinstance(j.pr, dict) else None
        if j.open:
            return f'Claude started building #{n}.'
        if out == 'done' and pr:
            return f'Claude built #{n} and opened PR #{pr}, in {plural(len(j.commits), "commit")}.'
        return {
            'done': f'Claude built #{n}.',
            'done-no-pr': f'Claude built #{n}, but no PR was opened.',
            'failed': f'The build of #{n} failed' + (f': {clip(j.error, 160)}' if j.error else '')
                      + ('' if (j.error or '').endswith('.') else '.'),
            'waiting': f'The build of #{n} stopped to ask a question.',
            'continued': f'The build of #{n} had asked a question, and '
                         + ('you answered it on GitHub.' if j.reason == 'github' else
                            'a decision answered it.'),
            'closed': f'The build of #{n} had asked you a question, and #{n} was closed, so '
                      'it ended.',
            'usage-limit': f"The build of #{n} was cut off by Claude's usage limit.",
            'branch-exists': f"The build of #{n} couldn't start: a branch from an earlier one "
                             'was left over.',
            'restart-failed': f"The build of #{n} couldn't be restarted after the usage limit.",
        }.get(out, None if out in SKIPPED else f'The build of #{n} ended {out}.')

    def _review(self, j) -> str:
        where = f'Review {j.round} on {(j.sha or "")[:7]}' + (   # issues #69 and #76
            {'opus-config': ', by Opus (config.toml says so),'}.get(
                j.reviewer, ', by Opus while Sol was out of usage,') if j.reviewer else '')
        if j.outcome == 'clean':
            return f'{where} came back clean.'
        found = self.problems(j)
        if found:
            return f'{where} found {plural(len(found), "problem")}: {"; ".join(found)}.'
        still = list(dict.fromkeys(f.get('class') or f.get('id') for f in self.findings(j)
                                   if f.get('tag') == 'important' and f.get('status') == 'open'))
        if still:
            return (f'{where} found no new problem, but {plural(len(still), "kind")} '
                    f'{"is" if len(still) == 1 else "are"} still open: {"; ".join(still)}.')
        return f'{where} was blocking.'

    @staticmethod
    def _fix(j) -> str | None:
        h7, to = (j.sha or '')[:7], (j.head or '')[:7]
        what = 'A conflict round' if j.cause == 'conflict' else 'A fix round'
        if j.open:
            return f'Claude started {what[2:]} on {h7}.'
        if j.outcome == 'pushed':
            if j.cause == 'conflict':
                return (f'A conflict round merged the base into the PR and pushed, moving it '
                        f'from {h7} to {to}.')
            return (f'A fix round pushed {plural(len(j.commits), "commit")}, moving the PR from '
                    f'{h7} to {to}.')
        return {
            'no-push': f"A conflict round on {h7} couldn't resolve the conflict and pushed "
                       'nothing.' if j.cause == 'conflict' else f'A fix round on {h7} pushed '
                       'nothing.',
            'failed': f'{what} on {h7} failed.',
            'waiting': f'{what} on {h7} stopped to ask a question.',
            'continued': f'{what} on {h7} had asked a question, and '
                         + ('you answered it on GitHub.' if j.reason == 'github' else
                            'a decision answered it.'),
            'closed': f'{what} on {h7} had asked you a question, and the PR was '
                      + ('merged' if 'merged' in (j.reason or '') else 'closed') + ', so it ended.',
            'usage-limit': f"{what} on {h7} was cut off by Claude's usage limit.",
            'head-unknown': f"{what} on {h7} ended, but GitHub couldn't say where the PR's head "
                            'went.',
            'branch-exists': f"{what} on {h7} couldn't start: its branch was left over.",
        }.get(j.outcome, None if j.outcome in SKIPPED else f'{what} on {h7} ended {j.outcome}.')

    @staticmethod
    def _ready(j) -> str | None:
        if j.outcome == 'marked':
            return 'The runner marked it ready for you to merge.'
        if j.outcome == 'unmarked':
            return 'The runner took the ready mark off' + (
                f': {j.reason}.' if j.reason else '.')
        return None

    @staticmethod
    def _decision(j) -> str | None:
        if j.open:
            return 'A decision thread is deciding what to do next.'
        rec = RECOMMEND.search(j.reason or '')
        q = j.question
        return {
            'approach-note': 'A decision thread wrote an approach note'
                             + (f'; it recommends {rec[1]}.' if rec else '.'),
            'stop': {'waiting': "A decision thread couldn't answer the thread's question, so it "
                                'came to you.',
                     'reply': "A decision thread couldn't settle what your reply asks, so it "
                              'came back to you.',
                     'approach-note': "A decision thread couldn't write an approach note, so it "
                                      'came to you.'}.get(
                q, "A decision thread couldn't settle what to do, so it came to you."),
            'fix': 'A decision on your reply ordered one more fix round.',
            'carry-on': 'A decision on your reply let the loop carry on as it is.',
            'hold': 'You said hold, so the runner leaves it until you release it.',
            'retry': 'A decision thread had it tried again.',
            'answer': "A decision thread answered the thread's question.",
            'close': 'A decision thread closed the issue as not needed.',
        }.get(j.outcome)

    @staticmethod
    def _stop(j) -> str:
        on = f', on needs-info issue #{number_of(j.link)}' if j.link else ''
        h7 = (j.sha or '')[:7]
        lead = {'failed-check': f'A check failed on {h7}, so the runner',
                'conflict': f'It conflicted with its base at {h7}, so the runner'}.get(
                    j.stop, 'The runner')
        return f'{lead} stopped the PR and brought it to you{on}.'


# --- each kind's sentences ----------------------------------------------------------------------

PR_OPTIONS = [
    ('a reply', 'A decision thread reads it: one more fix round on {h7} with your words first, '
                'carry on, or hold'),
    ('hold', 'Leave the PR until you release it'),
    ('close the issue', 'The PR goes back to the loop as it is'),
]
APPROACH_OPTIONS = [
    ('rework', 'One more fix round that reworks the approach, as the note and your reply say'),
    ('fix on', 'One more fix round on the open findings, the same approach'),
    ('hold', 'Leave the PR until you release it'),
]


def _options(rows, recommended=None, **fill) -> list[dict]:
    out = []
    for say, means in rows:
        o = {'say': say, 'means': means.format(**fill)}
        if say == recommended:
            o['recommended'] = True
        out.append(o)
    return out


def _review_of(story, w):
    rs = [j for j in story.on('review', w.repo, w.number)
          if j.outcome in REVIEWED and (w.job.sha is None or j.sha == w.job.sha)]
    return rs[-1] if rs else None


def _stop_ask(story, w, repo) -> dict:
    s, n = w.job, w.number
    h7 = (s.sha or w.head or '')[:7]
    review = _review_of(story, w)
    r = review.round if review else None
    reason = s.reason or KINDS.get(s.stop, s.stop)
    because = sentence(reason)
    question = 'What should happen to this PR next?'
    options = _options(PR_OPTIONS, h7=h7)
    if s.stop == 'review':
        signals = set(review.signals) if review else set()
        situation = (f'Review {r} found a kind of problem that a fix round had already fixed.'
                     if 'repeated-class' in signals else
                     f'Review {r} found a fixed problem back again.' if 'reopened' in signals
                     else f'Review {r} kept open a finding Claude had declined.'
                     if 'decline-kept' in signals else f'Review {r or ""} stopped the loop for '
                     'you.'.replace('Review  ', 'The review '))
    elif s.stop == 'approach-note':
        k = story.fix_rounds(w.repo, n)
        after = f' after {plural(k, "fix round")}' if k else ''   # rounds the log holds
        situation = (f'Review {r} is still blocking{after}, so it came '
                     'to you' + (' with an approach note.' if w.note else '.'))
        because = sentence(reason.split(';', 1)[0])
        if w.note:
            because += f' The approach note says: {first_prose(w.note, NOTE_MAX)}'
        rec = RECOMMEND.search(reason)
        question = 'Rework the approach, fix on with the same approach, or hold it?'
        options = _options(APPROACH_OPTIONS, rec[1] if rec else None)
    elif s.stop == 'no-push':
        situation = f'The fix round after review {r} pushed nothing, so the PR is stuck at {h7}.'
    elif s.stop == 'conflict':
        base = w.base or 'its base'
        situation = (f'PR #{n} keeps conflicting as {base} moves under it, after '
                     f'{reason.split(" ", 1)[0]} conflict rounds.'
                     if 'keeps moving under it' in reason else
                     f'PR #{n} still conflicts with {base}, though a conflict round merged it '
                     'and it has not moved since.'
                     if 'has not moved since' in reason else
                     f'PR #{n} conflicts with its base for the third time.'
                     if 'third conflict' in reason else   # a stop filed before issue #91
                     f"PR #{n} conflicts with {base}, and a conflict round couldn't resolve it.")
    elif s.stop == 'failed-check':
        situation = f'A check failed on {h7}.'
        question = 'Is the failure the change\'s fault, or should the PR go on?'
    elif s.stop == 'decision':
        situation = 'A decision on this PR needs your answer.'
        because = "A decision thread couldn't settle it, and left the question to you."
        question = sentence(reason)
    if review and s.stop in ('review', 'approach-note', 'no-push') and story.open_now(review):
        because += ' ' + story.open_now(review)
    return {'situation': situation, 'because': because, 'question': question,
            'options': options,
            'go': {'label': 'Open the needs-info issue', 'where': 'github',
                   'url': s.link or w.url}}


def _base_ask(story, w, repo) -> dict:
    s, b = w.job, w.job.branch
    n = len(w.holds_up)
    held = f', and {plural(n, "PR")} failing only those checks wait' if n else ''
    return {'situation': f'{b} fails its checks, so every PR into it inherits the failure.',
            'because': sentence(f'{s.reason} on {b}: no build starts from it{held}, with no '
                                'stop of their own'),
            'question': f'Fix {b}: once its checks pass, the runner updates the held PRs from it '
                        'and closes the issue itself.',
            'options': [],
            'go': {'label': 'Open the issue', 'where': 'github', 'url': s.link or w.url}}


def _merge_ask(story, w, repo) -> dict:
    r = w.job.round if w.job else None
    h7 = (w.head or '')[:7]
    return {'situation': 'This PR is reviewed clean and ready for you to merge.',
            'because': (f'Clean on {h7}' + (f' after review {r}' if r else '')
                        + ', checks passed, no conflict, nothing said since.'
                        + (f' In {repo.name} the merge is yours.' if repo else '')),
            'question': "Merge it when you've looked.", 'options': [],
            'go': {'label': 'Open PR to merge', 'where': 'github', 'url': w.url}}


def _build_ask(story, w, repo) -> dict:
    j, d, n = w.job, w.decision, w.number
    done = 'failed' if d.question == 'failed' else 'ended without a PR'
    return {'situation': f'The build of #{n} {done}, and a decision thread left it to you.',
            'because': (f'The build ended {j.outcome}' + (f': {clip(j.error, 200)}' if j.error
                                                          else '')).rstrip('.')
            + ". A decision thread couldn't settle what to do.",
            'question': sentence(d.reason) or 'What should happen to this issue?',
            'options': _options([(f'--release {w.repo}#{n}', 'Once you have handled it on the '
                                                             'issue, the runner may build it '
                                                             'again')]),
            'go': {'label': 'Open the issue', 'where': 'github', 'url': w.url}}


def _thread_ask(story, w, repo) -> dict:
    j, d, n = w.job, w.decision, w.number
    what = f'fix round on PR #{n}' if j.kind == 'fix' else f'build of #{n}'
    return {'situation': f"The {what} stopped at a question a decision thread couldn't answer.",
            'because': f'The {j.kind} thread asked a question, and a decision thread couldn\'t '
                       'answer it from what it had.',
            'question': sentence(d.reason) or 'See the thread.', 'options': [],
            'go': {'label': 'Answer in T3', 'where': 't3', 'url': j.link or ''}}


WRITERS = {'base': _base_ask, 'ready': _merge_ask, 'stop': _stop_ask, 'build': _build_ask, 'thread': _thread_ask}


def _id(w) -> str:
    if w.kind == 'ready':
        return f'merge-{w.repo}-{w.number}-{(w.head or "")[:7]}'
    if w.kind == 'build':
        return f'decision-{w.decision.id}'
    if w.kind == 'base':
        return f'base-{w.job.id}'
    return f'{"stop" if w.kind == "stop" else "thread"}-{w.job.id}'


def _since(story, w) -> str | None:
    if w.kind == 'ready':
        marks = [j for j in story.on('ready', w.repo, w.number)
                 if j.outcome == 'marked' and j.sha == w.head]
        return marks[-1].started_at if marks else (w.job.ended_at if w.job else None)
    if w.kind in ('build', 'thread'):
        return w.decision.ended_at
    return w.job.started_at


def _kind(w) -> str:
    if w.kind == 'base':
        return 'broken'
    return 'merge' if w.kind == 'ready' else KIND.get(w.job.stop, 'stuck') \
        if w.kind == 'stop' else 'decision'


def ask(story, w, repos) -> dict:
    repo = repos.get(w.repo)
    a = {
        'id': _id(w), 'kind': _kind(w), 'repo': w.repo,
        'ref': f'PR #{w.number}' if w.on_pr else f'#{w.number}',
        'pr': w.number if w.on_pr else None,
        'subject': w.title or (f'PR #{w.number}' if w.on_pr else f'#{w.number}'),
        'since': _iso(_since(story, w)),
        'about': about_text(w.issue_body, w.body),
    }
    a.update(WRITERS[w.kind](story, w, repo))
    holds = [f'PR #{n} {title}'.rstrip() if w.kind == 'base' else f'#{n} {title}'
             for n, title in w.holds_up]
    if w.kind == 'base':
        holds.append(f'Every new build in {w.repo}')
    a['holds_up'] = holds
    a['timeline'] = story.steps(w.repo, w.number, w.on_pr)
    order = ['id', 'kind', 'repo', 'ref', 'pr', 'subject', 'since', 'situation', 'about',
             'because', 'timeline', 'question', 'options', 'holds_up', 'go']
    return {k: a[k] for k in order}


def _next(story, w) -> str:
    """What the runner does with Stefan's answer next."""
    from .inbox import acting
    s, n = w.job, w.number
    after = acting(story.jobs, s)
    if s.answer in ('replied', 'thread'):   # a reply, or decided in its T3 thread (35)
        d = next((j for j in after if j.kind == 'decision'), None)
        if d is None:
            return 'The runner reads your reply on its next pass: a decision on it comes first.'
        if d.open:
            return 'A decision thread is reading your reply.'
        if d.outcome == 'fix':
            return f'One more fix round on PR #{n} is queued.'
        return 'The runner carries on from the decision on your reply.'
    if any(j.open for j in after):
        return f'The runner is on PR #{n} again.'
    return 'The PR is back in the loop: the runner takes it up on its next pass.'


def stale_github(sources: list[dict], stale: dict) -> None:
    """When the Sol lane couldn't read GitHub for a repo, its asks are the last good read's: the
    GitHub source says so, since when, and what it affects (as the sample's `github-down`). It's
    red, so not reconnecting, whatever another repo's or the latest call's failure says (PR #113
    review 1, F1)."""
    if not stale:
        return
    src = next((s for s in sources if s['id'] == 'github'), None)
    if src is None:
        return
    names = ', '.join(sorted(stale))
    whens = [v[0] for v in stale.values() if v[0] is not None]
    error = next((v[1] for v in stale.values() if v[1]), '')
    src.update(ok=False, retrying=None, note=sentence(error.split(': ', 1)[-1]) or "Couldn't be read",
               checked_at=min(whens).astimezone().isoformat(timespec='seconds')
               if len(whens) == len(stale) else None,
               affects=f'The Inbox is as GitHub last showed it for {names}: an ask since then '
                       'may be missing, and one you answered may still be listed.')


def render(collection, jobs, releases=(), repos=()) -> tuple[list[dict], list[dict]]:
    """(asks, answered) from the last collection and the job log now."""
    if collection is None:
        return [], []
    story = Story(list(jobs), list(releases), collection.reviews)
    by_name = {r.name: r for r in repos}
    rank = {k: i for i, k in enumerate(ORDER)}
    asks = [ask(story, w, by_name) for w in collection.items]
    asks.sort(key=lambda a: (rank[a['kind']], _t(a['since']) if a['since'] else _EPOCH))
    answered = []
    for w in collection.answered:
        a = ask(story, w, by_name)
        a['answered'] = {'at': _iso(w.job.ended_at), 'said': w.said or 'a reply',
                         'next': _next(story, w)}
        answered.append(a)
    answered.sort(key=lambda a: _t(a['answered']['at']) if a['answered']['at'] else _EPOCH)
    return asks, answered

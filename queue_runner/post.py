"""Posting a review (ticket 04): the review loop's automated posts on the repo's own PR, which
need no go-ahead (`~/.claude/CLAUDE.md`; `~/.claude/docs/pr-review.md`, A round, step 4).

In order: each new Pre-existing finding filed once as a `needs-triage` issue (an open issue that
already holds it is linked instead), the review comment with those links and its ledger, the
`sol-review` status on H (the commit reviewed, never a newer one), then the repo's own records
(leads-dashboard: a row in the PR body's `## Review` table). The comment is the review's record:
if it can't be posted, the review failed and nothing counts. Anything after it that fails is
said and left; the review stands.
"""
import datetime
import os
import re

from .ledger import LEDGER, OPEN, _cell, _where, with_issues

TRIAGE = 'needs-triage'
OUTCOMES = {'stop': 'stopped for Stefan', 'approach-note': 'approach note for Stefan',
            'merge': 'to merge', 'fix': 'back to fix'}
TABLE_HEAD = '| Step | Time (UTC) | Commit | Verdict |'


class PostFailed(Exception):
    """The review comment couldn't be posted: nothing is on the PR, so the review failed."""


def followup_mark(github: str, n: int, fid: str) -> str:
    """The hidden line that ties a follow-up issue to its PR and finding."""
    return f'<!-- sol-finding {github}#{n} {fid} -->'


def issue_body(github: str, n: int, rnd: int, sha: str, f: dict) -> str:
    lines = [f"Sol found this in code that PR #{n} didn't change, in review {rnd} of "
             f'https://github.com/{github}/pull/{n}, so it was filed here instead of blocking '
             'that PR.', '']
    if f['file']:
        lines.append(f'- **Where:** {_where(github, sha, f)}')
    lines += [f'- **{k.capitalize()}:** {f[k]}' for k in ('class', 'scenario', 'cost', 'rule')
              if f.get(k)]
    return '\n'.join(lines + ['', f"<sub>Finding {f['id']}, filed by the queue runner from "
                                  "Stefan's PC.</sub>", '', followup_mark(github, n, f['id']), ''])


def filed_already(issues, github: str, n: int, fid: str, title: str):
    """The open issue that already holds this finding, or None: the runner's mark, the old
    script's footer for the same PR and ID, or the same title."""
    old = re.compile(rf'Finding {re.escape(fid)}, filed by sol-pr-review')
    for i in issues:
        if (followup_mark(github, n, fid) in i.body
                or (old.search(i.body) and f'/{github}/pull/{n}' in i.body)
                or i.title.strip() == title.strip()):
            return i
    return None


def review_row(d: dict, url: str, at: datetime.datetime) -> str:
    """The PR body's `## Review` row for this review: what it found, closed and left open."""
    rnd, fs = d['round'], d['findings']

    def ids(ok):
        return ', '.join(f['id'] for f in fs if ok(f))
    came = {i for s in d['signals'] if s['signal'] == 'reopened' for i in s['ids']}
    signal = f" ({', '.join(s['signal'] for s in d['signals'])})" if d['signals'] else ''
    parts = [f"**{d['verdict'].capitalize()}**, {OUTCOMES[d['outcome']]}{signal}"]
    for label, ok in (
            ('raised', lambda f: f['raised'] == rnd and f['tag'] != 'pre-existing'),
            ('came back', lambda f: f['id'] in came),
            ('fixed', lambda f: f.get('closed') == rnd and f['status'] == 'fixed'),
            ('decline accepted',
             lambda f: f.get('closed') == rnd and f['status'] == 'decline-accepted'),
            ('decline kept open', lambda f: f['id'] in d['kept']),
            ('filed as follow-ups', lambda f: f['raised'] == rnd and f['tag'] == 'pre-existing'),
            ('left open', lambda f: f['tag'] == 'important' and f['status'] in OPEN)):
        if got := ids(ok):
            parts.append(f'{label}: {got}')
    return (f"| [Sol review {rnd}]({url}) | {at:%Y-%m-%d %H:%M} | `{d['sha'][:7]}` | "
            f"{_cell('; '.join(parts))} |")


def with_review_row(body: str, row: str) -> str:
    """The PR body with `row` appended to its `## Review` table. A section without a table gets
    one; a body without the section gets it after `## Evidence` (or at the end). Rows already
    there stay. Ported from `~/sol-pr-review.py`."""
    lines = (body or '').replace('\r\n', '\n').rstrip('\n').split('\n')

    def head(pat):
        return next((i for i, line in enumerate(lines) if re.match(pat, line)), None)

    def end(i):
        return next((j for j in range(i + 1, len(lines)) if re.match(r'#{1,2}\s', lines[j])),
                    len(lines))
    table = [TABLE_HEAD, '|---|---|---|---|', row]

    def put(at, floor, new):
        # In place of the blank lines before line `at`, one blank line either side of `new`.
        s = at
        while s > floor and not lines[s - 1].strip():
            s -= 1
        lines[s:at] = ['', *new, *([''] if at < len(lines) else [])]
    if (r := head(r'##\s+Review\s*$')) is not None:
        rows = [j for j in range(r + 1, end(r)) if lines[j].startswith('|')]
        # A table with another header (written by hand) keeps its rows; ours starts below it.
        if rows and lines[rows[0]].strip() == TABLE_HEAD:
            lines.insert(rows[-1] + 1, row)
        elif rows:
            lines[rows[-1] + 1:rows[-1] + 1] = ['', *table]
        else:
            put(end(r), r + 1, table)
    else:
        ev = head(r'##\s+Evidence\b')
        put(len(lines) if ev is None else end(ev), 0,
            ['## Review', '', '_Rows from the Sol review loop, one per review; each links its '
                              'comment._', '', *table])
    return '\n'.join(lines).lstrip('\n') + '\n'


def _write(path: str, text: str) -> None:
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def _utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


class GitHubPoster:
    def __init__(self, github, say, now=_utcnow):
        self.github, self.say, self.now = github, say, now

    def post(self, repo, pr, d: dict, run_dir: str) -> str:
        """Posts the review; returns its comment's URL. PostFailed if the comment didn't post."""
        n, name = pr.number, f'review {repo.name}#{pr.number}'
        urls, failed = self._file(repo, pr, d, run_dir)
        body = with_issues(d, urls)
        if failed:
            i = body.rindex(LEDGER)
            body = (f'{body[:i]}Filing {", ".join(failed)} as follow-up issues failed; the '
                    f'runner left {"it" if len(failed) == 1 else "them"} for Stefan to file.'
                    f'\n\n{body[i:]}')
        _write(os.path.join(run_dir, 'comment.md'), body)
        try:
            url = self.github.post_comment(repo, n, body)
        except Exception as e:
            raise PostFailed(f'Posting the review comment failed ({type(e).__name__}: {e}).') \
                from e
        self.say(f'{name}: posted {url}')
        st = d['status']
        try:   # on H, the commit Sol reviewed, whatever the PR's head is by now
            self.github.set_status(repo, d['sha'], st['state'], st['description'], url)
            self.say(f"{name}: sol-review {st['state']} on {d['sha'][:7]}")
        except Exception as e:
            self.say(f"{name}: setting sol-review on {d['sha'][:7]} failed: {e}")
        if repo.review_table:
            try:   # read afresh: someone may have edited the body while Sol ran
                row = review_row(d, url, self.now())
                new = with_review_row(self.github.pull_body(repo, n), row)
                _write(os.path.join(run_dir, 'pr-body.md'), new)
                self.github.edit_pull_body(repo, n, new)
            except Exception as e:
                self.say(f'{name}: adding the Review row to the PR body failed: {e}')
        return url

    def _file(self, repo, pr, d, run_dir) -> tuple[dict[str, str], list[str]]:
        """Files each new Pre-existing finding once: ({finding id: issue url}, ids that failed)."""
        if not d['issues']:
            return {}, []
        n, name = pr.number, f'review {repo.name}#{pr.number}'
        urls, failed = {}, []
        try:
            open_ = self.github.open_issues(repo)
        except Exception as e:   # without the check, filing could duplicate: leave it
            self.say(f'{name}: reading open issues failed, so nothing is filed: {e}')
            return {}, [i['id'] for i in d['issues']]
        for i in d['issues']:
            fid = i['id']
            if had := filed_already(open_, repo.github, n, fid, i['title']):
                urls[fid] = had.url
                self.say(f'{name}: {fid} is open already as {had.url}; not filed again')
                continue
            text = issue_body(repo.github, n, d['round'], d['sha'], i['finding'])
            _write(os.path.join(run_dir, f'followup-{re.sub(r"[^A-Za-z0-9-]", "_", fid)}.md'),
                   text)
            try:
                urls[fid] = self.github.create_issue(repo, i['title'], text, [TRIAGE])
                self.say(f'{name}: filed {fid} as {urls[fid]}')
            except Exception as e:
                failed.append(fid)
                self.say(f'{name}: filing {fid} failed: {e}')
        return urls, failed

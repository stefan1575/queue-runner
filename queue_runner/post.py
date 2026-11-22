"""Posting a review (ticket 04): the review loop's automated posts on the repo's own PR, which
need no go-ahead (`docs/flow.md`, Who runs it; A round, step 4).

In order: each new Pre-existing finding filed once as a `needs-triage` issue (an open issue that
already holds it is linked instead), the review comment with those links and its ledger, the
`sol-review` status on H (the commit reviewed, never a newer one). The comment is the review's record:
if it can't be posted, the review failed and nothing counts. Anything after it that fails is
said and left; the review stands.
"""
import os
import re

from .ledger import _where, with_issues

TRIAGE = 'needs-triage'


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


def _write(path: str, text: str) -> None:
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


class GitHubPoster:
    def __init__(self, github, say):
        self.github, self.say = github, say

    def post(self, repo, pr, d: dict, run_dir: str) -> str:
        """Posts the review; returns its comment's URL. PostFailed if the comment didn't post."""
        n, name = pr.number, f'review {repo.name}#{pr.number}'
        urls, failed = self._file(repo, pr, d, run_dir)
        body = with_issues(d, urls, failed)
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

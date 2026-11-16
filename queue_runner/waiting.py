"""A waiting thread's question answered on GitHub (issue #71, review 1's F1). A build or fix
thread that stopped on a question a decision left to Stefan (the `waiting` question's `stop`)
is answered in the thread, or on GitHub, where the stop's comment is (`Stopper.file_on_issue`:
the build's issue, or the fix round's PR):

- **His reply** there after the question was put to him (not a bot's, not the runner's own
  posts) is his answer: the Claude lane sends it to the thread as a continued job
  (`Runner.continue_job`, in place or fresh as for any), gated as the job's kind. The job it
  picks up ends `continued` with `reason` `github` and `answer` the newest reply's time
  (GitHub's), so a reply is sent once: what the thread asks next waits for words after it.
- **The issue closed, or the PR merged or closed**, answers it too: nothing is left to ask.
  The job ends `closed` (with `reason`), so it holds no PR and leaves the Inbox.

Either way the thread no longer needs him, so its "Answer: " comes off and it's settled
(`prefixes.py`). Read each Claude pass, after the lane's switch, in the repos the lanes work.
"""
from .config import working
from .ledger import said_since
from .state import when
from .stops import utc

CLOSED = 'closed'


def left_to_stefan(jobs, job) -> bool:
    """A waiting build or fix whose question a decision left to Stefan."""
    d = jobs.decided(job.id)
    return (job.kind in ('build', 'fix') and d is not None and d.question == 'waiting'
            and not d.open and d.outcome == 'stop')


def message(repo, n: int, said) -> str:
    """What the thread is sent: Stefan's words on GitHub, quoted."""
    words = '\n\n'.join(c.body.strip() for c in said if c.body.strip())
    quoted = '\n'.join(f'> {line}' if line else '>' for line in words.splitlines())
    return (f'Stefan answered your question on GitHub '
            f'(https://github.com/{repo.github}/issues/{n}):\n\n{quoted}\n\n'
            'Carry on with that as his answer.')


class GitHubAnswers:
    """The Claude lane's part: `read` each pass, then `next` gives a reply to send."""

    def __init__(self, config, *, github, jobs, say):
        self.config, self.github, self.jobs, self.say = config, github, jobs, say
        self._replies: list = []   # (job, message, its end's marks), from the last read
        self._said: dict[str, str] = {}

    def _once(self, key: str, text: str | None) -> None:
        if text is not None and self._said.get(key) != text:
            self.say(text)
        if text is None:
            self._said.pop(key, None)
        else:
            self._said[key] = text

    def read(self) -> None:
        """Ends each waiting job whose issue or PR is closed, and keeps each one Stefan replied
        to for `next`. GitHub failing on one job skips only that job, said once."""
        self._replies = []
        repos = {r.name: r for r in working(self.config) if r.github}
        for j in self.jobs.waiting_jobs():
            repo = repos.get(j.repo)
            if repo is None or not left_to_stefan(self.jobs, j):
                continue
            n, name = j.issue, f'{j.kind} {j.repo}#{j.issue}'
            since = self._since(j)
            try:
                if j.kind == 'fix':
                    state = self.github.pull(repo, n).state
                    said = (self.github.issue_comments(repo, n)
                            + self.github.review_replies(repo, n)) if state == 'open' else []
                else:
                    state = self.github.issue_state(repo.github, n)
                    said = self.github.issue_comments(repo, n) if state == 'open' else []
            except Exception as e:   # noqa: BLE001 - GitHub down: the next pass
                self._once(j.id, f'{name}: reading GitHub for an answer to its question failed '
                                 f'({e}); next pass')
                continue
            self._once(j.id, None)
            if state != 'open':
                what = 'issue' if j.kind == 'build' else 'PR'
                reason = f'its {what} #{n} was {state} on GitHub while it waited for Stefan'
                self.jobs.ended(j.id, exit_code=j.exit_code, outcome=CLOSED, reason=reason)
                self.say(f'{name}: {reason}, so it ends; its thread is settled')
                continue
            said = sorted(said_since(said, since), key=lambda c: c.created_at)
            if said:
                self._replies.append((j, message(repo, n, said),
                                      {'reason': 'github', 'answer': said[-1].created_at}))

    def _since(self, job) -> str:
        """GitHub's time after which Stefan's words answer this job's question: once it was put
        to him, and after every reply already sent to the thread (the jobs it picks up)."""
        by_id = {j.id: j for j in self.jobs.jobs()}
        stamps = [utc(max(self.jobs.decided(job.id).ended_at, job.ended_at, key=when))]
        j = job
        while j.about in by_id and by_id[j.about].kind == job.kind:
            j = by_id[j.about]
            if j.outcome == 'continued' and j.reason == 'github' and j.answer:
                stamps.append(j.answer)
        return max(stamps)

    def next(self):
        """(the waiting job, the message to send it, the marks for its `continued` end) for the
        first Stefan replied to, or None."""
        return self._replies[0] if self._replies else None

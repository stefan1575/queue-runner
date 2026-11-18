"""In-memory GitHub for tests: no network, no gh."""
from queue_runner.github import Comment, Issue, PullRequest


MAIN_HEAD = '9' * 40   # the base branch's head, unless a test says otherwise (issue #98)


class FakeGitHub:
    def __init__(self, issues=(), states=None, prs=(), branches=(), comments=None):
        self.issues = list(issues)
        self.states = dict(states or {})
        for i in self.issues:
            self.states.setdefault(i.number, 'open')
        self.prs = list(prs)
        self.branch_names = list(branches)
        self.comments = dict(comments or {})

    def ready_issues(self, repo):
        return list(self.issues)

    def issue_state(self, github, number):
        """States keyed by (owner/name, number), or by number alone for the served repo."""
        return self.states.get((github, number), self.states.get(number, 'closed'))

    def open_pulls(self, repo):
        return list(self.prs)

    def branches(self, repo, prefix):
        return [b for b in self.branch_names if b.startswith(prefix)]

    def issue_comments(self, repo, number):
        return list(self.comments.get(number, []))

    def open_issues(self, repo):
        return list(self.issues)

    def work_issues(self, repo):
        """The dashboard's read of open issues (`work_list`: github.WorkIssue); a call named in
        `fail` (FakeGitHubForReviews) raises."""
        if 'work_issues' in getattr(self, 'fail', ()):
            raise RuntimeError('gh failed (HTTP 503)')
        return list(getattr(self, 'work_list', []))

    def blocking(self, repo, number):
        """The open issues this one blocks by GitHub's dependencies: `blocks`, number -> [Issue]."""
        return list(getattr(self, 'blocks', {}).get(number, []))


def issue(number, title='A ticket', body='', open_blockers=0, open_sub_issues=0,
          open_linked_pulls=0):
    return Issue(number=number, title=title, body=body, open_blockers=open_blockers,
                 open_sub_issues=open_sub_issues, open_linked_pulls=open_linked_pulls)


def pr(number, branch, body=''):
    return PullRequest(number=number, branch=branch, body=body)


class FakeGitHubWithPulls(FakeGitHub):
    """Also answers which PR a job opened from its branch."""

    def __init__(self, *args, pulls_by_branch=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.pulls_by_branch = dict(pulls_by_branch or {})

    def pull_for_branch(self, repo, branch):
        return self.pulls_by_branch.get(branch)

    def issue(self, github, number):
        return next(i for i in self.issues if i.number == number)


class FakeGitHubForReviews(FakeGitHubWithPulls):
    """Also what the Sol lane reads (a PR's checks, conflicts, review replies, its issues and
    body) and what it posts: every write goes to `posts`, in order, as (call, args...). A call
    named in `fail` raises."""

    def __init__(self, *args, checks=None, conflicts=(), replies=None, issue_bodies=None,
                 open_issue_list=(), bodies=None, fail=(), **kwargs):
        super().__init__(*args, **kwargs)
        self.open_issue_list = list(open_issue_list)
        self.bodies = dict(bodies or {})              # PR number -> its body now
        self.fail = set(fail)
        self.posts = []
        self._next = 900
        self.check_states = dict(checks or {})        # sha -> Checks; default passed
        self.conflicts = set(conflicts)
        self.replies = dict(replies or {})            # PR number -> [Comment]
        self.issue_bodies = dict(issue_bodies or {})  # (github, number) -> Issue
        self.now = {}                # PR number -> its fields now, where they changed
        self.threads = {}            # PR number -> unresolved review threads
        self.push_before_merge = {}  # PR number -> a head pushed just before the merge call
        self.workflow_runs = {}      # Actions run id -> WorkflowRun now (issue #93)
        self.base_heads = {}         # branch -> its head now (issue #98); default MAIN_HEAD

    def checks(self, repo, sha):
        from queue_runner.github import Checks
        return self.check_states.get(sha, Checks('passed'))

    def has_conflict(self, repo, number):
        return number in self.conflicts

    def workflow_run(self, repo, run_id):
        return self.workflow_runs[run_id]

    def rerun_failed(self, repo, run_id):
        """Re-runs the run's failed jobs: its next attempt is queued, its checks pending."""
        from dataclasses import replace
        self._write('rerun', run_id)
        r = self.workflow_runs[run_id]
        self.workflow_runs[run_id] = replace(r, attempt=r.attempt + 1, status='queued',
                                             conclusion=None)

    def branch_head(self, repo, branch):
        if 'branch_head' in self.fail:
            raise RuntimeError('gh failed')
        return self.base_heads.get(branch, MAIN_HEAD)

    def update_branch(self, repo, number, expected_head):
        """GitHub's update-branch: refused (422) once the head moved, or when `update-branch` is
        in `fail` (a conflict)."""
        from queue_runner.github import GhError
        if 'update-branch' in self.fail or self.pull(repo, number).head_sha != expected_head:
            raise GhError('gh api failed (1): merge conflict between base and head (HTTP 422)')
        self.posts.append(('update-branch', number, expected_head))

    def retarget(self, repo, number, base):
        """Points the PR at `base`: GitHub works its mergeability out again."""
        self._write('retarget', number, base)
        self.now.setdefault(number, {})['base'] = base

    def close_completed(self, repo, number):
        self._write('close-done', number)
        self.close_issue(number)

    def review_replies(self, repo, number):
        return list(self.replies.get(number, []))

    def issue(self, github, number):
        return self.issue_bodies[(github, number)]

    def open_issues(self, repo):
        if 'open_issues' in self.fail:
            raise RuntimeError('gh failed')
        return list(self.open_issue_list)

    def pull_body(self, repo, number):
        return self.bodies.get(number, next((p.body for p in self.prs if p.number == number), ''))

    def _write(self, call, *args):
        if call in self.fail:
            raise RuntimeError(f'{call} failed')
        self.posts.append((call, *args))

    def post_comment(self, repo, number, body):
        self._write('comment', number, body)
        self.comments.setdefault(number, []).append(Comment('stefan1575', '2026-11-09T12:00:00Z',
                                                            body))
        self._next += 1
        return f'https://github.com/{repo.github}/pull/{number}#issuecomment-{self._next}'

    def create_issue(self, repo, title, body, labels=()):
        self._write('issue', title, body, tuple(labels))
        self._next += 1
        self.states[self._next] = 'open'
        self.open_issue_list.append(Issue(self._next, title, body,
                                          url=f'https://github.com/{repo.github}/issues/{self._next}'))
        return f'https://github.com/{repo.github}/issues/{self._next}'

    def close_issue(self, number):
        """Stefan closes an issue."""
        self.states[number] = 'closed'
        self.open_issue_list = [i for i in self.open_issue_list if i.number != number]

    def close_not_planned(self, repo, number):
        self._write('close', number)
        self.states[number] = 'closed'

    def set_status(self, repo, sha, state, description, target_url='', context='sol-review'):
        self._write('status', sha, state, description, target_url)

    def edit_pull_body(self, repo, number, body):
        self._write('body', number, body)
        self.bodies[number] = body

    def add_label(self, repo, number, label):
        self._write('label', number, label)

    def remove_label(self, repo, number, label):
        self._write('unlabel', number, label)

    # --- merging (ticket 05) ------------------------------------------------------------------

    def pull(self, repo, number):
        """The PR as listed, with what changed since (`now`: number -> fields)."""
        from dataclasses import replace
        if 'pull' in self.fail:
            raise RuntimeError('gh failed')
        p = next(p for p in self.prs if p.number == number)
        return replace(p, **self.now.get(number, {}))

    def open_threads(self, repo, number):
        return self.threads.get(number, 0)

    def merge(self, repo, number, sha):
        """GitHub's merge with an expected head: a push in `push_before_merge` lands first."""
        if number in self.push_before_merge:
            self.now.setdefault(number, {})['head_sha'] = self.push_before_merge.pop(number)
        if self.pull(repo, number).head_sha != sha:
            from queue_runner.github import GhError
            raise GhError('gh api failed (1): Head branch was modified. Review and try the merge '
                          'again. (HTTP 409)')
        self._write('merge', number, sha)
        self.now.setdefault(number, {})['state'] = 'merged'
        return 'f' * 40

    def open_pulls(self, repo):
        """The listed PRs as they are now, merged ones left out."""
        return [self.pull(repo, p.number) for p in self.prs
                if self.now.get(p.number, {}).get('state', 'open') == 'open']


def full_pr(number, branch, head_sha, body='', title='A PR', base='main', labels=()):
    return PullRequest(number=number, branch=branch, body=body, title=title, head_sha=head_sha,
                       base=base, url=f'https://github.com/owner/first/pull/{number}',
                       labels=tuple(labels))


class FakeToaster:
    """Plays the Windows toaster: each toast goes to `toasts`; with `fail`, toasting raises."""

    def __init__(self, fail=False):
        self.toasts, self.fail = [], fail

    def toast(self, title, text, url, tag='', button='Open'):
        if self.fail:
            raise RuntimeError('no toast')
        self.toasts.append({'title': title, 'text': text, 'url': url, 'tag': tag})


class FakeUsage:
    """Plays Claude's usage endpoint: each read gives the next of `reads` (the last one again
    once they run out); an exception in it is raised. Tests never read the real one. It never
    answers 429, so it may be asked at any pace: `call_every` 0 leaves `usage.CachedUsage`'s
    budget out of the tests that use it (the budget's own tests give their endpoint one)."""
    call_every = 0

    def __init__(self, *reads):
        import datetime
        from queue_runner.usage import Usage, Window
        far = datetime.datetime(2099, 1, 1, tzinfo=datetime.timezone.utc)
        self.reads = list(reads) or [Usage(Window(0, None), Window(0, far))]
        self.count = 0

    def read(self):
        got = self.reads[min(self.count, len(self.reads) - 1)]
        self.count += 1
        if isinstance(got, Exception):
            raise got
        return got


class StubEndpoint:
    """Plays `api/oauth/usage` behind a real `usage.OAuthUsage` (its `fetch`), on a test's clock:
    it answers a response shaped like the real one, or HTTP 429 when it's asked within `limit`
    seconds of its last call, as the real one does (issue 66). `fail` makes every call answer
    that status. `calls` is every call, as (time, status). Nothing calls Anthropic."""

    def __init__(self, clock, five=38, week=46, limit=60, resets=None):
        self.clock, self.five, self.week, self.limit = clock, five, week, limit
        self.resets = resets or (None, None)   # the windows' resets_at: datetimes, or None
        self.fail: int | None = None
        self.calls: list = []

    def __call__(self, request):
        import json
        import urllib.error
        now = self.clock()
        status = self.fail or (429 if self.calls and
                               (now - self.calls[-1][0]).total_seconds() < self.limit else 200)
        self.calls.append((now, status))
        if status != 200:
            raise urllib.error.HTTPError(request.full_url, status, 'stub', {}, None)
        five, week = (r.isoformat() if r else None for r in self.resets)
        return json.dumps({'five_hour': {'utilization': self.five, 'resets_at': five},
                           'seven_day': {'utilization': self.week, 'resets_at': week}}).encode()

    def oauth(self, config_dir: str):
        """A real `OAuthUsage` on this stub, with a fake login written in `config_dir`."""
        import json
        import os
        from queue_runner.usage import OAuthUsage
        with open(os.path.join(config_dir, '.credentials.json'), 'w', encoding='utf-8') as f:
            json.dump({'claudeAiOauth': {'accessToken': 'sk-fake'}}, f)
        return OAuthUsage(config_dir=config_dir, fetch=self, clock=self.clock)


class FakeLimits:
    """Plays T3's database for limit recovery: `resets` maps a thread id to the reset T3 stored
    for its runs' limit stop (None: a stop with no reset), `failures` a thread id to another
    failure class T3 recorded, `contexts` a thread id to its context in tokens, `starts` a thread
    id to when its last real request started (`default_start` for any other thread), `expires`
    a thread id to when T3 says its prompt cache expires (none: T3 reports none, issue #72).
    Tests never read the real database or a real transcript."""

    def __init__(self, resets=None, contexts=None, failures=None, starts=None,
                 default_start=None, expires=None):
        self.resets, self.contexts = dict(resets or {}), dict(contexts or {})
        self.failures, self.starts = dict(failures or {}), dict(starts or {})
        self.default_start = default_start
        self.expires = dict(expires or {})

    def cache_expires_at(self, thread_id):
        return self.expires.get(thread_id)

    def run_failure(self, thread_id, run_id):
        if thread_id in self.resets:
            reset = self.resets[thread_id]
            return {'class': 'usage_limit',
                    'resetAt': reset.isoformat().replace('+00:00', 'Z') if reset else None}
        if thread_id in self.failures:
            return {'class': self.failures[thread_id]}
        return None

    def context_tokens(self, thread_id):
        return self.contexts.get(thread_id)

    def last_call(self, thread_id):
        from queue_runner.limits import LastCall
        return LastCall(self.starts.get(thread_id, self.default_start),
                        self.contexts.get(thread_id))


class FakeScheduler:
    """Plays Task Scheduler for `wake.Waker`: `tasks` maps a wake task's name to its time, and
    `calls` records each create and delete in order; with `fail`, every call raises. Tests never
    touch the real one."""

    def __init__(self, tasks=None, fail=None):
        self.tasks, self.calls, self.fail = dict(tasks or {}), [], fail

    def _check(self):
        if self.fail:
            from queue_runner.wake import WakeError
            raise WakeError(self.fail)

    def names(self):
        self._check()
        return set(self.tasks)

    def create(self, name, when):
        self._check()
        self.calls.append(('create', name))
        self.tasks[name] = when

    def delete(self, name):
        self._check()
        self.calls.append(('delete', name))
        del self.tasks[name]

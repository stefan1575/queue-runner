"""Live check for the merge path (ticket 05), against the private GitHub sandbox
`stefan1575/queue-runner-sandbox` (cloned at `~/.queue-runner/gh-sandbox/repo`). Costs no tokens:
Sol is stubbed to reply clean, and everything else is real (gh, git, the job log, posting).

    python3 scripts/live_merge.py

1. Opens a PR from a branch made in a git worktree that plays a build job's (recorded in a job
   log of its own under `~/.queue-runner/live-merge/<time>/`), and passes a `ci` status on H.
2. Reviews H clean without merging, then pushes a second commit: the merge pass must not merge,
   and GitHub must refuse a merge that expects the old head (409).
3. Passes `ci` on the new head, reviews it clean (review 2), and lets the Sol lane merge it: the
   merge is checked on GitHub, and the build's worktree and branch must be gone.
"""
import dataclasses
import datetime
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_runner.config import Repo, load_config  # noqa: E402
from queue_runner.git import GitCli  # noqa: E402
from queue_runner.github import GhCli, GhError  # noqa: E402
from queue_runner.merge import Merger  # noqa: E402
from queue_runner.review import Reviewer  # noqa: E402
from queue_runner.state import JobLog  # noqa: E402

GITHUB = 'stefan1575/queue-runner-sandbox'
CLONE = os.path.join(os.path.expanduser('~'), '.queue-runner', 'gh-sandbox', 'repo')
CLEAN = 'Nothing to fix.\n\n```sol-findings\n{"findings": []}\n```\n'


class CleanSol:
    def review(self, brief, reply, workdir, out):
        with open(reply, 'w', encoding='utf-8') as f:
            f.write(CLEAN)
        return CLEAN.strip()


def git(*args, cwd=CLONE):
    return subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True,
                          text=True).stdout.strip()


def commit(wt, name, text, subject, branch):
    with open(os.path.join(wt, name), 'w', encoding='utf-8') as f:
        f.write(text)
    git('add', name, cwd=wt)
    git('commit', '-q', '-m', subject, cwd=wt)
    git('push', '-q', 'origin', f'HEAD:{branch}', cwd=wt)
    return git('rev-parse', 'HEAD', cwd=wt)


def check(ok, what):
    print(('PASS ' if ok else 'FAIL ') + what)
    if not ok:
        sys.exit(1)


def main() -> int:
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    home = os.path.join(os.path.expanduser('~'), '.queue-runner', 'live-merge', stamp)
    repo = Repo(name='sandbox', github=GITHUB, path=CLONE)
    config = dataclasses.replace(load_config(), repos=[repo], state_dir=os.path.join(home, 'state'),
                                 runs_dir=os.path.join(home, 'runs'),
                                 checkouts_dir=os.path.join(home, 'checkouts'))
    gh, gitcli = GhCli(), GitCli()
    jobs = JobLog(os.path.join(config.state_dir, 'jobs.jsonl'))

    # 1. A build's worktree and branch, and its PR.
    branch, wt = f'claude/live-merge-{stamp}', os.path.join(home, 'build-worktree')
    git('fetch', '-q', 'origin', 'main')
    git('worktree', 'add', '-q', '-b', branch, wt, 'origin/main')
    h1 = commit(wt, f'{stamp}.txt', 'one\n', 'Live merge check: first commit', branch)
    build = jobs.started(kind='build', repo='sandbox', issue=0, branch=branch,
                         title='Queue runner build: sandbox#0')
    jobs.ended(build.id, exit_code=0, outcome='done', worktree=wt)
    n = gh._send('POST', f'repos/{GITHUB}/pulls', {
        'title': f'Live merge check {stamp}', 'head': branch, 'base': 'main',
        'body': 'Opened by queue-runner `scripts/live_merge.py`.'})['number']
    print(f'PR #{n}: https://github.com/{GITHUB}/pull/{n}, H1 {h1[:7]}')
    gh.set_status(repo, h1, 'success', 'live check', context='ci')

    # 2. Clean on H1, then a push: no merge, and GitHub refuses the old head.
    Reviewer(config, github=gh, git=gitcli, sol=CleanSol(), jobs=jobs, say=print,
             merger=False).review_one(repo, n)
    h2 = commit(wt, f'{stamp}.txt', 'one\ntwo\n', 'Live merge check: a push after the review',
                branch)
    merger = Merger(config, github=gh, git=gitcli, jobs=jobs, say=print)
    merger.merge_pass()
    check(gh.pull(repo, n).state == 'open', f'not merged after the head moved to {h2[:7]}')
    try:
        gh.merge(repo, n, h1)
        refused = None
    except GhError as e:
        refused = str(e)
    print(f'GitHub on a merge expecting {h1[:7]}: {refused}')
    check(refused is not None and '409' in refused, 'GitHub refused the stale expected head (409)')
    check(gh.pull(repo, n).state == 'open', 'still open')

    # 3. Clean on H2 (review 2), merged by the Sol lane, worktree removed.
    gh.set_status(repo, h2, 'success', 'live check', context='ci')
    Reviewer(config, github=gh, git=gitcli, sol=CleanSol(), jobs=jobs, say=print).review_one(
        repo, n)
    pr = gh.pull(repo, n)
    check(pr.state == 'merged', f'merged ({pr.state})')
    merged = [j for j in jobs.jobs() if j.kind == 'merge']
    check([(j.outcome, j.sha) for j in merged] == [('merged', h2)], f'one merge job at {h2[:7]}')
    commit_ = gh._get(f'repos/{GITHUB}/commits/{merged[0].head}')
    check(len(commit_['parents']) == 2, 'a merge commit (two parents)')
    check(not os.path.exists(os.path.join(wt, f'{stamp}.txt')), 'the build worktree is removed')
    check(not gitcli.has_branch(CLONE, branch), 'its local branch is deleted')
    return 0


if __name__ == '__main__':
    sys.exit(main())

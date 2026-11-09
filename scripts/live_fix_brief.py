"""Live check for the fix round's start (ticket 05): print the fix brief for a real PR the runner
found blocking, and start nothing.

    python3 scripts/live_fix_brief.py NAME#N

It takes the runner's newest blocking review of the PR from its job log (read only), even if the
PR's head has moved since (it says so), and builds the brief for the reviewed head H as the
Claude lane would: the findings from the PR's ledger, the commits and files from git (after
fetching the PR's head into the runner's local ref), the earlier threads from the job log. Nothing
is posted, started or written to the job log.
"""
import dataclasses
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_runner.config import load_config  # noqa: E402
from queue_runner.fix import Fixer  # noqa: E402
from queue_runner.git import GitCli  # noqa: E402
from queue_runner.github import GhCli  # noqa: E402
from queue_runner.merge import fix_branch  # noqa: E402
from queue_runner.state import JobLog  # noqa: E402


def main(ref: str) -> int:
    name, n = ref.split('#')
    config = load_config()
    repo = next(r for r in config.repos if r.name == name)
    github, git = GhCli(), GitCli()
    jobs = JobLog(os.path.join(config.state_dir, 'jobs.jsonl'))
    fixer = Fixer(config, github=github, git=git, jobs=jobs)
    pr = github.pull(repo, int(n))
    blocking = [j for j in jobs.on('review', repo.name, pr.number, released=True)
                if j.outcome == 'blocking']
    if not blocking:
        print(f'{ref}: the runner has no blocking review of it.')
        return 1
    review = blocking[-1]
    print(f'Now: {ref} is at {pr.head_sha[:7]}; the Claude lane would say: '
          + (fixer.why_not(repo, pr) or 'start a fix round'
             if fixer.review_to_fix(repo, pr) else 'no fix round (no blocking runner review '
                                                    'of this head)'))
    git.fetch_pr(repo.path, pr.number, pr.base)
    at_h = dataclasses.replace(pr, head_sha=review.sha)
    print(f'The fix brief for review {review.round} of {review.sha[:7]} (worktree from '
          f'{review.sha[:7]} on {fix_branch(pr.number, review.sha)}, pushing to {pr.branch}):')
    print('-' * 72)
    print(fixer.brief(repo, at_h, review))
    print('-' * 72)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))

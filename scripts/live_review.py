"""Live check for the Sol lane (ticket 03): one real Sol review of a real PR's exact head, dry run.

    python3 scripts/live_review.py NAME#N

Runs `Reviewer.review` directly, so it says what adoption would decide (`why_not`) and reviews
anyway: on 2026-11-09 no open leads-dashboard PR was adoptable (each was reviewed on its head or
conflicted with main). Nothing is posted. Its job log, run folder and checkout live in
`~/.queue-runner/live-review/`, apart from the runner's own state, so this dry run never makes
the runner skip that head once reviews post (ticket 04).
"""
import dataclasses
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_runner.config import load_config  # noqa: E402
from queue_runner.git import GitCli  # noqa: E402
from queue_runner.github import GhCli  # noqa: E402
from queue_runner.lock import runner_lock  # noqa: E402
from queue_runner.review import DryRunPoster, Reviewer  # noqa: E402
from queue_runner.sol import SolCli  # noqa: E402
from queue_runner.state import JobLog  # noqa: E402

HOME = os.path.join(os.path.expanduser('~'), '.queue-runner', 'live-review')


def main(ref: str) -> int:
    name, n = ref.split('#')
    config = dataclasses.replace(load_config(), state_dir=os.path.join(HOME, 'state'),
                                 runs_dir=os.path.join(HOME, 'runs'),
                                 checkouts_dir=os.path.join(HOME, 'checkouts'))
    repo = next(r for r in config.repos if r.name == name)
    github = GhCli()
    jobs = JobLog(os.path.join(config.state_dir, 'jobs.jsonl'))
    reviewer = Reviewer(config, github=github, git=GitCli(), sol=SolCli(
        script=config.sol_script, bash=config.sol_bash), jobs=jobs, say=print,
        poster=DryRunPoster(print))   # a live check posts nothing
    pr = next(p for p in github.open_pulls(repo) if p.number == int(n))
    print(f'Adoption would say: {reviewer.why_not(repo, pr) or "review it"}')
    with runner_lock(config.state_dir, 'sol.lock'):
        reviewer.review(repo, pr)
    print(dataclasses.asdict(jobs.jobs()[-1]))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))

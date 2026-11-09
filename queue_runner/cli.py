"""The runner's command line.

    python -m queue_runner                    # run: pass after pass (what logon will start)
    python -m queue_runner --once             # one pass of each lane: settle, at most one build
                                              # and at most one Sol review
    python -m queue_runner --once --dry-run   # name the next build and the PRs Sol would review
    python -m queue_runner --release NAME#N   # let the picker take a held issue again
    python -m queue_runner --review NAME#N    # Sol reviews that PR's head now
"""
import argparse
import datetime
import os
import re
import sys
import time

from .brief import build_brief
from .config import DEFAULT_CONFIG, load_config
from .run import Runner, RunnerBusy, runner_lock
from .state import JobLog

EXIT_LOCKED = 3


def _logger(config):
    def log_line(line: str) -> None:
        os.makedirs(config.log_dir, exist_ok=True)
        stamp = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
        with open(os.path.join(config.log_dir, 'runner.log'), 'a', encoding='utf-8') as f:
            f.write(f'{stamp} {line}\n')
    return log_line


def _jobs(config) -> JobLog:
    return JobLog(os.path.join(config.state_dir, 'jobs.jsonl'))


def _dry_run(config, github, out, log_line) -> int:
    _dry_run_build(config, github, out, log_line)
    _dry_run_reviews(config, github, out)
    return 0


def _dry_run_build(config, github, out, log_line) -> None:
    from .picker import pick
    jobs = _jobs(config)
    for repo in config.repos:
        if not repo.github:
            continue
        job = pick(repo, github, held=jobs.held_issues(repo.name))
        if job is None:
            continue
        brief = build_brief(job, github.issue_comments(repo, job.issue.number))
        log_line(f'dry run: would build {repo.github}#{job.issue.number} on {job.branch}')
        print('Would start a build job (dry run: nothing started)', file=out)
        print(f'  repo:   {repo.github} ({repo.path})', file=out)
        print(f'  issue:  #{job.issue.number} {job.issue.title}', file=out)
        print(f'  branch: {job.branch} from {job.base}', file=out)
        print('  brief:', file=out)
        print('-' * 72, file=out)
        print(brief, file=out)
        print('-' * 72, file=out)
        return
    log_line('dry run: nothing to start')
    print('Nothing to start: no repo has an unblocked ready-for-agent issue that isn\'t already '
          'being built or held.', file=out)


def _dry_run_reviews(config, github, out) -> None:
    from .ledger import next_round, read_reviews
    from .review import Reviewer
    reviewer = Reviewer(config, github=github, git=None, sol=None, jobs=_jobs(config),
                        say=lambda line: None)
    print('Sol reviews (dry run: Sol not started):', file=out)
    for repo in config.repos:
        if not repo.github:
            continue
        for pr, why in reviewer.candidates(repo):
            if why:
                print(f'  {repo.name}#{pr.number}: not now, {why}', file=out)
            else:
                rnd = next_round(read_reviews(github.issue_comments(repo, pr.number)))
                print(f'  {repo.name}#{pr.number}: would review #{pr.number} on '
                      f'{pr.head_sha[:7]} (review {rnd})', file=out)


def _repo_ref(value, config, flag, out):
    """NAME#N from the command line: (repo, N), or None after saying what's wrong."""
    m = re.fullmatch(r'([\w.-]+)#(\d+)', value)
    repos = {r.name: r for r in config.repos}
    if not m or m[1] not in repos:
        print(f'{flag} takes NAME#N with NAME one of the repos in the config.', file=out)
        return None
    return repos[m[1]], int(m[2])


def _review(config, github, git, sol, value, out, log_line) -> int:
    """`--review NAME#N`: one Sol review now, under sol.lock, if the PR needs one."""
    from .review import Reviewer
    ref = _repo_ref(value, config, '--review', out)
    if ref is None:
        return 2

    def say(line):
        log_line(line)
        print(line, file=out)
    reviewer = Reviewer(config, github=github, git=git, sol=sol, jobs=_jobs(config), say=say)
    try:
        _, why = reviewer.review_one(*ref)
    except RunnerBusy:
        print('Another Sol job is running (sol.lock): one at a time.', file=out)
        return EXIT_LOCKED
    if why:
        print(f'{value}: not reviewed: {why}.', file=out)
        return 1
    return 0


def main(argv=None, github=None, out=None, t3=None, git=None, sleep=time.sleep,
         sol=None) -> int:
    out = out or sys.stdout
    parser = argparse.ArgumentParser(prog='queue_runner')
    parser.add_argument('--once', action='store_true', help='one pass, then exit')
    parser.add_argument('--dry-run', action='store_true', help='print what it would do; start nothing')
    parser.add_argument('--release', metavar='NAME#N',
                        help='let the picker take a held issue again (NAME is the repo in config)')
    parser.add_argument('--review', metavar='NAME#N',
                        help="have Sol review that PR's head now (nothing is posted yet)")
    parser.add_argument('--config', default=DEFAULT_CONFIG)
    args = parser.parse_args(argv)
    if args.dry_run and not args.once:
        print('--dry-run goes with --once.', file=out)
        return 2

    config = load_config(args.config)
    log_line = _logger(config)

    if args.release:
        ref = _repo_ref(args.release, config, '--release', out)
        if ref is None:
            return 2
        _jobs(config).released(ref[0].name, ref[1])
        log_line(f'released {args.release}')
        print(f'Released {args.release}: the picker may take it again, and the Sol lane may '
              'review it again if its reviews failed.', file=out)
        return 0

    if github is None:
        from .github import GhCli
        github = GhCli()
    if args.dry_run:
        return _dry_run(config, github, out, log_line)

    if git is None:
        from .git import GitCli
        git = GitCli()
    if sol is None:
        from .sol import SolCli
        sol = SolCli(script=config.sol_script, bash=config.sol_bash)
    if args.review:
        return _review(config, github, git, sol, args.review, out, log_line)

    if t3 is None:
        from .t3 import T3Cli
        t3 = T3Cli()
    runner = Runner(config, github=github, t3=t3, git=git, out=out, log_line=log_line, sol=sol)
    try:
        with runner_lock(config.state_dir):
            if args.once:
                runner.run_once()
            else:
                log_line('runner started')
                runner.run_forever(sleep)
    except RunnerBusy as e:
        print(f'A queue runner is already running ({e}).', file=out)
        return EXIT_LOCKED
    return 0

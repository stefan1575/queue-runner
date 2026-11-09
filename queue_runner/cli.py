"""The runner's command line.

    python -m queue_runner                    # run: pass after pass (what logon will start)
    python -m queue_runner --once             # one pass: settle, then start at most one job
    python -m queue_runner --once --dry-run   # name the next build job and print its brief
    python -m queue_runner --release NAME#N   # let the picker take a held issue again
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


def _dry_run(config, github, out, log_line) -> int:
    from .picker import pick
    jobs = JobLog(os.path.join(config.state_dir, 'jobs.jsonl'))
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
        return 0
    log_line('dry run: nothing to start')
    print('Nothing to start: no repo has an unblocked ready-for-agent issue that isn\'t already '
          'being built or held.', file=out)
    return 0


def main(argv=None, github=None, out=None, t3=None, git=None, sleep=time.sleep) -> int:
    out = out or sys.stdout
    parser = argparse.ArgumentParser(prog='queue_runner')
    parser.add_argument('--once', action='store_true', help='one pass, then exit')
    parser.add_argument('--dry-run', action='store_true', help='print what it would do; start nothing')
    parser.add_argument('--release', metavar='NAME#N',
                        help='let the picker take a held issue again (NAME is the repo in config)')
    parser.add_argument('--config', default=DEFAULT_CONFIG)
    args = parser.parse_args(argv)
    if args.dry_run and not args.once:
        print('--dry-run goes with --once.', file=out)
        return 2

    config = load_config(args.config)
    log_line = _logger(config)

    if args.release:
        m = re.fullmatch(r'([\w.-]+)#(\d+)', args.release)
        if not m or m[1] not in {r.name for r in config.repos}:
            print(f'--release takes NAME#N with NAME one of the repos in {args.config}.', file=out)
            return 2
        JobLog(os.path.join(config.state_dir, 'jobs.jsonl')).released(m[1], int(m[2]))
        log_line(f'released {args.release}')
        print(f'Released {args.release}: the picker may take it again.', file=out)
        return 0

    if github is None:
        from .github import GhCli
        github = GhCli()
    if args.dry_run:
        return _dry_run(config, github, out, log_line)

    if t3 is None:
        from .t3 import T3Cli
        t3 = T3Cli()
    if git is None:
        from .git import GitCli
        git = GitCli()
    runner = Runner(config, github=github, t3=t3, git=git, out=out, log_line=log_line)
    try:
        with runner_lock(config.state_dir):
            if args.once:
                runner.run_pass()
            else:
                log_line('runner started')
                runner.run_forever(sleep)
    except RunnerBusy as e:
        print(f'A queue runner is already running ({e}).', file=out)
        return EXIT_LOCKED
    return 0

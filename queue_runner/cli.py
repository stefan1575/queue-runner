"""`python -m queue_runner --once --dry-run`: name the job the runner would start next."""
import argparse
import datetime
import os
import sys

from .brief import build_brief
from .config import DEFAULT_CONFIG, load_config
from .github import GhCli
from .picker import pick


def _log(config, line: str) -> None:
    os.makedirs(config.log_dir, exist_ok=True)
    stamp = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
    with open(os.path.join(config.log_dir, 'runner.log'), 'a', encoding='utf-8') as f:
        f.write(f'{stamp} {line}\n')


def main(argv=None, github=None, out=None) -> int:
    out = out or sys.stdout
    parser = argparse.ArgumentParser(prog='queue_runner')
    parser.add_argument('--once', action='store_true', help='one pass, then exit')
    parser.add_argument('--dry-run', action='store_true', help='print what it would do; start nothing')
    parser.add_argument('--config', default=DEFAULT_CONFIG)
    args = parser.parse_args(argv)
    if not (args.once and args.dry_run):
        print('Only `--once --dry-run` is built so far: it starts nothing.', file=out)
        return 2

    config = load_config(args.config)
    github = github or GhCli()
    for repo in config.repos:
        job = pick(repo, github)
        if job is None:
            continue
        brief = build_brief(job, github.issue_comments(repo, job.issue.number))
        _log(config, f'dry run: would build {repo.github}#{job.issue.number} on {job.branch}')
        print('Would start a build job (dry run: nothing started)', file=out)
        print(f'  repo:   {repo.github} ({repo.path})', file=out)
        print(f'  issue:  #{job.issue.number} {job.issue.title}', file=out)
        print(f'  branch: {job.branch} from {job.base}', file=out)
        print('  brief:', file=out)
        print('-' * 72, file=out)
        print(brief, file=out)
        print('-' * 72, file=out)
        return 0

    _log(config, 'dry run: nothing to start')
    print('Nothing to start: no repo has an unblocked ready-for-agent issue that isn\'t already '
          'being built.', file=out)
    return 0

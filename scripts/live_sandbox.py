"""Live check of a build job against the sandbox (ticket 02): a real T3 thread in a real T3
worktree, through `Runner.run_build`, on a hand-made issue. Costs one small Haiku thread. Its
record's `effort` is the effort the run used, read back (ticket 39).

    python3 scripts/live_sandbox.py

The sandbox is `~/.queue-runner/sandbox/repo` (a T3 project; its `origin` is the bare repo
`../origin.git`). Its job log is `~/.queue-runner/sandbox/state/jobs.jsonl`, apart from the
runner's own state. It has no GitHub, so the picker is skipped and no PR is looked for.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_runner.config import DEFAULT_JOBS, Config, JobSpec, Repo  # noqa: E402
from queue_runner.effort import Effort, T3Files  # noqa: E402
from queue_runner.git import GitCli  # noqa: E402
from queue_runner.github import Issue  # noqa: E402
from queue_runner.picker import BuildJob, slug  # noqa: E402
from queue_runner.run import Runner  # noqa: E402
from queue_runner.t3 import T3Cli  # noqa: E402
from queue_runner.t3_mcp import T3Mcp  # noqa: E402

SANDBOX = os.path.join(os.path.expanduser('~'), '.queue-runner', 'sandbox')

ISSUE = Issue(number=1, title='Add a line to README', body=(
    'Add the line `Checked by the queue runner live test.` at the end of `README.md`, commit it, '
    'and push the branch to `origin`. This repo has no GitHub: there is no PR to open and no '
    'issue to comment on. No tests and no review: it is one line.'))


class NoGitHub:
    def issue_comments(self, repo, number):
        return []


def main() -> int:
    repo = Repo(name='sandbox', github=None, path=os.path.join(SANDBOX, 'repo'), base='main')
    config = Config(repos=[repo], state_dir=os.path.join(SANDBOX, 'state'),
                    log_dir=os.path.join(SANDBOX, 'logs'),
                    jobs={**DEFAULT_JOBS, 'build': JobSpec('claudeAgent', 'claude-haiku-5-5',
                                                           'high')})
    log_dir = config.log_dir

    def log_line(line):
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, 'runner.log'), 'a', encoding='utf-8') as f:
            f.write(line + '\n')

    # The effort (ticket 39; #119): it starts on Haiku at the config's effort, named in T3's MCP
    # launch, and the record's `effort` is read back.
    effort = Effort(config, files=T3Files())
    # Its thread is settled at its end, as the runner's are (ticket 70; review 1's N5): signing in
    # revokes the running runner's older session, and it signs in again on its next settle.
    runner = Runner(config, github=NoGitHub(), t3=T3Cli(mcp=T3Mcp()), git=GitCli(),
                    out=sys.stdout, log_line=log_line, effort=effort)
    build = BuildJob(repo=repo, issue=ISSUE, base='origin/main',
                     branch=f'claude/{slug(ISSUE.title)}-{ISSUE.number}')
    runner.run_build(build)
    record = runner.jobs.jobs()[-1]
    print(json.dumps(record.__dict__, indent=2, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())

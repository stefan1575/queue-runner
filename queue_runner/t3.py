"""T3 Code as the runner sees it: the `t3` CLI (`~/.t3/bin/t3.cmd`) and its `--json` output.

`thread start|send --wait --json` blocks until the run ends and always prints
`{threadId, runId, status, reply, error}` once a thread exists. It exits 0 when the run
completed, 2 when the agent waits for an answer (status `waiting`), and 1 when the run ended any
other way (failed, interrupted, cancelled...). It also exits 1, printing nothing on stdout, when
T3 itself fails before or while waiting (server not running, unknown project): that's `T3Error`.
"""
import json
import os
import re
from dataclasses import dataclass

T3_CMD = os.path.join(os.path.expanduser('~'), '.t3', 'bin', 't3.cmd')

# Run statuses (T3's OrchestrationV2RunStatus); a thread with none is `idle`.
ACTIVE = frozenset({'preparing', 'queued', 'starting', 'running'})

# `t3.cmd` is a batch file, so cmd.exe parses its arguments: keep them free of its specials.
# Messages go on stdin and never pass through cmd.
_CMD_SPECIALS = re.compile(r'[&|<>^%"!\r\n]')


class T3Error(RuntimeError):
    """T3 failed without starting or finishing a run it can report (no JSON on stdout)."""


@dataclass(frozen=True)
class RunResult:
    exit_code: int        # 0 completed, 1 ended otherwise, 2 waiting for an answer
    thread_id: str
    run_id: str | None
    status: str
    reply: str | None
    error: str | None


@dataclass(frozen=True)
class Thread:
    thread_id: str
    title: str
    link: str
    status: str
    settled: bool
    created_at: str
    latest_run_id: str | None = None
    model: str | None = None
    branch: str | None = None          # `thread show` only
    worktree_path: str | None = None   # `thread show` only
    pending_requests: int = 0          # `thread show` only

    @property
    def active(self) -> bool:
        return self.status in ACTIVE


@dataclass(frozen=True)
class Message:
    role: str   # user | assistant
    text: str
    run_id: str | None = None   # the run that wrote it


def run_t3(args: list[str], stdin: str | None = None) -> tuple[int, str, str]:
    """Runs the `t3` CLI with no console window (the runner lives under pythonw). No timeout:
    `--wait` blocks for as long as the job runs."""
    import subprocess
    p = subprocess.run([T3_CMD, *args], input=stdin if stdin is not None else '',
                       capture_output=True, text=True, encoding='utf-8', errors='replace',
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return p.returncode, p.stdout, p.stderr


def _thread(raw: dict) -> Thread:
    return Thread(thread_id=raw['threadId'], title=raw['title'], link=raw['link'],
                  status=raw['status'], settled=bool(raw.get('settled')),
                  created_at=raw['createdAt'], latest_run_id=raw.get('latestRunId'),
                  model=raw.get('model'), branch=raw.get('branch'),
                  worktree_path=raw.get('worktreePath'),
                  pending_requests=raw.get('pendingRequestCount') or 0)


class T3Cli:
    """`run(args, stdin)` returns the CLI's (exit code, stdout, stderr)."""

    def __init__(self, run=run_t3):
        self._run = run

    def _call(self, args, stdin=None):
        for a in args:
            if _CMD_SPECIALS.search(a):
                raise ValueError(f'unsafe argument for t3.cmd: {a!r}')
        return self._run(args, stdin)

    def _json(self, args, stdin=None):
        code, out, err = self._call(args, stdin)
        if code:
            raise T3Error(f"t3 {' '.join(args[:2])} failed ({code}): {err.strip()}")
        return json.loads(out)

    def _run_result(self, args, message) -> RunResult:
        code, out, err = self._call(args, message)
        try:
            raw = json.loads(out)
        except ValueError:
            raise T3Error(f"t3 {' '.join(args[:2])} failed ({code}), no result: {err.strip()}")
        return RunResult(exit_code=code, thread_id=raw['threadId'], run_id=raw.get('runId'),
                         status=raw['status'], reply=raw.get('reply'), error=raw.get('error'))

    def start(self, project: str, message: str, *, title: str, provider: str | None = None,
              model: str | None = None, worktree: str | None = None,
              branch: str | None = None) -> RunResult:
        """Starts a thread and blocks until its run ends. `worktree` is the base ref of a new T3
        worktree, `branch` the branch T3 makes there."""
        args = ['thread', 'start', '--wait', '--json', '--title', title]
        if provider:
            args += ['--provider', provider, '--model', model]
        if worktree:
            args += ['--worktree', worktree]
        if branch:
            args += ['--branch', branch]
        return self._run_result(args + [project, '-'], message)

    def send(self, thread_id: str, message: str) -> RunResult:
        """Sends a message and blocks until the run it starts ends."""
        return self._run_result(['thread', 'send', '--wait', '--json', thread_id, '-'], message)

    def show(self, thread_id: str, messages: int = 3) -> tuple[Thread, list[Message]]:
        raw = self._json(['thread', 'show', '--messages', str(messages), '--json', thread_id])
        return _thread(raw['thread']), [Message(m['role'], m['text'], m.get('runId'))
                                           for m in raw['messages']]

    def list(self, project: str) -> list[Thread]:
        return [_thread(t) for t in self._json(['thread', 'list', '--json', '--project', project])]

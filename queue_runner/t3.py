"""T3 Code as the runner sees it: the `t3` CLI (`~/.t3/bin/t3.cmd`) and its `--json` output,
and T3's MCP endpoint for what the CLI can't do: start a thread with its effort named (issue
#119), settle, rename (docs/t3.md).

`start` launches through MCP and waits as the CLI's `--wait` does, giving the same result.
`thread send --wait --json` blocks until the run ends and always prints
`{threadId, runId, status, reply, error}` once a thread exists. It exits 0 when the run
completed, 2 when the agent waits for an answer (status `waiting`), and 1 when the run ended any
other way (failed, interrupted, cancelled...). It also exits 1, printing nothing on stdout, when
T3 itself fails before or while waiting (server not running, unknown project): that's `T3Error`.
"""
import datetime
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


# The option a driver reads its effort from (`runtimeLayer-*.mjs` in T3's server.asar, read
# 2026-11-17; checked live: docs/t3.md). Codex ignores `effort`.
EFFORT_OPTION = {'codex': 'reasoningEffort'}
WAIT_SLICE_MS = 15_000   # T3's CLI waits in 15-second slices, so a run that asks is noticed soon


def selection(provider: str, model: str, effort: str) -> dict:
    """T3's model selection for `provider`'s `model` at `effort`."""
    return {'instanceId': provider, 'model': model,
            'options': [{'id': EFFORT_OPTION.get(provider, 'effort'), 'value': effort}]}


def _same_folder(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


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
class Launched:
    """A thread `start` without `--wait` started: `{threadId, projectId, runId}`."""
    thread_id: str
    run_id: str | None


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


def find_job_thread(t3, job, project: str | None) -> Thread | None:
    """A job's T3 thread (`thread show`): by its `thread_id`, else by its title among the
    threads of `project` created after the job's start record (5 seconds' slack), the newest.
    None when there's none, or no project to look in. T3Error propagates."""
    if job.thread_id:
        return t3.show(job.thread_id)[0]
    if project is None:
        return None
    from .state import when
    since = when(job.started_at) - datetime.timedelta(seconds=5)
    found = [t for t in t3.list(project)
             if t.title == job.title and when(t.created_at) >= since]
    if not found:
        return None
    newest = max(found, key=lambda t: when(t.created_at))
    return t3.show(newest.thread_id)[0]


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
    """`run(args, stdin)` returns the CLI's (exit code, stdout, stderr). Starting a thread,
    settling and renaming go to `mcp`, T3's MCP endpoint called directly (`t3_mcp.T3Mcp`):
    the CLI has no settle or rename command (ticket 70), and its `thread start` can't name an
    effort (issue #119). With no `mcp`, they raise T3Error."""

    def __init__(self, run=run_t3, mcp=None):
        self._run = run
        self.mcp = mcp

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

    # --- a job's thread, through T3's MCP (issue #119; docs/t3.md) -------------------------

    def _mcp(self):
        if self.mcp is None:
            raise T3Error("starting a thread needs T3's MCP endpoint (no MCP client given)")
        return self.mcp

    def _project(self, folder: str) -> str:
        """The id of the T3 project whose folder is `folder`."""
        mcp, cursor = self._mcp(), 0
        while cursor is not None:
            page = mcp.call('t3_project_list', {'cursor': cursor, 'limit': 100}) or {}
            for p in page.get('projects') or ():
                if p.get('workspaceRoot') and _same_folder(p['workspaceRoot'], folder):
                    return p['id']
            cursor = page.get('nextCursor')
        raise T3Error(f'No T3 Code project matches {folder!r}')

    def _launch(self, project, message, title, provider, model, effort, worktree, branch):
        """`t3_thread_launch` with the model and its effort named: `{threadId, runId, ...}`."""
        if branch and not worktree:
            raise ValueError('a branch needs a worktree base')
        arguments = {'projectId': self._project(project), 'title': title, 'message': message,
                     'runtimeMode': 'full-access',
                     'modelSelection': selection(provider, model, effort)}
        if worktree:   # as the CLI's --worktree and --branch (`launchWorkspaceStrategy`)
            arguments['workspaceStrategy'] = {'type': 'worktree', 'baseRef': worktree,
                                              **({'branch': branch} if branch else {})}
        launched = self._mcp().call('t3_thread_launch', arguments)
        if not isinstance(launched, dict) or not launched.get('threadId'):
            raise T3Error(f't3_thread_launch started no thread: {launched!r}'[:300])
        return launched

    def start(self, project: str, message: str, *, title: str, provider: str, model: str,
              effort: str, worktree: str | None = None, branch: str | None = None) -> RunResult:
        """Starts a thread on `provider`'s `model` at `effort` and blocks until its run ends.
        `worktree` is the base ref of a new T3 worktree, `branch` the branch T3 makes there."""
        launched = self._launch(project, message, title, provider, model, effort, worktree,
                                branch)
        thread_id, run_id = launched['threadId'], launched.get('runId')
        if not run_id:
            raise T3Error(f'T3 started thread {thread_id} with no run')
        return self._finish(thread_id, run_id)

    def launch(self, project: str, message: str, *, title: str, provider: str, model: str,
               effort: str) -> Launched:
        """Starts a thread in the project folder on `provider`'s `model` at `effort` and
        returns at once."""
        launched = self._launch(project, message, title, provider, model, effort, None, None)
        return Launched(thread_id=launched['threadId'], run_id=launched.get('runId'))

    def _wait(self, thread_id: str, run_id: str, timeout_ms: int) -> dict:
        return self._mcp().call('t3_thread_wait', {'threadId': thread_id, 'runId': run_id,
                                                   'timeoutMs': timeout_ms}) or {}

    def _finish(self, thread_id: str, run_id: str) -> RunResult:
        """Waits for the run as `t3 thread start --wait --json` does (`waitForRun` and
        `finishRun` in T3's binCli): slices of `t3_thread_wait`; a pending request after a
        timed-out slice is a run waiting for an answer, unless one more short wait ends it."""
        while True:
            waited = self._wait(thread_id, run_id, WAIT_SLICE_MS)
            if not waited.get('timedOut'):
                break
            read = self._mcp().call('t3_thread_read', {'threadId': thread_id, 'limit': 1,
                                                       'runLimit': 1}) or {}
            if (read.get('thread') or {}).get('pendingRequestCount'):
                waited = self._wait(thread_id, run_id, 1)
                if waited.get('timedOut'):
                    return RunResult(exit_code=2, thread_id=thread_id, run_id=run_id,
                                     status='waiting', reply=None, error=None)
                break
        run_id = waited.get('runId') or run_id
        status = waited.get('status') or 'unknown'
        done = status == 'completed'
        return RunResult(exit_code=0 if done else 1, thread_id=thread_id, run_id=run_id,
                         status=status,
                         reply=self._run_text(thread_id, run_id, 'assistant_message')
                         if done else None,
                         error=None if done else self._run_text(thread_id, run_id, 'error'))

    def _run_text(self, thread_id: str, run_id: str, kind: str) -> str | None:
        """The run's last `kind` item's full text (`runResultText` in T3's binCli)."""
        mcp, items, after = self._mcp(), [], None
        view = 'messages' if kind == 'assistant_message' else 'activity'
        while True:
            page = mcp.call('t3_thread_read', {
                'threadId': thread_id, 'view': view, 'limit': 100, 'runLimit': 1,
                **({} if after is None else {'afterPosition': after})}) or {}
            items += page.get('items') or []
            after = page.get('nextPosition')
            if not page.get('hasMore') or after is None:
                break
        found = [i for i in items if i.get('runId') == run_id and i.get('type') == kind]
        if not found:
            return None
        last = found[-1]
        text = last.get('text') or ''
        offset = last.get('nextTextOffset') if last.get('textTruncated') else None
        while offset is not None:
            page = mcp.call('t3_thread_read', {'threadId': thread_id, 'itemId': last['itemId'],
                                               'textOffset': offset, 'runLimit': 1}) or {}
            chunk = next((i for i in page.get('items') or ()
                          if i.get('itemId') == last['itemId']), None)
            if chunk is None:
                break
            text += chunk.get('text') or ''
            offset = chunk.get('nextTextOffset') if chunk.get('textTruncated') else None
        return text

    def send(self, thread_id: str, message: str) -> RunResult:
        """Sends a message and blocks until the run it starts ends."""
        return self._run_result(['thread', 'send', '--wait', '--json', thread_id, '-'], message)

    def show(self, thread_id: str, messages: int = 3) -> tuple[Thread, list[Message]]:
        raw = self._json(['thread', 'show', '--messages', str(messages), '--json', thread_id])
        return _thread(raw['thread']), [Message(m['role'], m['text'], m.get('runId'))
                                           for m in raw['messages']]

    def list(self, project: str) -> list[Thread]:
        return [_thread(t) for t in self._json(['thread', 'list', '--json', '--project', project])]

    def settle(self, thread_id: str) -> None:
        """Settles a thread the runner started: it leaves T3's sidebar and stays readable."""
        if self.mcp is None:
            raise T3Error("settling a thread needs T3's MCP endpoint (no MCP client given)")
        self.mcp.settle(thread_id)

    def rename(self, thread_id: str, title: str) -> None:
        if self.mcp is None:
            raise T3Error("renaming a thread needs T3's MCP endpoint (no MCP client given)")
        self.mcp.rename(thread_id, title)


def settle_quietly(t3, thread_id: str | None, name: str, say) -> bool:
    """Settles a thread the runner started, once it's done with it (ticket 70): it leaves
    Stefan's sidebar and stays readable. A failure is said and never raised: a thread left in
    the sidebar stops no lane. False if it wasn't settled."""
    if not thread_id or t3 is None:
        return False
    try:
        t3.settle(thread_id)
    except Exception as e:   # noqa: BLE001 - T3 down, refused, or no MCP client
        say(f'{name}: settling its thread {thread_id} in T3 failed '
            f'({type(e).__name__}: {e}); left as it is')
        return False
    return True

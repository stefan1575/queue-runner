"""Today's runner settling a thread across the app's sign-ins (#149, review 1's F2), for the app's
live check (`app/live/sign-in.ts` starts it; it isn't run on its own). In the "queue-runner
sandbox" project only: never a served repo. It costs no tokens: its thread is launched idle.

1. Signs in exactly as the runner does (`t3_mcp.T3Mcp`, label "Queue runner") and launches an
   idle `full-access` thread with that session, then prints one JSON line:
   `{"thread": ..., "session": ...}`.
2. Waits for a line on stdin: the app signs in meanwhile.
3. Settles the thread with the same `T3Mcp` and its token from step 1, reads it back with
   `t3 thread show`, archives it and revokes its own session, then prints one JSON line:
   `{"settled": bool, "signedInAgain": bool, "error": str|null}`. `signedInAgain` is whether
   T3 refused the step-1 token, so the settle needed a fresh sign-in: the failure this checks.

Its sign-in revokes the running runner's older session, as any runner sign-in does
(`live_mcp.py`): a running runner signs in again on its next settle.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from live_mcp import MODEL, sandbox_project  # noqa: E402 - this folder's sibling check
from queue_runner.t3 import T3Cli, T3Error, run_t3  # noqa: E402
from queue_runner.t3_mcp import LABEL, T3Mcp  # noqa: E402


class Counted(T3Mcp):
    """The runner's client, counting its sign-ins."""
    mints = 0

    def _mint(self, origin):
        self.mints += 1
        return super()._mint(origin)


def say(**fields) -> None:
    print(json.dumps(fields), flush=True)


def newest_session() -> str:
    sessions = [s for s in json.loads(run_t3(['auth', 'session', 'list', '--json'])[1])
                if s.get('subject') == 'mcp-client'
                and (s.get('client') or {}).get('label') == LABEL]
    return max(sessions, key=lambda s: s.get('issuedAt') or '')['sessionId']


def main() -> int:
    mcp = Counted()
    cli = T3Cli(mcp=mcp)
    project = sandbox_project(mcp)   # signs in: the first call mints the session
    session = newest_session()
    thread_id = mcp.call('t3_thread_launch', {
        'projectId': project, 'title': 'Queue runner app check (idle)',
        'runtimeMode': 'full-access', 'modelSelection': MODEL})['threadId']
    say(thread=thread_id, session=session)
    sys.stdin.readline()
    error, settled = None, False
    before = mcp.mints
    try:
        cli.settle(thread_id)
        settled = cli.show(thread_id, 1)[0].settled
    except T3Error as e:
        error = str(e)
    again = mcp.mints > before
    try:
        mcp.call('t3_thread_organize', {'threadId': thread_id, 'action': 'archive'})
    finally:
        for s in {session, newest_session()}:
            run_t3(['auth', 'session', 'revoke', s])
    say(settled=settled, signedInAgain=again, error=error)
    return 0


if __name__ == '__main__':
    sys.exit(main())

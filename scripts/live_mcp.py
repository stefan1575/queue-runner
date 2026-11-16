"""Live check of T3's MCP endpoint, called directly (ticket 70), in the sandbox project only:
never a served repo. It costs no tokens: its one thread is launched idle, with no message.

    python3 scripts/live_mcp.py

1. Signs in as the runner does (`t3_mcp.T3Mcp`: a pairing code, then T3's OAuth flow) and says
   what the session can do.
2. Launches an idle `full-access` thread in "queue-runner sandbox" with that session: whether
   such a token can launch full-access threads (the TypeScript rebuild needs it).
3. Tries to settle it with a token from `t3 auth session issue --subject mcp-client` instead,
   which T3 refuses (no runtime-mode ceiling: approval-required), then revokes that session.
4. Settles it with the runner's session, reads it back with `t3 thread show` (settled, still
   readable), renames it, and archives it.

Signing in revokes the runner's older sessions, as any new sign-in does: a running runner
signs in again on its next settle (T3 refuses the old token, once). This check's own session is
revoked at the end.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_runner.config import load_config  # noqa: E402
from queue_runner.t3 import T3Cli, T3Error, run_t3  # noqa: E402
from queue_runner.t3_mcp import LABEL, T3Mcp  # noqa: E402

SANDBOX = os.path.join(os.path.expanduser('~'), '.queue-runner', 'sandbox', 'repo')
MODEL = {'instanceId': 'claudeAgent', 'model': 'claude-haiku-5-5'}


def same(a: str, b: str) -> bool:
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def sandbox_project(mcp: T3Mcp) -> str:
    page = mcp.call('t3_project_list', {'cursor': 0, 'limit': 100})
    found = [p for p in page['projects'] if same(p['workspaceRoot'], SANDBOX)]
    if not found:
        raise SystemExit(f'No T3 project at {SANDBOX}: make the sandbox first (live_sandbox.py)')
    try:   # never a served repo
        served = [r.path for r in load_config().repos]
    except Exception:   # noqa: BLE001 - no config: nothing is served from here
        served = []
    if any(same(SANDBOX, p) for p in served):
        raise SystemExit('The sandbox is a served repo: refusing')
    return found[0]['id']


def check(label: str, ok: bool, detail: str = '') -> bool:
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + (f': {detail}' if detail else ''))
    return ok


def main() -> int:
    mcp = T3Mcp()
    cli = T3Cli(mcp=mcp)
    good = True
    project = sandbox_project(mcp)   # signs in: the first call mints the session
    sessions = [s for s in json.loads(run_t3(['auth', 'session', 'list', '--json'])[1])
                if s.get('subject') == 'mcp-client'
                and (s.get('client') or {}).get('label') == LABEL]
    newest = max(sessions, key=lambda s: s.get('issuedAt') or '')
    good &= check('signed in through the OAuth flow', True,
                  f"session {newest['sessionId']}, scopes {', '.join(newest['scopes'])}, "
                  f"expires {newest['expiresAt']}")

    launched = mcp.call('t3_thread_launch', {
        'projectId': project, 'title': 'Queue runner MCP check (idle)',
        'runtimeMode': 'full-access', 'modelSelection': MODEL})
    thread_id = launched['threadId']
    thread, _ = cli.show(thread_id, 1)
    good &= check('launched an idle full-access thread', True, f'{thread_id} {thread.link}')

    code, out, err = run_t3(['auth', 'session', 'issue', '--subject', 'mcp-client',
                             '--scope', 'orchestration:read', '--scope', 'orchestration:operate',
                             '--ttl', '5m', '--label', 'Queue runner MCP check', '--json'])
    if code:
        good &= check('t3 auth session issue', False, err.strip())
    else:
        issued = json.loads(out)

        class Issued(T3Mcp):   # the same calls, with that token instead of a sign-in
            def _mint(self, origin):
                return issued['token']
        try:
            Issued().settle(thread_id)
            good &= check("t3 auth session issue's token is refused a full-access thread", False,
                          'it settled it')
        except T3Error as e:
            good &= check("t3 auth session issue's token is refused a full-access thread",
                          'runtime_mode_escalation_denied' in str(e), str(e))
        finally:
            run_t3(['auth', 'session', 'revoke', issued['sessionId']])

    cli.settle(thread_id)
    thread, said = cli.show(thread_id, 3)
    good &= check('settled, and still read by t3 thread show', thread.settled,
                  f'settled={thread.settled}, {len(said)} messages')
    cli.rename(thread_id, 'Queue runner MCP check (renamed)')
    thread, _ = cli.show(thread_id, 1)
    good &= check('renamed', thread.title == 'Queue runner MCP check (renamed)', thread.title)
    mcp.call('t3_thread_organize', {'threadId': thread_id, 'action': 'archive'})
    print(f'archived {thread_id}')
    run_t3(['auth', 'session', 'revoke', newest['sessionId']])
    print(f"revoked this check's session {newest['sessionId']}")
    return 0 if good else 1


if __name__ == '__main__':
    sys.exit(main())

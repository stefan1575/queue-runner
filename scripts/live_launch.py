"""Live check of a launch through T3's MCP with an explicit model and effort (issue #119), in the
sandbox project only: never a served repo. Costs one tiny Haiku thread (and one Codex thread
with `--codex INSTANCE MODEL`).

    python3 scripts/live_launch.py [--codex INSTANCE MODEL]

It launches a thread through `T3Mcp.call('t3_thread_launch', ...)` with
`{instanceId, model, options: [{id: 'effort', value: 'low'}]}` (Codex: `reasoningEffort`,
`high`) in a new T3
worktree, waits for its run with `t3_thread_wait`, prints what T3 answered, and reads the effort
back the way the runner does (`effort.T3Files.run_effort`: Claude Code's transcript, else T3's
run record). The worktree and branch are removed at the end and the thread settled.
"""
import datetime
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_runner.effort import T3Files  # noqa: E402
from queue_runner.t3 import T3Cli  # noqa: E402
from queue_runner.t3_mcp import T3Mcp  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from live_mcp import SANDBOX, sandbox_project  # noqa: E402

# The option T3 reads a driver's effort from (`reasoningEffort` for Codex: runtimeLayer-*.mjs in
# server.asar, read 2026-11-17; Codex ignores `effort`).
EFFORT_OPTION = {'claudeAgent': 'effort', 'codex': 'reasoningEffort'}
MESSAGE = 'Reply with the single word: ok. Do not run any tools.'


def launch(mcp, project, instance, model, effort):
    branch = f"live/launch-{datetime.datetime.now():%Y%m%d-%H%M%S}-{instance}"
    selection = {'instanceId': instance, 'model': model,
                 'options': [{'id': EFFORT_OPTION.get(instance, 'effort'), 'value': effort}]}
    launched = mcp.call('t3_thread_launch', {
        'projectId': project, 'title': f'Queue runner launch check ({model} at {effort})',
        'runtimeMode': 'full-access', 'modelSelection': selection, 'message': MESSAGE,
        'workspaceStrategy': {'type': 'worktree', 'baseRef': 'main', 'branch': branch,
                              'startFromOrigin': False}})
    print('launch answered:', json.dumps(launched, indent=2))
    thread_id = launched['threadId']
    while True:
        waited = mcp.call('t3_thread_wait', {'threadId': thread_id, 'timeoutMs': 20000})
        print('wait answered:', json.dumps(waited)[:1500])
        if not (waited or {}).get('timedOut'):
            break
        time.sleep(1)
    return thread_id, branch, launched


def main() -> int:
    mcp = T3Mcp()
    cli = T3Cli(mcp=mcp)
    project = sandbox_project(mcp)
    runs = [('claudeAgent', 'claude-haiku-5-5', 'low')]
    if '--codex' in sys.argv:
        i = sys.argv.index('--codex')
        runs.append((sys.argv[i + 1], sys.argv[i + 2], 'high'))
    files = T3Files()
    for instance, model, effort in runs:
        thread_id, branch, launched = launch(mcp, project, instance, model, effort)
        thread, messages = cli.show(thread_id, 2)
        print('thread show:', thread)
        for m in messages:
            print(f'  {m.role}: {m.text[:200]!r}')
        run_id = launched.get('runId') or thread.latest_run_id
        print(f'{model}: asked for {effort}; read back:', files.run_effort(thread_id, run_id))
        if instance != 'claudeAgent':
            print('  (a Codex run: read its effort from its rollout, ~/.codex/sessions)')
        print('  run record:', json.dumps(files._run(run_id))[:1500])
        if thread.worktree_path:
            subprocess.run(['git', '-C', SANDBOX, 'worktree', 'remove', '--force',
                            thread.worktree_path])
        subprocess.run(['git', '-C', SANDBOX, 'branch', '-D', branch])
        try:
            cli.settle(thread_id)
        except Exception as e:   # noqa: BLE001
            print('settle failed:', e)
    return 0


if __name__ == '__main__':
    sys.exit(main())

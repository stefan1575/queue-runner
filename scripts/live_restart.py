"""Live check of a restart whose new code won't start (ticket 14): toasts Stefan for real.

Clones this repo's HEAD into a temp folder, breaks `queue_runner/cli.py` with a syntax error (the
broken stub), and runs `restart.relaunch` on it as the runner would after its own merge, with
the real Windows toaster. Expect: the log line below says the new code failed to start, with
`SyntaxError`, and a "Queue runner didn't restart" toast. Nothing else starts: the stub dies on
import, before it reads any config or takes any lock.

    python3 scripts/live_restart.py
"""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_runner.restart import relaunch  # noqa: E402
from queue_runner.toast import WindowsToaster  # noqa: E402


def main() -> int:
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sha = subprocess.run(['git', '-C', here, 'rev-parse', 'HEAD'], capture_output=True,
                         text=True, check=True).stdout.strip()
    with tempfile.TemporaryDirectory() as tmp:
        stub = os.path.join(tmp, 'queue-runner')
        subprocess.run(['git', 'clone', '-q', here, stub], check=True)
        with open(os.path.join(stub, 'queue_runner', 'cli.py'), 'a', encoding='utf-8') as f:
            f.write('\ndef broken(:\n')
        state = os.path.join(tmp, 'state')
        os.makedirs(state)
        ok = relaunch([sys.executable, '-m', 'queue_runner'], cwd=stub, sha=sha,
                      github='stefan1575/queue-runner',
                      pid_file=os.path.join(state, 'runner.pid'),
                      err_file=os.path.join(tmp, 'restart.err'), toaster=WindowsToaster(),
                      say=print, timeout=60)
    print('restarted' if ok else 'not restarted: a toast should be on screen')
    return 0 if not ok else 1


if __name__ == '__main__':
    sys.exit(main())

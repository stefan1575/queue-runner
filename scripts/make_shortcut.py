"""Makes the runner's logon shortcut, `~/.queue-runner/Queue runner.lnk` (ticket 10).

It starts `pythonw -m queue_runner` in this repo: no console, one instance (runner.lock), logging
to `log_dir/runner.log`. It is left out of the Startup folder until the cutover (ticket 13), so
the runner doesn't race `~/sol-pr-review.py`; the cutover copies it to
`%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup/`.

    python3 scripts/make_shortcut.py
"""
import os
import subprocess

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTHONW = os.path.expanduser('~/scoop/apps/python/current/pythonw.exe')   # survives upgrades
LINK = os.path.expanduser('~/.queue-runner/Queue runner.lnk')


def main() -> None:
    os.makedirs(os.path.dirname(LINK), exist_ok=True)
    ps = ('$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:QR_LINK); '
          '$s.TargetPath = $env:QR_EXE; $s.Arguments = "-m queue_runner"; '
          '$s.WorkingDirectory = $env:QR_REPO; $s.WindowStyle = 7; '
          '$s.Description = "Queue runner: Stefan\'s build-and-review flow, no AI"; $s.Save()')
    env = dict(os.environ, QR_LINK=LINK, QR_EXE=PYTHONW, QR_REPO=REPO)
    subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps],
                   env=env, check=True)
    print(f'Made {LINK}: {PYTHONW} -m queue_runner in {REPO}')


if __name__ == '__main__':
    main()

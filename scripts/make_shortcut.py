"""Makes the logon shortcuts: the runner's and the dashboard's (tickets 10 and 29).

- `Queue runner.lnk` starts `pythonw -m queue_runner` in this repo: no console, one instance
  (runner.lock), logging to `log_dir/runner.log`.
- `Queue runner dashboard.lnk` starts `pythonw -m dashboard` in this repo: one instance (its port
  is bound alone), the runner's page on http://queue.localhost:5289/ and sample data on
  http://localhost:5289/.

Both go in `~/.queue-runner/`. `--startup` also copies both into the Startup folder,
`%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup/`, so they start at logon. The folders
and pythonw can be given, so a test makes them in a temp folder.

    python3 scripts/make_shortcut.py              # ~/.queue-runner only
    python3 scripts/make_shortcut.py --startup    # and the Startup folder
"""
import argparse
import os
import shutil
import subprocess

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTHONW = os.path.expanduser('~/scoop/apps/python/current/pythonw.exe')   # survives upgrades
LINK_DIR = os.path.expanduser('~/.queue-runner')
STARTUP = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~/AppData/Roaming')),
                       'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')

SHORTCUTS = [
    ('Queue runner.lnk', 'queue_runner', "Queue runner: Stefan's build-and-review flow, no AI"),
    ('Queue runner dashboard.lnk', 'dashboard',
     "Queue runner dashboard: the runner's page on http://queue.localhost:5289/"),
]


def make(link: str, pythonw: str, module: str, description: str) -> None:
    ps = ('$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:QR_LINK); '
          '$s.TargetPath = $env:QR_EXE; $s.Arguments = "-m " + $env:QR_MODULE; '
          '$s.WorkingDirectory = $env:QR_REPO; $s.WindowStyle = 7; '
          '$s.Description = $env:QR_DESCRIPTION; $s.Save()')
    env = dict(os.environ, QR_LINK=link, QR_EXE=pythonw, QR_REPO=REPO, QR_MODULE=module,
               QR_DESCRIPTION=description)
    subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps],
                   env=env, check=True)


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description="Make the runner's and the dashboard's logon shortcuts.")
    p.add_argument('--dir', default=LINK_DIR, help='where the shortcuts are made (default ~/.queue-runner)')
    p.add_argument('--startup', action='store_true', help='also copy both into the Startup folder')
    p.add_argument('--startup-dir', default=STARTUP, help='the Startup folder')
    p.add_argument('--pythonw', default=PYTHONW)
    args = p.parse_args(argv)

    os.makedirs(args.dir, exist_ok=True)
    for name, module, description in SHORTCUTS:
        link = os.path.join(args.dir, name)
        make(link, args.pythonw, module, description)
        print(f'Made {link}: {args.pythonw} -m {module} in {REPO}')
        if args.startup:
            os.makedirs(args.startup_dir, exist_ok=True)
            shutil.copy2(link, args.startup_dir)
            print(f'Copied it to {args.startup_dir}')


if __name__ == '__main__':
    main()

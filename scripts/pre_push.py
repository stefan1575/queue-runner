"""The pre-push hook (#172; `hooks/pre-push` runs it, `scripts/install_hooks.py` installs it).

A push that updates main runs the Python tests and the app's typecheck and tests, and is refused
if any fails: GitHub can't require checks before a push to this private repo, so CI would only
see a broken main after it landed (#169). A push to any other branch isn't checked, so build and
fix threads aren't slowed. The tests run in this checkout, so the commit pushed to main must be
the one checked out, with no changed, staged or untracked files (ignored ones aside: dependencies
and build output); otherwise the push is refused and says so.

Git gives the hook `<remote> <url>` as arguments and one line per ref on stdin:
`<local ref> <local sha> <remote ref> <remote sha>`.
"""
import os
import shutil
import subprocess
import sys

MAIN = 'refs/heads/main'
DELETED = '0' * 40


def pushed_to_main(lines):
    """The sha a push sends to main, or None when it doesn't update main (a deletion included)."""
    for line in lines:
        parts = line.split()
        if len(parts) == 4 and parts[2] == MAIN and parts[1].strip('0'):
            return parts[1]
    return None


def checks():
    pnpm = shutil.which('pnpm') or 'pnpm'
    return [
        [sys.executable, '-m', 'unittest'],
        [pnpm, '--dir', 'app', 'typecheck'],
        [pnpm, '--dir', 'app', 'test'],
    ]


def clean_env():
    """Git sets GIT_DIR and friends for a hook; the tests run git in repos of their own."""
    return {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}


def git(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True, check=True).stdout.strip()


def say_err(text):
    print(text, file=sys.stderr, flush=True)


def main(lines, run=subprocess.run, checks=checks, git=git, say=say_err):
    sha = pushed_to_main(lines)
    if sha is None:
        return 0
    if git('rev-parse', 'HEAD') != sha:
        say(f'pre-push: refused: the tests run in this checkout, so check out {sha[:7]}, the commit '
            'you push to main, and push again')
        return 1
    # The checks run every file here, so any file the commit lacks (changed, staged or untracked)
    # would be tested in its place. Ignored files are dependencies and build output.
    unlike = git('status', '--porcelain', '--untracked-files=all')
    if unlike:
        files = ', '.join(line.split(None, 1)[-1] for line in unlike.splitlines())
        say(f'pre-push: refused: the tests run in this checkout, which differs from {sha[:7]}, the '
            f'commit you push to main, in changed or untracked files ({files}); commit, remove or '
            'ignore them and push again')
        return 1
    for command in checks():
        say(f'pre-push: main moves to {sha[:7]}: {" ".join(command[1:])}')
        try:
            code = run(command, env=clean_env()).returncode
        except OSError as e:
            say(f'pre-push: refused: {command[0]} could not start ({e})')
            return 1
        if code != 0:
            say(f'pre-push: refused: {" ".join(command[1:])} failed (exit {code}); main stays where it was')
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.stdin.read().splitlines()))

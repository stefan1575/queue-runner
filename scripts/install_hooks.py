"""Installs the repo's git hooks (#172): points git's core.hooksPath at `hooks/`, so a push to
main runs the tests first (`hooks/pre-push`, `scripts/pre_push.py`; docs/tests.md). The setting
is in the repo's shared config, so it covers every worktree; a checkout of a branch from before
the hook has no `hooks/` folder and runs none.

    python3 scripts/install_hooks.py
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    subprocess.run(['git', 'config', 'core.hooksPath', 'hooks'], cwd=ROOT, check=True)
    print(f'git hooks installed: {ROOT / "hooks"} (a push to main runs the tests first)')


if __name__ == '__main__':
    sys.exit(main())

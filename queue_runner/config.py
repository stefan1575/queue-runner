"""Which repos the runner serves, and where it keeps its own state and logs."""
import os
import tomllib
from dataclasses import dataclass

DEFAULT_CONFIG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              'config.toml')


@dataclass(frozen=True)
class Repo:
    name: str
    github: str | None  # owner/name; None for a repo with no GitHub (the live-check sandbox)
    path: str          # local clone; T3's project for its jobs
    base: str = 'main'
    review_table: bool = False   # a posted review adds a row to the PR body's `## Review` table


@dataclass(frozen=True)
class Config:
    repos: list[Repo]  # in priority order: the first repo with work gets the next job
    state_dir: str
    log_dir: str
    claude_provider: str = 'claudeAgent'     # T3 provider instance for Claude jobs
    claude_model: str = 'claude-opus-5-5'    # T3 has no flag for reasoning effort
    poll_seconds: int = 300                  # continuous mode: the pause after an idle pass
    runs_dir: str = ''        # a review's run folder: brief, inputs, reply, would-be comment
    checkouts_dir: str = ''   # Sol's detached checkout of the PR's head, removed after
    sol_script: str = ''      # ~/codex-sol.sh
    sol_bash: str = ''        # Git's bash, which runs it


def _path(p: str) -> str:
    return os.path.normpath(os.path.expanduser(p))


def load_config(path: str = DEFAULT_CONFIG) -> Config:
    with open(path, 'rb') as f:
        raw = tomllib.load(f)
    repos = [Repo(name=r['name'], github=r.get('github'), path=_path(r['path']),
                  base=r.get('base', 'main'), review_table=bool(r.get('review_table')))
             for r in raw['repos']]
    claude, sol = raw.get('claude', {}), raw.get('sol', {})
    state_dir = _path(raw['state_dir'])
    home = os.path.dirname(state_dir)   # runs and checkouts sit beside the state folder
    from .sol import GIT_BASH, SOL_SCRIPT
    return Config(repos=repos, state_dir=state_dir, log_dir=_path(raw['log_dir']),
                  claude_provider=claude.get('provider', 'claudeAgent'),
                  claude_model=claude.get('model', 'claude-opus-5-5'),
                  poll_seconds=int(raw.get('poll_seconds', 300)),
                  runs_dir=_path(raw.get('runs_dir') or os.path.join(home, 'runs')),
                  checkouts_dir=_path(raw.get('checkouts_dir') or os.path.join(home, 'checkouts')),
                  sol_script=_path(sol.get('script') or SOL_SCRIPT),
                  sol_bash=sol.get('bash') or GIT_BASH)

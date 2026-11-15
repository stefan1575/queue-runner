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
    # Live steps after merges (ticket 11, `live.py`): the repo's doc that says how a merge goes
    # live (None: the repo has none), and where its migrations and edge functions live.
    live_doc: str | None = None
    live_migrations: str = 'supabase/migrations'
    live_functions: str = 'supabase/functions'
    # Where its tickets are (ticket 12, `tickets.py`): 'github' (issues), or 'local' (markdown
    # under `.scratch/*/issues/`). No repo is local unless its entry says so.
    issues: str = 'github'
    # Who merges a clean PR (ticket 17, `merge.py`): 'runner' (it merges itself), or 'stefan'
    # (it labels the PR `ready-for-stefan` and toasts once; Stefan merges, and the runner notices).
    merge: str = 'runner'

    @property
    def local_issues(self) -> bool:
        return self.issues == 'local'

    @property
    def stefan_merges(self) -> bool:
        return self.merge == 'stefan'


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
    deps_dir: str = ''        # node_modules per lockfile, linked into Sol's checkout (ticket 16)
    sol_script: str = ''      # ~/Code/tools/codex-sol/codex-sol.sh
    sol_bash: str = ''        # Git's bash, which runs it


def toml_order(config: Config) -> list[Repo]:
    """The repos in config.toml's order, whatever build order is taken up now."""
    return list(getattr(config, '_toml_order', config.repos))


def set_build_order(config: Config, repos: list[Repo]) -> None:
    """The one change made to a Config once it's loaded: the order Stefan set on the dashboard
    (control.json's `repo_order`, ticket 33), which every part that goes through `repos` follows.
    The list is replaced, never changed in place, so a lane going through the repos when it
    changes finishes in the order it began."""
    if not hasattr(config, '_toml_order'):
        object.__setattr__(config, '_toml_order', list(config.repos))
    object.__setattr__(config, 'repos', list(repos))


def _path(p: str) -> str:
    return os.path.normpath(os.path.expanduser(p))


def _issues(entry: dict) -> str:
    issues = entry.get('issues', 'github')
    if issues not in ('github', 'local'):
        raise ValueError(f"repo {entry['name']}: issues must be 'github' or 'local', "
                         f"not {issues!r}")
    return issues


def _merge(entry: dict) -> str:
    merge = entry.get('merge', 'runner')
    if merge not in ('runner', 'stefan'):
        raise ValueError(f"repo {entry['name']}: merge must be 'runner' or 'stefan', "
                         f"not {merge!r}")
    return merge


def load_config(path: str = DEFAULT_CONFIG) -> Config:
    with open(path, 'rb') as f:
        raw = tomllib.load(f)
    repos = [Repo(name=r['name'], github=r.get('github'), path=_path(r['path']),
                  base=r.get('base', 'main'), review_table=bool(r.get('review_table')),
                  live_doc=r.get('live_doc') or None,
                  live_migrations=r.get('live_migrations', 'supabase/migrations'),
                  live_functions=r.get('live_functions', 'supabase/functions'),
                  issues=_issues(r), merge=_merge(r))
             for r in raw.get('repos', [])]
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
                  deps_dir=_path(raw.get('deps_dir') or os.path.join(home, 'deps')),
                  sol_script=_path(sol.get('script') or SOL_SCRIPT),
                  sol_bash=sol.get('bash') or GIT_BASH)

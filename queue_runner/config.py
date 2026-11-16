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
    repos: list[Repo]  # in config.toml's order, which breaks a tie between repos' work (#50)
    state_dir: str
    log_dir: str
    claude_provider: str = 'claudeAgent'     # T3 provider instance for Claude jobs
    claude_model: str = 'claude-opus-5-5'
    # The effort every Claude job runs at (ticket 39, `effort.py`): T3's CLI has no flag for it,
    # so a job gets it from its T3 project's default model when that is this model at this effort.
    claude_effort: str = 'high'
    poll_seconds: int = 300                  # continuous mode: the pause after an idle pass
    runs_dir: str = ''        # a review's run folder: brief, inputs, reply, would-be comment
    checkouts_dir: str = ''   # Sol's detached checkout of the PR's head, removed after
    deps_dir: str = ''        # node_modules per lockfile, linked into Sol's checkout (ticket 16)
    sol_script: str = ''      # ~/Code/tools/codex-sol/codex-sol.sh
    sol_bash: str = ''        # Git's bash, which runs it
    # The runner's cutover (issue 3): a blocking review it didn't run, posted on GitHub before
    # this date (GitHub's UTC time, `YYYY-MM-DD`), counts as its own for the fix lane. '' adopts
    # none.
    adopt_reviews_before: str = ''


def set_stopped(config: Config, names) -> None:
    """The repos Stefan stopped (control.json's `repos`, ticket 37): every part that chooses work
    goes through `working`, which leaves them out. `repos` itself keeps them, for what is only
    looked up or shown (a job's own repo, the Inbox, the snapshot)."""
    object.__setattr__(config, '_stopped', frozenset(names))


def stopped(config: Config) -> frozenset:
    return getattr(config, '_stopped', frozenset())


def working(config: Config) -> list[Repo]:
    """The repos the lanes take work from: `repos`, less those stopped."""
    off = stopped(config)
    return [r for r in config.repos if r.name not in off]


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


EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max')   # Claude Code's effort levels


def _effort(claude: dict) -> str:
    effort = claude.get('effort', 'high')
    if effort not in EFFORTS:
        raise ValueError(f"[claude] effort must be one of {', '.join(EFFORTS)}, not {effort!r}")
    return effort


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
                  claude_effort=_effort(claude),
                  poll_seconds=int(raw.get('poll_seconds', 300)),
                  runs_dir=_path(raw.get('runs_dir') or os.path.join(home, 'runs')),
                  checkouts_dir=_path(raw.get('checkouts_dir') or os.path.join(home, 'checkouts')),
                  deps_dir=_path(raw.get('deps_dir') or os.path.join(home, 'deps')),
                  sol_script=_path(sol.get('script') or SOL_SCRIPT),
                  sol_bash=sol.get('bash') or GIT_BASH,
                  adopt_reviews_before=str(raw.get('adopt_reviews_before') or ''))

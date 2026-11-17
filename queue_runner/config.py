"""Which repos the runner serves, and where it keeps its own state and logs."""
import os
import tomllib
from dataclasses import dataclass, field

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


# The job kinds `[jobs]` names (issue #120): a conflict is a fix round's thread that merges the
# base in, and an ask is an Inbox ask thread (ticket 35).
KINDS = ('build', 'fix', 'conflict', 'decision', 'live', 'review', 'ask')
# The T3 provider instances a job may run on, and the efforts each takes: Claude Code's levels,
# and what the Codex CLI's `model_reasoning_effort` accepts (its enum, read from codex.exe
# 2026-11-18).
EFFORTS = {'claudeAgent': ('low', 'medium', 'high', 'xhigh', 'max'),
           'codex': ('minimal', 'low', 'medium', 'high', 'xhigh', 'max')}
CLAUDE = 'claudeAgent'   # the provider whose usage the gate reads (`gate.py`)
CODEX = 'codex'          # a review on it runs through the Codex adapter (`sol.py`)


@dataclass(frozen=True)
class JobSpec:
    """What a job kind runs on: a T3 provider instance, its model and effort, and what it runs
    on instead while that provider is out of usage (None: it waits for the reset)."""
    provider: str
    model: str
    effort: str
    fallback: 'JobSpec | None' = None


OPUS_HIGH = JobSpec(CLAUDE, 'claude-opus-5-5', 'high')
# A config with no `[jobs]` table: Opus at high, and Sol reviewing at high with Opus at high
# while Sol is out of usage (the runner's jobs before #120).
DEFAULT_JOBS = {**{k: OPUS_HIGH for k in KINDS},
                'review': JobSpec(CODEX, 'gpt-6.1-sol', 'high', fallback=OPUS_HIGH)}


@dataclass(frozen=True)
class Config:
    repos: list[Repo]  # in config.toml's order, which breaks a tie between repos' work (#50)
    state_dir: str
    log_dir: str
    # Each job kind's provider, model and effort (issue #120, `[jobs]`): every one of KINDS.
    jobs: dict = field(default_factory=lambda: dict(DEFAULT_JOBS))
    poll_seconds: int = 300                  # continuous mode: the pause after an idle pass
    runs_dir: str = ''        # a review's run folder: brief, inputs, reply, would-be comment
    checkouts_dir: str = ''   # Sol's detached checkout of the PR's head, removed after
    deps_dir: str = ''        # node_modules per lockfile, linked into Sol's checkout (ticket 16)
    sol_script: str = ''      # scripts/codex-sol.sh
    sol_bash: str = ''        # Git's bash, which runs it
    # The runner's cutover (issue 3): a blocking review it didn't run, posted on GitHub before
    # this date (GitHub's UTC time, `YYYY-MM-DD`), counts as its own for the fix lane. '' adopts
    # none.
    adopt_reviews_before: str = ''

    def job(self, kind: str) -> JobSpec:
        """What a `kind` job runs on (one of KINDS)."""
        return self.jobs[kind]


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


SPEC_KEYS = ('provider', 'model', 'effort')
GONE = {'claude': '[jobs.default] (provider, model, effort)',
        'review': '[jobs.review] (provider "codex" for Sol, "claudeAgent" for Claude, with its '
                  'model and effort, and a fallback)'}


def _spec(name: str, raw, base: JobSpec, fallback: bool) -> JobSpec:
    """`[jobs.<kind>]` (or its `fallback`) as `name` says it, each key missing taken from
    `base`; checked: known keys, a known provider, an effort that provider takes."""
    if not isinstance(raw, dict):
        raise ValueError(f'{name} must be a table, not {raw!r}')
    keys = SPEC_KEYS + (('fallback',) if fallback else ())
    if unknown := sorted(set(raw) - set(keys)):
        raise ValueError(f'{name}: unknown key {", ".join(unknown)} (it takes '
                         f'{", ".join(keys)})')
    provider = raw.get('provider', base.provider)
    if provider not in EFFORTS:
        raise ValueError(f'{name}: provider must be one of {", ".join(EFFORTS)}, '
                         f'not {provider!r}')
    effort = raw.get('effort', base.effort)
    if effort not in EFFORTS[provider]:
        raise ValueError(f'{name}: effort on {provider} must be one of '
                         f'{", ".join(EFFORTS[provider])}, not {effort!r}')
    return JobSpec(provider, str(raw.get('model', base.model)), effort)


def _jobs(raw: dict) -> dict:
    """Each of KINDS's JobSpec from `[jobs]`: a kind not named takes `[jobs.default]`'s, and
    a key a kind leaves out is default's too. No `[jobs]` at all: DEFAULT_JOBS."""
    for old, new in GONE.items():
        if old in raw:
            raise ValueError(f"config.toml's [{old}] is gone (issue #120): write {new} "
                             'instead (docs/running.md, config.toml)')
    if 'jobs' not in raw:
        return dict(DEFAULT_JOBS)
    table = raw['jobs']
    if unknown := sorted(set(table) - set(KINDS) - {'default'}):
        raise ValueError(f'[jobs.{unknown[0]}]: no such job kind (they are '
                         f'{", ".join(KINDS)}, and default)')
    default_raw = table.get('default', {})
    default = _spec('jobs.default', default_raw, OPUS_HIGH, fallback=True)
    jobs = {}
    for kind in KINDS:
        own = table.get(kind, {})
        merged = {**default_raw, **own} if isinstance(own, dict) else own
        spec = _spec(f'jobs.{kind}', merged, default, fallback=True)
        if (back := merged.get('fallback')) is not None:
            fb = _spec(f'jobs.{kind}.fallback', back, default, fallback=False)
            if kind == 'review' and spec.provider != CODEX and fb.provider == CODEX:
                raise ValueError('jobs.review.fallback: a review runs on codex only as its own '
                                 'provider, through the Codex adapter; name a T3 provider '
                                 'such as claudeAgent')
            spec = JobSpec(spec.provider, spec.model, spec.effort, fallback=fb)
        jobs[kind] = spec
    return jobs


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
    jobs, sol = _jobs(raw), raw.get('sol', {})
    state_dir = _path(raw['state_dir'])
    home = os.path.dirname(state_dir)   # runs and checkouts sit beside the state folder
    from .sol import GIT_BASH, SOL_SCRIPT
    return Config(repos=repos, state_dir=state_dir, log_dir=_path(raw['log_dir']),
                  jobs=jobs,
                  poll_seconds=int(raw.get('poll_seconds', 300)),
                  runs_dir=_path(raw.get('runs_dir') or os.path.join(home, 'runs')),
                  checkouts_dir=_path(raw.get('checkouts_dir') or os.path.join(home, 'checkouts')),
                  deps_dir=_path(raw.get('deps_dir') or os.path.join(home, 'deps')),
                  sol_script=_path(sol.get('script') or SOL_SCRIPT),
                  sol_bash=sol.get('bash') or GIT_BASH,
                  adopt_reviews_before=str(raw.get('adopt_reviews_before') or ''))

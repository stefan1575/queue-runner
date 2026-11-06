"""Which repos the runner serves, and where it keeps its own state and logs."""
import os
import tomllib
from dataclasses import dataclass

DEFAULT_CONFIG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              'config.toml')


@dataclass(frozen=True)
class Repo:
    name: str
    github: str        # owner/name
    path: str          # local clone; T3's project for its jobs
    base: str = 'main'


@dataclass(frozen=True)
class Config:
    repos: list[Repo]  # in priority order: the first repo with work gets the next job
    state_dir: str
    log_dir: str


def _path(p: str) -> str:
    return os.path.normpath(os.path.expanduser(p))


def load_config(path: str = DEFAULT_CONFIG) -> Config:
    with open(path, 'rb') as f:
        raw = tomllib.load(f)
    repos = [Repo(name=r['name'], github=r['github'], path=_path(r['path']), base=r.get('base', 'main'))
             for r in raw['repos']]
    return Config(repos=repos, state_dir=_path(raw['state_dir']), log_dir=_path(raw['log_dir']))

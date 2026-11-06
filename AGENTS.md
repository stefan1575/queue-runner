# Queue runner

A script with no AI in it that runs Stefan's fixed build-and-review flow and starts fresh T3 Code
threads only for work that needs Claude or Sol. The design and its rules live outside this repo:
`~/.claude/docs/orchestration.md`, `~/.claude/docs/pr-review.md` and `~/.claude/docs/sol.md`. The
spec and the tickets that build it are in personal-ops `.scratch/queue-runner/` (`spec.md`,
`issues/NN-*.md`).

**This repo never goes to GitHub**: local git only, no remote, no push. Commit after every
completed step, with a message that says what changed and why.

## Run it

```
python3 -m queue_runner --once --dry-run      # name the next build job and print its brief
```

Only `--once --dry-run` is built so far (ticket 01); it starts, posts and writes nothing outside
the runner's own state and log folders. In production it runs under `pythonw`, so it never
needs a console: every subprocess runs with no window.

`config.toml` names the repos it serves (GitHub repo, local clone, base branch), in priority
order, and the runner's `state_dir` and `log_dir` (`~/.queue-runner/`, outside every served
repo). `--config <path>` reads another one.

## Tests

```
python3 -m unittest
```

Standard library only (Python 3.15 from scoop; `python3` is its shim). Tests never touch the
network: GitHub is the `GhCli` adapter in `queue_runner/github.py`, faked in tests with
`tests/fakes.py` (`FakeGitHub`) or with canned `gh api` JSON (`tests/test_github.py`). T3 gets the
same treatment when jobs start (ticket 02).

## Layout

- `queue_runner/picker.py`: which ticket is next: open, `ready-for-agent`, every blocker closed
  (GitHub's native dependencies, or `#N`, `owner/name#N` or issue URLs on a `Blocked by:` line or
  under a `## Blocked by` heading), not already in flight (a `claude/*-<issue>` branch, an open
  PR on one, or an open PR that closes it or that GitHub links to it by hand), not a spec with
  open sub-issues (its children are the work); lowest number first. The job branches `claude/<slug>-<issue>` from
  `origin/<base>`.
- `queue_runner/brief.py` and `templates/<kind>.md`: a job's brief, filled from the issue and the
  repo; no handoff files.
- `queue_runner/github.py`: the GitHub seam and its `gh api` adapter.
- `queue_runner/cli.py`: the command line.

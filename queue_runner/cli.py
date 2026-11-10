"""The runner's command line.

    python -m queue_runner                    # run: pass after pass (what logon will start)
    python -m queue_runner --once             # one pass of each lane: settle, at most one build
                                              # and at most one Sol review
    python -m queue_runner --once --dry-run   # name the next Claude job (a decision first, then
                                              # a fix round, else a build, with its brief), the
                                              # stops, the PRs Sol would review
                                              # and the PRs that would merge
    python -m queue_runner --release NAME#N   # let the picker take a held issue again
    python -m queue_runner --review NAME#N    # Sol reviews that PR's head now
    python -m queue_runner --gate             # Claude's usage now, and whether each job kind fits
    python -m queue_runner --pause | --resume # hold Claude jobs back, or let them start again
    python -m queue_runner --reserve PERCENT  # the share of the week kept for Stefan (default 5)
    python -m queue_runner --stop             # stop the running runner (its pid in runner.pid)
"""
import argparse
import datetime
import os
import re
import sys
import time
import traceback

from .brief import build_brief
from .config import DEFAULT_CONFIG, load_config
from .run import Runner, RunnerBusy, runner_lock, wall_sleep
from .state import JobLog

EXIT_LOCKED = 3


def _logger(config):
    def log_line(line: str) -> None:
        os.makedirs(config.log_dir, exist_ok=True)
        stamp = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
        with open(os.path.join(config.log_dir, 'runner.log'), 'a', encoding='utf-8') as f:
            f.write(f'{stamp} {line}\n')
    return log_line


def _jobs(config) -> JobLog:
    return JobLog(os.path.join(config.state_dir, 'jobs.jsonl'))


def _gate(config, usage, clock):
    from .gate import Gate
    if usage is None:
        from .usage import OAuthUsage
        usage = OAuthUsage()
    return Gate(config.state_dir, usage, clock)


def _print_gate(gate, out) -> None:
    """The knob, Claude's windows now and each job kind's verdict (reads usage once)."""
    from .gate import CLAUDE_KINDS, CostBook, decide
    from .usage import UsageError
    try:
        knob = gate.knob()
    except (OSError, ValueError) as e:
        print(f'gate.json is unreadable ({e}): no Claude job starts until it is fixed or removed',
              file=out)
        return
    print(f'Claude usage gate: {"paused" if knob.paused else "running"}, weekly reserve '
          f'{knob.reserve:g}%', file=out)
    try:
        usage = gate.reader.read()
    except UsageError as e:
        print(f'  usage unreadable: {e}', file=out)
        return
    for name, w in (('5 hours', usage.five_hour), ('week', usage.seven_day)):
        resets = (f', resets {w.resets_at.astimezone().isoformat(timespec="minutes")}'
                  if w.resets_at else ', not started')
        print(f'  {name}: {w.used:g}% used{resets}', file=out)
    for kind in CLAUDE_KINDS:
        cost = gate.book.expected(kind)
        learned = ' (the cautious default)' if cost == CostBook.default(kind) else ''
        v = decide(usage, kind, cost, knob, gate.clock())
        print(f'  {kind}: {"starts" if v.go else "waits"}: {v.text}{learned}', file=out)


def _knob(config, args, out) -> int:
    from dataclasses import replace
    from .gate import Knob, read_knob, write_knob
    try:
        knob = read_knob(config.state_dir)
    except (OSError, ValueError) as e:   # set afresh from the defaults
        print(f'gate.json was unreadable ({e}); starting again from the defaults.', file=out)
        knob = Knob()
    if args.reserve is not None:
        if not 0 <= args.reserve <= 100:
            print('--reserve takes a percent from 0 to 100.', file=out)
            return 2
        knob = replace(knob, reserve=args.reserve)
    if args.pause or args.resume:
        knob = replace(knob, paused=args.pause)
    write_knob(config.state_dir, knob)
    state = ('Paused: no Claude job starts (one running now runs to its end; Sol goes on)'
             if knob.paused else 'Running: Claude jobs start when they fit')
    print(f'{state}; the weekly reserve is {knob.reserve:g}%. A running runner reads this '
          'before its next Claude job.', file=out)
    return 0


def _dry_run_limited(config, out, log_line) -> bool:
    """A job cut off by a usage limit comes first: when, and in place or fresh."""
    from .limits import in_place
    limited = _jobs(config).limited_jobs()
    if not limited:
        return False
    j = limited[0]
    how = 'continue its thread in place' if in_place(j.context) else 'restart it in a fresh thread'
    line = (f'dry run: {j.kind} {j.repo}#{j.issue} was cut off by a usage limit; after '
            f'{j.resume_at} the runner would {how} ({j.link or j.thread_id}), and starts no '
            'other Claude job before')
    log_line(line)
    print(line, file=out)
    return True


def _dry_run(config, github, git, out, log_line, t3=None, gate=None) -> int:
    if not _dry_run_limited(config, out, log_line) and \
            not _dry_run_decision(config, github, t3, out, log_line) and \
            not _dry_run_fix(config, github, git, out, log_line):
        _dry_run_build(config, github, out, log_line)
    if gate is not None:
        _print_gate(gate, out)
    _dry_run_stops(config, github, out)
    _dry_run_reviews(config, github, out)
    _dry_run_merges(config, github, out)
    return 0


def _dry_run_stops(config, github, out) -> None:
    """The stops the Sol lane would file, and the PRs left alone for Stefan."""
    from .stops import Stopper, held
    jobs = _jobs(config)
    stopper = Stopper(config, github=github, jobs=jobs, say=lambda line: None)
    print('Stops for Stefan (dry run: nothing filed or toasted):', file=out)
    for repo in config.repos:
        if not repo.github:
            continue
        for pr in sorted(github.open_pulls(repo), key=lambda p: p.number):
            for kind, why, _ in stopper.new_stops(repo, pr):
                print(f'  {repo.name}#{pr.number}: would stop for Stefan ({kind}): {why}',
                      file=out)
            if why := held(jobs, repo, pr.number):
                print(f'  {repo.name}#{pr.number}: {why}', file=out)


def _dry_run_decision(config, github, t3, out, log_line) -> bool:
    """Prints the decision the Claude lane would take first, with its brief (a reply to an
    Approach note that names rework, fix on or hold needs no thread)."""
    from .decisions import Decider
    from .stops import Stopper
    jobs = _jobs(config)
    decider = Decider(config, github=github, t3=t3, jobs=jobs, say=lambda line: None,
                      stopper=Stopper(config, github=github, jobs=jobs, say=lambda line: None))
    case = decider.next_case()
    if case is None:
        return False
    what = f'{case.repo.name}#{case.number} ({case.question})'
    log_line(f'dry run: would decide {what}')
    print(f'Would start a decision on {what} (dry run: nothing started or posted)', file=out)
    if answer := decider.direct_answer(case):
        print(f'  Stefan answered the Approach note: {answer.action}, with no thread', file=out)
        return True
    print('  brief:', file=out)
    print('-' * 72, file=out)
    print(decider.brief(case), file=out)
    print('-' * 72, file=out)
    return True


def _dry_run_fix(config, github, git, out, log_line) -> bool:
    """Prints the fix round the Claude lane would start, with its brief. It fetches the PR's
    head (local refs only) so the brief's commits and files are real; nothing else changes."""
    from .fix import Fixer
    from .fix import fix_branch
    fixer = Fixer(config, github=github, git=git, jobs=_jobs(config))
    for repo in config.repos:
        if not repo.github:
            continue
        for pr, review, why in fixer.candidates(repo):
            if why:
                print(f'Fix round {repo.name}#{pr.number}: not now, {why}', file=out)
                continue
            _, fetched = git.fetch_pr(repo.path, pr.number, pr.base)
            if fetched != pr.head_sha:
                print(f'Fix round {repo.name}#{pr.number}: the head moved to {fetched[:7]}; '
                      'Sol reviews it first', file=out)
                continue
            brief = fixer.brief(repo, pr, review)
            log_line(f'dry run: would start a fix round on {repo.github}#{pr.number}')
            print('Would start a fix round (dry run: nothing started)', file=out)
            print(f'  repo:   {repo.github} ({repo.path})', file=out)
            print(f'  PR:     #{pr.number} {pr.title}, after review {review.round}', file=out)
            print(f'  from:   {pr.head_sha[:7]} on {fix_branch(pr.number, pr.head_sha)}, pushing '
                  f'to {pr.branch}', file=out)
            print('  brief:', file=out)
            print('-' * 72, file=out)
            print(brief, file=out)
            print('-' * 72, file=out)
            return True
    return False


def _dry_run_merges(config, github, out) -> None:
    from .merge import Merger
    merger = Merger(config, github=github, git=None, jobs=_jobs(config), say=lambda line: None)
    print('Merges (dry run: nothing merged):', file=out)
    for repo in config.repos:
        if not repo.github:
            continue
        for pr, why in merger.candidates(repo):
            print(f'  {repo.name}#{pr.number}: ' + (f'not now, {why}' if why else
                                                    f'would merge at {pr.head_sha[:7]}'), file=out)


def _dry_run_build(config, github, out, log_line) -> None:
    from .picker import pick
    jobs = _jobs(config)
    for repo in config.repos:
        if not repo.github:
            continue
        job = pick(repo, github, held=jobs.held_issues(repo.name))
        if job is None:
            continue
        brief = build_brief(job, github.issue_comments(repo, job.issue.number))
        log_line(f'dry run: would build {repo.github}#{job.issue.number} on {job.branch}')
        print('Would start a build job (dry run: nothing started)', file=out)
        print(f'  repo:   {repo.github} ({repo.path})', file=out)
        print(f'  issue:  #{job.issue.number} {job.issue.title}', file=out)
        print(f'  branch: {job.branch} from {job.base}', file=out)
        print('  brief:', file=out)
        print('-' * 72, file=out)
        print(brief, file=out)
        print('-' * 72, file=out)
        return
    log_line('dry run: nothing to start')
    print('Nothing to start: no repo has an unblocked ready-for-agent issue that isn\'t already '
          'being built or held.', file=out)


def _dry_run_reviews(config, github, out) -> None:
    from .ledger import next_round, read_reviews
    from .review import DryRunPoster, Reviewer
    reviewer = Reviewer(config, github=github, git=None, sol=None, jobs=_jobs(config),
                        say=lambda line: None, poster=DryRunPoster(lambda line: None))
    print('Sol reviews (dry run: Sol not started):', file=out)
    for repo in config.repos:
        if not repo.github:
            continue
        for pr, why in reviewer.candidates(repo):
            if why:
                print(f'  {repo.name}#{pr.number}: not now, {why}', file=out)
            else:
                rnd = next_round(read_reviews(github.issue_comments(repo, pr.number)))
                print(f'  {repo.name}#{pr.number}: would review #{pr.number} on '
                      f'{pr.head_sha[:7]} (review {rnd})', file=out)


def _repo_ref(value, config, flag, out):
    """NAME#N from the command line: (repo, N), or None after saying what's wrong."""
    m = re.fullmatch(r'([\w.-]+)#(\d+)', value)
    repos = {r.name: r for r in config.repos}
    if not m or m[1] not in repos:
        print(f'{flag} takes NAME#N with NAME one of the repos in the config.', file=out)
        return None
    return repos[m[1]], int(m[2])


def _review(config, github, git, sol, value, out, log_line, toaster=None) -> int:
    """`--review NAME#N`: one Sol review now, under sol.lock, if the PR needs one."""
    from .review import Reviewer
    ref = _repo_ref(value, config, '--review', out)
    if ref is None:
        return 2

    def say(line):
        log_line(line)
        print(line, file=out)
    reviewer = Reviewer(config, github=github, git=git, sol=sol, jobs=_jobs(config), say=say,
                        toaster=toaster)
    try:
        _, why = reviewer.review_one(*ref)
    except RunnerBusy:
        print('Another Sol job is running (sol.lock): one at a time.', file=out)
        return EXIT_LOCKED
    if why:
        print(f'{value}: not reviewed: {why}.', file=out)
        return 1
    return 0


def _pid_file(config) -> str:
    return os.path.join(config.state_dir, 'runner.pid')


def _kill(pid: int) -> tuple[int, str]:
    import subprocess
    p = subprocess.run(['taskkill', '/PID', str(pid), '/F'], capture_output=True, text=True,
                       errors='replace', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return p.returncode, (p.stdout + p.stderr).strip()


def _stop(config, out, log_line, kill) -> int:
    """`--stop`: kills the process that holds runner.lock, named in runner.pid. A job it was
    running is settled by the next runner (its thread runs on in T3)."""
    try:
        with runner_lock(config.state_dir):
            print('No queue runner is running.', file=out)
            return 1
    except RunnerBusy:
        pass
    try:
        with open(_pid_file(config), encoding='utf-8') as f:
            pid = int(f.read().strip())
    except (OSError, ValueError) as e:
        print(f'A runner holds runner.lock, but runner.pid is unreadable ({e}).', file=out)
        return 1
    code, text = kill(pid)
    if code:
        print(f'Could not stop the runner (pid {pid}): {text}', file=out)
        return 1
    log_line(f'runner stopped by --stop (pid {pid})')
    print(f'Stopped the queue runner (pid {pid}).', file=out)
    return 0


def main(argv=None, github=None, out=None, t3=None, git=None, sleep=None,
         sol=None, toaster=None, usage=None, clock=None, limits=None,
         t3_settings=None, waker=None, kill=_kill) -> int:
    out = out or sys.stdout   # None under pythonw: print() then prints nothing
    sleep = sleep or wall_sleep
    parser = argparse.ArgumentParser(prog='queue_runner')
    parser.add_argument('--once', action='store_true', help='one pass, then exit')
    parser.add_argument('--dry-run', action='store_true', help='print what it would do; start nothing')
    parser.add_argument('--release', metavar='NAME#N',
                        help='let the picker take a held issue again (NAME is the repo in config)')
    parser.add_argument('--review', metavar='NAME#N',
                        help="have Sol review that PR's head now (nothing is posted yet)")
    parser.add_argument('--gate', action='store_true',
                        help="print Claude's usage now and whether each job kind would start")
    knob = parser.add_mutually_exclusive_group()
    knob.add_argument('--pause', action='store_true', help='start no Claude job until --resume')
    knob.add_argument('--resume', action='store_true', help='let Claude jobs start again')
    parser.add_argument('--reserve', type=float, metavar='PERCENT',
                        help='the share of the week kept for Stefan until 24h before its reset')
    parser.add_argument('--stop', action='store_true', help='stop the running runner')
    parser.add_argument('--config', default=DEFAULT_CONFIG)
    args = parser.parse_args(argv)
    if args.dry_run and not args.once:
        print('--dry-run goes with --once.', file=out)
        return 2

    config = load_config(args.config)
    log_line = _logger(config)
    if args.stop:
        return _stop(config, out, log_line, kill)

    if args.release:
        ref = _repo_ref(args.release, config, '--release', out)
        if ref is None:
            return 2
        _jobs(config).released(ref[0].name, ref[1])
        log_line(f'released {args.release}')
        print(f'Released {args.release}: the picker may take it again, the Sol lane may '
              'review it again if its reviews failed, and a PR stopped for Stefan is back in '
              'the loop.', file=out)
        return 0

    if args.pause or args.resume or args.reserve is not None:
        code = _knob(config, args, out)
        if code == 0:
            log_line(f'gate knob: {" ".join(argv or sys.argv[1:])}')
        return code
    gate = _gate(config, usage, clock)
    if args.gate:
        _print_gate(gate, out)
        return 0

    if github is None:
        from .github import GhCli
        github = GhCli()
    if git is None:
        from .git import GitCli
        git = GitCli()
    if args.dry_run:   # T3 only read: a waiting or failed thread's last messages for a brief
        if t3 is None:
            from .t3 import T3Cli
            t3 = T3Cli()
        return _dry_run(config, github, git, out, log_line, t3, gate)
    if sol is None:
        from .sol import SolCli
        sol = SolCli(script=config.sol_script, bash=config.sol_bash)
    if toaster is None:
        from .toast import WindowsToaster
        toaster = WindowsToaster()
    if args.review:
        return _review(config, github, git, sol, args.review, out, log_line, toaster)

    if t3 is None:
        from .t3 import T3Cli
        t3 = T3Cli()
    from .limits import T3Store, auto_resume_warning
    if limits is None:
        limits = T3Store()
    if waker is None and not args.once:
        from .wake import Schtasks, Waker
        waker = Waker(Schtasks(), say=lambda line: runner.say(line), now=clock)
    runner = Runner(config, github=github, t3=t3, git=git, out=out, log_line=log_line, sol=sol,
                    toaster=toaster, gate=gate, limits=limits, now=clock, waker=waker)
    if warning := auto_resume_warning(*([t3_settings] if t3_settings else [])):
        runner.say(f'Warning: {warning}')
    try:
        with runner_lock(config.state_dir):
            with open(_pid_file(config), 'w', encoding='utf-8') as f:
                f.write(str(os.getpid()))
            if args.once:
                runner.run_once()
            else:
                log_line(f'runner started (pid {os.getpid()})')
                runner.wait_for_t3(sleep)
                runner.run_forever(sleep)
    except RunnerBusy as e:
        log_line(f'a second runner started (pid {os.getpid()}) and exited at once: {e}')
        print(f'A queue runner is already running ({e}).', file=out)
        return EXIT_LOCKED
    except Exception:
        log_line('runner stopped on an error:\n' + traceback.format_exc())
        raise
    return 0

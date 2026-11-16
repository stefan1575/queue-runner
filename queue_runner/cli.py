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
    python -m queue_runner --pause | --resume [LANE]   # stop a lane after its job, or let it
                                              # carry on (claude by default; sol, all): the
                                              # dashboard's Stop and Resume, in control.json
    python -m queue_runner --reserve PERCENT  # the share of the week kept for Stefan (default 5)
    python -m queue_runner --stop             # stop the running runner (its pid in runner.pid)
    python -m queue_runner --inbox            # everything waiting on Stefan: PRs ready to
                                              # merge, needs-info stops, threads waiting
    python -m queue_runner --snapshot         # print the dashboard's snapshot from the state
                                              # now (reads usage once; no lock, writes nothing)
"""
import argparse
import contextlib
import dataclasses
import datetime
import json
import os
import re
import sys
import time
import traceback

from .brief import build_brief
from .config import DEFAULT_CONFIG, load_config, working
from .run import RESTART, Runner, RunnerBusy, runner_lock, wall_sleep
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


def _switch_lines(config) -> list[str]:
    """Each lane's switch (`control.py`), then each repo Stefan stopped (ticket 37), as the log
    says them."""
    from . import control
    switch = control.read(config.state_dir)
    if switch.error is not None:
        return [control.unreadable_text(switch)]
    return [control.stopped_text(id) if switch.stop(id).stopped else
            f'The {control.NAMES[id]} lane carries on' for id in control.LANES
            ] + _repo_stop_lines(config, switch)


def _repo_stop_lines(config, switch) -> list[str]:
    from . import control
    names, unknown = control.stopped_repos(config.repos, switch)
    return [control.repo_stopped_text(n) for n in names] + (
        [control.unknown_repos_text(unknown)] if unknown else [])


def _print_gate(gate, out, config) -> None:
    """Each lane's switch, the knob, Claude's windows now, the Claude jobs running, and each job
    kind's verdict beside them with how many of that kind could start at once, one per working
    repo with none running (#50). Reads usage once."""
    from . import control
    from .gate import CLAUDE_KINDS, FALLBACK_REVIEW, GATED_KINDS, CostBook, decide
    from .usage import UsageError
    for line in _switch_lines(config):
        print(line, file=out)
    switch = control.read(config.state_dir)
    try:
        knob = gate.knob()
    except (OSError, ValueError) as e:
        print(f'gate.json is unreadable ({e}): no Claude job starts until it is fixed or removed',
              file=out)
        return
    print(f'Claude usage gate: weekly reserve {knob.reserve:g}%', file=out)
    try:
        usage = gate.reader.read()
    except UsageError as e:
        print(f'  usage unreadable: {e}', file=out)
        return
    for name, w in (('5 hours', usage.five_hour), ('week', usage.seven_day)):
        resets = (f', resets {w.resets_at.astimezone().isoformat(timespec="minutes")}'
                  if w.resets_at else ', not started')
        print(f'  {name}: {w.used:g}% used{resets}', file=out)
    jobs = [j for j in _jobs(config).open_jobs() if j.kind in CLAUDE_KINDS]
    running = gate.running([(f'{j.kind} {j.repo}#{j.issue}', j.kind, None) for j in jobs])
    free = [r.name for r in working(config) if r.name not in {j.repo for j in jobs}]
    print(f'  running: {", ".join(running.jobs) if running else "no Claude job"}; '
          f'{len(free)} working repo{"" if len(free) == 1 else "s"} with none running'
          + (f' ({", ".join(free)})' if free else ''), file=out)
    for kind in GATED_KINDS:
        cost = gate.book.expected(kind)
        learned = ' (the cautious default)' if cost == CostBook.default(kind) else ''
        # The Opus review while Sol is out of usage (issue #69) runs in the reviewing lane.
        lane = 'sol' if kind == FALLBACK_REVIEW else 'claude'
        name = 'review (Opus, while Sol is out)' if kind == FALLBACK_REVIEW else kind
        if switch.holds(lane):
            print(f'  {name}: waits: the {control.NAMES[lane]} lane is stopped by Stefan',
                  file=out)
            continue
        if kind == FALLBACK_REVIEW:
            # The Sol lane's one review at a time, checked alone (fallback.py), as it starts.
            v = decide(usage, kind, cost, knob, gate.clock())
            print(f'  {name}: {"starts" if v.go else "waits"}: {v.text}{learned}', file=out)
            continue
        v = decide(usage, kind, cost, knob, gate.clock(), running)
        print(f'  {name}: {"starts" if v.go else "waits"}: {v.text}{learned}; '
              f'{_could_start(usage, kind, cost, knob, gate.clock(), running, len(free))} '
              'could start at once', file=out)


def _could_start(usage, kind, cost, knob, now, running, free: int) -> int:
    """How many `kind` jobs the gate would let in one after another, beside `running`, with
    one per repo that has none running."""
    from .gate import decide
    n = 0
    while n < free and decide(usage, kind, cost, knob, now, running).go:
        running, n = running.plus(f'{kind} {n + 1}', cost), n + 1
    return n


def _now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


def _switch(config, args, out) -> int:
    """`--pause [LANE]` and `--resume [LANE]`: control.json, as the dashboard's Stop and Resume
    write it (`control.py`)."""
    from . import control
    lane = args.pause or args.resume
    served = [r.name for r in config.repos]
    words = (*control.LANES, 'all')   # a lane's id and all keep their meaning (ticket 30)
    if lane not in (*words, *served):
        print(f'--pause and --resume take {", ".join(words)}'
              + (f', {", ".join(served[:-1])} or {served[-1]}' if served else '')
              + f', not {lane!r}.', file=out)
        return 2
    repos = () if lane in words else (lane,)
    lanes = control.LANES if lane == 'all' else () if repos else (lane,)
    if (was := control.read(config.state_dir)).error:
        print(f'{was.error}; writing it afresh.', file=out)
    control.ask(config.state_dir, lanes, 'after-job' if args.pause else None, _now_iso(),
                repos=repos)
    for name in repos:   # ticket 37: one repo, in both lanes
        print(f'{control.repo_stopped_text(name)}.' if args.pause else
              f'{control.repo_resumed_text(name)}: both lanes take up its work again on their '
              'next pass.', file=out)
    for id in lanes:
        if args.pause:
            print(f'{control.stopped_text(id)}. A job running now runs to its end.', file=out)
        else:
            print(f'The {control.NAMES[id]} lane carries on: it starts jobs again on its next '
                  'pass.', file=out)
    return 0


def _knob(config, args, out) -> int:
    from . import control
    from .gate import Knob, read_knob, write_knob
    if not 0 <= args.reserve <= 100:
        print('--reserve takes a percent from 0 to 100.', file=out)
        return 2
    try:
        read_knob(config.state_dir)
    except (OSError, ValueError) as e:   # set afresh
        print(f'gate.json was unreadable ({e}); writing it afresh.', file=out)
    else:
        control.carry_over(config.state_dir, _now_iso())   # an older pause in it stands
    write_knob(config.state_dir, Knob(reserve=args.reserve))
    print(f'The weekly reserve is {args.reserve:g}%. A running runner reads this before its '
          'next Claude job.', file=out)
    return 0


def _limit_ahead(config, out, log_line) -> bool:
    """While a job a usage limit cut off may not resume yet, no Claude job starts in any repo
    (the limit is the whole account's): said first."""
    import datetime
    from .config import stopped
    now = datetime.datetime.now(datetime.timezone.utc)
    ahead = [j for j in _jobs(config).limited_jobs() if j.repo not in stopped(config)
             and j.resume_at and datetime.datetime.fromisoformat(j.resume_at) > now]
    if not ahead:
        return False
    j = max(ahead, key=lambda j: datetime.datetime.fromisoformat(j.resume_at))
    line = (f'dry run: {j.kind} {j.repo}#{j.issue} was cut off by a usage limit: no Claude job '
            f'starts in any repo before {j.resume_at}. Then each repo would:')
    log_line(line)
    print(line, file=out)
    return True


def _dry_run_limited(config, out, log_line) -> bool:
    """A job cut off by a usage limit comes first in its repo: when, and in place or fresh."""
    from .config import stopped
    import datetime
    from .limits import resume_choice
    limited = [j for j in _jobs(config).limited_jobs() if j.repo not in stopped(config)
               and j.repo in {r.name for r in config.repos}]
    if not limited:
        return False
    j = limited[0]
    when = datetime.datetime.fromisoformat
    # As the stop's record says it would be chosen at its resume time; the run chooses again.
    then = resume_choice(when(j.last_request) if j.last_request else None, j.context,
                         when(j.resume_at)) if j.resume_at else None
    how = ('continue its thread in place' if then and then.in_place else
           'restart it in a fresh thread') + (f' ({then.why})' if then else '')
    line = (f'dry run: {j.kind} {j.repo}#{j.issue} was cut off by a usage limit; after '
            f'{j.resume_at} the runner would {how} ({j.link or j.thread_id}), before any other '
            f'Claude job in {j.repo}')
    log_line(line)
    print(line, file=out)
    return True


def _dry_run(config, github, git, out, log_line, t3=None, gate=None) -> int:
    from . import control
    switch = control.read(config.state_dir)
    if switch.error is not None:
        print(f'dry run: {control.unreadable_text(switch)}. Once it is, the lanes would:',
              file=out)
    for id in control.LANES:
        if switch.error is None and switch.stop(id).stopped:
            print(f'dry run: {control.stopped_text(id)}. Once resumed, it would:', file=out)
    config = dataclasses.replace(config, repos=list(config.repos))
    if switch.error is None:   # ticket 37: what a stopped repo holds back, as the lanes do
        from .config import set_stopped
        for line in _repo_stop_lines(config, switch):
            print(f'dry run: {line}', file=out)
        set_stopped(config, control.stopped_repos(config.repos, switch)[0])
    _limit_ahead(config, out, log_line)
    for repo in working(config):   # each working repo's own job, side by side (#50)
        one = dataclasses.replace(config, repos=[repo])
        print(f'dry run: {repo.name}\'s Claude job:', file=out)
        if not _dry_run_limited(one, out, log_line) and \
                not _dry_run_ask(one, github, t3, switch, out, log_line) and \
                not _dry_run_decision(one, github, t3, out, log_line) and \
                not _dry_run_live(one, github, git, t3, out, log_line) and \
                not _dry_run_fix(one, github, git, out, log_line):
            _dry_run_build(one, github, out, log_line)
    if not working(config):
        print('dry run: no repo is working: Stefan stopped them all.', file=out)
    if gate is not None:
        _print_gate(gate, out, config)
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
    for repo in working(config):   # a stopped repo: none (37)
        if not repo.github:
            continue
        for pr in sorted(github.open_pulls(repo), key=lambda p: p.number):
            for kind, why, _ in stopper.new_stops(repo, pr):
                print(f'  {repo.name}#{pr.number}: would stop for Stefan ({kind}): {why}',
                      file=out)
            if why := held(jobs, repo, pr.number):
                print(f'  {repo.name}#{pr.number}: {why}', file=out)


def _dry_run_ask(config, github, t3, switch, out, log_line) -> bool:
    """Prints the ask thread Stefan asked for that the Claude lane would open first (ticket 35),
    with its brief."""
    from .ask_threads import AskThreads
    from .decisions import Decider
    from .stops import Stopper
    if switch.error is not None:
        return False
    jobs = _jobs(config)
    decider = Decider(config, github=github, t3=t3, jobs=jobs, say=lambda line: None,
                      stopper=Stopper(config, github=github, jobs=jobs, say=lambda line: None))
    asking = AskThreads(config, github=github, t3=t3, jobs=jobs, say=lambda line: None,
                        decider=decider)
    found = asking.next(switch)
    if found is None:
        return False
    repo, stop, pr = found
    log_line(f'dry run: would open an ask thread on {repo.name}#{pr.number}')
    print(f'Would open a T3 thread for Stefan to decide {repo.name}#{pr.number} in (dry run: '
          'nothing started)', file=out)
    print('  brief:', file=out)
    print('-' * 72, file=out)
    print(asking.brief(repo, stop, pr), file=out)
    print('-' * 72, file=out)
    return True


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


class _NoStops:
    """A dry run's stopper: files nothing."""

    def file(self, *args, **kwargs):
        return 'dry-run'


def _dry_run_live(config, github, git, t3, out, log_line) -> bool:
    """Prints the live run the Claude lane would start, with its brief, and why each repo with
    live steps waits. It fetches the base (a remote ref only) and records and files nothing, not
    even a first sight."""
    from .live import LiveSteps
    from .merge import Merger
    jobs = _jobs(config)
    said = []
    live = LiveSteps(config, github=github, git=git, t3=t3, jobs=jobs, say=said.append,
                     stopper=_NoStops(), merger=Merger(config, github=github, git=git, jobs=jobs,
                                                       say=lambda line: None))
    for repo in live.served():
        try:
            b = live.batch(repo, record=False)
        except Exception as e:
            print(f'Live {repo.name}: reading its state failed ({type(e).__name__}: {e})',
                  file=out)
            continue
        for line in said:
            print('L' + line[1:], file=out)
        said.clear()
        if b is None:
            continue
        log_line(f'dry run: would start live steps on {repo.name} at {b.target[:7]}')
        print(f'Would start the live steps on {repo.name} (dry run: nothing started)', file=out)
        print(f'  batch:  {", ".join(f"#{n}" for n in b.prs)} merged, '
              f'{b.start[:7]}..{b.target[:7]}', file=out)
        print('  brief:', file=out)
        print('-' * 72, file=out)
        print(live.brief(repo, b), file=out)
        print('-' * 72, file=out)
        return True
    return False


def _dry_run_fix(config, github, git, out, log_line) -> bool:
    """Prints the fix round the Claude lane would start, with its brief. It fetches the PR's
    head (local refs only) so the brief's commits and files are real; nothing else changes."""
    from .fix import Fixer
    from .fix import fix_branch
    fixer = Fixer(config, github=github, git=git, jobs=_jobs(config))
    for repo in working(config):   # a stopped repo: none (37)
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
            log_line(f'dry run: would start a {"fix" if review else "conflict"} round on '
                     f'{repo.github}#{pr.number}')
            print('Would start a fix round (dry run: nothing started)', file=out)
            print(f'  repo:   {repo.github} ({repo.path})', file=out)
            print(f'  PR:     #{pr.number} {pr.title}, '
                  + (f'after review {review.round}' if review else
                     f'a conflict round: it conflicts with {pr.base}'), file=out)
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
    for repo in working(config):   # a stopped repo: none (37)
        if not repo.github:
            continue
        for pr, why in merger.candidates(repo):
            would = (('ready for Stefan at' if merger.ready(repo, pr) else
                      'would mark ready for Stefan at') if repo.stefan_merges else 'would merge at')
            print(f'  {repo.name}#{pr.number}: ' + (f'not now, {why}' if why else
                                                    f'{would} {pr.head_sha[:7]}'), file=out)


def _dry_run_build(config, github, out, log_line) -> None:
    from .picker import pick
    jobs = _jobs(config)
    for repo in working(config):   # a stopped repo: none (37)
        if repo.local_issues:   # shown, but the lane builds none: go on to what it would build
            _dry_run_ticket(repo, out, log_line)
            continue
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
    names = ', '.join(r.name for r in working(config))
    log_line(f'dry run: nothing to start in {names}')
    print(f'Nothing to start in {names}: no unblocked ready-for-agent issue that isn\'t '
          'already being built or held.', file=out)


def _dry_run_ticket(repo, out, log_line) -> None:
    """A repo whose tickets are local: the ticket a build would take. The runner builds none
    (no served repo needs the no-remote flow: ticket 12), so the dry run says so."""
    from .tickets import pick_ticket
    ticket = pick_ticket(repo.path)
    if ticket is None:
        return
    log_line(f'dry run: next local ticket in {repo.name} is {ticket.key}')
    print(f'Next local ticket in {repo.name} (dry run; the runner builds no local tickets yet: '
          'ticket 12 asks Stefan how)', file=out)
    print(f'  repo:   {repo.name} ({repo.path})', file=out)
    print(f'  ticket: {ticket.key} {ticket.title}', file=out)
    print(f'  file:   {ticket.path}', file=out)


def _dry_run_reviews(config, github, out) -> None:
    from .ledger import next_round, read_reviews
    from .review import DryRunPoster, Reviewer
    reviewer = Reviewer(config, github=github, git=None, sol=None, jobs=_jobs(config),
                        say=lambda line: None, poster=DryRunPoster(lambda line: None))
    print('Sol reviews (dry run: Sol not started):', file=out)
    for repo in working(config):   # a stopped repo: none (37)
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


def _review(config, github, git, sol, value, out, log_line, toaster=None, deps=None) -> int:
    """`--review NAME#N`: one Sol review now, under sol.lock, if the PR needs one."""
    from .review import Reviewer
    ref = _repo_ref(value, config, '--review', out)
    if ref is None:
        return 2

    def say(line):
        log_line(line)
        print(line, file=out)
    reviewer = Reviewer(config, github=github, git=git, sol=sol, jobs=_jobs(config), say=say,
                        toaster=toaster, deps=deps)
    try:
        _, why = reviewer.review_one(*ref)
    except RunnerBusy:
        print('Another Sol job is running (sol.lock): one at a time.', file=out)
        return EXIT_LOCKED
    if why:
        print(f'{value}: not reviewed: {why}.', file=out)
        return 1
    return 0


def _commit() -> str | None:
    """The commit this runner's code is on (the snapshot's `runner.commit`)."""
    import subprocess
    try:
        p = subprocess.run(['git', '-C', os.path.dirname(DEFAULT_CONFIG), 'rev-parse', '--short',
                            'HEAD'], capture_output=True, text=True, timeout=10,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.SubprocessError):
        return None
    return p.stdout.strip() or None if p.returncode == 0 else None


def _utc_now():
    return datetime.datetime.now(datetime.timezone.utc)


def _snapshot(config, gate, sol_usage, clock, out, github, git) -> int:
    """`--snapshot`: one snapshot from the state now, printed. It reads Claude's usage once,
    ChatGPT's through codex app-server (ticket 42), and GitHub once for the Inbox and the work
    as the Sol lane would (ticket 32; git only read, nothing fetched), takes no lock, and starts, posts, records and
    writes nothing. The runner's pid and start are runner.pid's, if one is there."""
    from .inbox import Reader as InboxReader
    from .snapshot import Calls, RunnerInfo, Snapshots, Watch
    from .work import Memo, Reader as WorkReader
    calls = Calls(clock)
    github = calls.watch(github, 'github')
    readers = {'inbox': InboxReader(config, github, _jobs(config), clock),
               'work': WorkReader(config, github, git, _jobs(config), clock)}
    shared = Memo(github)
    for reader in readers.values():
        reader.read(shared)
    pid = started = None
    with contextlib.suppress(OSError, ValueError):
        with open(_pid_file(config), encoding='utf-8') as f:
            pid = int(f.read().strip())
        started = datetime.datetime.fromtimestamp(os.path.getmtime(_pid_file(config)),
                                                  datetime.timezone.utc)
    snaps = Snapshots(config, calls=calls, clock=clock, info=RunnerInfo(pid, started, _commit()),
                      readers=readers,
                      claude=Watch(gate.reader.read, calls, 'claude_usage', clock),
                      sol=Watch(sol_usage, calls, 'sol_usage', clock, timed=True))
    print(json.dumps(snaps.build(fresh=True), indent=1, ensure_ascii=False), file=out)
    return 0


def _publisher(config, runner, calls, claude, sol_usage, clock, log_line, every):
    """The running runner's snapshot (`snapshot.py`): written by both lanes and its own thread."""
    from .snapshot import Publisher, RunnerInfo, Snapshots, Watch
    snaps = Snapshots(config, calls=calls, clock=clock, runner=runner, claude=claude,
                      sol=Watch(sol_usage, calls, 'sol_usage', clock, timed=True),
                      info=RunnerInfo(os.getpid(), clock(), _commit()))
    return Publisher(os.path.join(config.state_dir, 'snapshot.json'), snaps.build, log_line,
                     every=every)


def _pid_file(config) -> str:
    return os.path.join(config.state_dir, 'runner.pid')


def _kill(pid: int) -> tuple[int, str]:
    """taskkill, but only a Python process: a pid left in runner.pid may have been reused."""
    import subprocess
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    p = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/FO', 'CSV', '/NH'],
                       capture_output=True, text=True, errors='replace', creationflags=flags)
    image = p.stdout.strip().split(',')[0].strip('"').lower()
    if not image.startswith('python'):
        return 1, f'pid {pid} is {image or "not running"}, not the runner (runner.pid is stale)'
    p = subprocess.run(['taskkill', '/PID', str(pid), '/F'], capture_output=True, text=True,
                       errors='replace', creationflags=flags)
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


def _own_repo(config):
    """The served repo this runner's code runs from, if any (ticket 14)."""
    here = os.path.normcase(os.path.dirname(DEFAULT_CONFIG))
    return next((r for r in config.repos
                 if r.github and os.path.normcase(os.path.abspath(r.path)) == here), None)


def _self_update(config, log_line):
    from .restart import SelfUpdate
    repo = _own_repo(config)
    return SelfUpdate(repo, say=log_line) if repo else None


def _relauncher(config, toaster, log_line):
    """Starts the same command again in the runner's own checkout (`restart.relaunch`)."""
    from .restart import relaunch
    repo = _own_repo(config)
    cmd = [sys.executable, *sys.orig_argv[1:]]
    return lambda sha: relaunch(cmd, cwd=repo.path, sha=sha, github=repo.github,
                                pid_file=_pid_file(config),
                                err_file=os.path.join(config.log_dir, 'restart.err'),
                                toaster=toaster, say=log_line)


def main(argv=None, github=None, out=None, t3=None, git=None, sleep=None,
         sol=None, toaster=None, usage=None, clock=None, limits=None,
         t3_settings=None, waker=None, kill=_kill, self_update=None, relaunch=None,
         sol_usage=None, snapshot_every=None) -> int:
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
    # A lane (claude, sol, all) or a served repo's name (ticket 37), checked once config is read
    knob.add_argument('--pause', nargs='?', const='claude', metavar='LANE|REPO',
                      help='stop a lane after its job: claude (the default), sol or all; or '
                           "one served repo, in both lanes; the dashboard's Stop")
    knob.add_argument('--resume', nargs='?', const='claude', metavar='LANE|REPO',
                      help="let a lane or a repo carry on: claude (the default), sol, all or a "
                           "repo's name; the dashboard's Resume")
    parser.add_argument('--reserve', type=float, metavar='PERCENT',
                        help='the share of the week kept for Stefan until 24h before its reset')
    parser.add_argument('--stop', action='store_true', help='stop the running runner')
    parser.add_argument('--inbox', action='store_true',
                        help='list everything waiting on Stefan: PRs ready to merge, '
                             'needs-info stops, threads waiting for an answer')
    parser.add_argument('--snapshot', action='store_true',
                        help="print the dashboard's snapshot built from the state now (no lock; "
                             'starts, posts and records nothing)')
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
        code = 0
        if args.reserve is not None:
            code = _knob(config, args, out)
        if code == 0 and (args.pause or args.resume):
            code = _switch(config, args, out)
        if code == 0:
            log_line(f'Stefan: {" ".join(argv or sys.argv[1:])}')
        return code
    gate = _gate(config, usage, clock)
    if args.gate:
        _print_gate(gate, out, config)
        return 0
    if sol_usage is None:
        from .codex_usage import CodexUsage   # as T3 reads it (ticket 42)
        sol_usage = CodexUsage().read
    snap_clock = clock or _utc_now
    if github is None:
        from .github import GhCli
        github = GhCli()
    if git is None:
        from .git import GitCli
        git = GitCli()
    if args.snapshot:
        return _snapshot(config, gate, sol_usage, snap_clock, out, github, git)

    if args.inbox:   # read only: posts, starts and records nothing
        from .inbox import report
        print(report(config, github, _jobs(config)), file=out)
        return 0
    if args.dry_run:   # T3 only read: a waiting or failed thread's last messages for a brief
        if t3 is None:
            from .t3 import T3Cli
            t3 = T3Cli()
        return _dry_run(config, github, git, out, log_line, t3, gate)
    deps = None   # a test's fake Sol reviews with no dependency installs
    if sol is None:
        from .deps import Deps
        from .sol import SolCli
        sol = SolCli(script=config.sol_script, bash=config.sol_bash)
        deps = Deps(config.deps_dir)
    if toaster is None:
        from .toast import WindowsToaster
        toaster = WindowsToaster()
    if args.review:
        return _review(config, github, git, sol, args.review, out, log_line, toaster, deps)

    if t3 is None:
        from .t3 import T3Cli
        t3 = T3Cli()
    from .limits import T3Store, auto_resume_warning
    if limits is None:
        limits = T3Store()
    if waker is None and not args.once:
        from .wake import Schtasks, Waker
        waker = Waker(Schtasks(), say=lambda line: runner.say(line), now=clock)
    if self_update is None and not args.once:
        self_update = _self_update(config, log_line)
    calls = None
    if not args.once:   # the dashboard's sources: the last real call of each kind
        from .snapshot import Calls, Watch
        calls = Calls(snap_clock)
        github, t3 = calls.watch(github, 'github'), calls.watch(t3, 't3')
        gate.reader = Watch(gate.reader.read, calls, 'claude_usage', snap_clock)
    # The effort Claude jobs run at (ticket 39): read from T3's own files when the limits store
    # is T3's real database (a test's fake store reads none, so nothing is read back).
    from .effort import Effort, T3Files, T3_SETTINGS
    effort = Effort(config, files=T3Files(settings=t3_settings or T3_SETTINGS, db=limits.path,
                                          projects=limits.projects)
                    if isinstance(limits, T3Store) else None)
    runner = Runner(config, github=github, t3=t3, git=git, out=out, log_line=log_line, sol=sol,
                    toaster=toaster, gate=gate, limits=limits, now=clock, waker=waker,
                    self_update=self_update, deps=deps, effort=effort)
    if calls is not None:   # continuous mode only: --once writes no snapshot
        from .snapshot import WRITE_EVERY
        runner.publisher = _publisher(config, runner, calls, gate.reader, sol_usage, snap_clock,
                                      log_line, snapshot_every or WRITE_EVERY)
    if warning := auto_resume_warning(*([t3_settings] if t3_settings else [])):
        runner.say(f'Warning: {warning}')
    effort.check(config.repos)   # how each served repo's Claude jobs start, and at what effort
    restart = None
    try:
        with runner_lock(config.state_dir):
            with open(_pid_file(config), 'w', encoding='utf-8') as f:
                f.write(str(os.getpid()))
            try:
                if args.once:
                    runner.run_once()
                else:
                    log_line(f'runner started (pid {os.getpid()})')
                    runner.wait_for_t3(sleep)
                    if runner.run_forever(sleep) == RESTART:
                        restart = runner.restart_sha
            finally:   # a runner that ends leaves no pid for --stop to find
                with contextlib.suppress(OSError):
                    os.remove(_pid_file(config))
    except RunnerBusy as e:
        log_line(f'a second runner started (pid {os.getpid()}) and exited at once: {e}')
        print(f'A queue runner is already running ({e}).', file=out)
        return EXIT_LOCKED
    except Exception:
        log_line('runner stopped on an error:\n' + traceback.format_exc())
        raise
    if restart:   # runner.lock and runner.pid are free for the new runner now
        if relaunch is None:
            relaunch = _relauncher(config, toaster, log_line)
        return 0 if relaunch(restart) else 1
    return 0

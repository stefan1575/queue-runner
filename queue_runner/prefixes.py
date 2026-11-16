"""Threads that need Stefan say so in their title (issue #71; spec #68), so T3's sidebar tells him
at a glance what's his to do. Only two prefixes, and only on threads the runner started (ids from
its own job records):

- **"Decide: "** on an ask thread (`ask_threads.py`) while its stop waits on his decision: filed,
  not released, not decided. It's launched with it.
- **"Answer: "** on a build or fix thread that waits for an answer a decision left to him (the
  `waiting` question's `stop`), while it still waits and isn't released.

Once it no longer needs him (he decided in the thread or on GitHub, answered in the thread or on
GitHub (`waiting.py`), or released it) the prefix comes off and the thread is settled.
Everything else is settled without a prefix (ticket 70), so there's no "Done" or "Blocked".

`Prefixes.sync` runs in each Claude pass, right after settling (so also while a dead runner's
job runs on, or the lane is stopped), and again after answers are read. It works from the job
log and the thread's title as T3 gives it (`thread list`, once per repo, and only for a repo
with a thread to change), so a title is never prefixed twice, a runner that restarted puts right
what an earlier one left, and a rename or settle that failed is tried again next pass (said
once). A thread still running
keeps its prefix until its run ends. What's in order is remembered for the process, so a quiet
pass calls T3 for nothing.
"""
from .state import NOT_STARTED

DECIDE = 'Decide: '
ANSWER = 'Answer: '
PREFIXES = (DECIDE, ANSWER)


def plain(title: str) -> str:
    """The title with every prefix the runner puts on taken off."""
    while True:
        p = next((p for p in PREFIXES if title.startswith(p)), None)
        if p is None:
            return title
        title = title[len(p):]


def titled(prefix: str, title: str) -> str:
    """The title with `prefix` on it once, whatever prefix it had."""
    return prefix + plain(title)


def waiting_on_stefan(all_jobs, released) -> tuple[dict, dict]:
    """(the runner's threads that need Stefan now, {thread id: (repo, prefix)}; every thread
    that ever did, {thread id: repo})."""
    from .ask_threads import KIND, OPENED
    by_id = {j.id: j for j in all_jobs}
    decided: dict[str, object] = {}   # job id -> the newest decision on it that ran
    newest_ask: dict[str, object] = {}   # stop id -> the newest ask thread opened on it
    for j in all_jobs:
        if j.kind == 'decision' and j.about and j.outcome != NOT_STARTED:
            decided[j.about] = j
        if j.kind == KIND and j.outcome == OPENED:
            newest_ask[j.about] = j
    # A thread a later job carries on (his answer sent to it, a decision's retry) isn't done
    # with while that job runs or waits: its own end settles it, or its own decision prefixes it.
    going = {j.thread_id for j in all_jobs if j.kind in ('build', 'fix') and j.thread_id
             and (j.open or j.outcome == 'waiting') and j.id not in released}
    now, ever = {}, {}
    for j in all_jobs:
        if not j.thread_id:
            continue
        if j.kind == KIND and j.outcome == OPENED:
            ever[j.thread_id] = j.repo
            stop = by_id.get(j.about)
            if (stop is not None and stop.outcome == 'filed' and stop.id not in released
                    and stop.id not in decided and newest_ask.get(stop.id) is j):
                now[j.thread_id] = (j.repo, DECIDE)
        elif j.kind in ('build', 'fix'):
            d = decided.get(j.id)
            if d is None or d.question != 'waiting' or d.open or d.outcome != 'stop':
                continue
            if j.outcome == 'waiting' and j.id not in released:
                now[j.thread_id] = (j.repo, ANSWER)
                ever[j.thread_id] = j.repo
            elif j.thread_id not in going:
                ever[j.thread_id] = j.repo
    return now, ever


class Prefixes:
    """The Claude lane's part: each pass, the titles of the runner's threads that need Stefan."""

    def __init__(self, config, *, t3, jobs, say):
        self.config, self.t3, self.jobs, self.say = config, t3, jobs, say
        self._marked: set[str] = set()   # prefixed as they should be
        self._done: set[str] = set()     # plain and settled (or gone from T3)
        self._said: dict[str, str] = {}

    def _once(self, key: str, text: str) -> None:
        if self._said.get(key) != text:
            self.say(text)
        self._said[key] = text

    def sync(self) -> None:
        """Never raises: a title left as it is stops no lane."""
        if self.t3 is None:
            return
        try:
            now, ever = waiting_on_stefan(self.jobs.jobs(), self.jobs.released_ids())
        except Exception as e:   # noqa: BLE001 - an unreadable job log is the lanes' to say
            self._once('log', f'thread titles: reading the job log failed ({e})')
            return
        todo: dict[str, list[str]] = {}
        for tid, (repo, _) in now.items():
            self._done.discard(tid)
            if tid not in self._marked:
                todo.setdefault(repo, []).append(tid)
        for tid, repo in ever.items():
            if tid in now:
                continue
            self._marked.discard(tid)
            if tid not in self._done:
                todo.setdefault(repo, []).append(tid)
        repos = {r.name: r for r in self.config.repos}
        for name, ids in todo.items():
            repo = repos.get(name)
            if repo is None:
                continue
            try:
                threads = {t.thread_id: t for t in self.t3.list(repo.path)}
            except Exception as e:   # noqa: BLE001 - T3 down: the next pass
                self._once(f'list {name}', f'thread titles in {name}: listing its T3 threads '
                                           f'failed ({type(e).__name__}: {e}); next pass')
                continue
            self._said.pop(f'list {name}', None)
            for tid in ids:
                t = threads.get(tid)
                if t is None:   # archived or deleted: nothing to put right
                    (self._marked if tid in now else self._done).add(tid)
                elif tid in now:
                    self._mark(t, now[tid][1])
                else:
                    self._clear(t)

    def _name(self, t) -> str:
        """`ask first#20`, `build first#4`: what the log calls the thread's job."""
        words = plain(t.title).removeprefix('Queue runner ').split(': ', 1)
        return ' '.join(words) if len(words) == 2 else t.thread_id

    def _rename(self, t, title: str) -> bool:
        try:
            self.t3.rename(t.thread_id, title)
        except Exception as e:   # noqa: BLE001 - T3 down, refused, or no MCP client
            self._once(t.thread_id, f'{self._name(t)}: renaming its thread {t.thread_id} in T3 '
                                    f'failed ({type(e).__name__}: {e}); tried again next pass')
            return False
        self._said.pop(t.thread_id, None)
        return True

    def _mark(self, t, prefix: str) -> None:
        want = titled(prefix, t.title)
        if t.title == want or self._rename(t, want):
            self._marked.add(t.thread_id)

    def _clear(self, t) -> None:
        if t.active:
            return   # its run ends first: it keeps the prefix until then
        name = plain(t.title)
        if name != t.title and not self._rename(t, name):
            return
        if not t.settled:
            try:
                self.t3.settle(t.thread_id)
            except Exception as e:   # noqa: BLE001
                self._once(t.thread_id, f'{self._name(t)}: settling its thread {t.thread_id} '
                                        f'in T3 failed ({type(e).__name__}: {e}); tried again '
                                        'next pass')
                return
        self._said.pop(t.thread_id, None)
        self._done.add(t.thread_id)

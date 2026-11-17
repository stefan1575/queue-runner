"""A review as a T3 thread (issue #120; first the Opus fallback, #69, and #76): when config.toml's
`[jobs.review]` names a provider other than Codex, every review runs as a T3 thread on its
provider, model and effort; and while the review's own provider is out of usage, a review runs
on its `fallback` (Stefan's config: Opus 5.5 high while Sol is out). Either way the thread
reviews from the same brief Sol gets, and its reply is posted as Sol's is.

It plays the Sol seam (`review(brief, reply, workdir, out, writable)`, as `sol.SolCli`), so the
Reviewer builds the brief, reads the verdict from the sol-findings block and posts exactly as for
Sol. The differences:

- **The usage gate:** a thread on Claude is gated as kind `review` (`gate.FALLBACK_REVIEW`)
  beside the Claude lane's jobs running (#50), and counted among them while it runs (`beside`,
  the Runner); what it spent is recorded like any Claude job's, with `shared_with` the Claude
  lane's jobs that ran meanwhile (PR #74's review 1, F1). A thread on another provider isn't
  gated: the gate reads Claude's usage.
- **Where it runs:** a T3 thread in the repo's project folder with no worktree (T3 can't start a
  thread in an existing folder, and the runner's checkout of H is where the dependencies are
  linked in), told to work in that checkout and change nothing in the project folder. It starts
  as every job does, its provider, model and effort named (#119), but a thread on claudeAgent
  starts on the T3 instance `[review] claude_provider` names, one with no MCP tools
  (docs/reviews.md, A review has no outside tools), never one another job kind runs on, and the
  effort its run used is read back. A run that stops on a usage limit (T3's run record,
  `limits.limit_stop`) is that provider out of usage, as Sol's is (`sol.SolOutOfUsage`).
- **The label:** the comment, the `sol-review` status and the Review row name the model and
  say why ("Opus 5.5 high, fallback while Sol is out", or "Opus 5.5 high, set in config.toml"),
  with the effort read back when it can be.
"""
import os
import re

from .config import CLAUDE, CODEX
from .effort import flags
from .ledger import SolFailed
from .sol import SolOutOfUsage
from .t3 import T3Error, settle_quietly

# The review job's `reviewer`, and why a thread reviewed: the review's own provider was out of
# usage (its fallback), or config.toml names a provider other than Codex for reviews.
KIND = 'opus-fallback'
SET = 'opus-config'
WHY = {KIND: 'fallback while {primary} is out', SET: 'set in config.toml'}
# Who reviewed an earlier job, as the work lists and the Inbox's story say it.
WHO = {KIND: 'Opus (the fallback while Sol is out of usage)', SET: 'Opus (config.toml says so)'}
OPUS_KINDS = tuple(WHO)   # a review job's `reviewer` when a T3 thread reviewed


def gate_label(repo: str, number: int) -> str:
    """A thread review as the usage gate and `shared_with` name it: `review queue-runner#67`."""
    return f'review {repo}#{number}'


class Alone:
    """No Claude lane beside the review (the tests' Reviewer, the live checks): nothing to
    count, nothing shared."""

    def __init__(self):
        import threading
        self.gate_lock = threading.Lock()

    def claude_jobs(self) -> list:
        return []

    def review_began(self, label: str) -> None:
        pass

    def review_shared(self, label: str) -> list:
        return []

    def review_ended(self, label: str) -> None:
        pass


def chosen(config) -> bool:
    """Whether config.toml has every PR reviewed in a T3 thread (`[jobs.review]` on a provider
    other than Codex, issue #120), not only while the review's provider is out of usage."""
    return config.job('review').provider != CODEX


def model_name(model: str) -> str:
    """A model as people say it: `claude-opus-5-5` is `Opus 5.5`, `gpt-6.1-sol` `GPT-6.1 Sol`;
    any other as config.toml names it."""
    if m := re.fullmatch(r'claude-([a-z]+)-(\d+)-(\d+)', model or ''):
        return f'{m[1].title()} {m[2]}.{m[3]}'
    if m := re.fullmatch(r'gpt-(\d[\d.]*)-([a-z]+)', model or ''):
        return f'GPT-{m[1]} {m[2].title()}'
    return model


def reviewer_name(spec) -> str:
    """Who a review's spec is, as the log and a fallback's label say it: the Codex adapter is
    Sol (`sol.py`), a T3 thread its model."""
    return 'Sol' if spec.provider == CODEX else model_name(spec.model)


def label(model: str, effort: str, kind: str = KIND, primary: str = 'Sol') -> str:
    return f'{model_name(model)} {effort}, {WHY[kind].format(primary=primary)}'


def _slash(p: str) -> str:
    return str(p).replace('\\', '/')


def _preamble(workdir: str, project: str, kind: str = KIND, primary: str = 'Sol') -> str:
    wd = _slash(workdir)
    why = (f'{primary}, the usual reviewer, is out of usage, so you review this PR in its place'
           if kind == KIND else 'You review this PR in place of Sol, the usual reviewer')
    return (
        '## First: you review in Sol\'s place\n\n'
        f"{why}, from Sol's own brief below, exactly as it asks. Where it says \"this workdir\", "
        f'it means `{wd}`: a throwaway checkout of the PR\'s head the queue runner made. Run every '
        f'command there (`cd {wd}` first) and read the repo there. This thread starts in the '
        f"repo's own clone (`{_slash(project)}`): change nothing in it, and change nothing "
        'outside the workdir but tests you add there. Don\'t post on GitHub, push, comment or '
        'open anything there: the queue runner posts your reply as the review comment. Your '
        'reply is the review, and its last sol-findings block is its verdict. Ask nothing: '
        'nobody is there to answer. Run tests in the foreground and wait for them: a review has '
        'no MCP tools, T3\'s included, so nothing waits on a background run for you.\n\n')


class ReviewThread:
    """One review in a T3 thread: the Sol seam over one thread on `spec` (a JobSpec). `kind` is
    why a thread reviews (KIND: the review's own provider, `primary`, is out of usage; SET:
    config.toml says so). After `review`, `ran` says whether a thread ran, `record` holds its
    end-record fields and `label` names the reviewer."""

    def __init__(self, reviews: 'ThreadReviews', repo, title: str, spec, kind: str = KIND,
                 primary: str = 'Sol'):
        self.reviews, self.repo, self.title, self.kind = reviews, repo, title, kind
        self.spec, self.primary = spec, primary
        self.ran = False
        self.record: dict = {}
        self.label = label(spec.model, spec.effort, kind, primary)

    def review(self, brief: str, reply: str, workdir: str, out: str,
               writable: list[str] | tuple = ()) -> str:
        """The thread's reply to `brief`, reviewing in `workdir`. Raises SolOutOfUsage for a run
        that stopped on a usage limit, SolFailed for a thread that didn't start or didn't end
        with a reply (failed, waiting, empty)."""
        f, repo = self.reviews, self.repo
        with open(brief, encoding='utf-8') as fh:
            message = _preamble(workdir, repo.path, self.kind, self.primary) + fh.read()
        with open(os.path.join(os.path.dirname(reply), 'brief-opus.md'), 'w', encoding='utf-8',
                  newline='\n') as fh:
            fh.write(message)
        # Its provider, model and effort named (#119), but a thread on claudeAgent starts on the
        # no-tools instance, by name: never one another job kind runs on, which have the build's
        # tools (PR #127's review 1, F1).
        launch = flags(self.spec)
        if self.spec.provider == CLAUDE:
            provider = f.config.review_claude_provider
            if not provider or provider in f.config.build_instances():
                raise SolFailed(f"The {self.name} didn't start: [review] claude_provider "
                                f'({provider!r}) must name a T3 instance with no MCP tools, not '
                                "one [jobs] runs another kind on (docs/reviews.md, A review has "
                                'no outside tools).')
            launch['provider'] = provider
        try:
            result = f.t3.start(repo.path, message, title=self.title, **launch)
        except T3Error as e:
            raise SolFailed(f"The {self.name}'s thread didn't run: {e}") from None
        self.ran = True
        self.record = {'thread_id': result.thread_id, 'run_id': result.run_id}
        if f.effort:
            self.record.update(f.effort.used(repo.name, f'review {repo.name} ({self.name})',
                                             result.thread_id, result.run_id, self.spec.effort))
        if self.record.get('effort'):
            self.label = label(self.spec.model, self.record['effort'], self.kind, self.primary)
        with open(out, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(f'T3 thread {result.thread_id}, run {result.run_id}: exit '
                     f'{result.exit_code}, {result.status}\n{result.error or ""}\n')
        if result.exit_code == 2:
            raise SolFailed(f'The {self.name} thread {result.thread_id} stopped to ask a '
                            'question instead of reviewing.')
        if result.exit_code == 1:
            from .limits import limit_stop
            stop = limit_stop(f.limits, result.thread_id, result.run_id,
                              [result.error, result.reply])
            if stop is not None:   # its provider is out of usage, as Sol's can be
                raise SolOutOfUsage(stop.reset_at and stop.reset_at.astimezone(),
                                    who=model_name(self.spec.model))
        if result.exit_code != 0:
            raise SolFailed(f'The {self.name} thread {result.thread_id} ended '
                            f'{result.status}: {result.error or "no error given"}')
        text = (result.reply or '').strip()
        if not text:
            raise SolFailed(f'The {self.name} thread {result.thread_id} completed with an '
                            'empty reply.')
        with open(reply, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(text + '\n')
        return text

    @property
    def name(self) -> str:
        what = model_name(self.spec.model)
        return f'{what} fallback' if self.kind == KIND else f'{what} review'

    @property
    def who(self) -> str:
        """Who reviews, as the log says it: `Opus 5.5 (the fallback while Sol is out of usage)`."""
        what = model_name(self.spec.model)
        return (f'{what} (the fallback while {self.primary} is out of usage)'
                if self.kind == KIND else f'{what} (config.toml says so)')

    def settle(self, name: str, say) -> None:
        """Settles the thread that ran, once the review's end is recorded, whatever its
        outcome (issue #77): nobody answers a review thread, so one that asked is done too. A
        failed settle is said and never raised (ticket 70). No thread ran: nothing."""
        if self.ran:
            settle_quietly(self.reviews.t3, self.record.get('thread_id'), name, say)


class ThreadReviews:
    """What the Sol lane needs to review in T3 threads: T3, the usage gate (None: every review
    starts, as for the tests' Runner without one), the effort (None: nothing read back), T3's
    run records (`limits.T3Store`; None reads only what the thread said) and `beside`, the
    Claude lane (`run.Runner`: its jobs running, and the review counted among them while it
    runs; `Alone` without one)."""

    def __init__(self, config, *, t3, gate=None, effort=None, beside=None, limits=None):
        self.config, self.t3, self.gate, self.effort = config, t3, gate, effort
        self.limits = limits
        self.beside = beside or Alone()

    def check(self, label: str):
        """The gate's verdict for the Claude review thread `label` now, beside the Claude lane's jobs
        running, or None with no gate (it starts). One let in counts among the Claude jobs
        running until `ended`: the Claude lane's gate counts it, and each side's spending is
        the other's `shared_with`."""
        from .gate import FALLBACK_REVIEW
        with self.beside.gate_lock:   # the Claude lane admits nothing meanwhile
            verdict = None if self.gate is None else self.gate.check(
                FALLBACK_REVIEW, running=self.beside.claude_jobs())
            if verdict is None or verdict.go:
                self.beside.review_began(label)
        return verdict

    def ended(self, label: str) -> None:
        """The review thread `label` let in by `check` is over (posted, failed or never run)."""
        self.beside.review_ended(label)

    def thread(self, repo, title: str, spec, kind: str, primary: str) -> ReviewThread:
        return ReviewThread(self, repo, title, spec, kind, primary)

    def thread_ended(self, job_id: str) -> None:
        """A dead runner's fallback review thread was seen to end (`Reviewer.settle`): the
        Claude lane's next check waits for a reading after it, once per job (PR 67's review 2,
        F2)."""
        if self.gate is not None:
            self.gate.job_ended(job_id)

    def measured(self, jobs: list, verdict, label: str) -> None:
        """What a Claude review thread cost, learned as kind `review`; one that ran
        beside a Claude lane job teaches nothing (`shared_with`, #50)."""
        if self.gate is not None and verdict is not None and verdict.usage is not None:
            from .gate import FALLBACK_REVIEW
            self.gate.measured(FALLBACK_REVIEW, jobs, verdict.usage,
                               shared_with=self.beside.review_shared(label) or None)

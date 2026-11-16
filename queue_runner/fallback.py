"""The Opus reviewer: while Sol is out of usage (the fallback, issue #69), or for every review when
config.toml's `[review] provider` is "claude" (issue #76), the Sol lane has the review run as a T3
thread on the Claude model (`[claude]` in config.toml: Opus 5.5) instead of by Sol, from the same
brief, and posts it as it posts Sol's.

It plays the Sol seam (`review(brief, reply, workdir, out, writable)`, as `sol.SolCli`), so the
Reviewer builds the brief, reads the verdict from the sol-findings block and posts exactly as for
Sol. The differences:

- **The usage gate:** it's a Claude job, gated as kind `review` (`gate.FALLBACK_REVIEW`), and
  what it spent is recorded like any Claude job's.
- **Where it runs:** a T3 thread in the repo's project folder with no worktree (T3 can't start a
  thread in an existing folder, and the runner's checkout of H is where the dependencies are
  linked in), told to work in that checkout and change nothing in the project folder. It starts
  as every Claude job does (`effort.Effort.flags`: on the project's default model at the config's
  effort when that's set, else with --model), and the effort its run used is read back.
- **The label:** the comment, the `sol-review` status and the Review row name it and say why
  ("Opus 5.5 high, fallback while Sol is out", or "Opus 5.5 high, set in config.toml"), with the
  effort read back when it can be.
"""
import os
import re

from .ledger import SolFailed
from .t3 import T3Error

# The review job's `reviewer`, and why Opus reviewed: Sol was out of usage, or config.toml says
# Claude reviews.
KIND = 'opus-fallback'
SET = 'opus-config'
WHY = {KIND: 'fallback while Sol is out', SET: 'set in config.toml'}
# Who reviews, as the log, the work lists and the Inbox's story say it.
WHO = {KIND: 'Opus (the fallback while Sol is out of usage)', SET: 'Opus (config.toml says so)'}


def chosen(config) -> bool:
    """Whether config.toml has Claude review every PR (issue #76), not only while Sol is out."""
    return config.review_provider == 'claude'


def model_name(model: str) -> str:
    """`claude-opus-5-5` as people say it: `Opus 5.5`."""
    m = re.fullmatch(r'claude-([a-z]+)-(\d+)-(\d+)', model or '')
    return f'{m[1].title()} {m[2]}.{m[3]}' if m else model


def label(model: str, effort: str, kind: str = KIND) -> str:
    return f'{model_name(model)} {effort}, {WHY[kind]}'


def _slash(p: str) -> str:
    return str(p).replace('\\', '/')


def _preamble(workdir: str, project: str, kind: str = KIND) -> str:
    wd = _slash(workdir)
    why = ('Sol, the usual reviewer, is out of usage, so you review this PR in its place'
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
        'nobody is there to answer.\n\n')


class OpusThread:
    """One Opus review: the Sol seam over one T3 thread. `kind` is why Opus reviews (KIND: Sol is
    out of usage; SET: config.toml says so). After `review`, `ran` says whether a thread ran,
    `record` holds its end-record fields and `label` names the reviewer."""

    def __init__(self, fallback: 'OpusFallback', repo, title: str, kind: str = KIND):
        self.fallback, self.repo, self.title, self.kind = fallback, repo, title, kind
        self.ran = False
        self.record: dict = {}
        c = fallback.config
        self.label = label(c.claude_model, c.claude_effort, kind)

    def review(self, brief: str, reply: str, workdir: str, out: str,
               writable: list[str] | tuple = ()) -> str:
        """Opus's reply to `brief`, reviewing in `workdir`. Raises SolFailed for a thread that
        didn't start or didn't end with a reply (failed, waiting, empty)."""
        f, repo = self.fallback, self.repo
        with open(brief, encoding='utf-8') as fh:
            message = _preamble(workdir, repo.path, self.kind) + fh.read()
        with open(os.path.join(os.path.dirname(reply), 'brief-opus.md'), 'w', encoding='utf-8',
                  newline='\n') as fh:
            fh.write(message)
        flags = f.effort.flags(repo) if f.effort else {
            'provider': f.config.claude_provider, 'model': f.config.claude_model}
        try:
            result = f.t3.start(repo.path, message, title=self.title, **flags)
        except T3Error as e:
            raise SolFailed(f"The {self.name}'s thread didn't run: {e}") from None
        self.ran = True
        self.record = {'thread_id': result.thread_id, 'run_id': result.run_id}
        if f.effort:
            self.record.update(f.effort.used(repo.name, f'review {repo.name} ({self.name})',
                                             result.thread_id, result.run_id))
        if self.record.get('effort'):
            self.label = label(f.config.claude_model, self.record['effort'], self.kind)
        with open(out, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(f'T3 thread {result.thread_id}, run {result.run_id}: exit '
                     f'{result.exit_code}, {result.status}\n{result.error or ""}\n')
        if result.exit_code == 2:
            raise SolFailed(f'The {self.name} thread {result.thread_id} stopped to ask a '
                            'question instead of reviewing.')
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
        return 'Opus fallback' if self.kind == KIND else 'Opus review'


class OpusFallback:
    """What the Sol lane needs for the fallback: T3, the usage gate (None: every review starts,
    as for the tests' Runner without one) and the effort (None: --model, nothing read back)."""

    def __init__(self, config, *, t3, gate=None, effort=None):
        self.config, self.t3, self.gate, self.effort = config, t3, gate, effort

    def check(self):
        """The gate's verdict for a fallback review now, or None with no gate (it starts)."""
        if self.gate is None:
            return None
        from .gate import FALLBACK_REVIEW
        return self.gate.check(FALLBACK_REVIEW)

    @property
    def kind(self) -> str:
        """Why Opus reviews now, if it does: config.toml says so (SET), else Sol is out (KIND)."""
        return SET if chosen(self.config) else KIND

    def thread(self, repo, title: str) -> OpusThread:
        return OpusThread(self, repo, title, self.kind)

    def measured(self, jobs: list, verdict) -> None:
        """What a fallback review that ran a thread cost, learned as kind `review`."""
        if self.gate is not None and verdict is not None and verdict.usage is not None:
            from .gate import FALLBACK_REVIEW
            self.gate.measured(FALLBACK_REVIEW, jobs, verdict.usage)

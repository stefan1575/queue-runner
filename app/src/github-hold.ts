// A job's question on GitHub holds its repo (#211's decision, comment 7029694194): when a job needs
// the user, its repo waits until they answer. A builder that can't go on asks on its issue and
// swaps the issue's `ready-for-agent` for `needs-info`, then ends its turn; that pauses the job,
// it doesn't end it. GitHub is the source of truth, and the app reads it on its own timer (each
// pass): never T3 on a timer. The thread watch (`watchJobThread`) asks `open()` once the job's
// runs have ended, and the job ends only when GitHub has no question open: its repo stays held,
// its thread unsettled, meanwhile. Sending the answer back into the thread is #159's.
import type { GithubHold } from './t3/thread-end.ts';

export class QuestionHold implements GithubHold {
  private value: string | null | undefined = undefined;
  private reading = false;
  private since = false;
  private failed = false;
  /** Decides the watch again on GitHub's new answer (`Following.recheck`): no T3 read. */
  recheck: () => void = () => {};
  private ask: () => Promise<string | null>;
  private say: (line: string) => void;

  /** `ask` reads GitHub: the question open now, or null; it throws when GitHub can't be read. */
  constructor(ask: () => Promise<string | null>, say: (line: string) => void) {
    this.ask = ask;
    this.say = say;
  }

  open(): string | null | undefined { return this.value; }

  /** The job's runs have just ended: what GitHub said before is stale, so it's read now. */
  ended(): void {
    this.since = true;
    this.value = undefined;
    this.refresh();
  }

  /** Whether the job waits on GitHub: its runs ended, and a question is open or not read yet. */
  get waiting(): boolean { return this.since && this.value !== null; }

  /** Reads GitHub again (`ended`, and each pass while `waiting`), one read at a time. A read that
   *  fails keeps what was known (not read yet holds), is said once, and is read again next pass. */
  refresh(): void {
    if (this.reading) return;
    this.reading = true;
    void (async () => {
      try {
        this.value = await this.ask();
        this.failed = false;
      } catch (e) {
        if (!this.failed) this.say(`GitHub couldn't be read for its question (${(e as Error).message}); read again next pass`);
        this.failed = true;
      } finally {
        this.reading = false;
      }
      this.recheck();
    })();
  }
}

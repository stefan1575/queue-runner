// The records learned costs come from (#153; `src/costs.ts`): `usage.jsonl` in the state folder,
// one JSON object a line, appended.
import { readFileSync, truncateSync } from 'node:fs';
import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UsageRecord } from './costs.ts';

export class CostLogError extends Error {}

/** `usage.jsonl`: read whole at the start, appended as jobs are measured. A torn last line (a
 *  crash mid-write) is cut off; a bad line anywhere else, or a file that can't be read, makes the
 *  log unreadable: `records()` throws, so the gate holds every start with why, and the file is read
 *  again at each ask until it reads, as Python's gate reads it at each check (review 1 of #262, F3).
 *  Opening never fails, so the run loop settles first. */
export class CostLog {
  private file: string;
  private all: UsageRecord[];
  /** Why the file can't be read, or null. */
  private unreadable: string | null;
  private writing: Promise<void> = Promise.resolve();

  private constructor(file: string, records: UsageRecord[], unreadable: string | null) {
    this.file = file;
    this.all = records;
    this.unreadable = unreadable;
  }

  static async open(file: string): Promise<CostLog> {
    let data = Buffer.alloc(0);
    try {
      data = await readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return new CostLog(file, [], `${file} can't be read: ${(e as Error).message}`);
    }
    const read = parse(file, data);
    if (typeof read === 'string') return new CostLog(file, [], read);
    // and off the disk, so the next record isn't written onto it
    if (read.whole < data.length) await truncate(file, read.whole);
    return new CostLog(file, read.records, null);
  }

  /** The records; throws CostLogError while the file can't be read, after reading it again. */
  records(): UsageRecord[] {
    if (this.unreadable !== null) this.reread();
    if (this.unreadable !== null) throw new CostLogError(this.unreadable);
    return this.all;
  }

  private reread() {
    let data = Buffer.alloc(0);
    try {
      data = readFileSync(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.unreadable = `${this.file} can't be read: ${(e as Error).message}`;
        return;
      }
    }
    const read = parse(this.file, data);
    if (typeof read === 'string') {
      this.unreadable = read;
      return;
    }
    if (read.whole < data.length) truncateSync(this.file, read.whole);
    this.all = read.records;
    this.unreadable = null;
  }

  /** The record appended, as Python's `append_record` writes it: a torn last line (a crash, or a
   *  write that failed partway) is cut off first, and the record is kept, for what the gate
   *  learns, only once its write succeeded, so the gate learns only from complete records on disk. */
  async append(record: UsageRecord): Promise<void> {
    const write = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      let text: Buffer | null = null;
      try {
        text = await readFile(this.file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (text?.length && text[text.length - 1] !== 0x0a) await truncate(this.file, text.lastIndexOf(0x0a) + 1);
      await appendFile(this.file, `${JSON.stringify(record)}\n`);
      this.all = [...this.all, record];
    });
    this.writing = write.catch(() => {});
    return write;
  }
}

/** The file's records and where its complete records end, or why it isn't records. Every complete
 *  record ends in a newline; what follows the last one was torn by a crash (maybe inside a multibyte
 *  character), so it's cut off before it's parsed, as Python's `read_records` cuts it (review 3 of
 *  #261, F19): a torn record is never learned from. */
function parse(file: string, data: Buffer): { records: UsageRecord[]; whole: number } | string {
  const whole = data.lastIndexOf(0x0a) + 1;
  const records: UsageRecord[] = [];
  const lines = data.subarray(0, whole).toString('utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      return `${file} line ${i + 1} isn't a record`;
    }
  }
  return { records, whole };
}

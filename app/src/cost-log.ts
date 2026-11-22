// The records learned costs come from (#153; `src/costs.ts`): `usage.jsonl` in the state folder,
// one JSON object a line, appended.
import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UsageRecord } from './costs.ts';

export class CostLogError extends Error {}

/** `usage.jsonl`: read whole at the start, appended as jobs are measured. A torn last line (a
 *  crash mid-write) is cut off; a bad line anywhere else is an error, as today's runner has it. */
export class CostLog {
  private file: string;
  private all: UsageRecord[];
  private writing: Promise<void> = Promise.resolve();

  private constructor(file: string, records: UsageRecord[]) {
    this.file = file;
    this.all = records;
  }

  static async open(file: string): Promise<CostLog> {
    let data = Buffer.alloc(0);
    try {
      data = await readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new CostLogError(`${file} can't be read: ${(e as Error).message}`);
    }
    // Every complete record ends in a newline; what follows the last one was torn by a crash (maybe
    // inside a multibyte character), so it's cut off before it's parsed, as Python's
    // `read_records` cuts it (review 3 of #261, F19): a torn record is never learned from.
    const whole = data.lastIndexOf(0x0a) + 1;
    const records: UsageRecord[] = [];
    data.subarray(0, whole).toString('utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      try {
        records.push(JSON.parse(line));
      } catch {
        throw new CostLogError(`${file} line ${i + 1} isn't a record`);
      }
    });
    // and off the disk, so the next record isn't written onto it
    if (whole < data.length) await truncate(file, whole);
    return new CostLog(file, records);
  }

  records(): UsageRecord[] {
    return this.all;
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

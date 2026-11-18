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
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new CostLogError(`${file} can't be read: ${(e as Error).message}`);
    }
    const lines = text.split('\n');
    const records: UsageRecord[] = [];
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try {
        records.push(JSON.parse(line));
      } catch {
        if (i < lines.length - 1 && lines.slice(i + 1).some((l) => l.trim())) throw new CostLogError(`${file} line ${i + 1} isn't a record`);
      }
    });
    // a torn last line is cut off, so the next record isn't written onto it
    if (text && !text.endsWith('\n')) await truncate(file, Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)));
    return new CostLog(file, records);
  }

  records(): UsageRecord[] {
    return this.all;
  }

  async append(record: UsageRecord): Promise<void> {
    this.all = [...this.all, record];
    const write = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(record)}\n`);
    });
    this.writing = write.catch(() => {});
    return write;
  }
}

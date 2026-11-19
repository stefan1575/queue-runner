// Where the app keeps its state: the one thing in a machine file (#36, Fixed: "The state folder
// stays in a file"). Everything else the app keeps lives in that folder.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The state folder the machine file names. A first start writes `fallback` into it. A file that
 *  can't be read stops the start: guessing would start the app on an empty state. */
export function stateFolder(machineFile: string, fallback: string): string {
  if (!existsSync(machineFile)) {
    mkdirSync(dirname(machineFile), { recursive: true });
    writeFileSync(machineFile, `${JSON.stringify({ stateFolder: fallback }, null, 2)}\n`);
    return fallback;
  }
  let folder: unknown;
  try {
    folder = JSON.parse(readFileSync(machineFile, 'utf8'))?.stateFolder;
  } catch (e) {
    throw new Error(`${machineFile} can't be read: ${(e as Error).message}`);
  }
  if (typeof folder !== 'string' || !folder) throw new Error(`${machineFile} names no stateFolder`);
  return folder;
}

/** The desktop app's own folder in `appData` (Electron's `userData`: the app's productName). */
export const APP_DATA_NAME = 'Queue runner';

/** The state folder the app already uses, read and never written: for a check run beside the app
 *  (the live review check reads the user's settings there). An app never started has none. */
export function savedStateFolder(machineFile: string): string {
  if (!existsSync(machineFile)) throw new Error(`${machineFile} isn't there: start the desktop app once, or name its state folder`);
  return stateFolder(machineFile, '');
}

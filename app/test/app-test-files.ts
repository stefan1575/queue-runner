// Every file of the app's tests, for the checks over them (`no-real-time.test.ts`,
// `no-real-settings.test.ts`): each file Vitest runs (`*.test.*` / `*.spec.*` anywhere under the
// app) and every helper in a `test` folder, `app/test/` and `app/renderer/test/` alike (#202 F1).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export const APP = join(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'desktop-dist', 'dist', 'release']);
const CODE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The path, relative to the app with `/` separators, of every app test file. */
export function appTestFiles(root = APP): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string, inTest: boolean) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), path, inTest || entry.name === 'test');
      else if (CODE.test(entry.name) && (inTest || TEST_FILE.test(entry.name))) found.push(path);
    }
  };
  walk(root, '', false);
  return found.sort();
}

/** The parser's script kind for a file name: a `.tsx` or `.jsx` holds JSX, which parsed as plain
 *  TypeScript misreads an apostrophe in JSX text as a string. */
export function scriptKind(name: string): ts.ScriptKind {
  if (/\.tsx$/.test(name)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(name)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(name)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Every app test file but `self` (the check's own files), each with the hits `check` finds in
 *  it, as `path:hit`. */
export function hitsInAppTests(self: string[], check: (source: string, name: string) => string[]): string[] {
  return appTestFiles()
    .filter((path) => !self.includes(path))
    .flatMap((path) => check(readFileSync(join(APP, path), 'utf8'), path).map((hit) => `${path}:${hit}`));
}

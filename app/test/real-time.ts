// What no test may run on (docs/app.md, Test it): the real clock and real timers, so no test
// waits for real time to pass and none fails when the machine is slow (#202). A test may use one
// where `vi.useFakeTimers()` fakes it: in the test, in a hook of a describe around it or at the
// top of the file. A call with a `toFake` list fakes only what it lists, so
// `vi.useFakeTimers({ toFake: ['setTimeout'] })` leaves `Date` real and excuses no clock read;
// one with `shouldAdvanceTime: true` moves with the real clock, so it excuses nothing.
// `no-real-time.test.ts` runs it over every app test file, as `no-real-settings.test.ts` does for
// the user's home and tests/test_no_temp_leftovers.py does for `mkdtemp(`.
//
// It reads the code through TypeScript's parser, so a comment or a string that names a timer is
// not a use, and a use split over lines is still one.
import ts from 'typescript';
import { scriptKind } from './app-test-files.ts';
import { isTestCall, testNameAt } from './test-names.ts';

const CLOCK = 'the real clock (use vi.useFakeTimers or pass a clock)';
const TIMER = 'a real timer (use vi.useFakeTimers or a seam the test runs)';
const TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const TIMER_MODULE = /^(?:node:)?timers(?:\/promises)?$/;
// Each clock read, and the `toFake` name that fakes it; null where Vitest's fake timers never do.
const CLOCK_READS: Record<string, Record<string, string | null>> = {
  Date: { now: 'Date' },
  performance: { now: 'performance' },
  process: { hrtime: 'hrtime', uptime: null },
};

const isName = (n: ts.Node | undefined, name: string) => !!n && ts.isIdentifier(n) && n.text === name;

/** What a node does with real time, and the `toFake` name that would fake it (null: nothing
 *  does), or null for a node that does nothing with it. */
function use(node: ts.Node): { what: string; fake: string | null } | null {
  if (ts.isIdentifier(node) && TIMERS.has(node.text)) {
    const parent = node.parent;
    // An object's own key (`{ setTimeout: 0 }`) is a name, not the timer.
    if (parent && (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return null;
    return { what: TIMER, fake: node.text };
  }
  if (ts.isStringLiteralLike(node) && TIMER_MODULE.test(node.text)
    && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || ts.isCallExpression(node.parent))) {
    // Node's timers module is a second copy of the timers the fake clock doesn't replace.
    return { what: TIMER, fake: null };
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const reads = CLOCK_READS[node.expression.text];
    if (reads && Object.hasOwn(reads, node.name.text)) return { what: CLOCK, fake: reads[node.name.text] ?? null };
  }
  if (ts.isNewExpression(node) && isName(node.expression, 'Date') && !node.arguments?.length) return { what: CLOCK, fake: 'Date' };
  if (ts.isCallExpression(node) && isName(node.expression, 'Date')) return { what: CLOCK, fake: 'Date' };
  return null;
}

const isFakeClock = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
  && isName(n.expression.expression, 'vi') && n.expression.name.text === 'useFakeTimers';

/** What a `vi.useFakeTimers(...)` call fakes: 'all' with no config or no `toFake`, the names a
 *  literal `toFake` list gives, and nothing for a config the check can't read or one that lets
 *  the fake clock follow the real one (`shouldAdvanceTime: true`). */
function fakedBy(call: ts.CallExpression): 'all' | Set<string> {
  const config = call.arguments[0];
  if (!config) return 'all';
  if (!ts.isObjectLiteralExpression(config)) return new Set();
  let faked: 'all' | Set<string> = 'all';
  for (const prop of config.properties) {
    if (!ts.isPropertyAssignment(prop) || !prop.name || !ts.isIdentifier(prop.name)) {
      if (ts.isSpreadAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) return new Set();
      continue;
    }
    if (prop.name.text === 'shouldAdvanceTime' && prop.initializer.kind !== ts.SyntaxKind.FalseKeyword) return new Set();
    if (prop.name.text === 'toFake') {
      const list = prop.initializer;
      if (!ts.isArrayLiteralExpression(list)) return new Set();
      faked = new Set(list.elements.filter(ts.isStringLiteralLike).map((e) => e.text));
    }
  }
  return faked;
}

/** What `scope` (the file, or a describe or test) fakes itself: by calls in its own body or a hook
 *  there, not in a describe or test inside it. */
function fakedIn(scope: ts.Node): 'all' | Set<string> {
  const faked = new Set<string>();
  let all = false;
  const look = (n: ts.Node) => {
    if (isFakeClock(n)) {
      const by = fakedBy(n);
      if (by === 'all') all = true;
      else by.forEach((name) => faked.add(name));
    }
    if (!isTestCall(n)) ts.forEachChild(n, look);
  };
  ts.forEachChild(scope, look);
  return all ? 'all' : faked;
}

/** Whether `fake` is faked where `node` runs: the file, or a describe or test around it, fakes it.
 *  A use nothing fakes (`fake` null) never is. */
function onFakeClock(node: ts.Node, fake: string | null): boolean {
  if (fake === null) return false;
  for (let n = node.parent; n; n = n.parent) {
    if (!isTestCall(n) && !ts.isSourceFile(n)) continue;
    const faked = fakedIn(n);
    if (faked === 'all' || faked.has(fake)) return true;
  }
  return false;
}

/** Each line of `source` that reads the real clock or runs on a real timer, as
 *  `line: in test '<describe > test>': what: the line` (or `outside any test` for a helper at
 *  the top of the file). A use the fake clock fakes there is not one. */
export function realTimeUses(source: string, name = 'test.ts'): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, scriptKind(name));
  const lines = source.split('\n');
  const found = new Map<number, string>();
  const visit = (node: ts.Node) => {
    const hit = use(node);
    if (hit && !onFakeClock(node, hit.fake)) {
      const start = node.getStart(file);
      const n = file.getLineAndCharacterOfPosition(start).line;
      if (!found.has(n)) found.set(n, `${testNameAt(file, start)}: ${hit.what}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, what]) => `${n + 1}: ${what}: ${(lines[n] ?? '').trim()}`);
}

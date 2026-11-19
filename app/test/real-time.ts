// What no test may run on (docs/app.md, Test it): the real clock and real timers, so no test
// waits for real time to pass and none fails when the machine is slow (#202). A file that installs
// the fake clock (`vi.useFakeTimers()`) may use both, since its timers and `Date` are the fake
// ones. `no-real-time.test.ts` runs it over every test file, as `no-real-settings.test.ts` does for
// the user's home and tests/test_no_temp_leftovers.py does for `mkdtemp(`.
//
// It reads the code through TypeScript's parser, so a comment or a string that names a timer is
// not a use, and a use split over lines is still one.
import ts from 'typescript';

const CLOCK = 'the real clock (use vi.useFakeTimers or pass a clock)';
const TIMER = 'a real timer (use vi.useFakeTimers or a seam the test runs)';
const TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const TIMER_MODULE = /^(?:node:)?timers(?:\/promises)?$/;
const CLOCK_READS: Record<string, string[]> = { Date: ['now'], performance: ['now'], process: ['hrtime', 'uptime'] };
const TEST_CALLS = new Set(['describe', 'test', 'it']);

const isName = (n: ts.Node | undefined, name: string) => !!n && ts.isIdentifier(n) && n.text === name;

/** What a node does with real time, or null. */
function use(node: ts.Node): string | null {
  if (ts.isIdentifier(node) && TIMERS.has(node.text)) {
    const parent = node.parent;
    // An object's own key (`{ setTimeout: 0 }`) is a name, not the timer.
    if (parent && (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return null;
    return TIMER;
  }
  if (ts.isStringLiteralLike(node) && TIMER_MODULE.test(node.text)
    && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || ts.isCallExpression(node.parent))) {
    return TIMER;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
    && CLOCK_READS[node.expression.text]?.includes(node.name.text)) {
    return CLOCK;
  }
  if (ts.isNewExpression(node) && isName(node.expression, 'Date') && !node.arguments?.length) return CLOCK;
  if (ts.isCallExpression(node) && isName(node.expression, 'Date')) return CLOCK;
  return null;
}

/** `test`, `it` or `describe` behind a call's callee (`test`, `test.each([...])`, `it.skip`). */
function testCall(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return TEST_CALLS.has(callee.text);
  if (ts.isPropertyAccessExpression(callee)) return testCall(callee.expression);
  if (ts.isCallExpression(callee)) return testCall(callee.expression);
  return false;
}

/** The titles of the describes and tests a node sits in, outermost first. */
function titles(node: ts.Node): string[] {
  const out: string[] = [];
  for (let n = node.parent; n; n = n.parent) {
    const first = ts.isCallExpression(n) ? n.arguments[0] : undefined;
    if (ts.isCallExpression(n) && testCall(n.expression) && first && ts.isStringLiteralLike(first)) out.unshift(first.text);
  }
  return out;
}

const fakeClock = (n: ts.Node): boolean =>
  (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
    && isName(n.expression.expression, 'vi') && n.expression.name.text === 'useFakeTimers')
  || ts.forEachChild(n, (c) => fakeClock(c) || undefined) === true;

/** Each line of `source` that reads the real clock or runs on a real timer, as
 *  `line: in test '<describe > test>': what: the line` (or `outside any test` for a helper at
 *  the top of the file). Nothing when the file installs the fake clock. */
export function realTimeUses(source: string): string[] {
  const file = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (fakeClock(file)) return [];
  const lines = source.split('\n');
  const found = new Map<number, string>();
  const visit = (node: ts.Node) => {
    const what = use(node);
    if (what) {
      const n = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
      if (!found.has(n)) {
        const where = titles(node);
        found.set(n, `${where.length ? `in test '${where.join(' > ')}'` : 'outside any test'}: ${what}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, what]) => `${n + 1}: ${what}: ${(lines[n] ?? '').trim()}`);
}

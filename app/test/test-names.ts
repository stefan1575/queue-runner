// Which test a line of a test file sits in, for the checks over the test files
// (`no-real-time.test.ts`, `no-real-settings.test.ts`) to name the test they fail (#202).
import ts from 'typescript';

const TEST_CALLS = new Set(['describe', 'test', 'it']);

/** `test`, `it` or `describe` behind a call's callee (`test`, `test.each([...])`, `it.skip`). */
function testCallee(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return TEST_CALLS.has(callee.text);
  if (ts.isPropertyAccessExpression(callee)) return testCallee(callee.expression);
  if (ts.isCallExpression(callee)) return testCallee(callee.expression);
  return false;
}

/** A `describe`, `test` or `it` call. */
export const isTestCall = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n) && testCallee(n.expression);

/** `in test '<describe > test>'` for the describes and tests around `pos`, outermost first, or
 *  `outside any test` for a helper at the top of the file. */
export function testNameAt(file: ts.SourceFile, pos: number): string {
  const names: string[] = [];
  const visit = (n: ts.Node) => {
    if (pos < n.getStart(file) || pos >= n.end) return;
    const first = isTestCall(n) ? n.arguments[0] : undefined;
    if (first && ts.isStringLiteralLike(first)) names.push(first.text);
    ts.forEachChild(n, visit);
  };
  visit(file);
  return names.length ? `in test '${names.join(' > ')}'` : 'outside any test';
}

// What no test may reach (docs/app.md, Test it): the user's home or app-data folders, T3's real
// files, the runner's config.toml and the app's real settings path. `no-real-settings.test.ts`
// runs it over every test file, as tests/test_no_temp_leftovers.py does for `mkdtemp(`.
//
// The patterns run over the whole source with its comments blanked out, not line by line, so a
// call or an access split over lines (`t3Cli(\n)`, `process.env\n  .HOME`) is still found (#173).
import ts from 'typescript';
import { testNameAt } from './test-names.ts';

const REAL: [RegExp, string][] = [
  [/\bhomedir\b/g, "the user's home folder"],
  [/\b(?:USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA)\b/g, "the user's home or app-data folder"],
  [
    /\bprocess\.env\s*(?:\.\s*HOME\b|\[\s*['"`]HOME['"`]\s*\])|\{[^}]*\bHOME\b[^}]*\}\s*=\s*process\.env\b/g,
    "the user's home folder",
  ],
  [/\bT3_HOME\b|\bT3CODE_HOME\b|\bSERVER_RUNTIME\b|\bT3_CLI\b/g, "T3's real files"],
  [/\b(?:runtimeAddress|t3Cli)\s*\(\s*\)/g, "T3's real files (pass a path of the test's own)"],
  [/['"`]~[\\/]/g, 'a path in the home folder'],
  [/[\\/]\.t3[\\/]/g, "T3's real folder"],
  [/\bconfig\.toml\b/g, "the runner's real config.toml"],
  // The settings tickets (#150 to #152) export the real settings file's path under this name.
  [/\bSETTINGS_PATH\b/g, "the app's real settings"],
];

/** `source` with every comment replaced by spaces, newlines kept, so offsets and line numbers
 *  still match. TypeScript's own parser finds the tokens: only it can tell a regular expression
 *  (`/[/*]/`, `/https:\/\//`) or a string from a division, so a hand-written scanner read a
 *  regex's contents as a comment and blanked real code after it (#173 F3). A comment can only
 *  sit in the trivia before a token, which holds nothing but whitespace and comments, so each
 *  token's trivia is scanned on its own and its comments blanked. */
export function blankComments(source: string): string {
  const file = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const out = source.split('');
  const blankTrivia = (from: number, to: number) => {
    scanner.resetTokenState(from);
    for (let kind = scanner.scan(); scanner.getTokenStart() < to; kind = scanner.scan()) {
      if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
        for (let j = scanner.getTokenStart(); j < scanner.getTokenEnd(); j++) {
          if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' ';
        }
      }
      if (kind === ts.SyntaxKind.EndOfFileToken) break;
    }
  };
  const visit = (node: ts.Node) => {
    const children = node.getChildren(file).filter((child) => !ts.isJSDoc(child));
    if (children.length === 0) blankTrivia(node.pos, node.getStart(file));
    else children.forEach(visit);
  };
  visit(file);
  return out.join('');
}

/** Each line of `source` where a real setting is reached, as
 *  `line: in test '<describe > test>': what it reaches: the line` (or `outside any test`);
 *  a match over several lines is reported at the line it starts on. Comments are skipped. */
export function realSettingsReads(source: string): string[] {
  const code = blankComments(source);
  const file = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split('\n');
  const found = new Map<number, string>();
  for (const [pattern, what] of REAL) {
    for (const match of code.matchAll(pattern)) {
      const n = code.slice(0, match.index).split('\n').length - 1;
      if (!found.has(n)) found.set(n, `${testNameAt(file, match.index)}: ${what}`);
    }
  }
  return [...found.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, what]) => `${n + 1}: ${what}: ${(lines[n] ?? '').trim()}`);
}

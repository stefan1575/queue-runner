// What no test may reach (docs/app.md, Test it): the user's home or app-data folders, T3's real
// files, the runner's config.toml and the app's real settings path. `no-real-settings.test.ts`
// runs it over every test file, as tests/test_no_temp_leftovers.py does for `mkdtemp(`.
//
// The patterns run over the whole source with its comments blanked out, not line by line, so a
// call or an access split over lines (`t3Cli(\n)`, `process.env\n  .HOME`) is still found (#173).
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
 *  still match. Strings are kept: a `//` inside one (`'https://'`) isn't a comment. */
export function blankComments(source: string): string {
  const out = source.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to; j++) if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' ';
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const to = end === -1 ? source.length : end;
      blank(i, to);
      i = to;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const to = end === -1 ? source.length : end + 2;
      blank(i, to);
      i = to;
    } else if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') i++;
        else if (c !== '`' && source[i] === '\n') break;
        i++;
      }
      i++;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Each line of `source` where a real setting is reached, as `line: what it reaches: the line`;
 *  a match over several lines is reported at the line it starts on. Comments are skipped. */
export function realSettingsReads(source: string): string[] {
  const code = blankComments(source);
  const lines = source.split('\n');
  const found = new Map<number, string>();
  for (const [pattern, what] of REAL) {
    for (const match of code.matchAll(pattern)) {
      const n = code.slice(0, match.index).split('\n').length - 1;
      if (!found.has(n)) found.set(n, what);
    }
  }
  return [...found.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, what]) => `${n + 1}: ${what}: ${(lines[n] ?? '').trim()}`);
}

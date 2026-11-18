// What no test may reach (docs/app.md, Test it): the user's home or app-data folders, T3's real
// files, the runner's config.toml and the app's real settings path. `no-real-settings.test.ts`
// runs it over every test file, as tests/test_no_temp_leftovers.py does for `mkdtemp(`.
const REAL: [RegExp, string][] = [
  [/\bhomedir\b/, "the user's home folder"],
  [/\b(?:USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA)\b/, "the user's home or app-data folder"],
  [/\bprocess\.env\b[^\n]*\bHOME\b/, "the user's home folder"],
  [/\bT3_HOME\b|\bT3CODE_HOME\b|\bSERVER_RUNTIME\b|\bT3_CLI\b/, "T3's real files"],
  [/\b(?:runtimeAddress|t3Cli)\(\s*\)/, "T3's real files (pass a path of the test's own)"],
  [/['"`]~[\\/]/, 'a path in the home folder'],
  [/[\\/]\.t3[\\/]/, "T3's real folder"],
  [/\bconfig\.toml\b/, "the runner's real config.toml"],
  // The settings tickets (#150 to #152) export the real settings file's path under this name.
  [/\bSETTINGS_PATH\b/, "the app's real settings"],
];

/** Each line of `source` that reaches a real setting, as `line: what it reaches: the line`.
 *  Comment lines are skipped. */
export function realSettingsReads(source: string): string[] {
  const found: string[] = [];
  source.split('\n').forEach((line, i) => {
    const text = line.trim();
    if (text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) return;
    for (const [pattern, what] of REAL) {
      if (pattern.test(line)) {
        found.push(`${i + 1}: ${what}: ${text}`);
        break;
      }
    }
  });
  return found;
}

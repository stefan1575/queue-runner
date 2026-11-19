// #172: a test builds its own settings and checks what the code does with them. None reaches the
// real ones (docs/app.md, Test it), so changing one of Stefan's settings never turns main red.
import { describe, expect, it } from 'vitest';
import { appTestFiles, hitsInAppTests } from './app-test-files.ts';
import { realSettingsReads } from './real-settings.ts';

const SELF = ['test/no-real-settings.test.ts', 'test/real-settings.ts'];

describe('no test reaches the real settings', () => {
  it.each([
    ["the home folder", "import { homedir } from 'node:os';\nconst dir = join(homedir(), '.queue-runner');"],
    ["os.homedir", "import os from 'node:os';\nconst home = os.homedir();"],
    ["USERPROFILE", "const home = process.env.USERPROFILE!;"],
    ["APPDATA", "const dir = join(process.env['APPDATA']!, 'queue-runner');"],
    ["LOCALAPPDATA", "const dir = process.env.LOCALAPPDATA;"],
    ["T3_HOME", "import { T3_HOME } from '../src/t3/real.ts';\nreadFileSync(join(T3_HOME, 'userdata', 'settings.json'));"],
    ["T3CODE_HOME", "const t3 = process.env.T3CODE_HOME;"],
    ["T3's runtime file", "import { SERVER_RUNTIME } from '../src/t3/real.ts';"],
    ["T3's address with no file given", "const address = runtimeAddress();"],
    ["T3's real CLI", "const cli = t3Cli( );"],
    ["a ~ path", "readFileSync('~/.t3/userdata/state.sqlite');"],
    ["a .t3 folder", "const db = 'C:/Users/someone/.t3/userdata/state.sqlite';"],
    ["config.toml", "readFileSync(join(root, 'config.toml'), 'utf8');"],
    ["the app's real settings path", "import { SETTINGS_PATH } from '../src/settings.ts';"],
    // #173 F2: a call or an access split over lines is still the same call.
    ["T3's address with no file given, over two lines", "const address = runtimeAddress(\n);"],
    ["T3's real CLI, over three lines", "const cli = t3Cli(\n  // the default\n);"],
    ["T3's real CLI with only a comment in it", "const cli = t3Cli(/* real one */);"],
    ["HOME over two lines", "const home = process.env\n  .HOME;"],
    ["HOME by key", "const home = process.env['HOME'];"],
    ["HOME destructured", "const { HOME } = process.env;"],
    // #173 F3: a regular expression's contents are neither a comment nor a string.
    ["a call after a regex holding /*", "const special = /[/*]/;\nconst address = runtimeAddress();"],
    ["a call after an escaped-slash URL regex", "const url = /https:\\/\\//; const cli = t3Cli();"],
    ["a call after a regex holding a quote", "const quote = /['\"]/;\nconst address = runtimeAddress();"],
    ["a call after a regex holding a backtick", "const tick = /`/g; const cli = t3Cli();"],
    ["a call after a regex in a call", "s.replace(/\\/*/g, ''); const cli = t3Cli();"],
  ])('finds a test that reads %s', (_, source) => {
    expect(realSettingsReads(source)).not.toEqual([]);
  });

  it('reports a call over several lines at the line it starts on', () => {
    expect(realSettingsReads("const a = 1;\nconst cli = t3Cli(\n);")).toEqual([
      "2: outside any test: T3's real files (pass a path of the test's own): const cli = t3Cli(",
    ]);
  });

  it('names the test the read is in', () => {
    const source = [
      "describe('the settings', () => {",
      "  test.each([1, 2])('reads %s', () => {",
      "    const dir = join(homedir(), '.queue-runner');",
      "  });",
      "});",
    ].join('\n');
    expect(realSettingsReads(source)).toEqual([
      "3: in test 'the settings > reads %s': the user's home folder: const dir = join(homedir(), '.queue-runner');",
    ]);
  });

  it('passes a test that builds its own settings', () => {
    const source = [
      "const dir = await mkdtemp(join(tmpdir(), 'settings-'));",
      "const address = runtimeAddress(join(dir, 'server-runtime.json'));",
      "const cli = t3Cli(join(dir, 't3.cmd'));",
      "// comments may name homedir() and T3_HOME",
      "/* a block comment over lines may name",
      "   runtimeAddress() and USERPROFILE */",
      "const url = 'https://example.invalid/'; // a trailing comment: t3Cli()",
      "const env = { ...process.env, PATH: dir }; const HOMEPAGE = 1;",
      "const half = total / 2; // a division isn't a regex: t3Cli()",
      "const ratio = (a) / b / c; /* nor is this: runtimeAddress() */",
      "const quote = /'/; // a quote in a regex opens no string: t3Cli() '",
      "const s = `a ${b /* in a template: runtimeAddress() */} c`;",
    ].join('\n');
    expect(realSettingsReads(source)).toEqual([]);
  });

  it('reads a renderer test as JSX', () => {
    const source = [
      "test('the page', () => {",
      "  render(<p>Stefan's page, see https://example.invalid</p>);",
      "  const dir = homedir();",
      "});",
    ].join('\n');
    expect(realSettingsReads(source, 'renderer/test/page.test.tsx')).toEqual([
      "3: in test 'the page': the user's home folder: const dir = homedir();",
    ]);
  });

  it("reads every app test file, the renderer's included", () => {
    const files = appTestFiles();
    expect(files).toContain('test/t3.test.ts');
    expect(files).toContain('renderer/test/models-page.test.tsx');
    expect(files).toContain('test/fake-t3.ts');
    expect(files.filter((f) => f.includes('node_modules'))).toEqual([]);
  });

  it("passes the app's tests", () => {
    expect(hitsInAppTests(SELF, realSettingsReads)).toEqual([]);
  });
});

// The config, ported from the Python tests of `queue_runner/config.py` case for case (#219): the
// config cases of `tests/test_effort.py` (ConfigTest), `tests/test_fallback.py`
// (ReviewProviderConfigTest) and `tests/test_inbox.py` (MergeConfigTest), each on a config file
// the test writes in its own temp folder. That file isn't named as the runner's is, which the
// check on real settings refuses in a test (docs/app.md, Test it); `load_config` reads any path.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, test } from 'vitest';
import { load_config, Repo } from '../src/config.ts';
import { ValueError } from '../src/python.ts';

const dirs: string[] = [];
function tempdir(): string {
  const d = mkdtempSync(join(tmpdir(), 'qr-config-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FILE = 'settings.toml';

// tests/test_effort.py
function write_config(folder: string, claude = '[claude]\nprovider = "claudeAgent"\nmodel = "claude-opus-5-5"\n'): string {
  const path = join(folder, FILE);
  const d = folder.replaceAll('\\', '/');
  writeFileSync(path, `state_dir = "${d}/state"\nlog_dir = "${d}/logs"\n\n${claude}\n`
    + `[[repos]]\nname = "first"\ngithub = "owner/first"\npath = "${d}/first"\n`, 'utf8');
  return path;
}

describe('ConfigTest', () => {
  test('effort is high when config names none', () => {
    expect(load_config(write_config(tempdir())).claude_effort).toBe('high');
  });

  test('effort is read from the claude table', () => {
    const config = load_config(write_config(tempdir(), '[claude]\nmodel = "claude-opus-5-5"\n'
      + 'effort = "xhigh"\n'));
    expect(config.claude_effort).toBe('xhigh');
  });

  test('an effort claude code has not is refused', () => {
    const dir = tempdir();
    expect(() => load_config(write_config(dir, '[claude]\neffort = "ultrathink"\n'))).toThrow(ValueError);
    expect(() => load_config(write_config(dir, '[claude]\neffort = "ultrathink"\n'))).toThrow(/effort/);
  });

  // Reads the runner's own config and asserts the effort Stefan set there, which the app's tests
  // may not (docs/app.md, Test it, #172): left pending until that clash is settled.
  it.todo('the served config runs claude jobs at medium');
});

// tests/test_fallback.py
describe('ReviewProviderConfigTest', () => {
  function load(text: string) {
    const d = tempdir();
    const path = join(d, FILE);
    writeFileSync(path, 'state_dir = "s"\nlog_dir = "l"\n' + text, 'utf8');
    return load_config(path);
  }

  test('the default is chatgpt', () => {
    expect(load('').review_provider).toBe('chatgpt');
  });

  test('claude', () => {
    expect(load('[review]\nprovider = "claude"\n').review_provider).toBe('claude');
  });

  test('the review instance defaults to the no tools one', () => {
    expect(load('').review_claude_provider).toBe('claudeReviewer');
    expect(load('[review]\nclaude_provider = "other"\n')
      .review_claude_provider).toBe('other');
  });

  // PR #127's review 1, F1: a review never starts on an instance with the build's tools.
  test.each([
    '[review]\nclaude_provider = ""\n',
    '[review]\nclaude_provider = "claudeAgent"\n',
    '[claude]\nprovider = "mine"\n[review]\nclaude_provider = "mine"\n',
  ])('an empty or build review instance is an error naming the key (text=%j)', (text) => {
    expect(() => load(text)).toThrow(ValueError);
    expect(() => load(text)).toThrow(/\[review\] claude_provider must/);
  });

  test('anything else is an error naming the key', () => {
    expect(() => load('[review]\nprovider = "opus"\n')).toThrow(ValueError);
    expect(() => load('[review]\nprovider = "opus"\n')).toThrow(/\[review\] provider must be one of/);
  });
});

// tests/test_inbox.py
describe('MergeConfigTest', () => {
  test('merge stefan is read and the default is the runner', () => {
    // A temp config, not the runner's: which repo Stefan merges is his to change there.
    const d = tempdir();
    const path = join(d, FILE);
    writeFileSync(path, (`state_dir = "${d}/s"\nlog_dir = "${d}/l"\n`
      + `[[repos]]\nname = "mine"\npath = "${d}"\nmerge = "stefan"\n`
      + `[[repos]]\nname = "theirs"\npath = "${d}"\n`).replaceAll('\\', '/'), 'utf8');
    const repos = Object.fromEntries(load_config(path).repos.map((r) => [r.name, r]));
    expect(repos.mine!.stefan_merges).toBe(true);
    expect(repos.theirs!.stefan_merges).toBe(false);
    expect(new Repo({ name: 'x', github: null, path: '.' }).merge).toBe('runner');
  });

  test('a bad merge value is an error', () => {
    const d = tempdir();
    const path = join(d, FILE);
    writeFileSync(path, (`state_dir = "${d}/s"\nlog_dir = "${d}/l"\n[[repos]]\nname = "x"\n`
      + `path = "${d}"\nmerge = "michael"\n`).replaceAll('\\', '/'), 'utf8');
    expect(() => load_config(path)).toThrow(ValueError);
    expect(() => load_config(path)).toThrow(/merge must be 'runner' or 'stefan'/);
  });
});

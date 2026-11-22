// Every job's prompt is fully set by its template: none hands the work to a skill or a slash
// command (they load only in some harnesses, and only when the agent picks them), and none points
// at files outside this repo. Ported from `tests/test_templates.py` case for case (#219), over the
// templates ported so far (`src/templates/`). Two cases read `fix.md` and `review.md`, which the
// fix and reviews ports (#223, #222) copy in: pending until then.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, test } from 'vitest';
import { EVIDENCE, read_template, TEMPLATES } from '../src/build-brief.ts';

// Python's patterns, spelled out so JavaScript matches exactly what Python's `re` matches (checked
// against Python over every code point and 100,000 mixed strings): its `\w` is Unicode letters,
// numbers and `_`, its `\b` is the edge of those, its `\s` takes U+001C to U+001F and U+0085 but
// not U+FEFF, `(?i)` folds `s` to U+017F, `k` to U+212A and `i` to U+0130 and U+0131, and `(?m)^`
// starts a line only after `\n`.
const WORD = String.raw`[\p{L}\p{N}_]`;
const EDGE = String.raw`(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
const SPACE = String.raw`[\t\n\v\f\r\x1c-\x20\x85\xa0  -     　]`;
// r'(?i)\bskills?\b'
const SKILL = new RegExp(String.raw`${EDGE}[sSſ][kKK][iIİı][lL][lL][sSſ]?${EDGE}`, 'u');
// r'(?m)^\s*/[a-z][\w-]*\b'
const SLASH_LINE = new RegExp(String.raw`(?<![^\n])${SPACE}*\/[a-z][\p{L}\p{N}_\-]*${EDGE}`, 'u');
// r'`/[a-z][\w-]*`'
const SLASH_INLINE = /`\/[a-z][\p{L}\p{N}_-]*`/u;

function templates(): Record<string, string> {
  return Object.fromEntries(readdirSync(TEMPLATES).filter((name) => name.endsWith('.md'))
    .map((name) => [name, read_template(join(TEMPLATES, name))]));
}

describe('TemplatesTest', () => {
  test('there are templates', () => {
    expect(Object.keys(templates())).toContain('build.md');
  });

  test('no template names a skill', () => {
    for (const [name, text] of Object.entries(templates())) {
      expect(text, name).not.toMatch(SKILL);
    }
    expect('ſkill').toMatch(SKILL);   // Python's (?i) folds U+017F to `s`
  });

  test('no template starts a slash command', () => {
    for (const [name, text] of Object.entries(templates())) {
      expect(text, name).not.toMatch(SLASH_LINE);
      expect(text, name).not.toMatch(SLASH_INLINE);
    }
    expect('`/café`').toMatch(SLASH_INLINE);   // Python's `\w` is Unicode
    expect('\x85/cmd').toMatch(SLASH_LINE);        // Python's `\s` takes U+0085
  });

  test('no template points outside the repo', () => {
    for (const [name, text] of Object.entries(templates())) {
      expect(text, name).not.toMatch(/~\//);   // Python's `assertNotIn('~/', text)`
    }
  });

  test('the screenshot script they name is the runners own', () => {
    expect(statSync(EVIDENCE, { throwIfNoEntry: false })?.isFile(), EVIDENCE).toBe(true);
    expect(EVIDENCE.endsWith('scripts/evidence.py')).toBe(true);
  });

  // game-backdrop #14: "each state it touches" had no end, so reviews 4, 5 and 6 each asked for
  // more shots with no code changed. Both sides now stop at the same, checkable place.
  it.todo('builder and reviewer hold screenshots to the same finish line');

  // PR #115 review 1, F1: GitCli.evidence copies only `pr-<number>/` off the evidence branch, so
  // a template that publishes anywhere else leaves the review with no shots. It counts at least
  // two `--into`s, and `build.md` has one.
  it.todo('screenshots go where the review reads them');
});

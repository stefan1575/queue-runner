// Every job's prompt is fully set by its template: none hands the work to a skill or a slash
// command (they load only in some harnesses, and only when the agent picks them), and none points
// at files outside this repo. Ported from `tests/test_templates.py` case for case (#219), over the
// templates ported so far (`src/templates/`). Two cases read `fix.md` and `review.md`, which the
// fix and reviews ports (#223, #222) copy in: pending until then.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, test } from 'vitest';
import { EVIDENCE, read_template, TEMPLATES } from '../src/build-brief.ts';

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
      expect(text, name).not.toMatch(/\bskills?\b/i);
    }
  });

  test('no template starts a slash command', () => {
    for (const [name, text] of Object.entries(templates())) {
      expect(text, name).not.toMatch(/^\s*\/[a-z][\w-]*\b/m);
      expect(text, name).not.toMatch(/`\/[a-z][\w-]*`/);
    }
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

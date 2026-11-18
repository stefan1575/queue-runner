// No model or provider name in the app's code (#152, #121's rule; docs/app.md, Rules): which
// provider and model do a job comes from T3 and the settings, never from code. Tests and their
// fixtures may name them; nothing else in app/ may, comments included.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(import.meta.dirname, '..');
const CODE = ['src', 'renderer/src', 'live', 'renderer/index.html'];
// Names that aren't a model choice but what's on GitHub or in a repo, kept as today's runner has
// them (docs/app.md, Rules): the job branch prefix and a repo's own instructions file. Each
// literal, quotes included, is allowed; the bare word still isn't.
const GITHUB_FACING = ["'claude/'", "'CLAUDE.md'"];
const NAMES = /\b(?:claude\w*|codex|opus|sonnet|haiku|fable|gpt[\w.-]*|anthropic|openai|chatgpt|gemini|grok)\b/gi;

export function modelNames(source: string): string[] {
  return [...source.matchAll(NAMES)].map((m) => m[0]);
}

function files(path: string): string[] {
  const full = join(APP, path);
  if (statSync(full, { throwIfNoEntry: false })?.isDirectory()) {
    return readdirSync(full, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile()).map((e) => relative(APP, join(e.parentPath, e.name)));
  }
  return statSync(full, { throwIfNoEntry: false }) ? [path] : [];
}

describe('no model or provider name in the code', () => {
  it.each([
    ['a provider id', "const p = 'claudeAgent';", 'claudeAgent'],
    ['a model id', "model: 'gpt-6.1-sol',", 'gpt-6.1-sol'],
    ['a name in a comment', '// runs on Opus by default', 'Opus'],
    ['a vendor', "label: 'OpenAI'", 'OpenAI'],
  ])('finds %s', (_, source, name) => {
    expect(modelNames(source)).toEqual([name]);
  });

  it('leaves words that only hold a name alone', () => {
    expect(modelNames("const opusculum = 1; const sonnets = 'x'; reasoningEffort;")).toEqual([]);
  });

  it("the app's code names none", () => {
    expect(CODE.flatMap(files).length).toBeGreaterThan(20);
    const source = (f: string) => GITHUB_FACING.reduce((s, name) => s.split(name).join("''"), readFileSync(join(APP, f), 'utf8'));
    const found = CODE.flatMap(files).flatMap((f) => modelNames(source(f)).map((n) => `${f}: ${n}`));
    expect(found).toEqual([]);
  });
});

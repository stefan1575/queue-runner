// Job briefs, filled from sources that keep themselves current, never from handoff files. Ported
// from `queue_runner/brief.py` (#219), with its template, `templates/build.md`, copied byte for
// byte into `src/templates/`.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildJob } from './build-picker.ts';
import type { Repo } from './config.ts';
import type { Comment } from './github-seam.ts';
import { py_repr, py_str, strip, KeyError, ValueError, type Json } from './python.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The templates' folder (Python's `queue_runner/templates`, read through `importlib.resources`). */
export const TEMPLATES = join(HERE, 'templates');

// The screenshot script jobs run (`templates/build.md`, Screenshots): the runner's own copy, so a
// job in any repo reaches it.
export const EVIDENCE = join(dirname(dirname(HERE)), 'scripts', 'evidence.py').split(sep).join('/');

/** A template's text as Python's `read_text(encoding='utf-8')` gives it: universal newlines, so a
 *  checkout's CRLF reads as `\n`. */
export function read_template(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
}

// Python's `string.Template`: `$$`, `$name` and `${name}`, a name being ASCII letters, digits and
// `_`, not starting with a digit; any other `$` is an invalid placeholder.
const PATTERN = /\$(?:(\$)|([_a-zA-Z][_a-zA-Z0-9]*)|\{([_a-zA-Z][_a-zA-Z0-9]*)\}|())/g;
// `str.splitlines`'s line ends.
const LINE_END = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;

/** `Template(template).substitute(mapping)`: each value as `str()` gives it, a missing name a
 *  `KeyError`, an invalid placeholder a `ValueError` naming its line and column. */
export function substitute(template: string, mapping: Record<string, Json>): string {
  return template.replace(PATTERN, (_m, escaped, named, braced, invalid, offset: number) => {
    const name = named ?? braced;
    if (name !== undefined) {
      if (!Object.hasOwn(mapping, name)) throw new KeyError(py_repr(name));
      return py_str(mapping[name]);
    }
    if (escaped !== undefined) return '$';
    if (invalid !== undefined) {
      // `lines = template[:i].splitlines(keepends=True)`, each line's start kept
      const before = template.slice(0, offset);
      const starts: number[] = [];
      let at = 0;
      for (const end of before.matchAll(LINE_END)) {
        starts.push(at);
        at = end.index + end[0].length;
      }
      if (at < before.length) starts.push(at);
      const lineno = starts.length || 1;
      const colno = starts.length ? offset - starts.at(-1)! : 1;
      throw new ValueError(`Invalid placeholder in string: line ${lineno}, col ${colno}`);
    }
    throw new ValueError('Unrecognized named group in pattern');
  });
}

function _template(kind: string): string {
  return read_template(join(TEMPLATES, `${kind}.md`));
}

/** `os.path.isfile`. */
function isfile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function _agents_pointer(path: string): string {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    if (isfile(join(path, name))) {
      return `Read the repo's \`${name}\` first, and the docs it points to for what you touch.`;
    }
  }
  return 'The repo has no `AGENTS.md`; follow its README and existing conventions.';
}

function _comments(comments: readonly Comment[]): string {
  if (!comments.length) return 'No comments.';
  return comments.map((c) => `**${c.author}**, ${c.created_at}:\n\n${strip(c.body)}`).join('\n\n');
}

/** A build job as Python's `BuildJob` has it: its repo is the config's `Repo` that `pick` was
 *  given, which the picker's port types only by what it reads. */
export type Job = BuildJob & { readonly repo: Repo };

export function build_brief(job: Job, comments: readonly Comment[]): string {
  return substitute(_template('build'), {
    number: job.issue.number, github: job.repo.github, title: job.issue.title,
    branch: job.branch, base: job.base, agents: _agents_pointer(job.repo.path),
    body: strip(job.issue.body || '') || '(The issue has no body.)',
    comments: _comments(comments), evidence: EVIDENCE,
  });
}

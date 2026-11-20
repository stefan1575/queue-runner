// Python's semantics where the ledger and post ports (#220) need them to read and write what the
// Python runner does: its regex classes, its truthiness, `==`, hashing, `str()` and `strip()`
// on the JSON values a review ledger holds. A value from JSON is `Json`: null, a boolean, a
// number, a string, a list (array) or a dict (plain object).

export type Json = any;

// Python's `\w` (letters, digits and `_`, in any script), `\d` (any decimal digit) and `\s`
// (`str.isspace`), for a character class.
export const W = String.raw`\p{L}\p{N}_`;
export const D = String.raw`\p{Nd}`;
export const S = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0  -     　`;
/** Python's `\b` just before a word character, and just after one. */
export const B_BEFORE = `(?<![${W}])`;
export const B_AFTER = `(?![${W}])`;
/** Python's `^` and `$` under `re.M`: at the text's start or end, or next to a `\n`, never a
 *  `\r` (JavaScript's `m` flag also takes `\r`, U+2028 and U+2029 as line ends). */
export const BOL = String.raw`(?<![^\n])`;
export const EOL = String.raw`(?![^\n])`;

/** Python's `int` on a run of decimal digits, in any script. Unicode keeps each script's digits
 *  as one run of 0 to 9 in order, so a digit's value is how far it sits into its run. */
export function int(digits: string): number {
  let n = 0;
  for (const ch of digits) {
    const cp = ch.codePointAt(0)!;
    let start = cp;
    while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    n = n * 10 + ((cp - start) % 10);
  }
  return n;
}

export const is_dict = (x: Json): x is Record<string, Json> => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Python's truthiness: null, false, 0, '' and an empty list or dict are false. */
export function truthy(x: Json): boolean {
  if (Array.isArray(x)) return x.length > 0;
  if (is_dict(x)) return Object.keys(x).length > 0;
  return Boolean(x);
}

/** `a or b`. */
export const or = (a: Json, b: Json): Json => (truthy(a) ? a : b);

/** `x.get(key, dflt)` on a dict: its own field, or `dflt` when missing (never a prototype's). */
export const get = (x: Record<string, Json>, k: string, dflt: Json = null): Json => (Object.hasOwn(x, k) ? x[k] : dflt);

/** `k in d` for a dict of string keys. A list or dict can't be hashed, so Python raises. */
export const has = (d: Record<string, unknown>, k: Json): boolean => typeof key(k) === 'string' && Object.hasOwn(d, k);

const type_of = (x: Json) => (x === null ? 'NoneType' : Array.isArray(x) ? 'list' : typeof x === 'object' ? 'dict'
  : typeof x === 'string' ? 'str' : typeof x === 'boolean' ? 'bool' : Number.isInteger(x) ? 'int' : 'float');

/** A value as a dict key or set member: a list or dict raises, as Python can't hash it. */
export function key(x: Json): Json {
  if (x !== null && typeof x === 'object') throw new TypeError(`unhashable type: '${type_of(x)}'`);
  return x;
}

/** Python's `==` on JSON values: booleans are 1 and 0, lists and dicts compare by content. */
export function py_eq(a: Json, b: Json): boolean {
  const num = (x: Json) => typeof x === 'number' || typeof x === 'boolean';
  if (num(a) && num(b)) return Number(a) === Number(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => py_eq(x, b[i]));
  if (is_dict(a) && is_dict(b)) {
    const ks = Object.keys(a);
    return ks.length === Object.keys(b).length && ks.every((k) => Object.hasOwn(b, k) && py_eq(a[k], b[k]));
  }
  return a === b;
}

/** `x in xs` for a list or tuple: by `==`. */
export const among = (xs: readonly Json[], x: Json): boolean => xs.some((y) => py_eq(x, y));

/** Python's `repr` of a float: the shortest digits, in exponent form below 1e-4 and from 1e16. */
function float_repr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const [mant, exp] = x.toExponential().split('e') as [string, string];
  const e = Number(exp);
  if (e < -4 || e >= 16) return `${mant}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  const sign = mant.startsWith('-') ? '-' : '';
  const digits = mant.replace(/^-/, '').replace('.', '');
  if (e < 0) return `${sign}0.${'0'.repeat(-e - 1)}${digits}`;
  const whole = digits.padEnd(e + 1, '0');
  return `${sign}${whole.slice(0, e + 1)}.${whole.slice(e + 1) || '0'}`;
}

/** Python's `repr` of a string: single quotes unless it holds one and no double quote. */
function str_repr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === q || ch === '\\') out += `\\${ch}`;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch !== ' ' && /[\p{C}\p{Z}]/u.test(ch)) {
      out += cp < 0x100 ? `\\x${cp.toString(16).padStart(2, '0')}` : cp < 0x10000 ? `\\u${cp.toString(16).padStart(4, '0')}`
        : `\\U${cp.toString(16).padStart(8, '0')}`;
    } else out += ch;
  }
  return out + q;
}

/** Python's `repr` of a JSON value. */
export function py_repr(x: Json): string {
  if (typeof x === 'string') return str_repr(x);
  if (Array.isArray(x)) return `[${x.map(py_repr).join(', ')}]`;
  if (is_dict(x)) return `{${Object.entries(x).map(([k, v]) => `${str_repr(k)}: ${py_repr(v)}`).join(', ')}}`;
  return py_str(x);
}

/** Python's `str()` (and an f-string's `{x}`) of a JSON value. JSON's numbers come back as
 *  JavaScript's, so a whole number is an int, as Python's `json` reads one written without a
 *  point. */
export function py_str(x: Json): string {
  if (x === null || x === undefined) return 'None';
  if (x === true) return 'True';
  if (x === false) return 'False';
  if (typeof x === 'number') return Number.isInteger(x) && Math.abs(x) < 1e21 ? x.toFixed(0) : float_repr(x);
  if (typeof x === 'string') return x;
  return py_repr(x);
}

/** A value Python needs to be a string (`re.sub`, `quote`, slicing it as text): anything else raises. */
export function str_only(x: Json): string {
  if (typeof x !== 'string') throw new TypeError(`expected str, got '${type_of(x)}'`);
  return x;
}

/** `sep.join(xs)`: every item must be a string, as in Python. */
export const join = (sep: string, xs: readonly Json[]): string => xs.map(str_only).join(sep);

const STRIP = new RegExp(`^[${S}]+|[${S}]+$`, 'gu');
const RSTRIP = new RegExp(`[${S}]+$`, 'u');
/** `str.strip()` and `str.rstrip()`: Python's whitespace, not JavaScript's. */
export const strip = (s: string): string => s.replace(STRIP, '');
export const rstrip = (s: string): string => s.replace(RSTRIP, '');

/** `s[:n]` and `len(s)`: code points, as Python counts them. */
export const head = (s: string, n: number): string => Array.from(s).slice(0, n).join('');
export const len = (s: string): number => Array.from(s).length;

/** `str.capitalize()`: the first character upper case, the rest lower. */
export function capitalize(s: string): string {
  const [first = '', ...rest] = Array.from(s);
  return first.toUpperCase() + rest.join('').toLowerCase();
}

/** `type(e).__name__` and `str(e)` of a caught error. */
export const type_name = (e: unknown): string => (e instanceof Error ? e.name : typeof e);
export const err_str = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const LINE_BREAK = new RegExp(String.raw`\r\n|[\n\r\v\f\x1c\x1d\x1e\x85${String.fromCharCode(0x2028, 0x2029)}]`);

/** Python's `str.splitlines()`: every line boundary it knows, the last line's end dropped. */
export function splitlines(s: string): string[] {
  const lines = s.split(LINE_BREAK);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Python's `sorted()` of strings: by code point. */
export const by_code_point = (a: string, b: string) => {
  const x = Array.from(a, (c) => c.codePointAt(0)!), y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
};

/** `json.dumps(x, sort_keys=True)`: `, ` and `: ` between items, every dict's keys in code-point
 *  order, and everything outside printable ASCII as `\uXXXX` (`ensure_ascii`). A whole number is
 *  an int, as `py_str` reads one. */
export function json_dumps(x: Json): string {
  if (x === null || x === undefined) return 'null';
  if (x === true) return 'true';
  if (x === false) return 'false';
  if (typeof x === 'number') {
    if (Number.isNaN(x)) return 'NaN';
    if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity';
    return Number.isInteger(x) ? BigInt(x).toString() : float_repr(x);
  }
  if (typeof x === 'string') {
    return JSON.stringify(x).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }
  if (Array.isArray(x)) return `[${x.map(json_dumps).join(', ')}]`;
  const keys = Object.keys(x).sort(by_code_point);
  return `{${keys.map((k) => `${json_dumps(k)}: ${json_dumps(x[k])}`).join(', ')}}`;
}

/** `f'{x:.0f}'`: the nearest whole number, a tie to the even one, as Python rounds a float. */
export function format_0f(x: number): string {
  const floor = Math.floor(x);
  const n = x - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(x);
  return (Object.is(n, -0) || (n === 0 && x < 0) ? '-0' : String(n));
}

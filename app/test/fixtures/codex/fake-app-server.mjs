// A stand-in for `codex app-server`, ported from `tests/fixtures/codex/fake_app_server.py` (#263):
// JSON-RPC over stdin and stdout, one JSON object a line. It answers `initialize`, and
// `account/rateLimits/read` with the result saved in the fixture named first. With `--error` it
// answers the read with an error, with `--silent` it never answers it, and with `--before-init` it
// refuses a read sent before `initialized`. With `--close-stdin` (review 1 on PR #267, no Python
// twin) its stdin is closed before `initialize` is answered and its stdout stays open, so the
// next write to it fails.
//
//     node fake-app-server.mjs <fixture.json> [--error | --silent | --before-init | --close-stdin]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [fixture, how = ''] = process.argv.slice(2);
const saved = JSON.parse(readFileSync(fixture, 'utf8'));
let initialized = false;

const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const method = message.method;
  if (method === 'initialize') {
    if (how === '--close-stdin') {
      // Node can't close its own stdin pipe on Windows, so a child that holds only stdout gives
      // the answer, and this process exits: its stdin closes, its stdout stays open a second.
      const answer = JSON.stringify({ id: message.id, result: {} });
      spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(answer + '\n')}); setTimeout(() => {}, 1000);`],
        { stdio: ['ignore', 'inherit', 'ignore'], detached: true, windowsHide: true }).once('spawn', () => process.exit(0));
      break;
    }
    say({ id: message.id, result: { userAgent: 'codex_cli_rs/0.167.0', codexHome: 'C:/x', platformFamily: 'windows', platformOs: 'windows' } });
    say({ method: 'account/updated', params: {} });   // a notification, to be skipped
  } else if (method === 'initialized') {
    initialized = true;
  } else if (method === 'account/rateLimits/read') {
    if (how === '--silent') continue;
    if (how === '--error' || (how === '--before-init' && !initialized)) {
      say({ id: message.id, error: { code: -32600, message: 'not signed in' } });
    } else {
      say({ id: message.id, result: saved.result });
    }
  }
}

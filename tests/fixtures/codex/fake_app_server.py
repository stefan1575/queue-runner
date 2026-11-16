"""A stand-in for `codex app-server` (ticket 42's tests): JSON-RPC over stdin and stdout, one JSON
object a line. It answers `initialize`, and `account/rateLimits/read` with the result saved in the
fixture named first. With `--error` it answers the read with an error, with `--silent` it never
answers it, and with `--before-init` it refuses a read sent before `initialized`.

    python fake_app_server.py <fixture.json> [--error | --silent | --before-init]
"""
import json
import sys

fixture, how = sys.argv[1], (sys.argv[2:] or [''])[0]
with open(fixture, encoding='utf-8') as f:
    saved = json.load(f)
initialized = False


def say(message):
    sys.stdout.write(json.dumps(message) + '\n')
    sys.stdout.flush()


for line in sys.stdin:
    message = json.loads(line)
    method = message.get('method')
    if method == 'initialize':
        say({'id': message['id'], 'result': {'userAgent': 'codex_cli_rs/0.167.0', 'codexHome': 'C:/x',
                                             'platformFamily': 'windows', 'platformOs': 'windows'}})
        say({'method': 'account/updated', 'params': {}})   # a notification, to be skipped
    elif method == 'initialized':
        initialized = True
    elif method == 'account/rateLimits/read':
        if how == '--silent':
            continue
        if how == '--error' or (how == '--before-init' and not initialized):
            say({'id': message['id'], 'error': {'code': -32600, 'message': 'not signed in'}})
        else:
            say({'id': message['id'], 'result': saved['result']})

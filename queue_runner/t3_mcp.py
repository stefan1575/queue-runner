"""T3's MCP endpoint, called directly (ticket 70): what the `t3` CLI can't do (settle, rename).

T3's CLI has no settle or rename command. Its `thread` commands reach T3's MCP endpoint by
minting a full-access MCP client session in-process (`withThreadTools` in `binCli-*.mjs`), which
a Python script can't do. A token from `t3 auth session issue --subject mcp-client` reaches the
endpoint too, but T3 gives it no runtime-mode ceiling, so it acts as `approval-required`: T3
refuses it any write to a `full-access` thread, and every thread the runner starts is one
(`runtime_mode_escalation_denied`, checked live 2026-11-16). So the runner signs in the way an
outside MCP client does, with T3's OAuth flow and a one-time pairing code it makes itself:

1. `t3 auth pairing create` with the full-access scopes, for 5 minutes: a one-time code.
2. `POST /oauth/mcp/register`: a client id (T3 signs it; nothing is stored).
3. `POST /oauth/mcp/decision` with the code and `access: full-access`: an authorization code.
4. `POST /oauth/mcp/token` with PKCE: a bearer token for a `full-access` MCP client session,
   good for 30 days (T3's `MCP_CLIENT_SESSION_TTL`).

That is the access the `t3` CLI already mints for itself on every `thread` call. The token stays
in memory only, never in a log, a record or a file; a new one is made when T3 refuses the old
(401) and once per runner process. After minting, the runner revokes its own older sessions
(subject `mcp-client`, label `Queue runner`), so restarts don't pile them up.

The server's address is read from `~/.t3/userdata/server-runtime.json` on every call, as the CLI
reads it, since T3 may come back on another port.
"""
import base64
import hashlib
import json
import os
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request

from .t3 import T3Error, run_t3

SERVER_RUNTIME = os.path.join(os.path.expanduser('~'), '.t3', 'userdata', 'server-runtime.json')
LABEL = 'Queue runner'   # the client's name: T3 labels its session with it
REDIRECT = 'http://127.0.0.1/queue-runner/callback'   # never opened: the code is read from it
# mcpClientScopes('full-access') in T3: what a pairing code must grant for a full-access sign-in
SCOPES = ('orchestration:read', 'orchestration:operate', 'settings:write', 'source-control:write')
PROTOCOL = '2025-06-18'
TIMEOUT = 30


def http_post(url: str, body: bytes, headers: dict) -> tuple[int, dict, str]:
    """POSTs and returns (status, headers, text), an HTTP error's too."""
    req = urllib.request.Request(url, body, headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read().decode(
            errors='replace')


class Unauthorized(T3Error):
    """T3 refused the token (revoked, expired, or minted for another server)."""


def _rpc_result(text: str, content_type: str):
    """A JSON-RPC response's `result`, from a JSON body or an event stream's last message."""
    if 'text/event-stream' in (content_type or ''):
        data = [line[5:].strip() for line in text.splitlines() if line.startswith('data:')]
        text = data[-1] if data else ''
    try:
        msg = json.loads(text)
    except ValueError:
        raise T3Error(f'T3 sent an unreadable MCP answer: {text[:200]!r}')
    if 'error' in msg:
        raise T3Error(f"T3's MCP endpoint refused the call: {msg['error'].get('message')}")
    return msg.get('result')


class T3Mcp:
    """`settle` and `rename` through T3's MCP endpoint. `run` is the `t3` CLI (for the pairing
    code and the session list), `post` the HTTP seam, `runtime` the server-runtime.json path."""

    def __init__(self, *, run=run_t3, post=http_post, runtime=SERVER_RUNTIME):
        self._run, self._post, self._runtime = run, post, runtime
        self._token: str | None = None
        self._origin: str | None = None   # the server the token was minted on
        self._lock = threading.Lock()     # both lanes may settle

    # --- the interface ---------------------------------------------------------------------

    def settle(self, thread_id: str) -> None:
        """Settles the thread: it leaves the sidebar and stays readable (`thread show`)."""
        self.call('t3_thread_organize', {'threadId': thread_id, 'action': 'settle'})

    def rename(self, thread_id: str, title: str) -> None:
        self.call('t3_thread_update', {'threadId': thread_id, 'action': 'rename',
                                       'title': title})

    def call(self, tool: str, arguments: dict):
        """One tool call in a fresh MCP session; its structured result. A T3Error if T3 can't
        be reached, refuses it or the tool fails."""
        with self._lock:
            origin = self.origin()
            for attempt in (1, 2):
                if self._token is None or self._origin != origin:
                    self._token, self._origin = self._mint(origin), origin
                try:
                    return self._tool(origin, tool, arguments)
                except Unauthorized:
                    self._token = None
                    if attempt == 2:
                        raise

    # --- the server ------------------------------------------------------------------------

    def origin(self) -> str:
        try:
            with open(self._runtime, encoding='utf-8') as f:
                return json.load(f)['origin'].rstrip('/')
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
            raise T3Error(f"T3's server isn't running ({self._runtime}: {type(e).__name__})")

    def _send(self, url: str, body: bytes, headers: dict) -> tuple[int, dict, str]:
        try:
            return self._post(url, body, headers)
        except (OSError, ValueError) as e:   # refused, timed out, a bad URL
            raise T3Error(f"T3's server can't be reached at {url}: {type(e).__name__}: {e}")

    def _json(self, url: str, payload, form: bool = False) -> dict:
        body = (urllib.parse.urlencode(payload) if form else json.dumps(payload)).encode()
        ctype = 'application/x-www-form-urlencoded' if form else 'application/json'
        status, _, text = self._send(url, body, {'Content-Type': ctype,
                                                 'Accept': 'application/json'})
        path = urllib.parse.urlparse(url).path
        if status >= 400:
            raise T3Error(f'T3 refused {path} ({status}): {text[:300]}')
        try:
            return json.loads(text)
        except ValueError:
            raise T3Error(f'T3 sent an unreadable answer to {path}: {text[:200]!r}')

    # --- signing in ------------------------------------------------------------------------

    def _cli(self, args: list[str]):
        code, out, err = self._run(args)
        if code:
            raise T3Error(f"t3 {' '.join(args[:3])} failed ({code}): {err.strip()[:300]}")
        try:
            return json.loads(out)
        except ValueError:
            raise T3Error(f"t3 {' '.join(args[:3])} printed no JSON")

    def _mint(self, origin: str) -> str:
        """A full-access MCP client session through T3's OAuth flow (the module's docstring)."""
        args = ['auth', 'pairing', 'create']
        for s in SCOPES:
            args += ['--scope', s]
        pairing = self._cli(args + ['--ttl', '5m', '--label', LABEL, '--json'])
        client = self._json(f'{origin}/oauth/mcp/register', {
            'client_name': LABEL, 'redirect_uris': [REDIRECT],
            'token_endpoint_auth_method': 'none'})['client_id']
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        resource, state = f'{origin}/mcp', secrets.token_urlsafe(12)
        authorization = {'response_type': 'code', 'client_id': client, 'redirect_uri': REDIRECT,
                         'code_challenge': challenge, 'code_challenge_method': 'S256',
                         'state': state, 'resource': resource}
        went = self._json(f'{origin}/oauth/mcp/decision', {
            'authorization': authorization,
            'decision': {'_tag': 'pairing-code', 'access': 'full-access',
                         'code': pairing['credential']}})
        query = urllib.parse.parse_qs(urllib.parse.urlparse(went.get('redirectTo', '')).query)
        if 'code' not in query:
            raise T3Error('T3 approved no sign-in: '
                          + (query.get('error_description') or query.get('error') or ['?'])[0])
        if query.get('state') != [state]:
            raise T3Error("T3's sign-in answered another request (its state differs)")
        token = self._json(f'{origin}/oauth/mcp/token', {
            'grant_type': 'authorization_code', 'code': query['code'][0],
            'redirect_uri': REDIRECT, 'client_id': client, 'code_verifier': verifier,
            'resource': resource}, form=True)
        if not token.get('access_token'):
            raise T3Error('T3 issued no token')
        self._revoke_older()
        return token['access_token']

    def _revoke_older(self) -> None:
        """Revokes this runner's earlier sessions, keeping the newest (the one just made). A
        failure leaves them to expire."""
        try:
            mine = sorted((s for s in self._cli(['auth', 'session', 'list', '--json'])
                           if s.get('subject') == 'mcp-client'
                           and (s.get('client') or {}).get('label') == LABEL),
                          key=lambda s: s.get('issuedAt') or '')
            for s in mine[:-1]:
                self._run(['auth', 'session', 'revoke', s['sessionId']])
        except Exception:   # noqa: BLE001 - tidying only
            pass

    # --- one tool call ---------------------------------------------------------------------

    def _rpc(self, origin: str, session: str | None, method: str, params=None, id_=None):
        headers = {'Authorization': f'Bearer {self._token}', 'Content-Type': 'application/json',
                   'Accept': 'application/json, text/event-stream',
                   'MCP-Protocol-Version': PROTOCOL}
        if session:
            headers['Mcp-Session-Id'] = session
        msg = {'jsonrpc': '2.0', 'method': method}
        if params is not None:
            msg['params'] = params
        if id_ is not None:
            msg['id'] = id_
        status, got, text = self._send(f'{origin}/mcp', json.dumps(msg).encode(), headers)
        if status in (401, 403):
            raise Unauthorized(f'T3 refused the runner\'s MCP token ({status})')
        if status >= 400:
            raise T3Error(f"T3's MCP endpoint answered {status} to {method}: {text[:300]}")
        return got, (_rpc_result(text, got.get('content-type', '')) if id_ is not None else None)

    def _tool(self, origin: str, tool: str, arguments: dict):
        got, _ = self._rpc(origin, None, 'initialize', {
            'protocolVersion': PROTOCOL, 'capabilities': {},
            'clientInfo': {'name': 'queue-runner', 'version': '1'}}, 1)
        session = got.get('mcp-session-id')
        self._rpc(origin, session, 'notifications/initialized')
        _, result = self._rpc(origin, session, 'tools/call',
                              {'name': tool, 'arguments': arguments}, 2)
        if not isinstance(result, dict):
            raise T3Error(f'T3 sent no result for {tool}')
        if result.get('isError'):
            text = next((c.get('text') for c in result.get('content') or []
                         if c.get('text')), '') or ''
            try:
                failure = json.loads(text)
                text = f"{failure.get('code')}: {failure.get('message')}"
            except (ValueError, AttributeError):
                pass
            raise T3Error(f'{tool} failed: {text[:300]}')
        return result.get('structuredContent')

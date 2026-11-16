"""T3's MCP endpoint called directly (ticket 70): the sign-in, the tool call, and failures,
against a fake T3 server. No network, no T3."""
import json
import os
import tempfile
import unittest
import urllib.parse

from queue_runner.t3 import T3Cli, T3Error
from queue_runner.t3_mcp import LABEL, SCOPES, T3Mcp, Unauthorized

TOKEN = 'secret-token-1'


class FakeServer:
    """Plays T3's OAuth routes, its MCP endpoint and the `t3 auth` CLI. `tool_result` is what
    tools/call answers; `refuse` how many MCP calls answer 401 first."""

    def __init__(self, origin='http://127.0.0.1:3773'):
        self.origin = origin
        self.cli, self.posts = [], []
        self.tokens = []              # tokens issued, oldest first
        self.revoked = []
        self.refuse = 0
        self.stream = False           # answer tools/call as an event stream
        self.state = None             # the state the decision redirects with (None: echo it)
        self.tool_result = {'content': [{'type': 'text', 'text': '{"sequence":1}'}],
                            'structuredContent': {'sequence': 1}, 'isError': False}
        self.sessions = [
            {'sessionId': 's-old', 'subject': 'mcp-client', 'client': {'label': LABEL},
             'issuedAt': '2026-11-01T00:00:00Z'},
            {'sessionId': 's-cli', 'subject': 'mcp-client', 'client': {'label': 't3 thread cli'},
             'issuedAt': '2026-11-15T00:00:00Z'},
        ]

    def run(self, args, stdin=None):
        self.cli.append(list(args))
        if args[:3] == ['auth', 'pairing', 'create']:
            return 0, json.dumps({'id': 'p1', 'credential': 'PAIRCODE1234'}), ''
        if args[:3] == ['auth', 'session', 'list']:
            return 0, json.dumps(self.sessions), ''
        if args[:3] == ['auth', 'session', 'revoke']:
            self.revoked.append(args[3])
            return 0, 'Revoked.', ''
        return 1, '', 'unknown'

    def post(self, url, body, headers):
        path = urllib.parse.urlparse(url).path
        assert url.startswith(self.origin), url
        text = body.decode()
        self.posts.append((path, text, dict(headers)))
        if path == '/oauth/mcp/register':
            return 201, {}, json.dumps({'client_id': 'client-1'})
        if path == '/oauth/mcp/decision':
            d = json.loads(text)
            self.decision = d
            state = self.state or d['authorization']['state']
            return 200, {}, json.dumps({'redirectTo': (
                f"{d['authorization']['redirect_uri']}?code=AUTH1&state={state}&iss=x")})
        if path == '/oauth/mcp/token':
            self.token_form = urllib.parse.parse_qs(text)
            token = f'secret-token-{len(self.tokens) + 1}'
            self.tokens.append(token)
            self.sessions.append({'sessionId': f's-new{len(self.tokens)}',
                                  'subject': 'mcp-client', 'client': {'label': LABEL},
                                  'issuedAt': f'2026-11-16T0{len(self.tokens)}:00:00Z'})
            return 200, {}, json.dumps({'access_token': token, 'token_type': 'Bearer',
                                        'expires_in': 2592000})
        if path == '/mcp':
            if self.refuse:
                self.refuse -= 1
                return 401, {}, '{"error":"invalid_token"}'
            assert headers['Authorization'] == f'Bearer {self.tokens[-1]}'
            msg = json.loads(text)
            if msg['method'] == 'initialize':
                return 200, {'mcp-session-id': 'mcp-s1', 'content-type': 'application/json'}, \
                    json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': {}})
            if msg['method'] == 'notifications/initialized':
                assert headers['Mcp-Session-Id'] == 'mcp-s1'
                return 202, {}, ''
            if msg['method'] == 'tools/call':
                self.called = msg['params']
                answer = json.dumps({'jsonrpc': '2.0', 'id': msg['id'],
                                     'result': self.tool_result})
                if self.stream:
                    return 200, {'content-type': 'text/event-stream'}, \
                        f'event: message\ndata: {answer}\n\n'
                return 200, {'content-type': 'application/json'}, answer
        return 404, {}, 'not found'

    def calls(self, path):
        return [p for p in self.posts if p[0] == path]


class T3McpTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.runtime = os.path.join(tmp.name, 'server-runtime.json')
        self.server = FakeServer()
        self.write_runtime(self.server.origin)
        self.mcp = T3Mcp(run=self.server.run, post=self.server.post, runtime=self.runtime)

    def write_runtime(self, origin):
        with open(self.runtime, 'w', encoding='utf-8') as f:
            json.dump({'version': 1, 'origin': origin, 'port': 3773}, f)

    def test_settle_signs_in_full_access_and_calls_organize(self):
        self.mcp.settle('mcp:t1')
        s = self.server
        pairing = s.cli[0]
        self.assertEqual(pairing[:3], ['auth', 'pairing', 'create'])
        self.assertEqual([pairing[i + 1] for i, a in enumerate(pairing) if a == '--scope'],
                         list(SCOPES))
        self.assertIn('5m', pairing)
        self.assertEqual(s.decision['decision'], {'_tag': 'pairing-code', 'access': 'full-access',
                                                  'code': 'PAIRCODE1234'})
        auth = s.decision['authorization']
        self.assertEqual(auth['code_challenge_method'], 'S256')
        self.assertEqual(auth['resource'], 'http://127.0.0.1:3773/mcp')
        self.assertEqual(s.token_form['code'], ['AUTH1'])
        self.assertEqual(s.token_form['client_id'], ['client-1'])
        import base64
        import hashlib
        verifier = s.token_form['code_verifier'][0]
        self.assertEqual(base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
                         .rstrip(b'=').decode(), auth['code_challenge'])
        self.assertEqual(s.called, {'name': 't3_thread_organize',
                                    'arguments': {'threadId': 'mcp:t1', 'action': 'settle'}})

    def test_older_runner_sessions_are_revoked_not_others(self):
        self.mcp.settle('mcp:t1')
        self.assertEqual(self.server.revoked, ['s-old'])   # not the CLI's, not the new one

    def test_the_token_is_reused(self):
        self.mcp.settle('mcp:t1')
        self.mcp.settle('mcp:t2')
        self.assertEqual(len(self.server.tokens), 1)
        self.assertEqual(len(self.server.calls('/oauth/mcp/token')), 1)
        self.assertEqual(self.server.called['arguments']['threadId'], 'mcp:t2')

    def test_a_refused_token_is_minted_again_once(self):
        self.mcp.settle('mcp:t1')
        self.server.refuse = 1
        self.mcp.settle('mcp:t2')
        self.assertEqual(len(self.server.tokens), 2)
        self.assertEqual(self.server.called['arguments']['threadId'], 'mcp:t2')

    def test_refused_twice_raises(self):
        self.server.refuse = 2
        with self.assertRaises(Unauthorized) as e:
            self.mcp.settle('mcp:t1')
        self.assertIsInstance(e.exception, T3Error)
        self.assertNotIn('secret-token', str(e.exception))

    def test_a_failed_tool_is_a_t3_error_with_its_reason(self):
        self.server.tool_result = {'content': [{'type': 'text', 'text': json.dumps({
            '_tag': 'OrchestratorMcpFailure', 'code': 'runtime_mode_escalation_denied',
            'message': 'Child runtime mode full-access is broader than parent mode '
                       'approval-required.'})}], 'isError': True}
        with self.assertRaises(T3Error) as e:
            self.mcp.settle('mcp:t1')
        self.assertIn('runtime_mode_escalation_denied', str(e.exception))
        self.assertNotIn('secret-token', str(e.exception))

    def test_an_event_stream_answer_is_read(self):
        self.server.stream = True
        self.mcp.settle('mcp:t1')
        self.assertEqual(self.server.called['name'], 't3_thread_organize')

    def test_rename(self):
        self.mcp.rename('mcp:t1', 'Decide: x')
        self.assertEqual(self.server.called, {'name': 't3_thread_update', 'arguments': {
            'threadId': 'mcp:t1', 'action': 'rename', 'title': 'Decide: x'}})

    def test_no_server_running(self):
        os.remove(self.runtime)
        with self.assertRaises(T3Error):
            self.mcp.settle('mcp:t1')
        self.assertEqual(self.server.cli, [])

    def test_unreachable_server(self):
        def refused(url, body, headers):
            raise ConnectionRefusedError('refused')
        mcp = T3Mcp(run=self.server.run, post=refused, runtime=self.runtime)
        with self.assertRaises(T3Error):
            mcp.settle('mcp:t1')

    def test_another_state_is_refused(self):
        self.server.state = 'not-mine'
        with self.assertRaises(T3Error):
            self.mcp.settle('mcp:t1')
        self.assertEqual(self.server.calls('/oauth/mcp/token'), [])

    def test_a_failed_pairing_code_is_a_t3_error(self):
        mcp = T3Mcp(run=lambda args, stdin=None: (1, '', 'server down'),
                    post=self.server.post, runtime=self.runtime)
        with self.assertRaises(T3Error):
            mcp.settle('mcp:t1')

    def test_a_new_server_address_signs_in_again(self):
        self.mcp.settle('mcp:t1')
        self.server.origin = 'http://127.0.0.1:4000'
        self.write_runtime('http://127.0.0.1:4000/')
        self.mcp.settle('mcp:t2')
        self.assertEqual(len(self.server.tokens), 2)


class T3CliSettleTest(unittest.TestCase):
    def test_settle_and_rename_go_to_the_mcp_client(self):
        done = []

        class Mcp:
            def settle(self, thread_id):
                done.append(('settle', thread_id))

            def rename(self, thread_id, title):
                done.append(('rename', thread_id, title))

        cli = T3Cli(run=lambda args, stdin=None: (1, '', ''), mcp=Mcp())
        cli.settle('mcp:t1')
        cli.rename('mcp:t1', 'x')
        self.assertEqual(done, [('settle', 'mcp:t1'), ('rename', 'mcp:t1', 'x')])

    def test_without_one_they_raise(self):
        cli = T3Cli(run=lambda args, stdin=None: (1, '', ''))
        with self.assertRaises(T3Error):
            cli.settle('mcp:t1')
        with self.assertRaises(T3Error):
            cli.rename('mcp:t1', 'x')


if __name__ == '__main__':
    unittest.main()

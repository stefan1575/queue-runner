"""codex-sol.sh's MCP switch-off for review and code jobs (PR #127): each enabled server goes off by
name, and anything that keeps a server from being named stops the job instead of starting it with
that server on (review 1, F2). Runs the script's own `mcp_off` block (between its >>> and <<<
lines) under Git's bash, with `codex` played by a shell function: no Codex, no network."""
import os
import re
import shutil
import subprocess
import unittest

from queue_runner.sol import GIT_BASH

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts',
                      'codex-sol.sh')
BASH = GIT_BASH if os.path.exists(GIT_BASH) else shutil.which('bash')

LISTED = '''[
  {
    "name": "clickup",
    "enabled": true,
    "transport": {
      "type": "streamable_http",
      "name": "nested, not a server"
    },
    "auth_status": "o_auth"
  },
  {
    "name": "codex_app",
    "enabled": false,
    "transport": {
      "type": "stdio"
    }
  },
  {
    "name": "playwright",
    "enabled": true
  }
]'''


def block() -> str:
    with open(SCRIPT, encoding='utf-8') as f:
        text = f.read()
    m = re.search(r'^# >>> mcp_off\n(.*)^# <<< mcp_off\n', text, re.S | re.M)
    assert m, 'codex-sol.sh has no mcp_off block'
    return m.group(1)


@unittest.skipUnless(BASH, 'no bash to run codex-sol.sh with')
class McpOffTest(unittest.TestCase):
    def run_off(self, printed: str, code: int = 0):
        """`mcp_off` with `codex mcp list --json` printing `printed` and exiting `code`: its exit
        code, the options it built and what it said on stderr."""
        fake = f"codex() {{ cat <<'JSON'\n{printed}\nJSON\nreturn {code}; }}\n"
        script = (fake + block() + 'cx=codex; mcp_opts=(); mcp_off; rc=$?\n'
                  'echo "rc=$rc"; printf "%s\\n" "${mcp_opts[@]}"\n')
        p = subprocess.run([BASH, '-c', script], capture_output=True, text=True, timeout=60)
        lines = p.stdout.splitlines()
        return int(lines[0].removeprefix('rc=')), [l for l in lines[1:] if l], p.stderr

    def test_each_enabled_server_goes_off_by_name(self):
        rc, opts, _ = self.run_off(LISTED)
        self.assertEqual(rc, 0)
        self.assertEqual(opts, ['-c', 'mcp_servers.clickup.enabled=false',
                                '-c', 'mcp_servers.playwright.enabled=false'])

    def test_no_servers_is_nothing_to_switch_off(self):
        self.assertEqual(self.run_off('[]')[:2], (0, []))

    def test_a_list_that_fails_stops_the_job(self):
        rc, opts, err = self.run_off('', code=1)
        self.assertEqual(rc, 1)
        self.assertIn("'codex mcp list --json' failed (exit 1)", err)

    def test_a_list_that_fails_after_printing_stops_the_job(self):
        self.assertEqual(self.run_off(LISTED, code=2)[0], 1)

    def test_output_that_isnt_a_json_list_stops_the_job(self):
        rc, _, err = self.run_off('Error: config.toml: bad mcp_servers')
        self.assertEqual(rc, 1)
        self.assertIn('printed no JSON list', err)

    def test_a_server_it_cant_read_stops_the_job(self):
        # Compact JSON, or a key order it doesn't expect: servers it can't count as read.
        for printed in ('[{"name": "clickup", "enabled": true}]',
                        '[\n  {\n    "enabled": true,\n    "name": "clickup"\n  }\n]',
                        '[\n  {\n    "name": "clickup",\n    "enabled": "yes"\n  }\n]'):
            with self.subTest(printed=printed):
                self.assertEqual(self.run_off(printed)[0], 1)

    def test_an_enabled_name_it_cant_pass_to_c_stops_the_job(self):
        rc, _, err = self.run_off('[\n  {\n    "name": "my.server",\n    "enabled": true\n  }\n]')
        self.assertEqual(rc, 1)
        self.assertIn("can't switch off MCP server 'my.server'", err)

    def test_the_review_and_code_jobs_stop_when_it_fails(self):
        with open(SCRIPT, encoding='utf-8') as f:
            text = f.read()
        self.assertIn('case $job in review|code)\n', text)
        self.assertRegex(text, r'case \$job in review\|code\)\n[^\n]*\n  mcp_off \|\| exit 1 ;;')


if __name__ == '__main__':
    unittest.main()

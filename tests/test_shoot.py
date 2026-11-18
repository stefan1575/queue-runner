"""scripts/shoot.py's file names: a before (`--commit`) and an after shot of the same state into
the same folder are two files, not one overwriting the other (PR #114 review 1, F1)."""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_spec = importlib.util.spec_from_file_location(
    'shoot', os.path.join(os.path.dirname(__file__), '..', 'scripts', 'shoot.py'))
shoot = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shoot)


class ShotNameTest(unittest.TestCase):
    def test_a_commit_shoots_before_and_the_checkout_after(self):
        self.assertEqual(shoot.label(shoot.parse(['--commit', 'origin/main', '--out', 'shots', 'x'])),
                         'before')
        self.assertEqual(shoot.label(shoot.parse(['--out', 'shots', 'x'])), 'after')

    def test_the_label_can_be_named(self):
        self.assertEqual(shoot.label(shoot.parse(['--label', 'after', '--commit', 'abc',
                                                  '--out', 's', 'x'])), 'after')

    def test_before_and_after_of_the_same_states_have_different_names(self):
        for state in ('reconnecting/settings', 'reconnecting/usage', 'busy'):
            self.assertNotEqual(shoot.shot_name('before', state), shoot.shot_name('after', state))
        self.assertEqual(shoot.shot_name('before', 'reconnecting/usage'),
                         'before-reconnecting-usage.png')
        self.assertEqual(shoot.shot_name('after', 'busy'), 'after-busy-overview.png')


class StateDirTest(unittest.TestCase):
    """`--state-dir DIR` (issue #136): the dashboard serves DIR, and the shot is the real-snapshot
    address, `queue.localhost:<port>`; `localhost:<port>` only ever serves sample data, which is
    how #131's before and after came out the same page."""

    def run_main(self, argv):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        seen = {'servers': [], 'urls': [], 'git': []}

        class Server:
            def __init__(self, cmd, cwd, **kw):
                seen['servers'].append((cmd, Path(cwd)))

            def terminate(self):
                pass

            def wait(self, timeout):
                pass

        def run(cmd, **kw):
            seen['git'].append(cmd)
            return mock.Mock(returncode=0)

        fake_ev = mock.Mock()
        fake_ev.shoot = lambda url, out, size: seen['urls'].append((url, Path(out).name))
        with mock.patch.object(shoot.subprocess, 'Popen', Server),                 mock.patch.object(shoot.subprocess, 'run', run),                 mock.patch.object(shoot, 'wait_up', lambda url: None),                 mock.patch.object(shoot, 'free_port', lambda: 5999),                 mock.patch.object(shoot, 'load_evidence', lambda: fake_ev),                 mock.patch('builtins.print'):
            shoot.main(argv + ['--out', tmp.name])
        return seen

    def test_the_checkout_shoots_the_state_folder_on_the_real_address(self):
        seen = self.run_main(['--state-dir', 'states/sol', 'sol-wait', 'sol-wait/usage'])
        (cmd, cwd), = seen['servers']
        self.assertEqual(cwd, shoot.REPO)
        self.assertEqual(cmd[cmd.index('--state-dir') + 1], str(Path('states/sol').resolve()))
        self.assertEqual(cmd[cmd.index('--port') + 1], '5999')
        self.assertEqual(seen['urls'], [('http://queue.localhost:5999/', 'after-sol-wait-overview.png'),
                                        ('http://queue.localhost:5999/?page=usage', 'after-sol-wait-usage.png')])

    def test_a_commit_shoots_the_same_state_folder_from_its_worktree(self):
        seen = self.run_main(['--commit', 'origin/main', '--state-dir', 'states/sol', 'sol-wait'])
        (cmd, cwd), = seen['servers']
        add = next(c for c in seen['git'] if 'add' in c)
        self.assertEqual(cwd, Path(add[add.index('origin/main') - 1]))   # the worktree, not the checkout
        self.assertNotEqual(cwd, shoot.REPO)
        # an absolute folder: the dashboard runs in the worktree, where a relative one isn't there
        self.assertEqual(cmd[cmd.index('--state-dir') + 1], str(Path('states/sol').resolve()))
        self.assertEqual(seen['urls'], [('http://queue.localhost:5999/', 'before-sol-wait-overview.png')])

    def test_without_a_state_folder_it_shoots_sample_states_as_before(self):
        seen = self.run_main(['reconnecting/usage'])
        (cmd, _), = seen['servers']
        self.assertNotEqual(cmd[cmd.index('--state-dir') + 1], str(Path('states/sol').resolve()))
        self.assertEqual(seen['urls'], [('http://localhost:5999/?sample=reconnecting&page=usage',
                                         'after-reconnecting-usage.png')])


class RailInShotTest(unittest.TestCase):
    """A shot's window is wider than the page's own rail breakpoints (PR #147 review 1, F1): at
    the old 1440x900 the 1480px breakpoint hid the rail, so all 12 of #147's shots of a rail
    change showed no rail. The width comes from the page being shot, so a breakpoint that moves
    moves the window with it, and a before shot is sized from its own commit's page."""

    CSS = """@media (max-width: 1480px) {
  .rail { display: none; }
}
@media (max-width: 2000px) {
  body.page-inbox .rail { display: none; }
}
@media (max-width: 1040px) {
  .mail { display: none; }
}"""

    def test_the_window_is_wider_than_every_breakpoint_that_hides_the_rail_on_that_page(self):
        self.assertGreater(shoot.rail_width(self.CSS, ''), 1480)
        self.assertGreater(shoot.rail_width(self.CSS, 'usage'), 1480)
        self.assertLess(shoot.rail_width(self.CSS, 'usage'), 2000)
        self.assertGreater(shoot.rail_width(self.CSS, 'inbox'), 2000)

    def test_the_dashboards_own_page_shows_its_rail_on_every_page(self):
        css = (shoot.REPO / 'dashboard' / 'index.html').read_text(encoding='utf-8')
        hide = shoot.rail_breakpoints(css)
        self.assertIn((1480, None), hide)   # the page still collapses the rail; it's found
        for page in ('', 'usage', 'inbox', 'queue', 'activity', 'settings'):
            w = shoot.rail_width(css, page)
            for px, only in hide:
                if only in (None, page or 'overview'):
                    self.assertGreater(w, px, (page, px))

    def test_each_shot_is_sized_from_its_page_unless_a_size_is_named(self):
        self.assertEqual(shoot.shot_size(self.CSS, 'busy', None), '1600x1200')
        self.assertEqual(shoot.shot_size(self.CSS, 'busy/inbox', None), '2120x1200')
        self.assertEqual(shoot.shot_size(self.CSS, 'busy/inbox', '1440x900'), '1440x900')


if __name__ == '__main__':
    unittest.main()

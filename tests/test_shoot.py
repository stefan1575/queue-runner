"""scripts/shoot.py's file names: a before (`--commit`) and an after shot of the same state into
the same folder are two files, not one overwriting the other (PR #114 review 1, F1)."""
import importlib.util
import os
import unittest

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


if __name__ == '__main__':
    unittest.main()

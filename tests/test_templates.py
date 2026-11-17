"""Every job's prompt is fully set by its template: none hands the work to a skill or a slash
command (they load only in some harnesses, and only when the agent picks them), and none points
at files outside this repo."""
import os
import re
import unittest
from importlib import resources

from queue_runner.brief import EVIDENCE


def templates():
    root = resources.files('queue_runner').joinpath('templates')
    return {t.name: t.read_text(encoding='utf-8') for t in root.iterdir() if t.name.endswith('.md')}


class TemplatesTest(unittest.TestCase):
    def test_there_are_templates(self):
        self.assertIn('build.md', templates())

    def test_no_template_names_a_skill(self):
        for name, text in templates().items():
            self.assertNotRegex(text, r'(?i)\bskills?\b', name)

    def test_no_template_starts_a_slash_command(self):
        for name, text in templates().items():
            self.assertNotRegex(text, r'(?m)^\s*/[a-z][\w-]*\b', name)
            self.assertNotRegex(text, r'`/[a-z][\w-]*`', name)

    def test_no_template_points_outside_the_repo(self):
        for name, text in templates().items():
            self.assertNotIn('~/', text, name)

    def test_the_screenshot_script_they_name_is_the_runners_own(self):
        self.assertTrue(os.path.isfile(EVIDENCE), EVIDENCE)
        self.assertTrue(EVIDENCE.endswith('scripts/evidence.py'))


if __name__ == '__main__':
    unittest.main()

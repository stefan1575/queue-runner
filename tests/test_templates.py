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

    def test_builder_and_reviewer_hold_screenshots_to_the_same_finish_line(self):
        # game-backdrop #14: "each state it touches" had no end, so reviews 4, 5 and 6 each asked
        # for more shots with no code changed. Both sides now stop at the same, checkable place.
        for name in ('build.md', 'fix.md', 'review.md'):
            text = ' '.join(templates()[name].split())
            self.assertIn('reading only the PR', text, name)
            self.assertIn('see the change the', text, name)

    def test_screenshots_go_where_the_review_reads_them(self):
        # PR #115 review 1, F1: GitCli.evidence copies only `pr-<number>/` off the evidence
        # branch, so a template that publishes anywhere else leaves the review with no shots.
        found = 0
        for name, text in templates().items():
            for into in re.findall(r'--into\s+(\S+)', text):
                found += 1
                self.assertTrue(into.startswith('pr-'), f'{name}: --into {into}')
        self.assertGreaterEqual(found, 2)


if __name__ == '__main__':
    unittest.main()

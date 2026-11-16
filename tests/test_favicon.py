"""A repo's favicon for its mark on the dashboard (`queue_runner/favicon.py`), found as T3 Code
finds a project's: its well-known paths in order, then a `<link rel="icon">` in a source file."""

import base64
import os
import tempfile
import unittest

from queue_runner import favicon


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class RepoIconTest(unittest.TestCase):
    def setUp(self):
        favicon._kept.clear()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = tmp.name
        self.clock = Clock()
        self.addCleanup(favicon._kept.clear)

    def put(self, rel, data=b'<svg xmlns="http://www.w3.org/2000/svg"/>'):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb' if isinstance(data, bytes) else 'w', **({} if isinstance(data, bytes) else {'encoding': 'utf-8'})) as f:
            f.write(data)

    def icon(self):
        return favicon.repo_icon(self.root, clock=self.clock)

    def decoded(self, url):
        head, body = url.split(',', 1)
        return head, base64.b64decode(body)

    def test_a_repo_with_none_has_none(self):
        self.assertIsNone(self.icon())

    def test_a_missing_repo_has_none(self):
        self.assertIsNone(favicon.repo_icon(os.path.join(self.root, 'gone'), clock=self.clock))

    def test_the_first_well_known_path_wins(self):
        self.put('public/favicon.ico', b'\x00\x00\x01\x00ico')
        self.put('assets/logo.png', b'\x89PNG')
        head, body = self.decoded(self.icon())
        self.assertEqual((head, body), ('data:image/x-icon;base64', b'\x00\x00\x01\x00ico'))

    def test_a_link_in_index_html_is_looked_up_under_public_then_the_root(self):
        self.put('index.html', '<head><link rel="icon" type="image/svg+xml" href="/brand/mark.svg?v=2"></head>')
        self.put('public/brand/mark.svg', b'<svg id="public"/>')
        self.assertEqual(self.decoded(self.icon())[1], b'<svg id="public"/>')

    def test_a_rel_icon_object_in_a_root_route_counts(self):
        self.put('src/routes/__root.tsx', 'links: () => [{ rel: "icon", href: "/mark.png" }]')
        self.put('mark.png', b'\x89PNG')
        self.assertEqual(self.decoded(self.icon())[0], 'data:image/png;base64')

    def test_a_remote_or_outside_href_is_never_read(self):
        self.put('index.html', '<link rel="icon" href="https://example.com/x.svg">')
        self.assertIsNone(self.icon())
        favicon._kept.clear()
        self.put('index.html', '<link rel="icon" href="../../outside.svg">')
        self.assertIsNone(self.icon())

    def test_a_type_a_browser_cant_draw_or_one_too_big_is_left_out(self):
        self.put('favicon.svg', b'<svg>' + b' ' * favicon.MAX_BYTES + b'</svg>')
        self.assertIsNone(self.icon())

    def test_an_answer_is_kept_ten_minutes_and_a_miss_one(self):
        self.assertIsNone(self.icon())
        self.put('favicon.svg')
        self.clock.t += 59
        self.assertIsNone(self.icon())        # the miss is still kept
        self.clock.t += 2
        found = self.icon()
        self.assertIsNotNone(found)
        os.remove(os.path.join(self.root, 'favicon.svg'))
        self.clock.t += 599
        self.assertEqual(self.icon(), found)   # the find is still kept
        self.clock.t += 2
        self.assertIsNone(self.icon())


if __name__ == '__main__':
    unittest.main()

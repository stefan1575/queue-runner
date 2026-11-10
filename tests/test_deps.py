"""A review checkout's dependencies: installed once per lockfile into the cache, linked into each
checkout as a junction, with the install command faked (no bun or npm runs here)."""
import json
import os
import tempfile
import unittest

from queue_runner.deps import Deps

PACKAGE = {'name': 'app', 'scripts': {'test': 'vitest run'},
           'dependencies': {'react': '^19.0.0'}, 'devDependencies': {'vitest': '^4.1.10'}}


class FakeInstall:
    """Plays `bun install`: writes node_modules in the folder it runs in, or fails."""

    def __init__(self, code=0):
        self.code = code
        self.calls = []

    def __call__(self, cmd, cwd, out_path, timeout):
        self.calls.append((cmd, cwd))
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write('installed\n' if self.code == 0 else 'error: lockfile had changes\n')
        if self.code == 0:
            os.makedirs(os.path.join(cwd, 'node_modules', 'react'), exist_ok=True)
        return self.code


class DepsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.cache = os.path.join(self.dir, 'deps')
        self.install = FakeInstall()
        self.n = 0

    def deps(self, **kw):
        return Deps(self.cache, run=self.install, bun='C:/scoop/shims/bun.exe',
                    npm='C:/node/npm.cmd', **kw)

    def checkout(self, package=PACKAGE, lock='bun.lock', lock_text='{"lockfileVersion": 1}'):
        self.n += 1
        wt = os.path.join(self.dir, f'wt{self.n}')
        os.makedirs(wt)
        if package is not None:
            with open(os.path.join(wt, 'package.json'), 'w', encoding='utf-8') as f:
                json.dump(package, f)
        if lock:
            with open(os.path.join(wt, lock), 'w', encoding='utf-8') as f:
                f.write(lock_text)
        return wt

    def test_installs_from_bun_lock_once_and_links_it_into_the_checkout(self):
        wt = self.checkout()
        got = self.deps().prepare('app', wt)
        self.assertTrue(got.ready)
        self.assertIn('bun.lock', got.note)
        [(cmd, cwd)] = self.install.calls
        self.assertEqual(cmd, ['C:/scoop/shims/bun.exe', 'install', '--frozen-lockfile'])
        self.assertTrue(cwd.startswith(self.cache))
        self.assertTrue(os.path.isjunction(os.path.join(wt, 'node_modules')))
        self.assertTrue(os.path.isdir(os.path.join(wt, 'node_modules', 'react')))

        again = self.deps().prepare('app', self.checkout())   # same lockfile: no install
        self.assertTrue(again.ready)
        self.assertEqual(len(self.install.calls), 1)
        self.assertIn('cached', again.how)

    def test_a_changed_lockfile_or_dependency_installs_again_but_a_script_change_does_not(self):
        self.deps().prepare('app', self.checkout())
        self.deps().prepare('app', self.checkout(
            package={**PACKAGE, 'scripts': {'test': 'vitest run --reporter dot'}}))
        self.assertEqual(len(self.install.calls), 1)
        self.deps().prepare('app', self.checkout(lock_text='{"lockfileVersion": 2}'))
        self.assertEqual(len(self.install.calls), 2)
        self.deps().prepare('app', self.checkout(
            package={**PACKAGE, 'dependencies': {'react': '^19.1.0'}}))
        self.assertEqual(len(self.install.calls), 3)

    def test_a_cache_emptied_since_installs_again(self):
        wt = self.checkout()
        self.deps().prepare('app', wt)
        os.remove(os.path.join(wt, 'node_modules', '.queue-runner-ready'))   # e.g. a test run
        self.deps().prepare('app', self.checkout())
        self.assertEqual(len(self.install.calls), 2)

    def test_package_lock_uses_npm_ci(self):
        self.deps().prepare('app', self.checkout(lock='package-lock.json'))
        self.assertEqual(self.install.calls[0][0], ['C:/node/npm.cmd', 'ci', '--no-audit',
                                                    '--no-fund'])

    def test_no_lockfile_or_a_failed_install_links_nothing_and_says_why(self):
        got = self.deps().prepare('app', self.checkout(lock=None))
        self.assertFalse(got.ready)
        self.assertIn('no lockfile', got.note)
        self.install.code = 1
        wt = self.checkout()
        got = self.deps().prepare('app', wt)
        self.assertFalse(got.ready)
        self.assertIn('install failed', got.note)
        self.assertIn('lockfile had changes', got.note)
        self.assertFalse(os.path.exists(os.path.join(wt, 'node_modules')))
        self.assertEqual([n for n in os.listdir(self.cache) if not n.endswith('.log')], [])

    def test_no_package_json_needs_nothing(self):
        got = self.deps().prepare('app', self.checkout(package=None, lock=None))
        self.assertFalse(got.ready)
        self.assertIsNone(got.note)
        self.assertEqual(self.install.calls, [])

    def test_no_bun_says_so(self):
        got = Deps(self.cache, run=self.install, bun=None, npm=None).prepare('app',
                                                                              self.checkout())
        self.assertFalse(got.ready)
        self.assertIn('bun', got.note)
        self.assertEqual(self.install.calls, [])

    def test_keeps_the_three_newest_caches_per_repo(self):
        for v in range(5):
            self.deps().prepare('app', self.checkout(lock_text=f'{{"v": {v}}}'))
        kept = [n for n in os.listdir(self.cache) if n.startswith('app-') and '.' not in n]
        self.assertEqual(len(kept), 3)
        self.deps().prepare('app', self.checkout(lock_text='{"v": 4}'))   # the newest stayed
        self.assertEqual(len(self.install.calls), 5)

    def test_an_install_setting_or_patch_is_part_of_the_key(self):
        self.deps().prepare('app', self.checkout())
        wt = self.checkout()
        with open(os.path.join(wt, '.npmrc'), 'w', encoding='utf-8') as f:
            f.write('omit=dev' + chr(10))
        self.deps().prepare('app', wt)
        self.assertEqual(len(self.install.calls), 2)
        wt = self.checkout()
        os.makedirs(os.path.join(wt, 'patches'))
        with open(os.path.join(wt, 'patches', 'react.patch'), 'w', encoding='utf-8') as f:
            f.write('--- a' + chr(10))
        self.deps().prepare('app', wt)
        self.assertEqual(len(self.install.calls), 3)

    def test_sol_may_write_only_where_vite_writes_not_the_packages(self):
        got = self.deps().prepare('app', self.checkout())
        self.assertEqual([os.path.basename(w) for w in got.writable], ['.vite-temp', '.vite'])
        for w in got.writable:
            self.assertTrue(os.path.isdir(w))
            self.assertTrue(w.startswith(self.cache))

    def test_an_install_that_finishes_second_keeps_the_one_already_in_use(self):
        wt = self.checkout()
        first = self.deps()
        inner = self.install

        def slow(cmd, cwd, out_path, timeout):   # another runner publishes the same key meanwhile
            code = inner(cmd, cwd, out_path, timeout)
            if len(inner.calls) == 1:
                Deps(self.cache, run=inner, bun='bun', npm='npm').prepare('app', self.checkout())
                with open(os.path.join(wt, 'in-use'), 'w') as f:
                    f.write('x')
            return code
        first.run = slow
        self.assertTrue(first.prepare('app', wt).ready)
        [cache] = [n for n in os.listdir(self.cache) if '.' not in n]
        self.assertEqual(len(inner.calls), 2)
        self.assertTrue(os.path.isfile(os.path.join(self.cache, cache, 'node_modules',
                                                    '.queue-runner-ready')))
        self.assertEqual([n for n in os.listdir(self.cache) if '.tmp-' in n], [])

    def test_pruning_leaves_a_repo_whose_name_starts_the_same(self):
        self.deps().prepare('app-tools', self.checkout())
        for v in range(4):
            self.deps().prepare('app', self.checkout(lock_text=f'{{"v": {v}}}'))
        self.assertEqual(len([n for n in os.listdir(self.cache)
                              if n.startswith('app-tools-') and '.' not in n]), 1)

    def test_an_install_a_dead_runner_left_is_swept_once_it_is_old(self):
        os.makedirs(self.cache)
        old = os.path.join(self.cache, 'app-0123456789ab.tmp-dead')
        young = os.path.join(self.cache, 'app-0123456789ab.tmp-running')
        os.makedirs(old)
        os.makedirs(young)
        os.utime(old, (0, 0))
        self.deps().prepare('app', self.checkout())
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(young))

    def test_unlink_removes_the_junction_and_keeps_the_cache(self):
        wt = self.checkout()
        self.deps().prepare('app', wt)
        Deps.unlink(wt)
        self.assertFalse(os.path.lexists(os.path.join(wt, 'node_modules')))
        self.assertTrue(self.deps().prepare('app', self.checkout()).ready)
        self.assertEqual(len(self.install.calls), 1)


if __name__ == '__main__':
    unittest.main()

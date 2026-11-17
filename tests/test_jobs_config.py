"""Issue #120: config.toml's `[jobs]` table names each job kind's provider, model and effort
(and a fallback while its provider is out of usage); `[claude]` and `[review]` are gone."""
import os
import tempfile
import unittest

from queue_runner.config import DEFAULT_CONFIG, KINDS, JobSpec, load_config


def write_config(folder, jobs=''):
    path = os.path.join(folder, 'config.toml')
    d = folder.replace('\\', '/')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(f'state_dir = "{d}/state"\nlog_dir = "{d}/logs"\n\n{jobs}\n'
                f'[[repos]]\nname = "first"\ngithub = "owner/first"\npath = "{d}/first"\n')
    return path


OPUS_HIGH = JobSpec('claudeAgent', 'claude-opus-5-5', 'high')
SOL_HIGH = JobSpec('codex', 'gpt-6.1-sol', 'high', fallback=OPUS_HIGH)


class JobsTableTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name

    def load(self, jobs=''):
        return load_config(write_config(self.dir, jobs))

    def test_every_kind_takes_defaults_values_unless_it_names_its_own(self):
        config = self.load('[jobs.default]\nprovider = "claudeAgent"\nmodel = "claude-fable-5-2"\n'
                           'effort = "xhigh"\n\n[jobs.live]\nmodel = "claude-haiku-5-5"\n'
                           'effort = "low"\n')
        fable = JobSpec('claudeAgent', 'claude-fable-5-2', 'xhigh')
        for kind in KINDS:
            with self.subTest(kind=kind):
                want = (JobSpec('claudeAgent', 'claude-haiku-5-5', 'low') if kind == 'live'
                        else fable)
                self.assertEqual(config.job(kind), want)

    def test_a_kind_names_its_provider_model_effort_and_fallback(self):
        config = self.load('[jobs.build]\nprovider = "codex"\nmodel = "gpt-6.1-sol"\n'
                           'effort = "xhigh"\nfallback = { provider = "claudeAgent", '
                           'model = "claude-opus-5-5", effort = "max" }\n')
        self.assertEqual(config.job('build'), JobSpec(
            'codex', 'gpt-6.1-sol', 'xhigh',
            fallback=JobSpec('claudeAgent', 'claude-opus-5-5', 'max')))
        self.assertIsNone(config.job('fix').fallback)

    def test_no_jobs_table_keeps_todays_jobs(self):
        # Opus at high for every kind but review: Sol at high, Opus at high while Sol is out.
        config = self.load()
        self.assertEqual(config.job('build'), OPUS_HIGH)
        self.assertEqual(config.job('review'), SOL_HIGH)

    def test_the_served_config_keeps_stefans_jobs(self):
        # Opus 5.5 medium for every kind (2026-11-16); Sol high reviews, Opus 5.5 high while
        # Sol is out (2026-11-16, "turn on 6.1 Sol high now").
        config = load_config(DEFAULT_CONFIG)
        medium = JobSpec('claudeAgent', 'claude-opus-5-5', 'medium')
        for kind in KINDS:
            with self.subTest(kind=kind):
                self.assertEqual(config.job(kind), SOL_HIGH if kind == 'review' else medium)

    def test_efforts_are_checked_per_provider(self):
        with self.assertRaisesRegex(ValueError, r'jobs\.fix.*claudeAgent.*minimal'):
            self.load('[jobs.fix]\neffort = "minimal"\n')   # Codex's, not Claude's
        self.assertEqual(self.load('[jobs.fix]\nprovider = "codex"\nmodel = "gpt-6.1-sol"\n'
                                   'effort = "minimal"\n').job('fix').effort, 'minimal')
        with self.assertRaisesRegex(ValueError, r'jobs\.review\.fallback.*effort'):
            self.load('[jobs.review]\nfallback = { effort = "ultrathink" }\n')

    def test_an_unknown_kind_or_provider_or_key_is_refused(self):
        with self.assertRaisesRegex(ValueError, r'jobs\.biuld.*build, fix'):
            self.load('[jobs.biuld]\neffort = "low"\n')
        with self.assertRaisesRegex(ValueError, r'jobs\.build.*provider.*claudeAgent, codex'):
            self.load('[jobs.build]\nprovider = "gemini"\n')
        with self.assertRaisesRegex(ValueError, r'jobs\.build.*modle'):
            self.load('[jobs.build]\nmodle = "x"\n')

    def test_a_review_fallback_on_codex_is_refused(self):
        # Only a review whose own provider is Codex runs through the Codex adapter.
        with self.assertRaisesRegex(ValueError, r'jobs\.review\.fallback.*codex'):
            self.load('[jobs.review]\nprovider = "claudeAgent"\nmodel = "claude-opus-5-5"\n'
                      'fallback = { provider = "codex", model = "gpt-6.1-sol" }\n')

    def test_an_old_claude_or_review_table_fails_saying_what_to_write(self):
        with self.assertRaisesRegex(ValueError, r'\[claude\].*\[jobs\.default\]'):
            self.load('[claude]\nmodel = "claude-opus-5-5"\n')
        with self.assertRaisesRegex(ValueError, r'\[review\].*\[jobs\.review\]'):
            self.load('[review]\nprovider = "claude"\n')


if __name__ == '__main__':
    unittest.main()

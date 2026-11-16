"""PR 67 review 2, F2: a dead runner's Opus fallback review, settled by the Sol lane, leaves the
cached reading taken while its thread ran good for the Claude lane's next check."""
import unittest

from queue_runner.fallback import KIND as FALLBACK
from queue_runner.run import STARTED
from tests.fakes_t3 import FakeGit
from tests.test_usage_budget import EndedElsewhereTest as _Base


class EndedElsewhereTest(_Base):
    pass


class FallbackSettleTest(EndedElsewhereTest):
    def test_a_dead_runners_fallback_review_holds_the_next_job_for_a_reading_after_it(self):
        job = self.log.started(kind='review', repo='queue-runner', issue=7,
                               branch='claude/x-7', title='Queue runner review: queue-runner#7',
                               sha='c' * 40, round=1, reviewer=FALLBACK)
        self.t3.add('mcp:opus', job.title, 'running')   # its Opus thread runs on
        self.endpoint.five = 10
        self.tick()                                     # 14:01:49: 10% while it runs
        from queue_runner.review import Reviewer
        Reviewer(self.config, github=self.gh, git=FakeGit(), sol=object(), jobs=self.r.jobs,
                 say=lambda line: None).settle()      # the Sol lane: counted failed
        self.clock.at(14, 2, 49)
        self.endpoint.five = 90                         # what the review spent
        self.t3.set_status('mcp:opus', 'completed')
        got = self.r.run_pass()
        # Expected (as for a build settled by Runner.settle): held until 14:06:49.
        self.assertNotEqual(got, STARTED,
                            'a build started on the 10% reading taken while the fallback '
                            'review thread ran; the endpoint now says 90%')


if __name__ == '__main__':
    unittest.main()

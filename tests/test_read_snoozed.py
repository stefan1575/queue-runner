"""Read and snoozed, kept by the runner (ticket 36): which asks Stefan has read or snoozed is
`control.json`'s `asks.<id>`, so every browser agrees. The page writes it (`dashboard/serve.py`,
tested in test_dashboard.py); the runner reads it into the snapshot's asks."""
import datetime
import json
import os
import shutil
import tempfile
import unittest

from queue_runner import control, inbox, snapshot
from tests.test_asks import H2, KindsCase

NOW = '2026-11-15T13:00:00+08:00'


class ControlFileTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='qr-read-snoozed-')
        self.addCleanup(shutil.rmtree, self.dir, True)

    def put(self, data):
        with open(control.path(self.dir), 'w', encoding='utf-8') as f:
            json.dump(data, f)

    def test_the_switch_carries_each_asks_entry(self):
        self.put({'written_at': NOW, 'lanes': {},
                  'asks': {'stop-1': {'read': True, 'open': 't3'},
                           'stop-2': {'snooze_until': '2026-11-16T09:00:00+08:00'}}})
        switch = control.read(self.dir)
        self.assertIsNone(switch.error)
        self.assertEqual(switch.asks, {'stop-1': {'read': True, 'open': 't3'},
                                       'stop-2': {'snooze_until': '2026-11-16T09:00:00+08:00'}})

    def test_an_asks_entry_it_cant_use_is_left_out_and_stops_no_lane(self):
        # Read and snoozed only change what the page shows: a bad entry is no reason to stop.
        self.put({'written_at': NOW, 'asks': {'stop-1': 'read', 'stop-2': {'read': True}}})
        switch = control.read(self.dir)
        self.assertIsNone(switch.error)
        self.assertEqual(switch.asks, {'stop-2': {'read': True}})
        self.put({'written_at': NOW, 'asks': ['stop-1']})
        self.assertEqual((control.read(self.dir).error, control.read(self.dir).asks), (None, {}))

    def test_pause_and_resume_keep_the_asks_as_they_were(self):
        asks = {'stop-1': {'read': True, 'open': 't3'}, 'stop-2': {'snooze_until': None}}
        self.put({'written_at': NOW, 'lanes': {}, 'asks': asks})
        data = control.ask(self.dir, ['claude'], 'after-job', NOW)
        self.assertEqual(data['asks'], asks)
        with open(control.path(self.dir), encoding='utf-8') as f:
            self.assertEqual(json.load(f)['asks'], asks)


class SnapshotTest(KindsCase):
    """The snapshot's asks carry `read` and `snoozed_until` from control.json's entries."""
    NOW = datetime.datetime(2026, 11, 15, 5, 0, tzinfo=datetime.timezone.utc)

    def setUp(self):
        super().setUp()
        self.ready()                                                      # merge-first-153-...
        self.stop = self.job('stop', 152, 'filed', sha=H2, stop='review', reason='review 2 stopped',
                             link='https://github.com/owner/first/issues/30')

    def asks(self, marks, now=NOW):
        got = inbox.collect(self.config, self.gh, self.jobs)
        snap = snapshot.build(snapshot.Facts(now=now, repos=[self.repo], jobs=self.jobs.jobs(),
                                             inbox=got, switch=control.Switch(asks=marks)))
        return {a['id']: a for a in snap['asks'] + snap['answered']}

    def test_an_ask_with_no_entry_is_unread_and_not_snoozed(self):
        for a in self.asks({}).values():
            self.assertEqual((a['read'], a['snoozed_until']), (False, None))

    def test_read_is_what_the_page_last_asked(self):
        stop = f'stop-{self.stop.id}'
        self.assertTrue(self.asks({stop: {'read': True}})[stop]['read'])
        self.assertFalse(self.asks({stop: {'read': False, 'open': 't3'}})[stop]['read'])

    def test_a_snooze_lasts_until_its_time_and_is_over_after(self):
        stop = f'stop-{self.stop.id}'
        until = '2026-11-15T14:00:00+08:00'   # 06:00Z, an hour after NOW
        a = self.asks({stop: {'snooze_until': until}})[stop]
        self.assertEqual(datetime.datetime.fromisoformat(a['snoozed_until']),
                         datetime.datetime.fromisoformat(until))
        later = self.NOW + datetime.timedelta(hours=1)
        self.assertIsNone(self.asks({stop: {'snooze_until': until}}, now=later)[stop]['snoozed_until'])
        self.assertIsNone(self.asks({stop: {'snooze_until': None}})[stop]['snoozed_until'])
        self.assertIsNone(self.asks({stop: {'snooze_until': 'soon'}})[stop]['snoozed_until'])

    def test_a_snoozed_ask_is_still_listed_and_still_holds_its_work_up(self):
        stop = f'stop-{self.stop.id}'
        plain = self.asks({})[stop]
        snoozed = self.asks({stop: {'snooze_until': '2026-11-16T09:00:00+08:00'}})[stop]
        self.assertEqual(snoozed['holds_up'], plain['holds_up'])
        self.assertTrue(snoozed['holds_up'])


if __name__ == '__main__':
    unittest.main()

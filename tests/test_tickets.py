import os
import subprocess
import tempfile
import unittest

from queue_runner.tickets import blocked_by, pick_ticket, read_tickets, status_of, why_not


def _ticket(n: int, title: str, status: str, blocked: str | None = None,
            form: str = 'bold') -> str:
    line = f'**Status:** {status}' if form == 'bold' else f'Status: {status}'
    blocker = f'\n**Blocked by:** {blocked}\n' if blocked is not None else ''
    return (f'# {n:02d}: {title}\n\n**What to build:** {title}.\n{blocker}\n{line}\n\n'
            f'- [ ] It works.\n')


class StatusTest(unittest.TestCase):
    def test_both_forms_with_and_without_a_trailing_date(self):
        for line, want in [('Status: done', 'done'),
                           ('**Status:** done', 'done'),
                           ('Status: done (2026-10-23)', 'done'),
                           ('**Status:** done (2026-11-10)', 'done'),
                           ('Status: done.', 'done'),
                           ('Status: done (2026-10-27; re-credited 2026-10-29)', 'done'),
                           ('**Status:** ready-for-agent', 'ready-for-agent'),
                           ('Status: needs-info (2026-11-10: asked under Comments)',
                            'needs-info'),
                           ('**Status**: Ready-For-Agent', 'ready-for-agent')]:
            with self.subTest(line=line):
                self.assertEqual(status_of(f'# 01: x\n\n{line}\n\nBody.\n'), want)

    def test_no_status_line(self):
        self.assertIsNone(status_of('# 01: x\n\nBody that mentions a `Status:` line.\n'))

    def test_a_status_line_under_comments_doesnt_count(self):
        self.assertIsNone(status_of('# 01: x\n\n## Comments\n\nStatus: done\n'))

    def test_the_first_status_line_wins(self):
        self.assertEqual(status_of('Status: needs-info\n\nStatus: done\n'), 'needs-info')


class BlockedByTest(unittest.TestCase):
    def test_forms(self):
        for line, want in [('**Blocked by:** 05', (5,)),
                           ('Blocked by: 01, 02', (1, 2)),
                           ('Blocked by: 03-sol-review-dry-run.md, #04', (3, 4)),
                           ('Blocked by: 02 (done 2026-11-07), 06', (2, 6)),
                           ('Blocked by: None (can start immediately)', ()),
                           ('**Blocked by:** none', ())]:
            with self.subTest(line=line):
                self.assertEqual(blocked_by(f'# 07: x\n\n{line}\n'), want)

    def test_no_line_blocks_nothing(self):
        self.assertEqual(blocked_by('# 07: x\n\nSee 05.\n'), ())


class SandboxRepoTest(unittest.TestCase):
    """A real git repo in a temp folder: three tickets in a blocker chain (01 <- 02 <- 03), and
    another feature whose numbers repeat."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = self._tmp.name
        subprocess.run(['git', 'init', '-q', '-b', 'main', self.repo], check=True)
        self.write('chain', 1, 'first', _ticket(1, 'First', 'ready-for-agent', 'None'))
        self.write('chain', 2, 'second', _ticket(2, 'Second', 'ready-for-agent', '01',
                                                 form='plain'))
        self.write('chain', 3, 'third', _ticket(3, 'Third', 'ready-for-agent', '01, 02'))
        os.makedirs(os.path.join(self.repo, '.scratch', 'chain'), exist_ok=True)
        with open(os.path.join(self.repo, '.scratch', 'chain', 'spec.md'), 'w') as f:
            f.write('# Spec\n\nStatus: ready-for-agent\n')   # not a ticket: not under issues/
        self.commit('three tickets')

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, feature, n, slug, text):
        folder = os.path.join(self.repo, '.scratch', feature, 'issues')
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, f'{n:02d}-{slug}.md'), 'w', encoding='utf-8') as f:
            f.write(text)

    def commit(self, message):
        subprocess.run(['git', '-C', self.repo, 'add', '-A'], check=True)
        subprocess.run(['git', '-C', self.repo, '-c', 'user.name=t', '-c', 'user.email=t@t',
                        'commit', '-q', '-m', message], check=True)

    def set_status(self, n, slug, title, status, blocked, form='bold'):
        self.write('chain', n, slug, _ticket(n, title, status, blocked, form=form))
        self.commit(f'{n:02d} {status}')

    def test_reads_every_ticket_with_its_status_and_blockers(self):
        tickets = read_tickets(self.repo)
        self.assertEqual([(t.key, t.status, t.blocked_by) for t in tickets],
                         [('chain/01', 'ready-for-agent', ()),
                          ('chain/02', 'ready-for-agent', (1,)),
                          ('chain/03', 'ready-for-agent', (1, 2))])
        self.assertEqual(tickets[0].path, '.scratch/chain/issues/01-first.md')
        self.assertEqual(tickets[0].title, '01: First')

    def test_the_chain_is_built_in_order(self):
        self.assertEqual(pick_ticket(self.repo).key, 'chain/01')
        self.set_status(1, 'first', 'First', 'done (2026-11-10)', 'None')
        self.assertEqual(pick_ticket(self.repo).key, 'chain/02')
        tickets = read_tickets(self.repo)
        self.assertEqual(why_not(tickets[2], tickets), 'blocked by chain/02 (ready-for-agent)')
        self.set_status(2, 'second', 'Second', 'done', '01', form='plain')
        self.assertEqual(pick_ticket(self.repo).key, 'chain/03')
        self.set_status(3, 'third', 'Third', 'done.', '01, 02')
        self.assertIsNone(pick_ticket(self.repo))

    def test_a_stopped_blocker_holds_the_rest_of_the_chain(self):
        self.set_status(1, 'first', 'First', 'needs-info (2026-11-10)', 'None')
        self.assertIsNone(pick_ticket(self.repo))

    def test_a_held_ticket_is_skipped(self):
        self.assertIsNone(pick_ticket(self.repo, held={'chain/01'}))   # 02 and 03 wait on it

    def test_a_blocker_with_no_file_blocks(self):
        self.write('other', 1, 'lone', _ticket(1, 'Lone', 'ready-for-agent', '09'))
        tickets = read_tickets(self.repo)
        lone = next(t for t in tickets if t.key == 'other/01')
        self.assertEqual(why_not(lone, tickets), 'blocked by other/09, which has no file')

    def test_blockers_are_in_the_tickets_own_feature(self):
        # other/02 is blocked by other/01, not chain/01 (which is ready, not done)
        self.write('other', 1, 'a', _ticket(1, 'A', 'done', None))
        self.write('other', 2, 'b', _ticket(2, 'B', 'ready-for-agent', '01'))
        self.set_status(1, 'first', 'First', 'needs-info', 'None')
        self.assertEqual(pick_ticket(self.repo).key, 'other/02')

    def test_equal_numbers_go_by_feature_name(self):
        self.write('aaa', 1, 'x', _ticket(1, 'X', 'ready-for-agent', None))
        self.assertEqual(pick_ticket(self.repo).key, 'aaa/01')

    def test_a_repo_with_no_scratch_folder_has_no_tickets(self):
        with tempfile.TemporaryDirectory() as empty:
            self.assertEqual(read_tickets(empty), [])
            self.assertIsNone(pick_ticket(empty))


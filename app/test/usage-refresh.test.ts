// Refresh on the Usage card, from `tests/test_usage_refresh.py` (#263): every case pending here,
// named as in Python. They test control.json, the dashboard's server, the snapshot and the
// dashboard's sample, not the gate, so each class's ticket turns its cases on (#263's comment).
import { describe, it } from 'vitest';

describe('ControlTest', () => {
  // Turned on by the switches' port (#229): control.py and dashboard/serve.py's apply_control.
  it.todo('test_refresh_is_written_with_its_time_and_kept_by_other_requests');
  it.todo('test_no_refresh_asked_writes_no_usage');
  it.todo("test_anything_else_under_usage_is_refused (body={'usage': 'now'})");
  it.todo("test_anything_else_under_usage_is_refused (body={'usage': True})");
  it.todo("test_anything_else_under_usage_is_refused (body={'usage': 'refresh', 'lane': 'sol'})");
  it.todo('test_the_runner_reads_when_it_was_asked');
  it.todo("test_a_usage_entry_the_page_couldnt_have_written_is_ignored_not_unreadable");
  it.todo('test_pause_and_resume_keep_the_request');
});

describe('RunnerTest', () => {
  // Turned on by the snapshot's port (#230): snapshot.Snapshots on the ported CachedUsage.
  it.todo('test_a_refresh_inside_claudes_budget_is_taken_and_gives_back_its_reading');
  it.todo('test_a_refresh_outside_claudes_budget_reads_it_as_now');
  it.todo('test_each_refresh_is_taken_and_none_asks_claude_inside_its_budget');
  it.todo('test_a_failed_login_is_said_in_the_plan_and_the_request_counts_as_taken');
  it.todo('test_a_429_beside_a_recent_reading_is_no_error');
  it.todo('test_a_request_left_from_before_the_runner_started_is_taken_by_its_first_read');
  it.todo('test_with_nothing_asked_there_is_no_refresh_to_tell');
  it.todo('test_an_unreadable_control_json_refreshes_nothing');
});

describe('SampleTest', () => {
  // Turned on by #235: dashboard/sample.py's pretend runner.
  it.todo('test_the_pretend_runner_takes_a_refresh_a_few_seconds_after_it_is_asked');
  it.todo('test_outside_claudes_budget_the_pretend_runner_reads_it_too');
  it.todo('test_one_plan_has_reset_credits_and_one_has_none');
});

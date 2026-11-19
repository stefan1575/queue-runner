## Before you push

Don't run a review (no review pass, no second agent): the runner has the PR reviewed. But reviews
keep blocking on the same few causes, so before you push, read your diff against this list once
and fix what you find, with a test for each:

- **The issue:** every case and acceptance criterion it names is done and tested, and whatever
  calls what you changed still gets what it expects (trace the callers).
- **Lists:** every list read from GitHub, a database or an API is read to its last page.
- **Checked earlier, used later:** a setting, switch or state checked before a slow step (a
  fetch, a launch, any I/O) is checked again just before the step it guards, and a choice made
  when the job was let in is the one used, not looked up again.
- **Failures:** a read or write that can fail for a moment is tried again later, never taken as
  "none", "done" or "gone"; a failed read never replaces good data already held.
- **A crash between steps:** a restart after any step (recorded but not yet done, done but not
  yet recorded) leaves something the next start finds and finishes or undoes.
- **Putting back:** whatever the change alters outside its own state (a file, a window, a
  label, a setting) is put back on every way out, failures included.
- **Screenshots:** if the issue changes what a person sees, your after shots show it.

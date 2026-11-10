"""One-off Windows wake tasks for the times the runner waits for (ticket 10).

While the runner waits for a time (the usage gate's reset, a limit's resume, Sol's resume), it
keeps one Task Scheduler task per time in the folder `\\Queue runner\\`, named `wake <local
time>`, set to wake the PC to run. The task's action holds off idle sleep for 10 minutes, so the
runner's own wall-clock sleep (`run.wall_sleep`) notices the time and starts its pass before the
PC drops back to sleep; the keep-awake hooks then hold it while a job runs. `Waker.sync` makes the
folder hold exactly the times still ahead: a task whose time has passed (used) or that nothing
waits for any more is deleted. Each task also expires an hour after its time, and Windows deletes
it then (`DeleteExpiredTaskAfter`), in case the runner is gone.
"""
import datetime
import os
import subprocess
import sys
import tempfile
from xml.sax.saxutils import escape

FOLDER = '\\Queue runner\\'
PREFIX = 'wake '
MIN_LEAD = datetime.timedelta(seconds=60)   # a time closer than this isn't worth a task
HOLD_SECONDS = 600
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def task_name(when: datetime.datetime) -> str:
    """`\\Queue runner\\wake 2026-11-10 1405`+0800`: the local minute it wakes at, with its UTC
    offset, so the two 01:30s of a DST change are two tasks."""
    return f'{FOLDER}{PREFIX}{when.astimezone():%Y-%m-%d %H%M%z}'


def wake_at(when: datetime.datetime) -> datetime.datetime:
    """The whole minute the task fires at: `when`, rounded up."""
    up = when.astimezone().replace(second=0, microsecond=0)
    return up if up == when.astimezone() else up + datetime.timedelta(minutes=1)


def hold_awake_action() -> tuple[str, str]:
    """(command, arguments): pythonw, with no window, holding off idle sleep for 10 minutes."""
    folder = os.path.dirname(sys.executable)
    pythonw = os.path.join(folder, 'pythonw.exe')
    exe = pythonw if os.path.exists(pythonw) else sys.executable
    code = ('import ctypes,time;k=ctypes.windll.kernel32;k.SetThreadExecutionState(0x80000001);'
            f'time.sleep({HOLD_SECONDS})')
    return exe, f'-I -c "{code}"'


def task_xml(when: datetime.datetime, command: str, arguments: str) -> str:
    """A one-off time trigger at `when` (an aware time), wake to run, deleted once expired."""
    start = when.astimezone().isoformat(timespec='seconds')
    end = (when + datetime.timedelta(hours=1)).astimezone().isoformat(timespec='seconds')
    return f'''<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Set by the queue runner (~/Code/Personal/queue-runner): wakes the PC for a time it waits for, then holds off sleep for 10 minutes.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>{start}</StartBoundary>
      <EndBoundary>{end}</EndBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <DeleteExpiredTaskAfter>PT0S</DeleteExpiredTaskAfter>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{escape(command)}</Command>
      <Arguments>{escape(arguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
'''


class WakeError(RuntimeError):
    pass


def run_schtasks(args: list[str]) -> tuple[int, str, str]:
    p = subprocess.run(['schtasks', *args], capture_output=True, text=True, errors='replace',
                       creationflags=NO_WINDOW)
    return p.returncode, p.stdout, p.stderr


class Schtasks:
    """The Task Scheduler seam, through `schtasks.exe`: `names()` lists the runner's wake tasks,
    `create(name, when)` and `delete(name)`."""

    def __init__(self, run=run_schtasks, action=hold_awake_action):
        self._run, self._action = run, action

    def _call(self, args):
        code, out, err = self._run(args)
        if code:
            raise WakeError(f'schtasks {args[0]} failed ({code}): {(err or out).strip()}')
        return out

    def names(self) -> set[str]:
        import csv
        out = self._call(['/query', '/fo', 'csv', '/nh'])
        return {row[0] for row in csv.reader(out.splitlines())
                if row and row[0].startswith(FOLDER + PREFIX)}

    def create(self, name: str, when: datetime.datetime) -> None:
        fd, path = tempfile.mkstemp(suffix='.xml')
        try:
            with os.fdopen(fd, 'w', encoding='utf-16') as f:
                f.write(task_xml(when, *self._action()))
            self._call(['/create', '/tn', name, '/xml', path, '/f'])
        finally:
            os.remove(path)

    def delete(self, name: str) -> None:
        self._call(['/delete', '/tn', name, '/f'])


class Waker:
    """Keeps the runner's wake tasks to the times it waits for. `say` logs; a scheduler error
    is said once (until it changes) and never stops the loop."""

    def __init__(self, scheduler, say, now=None):
        self.scheduler, self.say = scheduler, say
        self.now = now or (lambda: datetime.datetime.now(datetime.timezone.utc))
        self._last_error: str | None = None

    def sync(self, times) -> None:
        now = self.now()
        wanted, new = {}, set()   # every time still ahead keeps its task; only far ones get one
        for t in times:
            if t is not None and wake_at(t) > now:   # not yet fired
                at = wake_at(t)
                wanted[task_name(at)] = at
                if t - now >= MIN_LEAD:
                    new.add(task_name(at))
        try:
            have = self.scheduler.names()
            for name in sorted(have - wanted.keys()):
                self.scheduler.delete(name)
                self.say(f'Wake task removed: {name}')
            for name in sorted(new - have):
                self.scheduler.create(name, wanted[name])
                self.say(f'Wake task set: {name} wakes the PC at '
                         f'{wanted[name]:%Y-%m-%d %H:%M}')
            self._last_error = None
        except (WakeError, OSError) as e:
            if str(e) != self._last_error:
                self.say(f'Wake tasks: {e}')
            self._last_error = str(e)


class NoWaker:
    def sync(self, times) -> None:
        pass

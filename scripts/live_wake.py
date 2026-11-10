"""Live check of the wake tasks (ticket 10): sets one real wake task a few minutes ahead through
`wake.Waker` and `wake.Schtasks`, shows its settings from Task Scheduler, and after it fired,
removes it as the runner would.

    python3 scripts/live_wake.py [MINUTES]          # default 3
    python3 scripts/live_wake.py [MINUTES] --sleep  # also put the PC to sleep (it must wake itself)

With --sleep, the PC sleeps a few seconds after the task is set; wake it by hand only if it is
still asleep well after the time. Afterwards the System log's "returned from a low power state"
event names the wake source, and the script's output says whether the task ran.
"""
import datetime
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from queue_runner.wake import Schtasks, Waker, task_name, wake_at  # noqa: E402


def ps(command: str) -> str:
    return subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                          capture_output=True, text=True, errors='replace').stdout.strip()


def main() -> None:
    minutes = int(next((a for a in sys.argv[1:] if a.isdigit()), '3'))
    at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=minutes)
    waker = Waker(Schtasks(), say=print)
    waker.sync([at])
    name = task_name(wake_at(at))
    folder, leaf = name.rsplit('\\', 1)
    q = f"-TaskPath '{folder}\\' -TaskName '{leaf}'"
    print(ps(f'$t = Get-ScheduledTask {q}; "WakeToRun=" + $t.Settings.WakeToRun; '
             '"Trigger=" + $t.Triggers[0].CimClass.CimClassName + " " + $t.Triggers[0].StartBoundary; '
             '"Repetition=" + $t.Triggers[0].Repetition.Interval; '
             '"Action=" + $t.Actions[0].Execute + " " + $t.Actions[0].Arguments'))
    if '--sleep' in sys.argv:
        print('Sleeping the PC in 10 seconds...')
        time.sleep(10)
        subprocess.run(['rundll32.exe', 'powrprof.dll,SetSuspendState', '0,1,0'])
    while datetime.datetime.now(datetime.timezone.utc) < wake_at(at) + datetime.timedelta(seconds=40):
        time.sleep(10)
    print(ps(f'$i = Get-ScheduledTaskInfo {q}; "LastRunTime=" + $i.LastRunTime + " LastTaskResult=" + $i.LastTaskResult'))
    print(ps("Get-WinEvent -FilterHashtable @{LogName='System'; "
             "ProviderName='Microsoft-Windows-Power-Troubleshooter'} -MaxEvents 1 | "
             "Format-List TimeCreated, Message | Out-String"))
    waker.sync([])   # used: the runner removes it
    gone = name not in Schtasks().names()
    print(f'Removed after use: {gone}')


if __name__ == '__main__':
    main()

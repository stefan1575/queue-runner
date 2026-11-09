"""Locks between runner processes: one runner, and one Sol job at a time."""
import contextlib
import os


class RunnerBusy(RuntimeError):
    pass


@contextlib.contextmanager
def runner_lock(state_dir: str, name: str = 'runner.lock'):
    """A byte lock on `<state_dir>/<name>`: `runner.lock` for the runner's whole life,
    `sol.lock` for each Sol job. The OS drops it if the process dies."""
    os.makedirs(state_dir, exist_ok=True)
    f = open(os.path.join(state_dir, name), 'a+')
    try:
        try:
            if os.name == 'nt':
                import msvcrt
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RunnerBusy(f'another queue runner holds {f.name}') from None
        try:
            yield
        finally:
            if os.name == 'nt':
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
    finally:
        f.close()

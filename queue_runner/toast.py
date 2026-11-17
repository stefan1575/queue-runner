"""Toasting Stefan (ticket 06; `docs/flow.md`, Notifications): a native Windows
toast under the runner's own name and icon, not PowerShell's, whose click opens a URL (the stop's
`needs-info` issue, or a waiting thread).

How: the runner registers its own AppUserModelID under
`HKCU\\Software\\Classes\\AppUserModelId\\<AUMID>` with a display name and an icon (what the Windows
App SDK does for an unpackaged app), then has Windows PowerShell 5.1 show the toast through WinRT's
`ToastNotificationManager.CreateToastNotifier(<AUMID>)`. Windows shows the registered name and
icon, so PowerShell is only the carrier. The toast is `activationType="protocol"` with the URL as
its `launch`, so a click opens the URL in the default handler with no COM activator to run.
PowerShell runs with no window (the runner lives under pythonw).
"""
import base64
import os
import subprocess
from xml.sax.saxutils import quoteattr, escape

AUMID = 'Stefan.QueueRunner'
NAME = 'Queue runner'
ICON = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets', 'icon.png')
GROUP = 'queue-runner'

_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{xml}'))
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
$toast.Tag = '{tag}'
$toast.Group = '{group}'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{aumid}').Show($toast)
'''


class ToastFailed(RuntimeError):
    pass


def toast_xml(title: str, text: str, url: str, button: str = 'Open') -> str:
    """The toast: title, one line of text, and a click (or its button) that opens `url`."""
    return (f'<toast activationType="protocol" launch={quoteattr(url)}>'
            '<visual><binding template="ToastGeneric">'
            f'<text>{escape(title)}</text><text>{escape(text)}</text>'
            '</binding></visual>'
            f'<actions><action activationType="protocol" content={quoteattr(button)} '
            f'arguments={quoteattr(url)}/></actions>'
            '</toast>')


def register(aumid: str = AUMID, name: str = NAME, icon: str = ICON) -> None:
    """Gives the AppUserModelID its display name and icon (per user, no admin)."""
    import winreg
    key = winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                           rf'Software\Classes\AppUserModelId\{aumid}')
    with key:
        winreg.SetValueEx(key, 'DisplayName', 0, winreg.REG_SZ, name)
        winreg.SetValueEx(key, 'IconUri', 0, winreg.REG_SZ, icon)
        winreg.SetValueEx(key, 'IconBackgroundColor', 0, winreg.REG_SZ, 'FF115E59')


class WindowsToaster:
    """`toast(...)` raises ToastFailed if Windows didn't take it."""

    def __init__(self, aumid: str = AUMID, run=subprocess.run):
        self.aumid, self._run = aumid, run
        self._registered = False

    def toast(self, title: str, text: str, url: str, tag: str = '', button: str = 'Open') -> None:
        if not self._registered:
            try:
                register(self.aumid)
            except OSError as e:
                raise ToastFailed(f'registering {self.aumid} failed: {e}') from e
            self._registered = True
        xml = base64.b64encode(toast_xml(title, text, url, button).encode('utf-8')).decode()
        script = _SCRIPT.format(xml=xml, tag=_ps(tag[:64] or 'toast'), group=GROUP,
                                aumid=_ps(self.aumid))
        encoded = base64.b64encode(script.encode('utf-16-le')).decode()
        try:
            p = self._run(['powershell.exe', '-NoProfile', '-NonInteractive',
                           '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
                          capture_output=True, text=True, encoding='utf-8', errors='replace',
                          timeout=60, stdin=subprocess.DEVNULL,
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except (OSError, subprocess.SubprocessError) as e:
            raise ToastFailed(f'PowerShell did not run: {e}') from e
        if p.returncode:
            raise ToastFailed(f'PowerShell exited {p.returncode}: {(p.stderr or "").strip()}')


def _ps(s: str) -> str:
    """Inside a single-quoted PowerShell string."""
    return s.replace("'", "''")


class NoToaster:
    """Toasts nothing (tests, dry runs)."""

    def toast(self, title, text, url, tag='', button='Open') -> None:
        return None

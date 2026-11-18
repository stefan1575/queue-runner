## Install

Download `Queue-runner-Setup-<version>.exe` below and run it. It installs for your Windows
account only (no administrator rights), adds **Queue runner** to the Start menu and starts the
app, which opens **Setup**: what the runner still needs from this PC (T3 Code, a connected
provider, `gh` signed in).

**The installer is not signed**, so Windows' SmartScreen stops it the first time. It shows a blue
window, **Windows protected your PC**: "Microsoft Defender SmartScreen prevented an unrecognized
app from starting", with Publisher: Unknown publisher. Click **More info**, then **Run anyway**.
Signing needs a paid certificate and can come later.

## Uninstall

Settings > Apps > Installed apps > Queue runner > Uninstall. This removes the app, its Start
menu entry and its start at logon. Your settings and state stay in `%APPDATA%\Queue runner`, so a
reinstall picks up where you left off; delete that folder to remove them too.

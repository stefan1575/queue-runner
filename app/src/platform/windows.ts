// The platform module on Windows, through Electron: the tray icon and its menu, and the logon
// entry (Electron writes it under HKCU\...\Run). Not under test: the tests fake `Platform`.
import { app, Menu, nativeImage, Tray } from 'electron';
import type { Platform } from './platform.ts';

/** `trayIcon` is the 16px PNG; a `@2x` file beside it serves high-DPI screens. */
export function windowsPlatform(trayIcon: string): Platform {
  // Started at logon, the app runs as it was started now (Electron and the app's folder while
  // unpackaged), with --hidden so it stays in the tray.
  const logon = { path: process.execPath, args: [...(app.isPackaged ? [] : [app.getAppPath()]), '--hidden'] };
  let tray: Tray | null = null; // held, or the icon is collected away
  return {
    tray(menu) {
      tray = new Tray(nativeImage.createFromPath(trayIcon));
      tray.setToolTip('Queue runner');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open', click: menu.open },
        { type: 'separator' },
        { label: 'Quit', click: menu.quit },
      ]));
      tray.on('click', menu.open);
    },
    startAtLogon: {
      isOn: () => app.getLoginItemSettings(logon).openAtLogin,
      set: (on) => app.setLoginItemSettings({ ...logon, openAtLogin: on }),
    },
  };
}

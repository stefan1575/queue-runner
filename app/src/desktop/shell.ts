// The desktop app's frame (#150; #68 stories 33 and 34): one app at a time, a window that closes
// into the tray, and Quit in the tray menu to stop it. Electron's app and window are the `Shell`
// seam (`electron.ts` is the real one), the tray and the logon entry are the platform module's.
import type { Platform } from '../platform/platform.ts';
import type { SettingsStore } from '../settings.ts';

export interface AppWindow {
  show(): void;
  hide(): void;
  /** The window is being closed; calling `prevent` keeps it. */
  onClose(handler: (prevent: () => void) => void): void;
}

export interface Shell {
  /** Takes the one-app lock. False when another start holds it (that app is then told, through
   *  its `onSecondStart`). */
  singleInstance(onSecondStart: () => void): boolean;
  openWindow(): AppWindow;
  /** Stops the app: its windows close for real. */
  quit(): void;
}

export type Desktop = { window: AppWindow; show(): void; quit(): void };

/** Starts the frame, or returns null (and quits) when another app is already running: that one
 *  shows its window instead. `hidden` is a start at logon, which stays in the tray. */
export async function startDesktop(o: {
  shell: Shell; platform: Platform; settings: SettingsStore; hidden: boolean;
}): Promise<Desktop | null> {
  const { shell, platform, settings } = o;
  let desktop: Desktop | null = null;
  if (!shell.singleInstance(() => desktop?.show())) {
    shell.quit();
    return null;
  }

  // The logon entry follows Start with Windows: set on every start (an entry removed or left
  // outside the app is put right) and on every change.
  const followLogon = (on: boolean) => {
    if (platform.startAtLogon.isOn() !== on) platform.startAtLogon.set(on);
  };
  followLogon(settings.get().startWithWindows);
  settings.onChange((s) => followLogon(s.startWithWindows));

  let quitting = false;
  const window = shell.openWindow();
  window.onClose((prevent) => {
    if (quitting) return;
    prevent();
    window.hide();
  });
  desktop = {
    window,
    show: () => window.show(),
    quit: () => {
      quitting = true;
      shell.quit();
    },
  };
  platform.tray({ open: desktop.show, quit: desktop.quit });
  if (!o.hidden) window.show();
  return desktop;
}

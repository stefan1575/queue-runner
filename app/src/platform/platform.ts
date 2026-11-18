// What the app needs from the operating system, behind one module (#68: "Platform specifics sit
// behind one platform module; Windows only for v1"). This ticket brings the tray and start at
// logon; later tickets add notifications and waking the PC. Faked in tests.

/** The logon entry's name under HKCU\Software\Microsoft\Windows\CurrentVersion\Run: the installer's
 *  uninstall removes it by this name (installer/uninstall.nsh). */
export const LOGON_ENTRY = 'Queue runner';

export type TrayMenu = {
  /** Shows the window: a click on the icon, or Open in its menu. */
  open(): void;
  /** Quit in the menu: stops the app. */
  quit(): void;
};

export interface Platform {
  /** Puts the app's icon in the tray, with Open and Quit. */
  tray(menu: TrayMenu): void;
  /** The app's logon entry: it starts, in the tray, when you sign in. */
  startAtLogon: {
    isOn(): boolean;
    set(on: boolean): void;
  };
}

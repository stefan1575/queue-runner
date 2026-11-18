// The desktop app's frame (#150): one app at a time, a window that closes into the tray, Quit in
// the tray menu, and Start with Windows kept in step with the platform's logon entry. Electron and
// the platform module are faked here.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startDesktop, type AppWindow, type Shell } from '../src/desktop/shell.ts';
import type { Platform, TrayMenu } from '../src/platform/platform.ts';
import { SettingsStore } from '../src/settings.ts';

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});
async function store() {
  const d = await mkdtemp(join(tmpdir(), 'qr-desktop-'));
  dirs.push(d);
  return SettingsStore.open(d);
}

class FakeWindow implements AppWindow {
  visible = false;
  destroyed = false;
  private closeHandler: ((prevent: () => void) => void) | null = null;
  show() { this.visible = true; }
  hide() { this.visible = false; }
  onClose(h: (prevent: () => void) => void) { this.closeHandler = h; }
  /** The user clicks the window's X: the window goes unless the handler prevents it. */
  close() {
    let prevented = false;
    this.closeHandler?.(() => { prevented = true; });
    if (!prevented) this.destroyed = true;
  }
}

/** Electron's app, faked: one lock per machine, shared by every start in a test. */
class FakeMachine {
  lockHeld = false;
  firstStart: (() => void) | null = null;
  shell(): Shell & { quitted: boolean; windows: FakeWindow[] } {
    const machine = this;
    const s = {
      quitted: false,
      windows: [] as FakeWindow[],
      singleInstance(onSecondStart: () => void) {
        if (machine.lockHeld) {
          machine.firstStart?.();
          return false;
        }
        machine.lockHeld = true;
        machine.firstStart = onSecondStart;
        return true;
      },
      openWindow() {
        const w = new FakeWindow();
        s.windows.push(w);
        return w;
      },
      quit() {
        s.quitted = true;
        for (const w of s.windows) w.close();
      },
    };
    return s;
  }
}

class FakePlatform implements Platform {
  logonEntry = false;
  logonChanges: boolean[] = [];
  menu: TrayMenu | null = null;
  tray(menu: TrayMenu) { this.menu = menu; }
  startAtLogon = {
    isOn: () => this.logonEntry,
    set: (on: boolean) => { this.logonEntry = on; this.logonChanges.push(on); },
  };
}

test('closing the window keeps the app in the tray, and the tray opens it again', async () => {
  const shell = new FakeMachine().shell();
  const platform = new FakePlatform();
  await startDesktop({ shell, platform, settings: await store(), hidden: false });
  const win = shell.windows[0]!;
  expect(win.visible).toBe(true);
  win.close();
  expect(win.destroyed).toBe(false);
  expect(win.visible).toBe(false);
  expect(shell.quitted).toBe(false);
  platform.menu!.open();
  expect(win.visible).toBe(true);
});

test('Quit in the tray menu stops the app, window and all', async () => {
  const shell = new FakeMachine().shell();
  const platform = new FakePlatform();
  await startDesktop({ shell, platform, settings: await store(), hidden: false });
  platform.menu!.quit();
  expect(shell.quitted).toBe(true);
  expect(shell.windows[0]!.destroyed).toBe(true);
});

test("a second start shows the first app's window and stops itself", async () => {
  const machine = new FakeMachine();
  const first = machine.shell();
  await startDesktop({ shell: first, platform: new FakePlatform(), settings: await store(), hidden: false });
  first.windows[0]!.close(); // in the tray
  const second = machine.shell();
  const desktop = await startDesktop({ shell: second, platform: new FakePlatform(), settings: await store(), hidden: false });
  expect(desktop).toBeNull();
  expect(second.quitted).toBe(true);
  expect(second.windows).toEqual([]);
  expect(first.windows[0]!.visible).toBe(true);
});

test('a start at logon stays in the tray', async () => {
  const shell = new FakeMachine().shell();
  await startDesktop({ shell, platform: new FakePlatform(), settings: await store(), hidden: true });
  expect(shell.windows[0]!.visible).toBe(false);
});

test('Start with Windows, on by default, adds the logon entry on the first start', async () => {
  const platform = new FakePlatform();
  await startDesktop({ shell: new FakeMachine().shell(), platform, settings: await store(), hidden: false });
  expect(platform.logonEntry).toBe(true);
});

test('switching Start with Windows removes and adds the logon entry through the platform', async () => {
  const platform = new FakePlatform();
  platform.logonEntry = true;
  const settings = await store();
  await startDesktop({ shell: new FakeMachine().shell(), platform, settings, hidden: false });
  expect(platform.logonChanges).toEqual([]); // already in step: nothing to write
  await settings.set({ startWithWindows: false });
  expect(platform.logonEntry).toBe(false);
  await settings.set({ name: 'Ana' }); // another setting leaves the entry alone
  await settings.set({ startWithWindows: true });
  expect(platform.logonChanges).toEqual([false, true]);
});

test('an entry removed outside the app comes back while the setting is on', async () => {
  const platform = new FakePlatform();
  const settings = await store();
  await settings.set({ startWithWindows: false });
  platform.logonEntry = true; // left by an older install, say
  await startDesktop({ shell: new FakeMachine().shell(), platform, settings, hidden: false });
  expect(platform.logonEntry).toBe(false);
});

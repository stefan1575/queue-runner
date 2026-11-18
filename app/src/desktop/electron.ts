// The desktop app's main process (`pnpm --dir app desktop`): the runner runs here and the window
// shows it (docs/app.md, The desktop app). Bundled by esbuild to desktop-dist/main.mjs.
//
//   --hidden        a start at logon: the app stays in the tray
//   --shoot <dir>   renders the window and each Settings page, light and dark, into <dir> as
//                   PNGs, on a fresh state in a temp folder, and quits (docs/app.md, Screenshots)
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GhGitHub } from '../github.ts';
import { windowsPlatform } from '../platform/windows.ts';
import { Repositories } from '../repos.ts';
import { SettingsStore } from '../settings.ts';
import { T3Mcp } from '../t3/mcp.ts';
import { T3ProjectFeed } from '../t3/project-feed.ts';
import { fetchHttp, nodeConnect, runtimeAddress, t3Cli } from '../t3/real.ts';
import { T3Ws } from '../t3/ws.ts';
import { sampleRepos } from './sample.ts';
import { stateFolder } from '../state-folder.ts';
import { CHANNELS } from './bridge.ts';
import { startDesktop, type Shell } from './shell.ts';
import { T3TimeFormat } from '../t3/time-format.ts';
import { RunnerView } from './view.ts';

const here = dirname(fileURLToPath(import.meta.url)); // desktop-dist/
const assets = join(here, '..', 'desktop');
const shootAt = process.argv.indexOf('--shoot');
const shootTo = shootAt > 0 ? process.argv[shootAt + 1] : undefined;

// A shoot runs on a state of its own, so it never touches the real one, the real app's lock or
// the logon entry.
const shootData = shootTo ? mkdtempSync(join(tmpdir(), 'queue-runner-shoot-')) : null;
if (shootData) app.setPath('userData', shootData);

function openWindow(show: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 760, minHeight: 520, show: false, paintWhenInitiallyHidden: true,
    title: 'Queue runner', icon: join(assets, 'icon.png'), autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121418' : '#f4f5f7',
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.setMenu(null);
  // Links never open inside the app.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (show) win.once('ready-to-show', () => win.show());
  return win;
}

const page = (hash = '') => ({ file: join(here, 'renderer', 'index.html'), hash });

async function main() {
  await app.whenReady();
  const userData = app.getPath('userData');
  const settings = await SettingsStore.open(stateFolder(join(userData, 'machine.json'), join(userData, 'state')));
  let win: BrowserWindow | null = null;
  // Windows' own folder dialog, over the window when it's open.
  const pickFolder = async () => {
    const options = { title: 'Add a repository', properties: ['openDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : r.filePaths[0] ?? null;
  };
  const github = new GhGitHub();
  // T3's projects, from T3's events; a shoot shows a sample of them instead (docs/app.md, Screenshots).
  const repos = shootTo ? await sampleRepos(settings) : (() => {
    const address = runtimeAddress();
    const cli = t3Cli();
    const feed = T3ProjectFeed.start(new T3Ws(address, cli, fetchHttp, nodeConnect));
    return Repositories.start({ feed, github, settings, mcp: new T3Mcp(address, cli, fetchHttp), pickFolder });
  })();
  // The clock follows T3's Time format, read from T3's client settings (docs/app.md, The desktop app).
  const view = await RunnerView.start(settings, github, await T3TimeFormat.start(), repos);

  ipcMain.handle(CHANNELS.view, () => view.get());
  ipcMain.handle(CHANNELS.set, (_e, patch) => view.set(patch));
  ipcMain.handle(CHANNELS.repo, (_e, action) => view.repo(action));

  if (shootTo) return shoot(shootTo);

  const shell: Shell = {
    singleInstance(onSecondStart) {
      if (!app.requestSingleInstanceLock()) return false;
      app.on('second-instance', onSecondStart);
      return true;
    },
    openWindow() {
      const w = openWindow(false);
      win = w;
      const { file, hash } = page();
      void w.loadFile(file, { hash });
      return {
        show: () => {
          if (w.isMinimized()) w.restore();
          w.show();
          w.focus();
        },
        hide: () => w.hide(),
        onClose: (handler) => w.on('close', (e) => handler(() => e.preventDefault())),
      };
    },
    quit: () => app.quit(),
  };
  const desktop = await startDesktop({
    shell, platform: windowsPlatform(join(assets, 'tray.png')), settings,
    hidden: process.argv.includes('--hidden'),
  });
  if (!desktop) return;
  view.onChange((v) => win?.webContents.send(CHANNELS.changed, v));
  // The window only hides; the app lives in the tray until Quit.
  app.on('window-all-closed', () => {});
}

/** The window and each Settings page, light and dark, as PNGs in `dir`. */
async function shoot(dir: string) {
  mkdirSync(dir, { recursive: true });
  const states: [string, string][] = [
    ['window', ''],
    ['settings-name', 'settings=name'],
    ['settings-display', 'settings=display'],
    ['settings-repos', 'settings=repos'],
    ['settings-machine', 'settings=machine'],
    ['settings-search', 'q=windos'],
  ];
  const win = openWindow(false);
  win.setContentSize(1440, 900);
  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme;
    for (const [name, hash] of states) {
      const p = page(hash);
      await win.loadFile(p.file, { hash: p.hash });
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 400)))');
      const image = await win.webContents.capturePage();
      writeFileSync(join(dir, `${name}-${theme}.png`), image.toPNG());
    }
  }
  win.destroy();
  // Chromium holds the temp state until it exits; what it leaves is the temp folder's to clean.
  app.on('quit', () => { try { rmSync(shootData!, { recursive: true, force: true }); } catch {} });
  app.quit();
}

main().catch((e) => {
  console.error(e);
  app.exit(1);
});

// The desktop app's main process (`pnpm --dir app desktop`): the runner runs here and the window
// shows it (docs/app.md, The desktop app). Bundled by esbuild to desktop-dist/main.mjs.
//
//   --hidden        a start at logon: the app stays in the tray
//   --shoot <dir>   renders the window and each Settings page, light and dark, into <dir> as
//                   PNGs, on a fresh state in a temp folder with the sample T3 catalog and usage
//                   in test/fixtures, and quits (docs/app.md, Screenshots)
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GhGitHub } from '../github.ts';
import { windowsPlatform } from '../platform/windows.ts';
import { checkJobs, DEFAULT_JOBS } from '../jobs.ts';
import { checkShares } from '../shares.ts';
import { usageFromProviders } from '../usage.ts';
import { SettingsStore } from '../settings.ts';
import { catalogFromConfig } from '../t3/catalog.ts';
import { fixedCatalog, T3Catalog } from '../t3/catalog-source.ts';
import { fetchHttp, nodeConnect, runtimeAddress, t3Cli } from '../t3/real.ts';
import { T3Ws } from '../t3/ws.ts';
import { stateFolder } from '../state-folder.ts';
import { CHANNELS } from './bridge.ts';
import { startDesktop, type Shell } from './shell.ts';
import { T3TimeFormat } from '../t3/time-format.ts';
import { RunnerView } from './view.ts';

const here = dirname(fileURLToPath(import.meta.url)); // desktop-dist/
const assets = join(here, '..', 'desktop');
const fixtures = join(here, '..', 'test', 'fixtures');
const fixture = (name: string) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
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
  // What T3 offers each job, kept current from its WebSocket; a shoot shows the sample instead.
  const catalog = shootTo
    ? fixedCatalog(catalogFromConfig(fixture('server-config.json').config), sampleUsage())
    : T3Catalog.start(new T3Ws(runtimeAddress(), t3Cli(), fetchHttp, nodeConnect));
  // The clock follows T3's Time format, read from T3's client settings (docs/app.md, The desktop app).
  const view = await RunnerView.start(settings, new GhGitHub(), await T3TimeFormat.start(), catalog);

  ipcMain.handle(CHANNELS.view, () => view.get());
  ipcMain.handle(CHANNELS.set, (_e, patch) => view.set(patch));

  if (shootTo) return shoot(shootTo, settings);

  let win: BrowserWindow | null = null;
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

/** The sample's usage, its times moved so T3 read it a minute ago (its resets stay ahead), with
 *  one more provider T3 reads no usage for (its Your share row is Coming soon). */
function sampleUsage() {
  const providers = [...fixture('server-config.json').config.providers, fixture('shoot-unread-provider.json')];
  const read = Math.max(...providers.map((p: any) => Date.parse(p.usageLimits?.checkedAt ?? '') || 0));
  const shift = Date.now() - 60_000 - read;
  const moved = (t: unknown) => (typeof t === 'string' ? new Date(Date.parse(t) + shift).toISOString() : t);
  for (const p of providers) {
    if (!p.usageLimits) continue;
    p.usageLimits.checkedAt = moved(p.usageLimits.checkedAt);
    for (const w of p.usageLimits.windows) w.resetsAt = moved(w.resetsAt);
  }
  return usageFromProviders(providers);
}

/** The window and each Settings page, light and dark, as PNGs in `dir`. */
async function shoot(dir: string, settings: SettingsStore) {
  mkdirSync(dir, { recursive: true });
  // The Models page twice: a new install (T3's default, the nudge) and with a sample of chosen
  // values (test/fixtures/shoot-jobs.json).
  // Your share twice too: a new install (nothing kept) and a sample share
  // (test/fixtures/shoot-shares.json).
  const chosen = checkJobs(fixture('shoot-jobs.json'))!;
  const shares = checkShares(fixture('shoot-shares.json'))!;
  const states: [string, string, boolean?][] = [
    ['window', ''],
    ['settings-name', 'settings=name'],
    ['settings-models', 'settings=models'],
    ['settings-models-chosen', 'settings=models', true],
    ['settings-share', 'settings=share'],
    ['settings-share-kept', 'settings=share', true],
    ['settings-display', 'settings=display'],
    ['settings-machine', 'settings=machine'],
    ['settings-search', 'q=windos'],
  ];
  const win = openWindow(false);
  win.setContentSize(1440, 900);
  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme;
    for (const [name, hash, withChoices] of states) {
      await settings.set({ jobs: withChoices ? chosen : DEFAULT_JOBS, shares: withChoices ? shares : {} });
      // The same address again would keep the page (and the view it holds): load it fresh.
      await win.loadURL('about:blank');
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

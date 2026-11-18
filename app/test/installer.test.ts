// The Windows installer (#164): electron-builder's NSIS installer, built by CI on a version tag
// (.github/workflows/release.yml). These check what it's told to build; the build itself runs in
// CI and was installed and uninstalled by hand (docs/app.md, The installer).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { LOGON_ENTRY } from '../src/platform/platform.ts';

const app = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(app, path), 'utf8');
const pkg = JSON.parse(read('package.json'));
const config = JSON.parse(read('electron-builder.json'));

test('the installer is per user, puts the app in the Start menu and starts it when done', () => {
  expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
  expect(config.nsis).toMatchObject({
    oneClick: true, perMachine: false, runAfterFinish: true, createStartMenuShortcut: true,
    shortcutName: 'Queue runner',
  });
});

test('the installed app keeps the state folder where the unpackaged one does', () => {
  // Electron's userData is %APPDATA%\<productName>: machine.json and the state folder live there.
  expect(pkg.productName).toBe('Queue runner');
  expect(config.productName ?? pkg.productName).toBe('Queue runner');
  expect(config.nsis.deleteAppDataOnUninstall).toBe(false);
});

test('uninstalling removes the logon entry, but not when an update reinstalls', () => {
  const script = read(config.nsis.include);
  const removal = `DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${LOGON_ENTRY}"`;
  const uninstall = script.slice(script.indexOf('!macro customUnInstall'));
  expect(uninstall.slice(0, uninstall.indexOf('!macroend'))).toMatch(
    new RegExp(`\\$\\{ifNot\\} \\$\\{isUpdated\\}\\s+${removal.replace(/[\\$.*+?()[\]{}|]/g, '\\$&')}\\s+\\$\\{endIf\\}`),
  );
});

test('the package holds the bundles and the icons, and no node_modules', () => {
  // Everything the window and the main process need is bundled into desktop-dist (esbuild and
  // Vite), so the app has no runtime dependencies to ship.
  expect(pkg.dependencies ?? {}).toEqual({});
  expect(config.files).toEqual(['desktop-dist/**', 'desktop/**', 'package.json']);
  expect(existsSync(join(app, config.win.icon))).toBe(true);
});

test('the release notes say the installer is unsigned and what SmartScreen shows', () => {
  const notes = read('release-notes.md');
  expect(notes).toContain('not signed');
  expect(notes).toContain('Windows protected your PC');
  expect(notes).toContain('More info');
  expect(notes).toContain('Run anyway');
});

test('a version tag builds the installer on Windows and attaches it to the release', () => {
  const workflow = readFileSync(join(app, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  expect(workflow).toMatch(/tags: \['v\*'\]/);
  expect(workflow).toContain('runs-on: windows-latest');
  expect(workflow).toContain('pnpm installer');
  expect(workflow).toMatch(/gh release (create|upload)/);
  expect(workflow).toContain('--notes-file app/release-notes.md');
});

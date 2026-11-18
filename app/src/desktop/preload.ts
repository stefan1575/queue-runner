// The window's one door to the main process (`window.runner`, see bridge.ts). Bundled to CommonJS,
// as Electron's sandboxed preload scripts are.
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type Bridge } from './bridge.ts';

const bridge: Bridge = {
  view: () => ipcRenderer.invoke(CHANNELS.view),
  set: (patch) => ipcRenderer.invoke(CHANNELS.set, patch),
  repo: (action) => ipcRenderer.invoke(CHANNELS.repo, action),
  onView: (listener) => {
    const on = (_: unknown, view: any) => listener(view);
    ipcRenderer.on(CHANNELS.changed, on);
    return () => { ipcRenderer.off(CHANNELS.changed, on); };
  },
};
contextBridge.exposeInMainWorld('runner', bridge);

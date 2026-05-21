/* Crouton — preload for the menu-bar popover */
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
};

contextBridge.exposeInMainWorld('crouton', {
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickVault: () => ipcRenderer.invoke('vault:pick'),

  startSession: (opts) => ipcRenderer.invoke('session:start', opts || {}),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  sessionState: () => ipcRenderer.invoke('session:state'),

  openNote: (p) => ipcRenderer.invoke('note:open', p),
  revealNote: (p) => ipcRenderer.invoke('note:reveal', p),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  ensureModel: (k) => ipcRenderer.invoke('whisper:ensure-model', k),

  onSessionState: (cb) => on('session:state', cb),
  onChunk: (cb) => on('session:chunk', cb),
  onSummaryStatus: (cb) => on('session:summary-status', cb),
  onWhisperProgress: (cb) => on('whisper:progress', cb),
});

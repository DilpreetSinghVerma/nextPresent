/**
 * electron/laser-preload.js
 * Exposes safe display capture capabilities to the laser & optical magnifier overlay.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronScreen', {
  getPrimaryScreenId: () => ipcRenderer.invoke('get-primary-screen-id')
});

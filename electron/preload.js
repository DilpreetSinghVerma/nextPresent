/**
 * electron/preload.js
 * Exposes safe Electron APIs to the renderer (dashboard WebView).
 * Uses contextBridge so the renderer never gets full Node.js access.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Opens a URL in the user's default system browser.
   * Used by auth.js to open the Google Sign-In page.
   */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});

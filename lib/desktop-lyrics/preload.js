const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ncmDesktop', {
  onUpdate(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('ncm:update', handler);
    return () => ipcRenderer.removeListener('ncm:update', handler);
  },
  onHover(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('ncm:hover', handler);
    return () => ipcRenderer.removeListener('ncm:hover', handler);
  },
  lock(next) { return ipcRenderer.invoke('ncm:lock', Boolean(next)); },
  interactive(next) { return ipcRenderer.invoke('ncm:interactive', Boolean(next)); },
  control(action) { return ipcRenderer.invoke('ncm:control', String(action)); },
  close() { return ipcRenderer.invoke('ncm:close'); },
  config() { return ipcRenderer.invoke('ncm:config'); },
});

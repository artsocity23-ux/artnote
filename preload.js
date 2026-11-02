const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('artnote', {
  // editor
  image: () => ipcRenderer.invoke('artnote:image'),
  copy: png => ipcRenderer.invoke('artnote:copy', png),
  save: note => ipcRenderer.invoke('artnote:save', note),
  close: () => ipcRenderer.send('artnote:close'),
  // region picker
  onShot: cb => ipcRenderer.on('artnote:shot', (e, jpeg) => cb(jpeg)),
  shotReady: () => ipcRenderer.send('artnote:shot-ready'),
  select: rect => ipcRenderer.send('artnote:select', rect),
  cancel: () => ipcRenderer.send('artnote:cancel'),
  // donate window
  donate: () => ipcRenderer.invoke('artnote:donate'),
  donateCopy: i => ipcRenderer.invoke('artnote:donate-copy', i),
  donateOpen: i => ipcRenderer.send('artnote:donate-open', i),
  donateReady: height => ipcRenderer.send('artnote:donate-ready', height),
});

/* Meow-PDF 데스크톱 앱 ↔ 편집 화면 연결 (window.meowDesktop) */
const { contextBridge, ipcRenderer } = require('electron');
let info = { version: '', platform: process.platform, arch: process.arch, autoUpdate: false };
try { info = Object.assign(info, ipcRenderer.sendSync('meow:info') || {}); } catch (e) { /* 무시 */ }
contextBridge.exposeInMainWorld('meowDesktop', {
  isDesktop: true,
  version: info.version,
  platform: info.platform,
  arch: info.arch,
  autoUpdate: !!info.autoUpdate,
  openExternal: url => ipcRenderer.send('meow:open-external', String(url || '')),
  update: {
    start: () => ipcRenderer.invoke('meow:update-start'),
    install: () => ipcRenderer.send('meow:update-install'),
    onStatus: cb => { if (typeof cb === 'function') ipcRenderer.on('meow:update-status', (e, st) => { try { cb(st); } catch (er) { /* 무시 */ } }); }
  }
});

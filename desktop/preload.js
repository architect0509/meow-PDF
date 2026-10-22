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
  setLang: l => ipcRenderer.send('meow:lang', String(l || '')),   // v1.0.3 닫기 확인 창 언어
  files: {   // v1.0.2 연결 프로그램으로 연 파일
    take: () => ipcRenderer.invoke('meow:take-files'),
    onOpen: cb => { if (typeof cb === 'function') ipcRenderer.on('meow:open-files', (e, list) => { try { cb(list); } catch (er) { /* 무시 */ } }); }
  },
  assoc: {   // v1.0.2 기본 연결 프로그램
    status: () => ipcRenderer.invoke('meow:assoc-status'),
    open: () => ipcRenderer.invoke('meow:assoc-open')
  },
  print: {   // v1.0.6 인쇄 창에서 고른 프린터로 바로 인쇄
    printers: () => ipcRenderer.invoke('meow:printers'),
    run: o => ipcRenderer.invoke('meow:print', o || {})
  },
  onFocus: cb => { if (typeof cb === 'function') ipcRenderer.on('meow:focus', () => { try { cb(); } catch (er) { /* 무시 */ } }); },
  update: {
    start: () => ipcRenderer.invoke('meow:update-start'),
    install: () => ipcRenderer.send('meow:update-install'),
    onStatus: cb => { if (typeof cb === 'function') ipcRenderer.on('meow:update-status', (e, st) => { try { cb(st); } catch (er) { /* 무시 */ } }); }
  }
});

/* Meow-PDF 데스크톱 앱 (Windows · macOS · Linux)
   · 실행하면 소개 페이지를 건너뛰고 바로 편집 화면(https://www.meow-pdf.com/edit)을 열어요.
   · 편집 화면 파일은 앱 안에 함께 넣은 그 버전(app/ 폴더 = 사이트의 public/)을 써요. 그래서 인터넷이 없어도 열리고,
     버전도 설치한 앱 버전 그대로예요. 주소는 사이트와 같아서 로그인 · 결제 · 번역 · 공유작업 같은 서버 기능은 그대로 동작해요.
   · 앱 안에 없는 주소(/api, /payment, version.json, 다른 사이트 …)는 진짜 인터넷으로 보내요.
   · 업데이트: Windows(설치판) · Linux(AppImage)는 electron-updater 로 내려받아 다시 시작하며 설치하고,
     macOS 등은 다운로드 페이지를 열어요. */
const { app, BrowserWindow, net, shell, ipcMain, session, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const SITE = 'https://www.meow-pdf.com';
const START = SITE + '/edit';
const HOSTS = new Set(['www.meow-pdf.com', 'meow-pdf.com']);
const APP_DIR = path.join(__dirname, 'app');
const NET_ONLY = /^\/(api|payment|download|auth)(\/|$)|^\/version\.json$/;   // 늘 인터넷에서 받아요
const RELEASES = 'https://github.com/architect0509/meow-PDF/releases/latest';   // v1.0.2 자동 업데이트가 안 되면 릴리스 페이지를 열어요 (설치 파일 주소는 아직 없을 수 있어서)
const DOWNLOAD = { win32: RELEASES, darwin: SITE + '/download/mac', linux: RELEASES };
const STAY_HOSTS = /(^|\.)(meow-pdf\.com|tosspayments\.com|toss\.im)$/;   // 앱 창 안에서 열어 둘 주소 (결제 화면은 끝나면 돌아와요)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm' };

if (!app.requestSingleInstanceLock()) { app.quit(); }

/* ── v1.0.2 파일 열기: PDF · MPDF 등을 두 번 누르거나(연결 프로그램) 앱 아이콘에 끌어 놓으면 편집 화면에서 열어요 ── */
const OPEN_EXT = /\.(pdf|mpdf|zip|pptx|hwpx?|docx|png|jpe?g|webp|gif|bmp)$/i;
const MAX_OPEN = 600 * 1024 * 1024;
let pendingFiles = [], rendererReady = false;
function filesFromArgv(argv) {
  return (argv || []).slice(1).filter(a => a && !a.startsWith('-') && OPEN_EXT.test(a)).filter(a => { try { return fs.statSync(a).isFile(); } catch (e) { return false; } });
}
async function readForRenderer(paths) {
  const out = [];
  for (const f of paths) {
    try { const st = await fs.promises.stat(f); if (st.size > MAX_OPEN) continue; out.push({ name: path.basename(f), path: f, data: new Uint8Array(await fs.promises.readFile(f)) }); } catch (e) { /* 읽지 못한 파일은 건너뛰어요 */ }
  }
  return out;
}
async function queueFiles(paths) {
  if (!paths.length) return;
  if (!rendererReady || !mainWin || mainWin.isDestroyed()) { pendingFiles.push(...paths); return; }
  const list = await readForRenderer(paths);
  if (list.length) { try { mainWin.webContents.send('meow:open-files', list); } catch (e) { /* 무시 */ } }
  if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus();
}
pendingFiles = filesFromArgv(process.argv);
app.on('open-file', (e, f) => { e.preventDefault(); queueFiles([f]); });   // macOS: Finder에서 열기
ipcMain.handle('meow:take-files', async () => { rendererReady = true; const p = pendingFiles; pendingFiles = []; return readForRenderer(p); });

/* ── v1.0.2 기본 연결 프로그램: 지금 PDF를 Meow-PDF가 여는지 확인하고, 설정 화면을 열어요 ── */
const run = (cmd, args, ms) => new Promise(res => { try { execFile(cmd, args, { timeout: ms || 4000, windowsHide: true }, (err, out) => res(err ? '' : String(out || ''))); } catch (e) { res(''); } });
async function winProgId(ext) {
  const uc = await run('reg', ['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`, '/v', 'ProgId']);
  let m = /ProgId\s+REG_SZ\s+(.+)/i.exec(uc); if (m) return m[1].trim();
  const cl = await run('reg', ['query', `HKCR\\${ext}`, '/ve']);
  m = /REG_SZ\s+(.+)/i.exec(cl); return m ? m[1].trim() : '';
}
async function macDefaultApp(ext) {
  const tmp = path.join(os.tmpdir(), 'meow-check' + ext);
  try { if (!fs.existsSync(tmp)) fs.writeFileSync(tmp, ext === '.pdf' ? '%PDF-1.4\n%%EOF\n' : 'PK'); } catch (e) { return ''; }
  const js = `ObjC.import('AppKit'); var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(${JSON.stringify(tmp)})); u ? ObjC.unwrap(u.path) : ''`;
  return (await run('osascript', ['-l', 'JavaScript', '-e', js], 5000)).trim();
}
async function assocStatus() {
  if (!app.isPackaged) return { supported: false, reason: 'dev' };
  if (process.platform === 'win32') {
    const [pdf, mpdf] = await Promise.all([winProgId('.pdf'), winProgId('.mpdf')]);
    return { supported: true, platform: 'win32', isDefault: /meow/i.test(pdf), pdf, mpdfOk: /meow/i.test(mpdf) };
  }
  if (process.platform === 'darwin') {
    const a = await macDefaultApp('.pdf'), mine = (process.execPath.split('/Contents/')[0] || '');
    return { supported: true, platform: 'darwin', isDefault: a ? a === mine || /Meow-PDF\.app$/i.test(a) : null, pdf: a };
  }
  return { supported: false, platform: process.platform };   // Linux AppImage 는 파일 연결을 등록하지 않아요
}
ipcMain.handle('meow:assoc-status', () => assocStatus());
ipcMain.handle('meow:assoc-open', async () => {
  if (process.platform === 'win32') {
    try { await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Meow-PDF'); } catch (e) { try { await shell.openExternal('ms-settings:defaultapps'); } catch (er) { return { state: 'error' }; } }
    return { state: 'settings' };
  }
  if (process.platform === 'darwin') return { state: 'guide' };
  return { state: 'unsupported' };
});

/* 앱 안에 넣은 파일 찾기 (사이트의 cleanUrls 처럼 /edit → edit.html) */
function localFile(pathname) {
  let p; try { p = decodeURIComponent(pathname); } catch (e) { return null; }
  if (p.includes('\0')) return null;
  const cand = p === '/' ? ['index.html'] : [p, p + '.html', path.posix.join(p, 'index.html')];
  for (const c of cand) {
    const f = path.normalize(path.join(APP_DIR, c));
    if (!f.startsWith(APP_DIR + path.sep)) continue;
    try { if (fs.statSync(f).isFile()) return f; } catch (e) { /* 없음 */ }
  }
  return null;
}

function vendorFile(u) {
  const f = path.normalize(path.join(APP_DIR, 'vendor', u.hostname, ...u.pathname.split('/').filter(Boolean).map(x => { try { return decodeURIComponent(x); } catch (e) { return x; } })));
  if (!f.startsWith(path.join(APP_DIR, 'vendor') + path.sep)) return null;
  try { return fs.statSync(f).isFile() ? f : null; } catch (e) { return null; }
}
function serveLocal() {
  session.defaultSession.protocol.handle('https', async req => {
    try {
      const u = new URL(req.url);
      if (!HOSTS.has(u.hostname) && req.method === 'GET') {   // 함께 넣은 라이브러리 (pdf.js · pdf-lib · jszip · supabase)
        const f = vendorFile(u);
        if (f) return new Response(fs.readFileSync(f), { status: 200, headers: { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'max-age=31536000' } });
      }
      if (HOSTS.has(u.hostname) && (req.method === 'GET' || req.method === 'HEAD') && !NET_ONLY.test(u.pathname)) {
        const f = localFile(u.pathname);
        if (f) return new Response(req.method === 'HEAD' ? null : fs.readFileSync(f), { status: 200, headers: { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' } });
      }
    } catch (e) { /* 아래에서 인터넷으로 */ }
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
}

/* 창 크기 · 위치 기억 */
const STATE_FILE = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() { try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch (e) { return null; } }
function saveBounds(win) { try { const b = win.getNormalBounds(); fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...b, max: win.isMaximized() })); } catch (e) { /* 무시 */ } }

const ICON = path.join(__dirname, 'build', 'icon.png');
/* v1.0.3 닫기 확인 창 문구 — 편집 화면의 언어(설정 › 언어)를 따라요 */
const CLOSE_TXT = {
  ko: { message: '저장하지 않은 변경 사항이 있어요.', detail: '저장하지 않고 닫으면 바뀐 내용이 사라져요. 그래도 닫을까요?', close: '저장하지 않고 닫기', cancel: '취소' },
  en: { message: 'You have unsaved changes.', detail: 'If you close without saving, your changes will be lost. Close anyway?', close: "Close without saving", cancel: 'Cancel' },
  ja: { message: '保存していない変更があります。', detail: '保存せずに閉じると変更内容は失われます。閉じますか？', close: '保存せずに閉じる', cancel: 'キャンセル' },
  zh: { message: '有尚未保存的更改。', detail: '不保存就关闭，更改将会丢失。仍要关闭吗？', close: '不保存并关闭', cancel: '取消' }
};
let uiLang = 'ko';
ipcMain.on('meow:lang', (e, l) => { l = String(l || ''); if (CLOSE_TXT[l]) uiLang = l; });
let mainWin = null;

function openExternal(url) {
  try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') shell.openExternal(u.href); } catch (e) { /* 무시 */ }
}

function makeWindow(url) {
  const st = loadBounds();
  const win = new BrowserWindow({
    width: (st && st.width) || 1400, height: (st && st.height) || 900, x: st ? st.x : undefined, y: st ? st.y : undefined,
    minWidth: 760, minHeight: 520, backgroundColor: '#0e0e11', title: 'Meow-PDF', show: false, autoHideMenuBar: true,
    icon: fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  if (st && st.max) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', () => saveBounds(win));
  /* v1.0.3 저장하지 않은 채 X를 누르면 확인 창을 띄워요
     (편집 화면이 beforeunload 로 닫기를 막으면 Electron 은 아무 알림 없이 창을 그대로 두기 때문이에요) */
  win.webContents.on('will-prevent-unload', e => {
    const T = CLOSE_TXT[uiLang] || CLOSE_TXT.ko;
    const r = dialog.showMessageBoxSync(win, { type: 'warning', title: 'Meow-PDF', message: T.message, detail: T.detail, buttons: [T.close, T.cancel], defaultId: 1, cancelId: 1, noLink: true });
    if (r === 0) e.preventDefault();   // preventDefault = 막은 것을 무시하고 닫기
  });
  /* 새 창: 우리 사이트는 앱 창으로, 다른 사이트는 기본 브라우저로 */
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    try { const h = new URL(u).hostname; if (HOSTS.has(h)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#0e0e11', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } } }; } catch (e) { /* 무시 */ }
    if (u && u !== 'about:blank') openExternal(u);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, u) => {
    try { const x = new URL(u); if ((x.protocol === 'https:' || x.protocol === 'http:') && STAY_HOSTS.test(x.hostname)) return; } catch (er) { /* 무시 */ }
    if (/^(blob|data):/.test(u)) return;
    e.preventDefault(); openExternal(u);
  });
  win.loadURL(url || START);
  return win;
}

/* ── 업데이트 ── */
let updater = null, updWired = false;
function canAutoUpdate() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return true;
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  return false;   // macOS: 서명하지 않은 앱은 자동 업데이트가 안 돼서 다운로드 페이지를 열어요
}
function getUpdater() {
  if (updater) return updater;
  try { updater = require('electron-updater').autoUpdater; } catch (e) { updater = null; return null; }
  updater.autoDownload = true; updater.autoInstallOnAppQuit = true; updater.allowPrerelease = false;
  return updater;
}
function sendStatus(st) { for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('meow:update-status', st); } catch (e) { /* 무시 */ } } }
function wireUpdater(u) {
  if (updWired) return; updWired = true;
  u.on('checking-for-update', () => sendStatus({ state: 'checking' }));
  u.on('update-available', i => sendStatus({ state: 'downloading', percent: 0, version: i && i.version }));
  u.on('update-not-available', () => sendStatus({ state: 'none' }));
  u.on('download-progress', p => sendStatus({ state: 'downloading', percent: p && p.percent || 0 }));
  u.on('update-downloaded', i => sendStatus({ state: 'ready', version: i && i.version }));
  u.on('error', e => sendStatus({ state: 'error', message: String(e && e.message || e) }));
}

ipcMain.on('meow:info', e => { e.returnValue = { version: app.getVersion(), platform: process.platform, arch: process.arch, autoUpdate: canAutoUpdate() }; });
ipcMain.on('meow:open-external', (e, url) => openExternal(String(url || '')));
ipcMain.handle('meow:update-start', async () => {
  const u = canAutoUpdate() ? getUpdater() : null;
  if (!u) { openExternal(DOWNLOAD[process.platform] || SITE + '/#download'); return { state: 'external' }; }
  wireUpdater(u);
  try { await u.checkForUpdates(); return { state: 'checking' }; }   // 이후 상태는 meow:update-status 로 알려요
  catch (e) { openExternal(DOWNLOAD[process.platform] || SITE + '/#download'); return { state: 'external' }; }
});
ipcMain.on('meow:update-install', () => { const u = getUpdater(); if (u) setImmediate(() => u.quitAndInstall(false, true)); });

/* macOS 는 메뉴가 있어야 복사 · 붙여넣기 단축키가 동작해요 */
function setMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
}

app.on('second-instance', (e, argv) => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } queueFiles(filesFromArgv(argv)); });
app.on('browser-window-focus', (e, w) => { try { w.webContents.send('meow:focus'); } catch (er) { /* 무시 */ } });   // 설정을 바꾸고 돌아오면 다시 확인
app.whenReady().then(async () => {
  try { await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }); } catch (e) { /* 무시 */ }   // 웹용 오프라인 캐시가 앱 파일을 가리지 않게
  serveLocal(); setMenu();
  mainWin = makeWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) mainWin = makeWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

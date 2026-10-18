/* 빌드 전에: 사이트 파일(../public)을 app/ 으로 복사하고, 앱 버전을 편집 화면의 APP_VERSION 에 맞춰요. */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), SRC = path.join(ROOT, '..', 'public'), DST = path.join(ROOT, 'app');
const SKIP = new Set(['t.html', 'vercel.json', 'sw.js']);   // 시험용 · 사이트 설정 · 웹 오프라인 캐시는 넣지 않아요
fs.rmSync(DST, { recursive: true, force: true });
(function copy(a, b) {
  fs.mkdirSync(b, { recursive: true });
  for (const n of fs.readdirSync(a)) {
    if (SKIP.has(n) || n.startsWith('.')) continue;
    const s = path.join(a, n), d = path.join(b, n);
    if (fs.statSync(s).isDirectory()) copy(s, d); else fs.copyFileSync(s, d);
  }
})(SRC, DST);
const html = fs.readFileSync(path.join(SRC, 'edit.html'), 'utf8');
const v = (/const APP_VERSION = 'v?([^']+)'/.exec(html) || [])[1];
if (!v) throw new Error('edit.html 에서 APP_VERSION 을 찾지 못했어요');
const pj = path.join(ROOT, 'package.json'), pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
if (pkg.version !== v) { pkg.version = v; fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + '\n'); console.log('앱 버전 →', v); }
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? String(process.env.GITHUB_REF_NAME || '') : '';
if (tag && tag.replace(/^v/, '') !== v) { console.error(`태그(${tag})와 APP_VERSION(v${v})이 달라요. 같은 버전으로 태그를 만들어 주세요.`); process.exit(1); }
/* 인터넷이 없어도 PDF를 열 수 있게, 편집 화면이 쓰는 라이브러리(CDN)를 app/vendor/<주소> 에 함께 넣어요 */
(async () => {
  const sw = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');
  const urls = [...new Set((sw.match(/'https:\/\/[^']+'/g) || []).map(x => x.slice(1, -1)))];
  let ok = 0;
  for (const u of urls) {
    try {
      const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status);
      const x = new URL(u), f = path.join(DST, 'vendor', x.hostname, ...x.pathname.split('/').filter(Boolean));
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); ok++;
    } catch (e) { console.warn('라이브러리를 받지 못했어요 (앱은 인터넷에서 받아요):', u, e.message); }
  }
  console.log(`app/ 준비 완료 (Meow-PDF v${v}, 라이브러리 ${ok}/${urls.length}개)`);
})();

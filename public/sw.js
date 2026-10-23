/* Meow-PDF 서비스 워커 (v1.1.3)
   · 한 번 열어 본 편집기와 PDF · 압축 · 글꼴 라이브러리를 브라우저에 저장해 두고, 인터넷이 끊겨도 편집기를 열어 작업할 수 있게 해요.
   · 페이지(HTML)는 인터넷 우선 — 연결되면 항상 최신 버전, 끊기면 저장해 둔 버전을 보여줘요.
   · 라이브러리 · 글꼴 · 이미지는 저장해 둔 것을 먼저 쓰고, 뒤에서 새로 받아 둬요.
   · 로그인 · 결제 · 공유작업(Supabase · 결제 서버) 요청은 저장하지 않아요. */
const VER = 'meow-v1.1.3';
const CORE = [
  '/edit',
  '/',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'
];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
const NEVER = /supabase\.co|onrender\.com|tosspayments|\/api\/|\/version\.json|googlesyndication|doubleclick|googleadservices|adtrafficquality|google\.com\/(pagead|adsense)/;   // 광고는 저장하지 않아요

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VER);
    await Promise.all(CORE.map(async u => { try { const r = await fetch(u, { mode: u.startsWith('http') ? 'cors' : 'same-origin', cache: 'reload' }); if (r.ok) await c.put(u, r); } catch (er) { /* 다음에 다시 */ } }));
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VER && k.startsWith('meow-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (NEVER.test(req.url) || url.protocol === 'chrome-extension:') return;
  const same = url.origin === self.location.origin;

  /* 페이지: 인터넷 우선 → 끊기면 저장본 */
  if (req.mode === 'navigate' || (same && (req.headers.get('accept') || '').includes('text/html'))) {
    const key = /^\/edit(\.html)?\/?$/.test(url.pathname) ? '/edit' : url.pathname === '/' || url.pathname === '/index.html' ? '/' : url.pathname;
    e.respondWith((async () => {
      const c = await caches.open(VER);
      try {
        const r = await withTimeout(fetch(req), 5000);
        if (r.ok) c.put(key, r.clone());
        return r;
      } catch (er) {
        return (await c.match(key)) || (await c.match('/edit')) || (await c.match('/')) || new Response('<meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">인터넷에 연결되어 있지 않아요. 한 번이라도 온라인에서 편집기를 열면 다음부터는 오프라인에서도 열 수 있어요.</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  /* 라이브러리 · 글꼴 · 같은 사이트의 파일: 저장본 먼저, 뒤에서 새로 받기 */
  if (CDN.test(req.url) || same) {
    e.respondWith((async () => {
      const c = await caches.open(VER);
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      const r = await net;
      return r || new Response('', { status: 504, statusText: 'offline' });
    })());
  }
});

/* Meow-PDF 쿠키 선택 배너 (v1.0)
   · 처음 방문하면 화면 아래에 배너를 띄우고, ‘필수만 허용’ / ‘모두 허용’ 중 고른 값을 localStorage 'meowCookie'에 기억해요.
   · 고르기 전이거나 ‘필수만 허용’이면 광고는 맞춤형이 아닌 광고만 요청해요 (각 페이지 <head>의 adsbygoogle.requestNonPersonalizedAds).
   · 두 버튼은 같은 모양 · 같은 크기예요 (한쪽으로 유도하지 않아요).
   · [data-cookie-settings] 링크 · 버튼을 누르면 언제든 다시 고를 수 있어요. window.meowConsent.get() / .open() */
(function () {
  if (window.meowConsent) return;
  var KEY = 'meowCookie';
  var T = {
    ko: { t: '쿠키 사용 안내', d: '설정 · 로그인 유지용 저장소와 광고(Google AdSense) 쿠키를 써요. 맞춤형 광고는 ‘모두 허용’일 때만 나오며, 어느 쪽이든 기능은 같아요.', p: '쿠키정책', e: '필수만 허용', a: '모두 허용', s: '선택을 저장했어요. 다음 페이지부터 적용돼요.' },
    en: { t: 'About cookies', d: 'Meow-PDF uses storage needed for settings and sign-in, plus cookies for ads (Google AdSense). Personalized ads are shown only if you choose “Allow all”. Every feature works the same either way.', p: 'Cookie policy', e: 'Essential only', a: 'Allow all', s: 'Saved. It applies from the next page.' },
    ja: { t: 'Cookieについて', d: 'Meow-PDFは設定・ログイン維持に必要なストレージと、広告(Google AdSense)用のCookieを使用します。パーソナライズ広告は「すべて許可」を選んだ場合のみ表示されます。どちらを選んでもすべての機能を同じように使えます。', p: 'Cookieポリシー', e: '必須のみ許可', a: 'すべて許可', s: '保存しました。次のページから適用されます。' },
    zh: { t: '关于 Cookie', d: 'Meow-PDF 使用保存设置和登录状态所需的存储，以及广告（Google AdSense）Cookie。只有选择“全部允许”时才会显示个性化广告。无论选择哪一项，所有功能都可以同样使用。', p: 'Cookie 政策', e: '仅必要', a: '全部允许', s: '已保存，将从下一页开始生效。' }
  };
  function lang() {
    var v = null; try { v = localStorage.getItem('meowLang'); } catch (e) { /* 무시 */ }
    return T[v] ? v : 'ko';
  }
  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function set(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* 무시 */ }
    try { (window.adsbygoogle = window.adsbygoogle || []).requestNonPersonalizedAds = v === 'all' ? 0 : 1; } catch (e) { /* 무시 */ }
  }

  var css = '#meowCk{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:min(340px,calc(100% - 24px));box-sizing:border-box;padding:12px 14px;border-radius:14px;border:1px solid rgba(255,255,255,.16);background:#18181d;color:#f4f4f5;box-shadow:0 8px 28px rgba(0,0,0,.45);font:12.5px/1.55 "Pretendard","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;word-break:keep-all;animation:meowCkIn .35s cubic-bezier(.2,.8,.2,1)}' +
    '@keyframes meowCkIn{from{opacity:0;transform:translateY(12px)}}' +
    '#meowCk h2{margin:0 0 3px;font-size:13px;font-weight:700;color:inherit}' +
    '#meowCk p{margin:0;color:#d4d4d8}' +
    '#meowCk a{color:inherit;text-decoration:underline;text-underline-offset:3px}' +
    '#meowCk .ckb{display:flex;gap:6px;margin-top:10px}' +
    '#meowCk button{flex:1 1 0;min-height:36px;padding:0 10px;border-radius:999px;border:1px solid #f4f4f5;background:#f4f4f5;color:#111;font:inherit;font-weight:700;cursor:pointer}' +
    '#meowCk button:hover{filter:brightness(.92)}' +
    '#meowCk button:focus-visible,#meowCk a:focus-visible{outline:2px solid #dbbe43;outline-offset:3px}' +
    '#meowCk .ckmsg{margin-top:6px;font-size:12px;color:#dbbe43}' +
    '@media (max-width:480px){#meowCk{right:12px;bottom:12px}}' +
    '@media (prefers-reduced-motion:reduce){#meowCk{animation:none}}' +
    '@media (prefers-color-scheme:light){#meowCk{background:#ffffff;color:#18181b;border-color:rgba(0,0,0,.14);box-shadow:0 8px 28px rgba(0,0,0,.18)}#meowCk p{color:#3f3f46}#meowCk button{background:#18181b;color:#fff;border-color:#18181b}#meowCk .ckmsg{color:#6b5a08}}' +
    '@media print{#meowCk{display:none!important}}';

  var box = null, lastFocus = null;
  function close() { if (box) { box.remove(); box = null; } if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* 무시 */ } } lastFocus = null; }
  function open(fromUser) {
    if (box) { var b0 = box.querySelector('button'); if (b0) b0.focus(); return; }
    if (!document.getElementById('meowCkCss')) { var st = document.createElement('style'); st.id = 'meowCkCss'; st.textContent = css; document.head.appendChild(st); }
    var L = T[lang()], cur = get();
    box = document.createElement('section');
    box.id = 'meowCk';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-labelledby', 'meowCkT');
    box.setAttribute('lang', lang());
    box.innerHTML = '<h2 id="meowCkT"></h2><p><span class="ckd"></span> <a href="/cookies"></a></p><div class="ckb"><button type="button" data-v="essential"></button><button type="button" data-v="all"></button></div>';
    box.querySelector('h2').textContent = L.t;
    box.querySelector('.ckd').textContent = L.d;
    box.querySelector('a').textContent = L.p;
    var bs = box.querySelectorAll('button');
    bs[0].textContent = L.e; bs[1].textContent = L.a;
    if (cur) bs[cur === 'all' ? 1 : 0].setAttribute('aria-pressed', 'true');
    box.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button[data-v]'); if (!b) return;
      var prev = get(); set(b.getAttribute('data-v'));
      if (prev && prev !== b.getAttribute('data-v')) {   // 이미 떠 있는 광고에는 바로 적용되지 않으니 알려 줘요
        var m = document.createElement('p'); m.className = 'ckmsg'; m.setAttribute('role', 'status'); m.textContent = L.s; box.appendChild(m);
        bs[0].disabled = bs[1].disabled = true; setTimeout(close, 1600);
      } else close();
    });
    box.addEventListener('keydown', function (e) { if (e.key === 'Escape' && get()) close(); });
    document.body.appendChild(box);
    if (fromUser) { lastFocus = document.activeElement; bs[0].focus(); }
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-cookie-settings]');
    if (!t) return;
    e.preventDefault(); open(true);
  });
  window.meowConsent = { get: get, open: function () { open(true); } };
  function boot() {
    if (get()) return;
    if (document.documentElement.classList.contains('th-intro')) document.addEventListener('thaniyaintroend', function () { open(false); }, { once: true });   // 첫 화면 로고 인트로가 끝난 뒤에 띄워요
    else open(false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

'use strict';
/**
 * Meow-PDF 결제 서버
 *  - 토스페이먼츠 결제위젯(팝업) 제공 + 결제 승인(시크릿 키는 이 서버에만 존재)
 *  - 승인 성공 시 Supabase users_profile.is_paid = true 로 프리미엄 권한 부여
 *
 * 흐름
 *  1) 앱: POST /api/create-order  (Authorization: Bearer <Supabase 로그인 토큰>)  → { payUrl }
 *  2) 앱: payUrl 을 작은 팝업으로 연다  → GET /pay (토스 결제위젯)
 *  3) 토스: 결제 성공 → GET /payment/success?paymentKey&orderId&amount
 *  4) 성공 페이지: POST /api/confirm-payment → 토스 승인 API → Supabase 권한 부여
 *  5) 앱: 팝업의 postMessage / 창 포커스 시 계정 상태를 다시 읽어 프리미엄 반영
 */
const _envPath = require('path').join(__dirname, '.env');
const _envRes = require('dotenv').config({ path: _envPath });   // 실행 위치와 상관없이 server.js 옆의 .env 를 읽어요
console.log(_envRes.error ? '⚠ .env 파일을 찾지 못했어요: ' + _envPath + '  (이름이 .env.txt 가 아닌지 확인하세요)' : '• .env 로드됨: ' + _envPath);
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

/* ─────────── 설정 (비밀 값은 전부 여기/환경변수에만 둡니다) ─────────── */
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const PRICE = 3900;                                   // 가격은 서버가 정해요. 클라이언트가 보낸 금액은 믿지 않아요.
const ORDER_NAME = 'Meow-PDF 프리미엄 이용권';

// 토스페이먼츠 — 기본값은 토스 공식 문서의 "테스트 키"입니다. 실결제 전에 반드시 .env 로 교체하세요.
const TOSS_CLIENT_KEY = process.env.TOSS_CLIENT_KEY || 'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm';
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || 'test_gsk_docs_OaPz8L5KdmQXkzRz3y47BMw6';
const TOSS_API = (process.env.TOSS_API_BASE || 'https://api.tosspayments.com').replace(/\/$/, '');
const TOSS_AUTH = 'Basic ' + Buffer.from(TOSS_SECRET_KEY + ':').toString('base64');

// Supabase
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://zlulpyfiiutqpywyjbbi.supabase.co').replace(/\/$/, '');
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_16WKhcpLorKuoTTA_SoZbQ_Oyxl-7sv';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';   // 필수 (없으면 결제를 시작하지 않아요)

const ORDER_SECRET = process.env.ORDER_SECRET || crypto.randomBytes(32).toString('hex');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const ready = () => !!SUPABASE_SERVICE_KEY;

/* ─────────── 유틸 ─────────── */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

// CORS: 앱(HTML 파일 / 다른 주소)에서 호출할 수 있게. 쿠키를 쓰지 않고 Bearer 토큰만 쓰므로 안전해요.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin) || origin === 'null')) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.length ? origin : '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 아주 단순한 IP별 요청 제한 (분당 30회)
const hits = new Map();
setInterval(() => hits.clear(), 60 * 1000).unref();
const limiter = (req, res, next) => {
  const ip = req.ip || 'x', n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
  if (n > 30) return res.status(429).json({ success: false, message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
  next();
};

const sign = s => crypto.createHmac('sha256', ORDER_SECRET).update(s).digest('hex').slice(0, 10);
const hex32 = uuid => String(uuid).replace(/-/g, '');
const unhex32 = h => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

/** 주문번호 = m_<사용자ID 32자>_<시각 base36>_<서명 10자> (토스 규칙: 6~64자, 영문/숫자/-/_) */
function makeOrderId(uid) {
  const u = hex32(uid), t = Date.now().toString(36);
  return `m_${u}_${t}_${sign(u + t)}`;
}
function parseOrderId(id) {
  const m = /^m_([0-9a-f]{32})_([0-9a-z]{6,10})_([0-9a-f]{10})$/.exec(String(id || ''));
  if (!m) return null;
  const [, u, t, sg] = m, good = sign(u + t);
  if (!crypto.timingSafeEqual(Buffer.from(sg), Buffer.from(good))) return null;
  return { uid: unhex32(u), ts: parseInt(t, 36) };
}

/** Supabase 로그인 토큰 검증 → 사용자 정보 */
async function userFromToken(token) {
  const r = await axios.get(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` }, timeout: 8000
  });
  return r.data;
}

const sbAdmin = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };

/** 프리미엄 권한 부여 — 서비스 키로만 가능 (is_paid 는 클라이언트가 못 바꿔요) */
async function grantPremium(uid, orderId, paymentKey) {
  const au = await axios.get(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, { headers: sbAdmin, timeout: 8000 });
  await axios.post(`${SUPABASE_URL}/rest/v1/users_profile?on_conflict=id`, {
    id: uid, email: au.data.email, is_paid: true, paid_at: new Date().toISOString(), last_order_id: orderId, last_payment_key: paymentKey
  }, { headers: { ...sbAdmin, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, timeout: 8000 });
}

async function cancelPayment(paymentKey, reason) {
  try {
    await axios.post(`${TOSS_API}/v1/payments/${encodeURIComponent(paymentKey)}/cancel`, { cancelReason: reason },
      { headers: { Authorization: TOSS_AUTH, 'Content-Type': 'application/json' }, timeout: 15000 });
    return true;
  } catch (e) { console.error('[결제취소 실패]', e.response?.data || e.message); return false; }
}

/* ─────────── API ─────────── */
app.get('/health', (req, res) => res.json({ ok: true, ready: ready(), testKeys: TOSS_SECRET_KEY.startsWith('test_') }));

// 1) 주문 만들기 — 로그인한 사용자만. 가격/주문명은 서버가 정해요.
app.post('/api/create-order', limiter, async (req, res) => {
  if (!ready()) return res.status(503).json({ success: false, message: '결제 서버 설정이 완료되지 않았습니다. (SUPABASE_SERVICE_ROLE_KEY)' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  try {
    const user = await userFromToken(token);
    if (!user || !user.id || !user.email_confirmed_at) { console.error('[결제 거부] 이메일 미인증 계정:', user && user.email); return res.status(401).json({ success: false, message: '이메일 인증이 완료된 계정만 결제할 수 있습니다.' }); }
    const orderId = makeOrderId(user.id);
    res.json({ success: true, orderId, payUrl: `${PUBLIC_BASE_URL}/pay?order=${encodeURIComponent(orderId)}` });
  } catch (e) {
    const st = e.response && e.response.status, d = e.response && e.response.data;
    console.error('[로그인 확인 실패] status=' + (st || e.code || '-') + ' ' + JSON.stringify(d || e.message));
    const why = st === 401 || st === 403 ? '로그인이 만료되었습니다. 로그아웃 후 다시 로그인해 주세요.'
      : (!st ? '서버가 Supabase에 연결하지 못했습니다. 인터넷 및 방화벽 설정을 확인해 주세요.' : '로그인 확인에 실패했습니다. (Supabase ' + st + ') .env 의 SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY 가 앱과 같은 프로젝트인지 확인하세요.');
    res.status(401).json({ success: false, message: why });
  }
});

// 결제 팝업이 위젯을 그리는 데 필요한 정보 (클라이언트 키는 공개 값)
app.get('/api/order-info', limiter, (req, res) => {
  const o = parseOrderId(req.query.order);
  if (!o || Date.now() - o.ts > 60 * 60 * 1000) return res.status(400).json({ success: false, message: '주문이 올바르지 않거나 만료되었습니다. 앱에서 결제를 다시 시작해 주세요.' });
  res.json({ success: true, clientKey: TOSS_CLIENT_KEY, customerKey: 'user_' + hex32(o.uid), amount: PRICE, orderName: ORDER_NAME });
});

// 2) 결제 승인 — 토스 승인 API 호출 후 권한 부여
app.post('/api/confirm-payment', limiter, async (req, res) => {
  const { paymentKey, orderId } = req.body || {};
  const amount = Number(req.body && req.body.amount);
  if (!ready()) return res.status(503).json({ success: false, message: '결제 서버 설정이 완료되지 않았습니다.' });
  const o = parseOrderId(orderId);
  if (!o || !paymentKey || typeof paymentKey !== 'string') return res.status(400).json({ success: false, message: '주문 정보가 올바르지 않습니다.' });
  if (amount !== PRICE) return res.status(400).json({ success: false, message: '결제 금액이 올바르지 않습니다.' });   // 금액 위변조 방지

  let payment;
  try {
    const r = await axios.post(`${TOSS_API}/v1/payments/confirm`, { paymentKey, orderId, amount: PRICE },
      { headers: { Authorization: TOSS_AUTH, 'Content-Type': 'application/json' }, timeout: 20000 });
    payment = r.data;
  } catch (e) {
    const d = e.response && e.response.data;
    if (d && d.code === 'ALREADY_PROCESSED_PAYMENT') {          // 성공 페이지를 새로고침한 경우: 이미 승인된 결제인지 조회
      try {
        const g = await axios.get(`${TOSS_API}/v1/payments/orders/${encodeURIComponent(orderId)}`, { headers: { Authorization: TOSS_AUTH }, timeout: 15000 });
        payment = g.data;
      } catch (e2) { return res.status(400).json({ success: false, message: '이미 처리된 결제입니다.' }); }
    } else return res.status(400).json({ success: false, code: d && d.code, message: (d && d.message) || '결제 승인에 실패했습니다.' });
  }

  if (!payment || payment.status !== 'DONE' || Number(payment.totalAmount) !== PRICE || payment.orderId !== orderId) {
    return res.status(400).json({ success: false, message: '결제 상태를 확인할 수 없습니다.' });
  }
  try {
    await grantPremium(o.uid, orderId, payment.paymentKey || paymentKey);
  } catch (e) {
    console.error('[권한 부여 실패]', e.response?.data || e.message);
    const refunded = await cancelPayment(payment.paymentKey || paymentKey, '프리미엄 권한 부여 실패로 자동 취소');
    return res.status(500).json({ success: false, message: refunded ? '권한 부여에 실패하여 결제를 자동으로 취소했습니다. 다시 시도해 주세요.' : '권한 부여에 실패했습니다. 결제 취소가 필요하시면 문의해 주세요.' });
  }
  res.json({ success: true, message: '결제 승인 및 프리미엄 권한 부여 완료', orderId, amount: PRICE });
});


/* ─────────── 이용 키 (개발자 계정이 발급 → 발급일로부터 3개월간 프리미엄) ─────────── */
const DEV_EMAIL = (process.env.DEV_EMAIL || 'architect05092@gmail.com').trim().toLowerCase();
const KEY_MONTHS = 3;
const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 헷갈리는 글자(0 O 1 I) 제외
const isDev = u => !!(u && u.email && String(u.email).toLowerCase() === DEV_EMAIL && u.email_confirmed_at);
const normKey = k => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^MEOW/, '');
const hashKey = k => crypto.createHash('sha256').update('meow-key:' + normKey(k)).digest('hex');
function makeKey() {
  const g = () => Array.from({ length: 4 }, () => KEY_CHARS[crypto.randomInt(KEY_CHARS.length)]).join('');
  return `MEOW-${g()}-${g()}-${g()}-${g()}`;
}
const sbJson = { ...sbAdmin, 'Content-Type': 'application/json' };
const rest = p => `${SUPABASE_URL}/rest/v1/${p}`;

// 키 입력 시도는 더 엄격하게 제한 (분당 8회)
const keyHits = new Map();
setInterval(() => keyHits.clear(), 60 * 1000).unref();
const keyLimiter = (req, res, next) => {
  const ip = req.ip || 'x', n = (keyHits.get(ip) || 0) + 1; keyHits.set(ip, n);
  if (n > 8) return res.status(429).json({ success: false, message: '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
  next();
};
async function authed(req, res, devOnly) {
  if (!ready()) { res.status(503).json({ success: false, message: '서버 설정이 완료되지 않았습니다. (SUPABASE_SERVICE_ROLE_KEY)' }); return null; }
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ success: false, message: '로그인이 필요합니다.' }); return null; }
  let user;
  try { user = await userFromToken(token); }
  catch (e) { res.status(401).json({ success: false, message: '로그인이 만료되었습니다. 로그아웃 후 다시 로그인해 주세요.' }); return null; }
  if (!user || !user.id || !user.email_confirmed_at) { res.status(401).json({ success: false, message: '이메일 인증이 완료된 계정만 사용할 수 있습니다.' }); return null; }
  if (devOnly && !isDev(user)) { res.status(403).json({ success: false, message: '개발자 계정만 사용할 수 있습니다.' }); return null; }
  return user;
}
const dbErr = (res, e, what) => { console.error('[' + what + ']', e.response?.data || e.message); res.status(500).json({ success: false, message: '데이터베이스 처리에 실패했습니다. supabase.sql 을 실행했는지 확인해 주세요.' }); };

// 개발자: 키 발급 (발급일로부터 3개월)
app.post('/api/dev/issue-key', limiter, async (req, res) => {
  const user = await authed(req, res, true); if (!user) return;
  const key = makeKey(), now = new Date(), exp = new Date(now); exp.setMonth(exp.getMonth() + KEY_MONTHS);
  const note = String((req.body && req.body.note) || '').trim().slice(0, 60) || null;
  try {
    await axios.post(rest('access_keys'), { key_hash: hashKey(key), hint: key.slice(-4), note, issued_by: user.email, issued_at: now.toISOString(), expires_at: exp.toISOString() },
      { headers: { ...sbJson, Prefer: 'return=minimal' }, timeout: 8000 });
  } catch (e) { return dbErr(res, e, '키 발급 실패'); }
  res.json({ success: true, key, issuedAt: now.toISOString(), expiresAt: exp.toISOString() });
});
// 개발자: 발급 내역
app.get('/api/dev/keys', limiter, async (req, res) => {
  const user = await authed(req, res, true); if (!user) return;
  try {
    const k = await axios.get(rest('access_keys?select=id,hint,note,issued_at,expires_at,revoked&order=issued_at.desc&limit=100'), { headers: sbAdmin, timeout: 8000 });
    const r = await axios.get(rest('key_redemptions?select=key_id&limit=5000'), { headers: sbAdmin, timeout: 8000 });
    const cnt = {}; (r.data || []).forEach(x => { cnt[x.key_id] = (cnt[x.key_id] || 0) + 1; });
    res.json({ success: true, keys: (k.data || []).map(x => ({ ...x, uses: cnt[x.id] || 0 })) });
  } catch (e) { dbErr(res, e, '키 목록 실패'); }
});
// 개발자: 키 폐기 (이미 적용된 사용자의 기간은 유지돼요)
app.post('/api/dev/revoke-key', limiter, async (req, res) => {
  const user = await authed(req, res, true); if (!user) return;
  const id = String((req.body && req.body.id) || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
  try { await axios.patch(rest(`access_keys?id=eq.${id}`), { revoked: true }, { headers: { ...sbJson, Prefer: 'return=minimal' }, timeout: 8000 }); res.json({ success: true }); }
  catch (e) { dbErr(res, e, '키 폐기 실패'); }
});
// 사용자: 키 입력 → 키의 만료일(발급일 + 3개월)까지 프리미엄
app.post('/api/redeem-key', keyLimiter, async (req, res) => {
  const user = await authed(req, res, false); if (!user) return;
  const raw = normKey(req.body && req.body.key);
  if (raw.length !== 16) return res.status(400).json({ success: false, message: '키 형식이 올바르지 않습니다.' });
  try {
    const f = await axios.get(rest(`access_keys?key_hash=eq.${hashKey(raw)}&select=id,expires_at,revoked&limit=1`), { headers: sbAdmin, timeout: 8000 });
    const k = f.data && f.data[0];
    if (!k || k.revoked) return res.status(404).json({ success: false, message: '유효하지 않은 키입니다.' });
    if (new Date(k.expires_at) <= new Date()) return res.status(410).json({ success: false, message: '사용 기간이 지난 키입니다.' });
    const p = await axios.get(rest(`users_profile?id=eq.${user.id}&select=premium_until&limit=1`), { headers: sbAdmin, timeout: 8000 });
    const cur = p.data && p.data[0] && p.data[0].premium_until ? new Date(p.data[0].premium_until) : null;
    const until = cur && cur > new Date(k.expires_at) ? cur : new Date(k.expires_at);
    await axios.post(rest('users_profile?on_conflict=id'), { id: user.id, email: user.email, premium_until: until.toISOString() },
      { headers: { ...sbJson, Prefer: 'resolution=merge-duplicates,return=minimal' }, timeout: 8000 });
    await axios.post(rest('key_redemptions?on_conflict=key_id,user_id'), { key_id: k.id, user_id: user.id },
      { headers: { ...sbJson, Prefer: 'resolution=ignore-duplicates,return=minimal' }, timeout: 8000 });
    res.json({ success: true, until: until.toISOString() });
  } catch (e) { dbErr(res, e, '키 적용 실패'); }
});

/* ─────────── 결제 팝업 페이지들 ─────────── */
const page = (title, body, script) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:#1b1b1b;color:#eee;font:15px/1.6 system-ui,-apple-system,"Malgun Gothic",sans-serif}
main{max-width:480px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:18px;margin:6px 0 4px}p{color:#aaa;margin:6px 0}
#payment-widget,#agreement-widget{background:#fff;border-radius:12px;margin-top:12px;overflow:hidden}
button{width:100%;margin-top:16px;padding:13px;background:#dbbe43;border:0;border-radius:10px;font-weight:700;font-size:15px;cursor:pointer;color:#000}
button:disabled{opacity:.5;cursor:default}.sub{background:#333;color:#eee;font-weight:600}
.ok{color:#7ee787}.err{color:#ff8a80}.box{margin-top:14px;padding:14px;border:1px solid #444;border-radius:10px;background:#242424}
</style></head><body><main>${body}</main>${script}</body></html>`;

app.get('/pay', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(page('Meow-PDF 결제', `
<h1>Meow-PDF 프리미엄 결제</h1><p>${ORDER_NAME} · ${PRICE.toLocaleString('ko-KR')}원</p>
<div id="msg" class="err"></div>
<div id="payment-widget"></div><div id="agreement-widget"></div>
<button id="payment-button" disabled>${PRICE.toLocaleString('ko-KR')}원 결제하고 프리미엄 시작하기</button>`, `
<script src="https://js.tosspayments.com/v1/payment-widget"></script>
<script>
(async () => {
  const msg = document.getElementById('msg'), btn = document.getElementById('payment-button');
  const order = new URLSearchParams(location.search).get('order');
  try {
    if (typeof PaymentWidget !== 'function') { msg.textContent = '결제 모듈(js.tosspayments.com)을 불러오지 못했습니다. 광고·보안 차단 확장 프로그램이나 네트워크 상태를 확인한 후 새로고침해 주세요.'; return; }
    const info = await (await fetch('/api/order-info?order=' + encodeURIComponent(order))).json();
    if (!info.success) { msg.textContent = info.message; return; }
    const paymentWidget = PaymentWidget(info.clientKey, info.customerKey);              // 결제위젯 초기화
    // v1 SDK 의 결제 UI 렌더 함수는 renderPaymentMethods 예요. (예전 이름 renderPaymentWidget 이 있으면 그걸로 대체)
    (paymentWidget.renderPaymentMethods || paymentWidget.renderPaymentWidget).call(paymentWidget, '#payment-widget', { value: info.amount }, { variantKey: 'DEFAULT' });
    paymentWidget.renderAgreement('#agreement-widget');                                  // 이용약관 UI
    btn.disabled = false;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await paymentWidget.requestPayment({
          orderId: order, orderName: info.orderName,
          successUrl: location.origin + '/payment/success',
          failUrl: location.origin + '/payment/fail'
        });
      } catch (e) { console.error('결제 에러:', e); if (e && e.code !== 'USER_CANCEL') msg.textContent = e.message || '결제를 시작하지 못했습니다.'; btn.disabled = false; }
    });
  } catch (e) { console.error(e); msg.textContent = '결제 정보를 불러오지 못했습니다: ' + (e && e.message ? e.message : e) + ' (F12 콘솔도 확인해 주세요)'; }
})();
</script>`));
});

app.get('/payment/success', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(page('결제 확인 중', `<h1 id="t">결제를 확인하고 있습니다…</h1><p id="d">창을 닫지 말고 잠시만 기다려 주세요.</p><button id="c" class="sub" hidden>창 닫기</button>`, `
<script>
(async () => {
  const q = new URLSearchParams(location.search), t = document.getElementById('t'), d = document.getElementById('d'), c = document.getElementById('c');
  c.onclick = () => window.close(); c.hidden = false;
  try {
    const r = await fetch('/api/confirm-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentKey: q.get('paymentKey'), orderId: q.get('orderId'), amount: q.get('amount') }) });
    const j = await r.json();
    if (j.success) {
      t.textContent = '결제가 완료되었습니다'; t.className = 'ok'; d.textContent = '프리미엄이 적용되었습니다. 이 창을 닫고 Meow-PDF로 돌아가 주세요.';
      try { window.opener && window.opener.postMessage({ type: 'meow-paid', ok: true }, '*'); } catch (e) {}
      setTimeout(() => { try { window.close(); } catch (e) {} }, 2500);
    } else { t.textContent = '결제를 완료하지 못했습니다'; t.className = 'err'; d.textContent = j.message || '알 수 없는 오류'; }
  } catch (e) { t.textContent = '서버에 연결하지 못했습니다'; t.className = 'err'; d.textContent = '잠시 후 이 페이지를 새로고침해 주세요. 이미 결제가 완료된 경우 중복 결제되지 않습니다.'; }
})();
</script>`));
});

app.get('/payment/fail', (req, res) => {
  const esc = s => String(s || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  res.send(page('결제 실패', `<h1 class="err">결제가 완료되지 않았습니다</h1><p>${esc(req.query.message) || '결제가 취소되었거나 실패했습니다.'}</p><p>${esc(req.query.code)}</p><button class="sub" onclick="window.close()">창 닫기</button>`, ''));
});

// (선택) 앱 HTML 을 같은 서버에서 제공하려면 public/index.html 에 pdf-editor.html 을 넣으세요.
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Meow-PDF 결제 서버 실행 중: ${PUBLIC_BASE_URL}`);
  if (TOSS_SECRET_KEY.startsWith('test_')) console.log('• 토스페이먼츠 테스트 키 사용 중 (실제 결제 안 됨)');
  if (!ready()) console.warn('⚠ SUPABASE_SERVICE_ROLE_KEY 가 비어 있어서 결제를 시작할 수 없어요. .env 를 확인하세요.');
  if (!process.env.ORDER_SECRET) console.warn('⚠ ORDER_SECRET 을 .env 에 정해 두세요. (없으면 서버 재시작 시 진행 중이던 주문이 무효가 돼요)');
});

'use strict';
/**
 * Meow-PDF 결제 서버
 *  - 토스페이먼츠 일반 결제로 1개월 1,200원 / 1년 10,500원 이용권 판매. 시크릿 키는 이 서버에만 존재
 *  - v1.0.3 구독(자동결제)에서 이용권(한 번 결제)으로 다시 바꿨어요 — 자동으로 다시 결제되지 않아요.
 *  - 결제가 승인되면 Supabase users_profile.premium_until 을 1개월/1년 연장 (남은 기간이 있으면 그 뒤에 이어 붙여요)
 *  - v1.1.1 프리미엄 1개월 무료 체험(계정당 한 번, POST /api/trial/start) · 네이버 계정으로 로그인(/auth/naver/start → /auth/naver/callback)
 *
 * 흐름: POST /api/create-order {plan} → /pay 팝업(토스 결제창) → /payment/success → POST /api/confirm-payment
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

/* 이용권 — 금액은 서버가 정해요. 클라이언트가 보낸 금액은 믿지 않아요. (한 번 결제 · 자동결제 없음) */
const PLANS = {
  monthly: { id: 'monthly', code: 'm', label: '1개월 이용권', amount: 1200,  months: 1,  orderName: 'Meow-PDF 프리미엄 1개월 이용권', unit: '1개월' },
  yearly:  { id: 'yearly',  code: 'y', label: '1년 이용권',   amount: 10500, months: 12, orderName: 'Meow-PDF 프리미엄 1년 이용권',   unit: '1년' }
};
const planOf = id => (Object.prototype.hasOwnProperty.call(PLANS, id) ? PLANS[id] : null);
const addMonths = (d, n) => { const x = new Date(d), day = x.getDate(); x.setDate(1); x.setMonth(x.getMonth() + n); const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate(); x.setDate(Math.min(day, last)); return x; };

// 토스페이먼츠 — 결제창(SDK v1)은 'API 개별 연동 키(ck/sk)'를 써요. 기본값은 토스 공식 문서의 "테스트 키"입니다. 실결제 전에 반드시 .env 로 교체하세요.
const TOSS_CLIENT_KEY = process.env.TOSS_CLIENT_KEY || 'test_ck_docs_Ovk5rk1EwkEbP0W43n07xlzm';
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || 'test_sk_docs_OaPz8L5KdmQXkzRz3y47BMw6';
const TOSS_API = (process.env.TOSS_API_BASE || 'https://api.tosspayments.com').replace(/\/$/, '');
const TOSS_AUTH = 'Basic ' + Buffer.from(TOSS_SECRET_KEY + ':').toString('base64');

// Supabase
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://zlulpyfiiutqpywyjbbi.supabase.co').replace(/\/$/, '');
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_16WKhcpLorKuoTTA_SoZbQ_Oyxl-7sv';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';   // 필수 (없으면 결제를 시작하지 않아요)

const ORDER_SECRET = process.env.ORDER_SECRET || crypto.randomBytes(32).toString('hex');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
/* www 가 붙은 주소와 안 붙은 주소는 같은 사이트로 봐요 (예: meow-pdf.com 만 적어도 www.meow-pdf.com 허용) */
const wwwSwap = o => { try { const u = new URL(o); u.hostname = u.hostname.startsWith('www.') ? u.hostname.slice(4) : 'www.' + u.hostname; return u.origin; } catch (e) { return ''; } };
const originOk = o => !ALLOWED_ORIGINS.length || o === 'null' || ALLOWED_ORIGINS.includes(o) || ALLOWED_ORIGINS.includes(wwwSwap(o));

const ready = () => !!SUPABASE_SERVICE_KEY;

/* ─────────── 유틸 ─────────── */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

// CORS: 앱(HTML 파일 / 다른 주소)에서 호출할 수 있게. 쿠키를 쓰지 않고 Bearer 토큰만 쓰므로 안전해요.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && originOk(origin)) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.length ? origin : '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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

/** 주문번호 = p_<사용자ID 32자>_<시각 base36>_<이용권 m|y>_<서명 10자> (토스 규칙: 6~64자, 영문/숫자/-/_) — 이용권 종류도 서명에 넣어 바꿔치기를 막아요 */
function makeOrderId(uid, code) {
  const u = hex32(uid), t = Date.now().toString(36);
  return `p_${u}_${t}_${code}_${sign('p' + u + t + code)}`;
}
function parseOrderId(id) {
  const m = /^p_([0-9a-f]{32})_([0-9a-z]{6,10})_([my])_([0-9a-f]{10})$/.exec(String(id || ''));
  if (!m) return null;
  const [, u, t, c, sg] = m, good = sign('p' + u + t + c);
  if (!crypto.timingSafeEqual(Buffer.from(sg), Buffer.from(good))) return null;
  return { uid: unhex32(u), ts: parseInt(t, 36), plan: c === 'y' ? PLANS.yearly : PLANS.monthly };
}

/** Supabase 로그인 토큰 검증 → 사용자 정보 */
async function userFromToken(token) {
  const r = await axios.get(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` }, timeout: 8000
  });
  return r.data;
}

const sbAdmin = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };

/** 프리미엄 만료일 저장 — 서비스 키로만 가능 (premium_until 은 클라이언트가 못 바꿔요) */
async function grantPremiumUntil(uid, until, orderId, paymentKey) {
  const au = await axios.get(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, { headers: sbAdmin, timeout: 8000 });
  await upsertProfile({
    id: uid, email: au.data.email, paid_at: new Date().toISOString(), premium_until: until.toISOString(), last_order_id: orderId, last_payment_key: paymentKey, premium_source: 'paid'
  });
}
async function profileRow(uid) {
  try {
    const p = await axios.get(`${SUPABASE_URL}/rest/v1/users_profile?id=eq.${uid}&select=premium_until,last_order_id&limit=1`, { headers: sbAdmin, timeout: 8000 });
    return (p.data && p.data[0]) || null;
  } catch (e) { return null; }
}
async function profileUntil(uid) {
  const r = await profileRow(uid), cur = r && r.premium_until ? new Date(r.premium_until) : null;
  return cur && !isNaN(cur) ? cur : null;
}
/** users_profile 저장. premium_source 칸이 아직 없는 DB 에서는 그 칸만 빼고 다시 저장해요. */
async function upsertProfile(body) {
  const post = b => axios.post(`${SUPABASE_URL}/rest/v1/users_profile?on_conflict=id`, b,
    { headers: { ...sbAdmin, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, timeout: 8000 });
  try { await post(body); }
  catch (e) {
    if (!('premium_source' in body)) throw e;
    const { premium_source, ...rest } = body; void premium_source;
    await post(rest);
  }
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

/* ─────────── 이용권 (1개월 1,200원 · 1년 10,500원) — v1.0.3 구독에서 이용권으로 ───────────
 *  1) 앱: POST /api/create-order {plan}  → { payUrl }          (로그인 토큰 필요)
 *  2) 팝업 /pay  → 토스 결제창 requestPayment (한 번 결제)
 *  3) 토스 → /payment/success?paymentKey&orderId&amount
 *  4) POST /api/confirm-payment → 금액 확인 → 결제 승인 → premium_until 연장 (남은 기간 뒤에 이어 붙임)
 *  · 자동으로 다시 결제되지 않아요. 기간이 3일 이내로 남으면 앱이 연장할지 알려 줘요.
 *  · 결제하면 이용 키 없이 바로 계정에 적용돼요. (이용 키는 개발자가 따로 나눠 주는 무료 키이고 판매하지 않아요)
 *  · v1.0.4 결제 후 1년 안에 제공이 끝나야 해요(토스페이 심사 기준). 이어 붙여서 끝나는 날이 결제일 + 1년을 넘으면 결제를 막아요.
 */
const PROVIDE_MONTHS = 12;
/** 이 이용권을 지금 결제하면 이용 기간이 어떻게 되는지 — ok=false 면 결제일로부터 1년을 넘어서 살 수 없어요 */
function passPeriod(curUntil, plan, now = new Date()) {
  const cur = curUntil && !isNaN(curUntil) && curUntil > now ? curUntil : null;
  const base = cur || now, end = addMonths(base, plan.months), limit = addMonths(now, PROVIDE_MONTHS);
  const ok = end.getTime() <= limit.getTime() + 60 * 1000;
  const after = ok ? null : addMonths(cur, -(PROVIDE_MONTHS - plan.months));   // 이 날 이후에 결제할 수 있어요
  return { base, end, limit, ok, extend: !!cur, after };
}
const passBlockMsg = (plan, P) => plan.months >= PROVIDE_MONTHS
  ? `이용권은 결제일로부터 1년 안에 모두 제공돼야 해서, 남은 기간이 있을 때는 1년 이용권을 결제할 수 없어요. 지금 기간이 끝난 뒤(${P.after.toLocaleDateString('sv-SE')} 이후) 결제하거나 1개월 이용권을 이용해 주세요.`
  : `이용권은 결제일로부터 1년 안에 모두 제공돼야 해서, 남은 기간이 11개월 이하일 때 결제할 수 있어요. ${P.after.toLocaleDateString('sv-SE')} 이후에 다시 결제해 주세요.`;
const sbJ = { ...sbAdmin, 'Content-Type': 'application/json' };
const tossJ = { Authorization: TOSS_AUTH, 'Content-Type': 'application/json' };
const dbMissing = e => { const c = e && e.response && e.response.data && e.response.data.code; return c === 'PGRST205' || c === '42P01' || c === 'PGRST204' || c === '42703'; };

// 1) 주문 만들기 — 로그인 + 이메일 인증한 사용자만
app.post('/api/create-order', limiter, async (req, res) => {
  const user = await authed(req, res, false); if (!user) return;
  const plan = planOf(req.body && req.body.plan);
  if (!plan) return res.status(400).json({ success: false, message: '이용권을 선택해 주세요. (1개월 / 1년)' });
  if (!user.email_confirmed_at) return res.status(401).json({ success: false, message: '이메일 인증이 완료된 계정만 결제할 수 있습니다.' });
  { const P = passPeriod(await profileUntil(user.id), plan); if (!P.ok) return res.status(409).json({ success: false, code: 'OVER_1Y', message: passBlockMsg(plan, P) }); }
  const orderId = makeOrderId(user.id, plan.code);
  res.json({ success: true, orderId, plan: plan.id, payUrl: `${PUBLIC_BASE_URL}/pay?order=${encodeURIComponent(orderId)}` });
});

// 결제 팝업이 결제창을 여는 데 필요한 정보 (클라이언트 키는 공개 값)
app.get('/api/order-info', limiter, async (req, res) => {
  const o = parseOrderId(req.query.order);
  if (!o || Date.now() - o.ts > 60 * 60 * 1000) return res.status(400).json({ success: false, message: '주문이 올바르지 않거나 만료되었습니다. 앱에서 결제를 다시 시작해 주세요.' });
  const P = passPeriod(ready() ? await profileUntil(o.uid) : null, o.plan);
  res.json({ success: true, clientKey: TOSS_CLIENT_KEY, amount: o.plan.amount, orderName: o.plan.orderName, plan: o.plan.id, label: o.plan.label, unit: o.plan.unit,
    from: P.base.toISOString(), to: P.end.toISOString(), extend: P.extend, ok: P.ok, message: P.ok ? '' : passBlockMsg(o.plan, P) });
});

// 2) 결제 승인 → 이용 기간 연장
app.post('/api/confirm-payment', limiter, async (req, res) => {
  if (!ready()) return res.status(503).json({ success: false, message: '결제 서버 설정이 완료되지 않았습니다.' });
  const { paymentKey, orderId } = req.body || {}, amount = Number(req.body && req.body.amount);
  const o = parseOrderId(orderId);
  if (!o || !paymentKey || typeof paymentKey !== 'string') return res.status(400).json({ success: false, message: '주문 정보가 올바르지 않습니다.' });
  if (amount !== o.plan.amount) return res.status(400).json({ success: false, message: '결제 금액이 이용권 금액과 다릅니다.' });   // 금액 바꿔치기 방지
  const before = await profileRow(o.uid);
  if (before && before.last_order_id === orderId) return res.json({ success: true, already: true, plan: o.plan.id, until: before.premium_until, message: '이미 적용된 결제예요.' });   // 성공 페이지 새로고침 대비
  if (Date.now() - o.ts > 2 * 60 * 60 * 1000) return res.status(400).json({ success: false, message: '주문이 만료되었습니다. 앱에서 결제를 다시 시작해 주세요.' });
  { const P = passPeriod(before && before.premium_until ? new Date(before.premium_until) : null, o.plan);   // 승인 전에 한 번 더 — 1년을 넘으면 결제하지 않아요
    if (!P.ok) return res.status(409).json({ success: false, code: 'OVER_1Y', message: passBlockMsg(o.plan, P) }); }
  let paid;
  try {
    const r = await axios.post(`${TOSS_API}/v1/payments/confirm`, { paymentKey, orderId, amount: o.plan.amount }, { headers: tossJ, timeout: 25000 });
    paid = r.data;
    if (!paid || paid.status !== 'DONE' || Number(paid.totalAmount) !== o.plan.amount) throw Object.assign(new Error('결제 상태를 확인할 수 없습니다.'), { toss: paid });
  } catch (e) {
    const d = e.response && e.response.data;
    return res.status(400).json({ success: false, code: d && d.code, message: (d && d.message) || e.message || '결제를 승인하지 못했습니다.' });
  }
  try {
    const curUntil = before && before.premium_until ? new Date(before.premium_until) : null;
    const end = passPeriod(curUntil, o.plan).end;   // 이용 기간이 남아 있으면 그 뒤부터 이어 붙여요. (결제일 + 1년 이내)
    await grantPremiumUntil(o.uid, end, orderId, paymentKey);
    console.log('[이용권 결제]', o.uid, o.plan.id, '→', end.toISOString());
    return res.json({ success: true, plan: o.plan.id, until: end.toISOString(), message: o.plan.label + ' 결제가 완료되었습니다.' });
  } catch (e) {
    console.error('[이용권 적용 실패]', e.response?.data || e.message);
    const refunded = await cancelPayment(paymentKey, '프리미엄 적용 실패로 자동 취소');
    return res.status(500).json({ success: false, message: refunded ? '프리미엄 적용에 실패하여 결제를 자동으로 취소했습니다. 다시 시도해 주세요.' : '프리미엄 적용에 실패했습니다. 결제 취소가 필요하시면 문의해 주세요.' });
  }
});

/* 예전 구독(v0.9.3 ~ v1.0.2) 정리 — 남아 있는 자동결제를 모두 멈추고 저장된 빌링키를 지워요.
   이미 결제한 이용 기간(premium_until)은 그대로 유지돼요. subscriptions 표가 없으면 아무것도 하지 않아요. */
async function endLegacySubscriptions() {
  if (!ready()) return;
  try {
    const now = new Date().toISOString();
    const r = await axios.patch(rest('subscriptions?or=(status.in.(active,past_due),billing_key_enc.not.is.null)'),
      { status: 'canceled', billing_key_enc: null, next_charge_at: null, canceled_at: now, updated_at: now }, { headers: { ...sbJ, Prefer: 'return=representation' }, timeout: 15000 });
    if (r.data && r.data.length) console.log('• 예전 구독 ' + r.data.length + '건의 자동결제를 멈췄어요 (이용 기간은 유지).');
  } catch (e) { if (!dbMissing(e)) console.error('[예전 구독 정리 실패]', e.response?.data || e.message); }
}
setTimeout(() => { endLegacySubscriptions().catch(() => {}); }, 10 * 1000).unref();
// 예전 앱이 부르는 주소 — 이제 구독이 없어요
app.get('/api/subscription', limiter, (req, res) => res.json({ success: true, subscription: null, note: 'v1.0.3부터 이용권제' }));


/* ─────────── 이용 키 (개발자 계정이 발급 → 발급일로부터 3개월간 프리미엄) ─────────── */
const DEV_EMAIL = (process.env.DEV_EMAIL || 'architect05092@gmail.com').trim().toLowerCase();
const KEY_MONTHS = 3;
const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 헷갈리는 글자(0 O 1 I) 제외
const isDev = u => !!(u && u.email && String(u.email).toLowerCase() === DEV_EMAIL && u.email_confirmed_at);
// 발급한 키를 개발자가 나중에 다시 볼 수 있도록 서버 비밀값으로 암호화(AES-256-GCM)해 저장해요. (입력 검증에는 해시만 써요)
const ENC_KEY = crypto.createHash('sha256').update('meow-keyenc:' + (process.env.KEY_ENC_SECRET || SUPABASE_SERVICE_KEY || ORDER_SECRET)).digest();
function encKey(plain) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv); const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.'); }
function decKey(enc) { try { const [iv, tag, ct] = String(enc).split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]).toString('utf8'); } catch (e) { return null; } }
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
  catch (e) {
    const st = e.response && e.response.status;
    console.error('[로그인 확인 실패] status=' + (st || e.code || '-') + ' ' + JSON.stringify((e.response && e.response.data) || e.message) + ' | SUPABASE_URL=' + SUPABASE_URL);
    const why = !st ? '서버가 Supabase에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'
      : (st === 401 || st === 403) ? '로그인이 만료되었습니다. 로그아웃 후 다시 로그인해 주세요.'
      : '로그인 확인에 실패했습니다. (Supabase ' + st + ') 서버의 SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY 설정을 확인해 주세요.';
    res.status(401).json({ success: false, message: why }); return null;
  }
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
    const row = { key_hash: hashKey(key), hint: key.slice(-4), note, issued_by: user.id, issued_at: now.toISOString(), expires_at: exp.toISOString() };
    const post = b => axios.post(rest('access_keys'), b, { headers: { ...sbJson, Prefer: 'return=minimal' }, timeout: 8000 });
    try { await post({ ...row, key_enc: encKey(key) }); }
    catch (e) { const c = e.response && e.response.data && e.response.data.code; if (c === 'PGRST204' || c === '42703') { console.warn('[안내] access_keys.key_enc 컬럼이 없어 키 원문 보관 없이 발급합니다. supabase.sql 을 다시 실행하세요.'); await post(row); } else throw e; }
  } catch (e) { return dbErr(res, e, '키 발급 실패'); }
  res.json({ success: true, key, issuedAt: now.toISOString(), expiresAt: exp.toISOString() });
});
// 개발자: 발급 내역
app.get('/api/dev/keys', limiter, async (req, res) => {
  const user = await authed(req, res, true); if (!user) return;
  try {
    const q = cols => axios.get(rest('access_keys?select=' + cols + '&order=issued_at.desc&limit=100'), { headers: sbAdmin, timeout: 8000 });
    let k; try { k = await q('id,hint,note,issued_at,expires_at,revoked,key_enc'); }
    catch (e) { const c = e.response && e.response.data && e.response.data.code; if (c === '42703' || c === 'PGRST204') k = await q('id,hint,note,issued_at,expires_at,revoked'); else throw e; }
    const r = await axios.get(rest('key_redemptions?select=key_id&limit=5000'), { headers: sbAdmin, timeout: 8000 });
    const cnt = {}; (r.data || []).forEach(x => { cnt[x.key_id] = (cnt[x.key_id] || 0) + 1; });
    res.json({ success: true, keys: (k.data || []).map(({ key_enc, ...x }) => ({ ...x, key: key_enc ? decKey(key_enc) : null, uses: cnt[x.id] || 0 })) });
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
/* ─────────── 고객센터 (불편사항 · 의견 접수) ───────────
   - 누구나(로그인 없이도) 접수할 수 있고, 로그인한 경우 계정이 함께 기록돼요.
   - 조회 · 상태 변경 · 삭제는 개발자 계정만 가능해요. */
const FB_CATS = ['불편사항', '오류 신고', '기능 제안', '기타'];
const FB_STATUS = ['new', 'doing', 'done'];
const fbHits = new Map();
setInterval(() => fbHits.clear(), 10 * 60 * 1000).unref();
const fbLimiter = (req, res, next) => {   // IP당 10분에 5건
  const ip = req.ip || 'x', n = (fbHits.get(ip) || 0) + 1; fbHits.set(ip, n);
  if (n > 5) return res.status(429).json({ success: false, message: '접수 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
  next();
};
app.post('/api/feedback', fbLimiter, async (req, res) => {
  if (!ready()) return res.status(503).json({ success: false, message: '서버 설정이 완료되지 않았습니다.' });
  const b = req.body || {};
  const category = FB_CATS.includes(b.category) ? b.category : '기타';
  const title = String(b.title || '').trim().slice(0, 80);
  const message = String(b.message || '').trim().slice(0, 4000);
  let contact = String(b.contact || '').trim().slice(0, 120);
  const env = String(b.env || '').trim().slice(0, 600);
  const appVersion = String(b.appVersion || '').trim().slice(0, 30);
  if (message.length < 5) return res.status(400).json({ success: false, message: '내용을 5자 이상 입력해 주세요.' });
  if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return res.status(400).json({ success: false, message: '회신받을 이메일 형식이 올바르지 않습니다.' });
  let uid = null, email = null;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) { try { const u = await userFromToken(token); if (u && u.id) { uid = u.id; email = u.email || null; } } catch (e) { /* 로그인 정보 없이 접수 */ } }
  try {
    await axios.post(rest('feedback'), { category, title: title || null, message, contact: contact || null, user_id: uid, user_email: email, app_version: appVersion || null, env: env || null },
      { headers: { ...sbJson, Prefer: 'return=minimal' }, timeout: 8000 });
  } catch (e) { return dbErr(res, e, '피드백 접수 실패'); }
  res.json({ success: true });
});
// ── 번역 (편집기의 "페이지 번역" 보조 엔진) ──
// 크롬 내장 번역이 없는 브라우저에서 사용합니다. 번역 엔진 키는 서버(.env)에만 둡니다.
//   DEEPL_API_KEY(무료 키는 ':fx' 로 끝남) 또는 GOOGLE_TRANSLATE_API_KEY 중 하나를 설정하세요. 둘 다 없으면 무료 엔진(MyMemory)을 사용합니다.
const DEEPL_API_KEY = (process.env.DEEPL_API_KEY || '').trim();
const GOOGLE_TRANSLATE_API_KEY = (process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
const trHits = new Map();
setInterval(() => trHits.clear(), 60 * 1000).unref();
const trLimiter = (req, res, next) => {   // IP당 분당 12회
  const ip = req.ip || 'x', n = (trHits.get(ip) || 0) + 1; trHits.set(ip, n);
  if (n > 12) return res.status(429).json({ success: false, message: '번역 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
  next();
};
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const DEEPL_MAP = { en: 'EN-US', pt: 'PT-BR', zh: 'ZH', 'zh-Hant': 'ZH-HANT' };
// 키가 없을 때 쓰는 무료 기본 엔진: MyMemory (공개 API, 익명 하루 약 5천 자 / 이메일을 붙이면 약 5만 자). 품질은 DeepL·Google 보다 낮을 수 있습니다.
const MM_EMAIL = (process.env.MYMEMORY_EMAIL || process.env.DEV_EMAIL || '').trim();
const MM_LANG = { zh: 'zh-CN', 'zh-Hant': 'zh-TW', pt: 'pt-BR' };
const decodeEnt = s => String(s).replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const bl = s => Buffer.byteLength(s, 'utf8');
function mmCut(p, max) {            // 글자(코드포인트) 단위로 자르되 UTF-8 바이트 수가 max 를 넘지 않게
  const out = []; let cur = '', b = 0;
  for (const ch of p) { const n = bl(ch); if (b + n > max) { out.push(cur); cur = ''; b = 0; } cur += ch; b += n; }
  if (cur) out.push(cur); return out;
}
function mmChunks(text, max = 380) {   // MyMemory 는 한 번에 500바이트까지 (한글은 글자당 3바이트)
  const parts = text.split(/(?<=[.!?])\s+|(?<=[。！？])/).filter(Boolean), out = []; let cur = '';
  const push = () => { if (cur) { out.push(cur); cur = ''; } };
  for (const p of parts) {
    if (bl(p) > max) { push(); out.push(...mmCut(p, max)); continue; }
    if (cur && bl(cur + ' ' + p) > max) push();
    cur = cur ? cur + ' ' + p : p;
  }
  push(); return out;
}
async function myMemoryOne(q, source, target) {
  const pair = (source ? (MM_LANG[source] || source) : 'Autodetect') + '|' + (MM_LANG[target] || target);
  const r = await axios.get('https://api.mymemory.translated.net/get', { params: { q, langpair: pair, ...(MM_EMAIL ? { de: MM_EMAIL } : {}) }, timeout: 15000 });
  const d = r.data || {};
  if (Number(d.responseStatus) !== 200 || !d.responseData || d.responseData.translatedText == null) {
    const err = new Error('MyMemory ' + d.responseStatus + ' ' + (d.responseDetails || '')); err.quota = /QUOTA|LIMIT/i.test(String(d.responseDetails || '')) || Number(d.responseStatus) === 429; throw err;
  }
  return decodeEnt(d.responseData.translatedText);
}
async function myMemoryAll(texts, source, target) {
  const glue = /^(ja|zh|th)/.test(target) ? '' : ' ';
  const jobs = []; texts.forEach((t, i) => mmChunks(t).forEach((c, k) => jobs.push({ i, k, c })));
  const res = texts.map(() => []); let next = 0;
  const worker = async () => { while (next < jobs.length) { const j = jobs[next++]; res[j.i][j.k] = (/\p{L}/u.test(j.c)) ? await myMemoryOne(j.c, source, target) : j.c; } };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  return res.map(r => r.join(glue));
}
app.post('/api/translate', trLimiter, async (req, res) => {
  const b = req.body || {};
  const texts = Array.isArray(b.texts) ? b.texts.map(t => String(t == null ? '' : t)) : null;
  const target = String(b.target || ''), source = b.source ? String(b.source) : '';
  if (!texts || !texts.length || texts.length > 120) return res.status(400).json({ success: false, message: '번역할 문장 수가 올바르지 않습니다.' });
  if (texts.reduce((n, t) => n + t.length, 0) > 20000 || texts.some(t => t.length > 4000)) return res.status(400).json({ success: false, message: '번역할 글이 너무 깁니다.' });
  if (!LANG_RE.test(target) || (source && !LANG_RE.test(source))) return res.status(400).json({ success: false, message: '언어 코드가 올바르지 않습니다.' });
  try {
    let out;
    if (DEEPL_API_KEY) {
      const host = DEEPL_API_KEY.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
      const body = { text: texts, target_lang: DEEPL_MAP[target] || target.toUpperCase() };
      if (source) body.source_lang = (DEEPL_MAP[source] || source).split('-')[0].toUpperCase();
      const r = await axios.post(host + '/v2/translate', body, { headers: { Authorization: 'DeepL-Auth-Key ' + DEEPL_API_KEY }, timeout: 20000 });
      out = (r.data.translations || []).map(t => t.text);
    } else if (GOOGLE_TRANSLATE_API_KEY) {
      const body = { q: texts, target, format: 'text' }; if (source) body.source = source;
      const r = await axios.post('https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(GOOGLE_TRANSLATE_API_KEY), body, { timeout: 20000 });
      out = ((r.data.data || {}).translations || []).map(t => t.translatedText);
    } else {
      out = await myMemoryAll(texts, source, target);      // 키가 없을 때의 무료 기본 엔진
    }
    if (out.length !== texts.length) throw new Error('응답 개수 불일치');
    res.json({ success: true, texts: out });
  } catch (e) {
    console.error('[번역 실패]', e.response ? e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 200) : e.message);
    res.status(502).json({ success: false, message: e.quota ? '무료 번역의 하루 사용량을 넘었습니다. 내일 다시 시도하거나 DeepL / Google 번역 키를 서버에 설정해 주세요.' : '번역 엔진 호출에 실패했습니다.', detail: e.quota ? undefined : String((e.response && (e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 80))) || e.message || '').slice(0, 140) });
  }
});
// 개발자: 접수 목록 (?status=new|doing|done, 최신순 200건)
app.get('/api/dev/feedback', limiter, async (req, res) => {
  const user = await authed(req, res, true); if (!user) return;
  const st = FB_STATUS.includes(req.query.status) ? '&status=eq.' + req.query.status : '';
  try {
    const r = await axios.get(rest('feedback?select=id,created_at,category,title,message,contact,user_email,app_version,env,status,memo&order=created_at.desc&limit=200' + st), { headers: sbAdmin, timeout: 8000 });
    const c = await axios.get(rest('feedback?select=status&limit=5000'), { headers: sbAdmin, timeout: 8000 });
    const counts = { new: 0, doing: 0, done: 0 }; (c.data || []).forEach(x => { if (counts[x.status] !== undefined) counts[x.status]++; });
    res.json({ success: true, items: r.data || [], counts });
  } catch (e) { dbErr(res, e, '피드백 목록 실패'); }
});
// 개발자: 상태 · 메모 변경
app.post('/api/dev/feedback-update', limiter, async (req, res) => {
  const user = await authed(req, res, true); if (!user) return;
  const b = req.body || {}, id = String(b.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
  const patch = {};
  if (b.status !== undefined) { if (!FB_STATUS.includes(b.status)) return res.status(400).json({ success: false, message: '잘못된 상태입니다.' }); patch.status = b.status; }
  if (b.memo !== undefined) patch.memo = String(b.memo).slice(0, 1000);
  if (!Object.keys(patch).length) return res.status(400).json({ success: false, message: '변경할 내용이 없습니다.' });
  try { await axios.patch(rest(`feedback?id=eq.${id}`), patch, { headers: { ...sbJson, Prefer: 'return=minimal' }, timeout: 8000 }); res.json({ success: true }); }
  catch (e) { dbErr(res, e, '피드백 변경 실패'); }
});
// 개발자: 삭제
app.post('/api/dev/feedback-delete', limiter, async (req, res) => {
  const user = await authed(req, res, true); if (!user) return;
  const id = String((req.body && req.body.id) || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
  try { await axios.delete(rest(`feedback?id=eq.${id}`), { headers: sbAdmin, timeout: 8000 }); res.json({ success: true }); }
  catch (e) { dbErr(res, e, '피드백 삭제 실패'); }
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
    const body = { id: user.id, email: user.email, premium_until: until.toISOString() };
    if (!(cur && cur > new Date(k.expires_at))) body.premium_source = 'key';   // 이 키로 기간이 더 늘어난 경우에만 '키'로 표시
    await upsertProfile(body);
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

/* ─────────── 아이디 · 비밀번호 로그인 ───────────
 * Supabase 의 로그인은 이메일 기준이라, 서버가 "아이디 → 이메일" 을 찾아 대신 로그인/인증해 줘요.
 * 이메일 주소는 브라우저로 내려보내지 않아요(비밀번호 재설정은 가려진 주소만 알려줘요). */
const authHits = new Map();
setInterval(() => authHits.clear(), 60 * 1000).unref();
const authLimiter = max => (req, res, next) => {
  const k = (req.ip || 'x') + '|' + req.path, n = (authHits.get(k) || 0) + 1; authHits.set(k, n);
  if (n > max) return res.status(429).json({ success: false, message: '시도가 너무 많아요. 1분 뒤 다시 시도해 주세요.' });
  next();
};
const USER_RE = /^[a-z0-9_]{4,20}$/;
const normUser = v => String(v || '').trim().toLowerCase();
const maskEmail = e => { const [a, d] = String(e).split('@'); return (a.slice(0, 2) + '*'.repeat(Math.max(1, a.length - 2))) + '@' + d; };
async function profileByUsername(u) {
  const r = await axios.get(`${SUPABASE_URL}/rest/v1/users_profile?username=eq.${encodeURIComponent(u)}&select=id,email&limit=1`, { headers: sbAdmin, timeout: 8000 });
  return r.data && r.data[0] || null;
}
const needAdmin = res => { if (!SUPABASE_SERVICE_KEY) { res.status(503).json({ success: false, message: '서버 설정(SUPABASE_SERVICE_ROLE_KEY)이 필요합니다.' }); return true; } return false; };
app.get('/api/auth/username-available', authLimiter(30), async (req, res) => {
  if (needAdmin(res)) return;
  const u = normUser(req.query.u);
  if (!USER_RE.test(u)) return res.json({ success: true, available: false, message: '아이디는 영문 소문자·숫자·밑줄(_) 4~20자로 입력해 주세요.' });
  try { const p = await profileByUsername(u); res.json({ success: true, available: !p, message: p ? '이미 사용 중인 아이디예요.' : '사용할 수 있는 아이디예요.' }); }
  catch (e) { res.status(502).json({ success: false, message: '아이디를 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.' }); }
});
app.post('/api/auth/login', authLimiter(10), async (req, res) => {
  if (needAdmin(res)) return;
  const u = normUser(req.body && req.body.id), pw = String((req.body && req.body.password) || '');
  const isEmail = EMAIL_RE.test(u);   // v1.0.4 이메일로도 로그인
  const bad = () => res.status(401).json({ success: false, message: isEmail ? '이메일 또는 비밀번호가 맞지 않아요.' : '아이디 또는 비밀번호가 맞지 않아요.' });
  if ((!isEmail && !USER_RE.test(u)) || !pw || pw.length > 200) return bad();
  try {
    let email = u;
    if (!isEmail) { const p = await profileByUsername(u); if (!p || !p.email) return bad(); email = p.email; }
    let s;
    try { s = await passwordSession(email, pw); }
    catch (e1) {
      // v1.0.4 예전에 인증번호를 입력하지 못해 '인증 안 됨'으로 남은 계정 — 비밀번호가 맞을 때만 이 오류가 나와요. 인증 처리하고 다시 로그인해요.
      if (!/email_not_confirmed|not confirmed/i.test(JSON.stringify((e1.response && e1.response.data) || ''))) throw e1;
      const au = await adminUserByEmail(email); if (!au) throw e1;
      await axios.put(`${SUPABASE_URL}/auth/v1/admin/users/${au.id}`, { email_confirm: true }, { headers: { ...sbAdmin, 'Content-Type': 'application/json' }, timeout: 10000 });
      s = await passwordSession(email, pw);
    }
    res.json({ success: true, session: s });
  } catch (e) {
    const st = e.response && e.response.status;
    if (st === 400 || st === 401 || st === 422) return bad();
    console.error('[login]', e.response?.data || e.message);
    res.status(502).json({ success: false, message: '로그인 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.' });
  }
});
/* ─────────── v1.0.4 회원가입 (이메일 인증번호 없이 바로 가입) ───────────
 * 인증 메일이 오지 않아 가입하지 못하는 일이 없도록, 서버가 '인증된 계정'으로 바로 만들고 로그인 세션까지 돌려줘요.
 * (대학생 인증은 그대로 학교 메일 인증번호로 따로 해요) */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
async function passwordSession(email, pw) {
  const r = await axios.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { email, password: pw },
    { headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, timeout: 10000 });
  return { access_token: r.data.access_token, refresh_token: r.data.refresh_token };
}
async function adminUserByEmail(email) {
  try {
    const p = await axios.get(`${SUPABASE_URL}/rest/v1/users_profile?email=eq.${encodeURIComponent(email)}&select=id&limit=1`, { headers: sbAdmin, timeout: 8000 });
    if (p.data && p.data[0]) return { id: p.data[0].id };
  } catch (e) { /* 프로필이 없을 수 있어요 */ }
  for (let page = 1; page <= 20; page++) {   // 프로필이 아직 없는 계정은 관리자 목록에서 찾아요
    const r = await axios.get(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: sbAdmin, timeout: 15000 });
    const list = (r.data && r.data.users) || [];
    const hit = list.find(x => String(x.email || '').toLowerCase() === email); if (hit) return hit;
    if (list.length < 200) break;
  }
  return null;
}
const signupHits = new Map();   // 한 IP에서 하루 10개까지만 가입할 수 있어요 (무더기 가입 방지)
setInterval(() => signupHits.clear(), 24 * 60 * 60 * 1000).unref();
app.post('/api/auth/signup', authLimiter(5), async (req, res) => {
  if (needAdmin(res)) return;
  const b = req.body || {}, email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
  const un = normUser(b.username), nick = String(b.nickname || '').trim().slice(0, 20);
  if (!nick) return res.status(400).json({ success: false, message: '닉네임을 1~20자로 입력해 주세요.' });
  if (!USER_RE.test(un)) return res.status(400).json({ success: false, message: '아이디는 영문 소문자 · 숫자 · 밑줄(_) 4~20자로 입력해 주세요.' });
  if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ success: false, message: '올바른 이메일 주소를 입력해 주세요.' });
  if (pw.length < 8 || pw.length > 200) return res.status(400).json({ success: false, message: '비밀번호는 8자 이상으로 입력해 주세요.' });
  const ipk = req.ip || 'x', n = (signupHits.get(ipk) || 0) + 1;
  if (n > 10) return res.status(429).json({ success: false, message: '오늘은 이 네트워크에서 더 가입할 수 없어요. 내일 다시 시도해 주세요.' });
  try {
    if (await profileByUsername(un)) return res.status(409).json({ success: false, code: 'USERNAME_TAKEN', message: '이미 사용 중인 아이디예요.' });
    let user;
    try {
      const r = await axios.post(`${SUPABASE_URL}/auth/v1/admin/users`, { email, password: pw, email_confirm: true, user_metadata: { username: un, nickname: nick } },
        { headers: { ...sbAdmin, 'Content-Type': 'application/json' }, timeout: 15000 });
      user = r.data && (r.data.user || r.data);
    } catch (e) {
      const m = JSON.stringify((e.response && e.response.data) || e.message || '');
      if (/already|registered|exists|email_exists/i.test(m)) return res.status(409).json({ success: false, code: 'EMAIL_TAKEN', message: '이미 가입된 이메일이에요. 로그인하거나 ‘비밀번호 찾기’를 이용해 주세요.' });
      if (/password/i.test(m)) return res.status(400).json({ success: false, message: '비밀번호가 너무 쉬워요. 영문 · 숫자를 섞어 8자 이상으로 입력해 주세요.' });
      throw e;
    }
    signupHits.set(ipk, n);
    if (user && user.id) {   // 아이디 · 닉네임을 프로필에 바로 기록 (DB 트리거가 이미 했으면 같은 값으로 덮어써요)
      try { await upsertProfile({ id: user.id, email, username: un, nickname: nick }); }
      catch (e) { try { await upsertProfile({ id: user.id, email, username: un }); } catch (e2) { console.warn('[signup] 프로필 기록 실패', e2.response?.data || e2.message); } }
    }
    const session = await passwordSession(email, pw);
    console.log('[signup]', un);
    res.json({ success: true, session });
  } catch (e) {
    console.error('[signup]', e.response?.data || e.message);
    res.status(502).json({ success: false, message: '가입을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.' });
  }
});

const resetSent = new Map(), RESET_DEDUP_MS = 20 * 1000;
setInterval(() => { const t = Date.now(); for (const [k, v] of resetSent) if (t - v > RESET_DEDUP_MS) resetSent.delete(k); }, 60 * 1000).unref();
app.post('/api/auth/reset-send', authLimiter(5), async (req, res) => {
  if (needAdmin(res)) return;
  const id = String((req.body && req.body.id) || '').trim().toLowerCase();
  let sentTo = '';
  try {
    let email = '';
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) email = id;
    else if (USER_RE.test(id)) { const p = await profileByUsername(id); email = p && p.email || ''; }
    if (!email) return res.status(404).json({ success: false, message: '등록된 아이디(이메일)를 찾지 못했어요.' });
    /* 같은 이메일로 짧은 시간에 겹쳐 들어온 요청(중복 클릭 · 중복 요청)은 메일을 한 번만 보내요 */
    const last = resetSent.get(email);
    if (last && Date.now() - last < RESET_DEDUP_MS) return res.json({ success: true, masked: maskEmail(email), dedup: true });
    resetSent.set(email, Date.now()); sentTo = email;
    await axios.post(`${SUPABASE_URL}/auth/v1/otp`, { email, create_user: false },
      { headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, timeout: 12000 });
    res.json({ success: true, masked: maskEmail(email) });
  } catch (e) {
    if (sentTo && !(e.response && e.response.status === 429)) resetSent.delete(sentTo);   // 발송 실패면 바로 다시 시도할 수 있게
    const m = JSON.stringify(e.response && e.response.data || '');
    if (e.response && e.response.status === 429 || /rate|seconds/i.test(m)) return res.status(429).json({ success: false, message: '인증번호를 너무 빨리 다시 요청했어요. 1분 뒤 다시 눌러 주세요.' });
    if (/not found|signups? not allowed|user_not_found/i.test(m)) return res.status(404).json({ success: false, message: '등록된 아이디(이메일)를 찾지 못했어요.' });
    console.error('[reset-send]', e.response?.data || e.message);
    res.status(502).json({ success: false, message: '인증번호를 보내지 못했어요. 잠시 뒤 다시 시도해 주세요.' });
  }
});
app.post('/api/auth/reset-confirm', authLimiter(8), async (req, res) => {
  if (needAdmin(res)) return;
  const id = String((req.body && req.body.id) || '').trim().toLowerCase(), token = String((req.body && req.body.token) || '').trim(), pw = String((req.body && req.body.password) || '');
  if (!/^\d{6,8}$/.test(token)) return res.status(400).json({ success: false, message: '인증번호(숫자 6자리)를 입력해 주세요.' });
  if (pw.length < 8 || pw.length > 72) return res.status(400).json({ success: false, message: '비밀번호는 8자 이상으로 입력해 주세요.' });
  try {
    let email = '';
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) email = id;
    else if (USER_RE.test(id)) { const p = await profileByUsername(id); email = p && p.email || ''; }
    if (!email) return res.status(404).json({ success: false, message: '등록된 아이디(이메일)를 찾지 못했어요.' });
    const v = await axios.post(`${SUPABASE_URL}/auth/v1/verify`, { type: 'email', email, token },
      { headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, timeout: 10000 });
    await axios.put(`${SUPABASE_URL}/auth/v1/user`, { password: pw },
      { headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${v.data.access_token}`, 'Content-Type': 'application/json' }, timeout: 10000 });
    res.json({ success: true });
  } catch (e) {
    const m = JSON.stringify(e.response && e.response.data || '');
    if (/expired|invalid/i.test(m)) return res.status(400).json({ success: false, message: '인증번호가 맞지 않거나 만료됐어요. 새 번호를 받아 다시 입력해 주세요.' });
    if (/same.*password|different from the old/i.test(m)) return res.status(400).json({ success: false, message: '이전과 같은 비밀번호예요. 다른 비밀번호를 입력해 주세요.' });
    if (/weak|password/i.test(m)) return res.status(400).json({ success: false, message: '비밀번호가 너무 쉬워요. 영문과 숫자를 섞어 주세요.' });
    console.error('[reset-confirm]', e.response?.data || e.message);
    res.status(502).json({ success: false, message: '비밀번호를 바꾸지 못했어요. 잠시 뒤 다시 시도해 주세요.' });
  }
});

/* ─────────── 회원탈퇴 ───────────
 * 로그인 토큰으로 본인을 확인하고, 확인 문구("확인했습니다")가 맞으면 계정을 지워요.
 * users_profile · key_redemptions 는 계정에 연결돼 함께 지워지고, 프로필 사진도 지워요.
 * 프리미엄(결제) 계정이어도 탈퇴하면 환불되지 않아요. (결제 기록은 토스페이먼츠에 남아요) */
app.post('/api/account/delete', authLimiter(5), async (req, res) => {
  const user = await authed(req, res, false); if (!user) return;
  if (String((req.body && req.body.confirm) || '').trim() !== '확인했습니다') return res.status(400).json({ success: false, message: '확인 문구를 정확히 입력해 주세요.' });
  if (isDev(user)) return res.status(403).json({ success: false, message: '개발자 계정은 여기서 탈퇴할 수 없습니다.' });
  try {
    try { await axios.delete(`${SUPABASE_URL}/storage/v1/object/avatars/${user.id}/avatar.jpg`, { headers: sbAdmin, timeout: 8000 }); } catch (e) { /* 사진이 없으면 무시 */ }
    await axios.delete(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, { headers: sbAdmin, timeout: 10000 });
    console.log('[탈퇴]', user.id);
    res.json({ success: true });
  } catch (e) {
    console.error('[탈퇴 실패]', e.response?.data || e.message);
    res.status(502).json({ success: false, message: '탈퇴를 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.' });
  }
});

/* ─────────── v1.1.1 프리미엄 1개월 무료 체험 (계정당 한 번 · 자동결제 없음) ───────────
 * 계정(auth.users)의 app_metadata.trial_used_at 에 시작 시각을 남겨요. app_metadata 는 서비스 키로만 바꿀 수 있어서 사용자가 지울 수 없어요.
 * 기록을 먼저 남긴 뒤 이용 기간을 더해서, 같은 계정이 동시에 여러 번 눌러도 한 번만 적용돼요. */
const TRIAL_MONTHS = 1;
const trialBusy = new Set();
app.post('/api/trial/start', authLimiter(6), async (req, res) => {
  const user = await authed(req, res, false); if (!user) return;
  if (trialBusy.has(user.id)) return res.status(429).json({ success: false, message: '처리 중이에요. 잠시만 기다려 주세요.' });
  trialBusy.add(user.id);
  try {
    const au = (await axios.get(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, { headers: sbAdmin, timeout: 10000 })).data || {};
    const am = au.app_metadata || {};
    if (am.trial_used_at) return res.status(409).json({ success: false, code: 'TRIAL_USED', message: '1개월 무료 체험은 계정당 한 번만 쓸 수 있어요. 이미 사용한 계정이에요.' });
    const row = await profileRow(user.id), now = new Date();
    const cur = row && row.premium_until ? new Date(row.premium_until) : null;
    const base = cur && !isNaN(cur) && cur > now ? cur : now, end = addMonths(base, TRIAL_MONTHS);
    await axios.put(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, { app_metadata: { ...am, trial_used_at: now.toISOString(), trial_until: end.toISOString() } }, { headers: { ...sbAdmin, 'Content-Type': 'application/json' }, timeout: 10000 });
    const body = { id: user.id, email: au.email || user.email, premium_until: end.toISOString() };
    if (!(cur && cur > now)) body.premium_source = 'trial';   // 남은 이용권 기간이 있으면 원래 구분(결제 등)을 그대로 둬요
    await upsertProfile(body);
    console.log('[무료 체험]', user.id, '→', end.toISOString());
    res.json({ success: true, until: end.toISOString(), message: '프리미엄 1개월 무료 체험을 시작했어요.' });
  } catch (e) {
    console.error('[무료 체험 실패]', e.response?.data || e.message);
    res.status(502).json({ success: false, message: '무료 체험을 시작하지 못했어요. 잠시 뒤 다시 시도해 주세요.' });
  } finally { trialBusy.delete(user.id); }
});

/* ─────────── v1.1.1 네이버 계정으로 로그인 ───────────
 * 흐름: 편집기 작은 창 → GET /auth/naver/start?ret=<편집기 주소>/auth-callback → 네이버 로그인 → GET /auth/naver/callback
 *       → 이메일로 Meow-PDF 계정을 찾거나 새로 만들고(인증된 계정) → 로그인 세션을 만들어 ret#access_token=… 으로 돌려보내요.
 * 필요: .env 의 NAVER_CLIENT_ID · NAVER_CLIENT_SECRET (네이버 개발자센터 › 애플리케이션 › 네이버 로그인, Callback URL = PUBLIC_BASE_URL/auth/naver/callback, 이메일 제공 필수)
 * 안전: 같은 이메일로 이미 가입한 계정은 네이버 메일(@naver.com)이거나 전에 네이버로 연결한 계정일 때만 이어서 로그인해요. */
const NAVER_ID = (process.env.NAVER_CLIENT_ID || '').trim(), NAVER_SECRET = (process.env.NAVER_CLIENT_SECRET || '').trim();
const naverReady = () => !!(NAVER_ID && NAVER_SECRET && ready());
const b64u = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function retOk(u) {
  try {
    const x = new URL(u); if (!/^https?:$/.test(x.protocol) || x.pathname.replace(/\.html$/, '') !== '/auth-callback') return false;
    if (/^(www\.)?meow-pdf\.com$/.test(x.hostname)) return x.protocol === 'https:';
    if (x.hostname === 'localhost' || x.hostname === '127.0.0.1') return true;
    return ALLOWED_ORIGINS.length > 0 && originOk(x.origin);
  } catch (e) { return false; }
}
const backTo = (ret, params) => ret + '#' + Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
app.get('/api/auth/naver-ready', (req, res) => res.json({ success: true, ready: naverReady() }));
app.get('/auth/naver/start', authLimiter(20), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ret = String(req.query.ret || '');
  if (!retOk(ret)) return res.status(400).send(page('네이버 로그인', '<h1 class="err">잘못된 요청이에요</h1><p>Meow-PDF 편집기에서 다시 시도해 주세요.</p>', ''));
  if (!naverReady()) return res.redirect(backTo(ret, { error: 'not_ready', error_description: '네이버 로그인이 아직 준비되지 않았어요.', provider: 'naver' }));
  const st = b64u(JSON.stringify({ r: ret, t: Date.now(), n: crypto.randomBytes(8).toString('hex') })), state = st + '.' + sign('naver:' + st);
  res.redirect('https://nid.naver.com/oauth2.0/authorize?response_type=code&client_id=' + encodeURIComponent(NAVER_ID) + '&redirect_uri=' + encodeURIComponent(PUBLIC_BASE_URL + '/auth/naver/callback') + '&state=' + encodeURIComponent(state));
});
async function sessionForEmail(email) {   // 관리자 키로 일회용 로그인 링크를 만들고 바로 확인해서 세션을 받아요 (메일은 보내지 않아요)
  const g = await axios.post(`${SUPABASE_URL}/auth/v1/admin/generate_link`, { type: 'magiclink', email }, { headers: { ...sbAdmin, 'Content-Type': 'application/json' }, timeout: 12000 });
  const d = g.data || {}, hashed = d.hashed_token || (d.properties && d.properties.hashed_token), otp = d.email_otp || (d.properties && d.properties.email_otp);
  const verify = b => axios.post(`${SUPABASE_URL}/auth/v1/verify`, b, { headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, timeout: 12000 });
  let v;
  try { v = await verify({ type: 'magiclink', token_hash: hashed }); }
  catch (e) { if (!otp) throw e; v = await verify({ type: 'magiclink', email, token: otp }); }
  if (!v.data || !v.data.access_token) throw new Error('세션을 만들지 못했어요');
  return { access_token: v.data.access_token, refresh_token: v.data.refresh_token };
}
app.get('/auth/naver/callback', authLimiter(20), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const [st, sig] = String(req.query.state || '').split('.');
  let S = null; try { if (st && sig && sig === sign('naver:' + st)) S = JSON.parse(unb64u(st)); } catch (e) { S = null; }
  if (!S || !retOk(S.r) || Date.now() - S.t > 10 * 60 * 1000) return res.status(400).send(page('네이버 로그인', '<h1 class="err">로그인 요청이 만료되었어요</h1><p>Meow-PDF 편집기에서 다시 시도해 주세요.</p><button class="sub" onclick="window.close()">창 닫기</button>', ''));
  const fail = (code, msg) => res.redirect(backTo(S.r, { error: code, error_description: msg, provider: 'naver' }));
  if (req.query.error || !req.query.code) return fail(String(req.query.error || 'cancel'), req.query.error === 'access_denied' ? '네이버 로그인을 취소했어요.' : '네이버 로그인을 완료하지 못했어요.');
  if (!naverReady()) return fail('not_ready', '네이버 로그인이 아직 준비되지 않았어요.');
  try {
    const tk = await axios.get('https://nid.naver.com/oauth2.0/token', { params: { grant_type: 'authorization_code', client_id: NAVER_ID, client_secret: NAVER_SECRET, code: String(req.query.code), state: String(req.query.state) }, timeout: 12000 });
    if (!tk.data || !tk.data.access_token) return fail('token', '네이버 로그인 정보를 받지 못했어요.');
    const me = await axios.get('https://openapi.naver.com/v1/nid/me', { headers: { Authorization: 'Bearer ' + tk.data.access_token }, timeout: 12000 });
    const p = (me.data && me.data.response) || {}, nid = String(p.id || ''), email = String(p.email || '').trim().toLowerCase();
    if (!nid) return fail('profile', '네이버 계정 정보를 받지 못했어요.');
    if (!EMAIL_RE.test(email)) return fail('email', '네이버 로그인에서 이메일 제공에 동의해 주세요. (Meow-PDF 계정을 이메일로 구분해요)');
    const nick = String(p.nickname || p.name || email.split('@')[0]).trim().slice(0, 20);
    let au = await adminUserByEmail(email);
    if (au && au.id && !au.app_metadata) au = (await axios.get(`${SUPABASE_URL}/auth/v1/admin/users/${au.id}`, { headers: sbAdmin, timeout: 10000 })).data;
    if (au && au.id) {
      const am = au.app_metadata || {};
      if (am.naver_id && am.naver_id !== nid) return fail('mismatch', '이 이메일은 다른 네이버 계정과 연결되어 있어요.');
      if (!am.naver_id) {
        if (!/@naver\.com$/i.test(email)) return fail('email_taken', '이 이메일로 이미 가입된 Meow-PDF 계정이 있어요. 아이디 · 비밀번호로 로그인해 주세요.');
        await axios.put(`${SUPABASE_URL}/auth/v1/admin/users/${au.id}`, { app_metadata: { ...am, naver_id: nid, providers: [...new Set([].concat(am.providers || [], 'naver'))] }, email_confirm: true }, { headers: { ...sbAdmin, 'Content-Type': 'application/json' }, timeout: 10000 });
      }
    } else {
      const r = await axios.post(`${SUPABASE_URL}/auth/v1/admin/users`, { email, email_confirm: true, user_metadata: { nickname: nick, provider: 'naver' }, app_metadata: { provider: 'naver', providers: ['naver'], naver_id: nid } },
        { headers: { ...sbAdmin, 'Content-Type': 'application/json' }, timeout: 15000 });
      au = r.data && (r.data.user || r.data);
      if (au && au.id) { try { await upsertProfile({ id: au.id, email, nickname: nick }); } catch (e) { console.warn('[naver] 프로필 기록 실패', e.response?.data || e.message); } }
      console.log('[naver 가입]', au && au.id);
    }
    const s = await sessionForEmail(email);
    res.redirect(backTo(S.r, { access_token: s.access_token, refresh_token: s.refresh_token, token_type: 'bearer', provider: 'naver' }));
  } catch (e) {
    console.error('[naver 로그인 실패]', e.response?.data || e.message);
    fail('server', '네이버 로그인을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
  }
});

app.get('/pay', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const o = parseOrderId(req.query.order), plan = (o && o.plan) || PLANS.monthly, won = n => n.toLocaleString('ko-KR') + '원';
  res.send(page('Meow-PDF 이용권 결제', `
<h1>Meow-PDF 프리미엄 ${plan.label}</h1>
<p style="font-size:20px;color:#fff;font-weight:700;margin:10px 0 2px">${won(plan.amount)} <span style="font-size:13px;color:#aaa;font-weight:500">/ ${plan.unit} · 한 번 결제</span></p>
<p id="period" style="font-size:13.5px;color:#ddd;margin:4px 0 0"></p>
<div class="box" style="line-height:1.7">
  <b>이용권 안내</b>
  <ul style="margin:8px 0 0;padding-left:18px;color:#ccc;font-size:13.5px">
    <li>결제가 끝나면 <b>이용 키 없이 바로 내 계정에 적용</b>되고, 이용 기간도 그때부터 시작돼요.</li>
    <li><b>한 번만 결제</b>돼요. 기간이 끝나도 <b>자동으로 다시 결제되지 않아요.</b></li>
    <li>이용 기간이 남아 있으면 남은 기간 <b>뒤에 이어서</b> ${plan.unit}이 더해져요. 모든 이용권은 결제일로부터 1년 안에 제공이 끝나요.</li>
    <li>기간이 3일 이내로 남으면 앱에서 연장할지 알려 드려요.</li>
  </ul>
</div>
<div class="box" style="line-height:1.7">
  <b>환불 규정</b> <span style="color:#aaa;font-size:12.5px">(1개월 · 1년 이용권 공통)</span>
  <ul style="margin:8px 0 0;padding-left:18px;color:#ccc;font-size:13.5px">
    <li>결제일로부터 <b>7일 이내</b>에 요청하면 사용 여부와 관계없이 <b>전액 환불</b>해요.</li>
    <li>7일이 지난 뒤에도 사용하지 않은 <b>남은 기간만큼 일할 계산해 부분 환불</b>해요. 환불 금액 = 결제 금액 × 남은 일수 ÷ 전체 이용 일수 (1원 미만 버림, 위약금 · 수수료 없음)</li>
    <li>예) ${plan.months === 1 ? '1개월 이용권(1,200원 · 30일)을 10일 쓰고 요청하면 800원' : '1년 이용권(10,500원 · 365일)을 100일 쓰고 요청하면 7,623원'} 환불</li>
    <li>아직 시작되지 않은 기간(남은 기간 뒤에 이어 붙은 이용권)과 시스템 오류 등 회사 사유는 전액 환불해요.</li>
    <li>요청: 앱 계정 창의 ‘환불 요청’ 또는 <a href="mailto:contact@meow-pdf.com" style="color:#dbbe43">contact@meow-pdf.com</a> · 접수 후 3영업일 안에 결제 수단으로 취소해요.</li>
  </ul>
</div>
<label style="display:flex;gap:8px;align-items:flex-start;margin-top:14px;font-size:13.5px;color:#ddd"><input id="agree" type="checkbox" style="margin-top:4px"> <span>위 이용권 안내와 환불 규정에 동의합니다. (필수)</span></label>
<div id="msg" class="err" style="margin-top:10px"></div>
<button id="pay-button" disabled>${won(plan.amount)} 결제하기</button>`, `
<script src="https://js.tosspayments.com/v1/payment"></script>
<script>
(async () => {
  const msg = document.getElementById('msg'), btn = document.getElementById('pay-button'), agree = document.getElementById('agree'), per = document.getElementById('period');
  const q = new URLSearchParams(location.search), order = q.get('order');
  try {
    if (typeof TossPayments !== 'function') { msg.textContent = '결제 모듈(js.tosspayments.com)을 불러오지 못했습니다. 광고·보안 차단 확장 프로그램이나 네트워크 상태를 확인한 후 새로고침해 주세요.'; return; }
    const info = await (await fetch('/api/order-info?order=' + encodeURIComponent(order))).json();
    if (!info.success) { msg.textContent = info.message; return; }
    const d = s => new Date(s).toLocaleDateString('sv-SE');
    per.textContent = (info.extend ? '남은 기간에 이어서 ' : '') + '이용 기간: ' + d(info.from) + ' ~ ' + d(info.to);
    if (info.ok === false) { msg.textContent = info.message; agree.disabled = true; btn.disabled = true; return; }   // v1.0.4 결제일로부터 1년을 넘으면 결제할 수 없어요
    const toss = TossPayments(info.clientKey);
    agree.onchange = () => { btn.disabled = !agree.checked; }; btn.disabled = !agree.checked;
    btn.addEventListener('click', async () => {
      btn.disabled = true; msg.textContent = '';
      try {
        await toss.requestPayment('카드', {
          amount: info.amount, orderId: order, orderName: info.orderName,
          successUrl: location.origin + '/payment/success',
          failUrl: location.origin + '/payment/fail'
        });
      } catch (e) { console.error('결제 에러:', e); if (e && e.code !== 'USER_CANCEL') msg.textContent = e.message || '결제를 시작하지 못했습니다.'; btn.disabled = !agree.checked; }
    });
  } catch (e) { console.error(e); msg.textContent = '결제 정보를 불러오지 못했습니다: ' + (e && e.message ? e.message : e); }
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
      t.textContent = '결제가 완료되었습니다'; t.className = 'ok';
      d.textContent = '프리미엄이 적용되었습니다' + (j.until ? ' (' + new Date(j.until).toLocaleDateString('sv-SE') + '까지)' : '') + '. 이 창을 닫고 Meow-PDF로 돌아가 주세요.';
      try { window.opener && window.opener.postMessage({ type: 'meow-paid', ok: true, until: j.until || null }, '*'); } catch (e) {}
      setTimeout(() => { try { window.close(); } catch (e) {} }, 2500);
    } else { t.textContent = '결제를 완료하지 못했습니다'; t.className = 'err'; d.textContent = j.message || '알 수 없는 오류'; }
  } catch (e) { t.textContent = '서버에 연결하지 못했습니다'; t.className = 'err'; d.textContent = '잠시 후 이 페이지를 새로고침해 주세요. 이미 결제가 완료된 경우 중복으로 적용되거나 결제되지 않습니다.'; }
})();
</script>`));
});

app.get('/payment/fail', (req, res) => {
  const esc = s => String(s || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  res.send(page('결제 실패', `<h1 class="err">결제가 완료되지 않았습니다</h1><p>${esc(req.query.message) || '결제가 취소되었거나 실패했습니다.'}</p><p>${esc(req.query.code)}</p><button class="sub" onclick="window.close()">창 닫기</button>`, ''));
});

// 화면 구성: public/index.html = 소개 페이지(/), public/edit.html = 편집 페이지(/edit, pdf-editor.html 을 그대로 복사)
app.get('/edit', (req, res) => res.sendFile(path.join(__dirname, 'public', 'edit.html')));
app.get('/auth-callback', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth-callback.html')));   // v1.1.1 소셜 로그인이 돌아오는 곳
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Meow-PDF 결제 서버 실행 중: ${PUBLIC_BASE_URL}`);
  if (TOSS_SECRET_KEY.startsWith('test_')) console.log('• 토스페이먼츠 테스트 키 사용 중 (실제 결제 안 됨)');
  if (!ready()) console.warn('⚠ SUPABASE_SERVICE_ROLE_KEY 가 비어 있어서 결제를 시작할 수 없어요. .env 를 확인하세요.');
  if (!process.env.ORDER_SECRET) console.warn('⚠ ORDER_SECRET 을 .env 에 정해 두세요. (없으면 서버 재시작 시 진행 중이던 주문이 무효가 돼요)');
});

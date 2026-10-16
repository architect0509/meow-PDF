'use strict';
/**
 * Meow-PDF 결제 서버
 *  - 토스페이먼츠 자동결제(빌링키)로 월간 1,200원 / 연간 10,500원 구독 처리. 시크릿 키는 이 서버에만 존재
 *  - 결제가 성공할 때마다 Supabase users_profile.premium_until 을 1개월/1년씩 연장
 *  - 구독 정보(암호화된 빌링키 포함)는 Supabase subscriptions 테이블에 저장 (서버 전용, supabase.sql 6번)
 *
 * 흐름: POST /api/create-order {plan} → /pay 팝업(카드 등록) → /payment/success → POST /api/subscribe
 *       → 이후 서버가 매시간 만기 구독을 자동 결제 (POST /api/cron/renew 로도 실행 가능)
 *       POST /api/subscription/cancel 로 해지 · GET /api/subscription 으로 상태 확인
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

/* 구독 요금제 — 금액은 서버가 정해요. 클라이언트가 보낸 금액은 믿지 않아요. (토스 자동결제 · 빌링키 방식) */
const PLANS = {
  monthly: { id: 'monthly', label: '월간 구독', amount: 1200,  months: 1,  orderName: 'Meow-PDF 프리미엄 월간 구독', unit: '월' },
  yearly:  { id: 'yearly',  label: '연간 구독', amount: 10500, months: 12, orderName: 'Meow-PDF 프리미엄 연간 구독', unit: '년' }
};
const planOf = id => (Object.prototype.hasOwnProperty.call(PLANS, id) ? PLANS[id] : null);
const RETRY_MAX = 3;                                  // 정기결제 실패 시 하루 간격으로 최대 3번까지 다시 시도해요.
const CRON_SECRET = process.env.CRON_SECRET || '';    // 외부 스케줄러가 /api/cron/renew 를 호출할 때 쓰는 비밀값 (선택)
const addMonths = (d, n) => { const x = new Date(d), day = x.getDate(); x.setDate(1); x.setMonth(x.getMonth() + n); const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate(); x.setDate(Math.min(day, last)); return x; };

// 토스페이먼츠 — 자동결제(빌링)는 '결제위젯 키(gck/gsk)'가 아니라 'API 개별 연동 키(ck/sk)'를 써야 해요. 기본값은 토스 공식 문서의 "테스트 키"입니다. 실결제 전에 반드시 .env 로 교체하세요.
const TOSS_CLIENT_KEY = process.env.TOSS_CLIENT_KEY || 'test_ck_docs_Ovk5rk1EwkEbP0W43n07xlzm';
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || 'test_sk_docs_OaPz8L5KdmQXkzRz3y47BMw6';
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

/** 프리미엄 만료일 저장 — 서비스 키로만 가능 (premium_until 은 클라이언트가 못 바꿔요) */
async function grantPremiumUntil(uid, until, orderId, paymentKey) {
  const au = await axios.get(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, { headers: sbAdmin, timeout: 8000 });
  await upsertProfile({
    id: uid, email: au.data.email, paid_at: new Date().toISOString(), premium_until: until.toISOString(), last_order_id: orderId, last_payment_key: paymentKey, premium_source: 'paid'
  });
}
async function profileUntil(uid) {
  try {
    const p = await axios.get(`${SUPABASE_URL}/rest/v1/users_profile?id=eq.${uid}&select=premium_until&limit=1`, { headers: sbAdmin, timeout: 8000 });
    const cur = p.data && p.data[0] && p.data[0].premium_until ? new Date(p.data[0].premium_until) : null;
    return cur && !isNaN(cur) ? cur : null;
  } catch (e) { return null; }
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

/* ─────────── 구독 (월간 1,200원 · 연간 10,500원) ───────────
 *  1) 앱: POST /api/create-order {plan}  → { payUrl }          (로그인 토큰 필요)
 *  2) 팝업 /pay  → 토스 requestBillingAuth (카드 등록)
 *  3) 토스 → /payment/success?authKey&customerKey&order&plan
 *  4) POST /api/subscribe → 빌링키 발급 → 첫 결제 → 구독 저장 + premium_until 연장
 *  5) 매 시간 만기 도래 구독을 서버가 자동 결제(실패 시 하루 간격 재시도 최대 3회) / POST /api/cron/renew 로도 실행 가능
 *  6) POST /api/subscription/cancel  → 다음 결제부터 중단, 이미 낸 기간은 끝까지 이용
 */
const sbJ = { ...sbAdmin, 'Content-Type': 'application/json' };
const tossJ = { Authorization: TOSS_AUTH, 'Content-Type': 'application/json' };
const chargeOrderId = uid => { const u = hex32(uid), t = Date.now().toString(36); return `s_${u}_${t}_${sign('s' + u + t)}`; };
const dbMissing = e => { const c = e && e.response && e.response.data && e.response.data.code; return c === 'PGRST205' || c === '42P01' || c === 'PGRST204' || c === '42703'; };

async function getSub(uid) {
  const r = await axios.get(rest(`subscriptions?user_id=eq.${uid}&select=*&limit=1`), { headers: sbAdmin, timeout: 8000 });
  return (r.data && r.data[0]) || null;
}
async function saveSub(row) {
  await axios.post(rest('subscriptions?on_conflict=user_id'), row, { headers: { ...sbJ, Prefer: 'resolution=merge-duplicates,return=minimal' }, timeout: 8000 });
}
const subPublic = s => s ? { plan: s.plan, status: s.status, amount: s.amount, periodEnd: s.current_period_end, nextChargeAt: s.status === 'active' || s.status === 'past_due' ? s.next_charge_at : null, card: s.card_label || null, canceledAt: s.canceled_at || null } : null;

// 1) 주문(카드 등록 세션) 만들기 — 로그인 + 이메일 인증한 사용자만
app.post('/api/create-order', limiter, async (req, res) => {
  const user = await authed(req, res, false); if (!user) return;
  const plan = planOf(req.body && req.body.plan);
  if (!plan) return res.status(400).json({ success: false, message: '요금제를 선택해 주세요. (월간 / 연간)' });
  if (!user.email_confirmed_at) return res.status(401).json({ success: false, message: '이메일 인증이 완료된 계정만 구독할 수 있습니다.' });
  try {
    const cur = await getSub(user.id);
    if (cur && cur.status === 'active') return res.status(409).json({ success: false, message: '이미 구독 중이에요. 요금제를 바꾸려면 현재 구독을 해지한 뒤 다시 구독해 주세요.' });
  } catch (e) { if (dbMissing(e)) return res.status(503).json({ success: false, message: '구독 테이블이 아직 없어요. supabase.sql 의 6번(구독) 블록을 실행해 주세요.' }); }
  const orderId = makeOrderId(user.id);
  res.json({ success: true, orderId, plan: plan.id, payUrl: `${PUBLIC_BASE_URL}/pay?order=${encodeURIComponent(orderId)}&plan=${plan.id}` });
});

// 결제 팝업이 카드 등록 창을 여는 데 필요한 정보 (클라이언트 키는 공개 값)
app.get('/api/order-info', limiter, (req, res) => {
  const o = parseOrderId(req.query.order), plan = planOf(req.query.plan);
  if (!o || !plan || Date.now() - o.ts > 60 * 60 * 1000) return res.status(400).json({ success: false, message: '주문이 올바르지 않거나 만료되었습니다. 앱에서 결제를 다시 시작해 주세요.' });
  res.json({ success: true, clientKey: TOSS_CLIENT_KEY, customerKey: 'user_' + hex32(o.uid), amount: plan.amount, orderName: plan.orderName, plan: plan.id, label: plan.label, unit: plan.unit });
});

// 한 번의 청구 — 빌링키로 결제 승인
async function chargeBilling(billingKey, customerKey, plan, uid) {
  const orderId = chargeOrderId(uid);
  const r = await axios.post(`${TOSS_API}/v1/billing/${encodeURIComponent(billingKey)}`, { customerKey, amount: plan.amount, orderId, orderName: plan.orderName },
    { headers: tossJ, timeout: 25000 });
  const p = r.data;
  if (!p || p.status !== 'DONE' || Number(p.totalAmount) !== plan.amount) throw Object.assign(new Error('결제 상태를 확인할 수 없습니다.'), { toss: p });
  return { orderId, paymentKey: p.paymentKey };
}

// 2) 카드 등록 완료 → 빌링키 발급 → 첫 결제 → 구독 시작
app.post('/api/subscribe', limiter, async (req, res) => {
  if (!ready()) return res.status(503).json({ success: false, message: '결제 서버 설정이 완료되지 않았습니다.' });
  const { authKey, customerKey, order } = req.body || {}, plan = planOf(req.body && req.body.plan);
  const o = parseOrderId(order);
  if (!o || !plan || !authKey || typeof authKey !== 'string') return res.status(400).json({ success: false, message: '주문 정보가 올바르지 않습니다.' });
  if (Date.now() - o.ts > 60 * 60 * 1000) return res.status(400).json({ success: false, message: '주문이 만료되었습니다. 앱에서 구독을 다시 시작해 주세요.' });
  const ck = 'user_' + hex32(o.uid);
  if (customerKey !== ck) return res.status(400).json({ success: false, message: '고객 정보가 일치하지 않습니다.' });   // 남의 계정으로 등록 방지
  let cur = null;
  try { cur = await getSub(o.uid); } catch (e) { if (dbMissing(e)) return res.status(503).json({ success: false, message: '구독 테이블이 아직 없어요. supabase.sql 의 6번(구독) 블록을 실행해 주세요.' }); return res.status(502).json({ success: false, message: '구독 정보를 읽지 못했어요.' }); }
  if (cur && cur.status === 'active' && cur.last_order_id && cur.billing_key_enc) return res.json({ success: true, already: true, message: '이미 구독 중이에요.' });   // 성공 페이지 새로고침 대비

  let billingKey, cardLabel = null;
  try {
    const r = await axios.post(`${TOSS_API}/v1/billing/authorizations/issue`, { authKey, customerKey: ck }, { headers: tossJ, timeout: 20000 });
    billingKey = r.data && r.data.billingKey;
    const num = r.data && r.data.card && r.data.card.number ? String(r.data.card.number).replace(/\D/g, '').slice(-4) : '';
    cardLabel = [r.data && r.data.cardCompany, num ? '····' + num : ''].filter(Boolean).join(' ') || null;
  } catch (e) {
    const d = e.response && e.response.data;
    return res.status(400).json({ success: false, code: d && d.code, message: (d && d.message) || '카드 등록에 실패했습니다.' });
  }
  if (!billingKey) return res.status(400).json({ success: false, message: '카드 등록 정보를 받지 못했습니다.' });

  let paid;
  try { paid = await chargeBilling(billingKey, ck, plan, o.uid); }
  catch (e) {
    const d = e.response && e.response.data;
    return res.status(400).json({ success: false, code: d && d.code, message: (d && d.message) || e.message || '첫 결제에 실패했습니다. 카드 한도·잔액을 확인해 주세요.' });
  }
  try {
    const now = new Date(), curUntil = await profileUntil(o.uid);
    const base = curUntil && curUntil > now ? curUntil : now;                // 이용 기간이 남아 있으면 그 뒤부터 이어 붙여요.
    const end = addMonths(base, plan.months);
    await grantPremiumUntil(o.uid, end, paid.orderId, paid.paymentKey);
    await saveSub({
      user_id: o.uid, plan: plan.id, amount: plan.amount, status: 'active', billing_key_enc: encKey(billingKey), customer_key: ck, card_label: cardLabel,
      current_period_end: end.toISOString(), next_charge_at: end.toISOString(), fail_count: 0, last_order_id: paid.orderId, last_payment_key: paid.paymentKey,
      canceled_at: null, updated_at: now.toISOString(), started_at: (cur && cur.started_at) || now.toISOString()
    });
    return res.json({ success: true, plan: plan.id, until: end.toISOString(), message: '구독이 시작되었습니다.' });
  } catch (e) {
    console.error('[구독 저장 실패]', e.response?.data || e.message);
    const refunded = await cancelPayment(paid.paymentKey, '구독 권한 부여 실패로 자동 취소');
    return res.status(500).json({ success: false, message: refunded ? '구독 처리에 실패하여 결제를 자동으로 취소했습니다. 다시 시도해 주세요.' : '구독 처리에 실패했습니다. 결제 취소가 필요하시면 문의해 주세요.' });
  }
});

// 내 구독 상태
app.get('/api/subscription', limiter, async (req, res) => {
  const user = await authed(req, res, false); if (!user) return;
  try { res.json({ success: true, subscription: subPublic(await getSub(user.id)) }); }
  catch (e) { if (dbMissing(e)) return res.json({ success: true, subscription: null, note: 'subscriptions 테이블 없음' }); res.status(502).json({ success: false, message: '구독 정보를 읽지 못했어요.' }); }
});

// 구독 해지 — 다음 결제부터 중단, 이미 결제한 기간은 만료일까지 계속 이용
app.post('/api/subscription/cancel', limiter, async (req, res) => {
  const user = await authed(req, res, false); if (!user) return;
  try {
    const cur = await getSub(user.id);
    if (!cur || !['active', 'past_due'].includes(cur.status)) return res.status(400).json({ success: false, message: '해지할 구독이 없어요.' });
    await saveSub({ user_id: user.id, status: 'canceled', billing_key_enc: null, next_charge_at: null, canceled_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    res.json({ success: true, subscription: subPublic({ ...cur, status: 'canceled', next_charge_at: null, canceled_at: new Date().toISOString() }) });
  } catch (e) { console.error('[구독 해지 실패]', e.response?.data || e.message); res.status(502).json({ success: false, message: '해지를 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.' }); }
});

/* ─────────── 정기결제 (만기 도래 구독 자동 청구) ─────────── */
let renewing = false;
async function renewDue() {
  if (!ready() || renewing) return { checked: 0, ok: 0, failed: 0 };
  renewing = true; const out = { checked: 0, ok: 0, failed: 0 };
  try {
    const nowIso = new Date().toISOString();
    const r = await axios.get(rest(`subscriptions?status=in.(active,past_due)&next_charge_at=lte.${encodeURIComponent(nowIso)}&billing_key_enc=not.is.null&select=*&order=next_charge_at.asc&limit=50`), { headers: sbAdmin, timeout: 15000 });
    for (const sub of r.data || []) {
      // 같은 행을 두 번 청구하지 않도록 먼저 선점(15분 뒤로 미룸). 이미 다른 곳에서 선점했으면 건너뜀.
      let claimed;
      try {
        const c = await axios.patch(rest(`subscriptions?user_id=eq.${sub.user_id}&next_charge_at=eq.${encodeURIComponent(sub.next_charge_at)}&status=in.(active,past_due)`),
          { next_charge_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() }, { headers: { ...sbJ, Prefer: 'return=representation' }, timeout: 8000 });
        claimed = c.data && c.data[0];
      } catch (e) { continue; }
      if (!claimed) continue;
      out.checked++;
      const plan = planOf(sub.plan), key = decKey(sub.billing_key_enc);
      try {
        if (!plan || !key) throw new Error('구독 정보를 확인할 수 없어요.');
        const paid = await chargeBilling(key, sub.customer_key, plan, sub.user_id);
        const now = new Date(), curUntil = (await profileUntil(sub.user_id)) || new Date(sub.current_period_end);
        const base = curUntil > now ? curUntil : now, end = addMonths(base, plan.months);
        await grantPremiumUntil(sub.user_id, end, paid.orderId, paid.paymentKey);
        await saveSub({ user_id: sub.user_id, status: 'active', current_period_end: end.toISOString(), next_charge_at: end.toISOString(), fail_count: 0, last_order_id: paid.orderId, last_payment_key: paid.paymentKey, updated_at: now.toISOString() });
        out.ok++; console.log('[정기결제 성공]', sub.user_id, plan.id);
      } catch (e) {
        out.failed++;
        const d = e.response && e.response.data, fails = (sub.fail_count || 0) + 1, giveUp = fails >= RETRY_MAX;
        console.error('[정기결제 실패]', sub.user_id, fails + '/' + RETRY_MAX, (d && (d.code + ' ' + d.message)) || e.message);
        try {
          await saveSub({ user_id: sub.user_id, status: giveUp ? 'expired' : 'past_due', fail_count: fails, next_charge_at: giveUp ? null : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            billing_key_enc: giveUp ? null : sub.billing_key_enc, updated_at: new Date().toISOString() });
        } catch (e2) { console.error('[정기결제 상태 저장 실패]', e2.message); }
      }
    }
  } catch (e) { if (!dbMissing(e)) console.error('[정기결제 조회 실패]', e.response?.data || e.message); }
  finally { renewing = false; }
  return out;
}
// 외부 스케줄러(cron-job.org, GitHub Actions 등)에서 호출하는 길 — 서버가 잠들어 있는 호스팅용. 헤더: x-cron-secret
app.post('/api/cron/renew', async (req, res) => {
  const given = String(req.headers['x-cron-secret'] || '');
  if (!CRON_SECRET || given.length !== CRON_SECRET.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(CRON_SECRET)))
    return res.status(403).json({ success: false });
  res.json({ success: true, ...(await renewDue()) });
});
setInterval(() => { renewDue().catch(() => {}); }, 60 * 60 * 1000).unref();
setTimeout(() => { renewDue().catch(() => {}); }, 30 * 1000).unref();


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
  const bad = () => res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 맞지 않아요.' });
  if (!USER_RE.test(u) || !pw || pw.length > 200) return bad();
  try {
    const p = await profileByUsername(u); if (!p || !p.email) return bad();
    const r = await axios.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { email: p.email, password: pw },
      { headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, timeout: 10000 });
    res.json({ success: true, session: { access_token: r.data.access_token, refresh_token: r.data.refresh_token } });
  } catch (e) {
    const st = e.response && e.response.status;
    if (st === 400 || st === 401 || st === 422) {
      const m = JSON.stringify(e.response.data || '');
      if (/email_not_confirmed|not confirmed/i.test(m)) return res.status(403).json({ success: false, message: '이메일 인증이 끝나지 않았어요. ‘회원가입’에서 인증번호를 입력해 인증을 마쳐 주세요.' });
      return bad();
    }
    console.error('[login]', e.response?.data || e.message);
    res.status(502).json({ success: false, message: '로그인 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.' });
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

app.get('/pay', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const plan = planOf(req.query.plan) || PLANS.monthly, won = n => n.toLocaleString('ko-KR') + '원';
  res.send(page('Meow-PDF 구독', `
<h1>Meow-PDF 프리미엄 ${plan.label}</h1>
<p style="font-size:20px;color:#fff;font-weight:700;margin:10px 0 2px">${won(plan.amount)} <span style="font-size:13px;color:#aaa;font-weight:500">/ ${plan.unit}</span></p>
<div class="box" style="line-height:1.7">
  <b>구독 안내</b>
  <ul style="margin:8px 0 0;padding-left:18px;color:#ccc;font-size:13.5px">
    <li>카드를 등록하면 <b>지금 ${won(plan.amount)}</b>이 결제되고, 이후 ${plan.months === 1 ? '매달' : '매년'} 같은 날 <b>자동으로 결제</b>됩니다.</li>
    <li>언제든 앱의 <b>계정 → 구독 해지</b>에서 해지할 수 있어요. 해지하면 다음 결제부터 청구되지 않고, 이미 결제한 기간은 끝까지 이용할 수 있어요.</li>
    <li>정기결제가 실패하면 하루 간격으로 최대 ${RETRY_MAX}번 다시 시도하고, 끝내 실패하면 구독이 종료돼요.</li>
    <li>환불은 결제일로부터 7일 이내, 시스템 오류 또는 상품 미제공 사유에 한해 가능하며 단순 변심은 환불되지 않습니다.</li>
  </ul>
</div>
<label style="display:flex;gap:8px;align-items:flex-start;margin-top:14px;font-size:13.5px;color:#ddd"><input id="agree" type="checkbox" style="margin-top:4px"> <span>위 구독 안내와 <b>자동결제</b>에 동의합니다. (필수)</span></label>
<div id="msg" class="err" style="margin-top:10px"></div>
<button id="pay-button" disabled>카드 등록하고 ${won(plan.amount)} 결제하기</button>`, `
<script src="https://js.tosspayments.com/v1/payment"></script>
<script>
(async () => {
  const msg = document.getElementById('msg'), btn = document.getElementById('pay-button'), agree = document.getElementById('agree');
  const q = new URLSearchParams(location.search), order = q.get('order'), planId = q.get('plan');
  try {
    if (typeof TossPayments !== 'function') { msg.textContent = '결제 모듈(js.tosspayments.com)을 불러오지 못했습니다. 광고·보안 차단 확장 프로그램이나 네트워크 상태를 확인한 후 새로고침해 주세요.'; return; }
    const info = await (await fetch('/api/order-info?order=' + encodeURIComponent(order) + '&plan=' + encodeURIComponent(planId))).json();
    if (!info.success) { msg.textContent = info.message; return; }
    const toss = TossPayments(info.clientKey);
    agree.onchange = () => { btn.disabled = !agree.checked; }; btn.disabled = !agree.checked;
    btn.addEventListener('click', async () => {
      btn.disabled = true; msg.textContent = '';
      try {
        await toss.requestBillingAuth('카드', {
          customerKey: info.customerKey,
          successUrl: location.origin + '/payment/success?order=' + encodeURIComponent(order) + '&plan=' + encodeURIComponent(info.plan),
          failUrl: location.origin + '/payment/fail'
        });
      } catch (e) { console.error('카드 등록 에러:', e); if (e && e.code !== 'USER_CANCEL') msg.textContent = e.message || '카드 등록을 시작하지 못했습니다.'; btn.disabled = !agree.checked; }
    });
  } catch (e) { console.error(e); msg.textContent = '결제 정보를 불러오지 못했습니다: ' + (e && e.message ? e.message : e); }
})();
</script>`));
});

app.get('/payment/success', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(page('구독 확인 중', `<h1 id="t">카드를 확인하고 결제하고 있습니다…</h1><p id="d">창을 닫지 말고 잠시만 기다려 주세요.</p><button id="c" class="sub" hidden>창 닫기</button>`, `
<script>
(async () => {
  const q = new URLSearchParams(location.search), t = document.getElementById('t'), d = document.getElementById('d'), c = document.getElementById('c');
  c.onclick = () => window.close(); c.hidden = false;
  try {
    const r = await fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey: q.get('authKey'), customerKey: q.get('customerKey'), order: q.get('order'), plan: q.get('plan') }) });
    const j = await r.json();
    if (j.success) {
      t.textContent = '구독이 시작되었습니다'; t.className = 'ok'; d.textContent = '프리미엄이 적용되었습니다. 이 창을 닫고 Meow-PDF로 돌아가 주세요.';
      try { window.opener && window.opener.postMessage({ type: 'meow-paid', ok: true }, '*'); } catch (e) {}
      setTimeout(() => { try { window.close(); } catch (e) {} }, 2500);
    } else { t.textContent = '구독을 시작하지 못했습니다'; t.className = 'err'; d.textContent = j.message || '알 수 없는 오류'; }
  } catch (e) { t.textContent = '서버에 연결하지 못했습니다'; t.className = 'err'; d.textContent = '잠시 후 이 페이지를 새로고침해 주세요. 이미 결제가 완료된 경우 중복 결제되지 않습니다.'; }
})();
</script>`));
});

app.get('/payment/fail', (req, res) => {
  const esc = s => String(s || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  res.send(page('카드 등록 실패', `<h1 class="err">구독이 완료되지 않았습니다</h1><p>${esc(req.query.message) || '카드 등록이 취소되었거나 실패했습니다.'}</p><p>${esc(req.query.code)}</p><button class="sub" onclick="window.close()">창 닫기</button>`, ''));
});

// 화면 구성: public/index.html = 소개 페이지(/), public/edit.html = 편집 페이지(/edit, pdf-editor.html 을 그대로 복사)
app.get('/edit', (req, res) => res.sendFile(path.join(__dirname, 'public', 'edit.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Meow-PDF 결제 서버 실행 중: ${PUBLIC_BASE_URL}`);
  if (TOSS_SECRET_KEY.startsWith('test_')) console.log('• 토스페이먼츠 테스트 키 사용 중 (실제 결제 안 됨)');
  if (!ready()) console.warn('⚠ SUPABASE_SERVICE_ROLE_KEY 가 비어 있어서 결제를 시작할 수 없어요. .env 를 확인하세요.');
  if (!process.env.ORDER_SECRET) console.warn('⚠ ORDER_SECRET 을 .env 에 정해 두세요. (없으면 서버 재시작 시 진행 중이던 주문이 무효가 돼요)');
});

#!/usr/bin/env node
/* Meow-PDF: public/edit.html 의 APP_VERSION · CHANGELOG · 번역(I18N)으로 public/version.json 을 만들어요.
   데스크톱 앱은 이 파일(https://www.meow-pdf.com/version.json)을 읽어 새 버전과 바뀐 내용을 알려 줘요.
   새 버전을 낼 때마다 실행하세요:  node scripts/make-version-json.js  */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..'), EDIT = path.join(ROOT, 'public', 'edit.html'), OUT = path.join(ROOT, 'public', 'version.json');
const SITE = 'https://www.meow-pdf.com';
const html = fs.readFileSync(EDIT, 'utf8');

const ver = (/const APP_VERSION = '([^']+)'/.exec(html) || [])[1];
if (!ver) throw new Error('APP_VERSION 을 찾지 못했어요');
const cl0 = html.indexOf('const CHANGELOG = '); if (cl0 < 0) throw new Error('CHANGELOG 를 찾지 못했어요');
const clLine = html.slice(cl0, html.indexOf('\n', cl0));
const CHANGELOG = vm.runInNewContext(clLine.replace(/^const CHANGELOG = /, '(').replace(/;\s*$/, ')'));

/* 번역 사전: const I18N = … 부터 const i18n = (() => { 앞까지를 그대로 실행해요 */
let I18N = {};
try {
  const a = html.indexOf('const I18N = '), b = html.indexOf('const i18n = (() => {', a);
  const ctx = { safeStore: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} } };
  vm.runInNewContext(html.slice(a, b).replace(/^const I18N = /, 'var I18N = ') + '\n;this.__I = I18N;', ctx);
  I18N = ctx.__I || {};
} catch (e) { console.warn('번역 사전을 읽지 못했어요 (한국어만 넣어요):', e.message); }
const tr = (l, t) => (I18N[l] && typeof I18N[l][t] === 'string') ? I18N[l][t] : t;

const history = CHANGELOG.slice(0, 10).map(c => ({
  v: c.v, d: c.d,
  items: { ko: c.items, en: c.items.map(t => tr('en', t)), ja: c.items.map(t => tr('ja', t)), zh: c.items.map(t => tr('zh', t)) }
}));
const top = CHANGELOG[0];
if (top.v !== ver) console.warn(`주의: CHANGELOG 첫 버전(${top.v})이 APP_VERSION(${ver})과 달라요`);
const miss = ['en', 'ja', 'zh'].map(l => [l, top.items.filter(t => tr(l, t) === t).length]).filter(x => x[1]);
if (miss.length) console.warn('번역이 없는 변경 내역:', miss.map(x => x.join(' ')).join(', '));

const out = {
  name: 'Meow-PDF', version: ver, date: top.d, site: SITE + '/',
  download: { win: SITE + '/download/windows', mac: SITE + '/download/mac', linux: SITE + '/download/linux', page: SITE + '/#download' },
  history
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`version.json → ${ver} (${top.d}), 변경 내역 ${history.length}개 버전`);

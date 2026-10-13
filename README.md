# Meow-PDF 결제 서버

토스페이먼츠 결제위젯(팝업) + 승인 API + Supabase 권한 부여.
**시크릿 키는 이 서버(`server.js`/`.env`)에만 있어요. 앱(HTML)에는 두지 않아요.**

## 1. 준비
1. Node.js 18 이상
2. `npm install`
3. `.env.example` 을 `.env` 로 복사하고 채우기
   - `SUPABASE_SERVICE_ROLE_KEY` (필수): Supabase → Project Settings → API → *service_role* 키
   - `ORDER_SECRET`: 아무 긴 무작위 문자열
   - 토스 키는 비워 두면 공식 문서용 **테스트 키**가 쓰여요.
4. Supabase SQL Editor 에서 `supabase.sql` 실행 (is_paid / is_student 를 서버만 쓰게 잠가요)
5. `npm start`

## 2. 앱 연결
- 앱(`pdf-editor.html`)을 이 서버에서 같이 열려면 `public/index.html` 로 복사 → `http://localhost:3000`
- 다른 곳에서 열면(파일로 열기, GitHub Pages 등) 앱 코드의 `PAY_SERVER` 에 서버 주소를 넣어 주세요.

## 3. 결제 흐름
앱 → `POST /api/create-order`(로그인 토큰) → 결제 팝업 `/pay` (토스 결제위젯) → `/payment/success`
→ `POST /api/confirm-payment`(금액 3,900원 검증 → 토스 승인 → `users_profile.premium_until`(결제일 + 1년, 재결제 시 만료일부터 연장. 기존 `is_paid=true` 회원은 그대로 유지)) → 앱이 상태 새로고침.
- 가격(3,900원)은 서버가 정해요. 금액 위변조는 승인 전에 거절돼요.
- 권한 부여에 실패하면 결제를 자동 취소해요.
- 주문번호에 사용자 ID 와 서명이 들어 있어서, 남의 계정으로 위조할 수 없어요.

## 4. 테스트 결제
테스트 키로는 실제 돈이 빠지지 않아요. 결제창에서 카드번호는 토스 테스트 안내를 따르세요.

## 5. 실서비스 체크리스트
- [ ] 토스 **라이브 키**로 교체(`TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY`) — 사업자 심사 필요
- [ ] HTTPS 로 배포하고 `PUBLIC_BASE_URL`, `ALLOWED_ORIGINS` 설정
- [ ] `ORDER_SECRET` 고정, `.env` 는 git 에 올리지 않기
- [ ] 환불/이용약관/사업자 정보 고지 (전자상거래법)
- [ ] (권장) 토스 웹훅으로 취소/환불 시 `is_paid=false` 처리

## 이메일로 링크가 오고 인증번호가 안 올 때

앱은 인증번호(OTP)를 요청하지만, 메일에 숫자가 들어가는지는 **Supabase 메일 템플릿**이 정합니다.
기본 템플릿은 `{{ .ConfirmationURL }}`(로그인 링크)만 담고 있어서 링크가 옵니다.

1. Supabase 대시보드 → Authentication → Emails(Email Templates)
2. **Magic Link**와 **Confirm signup** 두 템플릿을 모두 열어 Subject를 `Meow-PDF 인증번호`로, Body를 `email-templates/otp.html` 내용으로 교체 후 저장
   (핵심은 `{{ .Token }}`이 들어 있고 `{{ .ConfirmationURL }}`은 없다는 점)
3. Authentication → Providers → Email에서 OTP 길이(기본 6자리)·만료 시간 확인
4. 기본 메일 발송은 시간당 발송 한도가 낮으니, 실서비스에서는 SMTP를 연결하세요.

## 이용 키 (개발자 발급 프리미엄)

개발자 계정(`DEV_EMAIL`)이 키를 발급하면, 키를 입력한 사용자는 **발급일로부터 3개월** 동안 프리미엄을 이용할 수 있습니다.

1. Supabase SQL Editor에서 `supabase.sql`을 다시 실행합니다. (`users_profile.premium_until`, `access_keys`, `key_redemptions` 추가)
2. `.env`에 `DEV_EMAIL`을 확인하고 서버를 재시작합니다. (`node server.js`)
3. 개발자 계정으로 로그인 → 계정 창 → "키 발급". 키는 발급 직후 한 번만 전체가 표시됩니다.
4. 사용자는 계정 창의 "이용 키"에 입력합니다. 한 키를 여러 사용자가 사용할 수 있습니다.
5. 만료일은 발급일 + 3개월이며, 늦게 입력하면 남은 기간만 적용됩니다.
6. 폐기하면 새로 입력하는 것만 막고, 이미 적용된 사용자의 기간은 유지됩니다.

보안: 서버에는 키의 해시와 끝 4자리만 저장하며, 입력 시도는 IP당 분당 8회로 제한됩니다. 발급·조회·폐기는 서버가 로그인 토큰의 이메일(인증 완료)을 검증해 개발자 계정만 허용합니다.

발급 내역에서 키 전체를 다시 볼 수 있습니다. 키는 서버가 `SUPABASE_SERVICE_ROLE_KEY`(또는 `KEY_ENC_SECRET`)로 암호화해 `access_keys.key_enc`에 저장하며, 이 값이 바뀌면 이전 키 원문은 복호화되지 않습니다. 이 기능을 넣기 전에 발급한 키는 끝 4자리만 보입니다.

## 고객센터 (불편사항 · 의견 접수)

앱의 설정 창(톱니바퀴) → "정보 · 고객센터"에서 누구나 접수할 수 있고, 로그인한 경우 계정 이메일이 함께 기록됩니다.

1. Supabase SQL Editor에서 `supabase.sql`을 다시 실행합니다. (`feedback` 테이블 추가)
2. 서버를 재배포합니다.
3. 개발자 계정으로 로그인하면 설정 창에 "고객 문의 관리" 메뉴가 나타납니다. 상태(신규 / 처리 중 / 완료) 변경, 메모, 삭제, 검색, CSV 내보내기를 할 수 있습니다.

API: `POST /api/feedback`(공개, IP당 10분에 5건), `GET /api/dev/feedback`, `POST /api/dev/feedback-update`, `POST /api/dev/feedback-delete`(개발자 전용). DB 테이블은 정책 없이 RLS만 켜 두어 서버(service_role)만 접근합니다.


## 화면 주소 구성 (v0.5.1)

| 주소 | 파일 | 설명 |
| --- | --- | --- |
| `/` | `public/index.html` | 서비스 소개 페이지 (`landing.html` 과 동일) |
| `/edit` | `public/edit.html` | PDF 편집 화면 (`pdf-editor.html` 을 그대로 복사) |
| `/assets/editor.webp` | `public/assets/` | 소개 페이지의 편집 화면 이미지 |

- 편집기를 수정하면 `pdf-editor.html` 을 `public/edit.html` 로 복사하세요. (예전처럼 `index.html` 로 복사하면 소개 페이지가 덮어써집니다.)
- `meow-pdf.com` 도메인은 Render 대시보드의 Settings → Custom Domains 에 추가하고, 도메인 업체의 DNS 에 Render 가 안내하는 레코드를 등록하세요. 연결 후 `PUBLIC_BASE_URL` 을 `https://meow-pdf.com` 으로 바꾸면 결제 안내 주소도 새 도메인을 씁니다.

## Vercel 로 배포하는 경우

- 이 폴더(`public`)의 파일은 정적 파일이라 Vercel 에도 올릴 수 있습니다. `/edit` 주소가 `edit.html` 로 연결되려면 `vercel.json` 의 `"cleanUrls": true` 설정이 필요합니다.
- 프로젝트의 Root Directory 를 `public` 으로 두었다면 `public/vercel.json` 을, 이 폴더 전체를 올렸다면 바로 위 `vercel.json` 을 사용하세요. (Root 에 두는 파일은 `outputDirectory` 가 `public` 으로 지정되어 있습니다.)
- 결제, 이용 키, 고객센터 같은 `/api` 기능은 Express 서버(`server.js`)가 필요하므로 Render 에서 계속 실행되어야 합니다. 편집기의 `PAY_SERVER` 값이 이미 Render 주소(`https://meow-pdf.onrender.com`)로 지정되어 있어서, 다른 도메인에서 열어도 그 서버로 연결됩니다.


## 페이지 번역 (v0.5.3)

- 편집기의 번역 버튼은 먼저 Chrome 내장 번역(Translator API, 기기에서 처리)을 사용합니다. 이 경우 서버 설정은 필요 없습니다.
- Chrome 내장 번역을 쓸 수 없는 경우(Safari, Firefox, 모바일 Chrome, 지원하지 않는 언어 조합 등)에는 서버 번역으로 대체됩니다. **키를 설정하지 않아도** 무료 엔진(MyMemory, 익명 하루 약 5천 자, `MYMEMORY_EMAIL` 또는 `DEV_EMAIL` 을 보내면 약 5만 자)이 동작하지만 품질과 사용량에 한계가 있습니다. 더 좋은 품질이 필요하면 `.env` 에 아래 중 **하나**를 넣으세요. (키는 서버에만 보관하며 앱 HTML 에는 들어가지 않습니다.)
  - `DEEPL_API_KEY` : DeepL API 키 (무료 키는 `:fx` 로 끝남)
  - `GOOGLE_TRANSLATE_API_KEY` : Google Cloud Translation API 키
- 엔드포인트: `POST /api/translate` — `{ texts: [...], source, target }`. IP당 분당 12회, 한 번에 120문장 · 2만 자까지로 제한됩니다. 서버가 이 기능이 없는 이전 버전이면 앱에 "서버를 최신 버전으로 다시 배포해 주세요"라는 안내가 표시됩니다.
- 번역 API 는 사용량만큼 요금이 나올 수 있으니 공급자 콘솔에서 월 한도를 설정해 두세요.

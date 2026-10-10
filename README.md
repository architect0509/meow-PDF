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
→ `POST /api/confirm-payment`(금액 3,900원 검증 → 토스 승인 → `users_profile.is_paid=true`) → 앱이 상태 새로고침.
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

개발자 계정(`DEV_EMAIL`, 기본 architect05092@gmail.com)이 키를 발급하면, 키를 입력한 사용자는 **발급일로부터 3개월** 동안 프리미엄을 이용할 수 있습니다.

1. Supabase SQL Editor에서 `supabase.sql`을 다시 실행합니다. (`users_profile.premium_until`, `access_keys`, `key_redemptions` 추가)
2. `.env`에 `DEV_EMAIL`을 확인하고 서버를 재시작합니다. (`node server.js`)
3. 개발자 계정으로 로그인 → 계정 창 → "키 발급". 키는 발급 직후 한 번만 전체가 표시됩니다.
4. 사용자는 계정 창의 "이용 키"에 입력합니다. 한 키를 여러 사용자가 사용할 수 있습니다.
5. 만료일은 발급일 + 3개월이며, 늦게 입력하면 남은 기간만 적용됩니다.
6. 폐기하면 새로 입력하는 것만 막고, 이미 적용된 사용자의 기간은 유지됩니다.

보안: 서버에는 키의 해시와 끝 4자리만 저장하며, 입력 시도는 IP당 분당 8회로 제한됩니다. 발급·조회·폐기는 서버가 로그인 토큰의 이메일(인증 완료)을 검증해 개발자 계정만 허용합니다.

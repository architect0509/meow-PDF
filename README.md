# Meow-PDF

브라우저에서 바로 쓰는 PDF 편집기입니다. 파일 하나(`pdf-editor.html`)로 동작하며, 설치 없이 열어서 PDF 텍스트를 고치고, 그리고, 합치고, 내보낼 수 있습니다. 한국어 UI, 다크 모드 기본, 앰버(`#dbbe43`) 포인트 컬러를 사용합니다.

> 라이브: https://meow-pdf.onrender.com

## 주요 기능

**편집**
- 선택 · 텍스트 · 펜 · 형광펜 · 선 · 도형 · 지우개 · 이미지 삽입
- PDF 안의 기존 글자를 눌러 바로 수정 (글꼴, 크기, 굵게/기울임, 글자색, 배경색)
- 음성 녹음을 페이지에 넣기
- 실행 취소 / 다시 실행, 단축키 지원

**문서 관리**
- 여러 문서를 탭으로 열기, 멀티작업 패널(PDF · 이미지 · 텍스트 · HWP · PPTX · DOCX 보기)
- 페이지 썸네일 사이드바, 전체 페이지 관리(순서 변경 · 삭제 · 회전)
- PDF 병합, 압축
- 내 PDF 안에서 검색, 책갈피, 페이지 주석 · 목록 보기, 인쇄
- 열기: PDF · MPDF · PPTX · HWP · 이미지 / 내보내기: PDF, MPDF(편집 가능 상태 유지), PPTX(페이지당 슬라이드 한 장)

**모바일 (화면 폭에 따라 자동 전환)**
- 한 화면에 한 페이지, 최소한의 도구만 표시. 레이어 · 노트 · 멀티작업은 숨김
- 상단에 편집 도구, 하단에 페이지 썸네일 패널과 페이지 이동 막대
- PDF 글자를 한 번 눌러 바로 수정. 옵션바는 페이지를 가리지 않게 아래에 떠 있고, 도구를 바꿔도 페이지 크기가 변하지 않음
- 두 손가락으로 확대 · 축소 · 이동 (모든 도구), 맞춤 크기에 가까워지면 자동으로 맞춤
- 한 손가락으로 끌어 페이지 넘기기(옆 페이지가 따라옴), 그리기 도구에서는 두 손가락 가로 스와이프

## 프리미엄

다음 중 하나에 해당하면 프리미엄 기능(전체 페이지 관리, 압축, PPTX 내보내기, 음성 녹음 등)을 쓸 수 있습니다.

1. 인증된 대학 이메일(`.ac.kr` / `.edu`)로 로그인
2. 결제 (토스페이먼츠, 서버가 금액을 검증)
3. 개발자가 발급한 **이용 키** 입력 (발급일로부터 3개월, 한 키를 여러 명이 사용 가능)
4. 개발자 계정

## 구성

| 구분 | 내용 |
| --- | --- |
| 앱 | 단일 HTML 파일, 순수 JS. pdf.js, pdf-lib, JSZip, lamejs(인라인), supabase-js · PptxGenJS(필요할 때 로드) |
| 서버 | Express (`meow-pdf-server/`). 결제, 이용 키 발급 · 조회 · 폐기, 키 입력 처리 |
| 계정 / DB | Supabase (이메일 인증번호 로그인, `users_profile`, `access_keys`, `key_redemptions`) |
| 배포 | Render (서버가 앱 `public/index.html` 도 함께 제공) |

민감한 정보(서비스 키, 토스 시크릿 등)는 서버의 `.env` 에만 있고 앱 HTML에는 들어 있지 않습니다.

## 실행

```bash
cd meow-pdf-server
npm install
cp .env.example .env     # 값 채우기
npm start                # http://localhost:3000
```

1. Supabase SQL Editor에서 `supabase.sql` 실행
2. 앱을 서버에서 열려면 `pdf-editor.html` 을 `public/index.html` 로 복사
3. 다른 곳에서 앱을 열 때는 앱 코드의 `PAY_SERVER` 에 서버 주소 입력

환경 변수: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ORDER_SECRET`, `DEV_EMAIL`, `KEY_ENC_SECRET`(선택), `PUBLIC_BASE_URL`, `ALLOWED_ORIGINS`, `TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY`

자세한 서버 설정, 결제 흐름, 이용 키 사용법은 `meow-pdf-server/README.md` 를 참고하세요.

## 이용 키 사용 흐름

1. 개발자 계정으로 로그인 → 계정 창 → 키 발급 (`MEOW-XXXX-XXXX-XXXX-XXXX`)
2. 사용자가 계정 창의 "이용 키"에 입력
3. 만료일은 발급일 + 3개월. 폐기하면 새 입력만 막고 이미 적용된 기간은 유지

## 참고

- Render 무료 플랜은 한동안 접속이 없으면 서버가 잠들어, 첫 요청에 수십 초가 걸릴 수 있습니다.
- 암호가 걸린 PDF와 배포용 HWP는 열 수 없습니다. 예전 `.ppt` 형식은 `.pptx` 로 저장한 뒤 사용하세요.
- 서버는 서비스 키와 `ORDER_SECRET` 을 외부에 노출하지 마세요. `.env` 는 git 에 올리지 않습니다.

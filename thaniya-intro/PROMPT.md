# AI에게 보낼 프롬프트

이 폴더(thaniya-intro)의 파일을 모두 첨부하고, 대괄호 부분만 채워서 보내세요.

```
첨부한 thaniya-intro 패키지(thaniya-intro.js, intro-logo.webp, README.md, demo.html)를
내 프로그램에 로고 인트로로 넣어 줘.

[내 프로그램]
- 종류/프레임워크: [예: React + Vite 웹앱 / Next.js App Router / Electron 데스크톱 앱 / 일반 HTML 사이트]
- 인트로를 띄울 화면: [예: 첫 화면(메인 페이지)만 / 앱을 켤 때마다]
- 로고 아래 글자: THANIYA PROJECT

[지켜야 할 것]
1. thaniya-intro.js 와 intro-logo.webp 는 수정하지 말고 그대로 써. 두 파일은 같은 폴더에 둬.
   (정적 파일 폴더, 예: public/thaniya-intro/)
2. README.md 의 "5. 프로그램별로 넣는 곳"에서 내 프로그램에 맞는 방법을 따라.
   화면보다 인트로가 먼저 떠야 하니 <head> 맨 위쪽(앱 번들보다 먼저)에서 불러와.
3. 인트로가 도는 동안 다른 팝업(쿠키 배너, 공지, 튜토리얼 등)이 위에 뜨지 않게 해.
   <html> 에 th-intro 클래스가 있으면 'thaniyaintroend' 이벤트를 기다렸다가 띄우도록 연결해.
4. 로고 그림은 바꾸지 마. 설계선(축 · 치수 · 초점 · 25° 각도)이 이 로고 모양에 맞춰 계산돼 있어.
5. 사이트에 Content-Security-Policy 가 있으면 style-src 에 'unsafe-inline' 또는 nonce 를 추가해.
6. Electron/웹뷰 앱이면 창 배경을 검정(#000000)으로 하고 준비된 뒤 보여 줘서 흰 화면이 깜빡이지 않게 해.

[결과로 줄 것]
- 바꾸거나 추가한 파일 목록과 각 변경 내용
- 동작 확인 방법: 새로고침하면 인트로가 먼저 뜨는지, 클릭하면 건너뛰는지, 끝나면 원이 퍼지며 화면이 나오는지
```

같은 탭에서 한 번만 보이게 하려면 3번 아래에 추가:
"<script> 태그에 data-once=\"session\" 을 넣어 같은 탭에서는 한 번만 보이게 해 줘."

## 파일 설명

| 파일 | 꼭 보내기 | 설명 |
|---|---|---|
| thaniya-intro.js | ✅ | 인트로 전체 코드 (CSS · 마크업 · 동작) |
| intro-logo.webp | ✅ | 인트로에 쓰이는 로고 그림 (투명 배경 660×660) |
| README.md | ✅ | 설치 가이드 (프로그램별 넣는 곳, 옵션) |
| demo.html | 권장 | 동작하는 최소 예제 |
| logo-original.png | 선택 | 원본 로고 (참고용 · 인트로에는 쓰지 않음) |
| PROMPT.md | — | 이 문서 (AI에게 붙여 넣을 프롬프트) |

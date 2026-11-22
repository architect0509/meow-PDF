# Thaniya Intro — 어디에나 넣는 로고 인트로

검은 화면 위에 설계도를 그리며 로고를 두 단계(01 STAR → 02 ORBIT)로 조립하고, 가운데서 원이 퍼지며 내 화면으로 이어지는 약 4.5초짜리 인트로입니다. 따로 설치할 라이브러리는 없고, 파일 두 개만 있으면 됩니다.

## 1. 들어 있는 파일

| 파일 | 설명 |
|---|---|
| `thaniya-intro.js` | 인트로 전체 (CSS · 마크업 · 동작이 한 파일, 약 24KB) |
| `intro-logo.webp` | 로고 그림 (투명 배경, 약 10KB) |
| `demo.html` | 바로 열어 보는 예제 |

`thaniya-intro.js`와 `intro-logo.webp`는 **같은 폴더**에 두세요. 그러면 로고 경로를 따로 적지 않아도 됩니다.

## 2. 가장 빠른 방법 (모든 웹 페이지)

`<head>`의 **맨 위쪽**에 한 줄을 넣습니다. 위에 둘수록 내 화면보다 먼저 뜹니다.

```html
<head>
  <meta charset="utf-8">
  <script src="/thaniya-intro/thaniya-intro.js" data-text="THANIYA PROJECT"></script>
  ...
</head>
```

이게 전부입니다. 페이지를 열 때마다 인트로가 먼저 나오고, 끝나면 원이 퍼지며 페이지가 드러납니다.

## 3. 옵션

`<script>` 태그의 `data-*` 속성이나 `ThaniyaIntro.play({...})`의 값으로 바꿉니다.

| data 속성 | play() 옵션 | 기본값 | 설명 |
|---|---|---|---|
| `data-text` | `text` | `THANIYA PROJECT` | 로고 아래 글자. 빈 값이면 글자 없음 |
| `data-logo` | `logo` | 스크립트 옆 `intro-logo.webp` | 로고 그림 주소 |
| `data-color` | `color` | `#f7bb0e` | 설계선 · 빛 · 충격파 색 (로고 그림 색은 그대로) |
| `data-once` | `once` | `always` | `session`이면 같은 탭에서 한 번만 |
| `data-skip` | `skip` | `true` | `false`면 클릭 · 키 입력으로 건너뛸 수 없음 |
| `data-z` | `zIndex` | `2147483600` | 다른 팝업보다 위/아래로 조정할 때 |
| `data-auto` | — | `true` | `false`면 자동 재생하지 않고 `play()`를 부를 때만 |

## 4. 코드로 직접 실행 · 끝나는 시점 잡기

```js
// 원하는 때 재생 — 끝나면 Promise 가 풀려요 (once:'session' 으로 이미 봤으면 false)
await ThaniyaIntro.play({ text: 'THANIYA PROJECT', once: 'session' });

// 또는 이벤트로
document.addEventListener('thaniyaintroend', () => {
  // 쿠키 배너 · 공지 창 · 튜토리얼처럼 인트로 뒤에 띄울 것
});
```

인트로가 도는 동안에는 `<html>`에 `th-intro` 클래스가 붙어 있습니다. 다른 팝업이 인트로 위에 겹치지 않게 하려면 이렇게 확인하세요.

```js
if (document.documentElement.classList.contains('th-intro')) {
  document.addEventListener('thaniyaintroend', showMyPopup, { once: true });
} else showMyPopup();
```

## 5. 프로그램별로 넣는 곳

**순수 HTML · 정적 사이트 (Vercel, GitHub Pages 등)**
두 파일을 `public/` 같은 정적 폴더에 넣고 2번처럼 `<head>`에 한 줄.

**React (Vite · CRA)**
`public/thaniya-intro/`에 두 파일을 넣고, `index.html`의 `<head>` 맨 위에 2번의 한 줄을 넣습니다. 앱 번들보다 먼저 실행돼 첫 화면이 깜빡이지 않습니다. 특정 시점에만 띄우려면 `data-auto="false"`로 넣고 컴포넌트에서 부르세요.
```jsx
useEffect(() => { window.ThaniyaIntro?.play(); }, []);
```

**Next.js (App Router)**
`public/thaniya-intro/`에 두 파일을 넣고 `app/layout.tsx`에:
```tsx
import Script from 'next/script';
export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>
        <Script src="/thaniya-intro/thaniya-intro.js" strategy="beforeInteractive"
                data-text="THANIYA PROJECT" data-logo="/thaniya-intro/intro-logo.webp" />
        {children}
      </body>
    </html>
  );
}
```
(Pages Router는 `pages/_document.tsx`의 `<Head>` 안에 일반 `<script>`로 넣으면 됩니다.)

**Vue (Vite) · Svelte · Angular**
React와 같이 `public/`에 두고 `index.html`의 `<head>`에 한 줄. Nuxt는 `nuxt.config`의 `app.head.script`에
`{ src: '/thaniya-intro/thaniya-intro.js', 'data-text': 'THANIYA PROJECT' }`.

**Electron · Tauri · 웹뷰 앱 (Meow-PDF 데스크톱 포함)**
창에 띄우는 HTML(렌더러)의 `<head>`에 한 줄. 파일로 여는 앱이면 상대 경로로 적으세요(`src="./thaniya-intro/thaniya-intro.js"`).
창이 흰색으로 먼저 깜빡이면 `new BrowserWindow({ backgroundColor: '#000000', show: false })` 로 만들고 `ready-to-show`에서 `win.show()` 하세요.

**모바일 앱 웹뷰 (Android WebView · iOS WKWebView)**
웹뷰가 여는 페이지의 `<head>`에 한 줄. 네이티브 스플래시 화면을 검정으로 맞추면 이음새가 없습니다.

## 6. 알아 둘 점

- **로고 전용 설계**: 별 · 궤도 작도선(축, 치수, 초점, 25° 각도)은 이 로고 모양에 맞춰 계산돼 있습니다. 다른 로고 그림으로 바꾸면 선이 맞지 않으니, 그때는 그 로고에 맞춰 다시 만들어야 합니다.
- **건너뛰기**: 클릭 · 터치 · 키 입력 · 휠로 0.3초 만에 넘어갑니다. 무슨 일이 있어도 6.5초 안에 닫힙니다.
- **동작 줄이기**: 기기에서 ‘동작 줄이기’를 켠 사람에게는 흔들림 · 섬광 없이 로고만 부드럽게 나오는 2.4초 버전이 나옵니다.
- **오래된 브라우저**: `@property`를 지원하지 않는 브라우저(예: iOS 16.3 이하 사파리)에서는 쓸어 도는 효과와 원형 전환 대신 페이드로 바뀝니다.
- **CSP**: 사이트에 Content-Security-Policy가 있으면 `style-src`에 `'unsafe-inline'`(또는 nonce)이 필요합니다. 인트로가 `<style>`을 넣기 때문입니다.
- **스크롤**: 인트로가 도는 동안에는 페이지 스크롤이 잠기고, 끝나면 풀립니다.

## 7. 지원

Chrome · Edge · Firefox · Safari 최신 버전, Android · iOS 모바일 브라우저.

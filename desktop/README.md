# Meow-PDF 데스크톱 앱

Windows · macOS · Linux용 Meow-PDF 프로그램 (Electron).

- 실행하면 소개 페이지 없이 바로 편집 화면(`https://www.meow-pdf.com/edit`)을 엽니다.
- 편집 화면 파일은 빌드할 때 `../public` 을 `app/` 으로 복사해 앱 안에 넣은 것을 씁니다. 그래서 인터넷 없이도 열리고, 버전은 설치한 버전 그대로입니다. 주소가 사이트와 같아서 로그인 · 결제 · 공유작업 같은 서버 기능은 그대로 동작합니다.
- pdf.js · pdf-lib · jszip · supabase 라이브러리도 빌드할 때 `app/vendor/` 에 받아 넣어 오프라인에서 씁니다.
- 새 버전 확인은 `https://www.meow-pdf.com/version.json`, 자동 업데이트는 GitHub Releases(electron-updater)를 씁니다.

```bash
npm install
npm start          # 개발 실행
npm run dist       # 설치 파일 만들기 (dist/)
```

배포는 저장소 루트 README의 ‘새 버전 내보내기’를 따르세요. 앱 버전은 `public/edit.html` 의 `APP_VERSION` 에 자동으로 맞춰집니다.

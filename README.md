# 텔레그램 자동 블로그 파이프라인 설정 가이드

`/post [내용]` 텔레그램 메시지 → Claude가 다듬어서 → GitHub 커밋 → Vercel 자동 배포

이미 완료됨:
- 텔레그램 봇 생성 (`dong_geon_bot`)
- 봇 토큰, chat_id 확보

앞으로 순서대로 진행하면 됨.

---

## 1. GitHub 저장소 만들기

1. https://github.com/new 접속
2. 저장소 이름 정하기 (예: `dongun-blog`), Private/Public 아무거나 상관없음
3. 이 프로젝트 폴더(`dongun-blog`) 전체를 그 저장소에 push

```bash
cd dongun-blog
git init
git add .
git commit -m "init: astro blog + telegram pipeline"
git branch -M main
git remote add origin https://github.com/본인아이디/dongun-blog.git
git push -u origin main
```

## 2. GitHub Personal Access Token 발급 (커밋 자동화용)

1. https://github.com/settings/tokens → "Generate new token (classic)"
2. 권한: `repo` 체크
3. 생성된 토큰 복사해두기 (한 번만 보여짐)

## 3. Anthropic API 키 발급 (글 다듬기용)

1. https://console.anthropic.com → API Keys → 새 키 생성
2. 이건 지금 Claude.ai 대화와는 별개로, 실제 운영 서버가 쓸 키

## 4. Vercel에 프로젝트 연결

1. https://vercel.com 가입 (GitHub 계정으로 로그인 추천)
2. "Add New Project" → 방금 만든 GitHub 저장소 선택 → Import
3. Framework Preset: Astro 자동 인식됨 → Deploy

배포되면 `https://프로젝트명.vercel.app` 같은 무료 주소가 생김. 이 주소를 아래 SITE_URL에 사용.

## 5. Vercel 환경변수 등록

Vercel 프로젝트 → Settings → Environment Variables 에서 아래 7개 등록:

| 이름 | 값 |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather가 준 토큰 |
| `TELEGRAM_CHAT_ID` | `8720450813` |
| `TELEGRAM_WEBHOOK_SECRET` | 아무 랜덤 문자열 직접 정하기 (예: `dg-secret-2026-xyz`) |
| `ANTHROPIC_API_KEY` | 3번에서 발급받은 키 |
| `GITHUB_TOKEN` | 2번에서 발급받은 토큰 |
| `GITHUB_REPO` | `본인깃허브아이디/dongun-blog` |
| `GITHUB_BRANCH` | `main` |
| `SITE_URL` | `https://프로젝트명.vercel.app` (4번에서 확인한 주소) |

등록 후 Deployments 탭에서 "Redeploy" 한 번 눌러서 환경변수 반영.

## 6. 텔레그램 웹훅 등록 (딱 한 번만 하면 됨)

터미널이나 브라우저 주소창에 아래 URL 접속 (본인 값으로 치환):

```
https://api.telegram.org/bot<봇토큰>/setWebhook?url=https://<프로젝트명>.vercel.app/api/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET에_적은_값>
```

`{"ok":true,"result":true,...}` 응답이 뜨면 성공.

## 7. 테스트

텔레그램에서 `dong_geon_bot`과의 대화창에:

```
/post 오늘 중국 부품 소싱 회의했다. 리스크 두 개 짚었음.
```

전송 → "포스팅 준비 중..." → 1~2분 후 "포스팅 완료" + 링크 도착하면 성공.

---

## 웹서치 기능

`/post` 뒤에 최신 정보가 필요한 요청(예: "요즘 부동산 시황 정리해줘", "이번주 KBO 순위 정리해줘")을 보내면
Claude가 자동으로 웹서치를 해서 그 내용을 반영해 글을 써줌. 이미 겪은 일을 그대로 적은 메모는
평소처럼 검색 없이 문장만 다듬어짐 — 요청 내용에 따라 자동으로 판단.

검색을 쓰면 API 호출당 비용이 약간 더 붙지만(호출 1회당 몇십 원 이내 수준), 크게 부담될 정도는 아님.

## 로컬 개발 (선택)

```bash
npm install
npm run dev       # http://localhost:4321 에서 미리보기
npm run build     # 정적 빌드 (dist/ 생성, 빌드 테스트 완료됨)
```

## 폴더 구조

```
dongun-blog/
├── src/
│   ├── content/blog/     ← 포스트 마크다운 파일들 (자동으로 여기 쌓임)
│   ├── layouts/          ← 페이지 레이아웃
│   └── pages/            ← index, [...slug] 라우팅
├── api/
│   └── telegram-webhook.js  ← 핵심 파이프라인 로직
└── astro.config.mjs
```

## 나중에 도메인 연결하고 싶을 때

Vercel 프로젝트 → Settings → Domains → 구매한 도메인 입력 → 안내에 따라 DNS 설정.
연결 후 `SITE_URL` 환경변수도 새 도메인으로 업데이트하고 Redeploy 필요.

클로드 코드 연동 테스트 완료

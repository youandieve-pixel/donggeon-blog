# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A statically-generated Astro blog ("탑건 부동산") that is authored almost entirely through a Telegram bot instead of by hand. The repo has two halves that must be understood together:

1. **`src/`** — an Astro static site (`output: 'static'`) that renders Markdown posts from a content collection.
2. **`api/telegram-webhook.js`** — a Vercel serverless function that receives a Telegram `/post` command, has Claude write the actual post, and commits the resulting Markdown (and optional image) straight to this repo via the GitHub Contents API. Pushing to `main` triggers Vercel to rebuild and redeploy the site automatically.

There is no CMS and no admin UI — new posts arrive as commits from the webhook (or are added by hand as `.md` files under `src/content/blog/`).

## Commands

```bash
npm install
npm run dev       # http://localhost:4321
npm run build     # static build -> dist/
npm run preview   # serve the built output locally
```

There is no lint, format, or test setup in this repo — don't assume one exists.

## Required workflow before committing

Node/npm availability is session-dependent — don't assume `node`/`npm` are missing just because a prior session in this project couldn't find them; run `node -v` fresh each session to check.

When Node.js is available, follow this sequence for every code change in this repo, in order:

1. Edit the file(s).
2. Run `npm run build` and confirm it completes with no build errors.
3. For logic that a build can't verify — date/time math, JSON parsing/fallback behavior, anything in `api/telegram-webhook.js` that isn't exercised by the Astro build — run that logic in isolation with `node -e "..."` and inspect the actual printed output, don't just eyeball the code.
4. Only `git commit` and `push` after both checks above pass.
5. If the build fails or a `node -e` check prints something unexpected, stop — do not push. Explain the failure/discrepancy first and wait before proceeding.

If Node truly isn't available in the current session (checked and confirmed missing), say so explicitly and fall back to careful manual review plus checking the live deployed site, rather than silently skipping verification.

## Architecture

### Content model
- The `blog` collection is defined in [src/content/config.ts](src/content/config.ts). `category` is a **strict enum**: `real-estate | stocks | economy | tips`.
- Human-readable category labels/ordering live in [src/lib/categories.js](src/lib/categories.js) (`CATEGORIES`, `categoryLabel`). This is the single source of truth for category display and is imported by the home page, category pages, and layout nav.
- **These two category lists, plus the `validCategories` fallback list inside `api/telegram-webhook.js`, must all stay in sync** — there's no shared import between the Astro app and the serverless function (different runtimes/deploy targets), so adding/renaming a category means editing all three by hand.

### Pages
- [src/pages/index.astro](src/pages/index.astro) — home page: most recent post is "featured", then up to 3 posts per category pulled from `CATEGORIES`, sections with zero posts are hidden.
- [src/pages/category/[category].astro](src/pages/category/[category].astro) — one static page per category via `getStaticPaths` over `CATEGORIES`.
- [src/pages/blog/[...slug].astro](src/pages/blog/[...slug].astro) — post detail page, statically generated from all collection entries.
- [src/layouts/BaseLayout.astro](src/layouts/BaseLayout.astro) — shared shell (fonts, CSS variables/theme, masthead, category nav, tag ticker, footer). Site title/branding is hardcoded inline in multiple places here (`<title>`, masthead `<h1>`, footer) rather than centralized in one constant — when rebranding, grep for the site name across this file and `[...slug].astro`'s byline.

### Telegram → post pipeline (`api/telegram-webhook.js`)
Single-file Vercel Node function, no framework. Flow for an incoming Telegram message:
1. Verify `x-telegram-bot-api-secret-token` header against `TELEGRAM_WEBHOOK_SECRET`, and sender `chat.id` against `TELEGRAM_CHAT_ID` (single-user whitelist).
2. Require the message to start with `/post`; text can also come from a photo's `caption`.
3. Detect an `AI이미지` keyword to request an AI-generated cover image (strips the keyword from the content).
4. Call the Claude API (`polishWithClaude`) with a system prompt that: keeps personal anecdotes factual/unembellished but uses the `web_search` tool when the request needs current info (prices, rankings, news), and returns a single JSON object (`title`, `description`, `tags`, `body`, `imagePrompt`, `category`).
5. Resolve a cover image: user-attached photo (downloaded from Telegram) takes priority, otherwise an AI image via Pollinations if requested, otherwise none.
6. Commit the image (if any) and the generated Markdown file (with frontmatter matching the content-collection schema) to GitHub via the Contents API (`putToGithub`) — this push is what triggers the Vercel rebuild.
7. Reply to the Telegram chat with a status message and the eventual post URL (built from `SITE_URL`).

Required Vercel environment variables: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BRANCH`, `SITE_URL`. None of these are present in the repo (as expected) — see [README.md](README.md) for full setup steps (bot creation, webhook registration, Vercel env var registration).

### Deploy
- Hosted on Vercel; every push to `main` (including the ones the webhook makes) triggers a redeploy.
- `astro.config.mjs`'s `site` value is a placeholder (`https://your-project.vercel.app`) and does not reflect the real deployed URL — don't treat it as authoritative.

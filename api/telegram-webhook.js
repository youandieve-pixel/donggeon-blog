// Vercel Serverless Function
// 텔레그램 /post 명령어 수신 -> Claude API로 다듬기(+웹서치) -> 이미지 처리 -> GitHub 커밋 -> 자동 배포
//
// 필요한 환경변수 (Vercel 프로젝트 Settings > Environment Variables 에 등록):
//   TELEGRAM_BOT_TOKEN      : BotFather에서 발급받은 토큰
//   TELEGRAM_CHAT_ID        : 본인 chat_id (허용된 사람만 포스팅 가능하게 하는 화이트리스트)
//   TELEGRAM_WEBHOOK_SECRET : 텔레그램 웹훅 검증용 임의의 문자열
//   ANTHROPIC_API_KEY       : 본인 Claude API 키
//   GITHUB_TOKEN            : GitHub Personal Access Token (repo 쓰기 권한)
//   GITHUB_REPO             : "아이디/저장소명" 형식
//   GITHUB_BRANCH           : 기본 브랜치명 (보통 "main")
//   SITE_URL                : 배포된 사이트 주소
//
// 선택 환경변수 (update_id 중복 요청 방지용 - 없으면 dedup 없이 동작):
//   KV_REST_API_URL / KV_REST_API_TOKEN             : Vercel KV (Upstash Redis) REST 접속 정보
//   (또는) UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//
// 사용법:
//   /post 텍스트만                       -> 이미지 없이 포스팅
//   /post 텍스트 (사진 첨부해서 캡션으로) -> 첨부한 사진이 글 대표 이미지로 삽입
//   /post 텍스트 AI이미지                -> 내용 기반으로 AI가 대표 이미지 자동 생성해서 삽입
//
// 응답 지연 방지: 텔레그램은 웹훅이 몇 초 안에 200을 응답하지 않으면 같은 업데이트를 재전송한다.
// Claude 호출+웹서치+이미지 생성+GitHub 커밋까지 합치면 수십 초가 걸릴 수 있어서, 예전에는 그 전체가
// 끝난 뒤에야 응답했고 그 사이 텔레그램이 같은 메시지를 여러 번 재전송해 글이 중복 생성됐다.
// 지금은 인증/파싱/dedup 체크까지만 동기로 끝내고 즉시 200을 응답한 뒤, 무거운 처리는
// @vercel/functions의 waitUntil로 응답 이후에도 계속 실행되게 분리했다.
// waitUntil이 응답 이후 실행을 실제로 보장하려면 Vercel 프로젝트에 Fluid Compute가 켜져 있어야 한다
// (Vercel이 새 프로젝트에 기본으로 켜주는 설정). 혹시 "포스팅 완료" 메시지가 끝까지 오지 않는다면
// Vercel 프로젝트 Settings > Functions에서 Fluid Compute 활성화 여부를 확인할 것.

import { waitUntil } from '@vercel/functions';

export const config = { runtime: 'nodejs', maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
  if (secretHeader !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  const body = req.body;
  const message = body?.message;
  const updateId = body?.update_id;

  if (!message) {
    return res.status(200).send('ignored');
  }

  // 사진과 함께 온 메시지는 text가 아니라 caption 필드에 글자가 들어있음
  const rawText = (message.text || message.caption || '').trim();
  const photos = message.photo; // 여러 해상도 배열, 마지막이 제일 고화질

  if (!rawText) {
    return res.status(200).send('ignored');
  }

  const chatId = String(message.chat.id);

  if (chatId !== process.env.TELEGRAM_CHAT_ID) {
    await sendTelegram(chatId, '권한이 없습니다.');
    return res.status(200).send('unauthorized user');
  }

  if (!rawText.startsWith('/post')) {
    return res.status(200).send('ignored');
  }

  let rawContent = rawText.replace(/^\/post\s*/, '').trim();

  if (!rawContent && !photos) {
    await sendTelegram(chatId, '/post 뒤에 내용을 입력해줘. 예: /post 오늘 있었던 일...');
    return res.status(200).send('empty content');
  }

  // update_id 기반 중복 요청 방지. 서버리스 인스턴스는 매번 새로 뜰 수 있어 메모리 변수로는
  // 신뢰할 수 없으므로, 외부 저장소(Vercel KV/Upstash Redis)에 SET NX EX로 짧게 마킹해둔다.
  if (updateId !== undefined) {
    const duplicate = await isDuplicateUpdate(updateId);
    if (duplicate) {
      console.warn(`중복 update_id 감지, 무시함: ${updateId}`);
      return res.status(200).send('duplicate ignored');
    }
  }

  // "AI이미지" 키워드 감지 (있으면 제거하고 플래그로 기억)
  const wantsAiImage = /AI\s*이미지/i.test(rawContent);
  rawContent = rawContent.replace(/AI\s*이미지/gi, '').trim();

  // 여기서부터가 무거운 처리. await 하지 않고 waitUntil에 넘겨서, 응답을 먼저 보낸 뒤에도
  // 함수 인스턴스가 이 프라미스가 끝날 때까지 계속 실행되게 한다.
  waitUntil(processPost({ chatId, rawContent, photos, wantsAiImage }));

  return res.status(200).send('accepted');
}

// Claude 호출 -> 이미지 처리 -> GitHub 커밋 -> 완료/오류 메시지 전송까지의 전체 파이프라인.
// handler가 즉시 응답한 뒤 waitUntil로 계속 실행되므로, 여기서 발생하는 에러는 텔레그램 메시지로만
// 알리고 HTTP 응답에는 영향을 주지 않는다(이미 응답이 나간 뒤이기 때문).
async function processPost({ chatId, rawContent, photos, wantsAiImage }) {
  try {
    await sendTelegram(chatId, '포스팅 준비 중...');

    const parsed = await polishWithClaude(rawContent || '(사진 첨부)');

    if (!parsed) {
      await sendTelegram(chatId, '포스팅 생성 중 오류가 발생했습니다. 다시 시도해주세요');
      return;
    }

    const { title, tags, body: polishedBody, description, imagePrompt, category } = parsed;

    const validCategories = ['real-estate', 'stocks', 'economy', 'tips'];
    const safeCategory = validCategories.includes(category) ? category : 'real-estate';

    const slug = makeSlug(title);
    const { dateStr, pubDateValue } = getKstDateAndPubDate();
    const filename = `${dateStr}-${slug}.md`;

    // 이미지 처리: 1) 사용자가 사진 첨부 2) AI이미지 요청 3) 없음
    let imagePath = null;

    if (photos && photos.length > 0) {
      await sendTelegram(chatId, '첨부한 사진 업로드 중...');
      const largest = photos[photos.length - 1];
      const imageBuffer = await downloadTelegramFile(largest.file_id);
      imagePath = await commitImageToGithub(imageBuffer, dateStr, slug, 'jpg');
    } else if (wantsAiImage) {
      await sendTelegram(chatId, 'AI 이미지 생성 중...');
      const promptForImage = imagePrompt || title;
      const imageBuffer = await generateAiImage(promptForImage);
      if (imageBuffer) {
        imagePath = await commitImageToGithub(imageBuffer, dateStr, slug, 'jpg');
      }
    }

    const imageFrontmatter = imagePath ? `\nimage: "${imagePath}"` : '';

    const frontmatter = `---
title: "${escapeYaml(title)}"
description: "${escapeYaml(description)}"
pubDate: ${pubDateValue}
tags: [${tags.map((t) => `"${escapeYaml(t)}"`).join(', ')}]
category: "${safeCategory}"${imageFrontmatter}
---

${polishedBody}
`;

    await commitTextToGithub(`src/content/blog/${filename}`, frontmatter, `post: ${filename}`);

    const siteUrl = process.env.SITE_URL || '';
    const link = `${siteUrl}/blog/${dateStr}-${slug}/`;

    await sendTelegram(chatId, `포스팅 완료 (1~2분 후 반영)\n제목: ${title}\n${link}`);
  } catch (err) {
    console.error(err);
    await sendTelegram(chatId, `오류 발생: ${err.message}`);
  }
}

// update_id를 짧은 TTL로 KV에 SET NX 해서, 이미 처리 중/처리된 업데이트면 true를 반환한다.
// KV가 설정되지 않은 환경에서는 dedup을 건너뛰고 항상 false(중복 아님)를 반환한다 - 이 레이어가
// 없어도 응답을 즉시 보내는 것 자체가 텔레그램 재전송의 근본 원인을 없애기 때문에 안전하게 열어둔다.
async function isDuplicateUpdate(updateId) {
  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!kvUrl || !kvToken) {
    console.warn('KV_REST_API_URL/KV_REST_API_TOKEN이 설정되지 않아 update_id 중복 방지를 건너뜁니다.');
    return false;
  }

  try {
    const res = await fetch(kvUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kvToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['SET', `telegram_update:${updateId}`, '1', 'NX', 'EX', '120'])
    });

    if (!res.ok) {
      console.error('KV dedup 요청 실패:', res.status, await res.text());
      return false;
    }

    const data = await res.json();
    // SET ... NX가 성공(새 키 생성)하면 result: "OK", 이미 존재해서 실패하면 result: null
    return data.result !== 'OK';
  } catch (e) {
    console.error('KV dedup 오류:', e);
    return false;
  }
}

// Claude API로 제목/태그/요약 생성 + 본문 다듬기 (필요 시 웹서치 활용)
async function polishWithClaude(rawContent) {
  const systemPrompt = `너는 개인 블로그 편집자야. 사용자가 텔레그램으로 보낸 메모나 요청을 받아서
자연스러운 한국어 블로그 글로 작성해.

【최우선 규칙 — 반드시 지킬 것】
네 응답 전체는 JSON 객체 하나여야 한다. 응답의 첫 글자는 반드시 { 여야 하고, 마지막 글자는 반드시 } 여야 한다.
"검색 결과를 바탕으로 작성합니다" 같은 안내 문장, 인사말, 설명, 코드블록 표시(\`\`\`) 등 그 어떤 텍스트도
JSON 앞이나 뒤에 절대 추가하지 마라. web_search로 조사하는 중간 과정에는 자유롭게 생각해도 되지만,
최종 응답 메시지 하나는 오직 JSON 객체만 담아야 한다.

- 사용자가 이미 겪은 일/생각을 적었다면: 과장하거나 내용을 새로 지어내지 말고, 원래 내용의 사실과 어조를 유지한 채 문장만 정리해.
- 사용자가 최신 정보나 사실관계가 필요한 주제(시황, 뉴스, 순위, 가격, 일정 등)를 요청했다면: web_search 도구를 사용해서 실제로 검색한 뒤, 검색으로 확인한 내용만 바탕으로 글을 작성해.
  - 검색 결과가 여러 개 나오면 한 개만 보고 요약하지 말고, 최소 2~3개 이상의 검색 결과를 비교·종합해서 판단해. 서로 다른 출처의 수치가 엇갈리면 그 사실도 자연스럽게 언급해.
- 표면적인 요약에 그치지 말고 깊이 있게 써:
  - 구체적인 수치(퍼센트, 금액, 기간, 날짜 등)를 반드시 포함하고, "많이 올랐다", "큰 폭으로 하락" 같은 뭉뚱그린 표현 대신 정확한 데이터로 서술해.
  - 단순 사실 나열로 끝내지 말고, 왜 이 일이 중요한지·어떤 배경과 맥락에서 발생했는지까지 짚어줘.
  - 글 구조는 자연스러운 소제목을 활용해 "배경/맥락 → 핵심 변화 내용 → 실질적 영향(예: 독자에게 실제로 뭐가 달라지는지) → 전망 또는 시사점" 이 4단계 흐름으로 구성해.
  - 본문(body)은 최소 800자 이상으로 작성해. 너무 짧게 끝내지 마.
- 특정 문장을 그대로 길게 베끼지 말고 항상 네 표현으로 다시 써.
- "imagePrompt" 필드에는 이 글의 대표 이미지를 생성할 때 쓸 짧은 영어 이미지 프롬프트를 만들어줘 (실제 인물/브랜드명 없이, 분위기와 장면 위주로).
- "category" 필드에는 아래 4개 중 내용에 가장 맞는 것 하나를 정확히 그대로 적어(다른 값 금지):
  - "real-estate" : 부동산 시세, 정책, 청약, 재건축 등
  - "stocks" : 국내외 증시, 종목, 섹터 이슈
  - "economy" : 금리, 환율, 세제개편, 정부 경제정책 전반
  - "tips" : 절세, 대출 전략, 자산배분 등 실용 재테크 팁
  - 애매하면 가장 가까운 것으로 판단해서 고르고, 절대 다른 문자열을 쓰지 마.

검색이 필요한 경우 먼저 web_search로 조사한 다음, 마지막 응답으로 반드시 아래 JSON 형식만 출력해.
그 외의 경우에도 최종 응답은 항상 이 JSON 하나만 출력해. 설명이나 코드블록 표시(\`\`\`)는 포함하지 마.
다시 한번 강조한다: 최종 응답의 첫 글자는 { , 마지막 글자는 } 여야 하며 그 앞뒤로 어떤 문장도 붙이면 안 된다:
{
  "title": "글 제목 (짧고 자연스럽게)",
  "description": "1문장 요약",
  "tags": ["태그1", "태그2"],
  "body": "마크다운 형식의 다듬어진 본문",
  "imagePrompt": "짧은 영어 이미지 생성 프롬프트",
  "category": "real-estate|stocks|economy|tips 중 하나"
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: rawContent },
        { role: 'assistant', content: '{' }
      ],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 5
        }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API 오류: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const textBlocks = data.content.filter((c) => c.type === 'text');
  const lastText = textBlocks[textBlocks.length - 1];

  if (!lastText) {
    throw new Error('Claude 응답에서 텍스트를 찾을 수 없음');
  }

  // assistant 메시지를 '{'로 prefill해서 응답을 강제했으므로, 파싱 전에 그 '{'를 다시 앞에 붙여야 완전한 JSON이 된다.
  const rawText = lastText.text.replace(/```json|```/g, '').trim();
  const fullJson = '{' + rawText;

  let parsed;
  try {
    parsed = JSON.parse(fullJson);
  } catch (e) {
    const firstBrace = fullJson.indexOf('{');
    const lastBrace = fullJson.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        parsed = JSON.parse(fullJson.slice(firstBrace, lastBrace + 1));
      } catch (e2) {
        parsed = null;
      }
    }
  }

  if (!parsed) {
    console.error('Claude 응답 JSON 파싱 실패. 원본 응답 텍스트:', lastText.text);
    return null;
  }

  return parsed;
}

// 텔레그램 파일(사진) 다운로드
async function downloadTelegramFile(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  const fileInfoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const fileInfo = await fileInfoRes.json();

  if (!fileInfo.ok) {
    throw new Error('텔레그램 파일 정보 조회 실패');
  }

  const filePath = fileInfo.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    throw new Error('텔레그램 파일 다운로드 실패');
  }

  const arrayBuffer = await fileRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// 무료 이미지 생성 서비스(Pollinations)로 AI 이미지 생성
async function generateAiImage(prompt) {
  try {
    const encodedPrompt = encodeURIComponent(prompt);
    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=576&nologo=true`;

    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (e) {
    console.error('AI 이미지 생성 실패:', e);
    return null;
  }
}

// 이미지를 GitHub public/images 폴더에 커밋하고, 사이트에서 접근 가능한 경로를 반환
async function commitImageToGithub(imageBuffer, dateStr, slug, ext) {
  const filename = `${dateStr}-${slug}.${ext}`;
  const repoPath = `public/images/${filename}`;

  await commitBinaryToGithub(repoPath, imageBuffer, `image: ${filename}`);

  // Astro에서 public/ 폴더는 사이트 루트로 그대로 서빙됨
  return `/images/${filename}`;
}

// GitHub Contents API로 텍스트 파일 커밋
async function commitTextToGithub(path, content, commitMessage) {
  const contentBase64 = Buffer.from(content, 'utf-8').toString('base64');
  await putToGithub(path, contentBase64, commitMessage);
}

// GitHub Contents API로 바이너리(이미지) 파일 커밋
async function commitBinaryToGithub(path, buffer, commitMessage) {
  const contentBase64 = buffer.toString('base64');
  await putToGithub(path, contentBase64, commitMessage);
}

async function putToGithub(path, contentBase64, commitMessage) {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: commitMessage,
      content: contentBase64,
      branch
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GitHub 커밋 실패: ${response.status} ${errText}`);
  }
}

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

function makeSlug(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\w\uac00-\ud7a3\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 50);
}

function escapeYaml(str) {
  return String(str).replace(/"/g, '\\"');
}

// 현재 시각을 한국(KST, UTC+9) 기준 날짜/전체 타임스탬프로 반환
// Intl.DateTimeFormat + timeZone: 'Asia/Seoul'로 실제 KST 시각을 뽑아내 수동 오프셋 계산을 피한다.
function getKstDateAndPubDate() {
  const now = new Date();
  const kstDateStr = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(now).replace(' ', 'T');
  const pubDateValue = `${kstDateStr}+09:00`;
  return {
    dateStr: kstDateStr.slice(0, 10),
    pubDateValue
  };
}

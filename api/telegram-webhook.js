// Vercel Serverless Function
// 텔레그램 /post 명령어 수신 -> Claude API로 글 생성(+웹서치) -> GitHub에 마크다운 커밋 -> 자동 배포
//
// [단계적 복구 중] 무응답/파싱 실패 문제를 진단하려고 최소 버전으로 내렸다가, 안정 동작이
// 확인되어 web_search를 다시 붙였다. 이미지 생성/첨부(AI이미지 키워드, 사진 첨부, Pollinations
// 연동)는 아직 제거된 상태 - 웹서치까지 안정 동작이 확인되면 다음으로 복구할 예정.
// web_search는 assistant message prefill과 함께 쓸 수 없다("This model does not support
// assistant message prefill" 오류 원인이었음) - 그래서 messages는 user 메시지 하나만 유지하고,
// JSON 파싱은 prefill 없이 text 블록에서 정규식(첫 '{' ~ 마지막 '}')으로 추출하는 방식을 쓴다.
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
// 사용법: /post 텍스트  -> 이미지 없이 포스팅
//
// 응답 지연 방지: 텔레그램은 웹훅이 몇 초 안에 200을 응답하지 않으면 같은 업데이트를 재전송한다.
// 그래서 인증/파싱/dedup 체크까지만 동기로 끝내고 즉시 200을 응답한 뒤, 무거운 처리(Claude 호출,
// GitHub 커밋)는 @vercel/functions의 waitUntil로 응답 이후에도 계속 실행되게 분리했다.
// waitUntil이 응답 이후 실행을 실제로 보장하려면 Vercel 프로젝트에 Fluid Compute가 켜져 있어야 한다.
// 혹시 "포스팅 완료" 메시지가 끝까지 오지 않는다면 Vercel 프로젝트 Settings > Functions에서
// Fluid Compute 활성화 여부를 확인할 것.

import { waitUntil } from '@vercel/functions';

// 이 프로젝트는 Vercel Hobby 플랜이라 함수 실행 시간 상한이 60초로 고정되어 있다(그 이상
// 설정해도 무시됨). 그래서 maxDuration은 플랜이 허용하는 최대치인 60으로 맞추고, 대신
// web_search 호출 횟수(max_uses)를 1로 제한해 파이프라인 전체가 60초 안에 끝날 확률을 높였다.
// 다만 검색 결과가 아무리 짧아도 본문 생성 자체(특히 긴 주제)에 시간이 걸릴 수 있어 60초를
// 완전히 보장하지는 못한다 - 그래서 45초 지연 시 텔레그램으로 먼저 안내를 보내는 소프트
// 타임아웃(SOFT_TIMEOUT_MS, 아래 processPost 참고)을 함께 두어, 60초 근처까지 걸리더라도
// 사용자가 무응답으로 오해하지 않게 했다.
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

  const rawText = (message.text || '').trim();

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

  const rawContent = rawText.replace(/^\/post\s*/, '').trim();

  if (!rawContent) {
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

  // 여기서부터가 무거운 처리. await 하지 않고 waitUntil에 넘겨서, 응답을 먼저 보낸 뒤에도
  // 함수 인스턴스가 이 프라미스가 끝날 때까지 계속 실행되게 한다.
  waitUntil(processPost({ chatId, rawContent }));

  return res.status(200).send('accepted');
}

// Claude 호출 -> GitHub 커밋 -> 완료/오류 메시지 전송까지의 전체 파이프라인.
// handler가 즉시 응답한 뒤 waitUntil로 계속 실행되므로, 여기서 발생하는 에러는 텔레그램 메시지로만
// 알리고 HTTP 응답에는 영향을 주지 않는다(이미 응답이 나간 뒤이기 때문).
//
// 주의: 아래 try/catch는 "JS 코드 안에서 던져진 예외"만 잡을 수 있다. Vercel이 함수 실행 자체를
// 외부에서 강제 종료(Fluid Compute 미적용으로 응답 직후 인스턴스가 얼어붙거나, maxDuration 초과로
// 강제 종료)하면 이 catch조차 실행될 기회가 없어 완전히 무응답으로 끝날 수 있다. 그래서 내부적으로
// SOFT_TIMEOUT_MS가 지나면 "처리가 지연되고 있다"는 안내를 먼저 보내는 안전장치를 둔다.
async function processPost({ chatId, rawContent }) {
  const startedAt = Date.now();
  const elapsed = () => `${Date.now() - startedAt}ms`;

  const SOFT_TIMEOUT_MS = 55_000; // maxDuration(60s)보다 여유를 두고 지연 안내를 먼저 보냄
  const softTimeoutHandle = setTimeout(() => {
    console.warn(`[processPost] ${elapsed()} 경과 - 지연 안내 전송`);
    sendTelegram(
      chatId,
      '포스팅 처리가 예상보다 오래 걸리고 있습니다. 잠시 후에도 완료/오류 메시지가 오지 않으면 /post로 다시 시도해주세요.'
    ).catch((e) => console.error('[processPost] 지연 안내 전송 실패:', e));
  }, SOFT_TIMEOUT_MS);

  try {
    await sendTelegram(chatId, '포스팅 준비 중...');

    console.log(`[processPost] ${elapsed()} Claude 호출 시작 (web_search max_uses=1)`);
    const parsed = await polishWithClaude(rawContent);
    console.log(`[processPost] ${elapsed()} Claude 호출 완료, 파싱 ${parsed ? '성공' : '실패'}`);

    if (!parsed) {
      await sendTelegram(chatId, '포스팅 생성 중 오류가 발생했습니다. 다시 시도해주세요');
      return;
    }

    const { title, tags, body: polishedBody, description, category } = parsed;

    const validCategories = ['real-estate', 'stocks', 'economy', 'tips'];
    const safeCategory = validCategories.includes(category) ? category : 'real-estate';

    const slug = makeSlug(title);
    const { dateStr, pubDateValue } = getKstDateAndPubDate();
    const filename = `${dateStr}-${slug}.md`;

    const frontmatter = `---
title: "${escapeYaml(title)}"
description: "${escapeYaml(description)}"
pubDate: ${pubDateValue}
tags: [${tags.map((t) => `"${escapeYaml(t)}"`).join(', ')}]
category: "${safeCategory}"
---

${polishedBody}
`;

    console.log(`[processPost] ${elapsed()} GitHub 커밋 시작: ${filename}`);
    await commitTextToGithub(`src/content/blog/${filename}`, frontmatter, `post: ${filename}`);
    console.log(`[processPost] ${elapsed()} GitHub 커밋 완료: ${filename}`);

    const siteUrl = process.env.SITE_URL || '';
    const link = `${siteUrl}/blog/${dateStr}-${slug}/`;

    await sendTelegram(chatId, `포스팅 완료 (1~2분 후 반영)\n제목: ${title}\n${link}`);
    console.log(`[processPost] ${elapsed()} 전체 완료`);
  } catch (err) {
    console.error(`[processPost] ${elapsed()} 오류 발생:`, err);
    await sendTelegram(chatId, `오류 발생: ${err.message}`).catch((e) =>
      console.error('[processPost] 오류 메시지 전송조차 실패:', e)
    );
  } finally {
    clearTimeout(softTimeoutHandle);
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

// Claude API로 제목/태그/요약 생성 + 본문 다듬기 (웹서치 없음 - 순수 텍스트 생성만)
async function polishWithClaude(rawContent) {
  const systemPrompt = `너는 개인 블로그 편집자야. 사용자가 텔레그램으로 보낸 메모나 요청을 받아서
자연스러운 한국어 블로그 글로 작성해.

【최우선 규칙 — 반드시 지킬 것】
응답은 반드시 순수 JSON 객체 하나여야 하고, 첫 글자는 반드시 '{', 마지막 글자는 반드시 '}' 여야 하며,
그 앞뒤로 어떤 설명이나 마크다운 코드블록(\`\`\`)도 절대 포함하지 마라. 인사말도 금지다. web_search로
조사하는 중간 과정에는 자유롭게 생각해도 되지만, 최종 응답 메시지 하나는 오직 JSON 객체만 담아야 한다.
검색 횟수 제한에 걸리거나 원하는 만큼 검색하지 못했더라도, 그 사실을 응답에 절대 언급하지 마라
("검색 횟수 제한으로..." 같은 문장 금지) - 그때까지 확보한 정보와 배경 지식만으로 조용히 최종
JSON을 작성해라.

- 사용자가 이미 겪은 일/생각을 적었다면: 과장하거나 내용을 새로 지어내지 말고, 원래 내용의 사실과 어조를 유지한 채 문장만 정리해.
- 사용자가 최신 정보(시황, 뉴스, 통계, 순위, 가격 등)를 요청했다면: web_search 도구로 실제로 검색한 뒤, 검색으로 확인한 내용만 바탕으로 글을 작성해. 확인할 수 없는 수치나 사실을 지어내지 마라.
- 요청에 여러 주제가 "A+B", "A와 B"처럼 함께 묶여 있어도, 검색은 각 주제마다 따로 하지 말고 전체를
  아우르는 검색어 하나로 딱 한 번만 검색해라. 나머지는 그 결과와 배경 지식을 조합해서 써라.
- 표면적인 요약에 그치지 말고 깊이 있게 써:
  - 사용자가 준 내용이나 검색으로 확인한 구체적인 사실(수치, 기간, 날짜 등)은 그대로 살려서 서술해.
  - 단순 사실 나열로 끝내지 말고, 왜 이 일이 중요한지·어떤 배경과 맥락에서 발생했는지까지 짚어줘.
  - 글 구조는 자연스러운 소제목을 활용해 "배경/맥락 → 핵심 변화 내용 → 실질적 영향(예: 독자에게 실제로 뭐가 달라지는지) → 전망 또는 시사점" 이 4단계 흐름으로 간결하게 구성해. 각 단계는 핵심만 짧게 짚고 늘어지지 마라.
  - 본문(body)은 최소 500자 이상으로 작성해. 너무 짧게 끝내지는 말되, 불필요하게 길게 늘리지도 마라.
- 특정 문장을 그대로 길게 베끼지 말고 항상 네 표현으로 다시 써.
- "category" 필드에는 아래 4개 중 내용에 가장 맞는 것 하나를 정확히 그대로 적어(다른 값 금지):
  - "real-estate" : 부동산 시세, 정책, 청약, 재건축 등
  - "stocks" : 국내외 증시, 종목, 섹터 이슈
  - "economy" : 금리, 환율, 세제개편, 정부 경제정책 전반
  - "tips" : 절세, 대출 전략, 자산배분 등 실용 재테크 팁
  - 애매하면 가장 가까운 것으로 판단해서 고르고, 절대 다른 문자열을 쓰지 마.

최종 응답은 항상 아래 JSON 하나만 출력해. 설명이나 코드블록 표시(\`\`\`)는 포함하지 마.
다시 한번 강조한다: 최종 응답의 첫 글자는 { , 마지막 글자는 } 여야 하며 그 앞뒤로 어떤 문장도 붙이면 안 된다:
{
  "title": "글 제목 (짧고 자연스럽게)",
  "description": "1문장 요약",
  "tags": ["태그1", "태그2"],
  "body": "마크다운 형식의 다듬어진 본문",
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
      max_tokens: 3200,
      system: systemPrompt,
      messages: [{ role: 'user', content: rawContent }],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 1
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

  const cleaned = sanitizeJsonControlChars(lastText.text.replace(/```json|```/g, '').trim());

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // 모델이 그래도 JSON 앞뒤에 설명을 붙였을 경우를 대비해, 첫 '{'부터 마지막 '}'까지만 추출해 재시도.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
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

// Claude가 긴 본문을 JSON 문자열 값 안에 넣으면서 개행을 "\n"으로 이스케이프하지 않고
// 실제 개행 문자(raw newline)를 그대로 남기는 경우가 있다. JSON 스펙상 문자열 리터럴 안의
// 이스케이프 안 된 제어 문자(개행·탭 등)는 파싱 오류를 일으키므로, 문자열 리터럴 내부에서만
// 그런 제어 문자를 이스케이프 형태로 바꿔준다. 문자열 바깥의 구조적 개행(들여쓰기용)은 원래
// 유효한 JSON이라 건드리지 않는다.
function sanitizeJsonControlChars(text) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (inString) {
      if (escaped) {
        result += ch;
        escaped = false;
      } else if (ch === '\\') {
        result += ch;
        escaped = true;
      } else if (ch === '"') {
        result += ch;
        inString = false;
      } else if (ch === '\n') {
        result += '\\n';
      } else if (ch === '\r') {
        result += '\\r';
      } else if (ch === '\t') {
        result += '\\t';
      } else {
        result += ch;
      }
    } else if (ch === '"') {
      inString = true;
      result += ch;
    } else {
      result += ch;
    }
  }

  return result;
}

// GitHub Contents API로 텍스트 파일 커밋
async function commitTextToGithub(path, content, commitMessage) {
  const contentBase64 = Buffer.from(content, 'utf-8').toString('base64');
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
    .replace(/[^\w가-힣\s-]/g, '')
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

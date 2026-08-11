// Vercel Serverless Function
// 텔레그램 /post 명령어 수신 -> Claude API로 다듬기 -> GitHub에 마크다운 커밋 -> 자동 배포
//
// 필요한 환경변수 (Vercel 프로젝트 Settings > Environment Variables 에 등록):
//   TELEGRAM_BOT_TOKEN   : BotFather에서 발급받은 토큰
//   TELEGRAM_CHAT_ID     : 본인 chat_id (허용된 사람만 포스팅 가능하게 하는 화이트리스트)
//   TELEGRAM_WEBHOOK_SECRET : 텔레그램 웹훅 검증용 임의의 문자열 (직접 정하면 됨)
//   ANTHROPIC_API_KEY    : 본인 Claude API 키 (console.anthropic.com 에서 발급)
//   GITHUB_TOKEN         : GitHub Personal Access Token (repo 쓰기 권한)
//   GITHUB_REPO          : "아이디/저장소명" 형식 (예: dongkeon/dongun-blog)
//   GITHUB_BRANCH        : 기본 브랜치명 (보통 "main")
//   SITE_URL             : 배포된 사이트 주소 (예: https://dongun-blog.vercel.app)

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  // 텔레그램 웹훅 보안 토큰 검증
  const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
  if (secretHeader !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  const body = req.body;
  const message = body?.message;

  if (!message || !message.text) {
    return res.status(200).send('ignored');
  }

  const chatId = String(message.chat.id);
  const text = message.text.trim();

  // 허용된 사용자(본인)만 포스팅 가능
  if (chatId !== process.env.TELEGRAM_CHAT_ID) {
    await sendTelegram(chatId, '권한이 없습니다.');
    return res.status(200).send('unauthorized user');
  }

  // /post 명령어가 아니면 무시
  if (!text.startsWith('/post')) {
    return res.status(200).send('ignored');
  }

  const rawContent = text.replace(/^\/post\s*/, '').trim();

  if (!rawContent) {
    await sendTelegram(chatId, '/post 뒤에 내용을 입력해줘. 예: /post 오늘 있었던 일...');
    return res.status(200).send('empty content');
  }

  try {
    await sendTelegram(chatId, '포스팅 준비 중...');

    const { title, tags, body: polishedBody, description } = await polishWithClaude(rawContent);

    const slug = makeSlug(title);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `${dateStr}-${slug}.md`;

    const frontmatter = `---
title: "${escapeYaml(title)}"
description: "${escapeYaml(description)}"
pubDate: ${dateStr}
tags: [${tags.map((t) => `"${escapeYaml(t)}"`).join(', ')}]
---

${polishedBody}
`;

    await commitToGithub(filename, frontmatter);

    const siteUrl = process.env.SITE_URL || '';
    const link = `${siteUrl}/blog/${dateStr}-${slug}/`;

    await sendTelegram(chatId, `포스팅 완료 (1~2분 후 반영)\n제목: ${title}\n${link}`);

    return res.status(200).send('posted');
  } catch (err) {
    console.error(err);
    await sendTelegram(chatId, `오류 발생: ${err.message}`);
    return res.status(200).send('error handled');
  }
}

// Claude API로 제목/태그/요약 생성 + 본문 다듬기
async function polishWithClaude(rawContent) {
  const systemPrompt = `너는 개인 블로그 편집자야. 사용자가 텔레그램으로 보낸 거친 메모를 받아서
자연스러운 한국어 블로그 글로 다듬어. 과장하거나 내용을 새로 지어내지 말고,
원래 내용의 사실과 어조를 유지한 채 문장만 정리해.

반드시 아래 JSON 형식으로만 응답해. 다른 설명, 코드블록 표시(\`\`\`) 없이 순수 JSON만 출력해:
{
  "title": "글 제목 (짧고 자연스럽게)",
  "description": "1문장 요약",
  "tags": ["태그1", "태그2"],
  "body": "마크다운 형식의 다듬어진 본문"
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
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: rawContent }]
    })
  });

  if (!response.ok) {
    throw new Error(`Claude API 오류: ${response.status}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((c) => c.type === 'text');
  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // 파싱 실패 시 최소한의 fallback
    parsed = {
      title: rawContent.slice(0, 20),
      description: '',
      tags: [],
      body: rawContent
    };
  }

  return parsed;
}

// GitHub Contents API로 마크다운 파일 커밋
async function commitToGithub(filename, content) {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const path = `src/content/blog/${filename}`;
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;

  const contentBase64 = Buffer.from(content, 'utf-8').toString('base64');

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: `post: ${filename}`,
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
  // 한글 제목도 슬러그로 쓸 수 있게 간단 처리 (공백 -> 하이픈, 특수문자 제거)
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

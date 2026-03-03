import * as vscode from 'vscode';

const STYLE_SAMPLES_KEY = 'blog-auto.blogStyleSamples';
const MAX_SAMPLE_LENGTH = 15000;

/** HTML에서 텍스트만 추출 (간단한 정규식) */
function extractTextFromHtml(html: string): string {
  const noScript = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  const text = noScript.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, MAX_SAMPLE_LENGTH);
}

/** URL에서 본문 텍스트 가져오기 (티스토리/벨로그 등) */
export async function fetchBlogStyleSamples(blogUrl: string): Promise<string> {
  const url = blogUrl.trim();
  if (!url.startsWith('http')) throw new Error('올바른 블로그 주소를 입력해 주세요.');

  let rssUrl = url;
  if (url.includes('tistory.com') && !url.includes('/rss')) {
    rssUrl = url.replace(/\/?$/, '') + '/rss';
  }
  const res = await fetch(rssUrl, {
    headers: { 'User-Agent': 'Cursor-BlogPlugin/1.0' },
  });
  if (!res.ok) {
    const htmlRes = url !== rssUrl ? await fetch(url, { headers: { 'User-Agent': 'Cursor-BlogPlugin/1.0' } }) : null;
    if (htmlRes?.ok) {
      const html = await htmlRes.text();
      return extractTextFromHtml(html);
    }
    throw new Error(`불러오기 실패: ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  if (contentType.includes('xml') || text.trimStart().startsWith('<?xml') || text.includes('<rss')) {
    const itemMatch = text.match(/<item>[\s\S]*?<description>([\s\S]*?)<\/description>/gi);
    if (itemMatch) {
      const parts = itemMatch
        .slice(0, 5)
        .map((item) => {
          const m = item.match(/<description>([\s\S]*?)<\/description>/i);
          if (!m) return '';
          return m[1]
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        })
        .filter(Boolean);
      return parts.join('\n\n').slice(0, MAX_SAMPLE_LENGTH);
    }
  }
  return extractTextFromHtml(text);
}

export function getStoredStyleSamples(context: vscode.ExtensionContext): string {
  return context.globalState.get(STYLE_SAMPLES_KEY, '');
}

export function setStoredStyleSamples(context: vscode.ExtensionContext, text: string): void {
  context.globalState.update(STYLE_SAMPLES_KEY, text.slice(0, MAX_SAMPLE_LENGTH));
}

/** OpenAI 등으로 "내 말투" 재작성 (API 키 필요) */
export async function rewriteInMyStyle(
  content: string,
  styleSamples: string,
  apiKey: string
): Promise<string> {
  if (!styleSamples.trim()) throw new Error('말투 샘플을 먼저 불러와 주세요.');
  if (!apiKey.trim()) throw new Error('설정에서 OpenAI API 키를 입력해 주세요.');

  const systemPrompt = `당신은 사용자의 블로그 글 말투를 흉내하는 글쓰기 도우미입니다. 아래 "말투 예시"는 사용자가 쓴 블로그 글입니다. "작성할 내용"을 같은 말투·스타일로 다시 써 주세요. 정보와 구조(제목, 목록 등)는 유지하되, 문장만 사용자 말투로 바꿉니다. 다른 설명 없이 재작성된 글만 출력하세요.`;
  const userPrompt = `[말투 예시]\n${styleSamples.slice(0, 8000)}\n\n[작성할 내용]\n${content}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API 오류: ${res.status} ${err.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const reply = data.choices?.[0]?.message?.content?.trim();
  return reply || content;
}

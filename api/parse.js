// Vercel API: /api/parse
// Cloudflare Worker가 차단된 Anthropic API를 대신 호출하는 프록시

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const providedSecret = req.headers['x-app-secret'] || '';
  if (providedSecret !== process.env.APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized', code: 'AUTH_FAILED' });
  }

  if (!process.env.CLAUDE_API_KEY) {
    return res.status(500).json({ error: 'CLAUDE_API_KEY 없음', code: 'API_KEY_MISSING' });
  }

  const body = req.body;
  const text = body?.text || '';
  const today = body?.today || new Date().toISOString().slice(0, 10);
  const images = Array.isArray(body?.images) ? body.images : [];
  const hasText = !!(text && text.trim());
  const hasImages = images.length > 0;

  if (!hasText && !hasImages) {
    return res.status(200).json({ items: [] });
  }

  const systemPrompt = `당신은 사용자의 메모를 할 일 목록으로 정리하는 도구입니다. 오늘 날짜: ${today}

【가장 중요한 원칙】
1. 사용자가 입력한 원문의 의도와 표현을 절대 바꾸지 마세요.
   - "무시하고" → "무시하고" (그대로). "준수하여"로 바꾸지 말 것.
   - "대충" → "대충". "꼼꼼히"로 바꾸지 말 것.
   - 윤리적으로 보정하거나, 부드럽게 다듬거나, 의미를 추측해서 바꾸지 마세요.
   - 사용자가 어떤 표현을 썼든 그대로 옮기세요. 평가나 판단 금지.

2. 한 흐름의 작업은 하나의 할 일로 유지하세요.
   - "A를 만들어서 B에게 전달" → 1개 (분리 금지)
   - "A 작성 후 B 보고" → 1개
   - "장보고 요리하기" → 1개 (장보기와 요리는 한 흐름)
   - 정말 독립적인 별개의 일일 때만 분리:
     * "병원 예약 + 보고서 작성" → 2개 (서로 무관)
     * "오전 미팅, 오후 출장 준비" → 2개

3. title은 사용자가 쓴 표현을 최대한 살리세요.
   - 원문이 짧으면 짧게, 길면 길게.
   - 인위적으로 "~하기" 형식으로 바꾸지 마세요.

【필드 규칙】
- title: 원문 표현 그대로. 인사말("안녕하세요" 등)만 제외.
- detail: 원문에 부가 맥락이 있으면 그대로. 없으면 빈 문자열.
- category: work(업무 맥락) / personal(개인 일상)
- priority: high("긴급/오늘까지/꼭/반드시" 명시) / mid(기본) / low("여유/시간날 때")
- duration(분): 확인/답장 15, 작성/삭제 30, 보고서 120, 미팅 60, 기본 30
- date: 명시된 경우만 YYYY-MM-DD, 모르면 null
  * "내일", "다음주" 등은 ${today} 기준으로 계산
  * 구체 날짜가 오늘 이전이면 가장 가까운 미래의 해당 날짜

【응답 형식】
JSON만. 설명/마크다운/코드블록 금지:
{"items":[{"title":"...","detail":"...","category":"work|personal","priority":"high|mid|low","duration":30,"date":"YYYY-MM-DD|null"}]}`;

  const content = [];
  if (hasImages) {
    for (const img of images) {
      if (typeof img !== 'string') continue;
      const m = img.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (!m) continue;
      content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    }
  }
  content.push({ type: 'text', text: hasText ? text : '(이미지 분석)' });

  const model = hasImages ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content }]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      return res.status(502).json({
        error: `Claude API ${apiRes.status}: ${errText.slice(0, 300)}`,
        code: 'CLAUDE_ERROR'
      });
    }

    const data = await apiRes.json();
    let txt = '';
    if (Array.isArray(data.content)) {
      for (const b of data.content) if (b.type === 'text' && b.text) txt += b.text;
    }

    let cleaned = txt.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
      else throw new Error('JSON 파싱 실패');
    }

    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(502).json({ error: e.message, code: 'PARSE_ERROR' });
  }
}

// Vercel API: /api/parse
// Cloudflare Worker가 차단된 Anthropic API를 대신 호출하는 프록시

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Secret');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 인증
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

  const systemPrompt = `당신은 한국어 할 일 정리 전문가입니다. 오늘 날짜: ${today}

규칙:
- 각 할 일은 구체적이고 실행 가능한 형태
- 인사말 제외
- title은 간결한 명령문, detail은 부가 맥락만
- 카테고리: work(업무) / personal(개인)
- 중요도: high / mid / low
- 소요시간(분): 확인/답장 15, 작성/삭제 30, 보고서 120, 미팅 60, 기본 30
- 날짜: 모르면 null

JSON으로만 응답:
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

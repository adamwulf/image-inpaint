// generate.mjs — text-to-image (OpenAI images.generate, gpt-image-1-mini).
// OPENAI_API_KEY is read from the environment and NEVER sent to the browser.
// Deploy safeguards (OpenAI spend cap + Netlify per-IP rate limiting) are in README.md.
//
// Plain fetch to the OpenAI REST API — no SDK dependency (these are simple
// single requests).
const OPENAI_URL = 'https://api.openai.com/v1/images/generations';

// Per-IP rate limit: 1 request every 3 seconds. This is a spend safeguard on a
// public deploy so a single visitor can't hammer the OpenAI endpoint. Netlify
// returns HTTP 429 automatically when the window limit is exceeded — no code
// path here handles it. On the free/Starter plan a project gets 2 rate-limit
// rules total; this + edit-background use both (see README deploy safeguards).
export const config = {
  rateLimit: {
    windowSize: 3,       // seconds
    windowLimit: 1,      // max requests per window
    aggregateBy: ['ip'], // key by client IP
  },
};

export default async (req) => {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return json({ error: 'Server missing OPENAI_API_KEY. Set it in Netlify env / .env.' }, 500);

    const { prompt } = await req.json();
    if (!prompt || !String(prompt).trim()) return json({ error: 'missing prompt' }, 400);

    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1-mini',
        prompt: String(prompt).slice(0, 1000),
        size: '1024x1024',
        quality: 'low',
        n: 1,
      }),
    });

    const data = await res.json();
    if (!res.ok) return json({ error: data?.error?.message || 'generate failed' }, res.status);

    const b64 = data.data[0].b64_json; // gpt-image returns base64
    return json({ image: b64 });        // browser: data:image/png;base64,${b64}
  } catch (e) {
    return json({ error: e?.message || 'generate failed' }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

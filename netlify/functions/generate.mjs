// generate.mjs — text-to-image (OpenAI images.generate, gpt-image-1-mini).
// OPENAI_API_KEY is read from the environment and NEVER sent to the browser.
// Deploy safeguards (OpenAI spend cap + Netlify per-IP rate limiting) are in README.md.
//
// Plain fetch to the OpenAI REST API — no SDK dependency (these are simple
// single requests).
const OPENAI_URL = 'https://api.openai.com/v1/images/generations';

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

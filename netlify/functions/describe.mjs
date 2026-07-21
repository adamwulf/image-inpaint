// describe.mjs — image-to-text (OpenAI gpt-4o-mini vision, Chat Completions).
// OPENAI_API_KEY is read from the environment and NEVER sent to the browser.
// Deploy safeguards (OpenAI spend cap + Netlify per-IP rate limiting) are in README.md.
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async (req) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return json({ error: 'Server missing OPENAI_API_KEY. Set it in Netlify env / .env.' }, 500);
    }
    const { imageB64, mode } = await req.json(); // browser strips the data: prefix
    if (!imageB64) return json({ error: 'missing image' }, 400);

    const imageBuf = Buffer.from(imageB64, 'base64');
    // Fail fast (and free) on oversized input, before calling OpenAI.
    if (imageBuf.length > 4_000_000) return json({ error: 'image too large (max 4MB)' }, 413);

    const instruction = mode === 'ocr'
      ? 'Transcribe all text visible in this image. If there is no text, say so.'
      : 'Describe this image in a sentence or two.';

    const result = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}`, detail: 'low' } },
          ],
        },
      ],
      max_tokens: 300,
    });

    const text = result.choices[0].message.content;
    return json({ text });
  } catch (e) {
    return json({ error: e?.message || 'describe failed' }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

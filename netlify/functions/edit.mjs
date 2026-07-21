// edit.mjs — masked inpaint / touchup (OpenAI images.edit, gpt-image-1-mini).
// OPENAI_API_KEY is read from the environment and NEVER sent to the browser.
// Deploy safeguards (OpenAI spend cap + Netlify per-IP rate limiting) are in README.md.
//
// Mask contract: the mask PNG is the SAME dimensions as the image, where
// alpha 0 (transparent) = "edit here" and alpha 255 = "keep". The browser
// exports the mask that way (see app.js exportMaskBase64).
import OpenAI, { toFile } from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async (req) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return json({ error: 'Server missing OPENAI_API_KEY. Set it in Netlify env / .env.' }, 500);
    }
    const { imageB64, maskB64, prompt } = await req.json(); // browser strips the data: prefix
    if (!imageB64 || !maskB64 || !prompt) return json({ error: 'missing image, mask, or prompt' }, 400);

    const imageBuf = Buffer.from(imageB64, 'base64');
    const maskBuf = Buffer.from(maskB64, 'base64');
    // Fail fast (and free) on oversized inputs, before calling OpenAI.
    if (imageBuf.length > 4_000_000 || maskBuf.length > 4_000_000) {
      return json({ error: 'image/mask too large (max 4MB each)' }, 413);
    }

    const image = await toFile(imageBuf, 'image.png', { type: 'image/png' });
    const mask = await toFile(maskBuf, 'mask.png', { type: 'image/png' });

    const result = await client.images.edit({
      model: 'gpt-image-1-mini',
      image,
      mask,
      prompt: String(prompt).slice(0, 1000),
      size: '1024x1024',
      quality: 'low',
      n: 1,
    });

    const b64 = result.data[0].b64_json; // gpt-image-1 returns base64
    return json({ image: b64 });          // browser: data:image/png;base64,${b64}
  } catch (e) {
    return json({ error: e?.message || 'edit failed' }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

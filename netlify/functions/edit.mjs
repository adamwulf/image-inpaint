// edit.mjs — masked inpaint / touchup (OpenAI images.edit, gpt-image-1).
// OPENAI_API_KEY is read from the environment and NEVER sent to the browser.
// Deploy safeguards (OpenAI spend cap + Netlify per-IP rate limiting) are in README.md.
//
// Mask contract: the mask PNG is the SAME dimensions as the image, where
// alpha 0 (transparent) = "edit here" and alpha 255 = "keep". The browser
// exports the mask that way (see app.js exportMaskBase64). OpenAI keeps the
// unmasked area faithful (input_fidelity:'high') so only the painted region
// changes — no browser compositing.
//
// Plain multipart fetch to the OpenAI REST API — no SDK dependency.
const OPENAI_URL = 'https://api.openai.com/v1/images/edits';

export default async (req) => {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return json({ error: 'Server missing OPENAI_API_KEY. Set it in Netlify env / .env.' }, 500);

    const { imageB64, maskB64, prompt } = await req.json(); // browser strips the data: prefix
    if (!imageB64 || !maskB64 || !prompt) return json({ error: 'missing image, mask, or prompt' }, 400);

    const imageBuf = Buffer.from(imageB64, 'base64');
    const maskBuf = Buffer.from(maskB64, 'base64');
    // Fail fast (and free) on oversized inputs, before calling OpenAI.
    if (imageBuf.length > 4_000_000 || maskBuf.length > 4_000_000) {
      return json({ error: 'image/mask too large (max 4MB each)' }, 413);
    }

    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('image', new Blob([imageBuf], { type: 'image/png' }), 'image.png');
    form.append('mask', new Blob([maskBuf], { type: 'image/png' }), 'mask.png');
    form.append('prompt', String(prompt).slice(0, 1000));
    form.append('size', '1024x1024');
    form.append('quality', 'low');
    // Keep the unmasked area faithful so only the painted region changes.
    // gpt-image-1 supports this (gpt-image-1-mini rejects it with 400).
    form.append('input_fidelity', 'high');
    form.append('n', '1');

    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}` }, // fetch sets the multipart boundary
      body: form,
    });

    const data = await res.json();
    if (!res.ok) return json({ error: data?.error?.message || 'edit failed' }, res.status);

    const b64 = data.data[0].b64_json; // gpt-image returns base64
    return json({ image: b64 });        // browser: data:image/png;base64,${b64}
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

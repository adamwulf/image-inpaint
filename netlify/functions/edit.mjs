// edit.mjs — masked inpaint / touchup (OpenAI images.edit, gpt-image-2).
// OPENAI_API_KEY is read from the environment and NEVER sent to the browser.
// Deploy safeguards (OpenAI spend cap + Netlify per-IP rate limiting) are in README.md.
//
// Mask contract: the mask PNG is the SAME dimensions as the image, where
// alpha 0 (transparent) = "edit here" and alpha 255 = "keep" (see app.js
// exportMaskBase64).
//
// WHY WE COMPOSITE: no gpt-image model hard-confines an edit to the mask — it's a
// documented OpenAI limitation that gpt-image regenerates the WHOLE canvas and
// treats the mask as a hint (unlike dall-e-2's pixel replacement, which is retired
// here). So this function does the confinement itself: it keeps the ORIGINAL
// outside the mask and blends in the AI result inside it, with a FEATHERED (blurred)
// mask edge so the seam fades smoothly. It returns BOTH the raw AI output and the
// composite. Plain multipart fetch to the OpenAI REST API — sharp for compositing.
import sharp from 'sharp';

const OPENAI_URL = 'https://api.openai.com/v1/images/edits';
const FEATHER_PX = 10; // Gaussian blur radius on the mask edge (the feather width)

export default async (req) => {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return json({ error: 'Server missing OPENAI_API_KEY. Set it in Netlify env / .env.' }, 500);

    const { imageB64, maskB64, prompt } = await req.json(); // browser strips the data: prefix
    if (!imageB64 || !prompt) return json({ error: 'missing image or prompt' }, 400);

    const imageBuf = Buffer.from(imageB64, 'base64');
    const maskBuf = maskB64 ? Buffer.from(maskB64, 'base64') : null; // optional
    // Fail fast (and free) on oversized inputs, before calling OpenAI.
    if (imageBuf.length > 4_000_000 || (maskBuf && maskBuf.length > 4_000_000)) {
      return json({ error: 'image/mask too large (max 4MB each)' }, 413);
    }

    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('image', new Blob([imageBuf], { type: 'image/png' }), 'image.png');
    // No mask => the model rebuilds the WHOLE image from the prompt (no composite).
    if (maskBuf) form.append('mask', new Blob([maskBuf], { type: 'image/png' }), 'mask.png');
    form.append('prompt', String(prompt).slice(0, 1000));
    form.append('size', '1024x1024');
    form.append('quality', 'low');
    // No input_fidelity: gpt-image-2 rejects it (it's high-fidelity automatically),
    // and the composite below is what GUARANTEES the unmasked area is untouched anyway.
    form.append('n', '1');

    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}` }, // fetch sets the multipart boundary
      body: form,
    });

    const data = await res.json();
    if (!res.ok) return json({ error: data?.error?.message || 'edit failed' }, res.status);

    const rawB64 = data.data[0]?.b64_json;
    if (!rawB64) return json({ error: 'no image returned' }, 502);

    // No mask: the whole-image rebuild IS the result — nothing to composite.
    if (!maskBuf) return json({ image: rawB64 });

    // Masked: composite the AI result back through a feathered mask so only the
    // painted region changes (the rest stays exactly the original). Return both the
    // composite (default) and the raw whole-canvas output (the "what the AI changed" view).
    const compositeB64 = await compositeMasked(imageBuf, maskBuf, Buffer.from(rawB64, 'base64'));
    return json({ image: compositeB64, raw: rawB64 });
  } catch (e) {
    return json({ error: e?.message || 'edit failed' }, 500);
  }
};

// Blend: out = source*(1-t) + aiResult*t, where t is a FEATHERED edit-strength map
// derived from the mask (mask alpha 0 = "edit here" => t=1; alpha 255 = "keep" => t=0),
// Gaussian-blurred so the boundary fades instead of a hard cut. All three images are
// normalized to the source's dimensions first so the pixels line up exactly.
async function compositeMasked(sourceBuf, maskBuf, aiBuf) {
  const src = sharp(sourceBuf).ensureAlpha();
  const meta = await src.metadata();
  const w = meta.width, h = meta.height;

  // Source RGB (drop alpha for the blend).
  const source = await sharp(sourceBuf).removeAlpha().resize(w, h, { fit: 'fill' })
    .raw().toBuffer(); // w*h*3
  // AI result RGB, matched to source dims.
  const ai = await sharp(aiBuf).removeAlpha().resize(w, h, { fit: 'fill' })
    .raw().toBuffer(); // w*h*3

  // Edit-strength map from the mask's ALPHA: painted (alpha 0) -> 255 ("use AI"),
  // kept (alpha 255) -> 0 ("use source"); then blur it for the feather.
  // NOTE: sharp expands a single-channel raw buffer to 3 channels on
  // .raw().toBuffer() unless forced to 'b-w', which would misalign the indexing —
  // so every single-channel read below pins the colourspace to b-w.
  const maskAlpha = await sharp(maskBuf).ensureAlpha().resize(w, h, { fit: 'fill' })
    .extractChannel('alpha').toColourspace('b-w').raw().toBuffer(); // w*h*1
  const strength = Buffer.alloc(w * h);
  for (let i = 0; i < strength.length; i++) strength[i] = 255 - maskAlpha[i];
  const feather = await sharp(strength, { raw: { width: w, height: h, channels: 1 } })
    .blur(FEATHER_PX).toColourspace('b-w').raw().toBuffer(); // w*h*1, feathered

  // Per-pixel blend.
  const out = Buffer.alloc(w * h * 3);
  for (let p = 0, s = 0; p < feather.length; p++, s += 3) {
    const t = feather[p] / 255;
    const it = 1 - t;
    out[s]     = (source[s]     * it + ai[s]     * t) | 0;
    out[s + 1] = (source[s + 1] * it + ai[s + 1] * t) | 0;
    out[s + 2] = (source[s + 2] * it + ai[s + 2] * t) | 0;
  }

  const png = await sharp(out, { raw: { width: w, height: h, channels: 3 } })
    .png().toBuffer();
  return png.toString('base64');
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

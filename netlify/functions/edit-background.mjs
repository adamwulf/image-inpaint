// edit-background.mjs — the masked inpaint / touchup, run as a BACKGROUND function.
//
// WHY BACKGROUND: the OpenAI edit takes ~20-28s and the composite adds a couple more,
// which blows Netlify's synchronous function timeout (10s on the free plan). A
// background function returns 202 immediately and may run up to 15 min; it writes the
// result to Netlify Blobs, and the browser polls edit-status.mjs for it.
//
// OPENAI_API_KEY is read from the environment and NEVER sent to the browser.
// Deploy safeguards (OpenAI spend cap + Netlify per-IP rate limiting) are in README.md.
//
// Mask contract: the mask PNG is the SAME dimensions as the image, where alpha 0
// (transparent) = "edit here" and alpha 255 = "keep" (see app.js exportMaskBase64).
// No gpt-image model hard-confines to the mask (documented limitation), so with a mask
// we composite the AI result back through a FEATHERED mask ourselves. Without a mask,
// the model rebuilds the whole image.
import sharp from 'sharp';
import { getStore } from '@netlify/blobs';

// background:true makes this async (202 + up to 15 min). The `-background` filename
// suffix ALSO marks it background; the function is invoked at the standard
// /.netlify/functions/edit-background path (no custom `path` — that conflicts with it).
//
// NOTE: NO rateLimit here — it is INCOMPATIBLE with background:true. Netlify's
// `rateLimit` config runs in the edge/traffic layer that only fronts SYNCHRONOUS
// functions; declaring it on a background function makes Netlify reject the invocation
// at the platform layer — a synchronous 500 with NO function log (the handler never
// runs). That is exactly the failure this fixed. So the edit path is NOT covered by
// an in-code per-IP rate limit; the OpenAI hard spend cap (README safeguard #1) is the
// backstop for it. If per-IP limiting of edits is ever required, do it at the edge
// (a Netlify Edge Function / redirect rule in netlify.toml), not via this config.
export const config = {
  background: true,
};

const OPENAI_URL = 'https://api.openai.com/v1/images/edits';
const FEATHER_PX = 10; // Gaussian blur radius on the mask edge (the feather width)
const STORE = 'edit-jobs';

export default async (req) => {
  let jobId;
  try {
    const body = await req.json();
    jobId = body.jobId;
    const { imageB64, maskB64, prompt } = body; // browser strips the data: prefix
    if (!jobId) return; // nothing to key the result on; drop silently
    const store = getStore(STORE);

    const key = process.env.OPENAI_API_KEY;
    if (!key) return finish(store, jobId, { status: 'error', error: 'Server missing OPENAI_API_KEY.' });
    if (!imageB64 || !prompt) return finish(store, jobId, { status: 'error', error: 'missing image or prompt' });

    const imageBuf = Buffer.from(imageB64, 'base64');
    const maskBuf = maskB64 ? Buffer.from(maskB64, 'base64') : null; // optional
    if (imageBuf.length > 4_000_000 || (maskBuf && maskBuf.length > 4_000_000)) {
      return finish(store, jobId, { status: 'error', error: 'image/mask too large (max 4MB each)' });
    }

    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('image', new Blob([imageBuf], { type: 'image/png' }), 'image.png');
    if (maskBuf) form.append('mask', new Blob([maskBuf], { type: 'image/png' }), 'mask.png');
    form.append('prompt', String(prompt).slice(0, 1000));
    form.append('size', '1024x1024');
    form.append('quality', 'low');
    form.append('n', '1');

    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}` }, // fetch sets the multipart boundary
      body: form,
    });
    const data = await res.json();
    if (!res.ok) return finish(store, jobId, { status: 'error', error: data?.error?.message || 'edit failed' });

    const rawB64 = data.data[0]?.b64_json;
    if (!rawB64) return finish(store, jobId, { status: 'error', error: 'no image returned' });

    if (!maskBuf) {
      // No mask: the whole-image rebuild IS the result — nothing to composite.
      return finish(store, jobId, { status: 'done', image: rawB64 });
    }
    // Masked: composite the AI result back through a feathered mask, return both the
    // composite (default) and the raw whole-canvas output ("what the AI changed").
    const compositeB64 = await compositeMasked(imageBuf, maskBuf, Buffer.from(rawB64, 'base64'));
    return finish(store, jobId, { status: 'done', image: compositeB64, raw: rawB64 });
  } catch (e) {
    try {
      if (jobId) await getStore(STORE).setJSON(jobId, { status: 'error', error: e?.message || 'edit failed' });
    } catch (_) { /* best effort */ }
  }
};

// Write the finished job to the blob store (the browser polls edit-status for it).
async function finish(store, jobId, result) {
  await store.setJSON(jobId, result);
}

// Blend: out = source*(1-t) + aiResult*t, where t is a FEATHERED edit-strength map from
// the mask (alpha 0 = "edit here" => t=1; alpha 255 = "keep" => t=0), Gaussian-blurred so
// the boundary fades. All images are normalized to the source dims so pixels line up.
// NOTE: sharp expands a single-channel raw buffer to 3 channels on .raw().toBuffer()
// unless forced to 'b-w', which would misalign indexing — so single-channel reads pin it.
async function compositeMasked(sourceBuf, maskBuf, aiBuf) {
  const meta = await sharp(sourceBuf).metadata();
  const w = meta.width, h = meta.height;

  // Force sRGB (3 channels) before removeAlpha: a grayscale source/result would
  // otherwise yield a 1-channel raw buffer and the `s += 3` blend loop below would
  // read out of bounds. The client always sends square RGBA (the whole pipeline is
  // 1024x1024), so source/mask/ai already share dims — resize is a safety no-op that
  // also guards against any off-by-one from OpenAI, keeping the overlay pixel-exact.
  const source = await sharp(sourceBuf).toColourspace('srgb').removeAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer();
  const ai = await sharp(aiBuf).toColourspace('srgb').removeAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer();
  const maskAlpha = await sharp(maskBuf).ensureAlpha().resize(w, h, { fit: 'fill' })
    .extractChannel('alpha').toColourspace('b-w').raw().toBuffer();

  const strength = Buffer.alloc(w * h);
  for (let i = 0; i < strength.length; i++) strength[i] = 255 - maskAlpha[i];
  const feather = await sharp(strength, { raw: { width: w, height: h, channels: 1 } })
    .blur(FEATHER_PX).toColourspace('b-w').raw().toBuffer();

  const out = Buffer.alloc(w * h * 3);
  for (let p = 0, s = 0; p < feather.length; p++, s += 3) {
    const t = feather[p] / 255, it = 1 - t;
    out[s]     = (source[s]     * it + ai[s]     * t) | 0;
    out[s + 1] = (source[s + 1] * it + ai[s + 1] * t) | 0;
    out[s + 2] = (source[s + 2] * it + ai[s + 2] * t) | 0;
  }
  const png = await sharp(out, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  return png.toString('base64');
}

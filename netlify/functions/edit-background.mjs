// edit-background.mjs — the masked inpaint / touchup, run as a BACKGROUND function.
//
// WHY BACKGROUND: the OpenAI edit takes ~20-28s and the composite adds a couple more,
// which blows Netlify's synchronous function timeout (10s on the free plan). A
// background function returns 202 immediately and may run up to 15 min; it writes the
// result to Netlify Blobs, and the browser polls edit-status.mjs for it.
//
// INPUTS COME FROM BLOBS, NOT THE REQUEST BODY. Background functions have a hard 256 KB
// request-body limit — far smaller than a base64 1024x1024 PNG (~1.4 MB) + mask. So the
// browser POSTs the heavy payload to the SYNCHRONOUS edit-submit function (6 MB limit),
// which stashes it in Blobs under `input:<jobId>` and triggers this function with only
// { jobId }. We read the inputs back from Blobs here. (Passing the image in this request
// body was the old bug: Netlify rejected the oversized invocation at the platform layer —
// a 500 with NO function log because the handler never ran. See edit-submit.mjs.)
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
    // TIMING: log the moment this handler actually begins executing. Compared against the
    // `submit->trigger fired` timestamp in edit-submit's logs, the gap between them is the
    // pure Netlify queue + cold-start latency for the background invocation — the number
    // that's invisible today and the prime suspect for the 120s+ production wait.
    const tStart = Date.now();
    console.log(`[edit-timing] background handler start jobId=%s at=%d`, undefined, tStart);
    const body = await req.json();
    jobId = body.jobId;
    if (!jobId) return; // nothing to key the result on; drop silently
    console.log(`[edit-timing] jobId=%s handler-started`, jobId);
    const store = getStore(STORE);

    // The heavy inputs were stashed by edit-submit under `input:<jobId>` (this request
    // body is just { jobId }, to stay under the 256 KB background-function cap).
    const tBlobRead = Date.now();
    const input = await store.get(`input:${jobId}`, { type: 'json' });
    console.log(`[edit-timing] jobId=%s blobs-read=%dms`, jobId, Date.now() - tBlobRead);
    if (!input) return finish(store, jobId, { status: 'error', error: 'edit inputs expired or missing' });
    const { imageB64, maskB64, prompt } = input; // browser stripped the data: prefix

    const key = process.env.OPENAI_API_KEY;
    if (!key) return finish(store, jobId, { status: 'error', error: 'Server missing OPENAI_API_KEY.' });
    if (!imageB64 || !prompt) return finish(store, jobId, { status: 'error', error: 'missing image or prompt' });

    const imageBuf = Buffer.from(imageB64, 'base64');
    const maskBuf = maskB64 ? Buffer.from(maskB64, 'base64') : null; // optional
    if (imageBuf.length > 4_000_000 || (maskBuf && maskBuf.length > 4_000_000)) {
      return finish(store, jobId, { status: 'error', error: 'image/mask too large (max 4MB each)' });
    }

    // Cancellation point #1 — BEFORE the OpenAI call. This is the one that saves money:
    // if the user cancelled while this job sat in Netlify's queue / cold-started, we bail
    // here and never spend on the edit. Bailing writes no result (client isn't polling).
    if (await isCancelled(store, jobId)) {
      console.log(`[edit-timing] jobId=%s cancelled-before-openai`, jobId);
      return finishCancelled(store, jobId);
    }

    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('image', new Blob([imageBuf], { type: 'image/png' }), 'image.png');
    if (maskBuf) form.append('mask', new Blob([maskBuf], { type: 'image/png' }), 'mask.png');
    form.append('prompt', String(prompt).slice(0, 1000));
    form.append('size', '1024x1024');
    form.append('quality', 'low');
    form.append('n', '1');

    const tOpenAI = Date.now();
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}` }, // fetch sets the multipart boundary
      body: form,
    });
    const data = await res.json();
    // TIMING: pure OpenAI edit duration. If this is ~30s (matching local) the model is NOT
    // the bottleneck — the extra production latency is Netlify queue/cold-start above.
    console.log(`[edit-timing] jobId=%s openai=%dms status=%d`, jobId, Date.now() - tOpenAI, res.status);
    if (!res.ok) return finish(store, jobId, { status: 'error', error: data?.error?.message || 'edit failed' });

    const rawB64 = data.data[0]?.b64_json;
    if (!rawB64) return finish(store, jobId, { status: 'error', error: 'no image returned' });

    // Cancellation point #2 — AFTER OpenAI, before the composite. The spend already
    // happened, but the user isn't waiting for this result, so skip the ~couple-second
    // composite and write nothing. (The client stopped polling on cancel; a result blob
    // here would only linger unread.)
    if (await isCancelled(store, jobId)) {
      console.log(`[edit-timing] jobId=%s cancelled-after-openai`, jobId);
      return finishCancelled(store, jobId);
    }

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
      if (jobId) await finish(getStore(STORE), jobId, { status: 'error', error: e?.message || 'edit failed' });
    } catch (_) { /* best effort */ }
  }
};

// Write the finished job to the blob store (the browser polls edit-status for it), then
// drop the now-consumed input blob. Order matters: write the result FIRST so a failure
// deleting the (large) input never loses the result the user paid for. Also drop any
// cancel flag so it never lingers past the job it belonged to.
async function finish(store, jobId, result) {
  await store.setJSON(jobId, result);
  try { await store.delete(`input:${jobId}`); } catch (_) { /* best effort */ }
  try { await store.delete(`cancel:${jobId}`); } catch (_) { /* best effort */ }
}

// True if the browser posted a cancel flag for this job (see edit-cancel.mjs). Checked at
// this function's cancellation points so a cancelled job bails early. Read failures are
// swallowed as "not cancelled" — a missed cancel just finishes the job normally, and the
// client (which has stopped polling) ignores the result.
async function isCancelled(store, jobId) {
  try { return !!(await store.get(`cancel:${jobId}`, { type: 'json' })); }
  catch (_) { return false; }
}

// A job that bails on cancel writes NO result blob (the client isn't polling for one) —
// it only cleans up the input + cancel-flag blobs so nothing lingers.
async function finishCancelled(store, jobId) {
  try { await store.delete(`input:${jobId}`); } catch (_) { /* best effort */ }
  try { await store.delete(`cancel:${jobId}`); } catch (_) { /* best effort */ }
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

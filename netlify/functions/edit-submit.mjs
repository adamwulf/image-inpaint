// edit-submit.mjs — SYNCHRONOUS front door for the slow masked edit.
//
// WHY THIS EXISTS: edit-background is a Netlify BACKGROUND function, and background
// functions have a hard **256 KB request-body limit** (synchronous functions get 6 MB).
// The edit payload is a base64 1024x1024 PNG (~1.4 MB) plus an optional mask — 5-10x
// over that cap. Netlify rejects the oversized invocation at the PLATFORM layer, before
// the handler runs: the browser sees a 500 and `netlify logs:function edit-background`
// shows NOTHING (the handler never executed). It "worked" under `netlify dev` only
// because local dev has no 256 KB gate. See README deploy notes.
//
// THE HANDOFF: the browser POSTs the big payload HERE (synchronous, 6 MB limit — fits).
// We stash the inputs in Netlify Blobs under `input:<jobId>`, then trigger edit-background
// passing ONLY { jobId } (tiny, well under 256 KB). edit-background reads the inputs back
// from Blobs, does the ~25 s OpenAI edit + composite, and writes the result under <jobId>;
// the browser polls edit-status for it exactly as before.
//
// OPENAI_API_KEY is never touched here — this function only moves bytes into Blobs and
// kicks off the background job.
import { getStore } from '@netlify/blobs';

// Per-IP rate limit mirrors generate.mjs: this is the public entry point for the (paid)
// edit, so gate it the same way. Unlike edit-background, this function IS synchronous, so
// `config.rateLimit` is valid here (it runs in the edge layer that fronts sync functions).
// The free/Starter plan allows 2 rate-limit rules per project; generate + edit-submit use
// both. edit-background stays unlimited-by-config (backstopped by the OpenAI spend cap).
export const config = {
  rateLimit: {
    windowSize: 3,       // seconds
    windowLimit: 1,      // max requests per window
    aggregateBy: ['ip'], // key by client IP
  },
};

const STORE = 'edit-jobs';

export default async (req) => {
  try {
    const body = await req.json();
    const { jobId, imageB64, maskB64, prompt } = body; // browser strips the data: prefix
    if (!jobId) return json({ error: 'missing jobId' }, 400);
    if (!imageB64 || !prompt) return json({ error: 'missing image or prompt' }, 400);

    // Guard the same 4 MB/side ceiling edit-background enforced, but check it here where a
    // real HTTP status can be returned (the background function can only stash an error).
    const imageBytes = Math.floor(imageB64.length * 0.75); // base64 -> raw byte estimate
    const maskBytes = maskB64 ? Math.floor(maskB64.length * 0.75) : 0;
    if (imageBytes > 4_000_000 || maskBytes > 4_000_000) {
      return json({ error: 'image/mask too large (max 4MB each)' }, 413);
    }

    // Stash the heavy inputs in Blobs keyed by jobId; edit-background reads them back.
    const store = getStore(STORE);
    await store.setJSON(`input:${jobId}`, { imageB64, maskB64: maskB64 || null, prompt });

    // Fire the background job with only the jobId (tiny — safely under the 256 KB cap).
    // context.site.url would also work, but a relative path against the request origin is
    // robust across the deploy's own domain and any branch/deploy-preview subdomain.
    const origin = new URL(req.url).origin;
    const bgRes = await fetch(`${origin}/.netlify/functions/edit-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
    // Background functions answer 202 Accepted. Anything else means the trigger failed;
    // surface it AND drop the orphaned input blob so it doesn't linger.
    if (bgRes.status !== 202) {
      try { await store.delete(`input:${jobId}`); } catch (_) { /* best effort */ }
      return json({ error: `could not start the edit (${bgRes.status})` }, 502);
    }

    // Mirror the background 202 so the client's existing submitEdit() check is unchanged.
    return json({ status: 'accepted', jobId }, 202);
  } catch (e) {
    return json({ error: e?.message || 'could not submit the edit' }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

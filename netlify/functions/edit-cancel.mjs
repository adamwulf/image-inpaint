// edit-cancel.mjs — the browser calls this when the user cancels an in-flight edit.
// POST /edit-cancel?id=<jobId> -> write a tiny cancel FLAG blob (`cancel:<jobId>`);
//                                 { ok: true }.
//
// WHY A FLAG, NOT A KILL: edit-background is a Netlify BACKGROUND function — once it's
// running there's no API to abort it. Instead it checks for this flag at its cancellation
// points (before the OpenAI call, and again after) and bails early if set, cleaning up its
// own blobs. This is BEST EFFORT: if the job is already inside the OpenAI request when the
// flag lands, that request still completes (the spend is already committed) — but the client
// has stopped polling, so the result is simply written and then aged out, never shown.
//
// The flag is a few bytes and lives in the same per-deploy store as the job, so it ages out
// with the deploy even if edit-background never runs (e.g. cancel arrives before the queued
// job cold-starts). edit-background deletes it explicitly on the way out when it does run.
import { getStore } from '@netlify/blobs';

const STORE = 'edit-jobs';

export default async (req) => {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'missing job id' }, 400);
    // A short-lived marker the background job polls for. Value is irrelevant — presence is
    // the signal — but stamp it so a human reading the store can tell what it is.
    await getStore(STORE).setJSON(`cancel:${id}`, { cancelled: true });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e?.message || 'cancel failed' }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

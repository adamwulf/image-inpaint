// edit-status.mjs — the browser polls this for a background edit's result.
// GET /edit-status?id=<jobId>       -> { status: 'pending' } until edit-background writes
//                                      the job, then { status: 'done', image, raw? } or
//                                      { status: 'error', error }.
// GET /edit-status?id=<jobId>&ack=1 -> delete the (already-received) job blob; { ok: true }.
//
// IMPORTANT: reading a terminal result does NOT delete the blob. Deleting on read loses
// the result if the client's body read fails after a 200 (truncated/backgrounded tab) —
// the user paid for an edit and would never see it. Instead the CLIENT sends an explicit
// ack=1 only after it has successfully parsed the result, so a lost body can be recovered
// by simply re-polling the still-present blob. Un-acked blobs are small and the store is
// per-deploy; they age out and are harmless.
import { getStore } from '@netlify/blobs';

const STORE = 'edit-jobs';

export default async (req) => {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) return json({ status: 'error', error: 'missing job id' }, 400);

    // Explicit acknowledgement: the client got the result, so clean up.
    if (url.searchParams.get('ack')) {
      try { await getStore(STORE).delete(id); } catch (_) { /* best effort */ }
      return json({ ok: true });
    }

    const result = await getStore(STORE).get(id, { type: 'json' });
    if (!result) return json({ status: 'pending' });
    // Note: no delete here — the client acks after a successful read (see above).
    return json(result);
  } catch (e) {
    return json({ status: 'error', error: e?.message || 'status check failed' }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

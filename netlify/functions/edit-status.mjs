// edit-status.mjs — the browser polls this for a background edit's result.
// GET /edit-status?id=<jobId> -> { status: 'pending' } until edit-background writes the
// job, then { status: 'done', image, raw? } or { status: 'error', error }.
import { getStore } from '@netlify/blobs';

const STORE = 'edit-jobs';

export default async (req) => {
  try {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return json({ status: 'error', error: 'missing job id' }, 400);

    const result = await getStore(STORE).get(id, { type: 'json' });
    if (!result) return json({ status: 'pending' });

    // One-shot: clean up the blob once a terminal result is read.
    if (result.status === 'done' || result.status === 'error') {
      try { await getStore(STORE).delete(id); } catch (_) { /* best effort */ }
    }
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

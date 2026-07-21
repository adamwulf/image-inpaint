/* Image Generation & Editor — client logic
 *
 * Three mutually-exclusive tabs (Generate / Modify / Describe). All OpenAI calls
 * go through Netlify functions that hold the API key server-side; the browser only
 * ever POSTs base64 JSON and renders what comes back.
 *
 * The two silent traps, both handled below:
 *   1. A hidden .tabpane reports clientWidth 0 — the mask canvas can only be sized
 *      once its tab is visible (see measureMaskCanvas / activateTab).
 *   2. The visible mask canvas is CSS-scaled — pointer coords must be mapped back to
 *      image pixels before painting, and the exported mask uses alpha inversion
 *      (brushed => alpha 0 => "edit here").
 */
(function () {
  'use strict';

  // Fixed longest-edge downscale before upload. Matched to the model's output size
  // (1024) so the edit path has NO resample: source == mask == requested size ==
  // returned size == displayed size, all 1024². Avoids the 768-in / 1024-out /
  // 768-display round-trip that softened results.
  var MAX_EDGE = 1024;
  // Paint the mask OPAQUE (var(--nontop) magenta) so overlapping strokes stay a
  // single flat region; the canvas element's CSS opacity:0.5 makes the whole
  // layer an even translucent overlay you can always see through.
  var BRUSH_COLOR = 'rgb(224,108,255)'; // var(--nontop)

  var $ = function (id) { return document.getElementById(id); };

  /* -------------------------------------------------------------------------
   * TABS — true one-of-3, full ARIA, hash deep-linking
   * ---------------------------------------------------------------------- */
  var TABS = ['generate', 'modify', 'describe'];
  var tabbar = document.querySelector('.tabbar');

  function activateTab(name, updateHash) {
    if (TABS.indexOf(name) === -1) name = 'generate';
    TABS.forEach(function (t) {
      var btn = $('tab-btn-' + t);
      var pane = $('tab-' + t);
      var isActive = t === name;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      btn.tabIndex = isActive ? 0 : -1;
      pane.classList.toggle('active', isActive);
    });
    if (updateHash) {
      // Write the hash without adding a scroll jump / extra history churn.
      if (history.replaceState) history.replaceState(null, '', '#' + name);
      else location.hash = name;
    }
    // The Modify tab owns a container-sized canvas; measure it now that its
    // pane is visible (a hidden pane reports clientWidth 0).
    if (name === 'modify') {
      window.dispatchEvent(new Event('resize'));
      measureMaskCanvas();
    }
  }

  tabbar.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    activateTab(btn.getAttribute('data-tab'), true);
    btn.focus();
  });

  // Left/Right arrow navigation across the tablist (ARIA best practice).
  tabbar.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    var current = document.querySelector('.tabbar button.active');
    var idx = TABS.indexOf(current.getAttribute('data-tab'));
    var next = e.key === 'ArrowRight' ? (idx + 1) % TABS.length
                                      : (idx - 1 + TABS.length) % TABS.length;
    e.preventDefault();
    activateTab(TABS[next], true);
    $('tab-btn-' + TABS[next]).focus();
  });

  window.addEventListener('hashchange', function () {
    var name = location.hash.replace('#', '');
    if (TABS.indexOf(name) !== -1) activateTab(name, false);
  });

  /* -------------------------------------------------------------------------
   * Shared helpers
   * ---------------------------------------------------------------------- */

  // Aspect-fit a source (HTMLImageElement) into a SQUARE maxEdge x maxEdge canvas,
  // centered, on a WHITE background (letterbox). Keeping everything square means the
  // OpenAI edit can request size:'1024x1024' with no aspect distortion, and the
  // returned square result overlays the (square) source pixel-for-pixel in the
  // composite — a non-square input would otherwise come back square from gpt-image
  // and get squashed on the way back. White padding never loses image content (the
  // whole photo stays visible and maskable), and outside the mask the bars stay
  // white via the composite. Returns { canvas, width, height } (width === height).
  function downscaleToCanvas(img, maxEdge) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    var scale = Math.min(1, maxEdge / Math.max(w, h));
    var dw = Math.max(1, Math.round(w * scale));
    var dh = Math.max(1, Math.round(h * scale));
    var c = document.createElement('canvas');
    c.width = maxEdge; c.height = maxEdge;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, maxEdge, maxEdge);
    ctx.drawImage(img, Math.round((maxEdge - dw) / 2), Math.round((maxEdge - dh) / 2), dw, dh);
    return { canvas: c, width: maxEdge, height: maxEdge };
  }

  function canvasToPngBase64(canvas) {
    // dataURL -> strip the "data:image/png;base64," prefix
    return canvas.toDataURL('image/png').split(',')[1];
  }

  function stripPrefix(dataUrl) { return dataUrl.split(',')[1]; }

  function loadImageFromSrc(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Could not load image')); };
      img.src = src;
    });
  }

  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('Could not read file')); };
      r.readAsDataURL(file);
    });
  }

  // Simple indeterminate progress: animate to ~90% while a single POST is in flight.
  function makeProgress(track, fill) {
    var timer = null;
    return {
      start: function () {
        track.hidden = false;
        var pct = 8;
        fill.style.width = pct + '%';
        timer = setInterval(function () {
          pct = Math.min(90, pct + Math.max(1, (90 - pct) * 0.12));
          fill.style.width = pct + '%';
        }, 300);
      },
      done: function () {
        if (timer) { clearInterval(timer); timer = null; }
        fill.style.width = '100%';
        setTimeout(function () { track.hidden = true; fill.style.width = '0%'; }, 450);
      }
    };
  }

  function setStatus(el, msg, isError) {
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  async function postJson(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    var data;
    try { data = await res.json(); }
    catch (e) {
      // A non-JSON body on a server error is almost always the function timing out
      // (the OpenAI edit can take 20-30s and the serverless function is killed),
      // which returns an HTML error page. Surface a friendly, actionable message.
      if (res.status >= 500) {
        throw new Error('That took too long and timed out. Try again, or paint a smaller region / shorter prompt.');
      }
      throw new Error('Server returned an unreadable response (' + res.status + ')');
    }
    if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
    return data;
  }

  // Thrown when the user cancels an in-flight edit. The caller checks `err.cancelled`
  // to treat it as a quiet no-op (restore the UI) rather than surfacing an error.
  function CancelledError() {
    var e = new Error('cancelled');
    e.cancelled = true;
    return e;
  }

  // Submit a slow edit, then poll for its result. The heavy payload (base64 image + mask)
  // goes to the SYNCHRONOUS edit-submit function: background functions cap the request body
  // at 256 KB, far under a ~1.4 MB image, so posting the image straight to edit-background
  // gets rejected at Netlify's platform layer (a 500 with no function log). edit-submit
  // (6 MB limit) stashes the payload in Blobs and triggers edit-background with just the
  // jobId; edit-background does the ~25s work and stashes {status,image,raw|error} in Blobs
  // under the job id; edit-status returns it. Resolves with { image, raw? } or throws.
  //
  // opts.signal (an AbortSignal) makes the edit CANCELLABLE: aborting it stops the poll
  // loop, fires a best-effort edit-cancel so the background job bails early (and cleans up
  // its own blobs), and rejects with a CancelledError the caller treats as a quiet no-op.
  async function submitEdit(body, onProgress, opts) {
    var signal = opts && opts.signal;
    // If already aborted before we even start, don't fire the request.
    if (signal && signal.aborted) throw CancelledError();
    var jobId = 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    var res;
    try {
      res = await fetch('/.netlify/functions/edit-submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ jobId: jobId }, body)),
        signal: signal
      });
    } catch (e) {
      // An abort during the submit itself throws a native AbortError (a DOMException, not
      // our CancelledError). Convert it: cancel the (possibly not-yet-created) job and
      // report it as a user cancel; re-throw anything else (a real network failure).
      if (signal && signal.aborted) throw cancelJob(jobId);
      throw e;
    }
    // edit-submit returns 202 Accepted once the background job is triggered.
    if (res.status !== 202 && res.status !== 200) {
      throw new Error('Could not start the edit (' + res.status + ').');
    }
    // Poll edit-status until done/error, or give up after ~300s. (The background
    // function itself has up to 15 min; the client cap is generous but bounded so a
    // stuck job doesn't spin forever.) After ~150s we flag onProgress as "slow" so
    // the caller can reassure the user we're still waiting rather than stalled.
    var statusUrl = '/.netlify/functions/edit-status?id=' + encodeURIComponent(jobId);
    var start = Date.now();
    var deadline = start + 300000;
    var SLOW_AFTER = 150000;
    while (Date.now() < deadline) {
      if (signal && signal.aborted) throw cancelJob(jobId);
      await new Promise(function (r) { setTimeout(r, 1000); });
      if (signal && signal.aborted) throw cancelJob(jobId);
      // Fetch and parse are separated on purpose: a network hiccup OR a body that
      // fails to parse after a 200 (truncated response, backgrounded tab) must NOT
      // discard a finished result. Because edit-status no longer deletes on read, the
      // blob survives and the next poll recovers it; we only delete via an explicit
      // ack AFTER a successful parse below.
      var sres;
      try {
        sres = await fetch(statusUrl, { signal: signal });
      } catch (e) {
        if (signal && signal.aborted) throw cancelJob(jobId);
        continue; // transient network error — keep polling
      }
      var s;
      try {
        s = await sres.json();
      } catch (e) { continue; } // unreadable body — the blob is still there, re-poll
      if (s.status === 'done' || s.status === 'error') {
        // We have the result in hand; tell the server it can drop the blob now.
        fetch(statusUrl + '&ack=1').catch(function () {}); // best-effort cleanup
        if (s.status === 'error') throw new Error(s.error || 'edit failed');
        return s;
      }
      if (onProgress) onProgress({ slow: Date.now() - start >= SLOW_AFTER });
    }
    throw new Error('That took too long and timed out. Try again, or paint a smaller region / shorter prompt.');
  }

  // Tell the server to cancel a still-running background job, then return a CancelledError
  // for the poll loop to throw. edit-cancel writes a cancel flag the background function
  // checks (before/around the OpenAI call) so it bails early and cleans up its own blobs;
  // this is best-effort (a job already past its OpenAI call just finishes normally, and the
  // client ignores the result since it has already stopped polling).
  function cancelJob(jobId) {
    fetch('/.netlify/functions/edit-cancel?id=' + encodeURIComponent(jobId), { method: 'POST' })
      .catch(function () {}); // best-effort — client stops regardless
    return CancelledError();
  }

  /* Sample image. dog.png is a real Unsplash photo (Alvan Nee, Unsplash License,
     credited in the footer), 1024² (already square, so it letterboxes to itself).
     Used for both Modify and Describe "or use a sample". */
  var SAMPLES = {
    modify: 'samples/dog.png',
    describe: 'samples/dog.png'
  };

  /* =========================================================================
   * TAB 1 — GENERATE (text-to-image)
   * ====================================================================== */
  (function () {
    var prompt = $('genPrompt');
    var runBtn = $('genRunBtn');
    var clearBtn = $('genClearBtn');
    var status = $('genStatus');
    var frame = document.querySelector('#tab-generate .output-frame');
    var placeholder = $('genPlaceholder');
    var sendBtn = $('genSendToModifyBtn');
    var downloadBtn = $('genDownloadBtn');
    var progress = makeProgress($('genTrack'), $('genFill'));
    var lastDataUrl = null;

    function showImage(dataUrl) {
      lastDataUrl = dataUrl;
      var img = $('genImage');
      if (!img) {
        img = document.createElement('img');
        img.id = 'genImage';
        img.alt = 'Generated image';
        frame.appendChild(img);
      }
      img.src = dataUrl;
      if (placeholder) placeholder.style.display = 'none';
      sendBtn.disabled = false;
      downloadBtn.disabled = false;
    }

    runBtn.addEventListener('click', async function () {
      var text = prompt.value.trim();
      if (!text) { setStatus(status, 'Enter a prompt first.', true); return; }
      runBtn.disabled = true;
      setStatus(status, 'Generating…', false);
      progress.start();
      try {
        var data = await postJson('/.netlify/functions/generate', { prompt: text });
        showImage('data:image/png;base64,' + data.image);
        setStatus(status, 'Done.', false);
      } catch (err) {
        setStatus(status, err.message, true);
      } finally {
        progress.done();
        runBtn.disabled = false;
      }
    });

    clearBtn.addEventListener('click', function () {
      prompt.value = '';
      var img = $('genImage');
      if (img) img.remove();
      if (placeholder) placeholder.style.display = '';
      lastDataUrl = null;
      sendBtn.disabled = true;
      downloadBtn.disabled = true;
      setStatus(status, 'Enter a prompt and press Generate.', false);
    });

    downloadBtn.addEventListener('click', function () {
      if (!lastDataUrl) return;
      var a = document.createElement('a');
      a.href = lastDataUrl;
      a.download = 'generated.png';
      a.click();
    });

    sendBtn.addEventListener('click', function () {
      if (!lastDataUrl) return;
      activateTab('modify', true);
      $('tab-btn-modify').focus();
      // loadModifyImage is exposed on the Modify module below.
      window.__loadModifyImage(lastDataUrl);
    });
  })();

  /* =========================================================================
   * TAB 2 — MODIFY (masked inpaint)
   * ====================================================================== */
  var measureMaskCanvas; // hoisted; defined inside the Modify IIFE
  (function () {
    var frame = $('modFrame');
    var placeholder = $('modPlaceholder');
    var maskCanvas = $('maskCanvas');
    var fileInput = $('modFileInput');
    var promptEl = $('modPrompt');
    var brush = $('brushSize');
    var brushValue = $('brushSizeValue');
    var runBtn = $('modRunBtn');
    var cancelBtn = $('modCancelBtn');
    var clearBtn = $('modClearMaskBtn');
    var status = $('modStatus');
    var chooseBtn = $('modChooseBtn');
    var sampleBtn = $('modSampleBtn');
    var sendToDescribeBtn = $('modSendToDescribeBtn');
    var downloadBtn = $('modDownloadBtn');
    var viewToggle = $('modView');
    var versionsEl = $('modVersions');
    var versionsEmpty = $('modVersionsEmpty');
    var progress = makeProgress($('modTrack'), $('modFill'));

    // The current image lives on this offscreen canvas at 1024² (square, letterboxed);
    // the mask canvas is sized to EXACTLY the same pixel dims so OpenAI accepts the pair.
    var sourceCanvas = null;   // { canvas, width, height } of the CURRENT version
    var maskCtx = maskCanvas.getContext('2d');
    var painted = false;       // has anything been painted onto the mask?
    var painting = false;
    // While an edit is in flight the mask/version UI is LOCKED so the submitted mask can't
    // be changed out from under the running job (which would produce a mismatched result).
    // `editAbort` is the AbortController for the current edit; Cancel aborts it.
    var editing = false;
    var editAbort = null;

    // Iterative version history: v1 = the loaded original, then each result.
    // Clicking a thumbnail makes that version current so it can be edited further.
    var versions = [];         // [{ src, raw, label, pinned }]
    var currentIndex = -1;
    // Which image of the current version is ACTIVE (displayed + editable + exported):
    // 'result' = the mask-confined composite (default), 'raw' = the raw AI output.
    var viewMode = 'result';

    function hasImage() { return !!sourceCanvas; }

    // Map a pointer event to image-pixel coords on the mask canvas.
    function eventToImagePx(e) {
      var rect = maskCanvas.getBoundingClientRect();
      var cx = (e.clientX - rect.left);
      var cy = (e.clientY - rect.top);
      // The canvas is object-fit: contain inside a square frame — the displayed
      // image box may be letterboxed, so compute the actual drawn box and map back.
      var scale = Math.min(rect.width / maskCanvas.width, rect.height / maskCanvas.height);
      var drawnW = maskCanvas.width * scale;
      var drawnH = maskCanvas.height * scale;
      var offX = (rect.width - drawnW) / 2;
      var offY = (rect.height - drawnH) / 2;
      return { x: (cx - offX) / scale, y: (cy - offY) / scale };
    }

    // Paint directly onto the mask canvas as the pointer moves (no undo stack —
    // the only mask control is Clear).
    var lastPt = null;
    function paintDot(p) {
      maskCtx.fillStyle = BRUSH_COLOR;
      maskCtx.strokeStyle = BRUSH_COLOR;
      maskCtx.lineCap = 'round';
      maskCtx.lineJoin = 'round';
      maskCtx.lineWidth = Number(brush.value);
      // Always drop a round cap at the point AND connect from the previous point,
      // so a drag reads as one continuous path rather than discrete circles.
      maskCtx.beginPath();
      maskCtx.arc(p.x, p.y, Number(brush.value) / 2, 0, Math.PI * 2);
      maskCtx.fill();
      if (lastPt) {
        maskCtx.beginPath();
        maskCtx.moveTo(lastPt.x, lastPt.y);
        maskCtx.lineTo(p.x, p.y);
        maskCtx.stroke();
      }
      lastPt = p;
      painted = true;
    }

    function startPaint(e) {
      if (!hasImage() || editing) return; // mask is locked while an edit is in flight
      e.preventDefault();
      painting = true;
      lastPt = null;
      paintDot(eventToImagePx(e));
      updateMaskButtons();
      maskCanvas.setPointerCapture && maskCanvas.setPointerCapture(e.pointerId);
    }
    function movePaint(e) {
      if (!painting) return;
      e.preventDefault();
      paintDot(eventToImagePx(e));
    }
    function endPaint() {
      if (!painting) return;
      painting = false;
      lastPt = null;
      updateMaskButtons();
    }

    maskCanvas.addEventListener('pointerdown', startPaint);
    maskCanvas.addEventListener('pointermove', movePaint);
    maskCanvas.addEventListener('pointerup', endPaint);
    maskCanvas.addEventListener('pointerleave', endPaint);
    maskCanvas.addEventListener('pointercancel', endPaint);

    function clearMask() {
      maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      painted = false;
      lastPt = null;
      updateMaskButtons();
    }

    function updateMaskButtons() {
      // Regenerate works with OR without a mask: with a mask it's a masked edit
      // (composited), without one the AI rebuilds the whole image from the prompt.
      // While an edit is in flight everything mask-related is locked (see setEditing).
      runBtn.disabled = editing || !hasImage();
      clearBtn.disabled = editing || !painted;
    }

    // Lock/unlock the mask + version UI around an in-flight edit. Locking keeps the
    // SUBMITTED mask fixed (no painting, no Clear, no switching versions/views) so the
    // running job's result always matches the mask it was given. Swaps Regenerate for a
    // Cancel button; the caller owns editAbort (Cancel aborts it).
    function setEditing(on) {
      editing = on;
      cancelBtn.hidden = !on;
      if (on) cancelBtn.disabled = false; // re-arm Cancel each time we enter editing
      runBtn.hidden = on;
      maskCanvas.classList.toggle('locked', on); // CSS: not-allowed cursor while locked
      updateMaskButtons();
    }

    // Re-assert the mask canvas backing store to the current image's px dims.
    // A hidden .tabpane reports clientWidth 0, so this is re-run whenever the
    // Modify tab is shown (see activateTab) as well as on each new current image.
    measureMaskCanvas = function () {
      if (!sourceCanvas) return;
      if (maskCanvas.width !== sourceCanvas.width || maskCanvas.height !== sourceCanvas.height) {
        maskCanvas.width = sourceCanvas.width;
        maskCanvas.height = sourceCanvas.height;
        clearMask();
      }
    };

    // Make a version (by its dataURL) the CURRENT image in the editor: draw it to
    // the source canvas and size the mask to match. preserveMask keeps the current
    // brush strokes (so you can regenerate the same region again); otherwise the
    // mask is cleared. Note: assigning canvas.width/height ALWAYS clears the canvas,
    // so to preserve we must snapshot and restore the pixels across a resize.
    async function setCurrentImage(url, preserveMask) {
      var img = await loadImageFromSrc(url);
      sourceCanvas = downscaleToCanvas(img, MAX_EDGE);

      var baseImg = $('modImage');
      if (!baseImg) {
        baseImg = document.createElement('img');
        baseImg.id = 'modImage';
        baseImg.alt = 'Image to edit';
        frame.insertBefore(baseImg, maskCanvas);
      }
      baseImg.src = sourceCanvas.canvas.toDataURL('image/png');

      if (placeholder) placeholder.style.display = 'none';
      frame.classList.remove('drop');
      frame.classList.add('masking');

      var dimsChanged = maskCanvas.width !== sourceCanvas.width ||
                        maskCanvas.height !== sourceCanvas.height;

      if (preserveMask && !dimsChanged) {
        // Same dims + keep the strokes: nothing to do, the mask stays as painted.
        return;
      }
      if (preserveMask && dimsChanged) {
        // Different dims: rescale the existing mask onto the new-sized canvas.
        var snapshot = document.createElement('canvas');
        snapshot.width = maskCanvas.width;
        snapshot.height = maskCanvas.height;
        snapshot.getContext('2d').drawImage(maskCanvas, 0, 0);
        maskCanvas.width = sourceCanvas.width;
        maskCanvas.height = sourceCanvas.height;
        maskCtx.drawImage(snapshot, 0, 0, sourceCanvas.width, sourceCanvas.height);
        // painted flag is unchanged; refresh button state.
        updateMaskButtons();
        return;
      }
      // Default: size the mask to the image and clear it.
      maskCanvas.width = sourceCanvas.width;
      maskCanvas.height = sourceCanvas.height;
      clearMask();
    }

    function renderVersions() {
      if (!versions.length) {
        versionsEl.innerHTML = '';
        versionsEl.appendChild(versionsEmpty);
        versionsEmpty.style.display = '';
        return;
      }
      versionsEmpty.style.display = 'none';
      versionsEl.innerHTML = '';
      versions.forEach(function (v, i) {
        var tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'version' + (i === currentIndex ? ' active' : '');
        tile.dataset.index = String(i);
        tile.setAttribute('aria-pressed', i === currentIndex ? 'true' : 'false');
        var thumb = document.createElement('div');
        thumb.className = 'thumb';
        var tImg = document.createElement('img');
        tImg.src = v.src;
        tImg.alt = v.label;
        thumb.appendChild(tImg);
        if (v.pinned) {
          var pin = document.createElement('span');
          pin.className = 'pin';
          pin.textContent = 'Orig';
          thumb.appendChild(pin);
        }
        var label = document.createElement('span');
        label.className = 'label';
        label.textContent = v.label;
        tile.appendChild(thumb);
        tile.appendChild(label);
        versionsEl.appendChild(tile);
      });
      // Auto-scroll to the newest tile on the right.
      versionsEl.scrollLeft = versionsEl.scrollWidth;
      // There's a current image, so the export buttons apply.
      sendToDescribeBtn.disabled = false;
      downloadBtn.disabled = false;
      updateViewToggle();
    }

    // The ACTIVE image of the current version — respects the result/raw view toggle,
    // so Download, "Use in Describe", and the next Regenerate all use whichever image
    // is currently shown.
    function currentSrc() {
      var v = currentIndex >= 0 ? versions[currentIndex] : null;
      if (!v) return null;
      return (viewMode === 'raw' && v.raw) ? v.raw : v.src;
    }

    // Show the Result/Raw view toggle only when the current version has a raw AI
    // image (i.e. a regenerated version, not the loaded Original); reset to Result.
    function updateViewToggle() {
      // A new current version always starts on the 'result' (composite) view.
      viewMode = 'result';
      var v = currentIndex >= 0 ? versions[currentIndex] : null;
      var hasRaw = !!(v && v.raw);
      viewToggle.hidden = !hasRaw;
      if (!hasRaw) return;
      Array.prototype.forEach.call(viewToggle.children, function (b) {
        b.classList.toggle('active', b.getAttribute('data-view') === 'result');
      });
    }

    // Select an existing version as current (from a thumbnail click). Keep the
    // painted mask (preserveMask=true) — it only clears on "Clear mask".
    async function selectVersion(i) {
      if (editing) return; // version switching is locked while an edit is in flight
      if (i < 0 || i >= versions.length || i === currentIndex) return;
      currentIndex = i;
      try {
        await setCurrentImage(versions[i].src, true);
        renderVersions();
        setStatus(status, 'Editing ' + versions[i].label + '. Paint a region, then Regenerate.', false);
      } catch (err) {
        setStatus(status, err.message, true);
      }
    }

    versionsEl.addEventListener('click', function (e) {
      var tile = e.target.closest('.version');
      if (!tile) return;
      selectVersion(Number(tile.dataset.index));
    });

    // Start a FRESH history from a newly loaded image (upload / sample / Generate).
    async function loadModifyImage(src) {
      try {
        // Normalize whatever we were given to a PNG dataURL for the history.
        var img = await loadImageFromSrc(src);
        var scaled = downscaleToCanvas(img, MAX_EDGE);
        var url = scaled.canvas.toDataURL('image/png');
        versions = [{ src: url, label: 'Original', pinned: true }];
        currentIndex = 0;
        await setCurrentImage(url);
        renderVersions();
        setStatus(status, 'Paint a region to change just that, or press Regenerate to rebuild the whole image.', false);
      } catch (err) {
        setStatus(status, err.message, true);
      }
    }
    // Expose for the Generate "Send to Modify" bridge.
    window.__loadModifyImage = loadModifyImage;

    // Build the OpenAI mask PNG: brushed pixels -> alpha 0 ("edit here"),
    // unpainted -> alpha 255 ("keep"). RGB is irrelevant.
    function exportMaskBase64() {
      var w = maskCanvas.width, h = maskCanvas.height;
      var out = document.createElement('canvas');
      out.width = w; out.height = h;
      var octx = out.getContext('2d');
      octx.drawImage(maskCanvas, 0, 0);
      var imgData = octx.getImageData(0, 0, w, h);
      var d = imgData.data;
      for (var i = 0; i < d.length; i += 4) {
        var brushed = d[i + 3] > 0;      // painted anywhere = brushed
        d[i] = d[i + 1] = d[i + 2] = 0;  // RGB irrelevant to OpenAI
        d[i + 3] = brushed ? 0 : 255;    // INVERSION: brushed => transparent => "edit here"
      }
      octx.putImageData(imgData, 0, 0);
      return canvasToPngBase64(out);
    }

    // ---- controls ----
    brush.addEventListener('input', function () {
      brushValue.textContent = brush.value;
    });

    clearBtn.addEventListener('click', function () {
      clearMask();
      setStatus(status, 'Mask cleared. Paint again to regenerate.', false);
    });

    // "Choose image…" / "or use a sample" links below the frame.
    chooseBtn.addEventListener('click', function () { fileInput.click(); });
    sampleBtn.addEventListener('click', function () { loadModifyImage(SAMPLES.modify); });

    // Result / "What the AI changed" view toggle. Whichever image is shown becomes
    // the ACTIVE image: it loads into the editor as the base (keeping the mask), so
    // the next Regenerate / Download / "Use in Describe" all act on it.
    viewToggle.addEventListener('click', async function (e) {
      if (editing) return; // Result/Raw switching is locked while an edit is in flight
      var btn = e.target.closest('button[data-view]');
      if (!btn) return;
      var mode = btn.getAttribute('data-view');
      var v = currentIndex >= 0 ? versions[currentIndex] : null;
      if (!v || (mode === 'raw' && !v.raw) || mode === viewMode) return;
      viewMode = mode;
      Array.prototype.forEach.call(viewToggle.children, function (b) {
        b.classList.toggle('active', b === btn);
      });
      // Load the chosen image as the editable base, keeping the painted mask.
      await setCurrentImage(mode === 'raw' ? v.raw : v.src, true);
    });

    // Export the current version: send it to Describe (mirror of Generate's
    // Send-to-Modify), or download it.
    sendToDescribeBtn.addEventListener('click', function () {
      var src = currentSrc();
      if (!src) return;
      activateTab('describe', true);
      $('tab-btn-describe').focus();
      window.__loadDescribeImage(src);
    });

    downloadBtn.addEventListener('click', function () {
      var src = currentSrc();
      if (!src) return;
      var a = document.createElement('a');
      a.href = src;
      a.download = (currentIndex === 0 ? 'original' : 'version-' + (currentIndex + 1)) + '.png';
      a.click();
    });

    fileInput.addEventListener('change', async function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      var url = await fileToDataUrl(fileInput.files[0]);
      loadModifyImage(url);
      fileInput.value = ''; // allow re-choosing the same file
    });

    // Click-to-upload only in the empty state; once loaded, clicks paint.
    frame.addEventListener('click', function (e) {
      if (!hasImage() && !e.target.closest('canvas')) fileInput.click();
    });
    frame.addEventListener('dragover', function (e) { e.preventDefault(); frame.classList.add('dragover'); });
    frame.addEventListener('dragleave', function () { frame.classList.remove('dragover'); });
    frame.addEventListener('drop', async function (e) {
      e.preventDefault();
      frame.classList.remove('dragover');
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) { var url = await fileToDataUrl(file); loadModifyImage(url); }
    });

    // ---- run: with a mask it's a masked edit (composited); without a mask the AI
    // rebuilds the whole image. Either way the result becomes a new current version.
    runBtn.addEventListener('click', async function () {
      if (editing) return; // ignore double-clicks while an edit is already running
      if (!hasImage()) { setStatus(status, 'Load an image first.', true); return; }
      var text = promptEl.value.trim();
      if (!text) { setStatus(status, 'Enter a prompt first.', true); return; }
      var masked = painted;

      // Enter the editing state: lock the mask/version UI and swap Regenerate for Cancel.
      editAbort = new AbortController();
      setEditing(true);
      setStatus(status, masked ? 'Regenerating masked region…' : 'Regenerating the whole image…', false);
      progress.start();
      try {
        var body = { imageB64: canvasToPngBase64(sourceCanvas.canvas), prompt: text };
        // Only send a mask when one is painted; no mask => full-image rebuild.
        if (masked) body.maskB64 = exportMaskBase64();
        // The edit is slow (~25s), so it runs as a background function: submit, then
        // poll for the result. status updates keep the user informed while awaiting.
        // The abort signal lets Cancel stop the poll (and bail the server job).
        var data = await submitEdit(body, function (p) {
          var base = masked ? 'Regenerating masked region' : 'Regenerating the whole image';
          setStatus(status, base + (p && p.slow
            ? '… still working, this one is taking longer than usual — hang tight'
            : '… still working'), false);
        }, { signal: editAbort.signal });
        // Masked edits return `image` = the feathered composite (only the masked region
        // changed) plus `raw` = the whole canvas the model regenerated. A no-mask rebuild
        // returns just `image` (there's nothing to composite / no "raw vs result").
        var resultUrl = 'data:image/png;base64,' + data.image;
        var rawUrl = data.raw ? 'data:image/png;base64,' + data.raw : null;
        // Append as a new version and make it current, KEEPING any mask so the same
        // region can be regenerated again without re-painting.
        versions.push({ src: resultUrl, raw: rawUrl, label: 'v' + (versions.length + 1) });
        currentIndex = versions.length - 1;
        await setCurrentImage(resultUrl, true);
        renderVersions();
        setStatus(status, 'Done — now editing ' + versions[currentIndex].label +
          (masked ? '. Mask kept; paint more or Clear mask.' : '.'), false);
      } catch (err) {
        // A user cancel is a quiet no-op: the mask/version state is untouched, so just
        // report it and let the finally clause restore the UI. Everything else is a real
        // error worth surfacing.
        if (err && err.cancelled) {
          setStatus(status, 'Canceled. Your mask is unchanged — edit it and Regenerate again.', false);
        } else {
          setStatus(status, err.message, true);
        }
      } finally {
        editAbort = null;
        progress.done();
        setEditing(false); // unlock the mask/version UI and restore Regenerate
      }
    });

    // Cancel an in-flight edit: abort the poll (submitEdit throws CancelledError and also
    // fires edit-cancel so the background job bails). The run handler's finally restores
    // the UI. The submitted mask is never touched, so the user resumes exactly where they
    // were. Disable Cancel immediately so a double-click can't fire against a stale signal.
    cancelBtn.addEventListener('click', function () {
      if (!editAbort) return;
      cancelBtn.disabled = true;
      setStatus(status, 'Canceling…', false);
      editAbort.abort();
    });

    // Keep the mask backing store correct if the window resizes while visible.
    window.addEventListener('resize', function () { measureMaskCanvas(); });
  })();

  /* =========================================================================
   * TAB 3 — DESCRIBE (image-to-text vision)
   * ====================================================================== */
  (function () {
    var frame = $('descFrame');
    var placeholder = $('descPlaceholder');
    var fileInput = $('descFileInput');
    var runBtn = $('descRunBtn');
    var clearBtn = $('descClearBtn');
    var status = $('descStatus');
    var out = $('descOut');
    var chooseBtn = $('descChooseBtn');
    var sampleBtn = $('descSampleBtn');
    var modeToggle = $('descMode');
    var progress = makeProgress($('descTrack'), $('descFill'));

    var sourceCanvas = null; // 1024² square (letterboxed) offscreen canvas
    var mode = 'describe';

    function loadDescribeImage(src) {
      return loadImageFromSrc(src).then(function (img) {
        sourceCanvas = downscaleToCanvas(img, MAX_EDGE);
        var baseImg = $('descImage');
        if (!baseImg) {
          baseImg = document.createElement('img');
          baseImg.id = 'descImage';
          baseImg.alt = 'Image to describe';
          frame.appendChild(baseImg);
        }
        baseImg.src = sourceCanvas.canvas.toDataURL('image/png');
        if (placeholder) placeholder.style.display = 'none';
        frame.classList.remove('drop');
        frame.classList.add('masking'); // reuse solid-border state (no crosshair needed but border reads as loaded)
        // Start fresh on this image: clear any prior description.
        out.textContent = 'The model’s description will appear here.';
        out.classList.add('empty');
        runBtn.disabled = false;
        clearBtn.disabled = false;
        setStatus(status, 'Press Describe.', false);
      }).catch(function (err) { setStatus(status, err.message, true); });
    }
    // Expose for the Modify "Use in Describe" bridge.
    window.__loadDescribeImage = loadDescribeImage;

    modeToggle.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      Array.prototype.forEach.call(modeToggle.children, function (b) {
        b.classList.toggle('active', b === btn);
      });
      mode = btn.getAttribute('data-mode');
      runBtn.textContent = (mode === 'ocr' ? 'Read text' : 'Describe') + ' →';
    });

    chooseBtn.addEventListener('click', function () { fileInput.click(); });
    sampleBtn.addEventListener('click', function () { loadDescribeImage(SAMPLES.describe); });

    fileInput.addEventListener('change', async function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      var url = await fileToDataUrl(fileInput.files[0]);
      loadDescribeImage(url);
      fileInput.value = ''; // allow re-choosing the same file
    });

    frame.addEventListener('click', function () { if (!sourceCanvas) fileInput.click(); });
    frame.addEventListener('dragover', function (e) { e.preventDefault(); frame.classList.add('dragover'); });
    frame.addEventListener('dragleave', function () { frame.classList.remove('dragover'); });
    frame.addEventListener('drop', async function (e) {
      e.preventDefault();
      frame.classList.remove('dragover');
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) { var url = await fileToDataUrl(file); loadDescribeImage(url); }
    });

    clearBtn.addEventListener('click', function () {
      sourceCanvas = null;
      var img = $('descImage');
      if (img) img.remove();
      if (placeholder) placeholder.style.display = '';
      frame.classList.add('drop');
      frame.classList.remove('masking');
      out.textContent = 'The model’s description will appear here.';
      out.classList.add('empty');
      runBtn.disabled = true;
      clearBtn.disabled = true;
      setStatus(status, 'Load an image, then press Describe.', false);
    });

    runBtn.addEventListener('click', async function () {
      if (!sourceCanvas) { setStatus(status, 'Load an image first.', true); return; }
      runBtn.disabled = true;
      setStatus(status, mode === 'ocr' ? 'Reading text…' : 'Describing…', false);
      progress.start();
      try {
        var imageB64 = canvasToPngBase64(sourceCanvas.canvas);
        var data = await postJson('/.netlify/functions/describe', {
          imageB64: imageB64, mode: mode
        });
        out.textContent = data.text;
        out.classList.remove('empty');
        setStatus(status, 'Done.', false);
      } catch (err) {
        setStatus(status, err.message, true);
      } finally {
        progress.done();
        runBtn.disabled = false;
      }
    });
  })();

  /* -------------------------------------------------------------------------
   * Boot — deep-link to the hash tab BEFORE the first mask-canvas measure.
   * ---------------------------------------------------------------------- */
  var initial = location.hash.replace('#', '');
  activateTab(TABS.indexOf(initial) !== -1 ? initial : 'generate', false);
})();

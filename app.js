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

  var MAX_EDGE = 768; // fixed longest-edge downscale before upload
  var BRUSH_RGBA = 'rgba(224,108,255,0.5)'; // var(--nontop) @ .5

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

  // Draw a source (HTMLImageElement) onto a canvas scaled to <=768 longest edge.
  // Returns { canvas, width, height }.
  function downscaleToCanvas(img, maxEdge) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    var scale = Math.min(1, maxEdge / Math.max(w, h));
    var dw = Math.max(1, Math.round(w * scale));
    var dh = Math.max(1, Math.round(h * scale));
    var c = document.createElement('canvas');
    c.width = dw; c.height = dh;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, dw, dh);
    return { canvas: c, width: dw, height: dh };
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
    catch (e) { throw new Error('Server returned an unreadable response (' + res.status + ')'); }
    if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
    return data;
  }

  /* Sample images (bundled clearly-labeled placeholders — see README).
     They are self-contained SVGs (no external refs) so drawing them to a canvas
     for downscale + getImageData does not taint it. */
  var SAMPLES = {
    modify: 'samples/portrait.svg',
    describe: 'samples/street-sign.svg'
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
    var undoBtn = $('modUndoBtn');
    var clearBtn = $('modClearMaskBtn');
    var status = $('modStatus');
    var sourceToggle = $('modSource');
    var beforeSlot = $('modBeforeSlot');
    var afterSlot = $('modAfterSlot');
    var progress = makeProgress($('modTrack'), $('modFill'));

    // The downscaled source lives on this offscreen canvas at <=768 px; the mask
    // canvas is sized to EXACTLY the same pixel dims so OpenAI accepts the pair.
    var sourceCanvas = null; // { canvas, width, height }
    var maskCtx = maskCanvas.getContext('2d');
    var strokes = [];        // stack of completed strokes (arrays of points) for Undo
    var currentStroke = null;
    var painting = false;

    function hasImage() { return !!sourceCanvas; }

    // Map a pointer event to image-pixel coords on the mask canvas.
    function eventToImagePx(e) {
      var rect = maskCanvas.getBoundingClientRect();
      var cx = (e.clientX - rect.left);
      var cy = (e.clientY - rect.top);
      // The canvas is object-fit: contain inside a square frame — but because we
      // size the backing store to the image dims AND the element fills the frame
      // with contain, the displayed image box may be letterboxed. Compute the
      // actual drawn box so painting lands on the image.
      var scale = Math.min(rect.width / maskCanvas.width, rect.height / maskCanvas.height);
      var drawnW = maskCanvas.width * scale;
      var drawnH = maskCanvas.height * scale;
      var offX = (rect.width - drawnW) / 2;
      var offY = (rect.height - drawnH) / 2;
      var x = (cx - offX) / scale;
      var y = (cy - offY) / scale;
      return { x: x, y: y };
    }

    function redraw() {
      maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      maskCtx.strokeStyle = BRUSH_RGBA;
      maskCtx.fillStyle = BRUSH_RGBA;
      maskCtx.lineCap = 'round';
      maskCtx.lineJoin = 'round';
      strokes.forEach(function (s) { drawStroke(s); });
      if (currentStroke) drawStroke(currentStroke);
    }

    function drawStroke(s) {
      if (!s.points.length) return;
      maskCtx.lineWidth = s.size;
      if (s.points.length === 1) {
        var p = s.points[0];
        maskCtx.beginPath();
        maskCtx.arc(p.x, p.y, s.size / 2, 0, Math.PI * 2);
        maskCtx.fill();
        return;
      }
      maskCtx.beginPath();
      maskCtx.moveTo(s.points[0].x, s.points[0].y);
      for (var i = 1; i < s.points.length; i++) {
        maskCtx.lineTo(s.points[i].x, s.points[i].y);
      }
      maskCtx.stroke();
    }

    function startPaint(e) {
      if (!hasImage()) return;
      e.preventDefault();
      painting = true;
      currentStroke = { size: Number(brush.value), points: [] };
      var p = eventToImagePx(e);
      currentStroke.points.push(p);
      redraw();
      maskCanvas.setPointerCapture && maskCanvas.setPointerCapture(e.pointerId);
    }
    function movePaint(e) {
      if (!painting) return;
      e.preventDefault();
      currentStroke.points.push(eventToImagePx(e));
      redraw();
    }
    function endPaint() {
      if (!painting) return;
      painting = false;
      if (currentStroke && currentStroke.points.length) strokes.push(currentStroke);
      currentStroke = null;
      updateMaskButtons();
    }

    maskCanvas.addEventListener('pointerdown', startPaint);
    maskCanvas.addEventListener('pointermove', movePaint);
    maskCanvas.addEventListener('pointerup', endPaint);
    maskCanvas.addEventListener('pointerleave', endPaint);
    maskCanvas.addEventListener('pointercancel', endPaint);

    function updateMaskButtons() {
      var canRun = hasImage() && strokes.length > 0;
      runBtn.disabled = !canRun;
      undoBtn.disabled = strokes.length === 0;
      clearBtn.disabled = strokes.length === 0;
    }

    // Size the mask canvas backing store to the source image's px dims. Only
    // meaningful once the pane is visible (clientWidth-0 gotcha) — but the
    // backing store is set to the image dims regardless of display size, and the
    // element is stretched by CSS. We still re-run on tab show for safety.
    measureMaskCanvas = function () {
      if (!sourceCanvas) return;
      if (maskCanvas.width !== sourceCanvas.width || maskCanvas.height !== sourceCanvas.height) {
        maskCanvas.width = sourceCanvas.width;
        maskCanvas.height = sourceCanvas.height;
        redraw();
      }
    };

    // Load a base image (from upload / sample / Generate bridge) into the frame.
    async function loadModifyImage(src) {
      try {
        var img = await loadImageFromSrc(src);
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

        // Mask canvas matches the source pixel dims exactly.
        maskCanvas.width = sourceCanvas.width;
        maskCanvas.height = sourceCanvas.height;
        strokes = [];
        currentStroke = null;
        redraw();
        updateMaskButtons();

        // Before slot mirrors the loaded original.
        beforeSlot.innerHTML = '';
        var beforeImg = document.createElement('img');
        beforeImg.src = baseImg.src;
        beforeImg.alt = 'Original';
        beforeSlot.appendChild(beforeImg);

        setStatus(status, 'Paint the area to regenerate, then press Regenerate.', false);
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

    undoBtn.addEventListener('click', function () {
      strokes.pop();
      redraw();
      updateMaskButtons();
    });

    clearBtn.addEventListener('click', function () {
      strokes = [];
      currentStroke = null;
      redraw();
      updateMaskButtons();
      setStatus(status, 'Mask cleared. Paint again to regenerate.', false);
    });

    // Source toggle (Upload / Sample)
    sourceToggle.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-source]');
      if (!btn) return;
      Array.prototype.forEach.call(sourceToggle.children, function (b) {
        b.classList.toggle('active', b === btn);
      });
      if (btn.getAttribute('data-source') === 'upload') {
        fileInput.click();
      } else {
        loadModifyImage(SAMPLES.modify);
      }
    });

    fileInput.addEventListener('change', async function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      var url = await fileToDataUrl(fileInput.files[0]);
      loadModifyImage(url);
    });

    // Drop-to-load on the frame (only meaningful in the empty/drop state, but
    // allowing a re-drop is harmless).
    frame.addEventListener('click', function (e) {
      // Clicking the empty placeholder opens the file picker; clicking once an
      // image is loaded is for painting, so don't hijack that.
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

    // ---- run inpaint ----
    runBtn.addEventListener('click', async function () {
      if (!hasImage()) { setStatus(status, 'Load an image first.', true); return; }
      if (strokes.length === 0) { setStatus(status, 'Paint a region to regenerate first.', true); return; }
      var text = promptEl.value.trim();
      if (!text) { setStatus(status, 'Enter a modify prompt first.', true); return; }

      runBtn.disabled = true;
      setStatus(status, 'Regenerating masked region…', false);
      progress.start();
      try {
        var imageB64 = canvasToPngBase64(sourceCanvas.canvas);
        var maskB64 = exportMaskBase64();
        var data = await postJson('/.netlify/functions/edit', {
          imageB64: imageB64, maskB64: maskB64, prompt: text
        });
        var resultUrl = 'data:image/png;base64,' + data.image;
        afterSlot.innerHTML = '';
        var afterImg = document.createElement('img');
        afterImg.src = resultUrl;
        afterImg.alt = 'Result';
        afterSlot.appendChild(afterImg);
        setStatus(status, 'Done. Compare before / after below.', false);
      } catch (err) {
        setStatus(status, err.message, true);
      } finally {
        progress.done();
        runBtn.disabled = false;
      }
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
    var sourceToggle = $('descSource');
    var modeToggle = $('descMode');
    var progress = makeProgress($('descTrack'), $('descFill'));

    var sourceCanvas = null; // downscaled <=768 for cheaper tokens
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
        runBtn.disabled = false;
        clearBtn.disabled = false;
        setStatus(status, 'Press Describe.', false);
      }).catch(function (err) { setStatus(status, err.message, true); });
    }

    modeToggle.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      Array.prototype.forEach.call(modeToggle.children, function (b) {
        b.classList.toggle('active', b === btn);
      });
      mode = btn.getAttribute('data-mode');
      runBtn.textContent = (mode === 'ocr' ? 'Read text' : 'Describe') + ' →';
    });

    sourceToggle.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-source]');
      if (!btn) return;
      Array.prototype.forEach.call(sourceToggle.children, function (b) {
        b.classList.toggle('active', b === btn);
      });
      if (btn.getAttribute('data-source') === 'upload') fileInput.click();
      else loadDescribeImage(SAMPLES.describe);
    });

    fileInput.addEventListener('change', async function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      var url = await fileToDataUrl(fileInput.files[0]);
      loadDescribeImage(url);
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

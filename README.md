# Image Generation & Editor

A small, single-page course demo (Rice/Kaplan intro-AI, video **5.05a "Photo Touchup
for Good and for Evil"**). Three mutually-exclusive tabs, all backed by OpenAI:

- **Generate** — text-to-image. Type a prompt, get a 1024×1024 image. (`images.generate`, `gpt-image-1-mini`)
- **Modify** — masked inpaint. Load an image, paint the region to change, describe the
  change, and regenerate just that region — iteratively, with a version history.
  (`images.edit`, `gpt-image-2`; the server composites the result back through a feathered
  mask so only the painted region changes — see "Why we composite" below.)
- **Describe** — image-to-text. Load an image and either describe it or read its text
  (OCR mode). (`gpt-4o-mini` vision via Chat Completions)

The OpenAI API key lives **only** in a Netlify function's environment — it is never sent
to the browser. The browser POSTs base64 JSON to `/.netlify/functions/{generate,edit,describe}`
and renders what comes back.

## Run locally

The functions call the OpenAI REST API with plain `fetch`; the edit path additionally uses
`sharp` (compositing) and `@netlify/blobs` (background-job hand-off), so install once.

```bash
npm install
export OPENAI_API_KEY=sk-...        # or put it in a local .env (git-ignored)
npx netlify dev                     # serves index.html + the functions
```

Then open the URL Netlify prints (usually http://localhost:8888). `netlify dev` runs the
background function and a sandboxed local Netlify Blobs store, so the Modify tab works
end-to-end locally.

Setting the key:
- **Local:** an environment variable as above, or a `.env` file in the repo root
  (`OPENAI_API_KEY=sk-...`). `.env` is git-ignored — never commit it.
- **Netlify (deployed):** Site settings → Environment variables → add `OPENAI_API_KEY`.

You provide your own key; nothing here hardcodes or commits one.

## ⚠️ Before you deploy — REQUIRED checklist

This app deploys **publicly** on Netlify with a real, paid OpenAI key behind it. The code
already ships with per-request guards (hard-coded models, output capped at `1024×1024`,
`n: 1`, prompt truncated to 1000 chars, inputs over ~4 MB rejected early with `413`, and
each function returns only what's needed). Those bound the cost of a *single* request — they
do **not** bound the total, and none of them can be committed for you. Work this checklist
before you make the site public:

- [ ] **1. OpenAI monthly spend cap.** In the OpenAI dashboard, set a hard monthly budget /
  usage limit on the project whose key this uses (e.g. **~$5**). This is the real backstop
  against a runaway bill — without it, nothing stops a busy day (or an abusive visitor) from
  running the bill up. Each request costs cents; the cap bounds the total. Note the **Modify**
  tab uses the full **`gpt-image-2`** (Generate uses the cheaper `gpt-image-1-mini`; Describe
  uses `gpt-4o-mini`), so size the cap with the edit tab in mind.

- [ ] **2. Netlify per-IP rate limiting.** Turn on rate limiting for the three functions
  (Netlify → site config → rate limiting) so a single visitor can't hammer the endpoints.
  A tight per-IP limit (e.g. a few requests per minute) is plenty for a demo.

- [ ] **3. `OPENAI_API_KEY` in the Netlify environment.** Site settings → Environment
  variables → add `OPENAI_API_KEY` for the deployed site (this is separate from your local
  `.env`, which only covers `netlify dev`).

- [ ] **4. Sample images (optional).** The bundled `samples/dog.png` is a real, licensed
  photo (Alvan Nee on Unsplash, credited in the footer) — it ships ready to use. If you want
  a different sample (e.g. your own face for the identity beat, a specific sign for OCR),
  drop it into `samples/`, update the `SAMPLES` map at the top of `app.js`, and keep any
  required attribution in the footer. Use your own images or genuinely licensed sources
  (CC0 / Unsplash / Pexels / Pixabay / Wikimedia). Do not ship unlicensed images.

Items 1–3 are set in dashboards, not in this repo. **Do not skip them.**

> **Already handled — the slow edit path.** The Modify edit takes ~25–33 s (OpenAI ~20–28 s
> + the composite), which blows a synchronous serverless function's timeout (10 s on the free
> plan). So the edit already runs as a
> [Netlify Background Function](https://docs.netlify.com/build/functions/background-functions/)
> (`edit-background.mjs`, up to 15 min, free-plan compatible): the browser submits the job,
> the function stashes the result in [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/),
> and the browser polls `edit-status.mjs` for it. No plan upgrade needed; nothing to do here.

## Sample images

On Modify and Describe, **Choose image…** opens the file picker, and **or use a sample**
loads the bundled photo from `samples/`:

- `samples/dog.png` — a real photo (fluffy white dog shaking off water), center-cropped to
  768². By [Alvan Nee](https://unsplash.com/@alvannee) on
  [Unsplash](https://unsplash.com/photos/rpkBHHu2TyE), credited in the page footer. Used
  under the Unsplash License. Both Modify and Describe use it: mask the dog and change
  something, or describe / read text from it.

To swap in your own images, drop them into `samples/` and update the `SAMPLES` map at the top
of `app.js` (see item 4 of the deploy checklist above). Use your own images or genuinely CC0
sources; keep any required attribution in the footer.

## Iterative editing & version history (Modify)

Modify is built around the 5.05a "escalation" beat. Each regenerate:

1. loads the **result back into the editor** as the new current image, and
2. adds it to the **Versions** strip below (`Original`, `v2`, `v3`, …).

The mask auto-clears after each pass so you can immediately paint the next edit — touch up
the touch-up, and watch the image drift further from reality. **Click any version** (including
**Original**, which is always kept and never evicted) to make it current and edit from there —
clicking back to Original is the "here's what was actually real" reveal.

## The mask (the one real gotcha)

OpenAI's edit mask is a PNG with the **same dimensions as the image**, where **alpha 0
(transparent) = "edit here"** and alpha 255 = "keep". The client:

- keeps the source and mask at the same downscaled dims (fixed **1024 px** longest edge, so
  input == the model's 1024² output == display — no resample round-trip),
- paints the brush at *image* resolution (pointer coords are mapped back from the CSS-scaled
  display), and
- on export inverts the alpha: brushed → alpha 0, unpainted → alpha 255 (`exportMaskBase64`
  in `app.js`).

If OpenAI errors on dimensions, the mask and image dims don't match.

## Why we composite (a 5.05a teaching point)

The mask does **not**, by itself, confine an edit to the painted region. OpenAI's docs say it
plainly: *"Masking with GPT Image is entirely prompt-based. The model uses the mask as
guidance, but may not follow its exact shape with complete precision."* GPT-Image models
**regenerate the whole canvas** and treat the mask as a hint — OpenAI Support has confirmed
this is *"a known limitation"* (unlike the retired DALL·E-2, which did true pixel-level
replacement). Measured, an edit drifts the *unmasked* area by ~45–55 / 255 on average — enough
to silently change things you never painted (in testing, a masked edit on one side turned the
dog's nose pink on the other).

So `edit-background.mjs` confines the edit itself: it keeps the **original** outside the mask
and blends the AI result **inside** it, with a **feathered** (Gaussian-blurred) mask edge so
the seam fades. Only the painted region changes; everything else is pixel-exact to the source.
(Paint nothing and press Regenerate to skip the mask and rebuild the whole image instead.)

This is also the lesson: generative AI doesn't surgically edit — it *regenerates*, and quietly
changes things you didn't ask for. The Modify tab's **"What the AI changed"** toggle shows the
raw, uncomposited model output next to the clean composite, so you can see the whole-canvas
drift the mask was supposed to prevent.

## Files

```
index.html                            UI + house-style <style> block (self-contained, no CDNs)
app.js                                all client logic (tabs, mask, downscale, submit+poll, bridges)
netlify/functions/generate.mjs        images.generate  (gpt-image-1-mini, synchronous)
netlify/functions/edit-background.mjs images.edit       (gpt-image-2, masked + server composite; background)
netlify/functions/edit-status.mjs     poll endpoint for the background edit result (Netlify Blobs)
netlify/functions/describe.mjs        chat.completions  (gpt-4o-mini vision, synchronous)
netlify.toml                   publish "." + functions dir
package.json                          type: module; deps: sharp, @netlify/blobs (edit path only)
samples/                       bundled sample photo (dog.png)
```

Source: https://github.com/adamwulf/image-inpaint

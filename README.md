# Image Generation & Editor

A small, single-page course demo (Rice/Kaplan intro-AI, video **5.05a "Photo Touchup
for Good and for Evil"**). Three mutually-exclusive tabs, all backed by OpenAI:

- **Generate** — text-to-image. Type a prompt, get a 1024×1024 image. (`images.generate`, `gpt-image-1-mini`)
- **Modify** — masked inpaint. Load an image, paint the region to change, describe the
  change, and regenerate just that region. Before/after compare. (`images.edit`, `gpt-image-1-mini`)
- **Describe** — image-to-text. Load an image and either describe it or read its text
  (OCR mode). (`gpt-4o-mini` vision via Chat Completions)

The OpenAI API key lives **only** in a Netlify function's environment — it is never sent
to the browser. The browser POSTs base64 JSON to `/.netlify/functions/{generate,edit,describe}`
and renders what comes back.

## Run locally

```bash
npm install
export OPENAI_API_KEY=sk-...        # or put it in a local .env (git-ignored)
npx netlify dev                     # serves index.html + the three functions
```

Then open the URL Netlify prints (usually http://localhost:8888).

Setting the key:
- **Local:** an environment variable as above, or a `.env` file in the repo root
  (`OPENAI_API_KEY=sk-...`). `.env` is git-ignored — never commit it.
- **Netlify (deployed):** Site settings → Environment variables → add `OPENAI_API_KEY`.

You provide your own key; nothing here hardcodes or commits one.

## ⚠️ Deploy safeguards — REQUIRED before going public

This app deploys **publicly** on Netlify with a real, paid OpenAI key behind it. The code
already ships with per-request guards (hard-coded models, output capped at `1024×1024`,
`n: 1`, prompt truncated to 1000 chars, inputs over ~4 MB rejected early with `413`, and
each function returns only what's needed). Those bound the cost of a *single* request — they
do **not** bound the total. Before you make the site public you MUST also set the two
account-level backstops that bound the total:

1. **OpenAI monthly spend cap.** In the OpenAI dashboard, set a hard monthly budget /
   usage limit on the project whose key this uses (e.g. **~$5**). This is the real backstop
   against a runaway bill. Without it, nothing stops a busy day (or an abusive visitor) from
   running the bill up.

2. **Netlify per-IP rate limiting.** Turn on rate limiting for the functions
   (Netlify → site config → rate limiting, or the `[[edge_functions]]` / rate-limit config)
   so a single visitor can't hammer the endpoints. A tight per-IP limit (e.g. a few requests
   per minute) is plenty for a demo.

Both are set in dashboards, not in this repo — they can't be committed, so they're on you at
deploy time. **Do not skip them.**

## Sample images

The **Sample** toggle on Modify and Describe loads bundled files from `samples/`:

- `samples/portrait.svg` — a portrait-style **placeholder** (avatar silhouette with eyes),
  so "mask the face + add sunglasses" has an obvious target.
- `samples/street-sign.svg` — a highway-sign **placeholder** with real text, so Describe's
  "Read text" (OCR) mode has something to transcribe.

These are **generated placeholders, not photographs** — shipped so the demo works on camera
without an upload, and so no unlicensed imagery is committed. To use real photos, drop genuine
**CC0** images (Unsplash / Pexels / Pixabay / Wikimedia public-domain) into `samples/` and
update the `SAMPLES` map at the top of `app.js` to point at them. CC0 needs no attribution.

## The mask (the one real gotcha)

OpenAI's edit mask is a PNG with the **same dimensions as the image**, where **alpha 0
(transparent) = "edit here"** and alpha 255 = "keep". The client:

- keeps the source and mask at the same downscaled dims (fixed **768 px** longest edge),
- paints the brush at *image* resolution (pointer coords are mapped back from the CSS-scaled
  display), and
- on export inverts the alpha: brushed → alpha 0, unpainted → alpha 255 (`exportMaskBase64`
  in `app.js`).

If the wrong region changes, the alpha inversion is flipped. If OpenAI errors on dimensions,
the mask and image dims don't match.

## Files

```
index.html                     UI + house-style <style> block (self-contained, no CDNs)
app.js                         all client logic (tabs, mask, downscale, fetch, bridge)
netlify/functions/generate.mjs images.generate  (gpt-image-1-mini)
netlify/functions/edit.mjs     images.edit       (gpt-image-1-mini, masked)
netlify/functions/describe.mjs chat.completions  (gpt-4o-mini vision)
netlify.toml                   publish "." + functions dir
package.json                   dep: openai; type: module
samples/                       bundled placeholder images for the Sample toggle
```

Source: https://github.com/adamwulf/image-inpaint

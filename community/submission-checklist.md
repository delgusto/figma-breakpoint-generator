# Figma Community submission — checklist

Everything needed to publish, in order. Items marked **[you]** must be done in
Figma (I can't touch your Figma account or build `.fig` files from here).

## 0. Assets I've prepared (in `assets/`)
- `icon.svg` — the 128×128 plugin icon.
- `cover.svg` — the 1920×960 listing cover.
- Listing copy — `community/listing.md`.

**[you] Export them to PNG** (Figma wants PNGs at publish):
1. Drag each SVG into a Figma file (or open in a browser and screenshot).
2. Select the frame → Export → PNG:
   - Icon: **128 × 128** (1×). Save as `icon.png`.
   - Cover: **1920 × 960** (1×). Save as `cover.png`.

## 1. Icon (128×128) — required
- Use `icon.png`. Should read clearly at small sizes; the SVG is already simple.

## 2. Cover art (1920×960) — required
- Use `cover.png`.

## 3. Carousel screenshots (recommended, up to 3–5) **[you]**
Capture these from the running plugin + canvas (⌘⇧4 on macOS, or Figma export):
1. **The plugin panel** — Set up → Step 1 (breakpoints) or the Generate screen.
2. **Output on canvas** — a row of generated breakpoints with labels.
3. **Light + dark frames** — the stacked light/dark output (the money shot).
4. _(optional)_ **Variant/variable picker** — showing DS-token linking.
5. _(optional)_ **Step 3** — the light & dark setup step.
Recommended size: 1920×1080 or the plugin window at 2× for crispness.

## 4. Listing text — required
- Name, tagline, description, tags — all in `community/listing.md`. Paste in.

## 5. Playground / template file (recommended) **[you]**
A small `.fig` users can try the plugin in immediately. Build one file with:
- **A sample screen frame** with auto-layout (e.g. a card or hero) whose width is
  **bound to a WIDTH variable**.
- **A width variable collection** with 3–5 **modes** named like your breakpoints
  (XS / SM / MD / LG / XL), each resolving `width` to a different px value.
- _(optional)_ **A component set with breakpoint variants** (XL…XS) so users can
  try variant switching.
- _(optional)_ **A label component** with a single text layer, to demo custom labels.
- A short text note on the canvas: "Select the frame → run Breakpoint Generator →
  Set up → Generate."
Then **Publish** that file to Community as a free template and link it from the
plugin listing (Support links).

## 6. Manifest — check before publishing
Current `manifest.json` is fine. On publish Figma assigns a real plugin id
(the local `breakpoint-generator-dgux-local` is replaced). Nothing to change,
but confirm:
- `name`: "Breakpoint Generator"
- `editorType`: `["figma"]`
- `permissions`: `["teamlibrary"]` — matches the listing's permission note.

## 7. Publish flow **[you]**
1. Figma → **Plugins** → **Development** → right-click _Breakpoint Generator_ →
   **Publish** (or Manage plugins → Publish new release).
2. Fill: icon, cover art, name, tagline, description, tags, screenshots.
3. **Visibility** — for internal approval, choose the most restricted option your
   org allows:
   - If your workspace supports **org-only / private** plugins, publish there.
   - Otherwise publish as **Unlisted / "Only people with the link"** and share the
     link with whoever approves internally.
4. Add the playground file link + a support contact.
5. Submit for review. Figma reviews public plugins; org-only ones typically go
   through your workspace admin instead.

## 8. Internal approval (CBA) **[you]**
- Point reviewers at `STORAGE_AND_NETWORK.md` (no network, local-only storage) and
  the `teamlibrary`-only permission — usually the two questions security asks.
- Note there are **no third-party dependencies** and **no build step** (two plain
  files: `code.js`, `ui.html`).

---

### What I can still do from here
- Tweak the icon / cover (colours, layout, wording) — just say how.
- Draft the screenshot captions or the playground file's on-canvas instructions.
- Write a short "reviewer one-pager" for internal security/brand sign-off.

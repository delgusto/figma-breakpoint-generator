# Figma Community submission — checklist

Everything needed to publish, in order. Items marked **[you]** must be done in
Figma (I can't touch your Figma account or build `.fig` files from here).

## 0. Assets — all exported and ready (in `assets/`)
- `icon.png` — 128×128 plugin icon (source: `icon.svg`).
- `cover.png` — 1920×960 listing cover (source: `cover.svg`).
- `screenshot-1-breakpoints.png` — 1920×960, generated XS/SM/LG output.
- `screenshot-2-light-dark.png` — 1920×960, light + dark output.
- `screenshot-3-guided-setup.png` — 1920×960, four plugin panels montage.
- Listing copy — `community/listing.md`.

All PNGs were exported from the playground file's "Listing assets" section.
Re-export from there if anything changes.

## 1. Icon (128×128) — required
- Use `assets/icon.png`.

## 2. Cover art (1920×960) — required
- Use `assets/cover.png`.

## 3. Carousel screenshots — ready
Upload in this order:
1. `screenshot-1-breakpoints.png` — one frame → every breakpoint.
2. `screenshot-2-light-dark.png` — light + dark output (the money shot).
3. `screenshot-3-guided-setup.png` — the guided Set up wizard.

## 4. Listing text — required
- Name, tagline, description, tags — all in `community/listing.md`. Paste in.

## 5. Playground / template file — built, publish is **[you]**
The file "Breakpoint generator Playground" follows the Figma-team playground
pattern (designed as "Breakpoint Playground v2" in Claude Design, implemented
on canvas with live wiring):
- **Cover** — full-yellow hero with the 390/768/1280 mini-frame graphic.
- **Contents** — jump links (real node links) to every section, plus the
  dashed "how to try it" tip with a Generate keycap.
- **Introduction and setup** — yellow sidebar card with the 3 steps; the
  live **Sample screen** sits right below it (width bound to
  `Breakpoints/width`, every fill on `Appearance` light/dark tokens; space to
  its right is kept clear for plugin output).
- **Expected output** — sidebar card with real mode-pinned clones at
  390 / 768 / 1280 showing the 1→2→3 column reflow.
- **Light & dark** — sidebar card with the same screen in both modes
  (yellow accent constant across modes).
- **Parts the plugin uses** — label component + nav bar shelf (XL→XS, menu
  collapses to a hamburger at SM/XS). Source components sit below.
- **Listing assets section** — icon, cover, and the three carousel frames.
  **Delete this section (and the plugin screenshots section) before
  publishing the file** — they're for the plugin listing, not for users.

To publish the file: open it → **Share** (top right) → **Publish to
Community** → set it as a **free template**, add a description (reuse the
tagline + first paragraph from `community/listing.md`), and publish. Then
paste the published URL into the plugin listing's Support links.

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

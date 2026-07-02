# Breakpoint Generator

A Figma plugin that clones one frame across every breakpoint — labelled, laid
out side by side, and optionally in light + dark.

Select a frame, pick your breakpoints, hit **Generate**. The plugin clones the
frame at each width, labels each clone, and can wrap the whole set in two
auto-layout frames (one per appearance mode) so you review responsive
behaviour in seconds instead of duplicating frames by hand.

## Features

- **One clone per breakpoint** — mobile to wide, or your own custom set,
  sized and spaced automatically.
- **Design-system aware widths** — drive each breakpoint from a width token,
  a variable mode (e.g. XS–XL modes on a collection), or a plain pixel value.
  Library tokens and alias chains are resolved.
- **Variant switching** — point the plugin at a component set with breakpoint
  variants (XL / LG / MD / SM / XS) and each clone gets the right variant,
  auto-matched by name.
- **Labels** — a text chip above each frame, or your own label component with
  the breakpoint name written into its text layer / text property.
- **Light + dark output** — one click wraps the results in two stacked
  auto-layout frames with the right variable mode applied to each; colour
  tokens flip automatically.
- **Remembers your setup** — breakpoints, labels, and appearance settings are
  stored per user, so the second run is a single click.

## Installation (development)

The plugin is two plain files — no build step, no dependencies.

1. Clone or download this repo.
2. In Figma Desktop: **Plugins → Development → Import plugin from manifest…**
3. Pick `manifest.json` from the repo folder.
4. Run it from **Plugins → Development → Breakpoint Generator**.

## How to use

1. Select a frame, component, or instance.
2. Open the plugin → **Set up** → choose your breakpoints (width- or
   variant-driven), labels, and optionally light + dark.
3. Hit **Generate**.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Plugin manifest — id, permissions, `dynamic-page` document access |
| `code.js` | Sandbox code: selection detection, token/variant resolution, generation |
| `ui.html` | The plugin panel — single self-contained file (inline CSS/JS) |
| `STORAGE_AND_NETWORK.md` | Data-handling notes for security review |

## Data handling & permissions

- **No network access.** `networkAccess.allowedDomains` is `["none"]`; the
  plugin makes no external requests of any kind.
- **Local storage only.** Settings are saved per user via
  `figma.clientStorage` (breakpoint setup, label component key, appearance
  collection choice). Nothing leaves Figma.
- **`teamlibrary` permission** — used solely to read width/colour variables
  and modes published in linked design-system libraries, so breakpoints can
  link to real tokens.

Details in [STORAGE_AND_NETWORK.md](STORAGE_AND_NETWORK.md).

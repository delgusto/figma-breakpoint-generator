# Community listing copy

Paste these into Figma's publish form. Edit anything in _italics_ to taste.

## Name
Breakpoint Generator

## Tagline (short — shows under the name; keep < ~60 chars)
Clone a frame across every breakpoint, instantly.

## Description
Design responsively without the busywork. Select a frame, component, or
instance, choose your breakpoints, and Generate — the plugin clones it at each
width and lays the clones out side-by-side, labelled and ready to review.

**What it does**
- Generates a clone per breakpoint (mobile, tablet, laptop, desktop, wide — or
  your own set), sized to each width and spaced neatly.
- Drives width three ways per breakpoint: a fixed number, a **width variable /
  token** (local or from a linked library), or a **variable mode** (applies the
  mode so a bound width auto-resolves).
- Switches **component variants** per breakpoint (e.g. XL / LG / MD / SM / XS),
  auto-matching variant names to your breakpoints.
- Adds a **label** above each frame — plain text, or your own design-system
  label component with the breakpoint name written in.
- Optionally wraps the output in **light + dark auto-layout frames**, each with
  the right appearance mode applied, and a background that flips with the mode.
- Groups each frame with its label, remembers your setup per-user across files,
  and lets you pin a preferred token library.

**How to use**
1. Select a frame / component / instance.
2. Open the plugin → **Set up** → define breakpoints, labels, and (optionally)
   light + dark.
3. Hit **Generate**.

Design-system aware: reads library tokens, semantic alias chains, multi-mode
collections, and variant component sets. No setup files, no dependencies.

## Tags (pick up to ~12)
responsive, breakpoints, design systems, variables, variant, modes, layout,
auto layout, dark mode, productivity, prototyping, tokens

## Permissions — why we ask
- `teamlibrary` — to read WIDTH variables and light/dark modes published in your
  linked design-system libraries, so breakpoints can link to real tokens.
- **No network access.** The plugin makes no external requests; all settings are
  stored locally per-user (see `STORAGE_AND_NETWORK.md`).

## Support / links (optional fields)
- Playground file: _<link to the published Community template — see checklist>_
- Contact / feedback: _<your email or internal channel>_

# Figma Breakpoint Generator — a Claude Code case study

A personal Figma plugin, built conversationally over a single working session with Claude Code. What started as "clone a frame at different widths" ended up handling library variables, semantic alias chains, variable **modes**, per-user preferences, branded UI, and drag-to-reorder — roughly 30 iterations of design → feedback → fix.

This doc is a tour of the interesting problems we hit and how we solved them. It's a useful case study for:
- **Claude Code** as a pair-programming partner across a long multi-feature session
- **Figma plugin development** — the API's sharp edges and the token/mode/variable model
- **Design-driven iteration** — most changes came from "I just tested it and…" feedback

---

## What the plugin does

Select a frame, component or instance in Figma. Pick your breakpoints (mobile, tablet, laptop, etc). Hit **Generate**. Clones appear side-by-side on the canvas at each breakpoint width, with labels.

A breakpoint can be linked to:
- a literal number (e.g. `768`)
- a Figma **variable** (value resolved from the current file or a published library)
- a Figma **variable mode** (e.g. "Semantic Measurement / XL" — applies the mode override on the clone so the bound width auto-resolves)

All settings persist per-user across files. There's a "preferred library" system that pins tokens from your design system library to the top of the picker.

---

## The problems, in the order we hit them

### 1. Library variables wouldn't appear in the dropdown

**Symptom:** the token picker only showed local variables. The user had a linked library with breakpoint tokens — none visible.

**Causes, in sequence:**
- `teamlibrary` permission wasn't in the manifest
- `getAvailableLibraryVariableCollectionsAsync()` returns library *collections*, not variables. Each collection has to be expanded via `getVariablesInLibraryCollectionAsync(key)`
- The user's library had zero **FLOAT** variables published — all COLOR. We were (correctly) filtering by type, so the list was empty

**Lesson:** add diagnostic logging early. A one-line `console.log` revealed the library was returning one COLOR variable, not any FLOATs. Saved hours of "why isn't this working".

### 2. Library variable values showed as `—`

**Cause:** `getVariablesInLibraryCollectionAsync` only returns metadata (name, key, type) — not the value. To read the actual number, you need to call `importVariableByKeyAsync(key)` which brings the variable into the file and exposes `valuesByMode`.

**Solution:** import each library FLOAT variable at fetch time to read its value. It's what Figma does internally when you use a library token — idempotent and safe.

### 3. Semantic tokens showed `—` even after import

**Cause:** aliases. A `Semantic/fontSize/body` variable references `Primitives/fontSize/body`. Its `valuesByMode` entry is an object `{ type: 'VARIABLE_ALIAS', id: '…' }`, not a number.

**Solution:** recursive alias resolver — follow the chain up to 10 hops, detect cycles, return the final numeric value.

### 4. Dropdown was a flat wall of tokens

**Symptom:** 50+ variables listed alphabetically. Breakpoint tokens were buried among spacing, font-size, and radius tokens.

**Solution evolution:**
1. First pass: `<optgroup>` grouping by collection, with a relevance heuristic (bump breakpoint-keyword matches, demote fontSize/spacing/radius). Worked, but the user wanted to match Figma's native picker pattern.
2. Second pass: 3-level label `Library / Collection / Name-prefix`, with the leaf name as the option text. E.g. group `DGUX redesign / Primitives / breakpoint` containing rows `tablet (640px)`, `desktop (1024px)`.
3. Third pass: replaced the native `<select>` with a custom combobox — single input that shows the current selection when closed, becomes a search field on focus, with grouped results in a popup. Supports keyboard navigation, click-outside to close, and a clear button.

### 5. Too much yellow

**Context:** CBA's brand is yellow (`#fc0`), black, and white. First attempt had a yellow CTA, yellow focus rings, yellow active tabs, yellow checkboxes. Visual noise.

**Solution:** restrict yellow to a single role — the small "var/lib/mode" chip next to a linked breakpoint. Primary CTA became black with white text. Active tab = black underline. Focus = subtle grey ring. One pop of brand colour instead of a flood.

### 6. Width input disabled even when nothing was linked

**Symptom:** user couldn't type a width value after clearing a linked variable.

**Root cause:** the render was checking `(bp.variableId || bp.variableKey)` — raw IDs. If a previously-linked variable was deleted or its library wasn't loaded, the stale ID was still on the breakpoint and the field stayed disabled — even though the combobox correctly showed "no variable".

**Fix:** switched the check to the *resolved* variable. If the ID exists but doesn't resolve to a real variable, treat it as unlinked.

### 7. Saving defaults + preferred library

**Need:** the user works with one library at work, across many Figma files. They wanted:
- their current breakpoints saved as a personal baseline
- a "preferred library" pinned to the top of the picker
- optional: hide everything except that library

**Solution:** three new `clientStorage` keys (`defaultBreakpoints`, `preferredLibrary`, `filterToLibrary`) — all per-user, persisted across files. "Reset to defaults" now reverts to the user's saved defaults if any exist, factory defaults otherwise.

### 8. The big one: variable **modes**

This is the most interesting problem. The user's actual workflow doesn't match what the plugin assumed.

**Their setup:**
- A `width` variable lives in a collection with **5 breakpoint modes** (XS, S, M, L, XL)
- Each mode resolves `width` to a different pixel value
- To render a frame at XL, the designer **applies the XL mode** on the frame via Figma's Appearance panel → "Apply variable mode → Semantic Measurement / XL"
- The frame's width (bound to the `width` variable) auto-resolves to XL's value

**The plugin** was only reading each variable's **default mode value**. Linking a breakpoint to `width` would resolve to XS (the default) every time — useless for multi-breakpoint generation.

**Solution:** make modes a first-class thing the picker can link to.

- New data feed: enumerate every (collection, mode) pair from collections with multiple modes
- Combobox popup now lists modes alongside variables, with a small "mode" pill instead of a px value
- At generate time, if a breakpoint is mode-linked, call `clone.setExplicitVariableModeForCollection(collection, modeId)` — the bound width variable auto-resolves, no manual resize needed

**Subtle trap:** encoding the mode selection as a data-value string used colons as delimiters — but Figma's `collectionId` (e.g. `VariableCollectionId:1:2`) and `modeId` (e.g. `1:0`) both contain colons internally. Switched the delimiter to `|`. Clicking modes suddenly worked.

### 9. Clones kept their original height

**Symptom:** after wiring up mode-link, all clones were 433px tall (source height) regardless of breakpoint.

**First fix:** force `primaryAxisSizingMode = 'AUTO'` on the clone so it hugs content vertically.

**That broke everything else:** for frames with **horizontal** auto-layout, the primary axis is *horizontal*, so we were forcing the frame to hug **width** — overriding the bound width variable. The outer frame collapsed to its inner content's size, so visually "only the inner frame" was cloned.

**Fix:** make the axis-forcing direction-aware.
- Vertical auto-layout → `primaryAxisSizingMode = 'AUTO'` (hug height)
- Horizontal auto-layout → `counterAxisSizingMode = 'AUTO'` (hug height)
- Never touch the axis that's on the horizontal dimension

**Further refinement:** when the user confirmed their source frame has **no auto-layout at all**, we stopped restructuring entirely for mode-linked clones. Trust the source. If it's got no auto-layout, the clone has no auto-layout — let the bound width variable do its thing and leave the layout alone.

### 10. Gaps between clones were wrong

**Cause:** cursor advanced by `bp.width` — the user's typed fallback. For mode-linked clones, the actual post-mode-apply width came from the variable, not from `bp.width`. So clones overlapped or were spaced wrongly.

**Fix:** read `clone.width` **after** applying the mode. Figma reflows synchronously, so the getter returns the correct resolved value immediately.

### 11. Auto-sort or manual order?

Initial approach: sort breakpoints by width descending (largest → smallest, left to right). Worked for variable-linked breakpoints where we could resolve widths up front. Got complicated for mode-linked ones — we had to clone everything first, measure, then re-sort and reposition. Two-pass.

User's feedback: *"the alternative would have been to allow for ordering the breakpoints in the UI."*

Right. That's cleaner:
- One source of truth (the breakpoint list order)
- No hidden sort
- No two-pass measure-then-sort

**Solution:** HTML5 drag-and-drop on the breakpoint cards. Drag handle icon on the left; drop indicator bar shows where the card will land; state.breakpoints reorders on drop and persists via `save-settings`. The generate flow just walks the list in order.

---

## Patterns that paid off

**Ask before assuming.** The variable-mode feature was a significant rethink of the data model. Before coding, we used structured questions to nail down the user's actual workflow (token shape, whether the source was bound, clone behaviour). A 3-minute conversation prevented a day's rework.

**Plan mode for big refactors.** For the "save defaults + preferred library" feature and the "variable modes" feature, we used Claude's plan mode to write an implementation plan to a file before touching code. Both plans were approved with small edits, then executed cleanly.

**Read the actual error, not the guessed error.** The "library variables empty" issue was diagnosed in one console log. Without it, we'd have gone down several wrong paths (permissions? scope filter? API missing? — all wrong).

**Incremental edits, preview-driven.** The plugin UI is a single `ui.html`. Every edit showed up in the live preview panel seconds later. Tight feedback loop meant 20+ iterations felt natural rather than painful.

**Trust the source, don't restructure.** The "cloned only the inner frame" bug was caused by opinionated structural changes to a clone. The fix was to stop changing things that don't need to be changed. For mode-linked clones: just apply the mode and step back.

---

## Figma API quirks worth knowing

- `collectionId` and `modeId` contain colons. Never use `:` as a delimiter when encoding these in strings.
- `importVariableByKeyAsync` is idempotent. Call it freely to read values from library variables.
- Variables with alias values return `{ type: 'VARIABLE_ALIAS', id: '…' }` — you have to walk the chain yourself.
- `getVariablesInLibraryCollectionAsync` returns metadata only. Import to read values.
- `setExplicitVariableModeForCollection` is how you apply a mode override programmatically. Bound variables auto-reflow; the clone's width getter updates synchronously.
- `resize()` breaks variable bindings on the resized axis. If you want a bound width to survive, don't resize.
- The `teamlibrary` permission is required in `manifest.json` to use the team library API.

---

## Stack

- Plain JS (no build step, no bundler)
- `code.js` runs in Figma's sandbox (no DOM, has `figma.*` API)
- `ui.html` is the plugin panel (vanilla JS, inline CSS, single file)
- No dependencies
- ~1000 lines of UI + ~500 lines of sandbox code

Total build time: a single evening + a follow-up session for modes + reorder.

---

## What Claude Code did well, what needed guidance

**Did well:**
- Held context over ~30 feature iterations in one session — no "what were we doing?" moments
- Diagnosed root causes fast (the colon-collision, the raw-ID disable check, the axis-direction bug)
- Planned refactors with clear trade-offs before writing code
- Incremental edits with live preview after each — felt like a tight pair-programming loop

**Needed guidance:**
- First instincts sometimes too aggressive (the blunt `primaryAxisSizingMode = 'AUTO'` that broke horizontal layouts). Surfaced the problem, but needed the user's "it's doing weird things" to go back and refine.
- Needed explicit context about the user's design-system structure (modes, aliases, hidden primitive collections) to build the right mental model. Generic token assumptions weren't enough.
- The grill-me / clarifying-question pattern worked best when proactively triggered — on a few occasions it started implementing and had to walk back when the spec turned out to be different.

---

## If you're building a Figma plugin

- Start with `teamlibrary` permission if you touch any library content
- Expose **modes** from day one if your design system uses them — your users probably do
- Don't restructure cloned nodes unless you have to. `resize()` is a blunt tool
- Build a proper picker (search + groups) for any file with more than ~20 tokens — native `<select>` breaks down fast
- Use `clientStorage` for user prefs; `figma.root.setPluginData` for per-file state

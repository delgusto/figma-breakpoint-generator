# Breakpoint Generator — Storage & Network

Plain-language summary of where this plugin keeps data and whether it talks to the network. Written for IT / security review.

## TL;DR

- **No network access.** The plugin cannot make HTTP, WebSocket, or any external requests. The `manifest.json` has no `networkAccess` allowlist, which means Figma blocks outbound traffic at the plugin sandbox boundary.
- **No telemetry, analytics, or external calls** of any kind — verified by a full-text scan of the source (`fetch`, `XMLHttpRequest`, `WebSocket`, `https://`, CDN hosts: zero matches).
- **All persisted data lives in Figma's `clientStorage`** (per-user, per-plugin, local to the user's Figma install). Nothing is written to the file itself, no cookies, no `localStorage`.
- **Read-only access to team libraries** for variable tokens, via Figma's own `figma.teamLibrary.*` APIs. The plugin never opens its own connection — Figma brokers the read.

---

## What gets stored

All persistence uses `figma.clientStorage`, a key-value store scoped per user and per plugin. Data stays on the user's device inside the Figma client. It does not sync to Figma's servers and is not shared with other users or files.

| Key                  | Contents                                                                 | Purpose                                                 |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| `breakpoints`        | Current breakpoint rows (label, width, variable/mode links, enabled flag, variant props) | Restores the user's active breakpoint config on reopen. |
| `settings`           | Gap, label toggle                                                        | Restores layout prefs on reopen.                        |
| `defaultBreakpoints` | User's saved "reset to" defaults                                         | Lets the user override the factory defaults.            |
| `preferredLibrary`   | Name/key of the team library the user last filtered to                   | UX convenience — remembers the filter.                  |
| `filterToLibrary`    | Boolean for the "filter to preferred library" toggle                     | UX convenience.                                         |

Source references: `code.js:46-52`, `code.js:385-424`.

**Not stored:**
- No user identifiers, email, Figma account info.
- No file contents, node IDs, selection history.
- No `figma.root.setPluginData` / `setSharedPluginData` — nothing is embedded in the `.fig` file.
- No `localStorage` / `sessionStorage` / cookies in the UI iframe.

### Clearing the data

Figma → Plugins → Development → Breakpoint Generator → "Clear plugin data" removes everything listed above. The plugin also has a "Reset defaults" button that rewrites `breakpoints` and `settings` back to their factory values.

---

## Network access

### Manifest

```json
{
  "name": "Breakpoint Generator",
  "id": "breakpoint-generator-dgux-local",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"],
  "permissions": ["teamlibrary"]
}
```

- **No `networkAccess` key.** Figma enforces that plugins without a `networkAccess` allowlist cannot reach any domain. Trying to `fetch()` or open a `WebSocket` fails at the sandbox.
- **`permissions: ["teamlibrary"]`** grants access to `figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()`, `getVariablesInLibraryCollectionAsync()`, and `figma.variables.importVariableByKeyAsync()`. These calls stay inside Figma — the plugin asks Figma for library data, Figma handles the lookup over its own authenticated session. The plugin never sees or controls any endpoint.

### UI

`ui.html` is fully self-contained. Scan for external assets returned:

- One inline `<script>` block (line 625).
- Zero `<link>`, zero external `src=` / `href=`, zero `@import`, zero CDN references (googleapis, unpkg, jsdelivr, etc.).
- No web fonts fetched — the UI renders with system fonts.

### Plugin code

Full scan of `code.js` and `ui.html` for `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `http://`, `https://`:

- Zero matches in executable code paths.
- The single `https://` reference found is in a code comment and is not a URL fetch.

### What "fetch" means in this codebase

A few UI strings use the word "fetching" / "fetch" in comments (e.g. *"True while the sandbox is fetching variables + modes"*). These refer to the plugin asking Figma's in-process API for local variable definitions — not a network request. No HTTP traffic leaves the Figma client.

---

## Figma APIs used (full list)

For completeness, the plugin calls:

- `figma.clientStorage.{get,set,delete}Async` — local storage (above).
- `figma.variables.*` — read/import variables and collections already available to the file.
- `figma.teamLibrary.*` — read-only access to variable collections in connected team libraries.
- `figma.ui.postMessage` / `parent.postMessage` — message passing between the sandbox and the UI iframe, both inside the Figma process.
- `figma.loadFontAsync('Inter')` — loads the font Figma already ships, not a network font.
- Standard node APIs (`clone`, `resize`, `setProperties`, `setExplicitVariableModeForCollection`, `findAll`, `appendChild`) — mutations confined to the open Figma file.

---

## Verification steps

Anyone can re-confirm these claims in under a minute:

1. `grep -nE "fetch|XMLHttpRequest|WebSocket|https?://" code.js ui.html` → only comments and one `https://` in a comment.
2. Inspect `manifest.json` → confirm no `networkAccess` key.
3. Open the plugin, then Figma → DevTools → Network panel → run "Generate". No external requests appear (Figma's own API calls are filtered out of the plugin context).
4. Figma → Plugins → Manage plugins → see permissions listed as only "Team library" — if Figma ever added network permissions, they would be displayed here.

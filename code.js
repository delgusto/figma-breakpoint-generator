// ─── Breakpoint Generator — code.js ──────────────────────────────────────────
// Runs in the Figma plugin sandbox. Communicates with ui.html via postMessage.

figma.showUI(__html__, { width: 460, height: 620, title: 'Breakpoint Generator' });

// Resolve a variable's value in its default mode, following alias chains (max 10 hops).
async function resolveVariableValue(variable) {
  const seen = new Set();
  let current = variable;
  for (let hop = 0; hop < 10; hop++) {
    if (seen.has(current.id)) return null; // circular
    seen.add(current.id);
    const col = await figma.variables.getVariableCollectionByIdAsync(current.variableCollectionId);
    if (!col) return null;
    const val = current.valuesByMode[col.defaultModeId];
    if (typeof val === 'number') return Math.round(val);
    // Alias — follow to the referenced variable
    if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
      current = await figma.variables.getVariableByIdAsync(val.id);
      if (!current) return null;
      continue;
    }
    return null; // unexpected type
  }
  return null;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_BREAKPOINTS = [
  { id: 'mobile',  label: 'Mobile',  width: 390,  enabled: true,  variableId: null },
  { id: 'tablet',  label: 'Tablet',  width: 768,  enabled: true,  variableId: null },
  { id: 'laptop',  label: 'Laptop',  width: 1280, enabled: true,  variableId: null },
  { id: 'desktop', label: 'Desktop', width: 1440, enabled: false, variableId: null },
  { id: 'wide',    label: 'Wide',    width: 1920, enabled: false, variableId: null },
];

const DEFAULT_SETTINGS = {
  gap: 120,
  addLabels: true,
  clearWidthConstraints: false, // Off by default — preserves component constraints. Turn on to strip min/max width so clones resize freely.
  liveUpdates: true,            // When false, the plugin ignores selectionchange events entirely. User must click "Refresh selection" to detect variants on the current selection.
  // Label component (PR A) — when set, the plugin instantiates this component
  // above each clone instead of the plain Inter text label. Empty = text label.
  labelComponentKey: null,      // Stable publish key (library) — preferred for import
  labelComponentId: null,       // Local node id fallback for unpublished local components
  labelComponentName: null,     // Display name, shown in the picker
  labelComponentIsSet: false,   // True when the chosen node is a COMPONENT_SET (import via set API, use defaultVariant)
  labelComponentIsLibrary: false, // True when the component is remote — import by key vs getNodeById
  labelComponentTextProp: null, // Which TEXT component property receives the breakpoint name
  labelComponentVariantProps: null, // Chosen variant per VARIANT property (e.g. {Platform:'web'}) — null = the set's default variant
  labelComponentVariantDefs: null,  // Variant property definitions [{name, options, defaultValue}] so the UI can offer dropdowns across sessions
  // Light/dark sections (PR B) — when a collection + both modes are set, the
  // plugin wraps the generated breakpoints in two Sections (light + dark),
  // each with the appearance variable mode applied. Empty = no sections.
  appearanceDisabled: false,    // True once the user explicitly picks "None" — suppresses auto-detect
  appearanceCollectionId: null,
  appearanceCollectionKey: null,
  appearanceCollectionName: null,
  lightModeId: null,
  lightModeName: null,
  darkModeId: null,
  darkModeName: null,
  // Section background — 'default' keeps Figma's grey, 'transparent' clears the
  // fill, 'variable' binds a COLOR variable so it flips with the section's mode.
  sectionBgMode: 'default',
  sectionBgVariableId: null,
  sectionBgVariableKey: null,
  sectionBgVariableName: null,
  // Group each frame with its label in a vertical auto-layout frame.
  groupWithLabel: true,
};

// Mirrors settings.liveUpdates so the sandbox can short-circuit the debounce
// without round-tripping to the UI on every selection event. Kept in sync via
// save-settings messages.
let liveUpdatesEnabled = true;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const [savedBreakpoints, savedSettings, defaultBreakpoints, preferredLibrary, filterToLibrary, variantTargetId, variantTargetKey, widthSourceId, widthSourceKey, driver, defaultSectionBg, variantSetPrefs] = await Promise.all([
    figma.clientStorage.getAsync('breakpoints'),
    figma.clientStorage.getAsync('settings'),
    figma.clientStorage.getAsync('defaultBreakpoints'),
    figma.clientStorage.getAsync('preferredLibrary'),
    figma.clientStorage.getAsync('filterToLibrary'),
    figma.clientStorage.getAsync('variantTargetId'),   // legacy: local node id
    figma.clientStorage.getAsync('variantTargetKey'),  // stable library key
    figma.clientStorage.getAsync('widthSourceId'),     // top-level width mode collection (local id)
    figma.clientStorage.getAsync('widthSourceKey'),    // …and its stable library key
    figma.clientStorage.getAsync('driver'),            // 'width' | 'variant'
    figma.clientStorage.getAsync('defaultSectionBg'),  // user-saved default frame background
    figma.clientStorage.getAsync('variantSetPrefs'),   // per-set enable/disable for the variant overlay
  ]);

  const breakpoints = savedBreakpoints || DEFAULT_BREAKPOINTS;
  // A user-saved default background seeds fresh settings (first run, or after
  // a reset) — live settings always win once they exist.
  const settings = savedSettings || Object.assign({}, DEFAULT_SETTINGS, defaultSectionBg || {});
  liveUpdatesEnabled = settings.liveUpdates !== false; // default true if absent

  // Read all FLOAT variables + multi-mode collections — both can be used as breakpoint links.
  // The label component is captured from the canvas selection (no document-wide
  // component scan), so there's nothing component-related to load here.
  // Colour variables are loaded lazily (on-demand 'load-colors') the first time
  // the user opens the light/dark frame options — enumerating them is a third
  // pass over every library variable and was slowing plugin open.
  const [variableOptions, modeOptions] = await Promise.all([
    getFloatVariables(),
    getVariableCollectionModes(),
  ]);

  figma.ui.postMessage({
    type: 'init',
    breakpoints,
    settings,
    variableOptions,
    modeOptions,
    componentOptions: [],
    defaultBreakpoints: defaultBreakpoints || null,
    preferredLibrary: preferredLibrary || null,
    filterToLibrary: !!filterToLibrary,
    variantTargetId: variantTargetId || null,
    variantTargetKey: variantTargetKey || null,
    variantSetPrefs: variantSetPrefs || null,
    widthSourceId: widthSourceId || null,
    widthSourceKey: widthSourceKey || null,
    driver: driver || 'width',
  });
  sendSelection();
}

// ─── Variable / token helpers ─────────────────────────────────────────────────

async function getFloatVariables() {
  let allVars = [];
  let collections = [];

  try {
    allVars = await figma.variables.getLocalVariablesAsync();
  } catch (err) {
    figma.ui.postMessage({ type: 'var-error', message: 'Could not read variables: ' + err.message });
    return [];
  }

  try {
    collections = await figma.variables.getLocalVariableCollectionsAsync();
  } catch (err) {
    figma.ui.postMessage({ type: 'var-error', message: 'Could not read variable collections: ' + err.message });
    return [];
  }

  const result = [];
  // Track keys of already-imported library vars to avoid duplicates in the library fetch below
  const importedKeys = new Set();

  for (const v of allVars) {
    if (v.resolvedType !== 'FLOAT') continue;

    const resolvedVal = await resolveVariableValue(v);
    if (resolvedVal === null) continue;

    let col = null;
    for (const c of collections) {
      if (c.id === v.variableCollectionId) { col = c; break; }
    }

    if (v.key) importedKeys.add(v.key);

    result.push({
      id: v.id,
      key: v.key || null,
      name: v.name,
      collection: col ? col.name : '',
      libraryName: 'Local',
      value: resolvedVal,
      isLibrary: false,
    });
  }

  // Fetch variables from linked libraries that haven't been imported into this file yet
  try {
    const libCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (const libCol of libCollections) {
      try {
        const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(libCol.key);
        for (const lv of libVars) {
          if (lv.resolvedType !== 'FLOAT') continue;
          if (importedKeys.has(lv.key)) continue;
          // Import to read the actual value (idempotent — same as using a library token on a frame)
          let resolvedValue = null;
          try {
            const imported = await figma.variables.importVariableByKeyAsync(lv.key);
            if (imported) resolvedValue = await resolveVariableValue(imported);
          } catch (err) {
            // Import failed — show without value
          }
          result.push({
            id: null,
            key: lv.key,
            name: lv.name,
            collection: libCol.name,
            libraryName: libCol.libraryName || 'Library',
            value: resolvedValue,
            isLibrary: true,
          });
        }
      } catch (err) {
        // Skip any collection we can't read
      }
    }
  } catch (err) {
    // teamLibrary unavailable or no libraries connected
  }

  return result;
}

// Enumerate COLOR variables (local + linked libraries) for the section
// background picker. We don't resolve values — just name/id/key for display
// and binding. Library vars are listed by key (no import needed until used).
//
// Big orgs can have dozens of libraries with thousands of colour tokens, so
// this pass streams: local colours are emitted immediately, then each library
// collection is fetched IN PARALLEL with its own timeout and emitted as it
// lands. One huge or hung library can no longer stall the whole picker.
// `onUpdate(result, done)` fires after every batch; `done` is true on the
// final call.
const COLOR_VARS_CAP = 1500;       // past this a dropdown is unusable anyway
const COLOR_FETCH_TIMEOUT_MS = 15000;

async function getColorVariables(onUpdate) {
  const result = [];
  const importedKeys = new Set();

  const emit = (done) => {
    result.sort(function(a, b) {
      if (a.libraryName !== b.libraryName) return a.libraryName === 'Local' ? -1 : (b.libraryName === 'Local' ? 1 : (a.libraryName < b.libraryName ? -1 : 1));
      return String(a.name).localeCompare(String(b.name));
    });
    if (onUpdate) onUpdate(result, done);
  };
  const withTimeout = (promise) => Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('library fetch timed out')), COLOR_FETCH_TIMEOUT_MS)),
  ]);

  // Local colours — fast; show them straight away.
  try {
    const localVars = await figma.variables.getLocalVariablesAsync();
    const cols = await figma.variables.getLocalVariableCollectionsAsync();
    for (const v of localVars) {
      if (v.resolvedType !== 'COLOR') continue;
      let colName = '';
      for (const c of cols) { if (c.id === v.variableCollectionId) { colName = c.name; break; } }
      if (v.key) importedKeys.add(v.key);
      result.push({
        id: v.id, key: v.key || null, name: v.name,
        collection: colName, libraryName: 'Local', isLibrary: false,
      });
    }
  } catch (err) {}
  emit(false);

  // Library colours — all collections in flight at once, each guarded.
  try {
    const libCollections = await withTimeout(figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync());
    await Promise.all(libCollections.map(async function(libCol) {
      try {
        const libVars = await withTimeout(figma.teamLibrary.getVariablesInLibraryCollectionAsync(libCol.key));
        for (const lv of libVars) {
          if (result.length >= COLOR_VARS_CAP) break;
          if (lv.resolvedType !== 'COLOR') continue;
          if (importedKeys.has(lv.key)) continue;
          result.push({
            id: null, key: lv.key, name: lv.name,
            collection: libCol.name, libraryName: libCol.libraryName || 'Library', isLibrary: true,
          });
        }
        emit(false);
      } catch (err) {
        // Slow or unreadable collection — skip it, keep everything else.
      }
    }));
  } catch (err) {}

  if (result.length >= COLOR_VARS_CAP) {
    console.warn('Breakpoint Generator: colour list capped at ' + COLOR_VARS_CAP + ' tokens');
  }
  emit(true);
  return result;
}

// Find the first FLOAT variable in a collection whose name contains "width" (case-insensitive).
// Returns the Variable object or null. Used to sample a width value per mode.
async function findWidthVariable(collection) {
  if (!collection || !collection.variableIds) return null;
  for (const varId of collection.variableIds) {
    try {
      const v = await figma.variables.getVariableByIdAsync(varId);
      if (v && v.resolvedType === 'FLOAT' && v.name.toLowerCase().includes('width')) return v;
    } catch (err) {}
  }
  return null;
}

// Resolve a COLOR variable's value in a specific mode, following alias chains
// (max 10 hops). Alias targets may live in other collections — when the
// requested mode doesn't exist on the current variable, its own collection's
// default mode is used. Returns an {r,g,b,a?} object or null.
async function resolveColorValueInMode(variable, modeId) {
  const seen = new Set();
  let current = variable;
  for (let hop = 0; hop < 10; hop++) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    let val = current.valuesByMode[modeId];
    if (val === undefined) {
      const col = await figma.variables.getVariableCollectionByIdAsync(current.variableCollectionId);
      if (col) val = current.valuesByMode[col.defaultModeId];
    }
    if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
      current = await figma.variables.getVariableByIdAsync(val.id);
      if (!current) return null;
      continue;
    }
    if (val && typeof val === 'object' && 'r' in val) return val;
    return null;
  }
  return null;
}

// Resolve a specific variable's value in a specific mode (not the default), following aliases.
async function resolveVariableValueInMode(variable, modeId) {
  const seen = new Set();
  let current = variable;
  for (let hop = 0; hop < 10; hop++) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    let val = current.valuesByMode[modeId];
    // If the mode doesn't exist on this variable, try the collection's default
    if (val === undefined) {
      const col = await figma.variables.getVariableCollectionByIdAsync(current.variableCollectionId);
      if (col) val = current.valuesByMode[col.defaultModeId];
    }
    if (typeof val === 'number') return Math.round(val);
    if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
      current = await figma.variables.getVariableByIdAsync(val.id);
      if (!current) return null;
      continue;
    }
    return null;
  }
  return null;
}

// Enumerate every (collection, mode) pair from local + library collections that have >1 mode.
// For each mode, try to resolve a "width" variable's value in that mode so the UI can
// show and auto-fill the width field.
async function getVariableCollectionModes() {
  const result = [];
  const seenCollectionKeys = new Set();

  // Local collections
  try {
    const localCols = await figma.variables.getLocalVariableCollectionsAsync();
    for (const col of localCols) {
      if (!col.modes || col.modes.length < 2) continue;
      if (col.key) seenCollectionKeys.add(col.key);
      const widthVar = await findWidthVariable(col);
      for (const mode of col.modes) {
        let modeValue = null;
        if (widthVar) {
          try { modeValue = await resolveVariableValueInMode(widthVar, mode.modeId); } catch (err) {}
        }
        result.push({
          collectionId: col.id,
          collectionKey: col.key || null,
          collectionName: col.name,
          libraryName: 'Local',
          modeId: mode.modeId,
          modeName: mode.name,
          value: modeValue,
          isLibrary: false,
        });
      }
    }
  } catch (err) {}

  // Library collections
  try {
    const libCols = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (const libCol of libCols) {
      if (libCol.key && seenCollectionKeys.has(libCol.key)) continue;
      try {
        const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(libCol.key);
        if (!libVars.length) continue;
        const imported = await figma.variables.importVariableByKeyAsync(libVars[0].key);
        if (!imported) continue;
        const col = await figma.variables.getVariableCollectionByIdAsync(imported.variableCollectionId);
        if (!col || !col.modes || col.modes.length < 2) continue;
        const widthVar = await findWidthVariable(col);
        for (const mode of col.modes) {
          let modeValue = null;
          if (widthVar) {
            try { modeValue = await resolveVariableValueInMode(widthVar, mode.modeId); } catch (err) {}
          }
          result.push({
            collectionId: col.id,
            collectionKey: col.key || libCol.key || null,
            collectionName: col.name || libCol.name,
            libraryName: libCol.libraryName || 'Library',
            modeId: mode.modeId,
            modeName: mode.name,
            value: modeValue,
            isLibrary: true,
          });
        }
      } catch (err) {}
    }
  } catch (err) {}

  return result;
}

// Collect variable ids referenced by a single node (node-level bindings +
// per-paint color bindings on fills/strokes).
function collectVarIdsFromNode(n, set) {
  const bv = n.boundVariables;
  if (bv) {
    for (const key of Object.keys(bv)) {
      const val = bv[key];
      if (Array.isArray(val)) {
        for (const a of val) { if (a && a.id) set.add(a.id); }
      } else if (val && val.id) {
        set.add(val.id);
      } else if (val && typeof val === 'object') {
        for (const k of Object.keys(val)) { const a = val[k]; if (a && a.id) set.add(a.id); }
      }
    }
  }
  for (const prop of ['fills', 'strokes']) {
    const paints = n[prop];
    if (Array.isArray(paints)) {
      for (const p of paints) {
        if (p && p.boundVariables && p.boundVariables.color && p.boundVariables.color.id) {
          set.add(p.boundVariables.color.id);
        }
      }
    }
  }
}

// Walk the selected node's subtree, gather every variable it binds, and return
// the multi-mode collections those variables belong to. This surfaces the
// collection the content ACTUALLY consumes — which the blanket library
// enumeration may miss (e.g. it found an unrelated kit instead).
// The collection id that a node's own `width` is bound to (if any, and if it
// has ≥2 modes). Used to auto-pick the right width source on detect.
async function widthBoundCollectionId(node) {
  try {
    const bv = node.boundVariables;
    const w = bv && bv.width;
    if (!w || !w.id) return null;
    const v = await figma.variables.getVariableByIdAsync(w.id);
    if (!v) return null;
    const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
    if (col && col.modes && col.modes.length >= 2) return col.id;
  } catch (err) {}
  return null;
}

async function getCollectionsUsedByNode(root) {
  if (!root) return [];

  // Bounded BFS — don't let findAll allocate a huge array on a giant subtree.
  const MAX_NODES = 6000;
  const MAX_VARS = 400;
  const varIds = new Set();
  const queue = [root];
  let visited = 0;
  while (queue.length && visited < MAX_NODES && varIds.size < MAX_VARS) {
    const n = queue.shift();
    visited++;
    try { collectVarIdsFromNode(n, varIds); } catch (err) {}
    if ('children' in n && n.children) {
      for (const c of n.children) queue.push(c);
    }
  }

  const colById = new Map();
  for (const id of varIds) {
    if (colById.size >= 8) break; // a handful of collections is plenty for the picker
    try {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (!v) continue;
      const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
      if (!col || !col.modes || col.modes.length < 2) continue;
      if (colById.has(col.id)) continue;
      colById.set(col.id, {
        collectionId: col.id,
        collectionKey: col.key || null,
        collectionName: col.name,
        libraryName: col.remote ? 'Library' : 'Local',
        modes: col.modes.map(function(m) { return { modeId: m.modeId, modeName: m.name }; }),
      });
    } catch (err) {}
  }
  return Array.from(colById.values());
}

// ─── Component choices (label component picker) ───────────────────────────────

// Build a label-choice object from a COMPONENT or COMPONENT_SET node.
function componentChoiceFromNode(node, isLibrary) {
  if (!node) return null;
  const textProps = [];
  const variantDefs = [];
  try {
    const defs = node.componentPropertyDefinitions || {};
    for (const propName of Object.keys(defs)) {
      if (!defs[propName]) continue;
      if (defs[propName].type === 'TEXT') textProps.push(propName);
      if (defs[propName].type === 'VARIANT') {
        variantDefs.push({
          name: propName,
          options: (defs[propName].variantOptions || []).slice(),
          defaultValue: defs[propName].defaultValue || null,
        });
      }
    }
  } catch (err) {}
  return {
    key: node.key || null,
    id: node.id,
    name: node.name,
    isSet: node.type === 'COMPONENT_SET',
    isLibrary: !!isLibrary,
    libraryName: isLibrary ? 'Library' : 'Local',
    textProps: textProps,
    variantDefs: variantDefs,
  };
}

// Resolve any selected node (instance / component / variant) up to the
// component or set the user means to use as a label. Returns a choice object
// or null when the selection isn't component-backed.
async function captureComponentChoiceFromSelection() {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) return null;
  let node = sel[0];

  // Remember which variant the user actually had selected — resolving up to
  // the set below loses it, and the set's DEFAULT variant is often not the
  // one they meant (e.g. picked "web", default is "ios").
  let variantProps = null;
  const rememberVariants = (props) => {
    for (const k of Object.keys(props || {})) {
      const p = props[k];
      // Instance componentProperties entries are {type, value}; a bare
      // variant component's variantProperties are plain name → value.
      const value = (p && typeof p === 'object' && 'value' in p) ? (p.type === 'VARIANT' ? p.value : undefined) : p;
      if (value !== undefined) (variantProps = variantProps || {})[k] = value;
    }
  };

  // Instance → its main component.
  if (node.type === 'INSTANCE') {
    try { rememberVariants(node.componentProperties); } catch (err) {}
    try { node = await node.getMainComponentAsync(); } catch (err) { return null; }
  }
  if (!node) return null;

  // A bare variant → surface its parent set.
  if (node.type === 'COMPONENT' && node.parent && node.parent.type === 'COMPONENT_SET') {
    if (!variantProps) { try { rememberVariants(node.variantProperties); } catch (err) {} }
    node = node.parent;
  }
  if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') return null;

  const choice = componentChoiceFromNode(node, !!node.remote);
  if (choice && choice.isSet) choice.variantProps = variantProps;
  return choice;
}

// Resolve the configured label component to a main ComponentNode ready to
// instantiate. Library → import by key; local → look up by node id. For sets,
// return the default variant. Null when not configured or unresolvable.
async function resolveLabelMainComponent(settings) {
  if (!settings || !settings.addLabels) return null;
  const key = settings.labelComponentKey;
  const id = settings.labelComponentId;
  if (!key && !id) return null;

  try {
    if (settings.labelComponentIsLibrary && key) {
      if (settings.labelComponentIsSet) {
        const set = await figma.importComponentSetByKeyAsync(key);
        return set ? (set.defaultVariant || null) : null;
      }
      return await figma.importComponentByKeyAsync(key);
    }
    // Local component — id is stable within the file.
    if (id) {
      const node = await figma.getNodeByIdAsync(id);
      if (!node) return null;
      if (node.type === 'COMPONENT_SET') return node.defaultVariant || null;
      if (node.type === 'COMPONENT') return node;
    }
  } catch (err) {}
  return null;
}

// Load every font used by a text node so its characters can be edited.
async function loadFontsForTextNode(node) {
  try {
    const len = Math.max(1, node.characters.length);
    const fonts = node.getRangeAllFontNames(0, len);
    await Promise.all(fonts.map(f => figma.loadFontAsync(f)));
    return true;
  } catch (err) {
    try {
      if (node.fontName && node.fontName !== figma.mixed) {
        await figma.loadFontAsync(node.fontName);
        return true;
      }
    } catch (err2) {}
  }
  return false;
}

// Write the breakpoint label into a label-component instance. Prefers a real
// TEXT component property when one is configured; otherwise falls back to the
// first editable TEXT layer inside the instance (the common case for label
// components that just contain a text node, no exposed property).
async function setInstanceLabelText(inst, textProp, text) {
  if (textProp) {
    try { inst.setProperties({ [textProp]: text }); return true; } catch (err) {}
  }
  try {
    const textNode = inst.findOne(n => n.type === 'TEXT');
    if (textNode) {
      const ok = await loadFontsForTextNode(textNode);
      if (ok) { textNode.characters = text; return true; }
    }
  } catch (err) {}
  return false;
}

async function resolveWidth(bp) {
  try {
    let variable = null;
    if (bp.variableId) {
      variable = await figma.variables.getVariableByIdAsync(bp.variableId);
    } else if (bp.variableKey) {
      variable = await figma.variables.importVariableByKeyAsync(bp.variableKey);
    }
    if (variable) {
      const val = await resolveVariableValue(variable);
      if (val !== null) return val;
    }
  } catch (err) {
    // fall through to static width
  }
  return bp.width;
}

// ─── Selection ────────────────────────────────────────────────────────────────

function getSourceNode() {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) return null;
  const node = sel[0];
  if (['FRAME', 'INSTANCE', 'COMPONENT'].includes(node.type)) {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      width: Math.round(node.width),
      height: Math.round(node.height),
      hasAutoLayout: node.type === 'FRAME' && node.layoutMode !== 'NONE',
    };
  }
  return null;
}

async function sendSelection() {
  const source = getSourceNode();
  const node = source ? await figma.getNodeByIdAsync(source.id) : null;
  // Variant detection is the only per-selection scan. It's depth- and
  // budget-capped (see collectInstancesWithDepth) so a huge selection can't
  // hang Figma. Appearance-collection detection is NOT run here — it walks the
  // whole subtree and resolves variables, which is too heavy for the hot path;
  // it runs only when the user clicks "Detect from selected frame".
  const variantSchema = node ? await detectVariantSchema(node) : null;
  figma.ui.postMessage({ type: 'selection', source, variantSchema });
}

// Walk the selected node (and its descendants) and return every component set
// whose instances appear inside the selection, ranked by how likely they are to
// be the "breakpoint" set the user wants to switch.
//
// Ranking signals (most → least important):
//   1. Variant option names look like breakpoint labels (XS/SM/MD/LG/XL,
//      Mobile/Tablet/Laptop/Desktop/Wide, Small/Medium/Large). These are
//      almost always the target.
//   2. Shallow depth from the selection. A local component wrapping one
//      library breakpoint component puts the target at depth 1-2; deeply
//      nested buttons live at depth 4+.
//   3. Fewer variant options total. Breakpoint sets usually have 3-7; a
//      button set with size+state+variant cross-products has dozens.
//
// The UI picks the top candidate automatically but always lets the user
// override via the target dropdown.
const BREAKPOINT_TOKEN_WORDS = [
  'mobile','tablet','laptop','desktop','wide','ultrawide',
  'xs','sm','md','lg','xl','xxl','xxxl','2xl','3xl',
  'small','medium','large','extra-small','extra-large',
  'phone','pad','tv',
];

function countBreakpointAffinity(properties) {
  let hits = 0;
  for (const prop of properties) {
    for (const opt of prop.options) {
      const lowered = String(opt).toLowerCase().replace(/\s+/g, '-');
      if (BREAKPOINT_TOKEN_WORDS.indexOf(lowered) !== -1) hits += 1;
    }
  }
  return hits;
}

// Per-session cache of computed schema by component-set id. Building the
// schema walks every variant component in the set (for variantSizes), which
// is wasted work when the same set re-appears on every selection change in a
// busy file. Set definitions are stable for the session — if the user edits
// the set we accept a stale cache until the plugin is reopened.
const SCHEMA_CACHE = new Map();

function buildSchemaForSet(set) {
  const cached = SCHEMA_CACHE.get(set.id);
  if (cached) return cached;
  const built = buildSchemaForSetUncached(set);
  if (built) SCHEMA_CACHE.set(set.id, built);
  return built;
}

function buildSchemaForSetUncached(set) {
  // Reading componentPropertyDefinitions throws ("Component set has existing
  // errors") when the set has variant conflicts. Guard it so one broken set in
  // the selection can't crash the whole detection pass — we just skip it.
  let defs;
  try {
    defs = set.componentPropertyDefinitions || {};
  } catch (err) {
    return null;
  }
  const properties = [];
  for (const key of Object.keys(defs)) {
    const d = defs[key];
    if (d && d.type === 'VARIANT') {
      properties.push({
        name: key,
        options: (d.variantOptions || []).slice(),
        defaultValue: d.defaultValue || null,
      });
    }
  }
  if (!properties.length) return null;

  // Walk each component in the set and capture its intrinsic width keyed by
  // its variantProperties combo. The UI uses this to display the *actual*
  // width of the picked variant on the Generate tab (rather than the
  // misleading static bp.width input that the user can't drive when a
  // variant is selected). Guard per-child reads too — a conflicted set can
  // throw on variantProperties as well.
  const variantSizes = [];
  if ('children' in set && set.children) {
    for (const child of set.children) {
      try {
        if (child.type !== 'COMPONENT') continue;
        const vProps = child.variantProperties || null;
        if (!vProps) continue;
        variantSizes.push({
          props: Object.assign({}, vProps),
          width: Math.round(child.width),
          height: Math.round(child.height),
        });
      } catch (err) { /* skip a broken variant child */ }
    }
  }

  // `id` is the local node id (changes per file for library components).
  // `key` is the library publication key — stable across files. We expose
  // both: id is used to match instances inside the clone at apply time,
  // key is used by the UI as the stable storage key for per-set variant
  // assignments so picks survive across files / re-imports.
  return {
    componentSetId: set.id,
    componentSetKey: set.key || '',
    componentSetName: set.name,
    properties: properties,
    variantSizes: variantSizes,
  };
}

// Breadth-first walk so we can track depth. Figma's findAll doesn't give us
// depth, so we do it manually. Capped at MAX_DETECT_DEPTH to keep selection
// changes responsive on large frames — the variant set we care about is
// almost always within a few layers of the selected node; descending into
// every leaf node of a deeply nested layout just to find buttons that we'd
// rank low anyway is wasted work that lags Figma during selection drags.
const MAX_DETECT_DEPTH = 8;
// Hard budgets so selecting a huge frame/section can't lock up or crash Figma.
// We stop visiting once either cap is hit and detection works on what we have.
const MAX_DETECT_NODES = 6000;     // total nodes the BFS will touch
const MAX_DETECT_INSTANCES = 1500; // instances we'll collect before stopping

function collectInstancesWithDepth(root) {
  const results = [];
  const queue = [{ node: root, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    if (visited >= MAX_DETECT_NODES || results.length >= MAX_DETECT_INSTANCES) break;
    visited++;
    const { node, depth } = queue.shift();
    if (node.type === 'INSTANCE') results.push({ inst: node, depth });
    if (depth >= MAX_DETECT_DEPTH) continue;
    if ('children' in node && node.children) {
      for (const child of node.children) queue.push({ node: child, depth: depth + 1 });
    }
  }
  return results;
}

async function detectVariantSchema(node) {
  if (!node) return null;

  const found = collectInstancesWithDepth(node);
  if (!found.length) return null;

  // Group by component-set id, keeping the shallowest depth seen.
  const bySet = new Map();
  for (const { inst, depth } of found) {
    try {
      const main = await inst.getMainComponentAsync();
      if (!main) continue;
      const parent = main.parent;
      if (!parent || parent.type !== 'COMPONENT_SET') continue;
      const entry = bySet.get(parent.id);
      if (entry) {
        entry.count += 1;
        if (depth < entry.minDepth) entry.minDepth = depth;
      } else {
        bySet.set(parent.id, { set: parent, count: 1, minDepth: depth });
      }
    } catch (err) {}
  }
  if (!bySet.size) return null;

  // Build candidate objects with ranking metadata.
  const candidates = [];
  bySet.forEach(function(entry) {
    const schema = buildSchemaForSet(entry.set);
    if (!schema) return;
    const totalOptions = schema.properties.reduce((n, p) => n + p.options.length, 0);
    candidates.push(Object.assign({}, schema, {
      count: entry.count,
      minDepth: entry.minDepth,
      totalOptions: totalOptions,
      breakpointAffinity: countBreakpointAffinity(schema.properties),
    }));
  });
  if (!candidates.length) return null;

  // Sort: high affinity first, then shallow, then fewer total options.
  candidates.sort(function(a, b) {
    if (b.breakpointAffinity !== a.breakpointAffinity) return b.breakpointAffinity - a.breakpointAffinity;
    if (a.minDepth !== b.minDepth) return a.minDepth - b.minDepth;
    return a.totalOptions - b.totalOptions;
  });

  return {
    candidates: candidates,
    primaryId: candidates[0].componentSetId,
  };
}

// Debounce `selectionchange` — Figma fires it many times during a drag-select
// or rapid clicking, and detectVariantSchema is the most expensive thing the
// plugin does on the hot path. Coalescing to one run per 200ms idle window
// keeps the UI responsive without noticeably delaying single clicks.
let selectionDebounceTimer = null;
function sendSelectionDebounced() {
  // Gate: when the user has disabled live updates, ignore selection events
  // entirely. They will hit "Refresh selection" in the UI when they want a
  // detection pass — that fires `refresh-selection` and runs immediately.
  if (!liveUpdatesEnabled) return;
  if (selectionDebounceTimer) clearTimeout(selectionDebounceTimer);
  selectionDebounceTimer = setTimeout(() => {
    selectionDebounceTimer = null;
    sendSelection();
  }, 200);
}
figma.on('selectionchange', sendSelectionDebounced);

// ─── Message router ───────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case 'ready':
      await init();
      break;

    case 'save-settings':
      await Promise.all([
        figma.clientStorage.setAsync('breakpoints', msg.breakpoints),
        figma.clientStorage.setAsync('settings', msg.settings),
      ]);
      // Mirror the live-updates flag into the sandbox so the next
      // selectionchange honours the new value without waiting for a UI
      // round-trip.
      if (msg.settings && typeof msg.settings.liveUpdates === 'boolean') {
        liveUpdatesEnabled = msg.settings.liveUpdates;
      }
      break;

    case 'refresh-selection':
      // Manual trigger — runs detection immediately regardless of the
      // liveUpdates setting. Cancels any pending debounce so we don't
      // double-fire.
      if (selectionDebounceTimer) {
        clearTimeout(selectionDebounceTimer);
        selectionDebounceTimer = null;
      }
      sendSelection();
      break;

    case 'save-variant-target':
      await Promise.all([
        figma.clientStorage.setAsync('variantTargetId', msg.variantTargetId || null),
        figma.clientStorage.setAsync('variantTargetKey', msg.variantTargetKey || null),
      ]);
      break;

    case 'save-variant-prefs':
      // { [stableSetKey]: boolean } — explicit per-set enable/disable for the
      // variant overlay. Absence of a key means "use the default rule".
      await figma.clientStorage.setAsync('variantSetPrefs', msg.variantSetPrefs || null);
      break;

    case 'save-width-source':
      await Promise.all([
        figma.clientStorage.setAsync('widthSourceId', msg.widthSourceId || null),
        figma.clientStorage.setAsync('widthSourceKey', msg.widthSourceKey || null),
      ]);
      break;

    case 'save-driver':
      await figma.clientStorage.setAsync('driver', msg.driver === 'variant' ? 'variant' : 'width');
      break;

    case 'reset-settings': {
      await Promise.all([
        figma.clientStorage.deleteAsync('breakpoints'),
        figma.clientStorage.deleteAsync('settings'),
      ]);
      // Library prefs + user defaults survive a reset. Component enumeration is
      // on-demand (not run here) to keep large files responsive.
      const [defaultBreakpoints, preferredLibrary, filterToLibrary, defaultSectionBg, variantSetPrefs, variantTargetId, variantTargetKey, widthSourceId, widthSourceKey, driver, variableOptions, modeOptions] = await Promise.all([
        figma.clientStorage.getAsync('defaultBreakpoints'),
        figma.clientStorage.getAsync('preferredLibrary'),
        figma.clientStorage.getAsync('filterToLibrary'),
        figma.clientStorage.getAsync('defaultSectionBg'),
        figma.clientStorage.getAsync('variantSetPrefs'),
        figma.clientStorage.getAsync('variantTargetId'),
        figma.clientStorage.getAsync('variantTargetKey'),
        figma.clientStorage.getAsync('widthSourceId'),
        figma.clientStorage.getAsync('widthSourceKey'),
        figma.clientStorage.getAsync('driver'),
        getFloatVariables(),
        getVariableCollectionModes(),
      ]);
      figma.ui.postMessage({
        type: 'init',
        // Prefer user-saved defaults over factory defaults.
        breakpoints: defaultBreakpoints || DEFAULT_BREAKPOINTS,
        settings: Object.assign({}, DEFAULT_SETTINGS, defaultSectionBg || {}),
        variableOptions,
        modeOptions,
        componentOptions: [],
        defaultBreakpoints: defaultBreakpoints || null,
        preferredLibrary: preferredLibrary || null,
        filterToLibrary: !!filterToLibrary,
        // Surviving prefs the reset init must not silently null in UI state.
        variantSetPrefs: variantSetPrefs || null,
        variantTargetId: variantTargetId || null,
        variantTargetKey: variantTargetKey || null,
        widthSourceId: widthSourceId || null,
        widthSourceKey: widthSourceKey || null,
        driver: driver || 'width',
      });
      break;
    }

    case 'save-defaults':
      await figma.clientStorage.setAsync('defaultBreakpoints', msg.breakpoints);
      break;

    case 'save-library-pref':
      await Promise.all([
        figma.clientStorage.setAsync('preferredLibrary', msg.preferredLibrary || null),
        figma.clientStorage.setAsync('filterToLibrary', !!msg.filterToLibrary),
      ]);
      break;

    case 'refresh-variables': {
      const [variableOptions, modeOptions] = await Promise.all([
        getFloatVariables(),
        getVariableCollectionModes(),
      ]);
      figma.ui.postMessage({ type: 'variables', variableOptions, modeOptions });
      break;
    }

    case 'load-colors': {
      // On-demand colour-variable enumeration for the frame background picker.
      // Streams: the UI gets local colours immediately, then library batches
      // as each collection loads (done=true on the final batch).
      await getColorVariables(function(colorOptions, done) {
        figma.ui.postMessage({ type: 'colors', colorOptions, done });
      });
      break;
    }

    case 'detect-source-collections': {
      // Scan the current selection's subtree for the multi-mode collections it
      // actually uses, so the appearance picker can offer the right one.
      const sel = figma.currentPage.selection;
      const node = sel.length === 1 ? sel[0] : null;
      const collections = node ? await getCollectionsUsedByNode(node) : [];
      figma.ui.postMessage({ type: 'source-collections', collections });
      break;
    }

    case 'detect-width-source': {
      // Same subtree scan, but for the top-level width mode collection. Prefer
      // the collection the node's own width is bound to; else all it uses.
      const sel = figma.currentPage.selection;
      const node = sel.length === 1 ? sel[0] : null;
      const preferredId = node ? await widthBoundCollectionId(node) : null;
      const collections = node ? await getCollectionsUsedByNode(node) : [];
      figma.ui.postMessage({ type: 'width-source-collections', collections, preferredId });
      break;
    }

    case 'preview-color': {
      // Resolve the selected background variable's colour in its collection's
      // first two modes (typically light + dark) so the UI can show a swatch.
      // Only the SELECTED token is ever resolved — resolving the whole list
      // is exactly the perf hole the streaming loader avoids.
      let variable = null;
      try {
        if (msg.variableId) variable = await figma.variables.getVariableByIdAsync(msg.variableId);
      } catch (err) {}
      try {
        if (!variable && msg.variableKey) variable = await figma.variables.importVariableByKeyAsync(msg.variableKey);
      } catch (err) {}
      const swatches = [];
      if (variable) {
        try {
          const col = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
          const modes = (col && col.modes ? col.modes : []).slice(0, 2);
          for (const m of modes) {
            const val = await resolveColorValueInMode(variable, m.modeId);
            if (val) swatches.push({ modeName: m.name, color: { r: val.r, g: val.g, b: val.b, a: ('a' in val) ? val.a : 1 } });
          }
        } catch (err) {}
      }
      figma.ui.postMessage({ type: 'color-preview', requestId: msg.requestId || null, swatches });
      break;
    }

    case 'save-default-bg':
      // Persist the current frame-background choice as the user's default —
      // seeds fresh settings and survives "Reset settings" (like
      // defaultBreakpoints does for the breakpoint rows).
      await figma.clientStorage.setAsync('defaultSectionBg', {
        sectionBgMode: msg.sectionBgMode === 'variable' ? 'variable' : 'transparent',
        sectionBgVariableId: msg.sectionBgVariableId || null,
        sectionBgVariableKey: msg.sectionBgVariableKey || null,
        sectionBgVariableName: msg.sectionBgVariableName || null,
      });
      figma.notify('Saved as your default frame background');
      break;

    case 'capture-label-component': {
      // Read the current selection and resolve it to a component/set choice.
      // This is how the user picks a library component that isn't enumerable
      // via the in-file scan — they just select it (or an instance of it).
      const choice = await captureComponentChoiceFromSelection();
      figma.ui.postMessage({ type: 'label-component-captured', choice: choice || null });
      // Picking the label component changed the canvas selection away from the
      // frame the user is generating from. Re-select it so they don't lose it.
      if (msg.restoreSelectionId) {
        try {
          const src = await figma.getNodeByIdAsync(msg.restoreSelectionId);
          if (src && !src.removed) figma.currentPage.selection = [src];
        } catch (err) {}
      }
      break;
    }

    case 'generate':
      try {
        const count = await generate(msg.payload);
        figma.ui.postMessage({ type: 'done', count });
        figma.notify(`✓ ${count} breakpoint${count !== 1 ? 's' : ''} generated`);
      } catch (err) {
        figma.ui.postMessage({ type: 'error', message: err.message });
        figma.notify(err.message, { error: true });
      }
      break;

    default:
      console.warn('Breakpoint Generator: unhandled message type', msg.type);
      break;
  }
};

// ─── Generate ─────────────────────────────────────────────────────────────────

async function generate({ sourceId, breakpoints, settings, primaryVariantSetId, variantTargetId }) {
  // Reject malformed payloads before touching the canvas — a partial run would
  // leave orphaned clones behind.
  if (!sourceId || !Array.isArray(breakpoints) || !settings) {
    throw new Error('Invalid payload — missing sourceId, breakpoints, or settings.');
  }
  const source = await figma.getNodeByIdAsync(sourceId);
  if (!source) throw new Error('Source not found — re-select the frame and try again.');
  if (!['FRAME', 'INSTANCE', 'COMPONENT'].includes(source.type)) {
    throw new Error('Select a Frame, Component or Instance.');
  }

  const enabled = breakpoints.filter(bp => bp.enabled);
  if (enabled.length === 0) throw new Error('Enable at least one breakpoint.');

  const GAP = typeof settings.gap === 'number' ? settings.gap : 120;

  // Pre-load fonts once if labels are needed
  if (settings.addLabels) {
    await Promise.all([
      figma.loadFontAsync({ family: 'Inter', style: 'Medium' }),
      figma.loadFontAsync({ family: 'Inter', style: 'Regular' }),
    ]);
  }

  // Resolve the label component once (if configured). When it fails to resolve
  // we fall back to the plain text label so the run still completes.
  const labelMain = settings.addLabels ? await resolveLabelMainComponent(settings) : null;
  const labelTextProp = settings.labelComponentTextProp || null;

  // Resolve variable-bound widths for the fallback (static & variable-linked cases).
  // Mode-linked breakpoints fall back to bp.width here; their *actual* width is
  // read from the clone after setExplicitVariableModeForCollection is applied.
  const resolved = await Promise.all(
    enabled.map(async function(bp) {
      const width = await resolveWidth(bp);
      return Object.assign({}, bp, { width: width });
    })
  );

  const parent = source.parent;
  const baseY = source.y;

  // Wrapping the output in light/dark frames uses a horizontal auto-layout, so
  // each breakpoint must be ONE node. Force per-breakpoint grouping when frames
  // are configured (and labels are on) so the layout stays clean.
  const wrapInFrames = appearanceConfigured(settings);
  const doGroup = settings.groupWithLabel !== false || wrapInFrames;

  // Clones are generated in the order the user has arranged them in the Settings
  // list — no auto-sort by width. Each clone is placed immediately to the right
  // of the previous one, using the *actual* post-layout width.
  let cursor = source.x + source.width + GAP;
  const generated = [];
  const cloneNodes = []; // clones only — used for the final selection

  for (const bp of resolved) {
    const clone = source.clone();
    if (clone.parent !== parent) parent.appendChild(clone);

    clone.name = `${source.name} / ${bp.label}`;
    clone.y = baseY;

    // Clear min/max width constraints inherited from library components so the
    // clone can resize freely to the target breakpoint width. Opt-out via
    // settings.clearWidthConstraints = false when the user wants the library
    // component's own min-width to bound the clone (e.g. a card that should
    // never go below 320px even on a 200px breakpoint).
    if (settings.clearWidthConstraints === true) {
      clearWidthConstraints(clone);
    }

    // Variants are an additive overlay: each bp ships variantSets =
    // [{ componentSetId, props }] for every enabled set. The PRIMARY set
    // (primaryVariantSetId, only sent under the variant driver) keeps its old
    // role — when this bp has primary picks, the swapped variant's intrinsic
    // size drives the frame and the width/mode/resize path is skipped.
    // Everything else applies AFTER sizing so auto-layout reflows the swapped
    // children inside the final width.
    const primaryId = primaryVariantSetId || variantTargetId || null;
    let entries = Array.isArray(bp.variantSets) ? bp.variantSets : null;
    if (!entries && primaryId && bp.variantProps && Object.keys(bp.variantProps).length) {
      // Legacy payload shape — a flat props object for the single target.
      entries = [{ componentSetId: primaryId, props: bp.variantProps }];
    }
    entries = (entries || []).filter(e => e && e.componentSetId && e.props && Object.keys(e.props).length);
    const primaryEntry = primaryId ? entries.find(e => e.componentSetId === primaryId) : null;
    const secondary = entries.filter(e => e !== primaryEntry);

    if (primaryEntry) {
      await applyVariantSets(clone, [primaryEntry]);
    } else {
      const modeLinked = bp.modeId && (bp.modeCollectionKey || bp.modeCollectionId);
      let appliedViaMode = false;
      if (modeLinked) {
        const collection = await resolveCollectionByKeyOrId(bp.modeCollectionId, bp.modeCollectionKey);
        if (collection && clone.setExplicitVariableModeForCollection) {
          try {
            clone.setExplicitVariableModeForCollection(collection, bp.modeId);
            appliedViaMode = true;
            // Intentionally do NOT touch the clone's auto-layout or children —
            // the source's bound width variable drives the resize, and the source's
            // existing layout handles reflow.
          } catch (err) {}
        }
      }

      if (!appliedViaMode) {
        if (clone.type === 'FRAME') {
          applyAutoLayoutWidth(clone, bp.width);
        } else {
          clone.resize(bp.width, clone.height);
        }
      }
    }

    // Secondary sets switch after sizing and before actualWidth is read, so
    // label spacing reflects the post-swap layout.
    if (secondary.length) await applyVariantSets(clone, secondary);

    const actualWidth = clone.width || bp.width;
    clone.x = cursor;

    // Build a single label node (component instance, or a text chip).
    let labelNode = null;
    if (settings.addLabels) {
      if (labelMain) {
        try {
          const inst = labelMain.createInstance();
          parent.appendChild(inst);
          // Apply the chosen variant BEFORE writing the text — the text layer
          // may differ per variant. Without this the label lands on the set's
          // default variant regardless of what the user picked.
          const vProps = settings.labelComponentVariantProps;
          if (vProps && Object.keys(vProps).length) {
            try { inst.setProperties(vProps); } catch (err) {}
          }
          await setInstanceLabelText(inst, labelTextProp, bp.label);
          labelNode = inst;
        } catch (err) { labelNode = null; }
      }
      if (!labelNode) {
        labelNode = makeLabelChip(bp.label, Math.round(actualWidth));
        parent.appendChild(labelNode);
      }
    }

    if (settings.addLabels && doGroup && labelNode) {
      // Vertical auto-layout group: label on top, frame below.
      const group = figma.createFrame();
      group.name = `${source.name} / ${bp.label}`;
      group.layoutMode = 'VERTICAL';
      group.primaryAxisSizingMode = 'AUTO';
      group.counterAxisSizingMode = 'AUTO';
      group.counterAxisAlignItems = 'MIN';
      group.itemSpacing = 8;
      group.fills = [];
      group.clipsContent = false;
      parent.appendChild(group);
      group.appendChild(labelNode);
      group.appendChild(clone);
      // Keep the frame itself at baseY (group top sits above it by label height).
      group.x = cursor;
      group.y = baseY - (group.height - clone.height);
      generated.push(group);
      cloneNodes.push(group);
      cursor += group.width + GAP;
    } else {
      if (labelNode) {
        labelNode.x = cursor;
        labelNode.y = baseY - labelNode.height - 8;
        generated.push(labelNode);
      }
      generated.push(clone);
      cloneNodes.push(clone);
      cursor += actualWidth + GAP;
    }
  }

  // Optionally wrap everything in light + dark auto-layout frames.
  if (wrapInFrames) {
    const frames = await wrapInLightDarkFrames(generated, source, settings, GAP);
    if (frames && frames.light) {
      const sel = frames.dark ? [frames.light, frames.dark] : [frames.light];
      figma.currentPage.selection = sel;
      figma.viewport.scrollAndZoomIntoView(sel);
      return resolved.length;
    }
  }

  // Select only the cloned frames (not labels — text or component instances)
  figma.currentPage.selection = cloneNodes;
  figma.viewport.scrollAndZoomIntoView(generated);

  return resolved.length;
}

// ─── Light/dark sections (PR B) ───────────────────────────────────────────────

function appearanceConfigured(settings) {
  return !!(settings &&
    settings.lightModeId && settings.darkModeId &&
    (settings.appearanceCollectionId || settings.appearanceCollectionKey));
}

// Wrap the generated per-breakpoint nodes in a "— Light" horizontal auto-layout
// frame with the light appearance mode applied, then clone it into a "— Dark"
// frame below with the dark mode. Auto-layout positions the children, so there
// is no manual coordinate maths (unlike Sections). Returns { light, dark } or
// null when not configured / failed.
async function wrapInLightDarkFrames(generated, source, settings, GAP) {
  if (!generated.length) return null;
  const collection = await resolveCollectionByKeyOrId(
    settings.appearanceCollectionId, settings.appearanceCollectionKey);
  if (!collection) return null;

  const page = figma.currentPage;
  const PAD = 80;

  // Anchor the light frame just below the source (absolute page coords).
  const st = source.absoluteTransform;
  const anchorX = st[0][2];
  const anchorY = st[1][2] + source.height + GAP * 2;

  const light = figma.createFrame();
  light.name = `${source.name} — Light`;
  light.layoutMode = 'HORIZONTAL';
  light.primaryAxisSizingMode = 'AUTO';
  light.counterAxisSizingMode = 'AUTO';
  light.counterAxisAlignItems = 'MIN'; // top-align the breakpoint columns
  light.itemSpacing = GAP;
  light.paddingLeft = light.paddingRight = light.paddingTop = light.paddingBottom = PAD;
  light.clipsContent = false;
  page.appendChild(light);
  light.x = anchorX;
  light.y = anchorY;

  // Auto-layout arranges the children left-to-right; no per-child positioning.
  for (const n of generated) {
    try { light.appendChild(n); } catch (err) {}
  }

  try {
    if (light.setExplicitVariableModeForCollection) {
      light.setExplicitVariableModeForCollection(collection, settings.lightModeId);
    }
  } catch (err) {}

  // Apply the chosen background BEFORE cloning so the dark frame inherits it.
  // A bound colour variable resolves per the frame's mode, so the dark clone
  // automatically shows the dark surface value.
  await applyFrameBackground(light, settings);

  // Dark clone, stacked directly below the light frame.
  let dark = null;
  try {
    dark = light.clone();
    dark.name = `${source.name} — Dark`;
    dark.x = light.x;
    dark.y = light.y + light.height + GAP;
    if (dark.setExplicitVariableModeForCollection) {
      dark.setExplicitVariableModeForCollection(collection, settings.darkModeId);
    }
  } catch (err) {}

  return { light: light, dark: dark };
}

// Apply the configured background to a wrapper frame: transparent (no fill) or
// a bound COLOR variable (flips with the mode). 'default' is treated as
// transparent for frames (a frame's own white fill would not flip with mode).
async function applyFrameBackground(frame, settings) {
  const mode = settings.sectionBgMode || 'default';
  if (mode === 'variable') {
    try {
      let variable = null;
      if (settings.sectionBgVariableId) {
        try { variable = await figma.variables.getVariableByIdAsync(settings.sectionBgVariableId); } catch (err) {}
      }
      if (!variable && settings.sectionBgVariableKey) {
        try { variable = await figma.variables.importVariableByKeyAsync(settings.sectionBgVariableKey); } catch (err) {}
      }
      if (variable) {
        const paint = { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 };
        const bound = figma.variables.setBoundVariableForPaint(paint, 'color', variable);
        frame.fills = [bound];
        return;
      }
    } catch (err) {}
  }
  // default + transparent → no fill.
  try { frame.fills = []; } catch (err) {}
}

// ─── Variant helper ───────────────────────────────────────────────────────────

// Walk a clone ONCE and switch every INSTANCE whose main component belongs to
// one of the given sets. entries: [{ componentSetId, props }]. A single
// subtree walk with a Map lookup keeps N enabled sets at one-walk cost. Each
// setProperties is independently guarded so one failure doesn't block the
// rest. (An instance's main component has exactly one parent set, so at most
// one entry can match any given instance.)
async function applyVariantSets(node, entries) {
  const bySet = new Map();
  for (const e of entries || []) {
    if (e && e.componentSetId && e.props && Object.keys(e.props).length) bySet.set(e.componentSetId, e.props);
  }
  if (!bySet.size) return;

  const targets = [];
  if (node.type === 'INSTANCE') targets.push(node);
  if ('findAll' in node) {
    try {
      const nested = node.findAll(n => n.type === 'INSTANCE');
      for (const n of nested) targets.push(n);
    } catch (err) {}
  }

  for (const inst of targets) {
    try {
      const main = await inst.getMainComponentAsync();
      if (!main || !main.parent) continue;
      const props = bySet.get(main.parent.id);
      if (!props) continue;

      // Swapping the variant gives the instance the NEW variant's intrinsic
      // width — a full-width header switched to a wider variant then overflows
      // its frame. Capture how the instance was sized BEFORE the swap and
      // restore the intent afterwards: instances that filled their parent, or
      // whose width covered/exceeded it (a fixed-width bar cloned into a
      // narrower frame), get pinned back to the parent's width; anything
      // narrower (buttons, chips) keeps the new variant's own size. The
      // generated root itself is exempt — its sizing belongs to the
      // width/variant driver logic.
      const isRoot = inst === node;
      const parent = inst.parent;
      const parentAuto = !isRoot && parent && 'layoutMode' in parent && parent.layoutMode && parent.layoutMode !== 'NONE';
      let wasFill = false;
      let coveredParent = false;
      let innerWidth = null;
      if (!isRoot && parent && 'width' in parent) {
        try {
          if (parentAuto) wasFill = inst.layoutSizingHorizontal === 'FILL';
        } catch (err) {}
        try {
          innerWidth = parent.width - ((parent.paddingLeft || 0) + (parent.paddingRight || 0));
          coveredParent = inst.width >= innerWidth - 1;
        } catch (err) {}
      }

      inst.setProperties(props);

      try {
        if (parentAuto && (wasFill || coveredParent)) {
          inst.layoutSizingHorizontal = 'FILL';
        } else if (!isRoot && !parentAuto && coveredParent && innerWidth) {
          inst.resize(innerWidth, inst.height);
        }
      } catch (err) {}
    } catch (err) {}
  }
}

// ─── Auto-layout helper ───────────────────────────────────────────────────────

// Set up vertical auto-layout and make children FILL the horizontal axis.
// Used both on its own (for mode-linked clones, where width is driven by a
// variable binding) and as a prelude to a resize.
function ensureAutoLayoutStructure(frame) {
  if (frame.layoutMode === 'NONE') {
    frame.layoutMode = 'VERTICAL';
    frame.primaryAxisSizingMode = 'AUTO';
    frame.counterAxisSizingMode = 'FIXED';
    frame.itemSpacing = 0;
  }

  for (const child of frame.children) {
    try {
      if ('layoutSizingHorizontal' in child) {
        child.layoutSizingHorizontal = 'FILL';
      }
    } catch (err) {
      // Some child types don't support layoutSizing — skip silently
    }
  }
}

// Clear min/max width constraints on a node and all descendants. Library
// components often have minWidth set per variant, which prevents the clone
// from resizing below that threshold. Clearing them lets the layout respond
// freely to the new breakpoint width. Iterative BFS with the same node budget
// as the other subtree walks, so a huge component can't freeze Figma.
function clearWidthConstraints(root) {
  const queue = [root];
  let visited = 0;
  while (queue.length && visited < MAX_DETECT_NODES) {
    const node = queue.shift();
    visited++;
    try {
      if ('minWidth' in node && node.minWidth !== null) node.minWidth = null;
      if ('maxWidth' in node && node.maxWidth !== null) node.maxWidth = null;
    } catch (err) {}
    if ('children' in node) {
      for (const child of node.children) queue.push(child);
    }
  }
}

function applyAutoLayoutWidth(frame, targetWidth) {
  ensureAutoLayoutStructure(frame);
  frame.resize(targetWidth, frame.height);
}

// Resolve a VariableCollection from a local id and/or a library key. Library
// collections are reached by importing one of their variables (same trick the
// breakpoint mode flow uses).
async function resolveCollectionByKeyOrId(collectionId, collectionKey) {
  if (collectionId) {
    try {
      const col = await figma.variables.getVariableCollectionByIdAsync(collectionId);
      if (col) return col;
    } catch (err) { /* fall through */ }
  }
  if (collectionKey) {
    try {
      const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collectionKey);
      if (libVars && libVars.length) {
        const imported = await figma.variables.importVariableByKeyAsync(libVars[0].key);
        if (imported) {
          return await figma.variables.getVariableCollectionByIdAsync(imported.variableCollectionId);
        }
      }
    } catch (err) { /* fall through */ }
  }
  return null;
}

// ─── Label helper ─────────────────────────────────────────────────────────────

// A single label node: a horizontal auto-layout chip holding the breakpoint
// name and its width. One node (vs two loose text nodes) so it can be dropped
// into an auto-layout group with its frame.
function makeLabelChip(name, width) {
  const chip = figma.createFrame();
  chip.name = 'Label';
  chip.layoutMode = 'HORIZONTAL';
  chip.primaryAxisSizingMode = 'AUTO';
  chip.counterAxisSizingMode = 'AUTO';
  chip.itemSpacing = 6;
  chip.fills = [];
  chip.clipsContent = false;

  const nameNode = figma.createText();
  nameNode.fontName = { family: 'Inter', style: 'Medium' };
  nameNode.fontSize = 11;
  nameNode.characters = name;
  nameNode.fills = [{ type: 'SOLID', color: { r: 0.55, g: 0.55, b: 0.55 } }];
  chip.appendChild(nameNode);

  const widthNode = figma.createText();
  widthNode.fontName = { family: 'Inter', style: 'Regular' };
  widthNode.fontSize = 11;
  widthNode.characters = `${width}px`;
  widthNode.fills = [{ type: 'SOLID', color: { r: 0.38, g: 0.38, b: 0.38 } }];
  chip.appendChild(widthNode);

  return chip;
}

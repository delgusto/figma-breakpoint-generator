// ─── Breakpoint Generator — code.js ──────────────────────────────────────────
// Runs in the Figma plugin sandbox. Communicates with ui.html via postMessage.

figma.showUI(__html__, { width: 360, height: 580, title: 'Breakpoint Generator' });

// Resolve a variable's value in its default mode, following alias chains (max 10 hops).
async function resolveVariableValue(variable) {
  var seen = new Set();
  var current = variable;
  for (var hop = 0; hop < 10; hop++) {
    if (seen.has(current.id)) return null; // circular
    seen.add(current.id);
    var col = await figma.variables.getVariableCollectionByIdAsync(current.variableCollectionId);
    if (!col) return null;
    var val = current.valuesByMode[col.defaultModeId];
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
  clearWidthConstraints: true, // Strip min/max width inherited from library components so the clone can resize freely. Turn off to preserve component constraints.
};

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const [savedBreakpoints, savedSettings, defaultBreakpoints, preferredLibrary, filterToLibrary, variantTargetId] = await Promise.all([
    figma.clientStorage.getAsync('breakpoints'),
    figma.clientStorage.getAsync('settings'),
    figma.clientStorage.getAsync('defaultBreakpoints'),
    figma.clientStorage.getAsync('preferredLibrary'),
    figma.clientStorage.getAsync('filterToLibrary'),
    figma.clientStorage.getAsync('variantTargetId'),
  ]);

  const breakpoints = savedBreakpoints || DEFAULT_BREAKPOINTS;
  const settings = savedSettings || DEFAULT_SETTINGS;

  // Read all FLOAT variables + multi-mode collections — both can be used as breakpoint links
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
    defaultBreakpoints: defaultBreakpoints || null,
    preferredLibrary: preferredLibrary || null,
    filterToLibrary: !!filterToLibrary,
    variantTargetId: variantTargetId || null,
  });
  sendSelection();
}

// ─── Variable / token helpers ─────────────────────────────────────────────────

async function getFloatVariables() {
  var allVars = [];
  var collections = [];

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

  var result = [];
  // Track keys of already-imported library vars to avoid duplicates in the library fetch below
  var importedKeys = new Set();

  for (var i = 0; i < allVars.length; i++) {
    var v = allVars[i];
    if (v.resolvedType !== 'FLOAT') continue;

    var resolvedVal = await resolveVariableValue(v);
    if (resolvedVal === null) continue;

    var col = null;
    for (var j = 0; j < collections.length; j++) {
      if (collections[j].id === v.variableCollectionId) { col = collections[j]; break; }
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
    var libCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (var k = 0; k < libCollections.length; k++) {
      var libCol = libCollections[k];
      try {
        var libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(libCol.key);
        for (var l = 0; l < libVars.length; l++) {
          var lv = libVars[l];
          if (lv.resolvedType !== 'FLOAT') continue;
          if (importedKeys.has(lv.key)) continue;
          // Import to read the actual value (idempotent — same as using a library token on a frame)
          var resolvedValue = null;
          try {
            var imported = await figma.variables.importVariableByKeyAsync(lv.key);
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

// Resolve a specific variable's value in a specific mode (not the default), following aliases.
async function resolveVariableValueInMode(variable, modeId) {
  var seen = new Set();
  var current = variable;
  for (var hop = 0; hop < 10; hop++) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    var val = current.valuesByMode[modeId];
    // If the mode doesn't exist on this variable, try the collection's default
    if (val === undefined) {
      var col = await figma.variables.getVariableCollectionByIdAsync(current.variableCollectionId);
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
        var modeValue = null;
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
          var modeValue = null;
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

async function resolveWidth(bp) {
  try {
    var variable = null;
    if (bp.variableId) {
      variable = await figma.variables.getVariableByIdAsync(bp.variableId);
    } else if (bp.variableKey) {
      variable = await figma.variables.importVariableByKeyAsync(bp.variableKey);
    }
    if (variable) {
      var val = await resolveVariableValue(variable);
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

function sendSelection() {
  const source = getSourceNode();
  const node = source ? figma.getNodeById(source.id) : null;
  const variantSchema = node ? detectVariantSchema(node) : null;
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

function buildSchemaForSet(set) {
  const defs = set.componentPropertyDefinitions || {};
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
  return {
    componentSetId: set.id,
    componentSetName: set.name,
    properties: properties,
  };
}

// Breadth-first walk so we can track depth. Figma's findAll doesn't give us
// depth, so we do it manually.
function collectInstancesWithDepth(root) {
  const results = [];
  const queue = [{ node: root, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift();
    if (node.type === 'INSTANCE') results.push({ inst: node, depth });
    if ('children' in node && node.children) {
      for (const child of node.children) queue.push({ node: child, depth: depth + 1 });
    }
  }
  return results;
}

function detectVariantSchema(node) {
  if (!node) return null;

  const found = collectInstancesWithDepth(node);
  if (!found.length) return null;

  // Group by component-set id, keeping the shallowest depth seen.
  const bySet = new Map();
  for (const { inst, depth } of found) {
    try {
      const main = inst.mainComponent;
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

figma.on('selectionchange', sendSelection);

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
      break;

    case 'save-variant-target':
      await figma.clientStorage.setAsync('variantTargetId', msg.variantTargetId || null);
      break;

    case 'reset-settings': {
      await Promise.all([
        figma.clientStorage.deleteAsync('breakpoints'),
        figma.clientStorage.deleteAsync('settings'),
      ]);
      // Library prefs + user defaults survive a reset.
      const [defaultBreakpoints, preferredLibrary, filterToLibrary, variableOptions, modeOptions] = await Promise.all([
        figma.clientStorage.getAsync('defaultBreakpoints'),
        figma.clientStorage.getAsync('preferredLibrary'),
        figma.clientStorage.getAsync('filterToLibrary'),
        getFloatVariables(),
        getVariableCollectionModes(),
      ]);
      figma.ui.postMessage({
        type: 'init',
        // Prefer user-saved defaults over factory defaults.
        breakpoints: defaultBreakpoints || DEFAULT_BREAKPOINTS,
        settings: DEFAULT_SETTINGS,
        variableOptions,
        modeOptions,
        defaultBreakpoints: defaultBreakpoints || null,
        preferredLibrary: preferredLibrary || null,
        filterToLibrary: !!filterToLibrary,
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
  }
};

// ─── Generate ─────────────────────────────────────────────────────────────────

async function generate({ sourceId, breakpoints, settings, variantTargetId }) {
  const source = figma.getNodeById(sourceId);
  if (!source) throw new Error('Source not found — re-select the frame and try again.');
  if (!['FRAME', 'INSTANCE', 'COMPONENT'].includes(source.type)) {
    throw new Error('Select a Frame, Component or Instance.');
  }

  const enabled = breakpoints.filter(bp => bp.enabled);
  if (enabled.length === 0) throw new Error('Enable at least one breakpoint.');

  const GAP = typeof settings.gap === 'number' ? settings.gap : 120;
  const LABEL_ABOVE = 28; // px above the clone's top edge

  // Pre-load fonts once if labels are needed
  if (settings.addLabels) {
    await Promise.all([
      figma.loadFontAsync({ family: 'Inter', style: 'Medium' }),
      figma.loadFontAsync({ family: 'Inter', style: 'Regular' }),
    ]);
  }

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

  // Clones are generated in the order the user has arranged them in the Settings
  // list — no auto-sort by width. Each clone is placed immediately to the right
  // of the previous one, using the *actual* post-layout width.
  let cursor = source.x + source.width + GAP;
  const generated = [];

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
    if (settings.clearWidthConstraints !== false) {
      clearWidthConstraints(clone);
    }

    // Either / or per breakpoint:
    //   variantProps set → swap component variant, leave width alone.
    //   otherwise         → apply width/mode logic as before.
    //
    // When variant mode is chosen, we intentionally skip resize because the
    // swapped variant is expected to carry its own width tokens (matching the
    // breakpoint). If the user wants both, they should set variantProps AND a
    // width — but by design this branch keeps the two axes orthogonal so
    // deeply-nested library components don't fight the outer resize.
    const hasVariant = variantTargetId && bp.variantProps && Object.keys(bp.variantProps).length;

    if (hasVariant) {
      applyVariantProps(clone, bp.variantProps, variantTargetId);
    } else {
      const modeLinked = bp.modeId && (bp.modeCollectionKey || bp.modeCollectionId);
      let appliedViaMode = false;
      if (modeLinked) {
        const collection = await resolveCollection(bp);
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

    const actualWidth = clone.width || bp.width;
    clone.x = cursor;

    if (settings.addLabels) {
      const label = makeLabel(bp.label, Math.round(actualWidth), cursor, baseY - LABEL_ABOVE);
      generated.push(...label);
    }

    generated.push(clone);
    cursor += actualWidth + GAP;
  }

  // Select only the cloned frames (not text labels)
  const clones = generated.filter(n => n.type !== 'TEXT');
  figma.currentPage.selection = clones;
  figma.viewport.scrollAndZoomIntoView(generated);

  return resolved.length;
}

// ─── Variant helper ───────────────────────────────────────────────────────────

// Walk a clone and call setProperties on every INSTANCE whose main component
// belongs to the detected component set. Each call is independently guarded so
// one failure doesn't block the rest.
function applyVariantProps(node, props, componentSetId) {
  const targets = [];
  if (node.type === 'INSTANCE') targets.push(node);
  if ('findAll' in node) {
    try {
      const nested = node.findAll(n => n.type === 'INSTANCE');
      for (var i = 0; i < nested.length; i++) targets.push(nested[i]);
    } catch (err) {}
  }

  for (var i = 0; i < targets.length; i++) {
    const inst = targets[i];
    try {
      const main = inst.mainComponent;
      if (!main || !main.parent || main.parent.id !== componentSetId) continue;
      inst.setProperties(props);
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

// Recursively clear min/max width constraints on a node and all descendants.
// Library components often have minWidth set per variant, which prevents the
// clone from resizing below that threshold. Clearing them lets the layout
// respond freely to the new breakpoint width.
function clearWidthConstraints(node) {
  try {
    if ('minWidth' in node && node.minWidth !== null) node.minWidth = null;
    if ('maxWidth' in node && node.maxWidth !== null) node.maxWidth = null;
  } catch (err) {}
  if ('children' in node) {
    for (var i = 0; i < node.children.length; i++) {
      clearWidthConstraints(node.children[i]);
    }
  }
}

function applyAutoLayoutWidth(frame, targetWidth) {
  ensureAutoLayoutStructure(frame);
  frame.resize(targetWidth, frame.height);
}

// Resolve the VariableCollection referenced by a mode-linked breakpoint.
// Tries the local id first, then imports the first variable of the library collection
// so Figma can surface the collection object via getVariableCollectionByIdAsync.
async function resolveCollection(bp) {
  if (bp.modeCollectionId) {
    try {
      const col = await figma.variables.getVariableCollectionByIdAsync(bp.modeCollectionId);
      if (col) return col;
    } catch (err) { /* fall through */ }
  }
  if (bp.modeCollectionKey) {
    try {
      const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(bp.modeCollectionKey);
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

function makeLabel(name, width, x, y) {
  const nameNode = figma.createText();
  nameNode.fontName = { family: 'Inter', style: 'Medium' };
  nameNode.fontSize = 11;
  nameNode.characters = name;
  nameNode.fills = [{ type: 'SOLID', color: { r: 0.55, g: 0.55, b: 0.55 } }];
  nameNode.x = x;
  nameNode.y = y;

  const widthNode = figma.createText();
  widthNode.fontName = { family: 'Inter', style: 'Regular' };
  widthNode.fontSize = 11;
  widthNode.characters = `${width}px`;
  widthNode.fills = [{ type: 'SOLID', color: { r: 0.38, g: 0.38, b: 0.38 } }];
  widthNode.x = x + nameNode.width + 6;
  widthNode.y = y;

  return [nameNode, widthNode];
}

// app.js (module)
// Sysex Librarian (client-only SPA) using IndexedDB

import { openDB } from './idb.js';
import { searchPatches } from './search.js';

const DB_NAME = 'sysex-librarian';
const DB_VERSION = 3;
const STORE_NAME = 'patches';
const MAX_BYTES = 16 * 1024; // 16 KiB

let dbPromise;

// Web MIDI state
let midiAccess = null;
const midiOutputs = new Map(); // id -> output
let selectedMidiOutputId = '';
let midiConfirmRequired = false;

async function initDB() {
  dbPromise = openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, newVersion, transaction) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'name' });
        store.createIndex('name', 'name', { unique: false });
        store.createIndex('manufacturer', 'manufacturer', { unique: false });
        store.createIndex('device', 'device', { unique: false });
        store.createIndex('author', 'author', { unique: false });
        store.createIndex('description', 'description', { unique: false });
        // tags as multiEntry to index each tag element individually
        store.createIndex('tags', 'tags', { unique: false, multiEntry: true });
      } else {
        // migration paths for existing DBs
        const store = transaction.objectStore(STORE_NAME);
        // add author index in earlier migration if missing
        if (oldVersion < 2) {
          if (!store.indexNames.contains('author')) {
            store.createIndex('author', 'author', { unique: false });
          }
        }
        // add description and tags indexes in this migration (v3)
        if (oldVersion < 3) {
          if (!store.indexNames.contains('description')) {
            store.createIndex('description', 'description', { unique: false });
          }
          if (!store.indexNames.contains('tags')) {
            store.createIndex('tags', 'tags', { unique: false, multiEntry: true });
          }
        }
      }
    }
  });
  return dbPromise;
}

async function addPatch(patch) {
  const db = await dbPromise;
  await db.put(STORE_NAME, patch);
}

async function deletePatch(name) {
  const db = await dbPromise;
  await db.delete(STORE_NAME, name);
}

async function clearAllPatches() {
  const db = await dbPromise;
  await db.clear(STORE_NAME);
}

async function countPatches() {
  const db = await dbPromise;
  return await db.count(STORE_NAME);
}

async function getAllPatches() {
  const db = await dbPromise;
  const all = await db.getAll(STORE_NAME);
  // sort ascending by name
  all.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return all;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\?%*:|"<>]/g, '-');
}

function parseTags(tagsString) {
  if (!tagsString) return [];
  return tagsString.split(',').map(t => t.trim()).filter(t => t.length > 0);
}

/* Validation rules:
   - name, device, manufacturer, author: max 25 chars
   - description: max 1000 chars
   - tags: each tag max 25 chars
*/
function validatePatchFields({ name, device, manufacturer, author, description, tags }) {
  if (name && name.length > 25) return 'Patch name must be at most 25 characters';
  if (!device) return 'Device name is required';
  if (device.length > 25) return 'Device must be at most 25 characters';
  if (manufacturer && manufacturer.length > 25) return 'Manufacturer must be at most 25 characters';
  if (author && author.length > 25) return 'Author must be at most 25 characters';
  if (description && description.length > 1000) return 'Description must be at most 1000 characters';
  if (tags && Array.isArray(tags)) {
    for (const t of tags) {
      if (t.length > 25) return `Tag "${t}" must be at most 25 characters`;
    }
  }
  return null;
}

function notification(type, msg) {
  return UIkit.notification({
      message: `<div class="uk-card uk-card-small uk-card-default uk-alert-${type}" uk-alert>${msg}</div>`,
      status: type,
  });
}

async function handleUpload(event) {
  event.preventDefault();
  const patchNameInput = document.getElementById('patchName');
  const manufacturerInput = document.getElementById('manufacturer');
  const deviceInput = document.getElementById('device');
  const filesInput = document.getElementById('files');
  const authorInput = document.getElementById('author');
  const descriptionInput = document.getElementById('description');
  const tagsInput = document.getElementById('tags');

  const providedName = patchNameInput.value.trim();
  const manufacturer = manufacturerInput.value.trim();
  const device = deviceInput.value.trim();
  const author = authorInput.value.trim();
  const description = descriptionInput.value.trim();
  const tags = parseTags(tagsInput.value);

  // Validate top-level fields that are independent of files
  const validationError = validatePatchFields({ name: providedName, device, manufacturer, author, description, tags });
  if (validationError) {
    notification('danger', validationError);
    return;
  }

  const files = Array.from(filesInput.files || []);
  if (files.length === 0) {
    notification('danger', 'Please select at least one .syx file');
    return;
  }

  const multipleFiles = files.length > 1;
  const operations = [];

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.syx')) {
      notification('warning', `${file.name}: skipped (not .syx)`);
      continue;
    }

    if (file.size > MAX_BYTES) {
      notification('warning', `${file.name}: skipped (exceeds ${MAX_BYTES} bytes)`);
      continue;
    }

    const filenameNoExt = file.name.replace(/\.syx$/i, '');
    const fallbackName = filenameNoExt.replace(/_/g, ' ');
    const name = (multipleFiles || !providedName) ? fallbackName.trim() : providedName;

    // Validate name per-file (fallback name length)
    const perFileValidation = validatePatchFields({ name, device, manufacturer, author, description, tags });
    if (perFileValidation) {
      notification('warning', `${file.name}: ${perFileValidation}`);
      continue;
    }

    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);

    const patch = {
      name,
      manufacturer,
      device,
      filename: file.name,
      data: base64,
      author,
      description,
      tags,
      mtime: new Date()
    };

    operations.push(addPatch(patch));
  }

  if (operations.length === 0) {
    notification('warning', 'No valid files were uploaded');
    return;
  }

  await Promise.all(operations);
  notification('warning', `Saved ${operations.length} patch(es)`);

  // Clear files input (leave other fields so user can upload more)
  filesInput.value = '';
  // refresh list and update DB button states
  await renderPatches();
  await updateDbButtonsState();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"'`]/g, s => {
    return ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '`': '&#96;'
    })[s];
  });
}

function handleTagClicked(ev) {
  const filterInput = document.getElementById('filterInput');
  const cl = ev.target.classList;
  let prefix = "";

  if (cl.contains('patch-device')) {
    prefix = "d:";
  }
  else if (cl.contains('patch-manufacturer')) {
    prefix = "m:";
  }
  else if (cl.contains('patch-tag')) {
    prefix = "t:";
  }
  else if (cl.contains('patch-author')) {
    prefix = "a:";
  }

  if (filterInput) {
    filterInput.value = `${prefix}"${ev.target.textContent}"`;
    setTimeout(() => {
      renderPatches(filterInput.value);
    }, 50);
  }
}

async function handleExportPatchSysEx(ev) {
  ev.preventDefault();
  let card = ev.target.closest('.patch-card');

  if (!card)
    return;

  if (card.dataset.patchName) {
    const db = await dbPromise;
    const patch = await db.get(STORE_NAME, card.dataset.patchName);

    const arr = base64ToUint8Array(patch.data);
    sendBlob(sanitizeFilename(patch.name) + '.syx', arr, 'application/octet-stream');
  }
}

async function handleExportPatchJson(ev) {
  ev.preventDefault();
  let card = ev.target.closest('.patch-card');

  if (!card)
    return;

  if (card.dataset.patchName) {
    const db = await dbPromise;
    const patch = await db.get(STORE_NAME, card.dataset.patchName);

    const json = JSON.stringify(patch, null, 2);
    sendBlob(sanitizeFilename(patch.name) + '.json', json, 'application/json');
  }
}

async function handleEditPatch(ev) {
  ev.preventDefault();
  let card = ev.target.closest('.patch-card');

  if (!card)
    return;

  if (card.dataset.patchName) {
    const db = await dbPromise;
    const patch = await db.get(STORE_NAME, card.dataset.patchName);
    // open edit modal and populate with patch data
    openEditModal(patch);
  }
}

async function handleDeletePatch(ev) {
  ev.preventDefault();
  let card = ev.target.closest('.patch-card');

  if (!card)
    return;

  const name = card.dataset.patchName;

  if (name) {
    UIkit.modal.confirm(`Delete patch "${name}"?`).then(
      async () => {
        await deletePatch(name);
        notification('success', `Deleted patch "${name}"`);
        await renderPatches();
        await updateDbButtonsState();
      },
      (err) => {}
    );
  }
}

function fillTagsContainer(container, tags) {
  container.innerHTML = '';
  if (!tags || !Array.isArray(tags) || tags.length === 0) return;
  tags.forEach(tag => {
    const span = document.createElement('span');
    span.classList.add('patch-tag');
    span.classList.add('uk-label');
    span.textContent = tag;
    span.addEventListener('click', handleTagClicked);
    container.appendChild(span);
  });
}

/**
 * Create a patch card using the template defined in index.html.
 * Fills name, author (prefixed with 'by '), manufacturer, device, description, tags and mtime tooltip.
 * Attaches event handlers to buttons (download syx/json, edit modal, delete).
 * Adds class 'patch-card' to the template root element (no extra wrapper).
 * Also attaches click handler on patch-image that sends the patch via WebMIDI.
 */
function createPatchCard(patch) {
  const tmpl = document.getElementById('patch-card-template');
  const fragment = document.importNode(tmpl.content, true);
  // the root card element inside template
  const cardEl = fragment.querySelector('.uk-card');

  if (!cardEl)
    return null;

  // add patch-card styling class
  cardEl.classList.add('patch-card');
  cardEl.dataset.patchName = patch.name;

  // fill fields
  const elName = cardEl.querySelector('.patch-name');
  const elAuthor = cardEl.querySelector('.patch-author');
  const elManufacturer = cardEl.querySelector('.patch-manufacturer');
  const elDevice = cardEl.querySelector('.patch-device');
  const elDescription = cardEl.querySelector('.patch-description');
  const elTags = cardEl.querySelector('.patch-tags');
  const elMtime = cardEl.querySelector('.patch-mtime');

  if (elName) elName.textContent = patch.name || '';
  if (elAuthor) elAuthor.textContent = patch.author || '';
  if (elManufacturer) elManufacturer.textContent = patch.manufacturer || '-';
  if (elDevice) elDevice.textContent = patch.device || '-';
  if (elDescription) elDescription.textContent = patch.description || '';

  fillTagsContainer(elTags, patch.tags || []);

  // set mtime tooltip
  try {
    const mtimeDate = patch.mtime ? new Date(patch.mtime) : null;
    const tooltipText = mtimeDate ? `title: Last modified:<br>${mtimeDate.toLocaleString()}` : '';
    if (elMtime) {
      elMtime.setAttribute('uk-tooltip', tooltipText);
    }
  } catch (e) {
    // ignore tooltip issues
  }

  // Attach event listeners to image and buttons
  cardEl.querySelector('.patch-image')?.addEventListener('click', handleSendPatch);
  cardEl.querySelector('.patch-download-syx')?.addEventListener('click', handleExportPatchSysEx);
  cardEl.querySelector('.patch-download-json')?.addEventListener('click', handleExportPatchJson);
  cardEl.querySelector('.patch-edit')?.addEventListener('click', handleEditPatch);
  cardEl.querySelector('.patch-delete')?.addEventListener('click', handleDeletePatch);
  cardEl.querySelector('.patch-device')?.addEventListener('click', handleTagClicked);
  cardEl.querySelector('.patch-manufacturer')?.addEventListener('click', handleTagClicked);
  elAuthor?.addEventListener('click', handleTagClicked);

  return cardEl;
}

/* Returns the list of patches filtered by filterText (if provided) */
async function getFilteredPatches(filterText = '') {
  // Use the search module which accepts dbPromise, store name, query and mapping
  // The module iterates using a cursor and returns matching patches
  const fieldMap = {
    name: 'name',
    manufacturer: 'manufacturer',
    device: 'device',
    author: 'author',
    description: 'description',
    tags: 'tags'
  };
  return await searchPatches(dbPromise, STORE_NAME, filterText, fieldMap);
}

async function renderPatches(filterText = '') {
  const container = document.getElementById('patchGrid');
  container.innerHTML = '';
  const filtered = await getFilteredPatches(filterText);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'uk-text-muted uk-text-center uk-padding-small';
    empty.textContent = 'No patches stored yet.';
    container.appendChild(empty);
  } else {
    for (const patch of filtered) {
      const card = createPatchCard(patch);
      if (card) container.appendChild(card);
    }
  }

  // Re-init UIkit tooltip / components for newly added elements
  if (window.UIkit) {
    UIkit.update(container);
  }
}

/* Edit modal behavior */
let currentEditOriginalName = null;

function openEditModal(patch) {
  currentEditOriginalName = patch.name;
  document.getElementById('editName').value = patch.name || '';
  document.getElementById('editAuthor').value = patch.author || '';
  document.getElementById('editManufacturer').value = patch.manufacturer || '';
  document.getElementById('editDevice').value = patch.device || '';
  document.getElementById('editDescription').value = patch.description || '';
  document.getElementById('editTags').value = (Array.isArray(patch.tags) ? patch.tags.join(', ') : '');

  const modal = UIkit.modal('#edit-modal');
  modal.show();
}

async function handleEditSubmit(ev) {
  ev.preventDefault();
  const name = document.getElementById('editName').value.trim();
  const author = document.getElementById('editAuthor').value.trim();
  const manufacturer = document.getElementById('editManufacturer').value.trim();
  const device = document.getElementById('editDevice').value.trim();
  const description = document.getElementById('editDescription').value.trim();
  const tags = parseTags(document.getElementById('editTags').value);

  const validationError = validatePatchFields({ name, device, manufacturer, author, description, tags });
  if (validationError) {
    notification('danger', validationError);
    return;
  }

  // load the original patch to retain data and filename/data
  const db = await dbPromise;
  const original = await db.get(STORE_NAME, currentEditOriginalName);
  if (!original) {
    notification('danger', 'Original patch not found');
    UIkit.modal('#edit-modal').hide();
    return;
  }

  const updated = {
    name,
    manufacturer,
    device,
    filename: original.filename,
    data: original.data,
    author,
    description,
    tags,
    mtime: new Date()
  };

  await addPatch(updated);
  // if name changed and different from original, delete original key
  if (name !== currentEditOriginalName) {
    await deletePatch(currentEditOriginalName);
  }

  notification('success', 'Patch updated');
  UIkit.modal('#edit-modal').hide();
  await renderPatches();
  await updateDbButtonsState();
}

/* Export/import/clear functions */
function serializePatches(patches) {
  return patches.map(p => ({
    ...p,
    mtime: p.mtime ? new Date(p.mtime).toISOString() : null
  }));
}

function sendBlob(filename, content, content_type) {
  const blob = new Blob([content], { type: content_type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function doExportPatches(filteredOnly = false) {
  const filterValue = document.getElementById('filterInput').value;
  let patches;
  if (filteredOnly) {
    patches = await getFilteredPatches(filterValue);
  } else {
    patches = await getAllPatches();
  }
  const payload = {
    exported_at: new Date().toISOString(),
    count: patches.length,
    patches: serializePatches(patches)
  };
  const filename = `patches-${new Date().toISOString().slice(0,19).replace(/[:T]/g, '-')}.json`;
  sendBlob(filename, JSON.stringify(payload, null, 2), 'application/json');
  notification('success', `Exported ${patches.length} patch(es)`);
}

/* Import patches */
let importBuffer = null;

function promptFileSelectForImport() {
  const input = document.getElementById('importFileInput');
  if (!input) return;
  input.value = '';
  input.click();
}

function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result);
        resolve(json);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function handleImportFileSelected(ev) {
  const file = ev.target.files && ev.target.files[0];

  if (!file)
    return;

  try {
    const parsed = await readJsonFile(file);
    // expect either an object with { patches: [...] } or a direct array
    let patches = [];

    if (Array.isArray(parsed)) {
      patches = parsed;
    } else if (parsed && Array.isArray(parsed.patches)) {
      patches = parsed.patches;
    } else {
      notification('danger', 'Invalid import file format');
      return;
    }

    importBuffer = patches.map(p => ({
      ...p,
      mtime: p.mtime ? new Date(p.mtime).toISOString() : null
    }));

    // Check if DB currently empty -> import all without asking
    const total = await countPatches();
    if (total === 0) {
      await doImportPatchesOverwrite();
      return;
    }

    // show import choice modal
    UIkit.modal('#import-choice-modal').show();
  } catch (err) {
    console.error(err);
    notification('danger', 'Failed to read import file');
  }
}

async function doImportPatchesOverwrite() {
  if (!importBuffer) {
    notification('warning', 'No import data');
    return;
  }

  let count = 0;
  for (const p of importBuffer) {
    const patch = {
      ...p,
      mtime: p.mtime ? new Date(p.mtime) : null
    };
    await addPatch(patch);
    count++;
  }

  UIkit.modal('#import-choice-modal').hide();
  notification('success', `Imported ${count} patches (overwriting existing)`);
  importBuffer = null;
  await renderPatches();
  await updateDbButtonsState();
}

async function doImportPatchesIfNewer() {
  if (!importBuffer) {
    notification('warning', 'No import data');
    return;
  }

  const db = await dbPromise;
  let written = 0;

  for (const p of importBuffer) {
    const name = p.name;
    if (!name) continue;
    const existing = await db.get(STORE_NAME, name);
    const importedMtime = p.mtime ? new Date(p.mtime).getTime() : null;
    const existingMtime = existing && existing.mtime ? new Date(existing.mtime).getTime() : null;

    if (!existing || (importedMtime && (!existingMtime || importedMtime > existingMtime))) {
      const patch = {
        ...p,
        mtime: p.mtime ? new Date(p.mtime) : null
      };
      await addPatch(patch);
      written++;
    }
  }

  UIkit.modal('#import-choice-modal').hide();
  notification('success', `Imported ${written} patch(es) (only newer)`);
  importBuffer = null;
  await renderPatches();
  await updateDbButtonsState();
}

/* Clear all patches with confirmation */
async function doClearAllPatchesConfirmed() {
  await clearAllPatches();
  UIkit.modal('#clear-confirm-modal').hide();
  notification('success', 'All patches cleared');
  await renderPatches();
  await updateDbButtonsState();
}

/* Wire up DB export/import/clear buttons and modals */
function setupDbButtons() {
  const exportBtn = document.getElementById('exportPatches');
  const importBtn = document.getElementById('importPatches');
  const clearBtn = document.getElementById('clearPatches');
  const importFileInput = document.getElementById('importFileInput');

  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const filterValue = document.getElementById('filterInput').value;
      if (filterValue && filterValue.trim().length > 0) {
        // ask whether to export all or filtered
        UIkit.modal('#export-choice-modal').show();
      } else {
        // export all
        await doExportPatches(false);
      }
    });
  }

  const exportAllBtn = document.getElementById('exportAllBtn');
  const exportFilteredBtn = document.getElementById('exportFilteredBtn');
  if (exportAllBtn) {
    exportAllBtn.addEventListener('click', async () => {
      await doExportPatches(false);
      UIkit.modal('#export-choice-modal').hide();
    });
  }
  if (exportFilteredBtn) {
    exportFilteredBtn.addEventListener('click', async () => {
      await doExportPatches(true);
      UIkit.modal('#export-choice-modal').hide();
    });
  }

  if (importBtn && importFileInput) {
    importBtn.addEventListener('click', () => {
      promptFileSelectForImport();
    });
    importFileInput.addEventListener('change', handleImportFileSelected);
  }

  const importOverwriteBtn = document.getElementById('importOverwriteBtn');
  const importNewerBtn = document.getElementById('importNewerBtn');
  if (importOverwriteBtn) {
    importOverwriteBtn.addEventListener('click', async () => {
      await doImportPatchesOverwrite();
    });
  }
  if (importNewerBtn) {
    importNewerBtn.addEventListener('click', async () => {
      await doImportPatchesIfNewer();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      UIkit.modal('#clear-confirm-modal').show();
    });
  }
  const confirmClearBtn = document.getElementById('confirmClearBtn');
  if (confirmClearBtn) {
    confirmClearBtn.addEventListener('click', async () => {
      await doClearAllPatchesConfirmed();
    });
  }
}

/* Update Export / Clear button disabled state depending on whether DB has patches */
async function updateDbButtonsState() {
  const total = await countPatches();
  const clearBtn = document.getElementById('clearPatches');
  const exportBtn = document.getElementById('exportPatches');
  if (clearBtn) {
    if (total === 0) clearBtn.setAttribute('disabled', 'disabled');
    else clearBtn.removeAttribute('disabled');
  }
  if (exportBtn) {
    if (total === 0) exportBtn.setAttribute('disabled', 'disabled');
    else exportBtn.removeAttribute('disabled');
  }
}

/* Web MIDI initialization and UI wiring */
async function initWebMIDI() {
  if (!navigator.requestMIDIAccess) {
    // no WebMIDI support
    notification('warning', 'Web MIDI not supported in this browser');
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: true });
    selectedMidiOutputId = window.localStorage?.getItem("midiOutputId") || '';
    populateMidiOutputs();
    midiAccess.onstatechange = () => {
      populateMidiOutputs();
    };
  } catch (err) {
    let msg = 'MIDI access denied or unavailable';
    console.warn(msg, err);
    notification('warning', msg);
  }
}

function populateMidiOutputs() {
  midiOutputs.clear();
  const select = document.getElementById('midiOutputSelect');
  if (!select) return;
  // clear options
  select.innerHTML = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '(no device selected)';
  select.appendChild(noneOpt);

  if (!midiAccess) return;

  for (const output of midiAccess.outputs.values()) {
    midiOutputs.set(output.id, output);
    const opt = document.createElement('option');
    opt.value = output.id;
    opt.textContent = output.name || output.manufacturer || output.id;
    select.appendChild(opt);
  }

  // restore previously selected id if present
  if (selectedMidiOutputId && midiOutputs.has(selectedMidiOutputId)) {
    select.value = selectedMidiOutputId;
  } else {
    selectedMidiOutputId = '';
    select.value = '';
  }
}

/* Hook up MIDI UI events */
function setupMidiUI() {
  const select = document.getElementById('midiOutputSelect');
  if (select) {
    select.addEventListener('change', (ev) => {
      selectedMidiOutputId = select.value;
      window.localStorage?.setItem("midiOutputId", selectedMidiOutputId);
    });
  }
  const chk = document.getElementById('midiConfirmCheckbox');
  if (chk) {
    chk.addEventListener('change', (ev) => {
      midiConfirmRequired = chk.checked;
    });
    midiConfirmRequired = chk.checked;
  }
}

/* Send patch via selected MIDI output.
   If confirm required, prompt the user; otherwise send directly.
*/
function sendPatch(patch, output) {
  try {
    const bytes = base64ToUint8Array(patch.data);
    // WebMIDI .send accepts an array or Uint8Array
    output.send(Array.from(bytes));
    notification('success', `Sent ${bytes.length} bytes to ${output.name || output.id}`);
  } catch (err) {
    console.error('MIDI send failed', err);
    notification('danger', 'Failed to send patch via MIDI');
  }
}

async function handleSendPatch(ev) {
  ev.preventDefault();
  let card = ev.target.closest('.patch-card');

  if (!card)
    return;

  if (card.dataset.patchName) {
    const db = await dbPromise;
    const patch = await db.get(STORE_NAME, card.dataset.patchName);

    if (!patch || !patch.data) {
      notification('warning', 'No patch data to send');
      return;
    }
    if (!midiAccess) {
      notification('warning', 'MIDI not initialized');
      return;
    }
    if (!selectedMidiOutputId) {
      notification('warning', 'No MIDI output selected');
      return;
    }
    const output = midiOutputs.get(selectedMidiOutputId);
    if (!output) {
      notification('warning', 'Selected MIDI output not found');
      return;
    }

    if (midiConfirmRequired) {
      UIkit.modal.confirm(`Send patch "${patch.name}" to MIDI device "${output.name || output.id}"?`).then(
        () => {
          sendPatch(patch, output);
        },
        (err) => {}
        );
    } else {
      sendPatch(patch, output);
    }
  }
}

/* Initialization and main */
function setupFilter() {
  const input = document.getElementById('filterInput');
  const form = document.getElementById('filterForm');

  if (!input) return;
  let timeout = null;

  input.addEventListener('input', (ev) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      renderPatches(input.value);
    }, 200);
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });

  const clear = document.getElementById('filterClear');
  if (clear) {
    clear.addEventListener('click', (ev) => {
      ev.preventDefault();
      input.value = '';
      renderPatches();
    });
  }
}

function setupDbAndImportUI() {
  setupDbButtons();
  const importFileInput = document.getElementById('importFileInput');
  if (importFileInput) {
    importFileInput.addEventListener('change', handleImportFileSelected);
  }
}

/* start app */
async function main() {
  await initDB();

  // wire up form
  const uploadForm = document.getElementById('uploadForm');
  if (uploadForm) uploadForm.addEventListener('submit', handleUpload);

  // edit modal submit handler
  const editForm = document.getElementById('editForm');
  if (editForm) editForm.addEventListener('submit', handleEditSubmit);

  // filter/search
  setupFilter();

  // DB import/export/clear
  setupDbAndImportUI();

  // Web MIDI init and UI
  initWebMIDI().then(() => {
    setupMidiUI();
  });

  // initial render and DB button state
  await renderPatches();
  await updateDbButtonsState();

  console.log('App fully loaded');
}

// start app on DOMContentLoaded
document.addEventListener("DOMContentLoaded", () => {
  main().catch(err => {
    console.error('App error', err);
    notification('danger', 'Application error (see console)');
  });
});

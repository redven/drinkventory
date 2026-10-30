/**
 * Drinkventory backend for Google Apps Script.
 *
 * The Apps Script project is bound to the Drinkventory Google Sheet and has two files:
 *   Code.gs   (this file)
 *   Logic.gs  (identical copy of docs/js/logic.js)
 *
 * First run: select setup() and click Run. Then deploy as web app:
 *   Execute as: Me    Who has access: Anyone
 *
 * Updates: replace BOTH Code.gs and Logic.gs, then Deploy > Manage deployments >
 * Edit > New version. CODE_VERSION must equal VERSION in Logic.gs; the app checks both.
 *
 * Keys (Project Settings > Script properties):
 *   API_KEY     used by the web app on both phones (read and write)
 *   SENSOR_KEY  used by climate sensors (can only add climate readings)
 */

var CODE_VERSION = '2.3.0';

var PHOTO_FOLDER_NAME = 'Drinkventory photos';
var MAX_OPS_PER_REQUEST = 50;
var MAX_PHOTO_BASE64 = 6 * 1024 * 1024;
var DATA_TABLES = ['products', 'bottles', 'events', 'ops', 'settings'];

var ALERT_DEFAULTS = {
  ALERT_TEMP_MIN: '8',
  ALERT_TEMP_MAX: '18',
  ALERT_RH_MIN: '50',
  ALERT_RH_MAX: '85',
  ALERT_STALE_MIN: '120'
};

// ======================================================================
// Setup and sheet menu
// ======================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Drinkventory')
    .addItem('Setup / show keys', 'menuSetup')
    .addSeparator()
    .addItem('New app key (both phones must update)', 'menuNewApiKey')
    .addItem('New sensor key', 'menuNewSensorKey')
    .addSeparator()
    .addItem('Install climate alerts (hourly check)', 'installClimateAlerts')
    .addItem('Remove climate alerts', 'removeClimateAlerts')
    .addItem('Check climate now', 'checkClimate')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this script from the Sheet: Extensions > Apps Script.');
  Object.keys(DrinkventoryLogic.SCHEMA).forEach(function (name) {
    ensureSheet_(ss, name, DrinkventoryLogic.SCHEMA[name]);
  });
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  if (!props.getProperty('API_KEY')) props.setProperty('API_KEY', newKey_());
  if (!props.getProperty('SENSOR_KEY')) props.setProperty('SENSOR_KEY', newKey_());
  var folderId = props.getProperty('PHOTO_FOLDER_ID');
  if (!folderId || !folderExists_(folderId)) {
    props.setProperty('PHOTO_FOLDER_ID', createPhotoFolder_(ss).getId());
  }
  Object.keys(ALERT_DEFAULTS).forEach(function (k) {
    if (props.getProperty(k) === null) props.setProperty(k, ALERT_DEFAULTS[k]);
  });
  Logger.log('Setup complete.');
  Logger.log('API_KEY (phones): ' + props.getProperty('API_KEY'));
  Logger.log('SENSOR_KEY (sensors): ' + props.getProperty('SENSOR_KEY'));
  return { apiKey: props.getProperty('API_KEY'), sensorKey: props.getProperty('SENSOR_KEY') };
}

function menuSetup() {
  var keys = setup();
  SpreadsheetApp.getUi().alert(
    'Drinkventory setup complete',
    'App key (enter on both phones):\n' + keys.apiKey +
    '\n\nSensor key (climate sensors only):\n' + keys.sensorKey,
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuNewApiKey() {
  var k = newKey_();
  PropertiesService.getScriptProperties().setProperty('API_KEY', k);
  SpreadsheetApp.getUi().alert('New app key', k + '\n\nEnter it on both phones (Settings).', SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuNewSensorKey() {
  var k = newKey_();
  PropertiesService.getScriptProperties().setProperty('SENSOR_KEY', k);
  SpreadsheetApp.getUi().alert('New sensor key', k + '\n\nUpdate the sensor configuration.', SpreadsheetApp.getUi().ButtonSet.OK);
}

function newKey_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40);
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var lastCol = sh.getLastColumn();
  var existing = lastCol > 0
    ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); })
    : [];
  while (existing.length && existing[existing.length - 1] === '') existing.pop();
  renameLegacyHeaders_(sh, name, existing);
  var missing = headers.filter(function (h) { return existing.indexOf(h) < 0; });
  if (missing.length) sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  var all = existing.concat(missing);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, all.length).setFontWeight('bold');
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  textRuns_(all).forEach(function (run) {
    sh.getRange(2, run[0], rows, run[1]).setNumberFormat('@');
  });
  return sh;
}

/** Version 2.1 renamed bottles.source to bottles.tags; the column and its values are kept. */
function renameLegacyHeaders_(sh, name, headers) {
  if (name !== 'bottles') return;
  var i = headers.indexOf('source');
  if (i < 0 || headers.indexOf('tags') >= 0) return;
  sh.getRange(1, i + 1).setValue('tags');
  headers[i] = 'tags';
}

/**
 * Adds schema columns that an older Sheet does not have yet (for example products.tags in 2.2),
 * so a sync never drops a field. New columns go to the right of the last used column.
 */
function addMissingHeaders_(sh, name, headers) {
  var schema = DrinkventoryLogic.SCHEMA[name];
  if (!schema || !headers.length) return;
  var missing = schema.filter(function (h) { return headers.indexOf(h) < 0; });
  if (!missing.length) return;
  var start = headers.length + 1;
  sh.getRange(1, start, 1, missing.length).setValues([missing]).setFontWeight('bold');
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  missing.forEach(function (h, i) {
    if (!DrinkventoryLogic.isNumericField(h)) sh.getRange(2, start + i, rows, 1).setNumberFormat('@');
    headers.push(h);
  });
}

/** Contiguous runs of non-numeric columns as [startCol (1-based), numCols]. */
function textRuns_(headers) {
  var runs = [];
  var start = -1;
  for (var i = 0; i <= headers.length; i++) {
    var isText = i < headers.length && headers[i] !== '' && !DrinkventoryLogic.isNumericField(headers[i]);
    if (isText && start < 0) start = i;
    if (!isText && start >= 0) { runs.push([start + 1, i - start]); start = -1; }
  }
  return runs;
}

function folderExists_(id) {
  try { DriveApp.getFolderById(id).getName(); return true; } catch (e) { return false; }
}

function createPhotoFolder_(ss) {
  var parents = DriveApp.getFileById(ss.getId()).getParents();
  var parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  return parent.createFolder(PHOTO_FOLDER_NAME);
}

function getSpreadsheet_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (ss) return ss;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Run setup() first.');
  return SpreadsheetApp.openById(id);
}

// ======================================================================
// HTTP entry points
// ======================================================================

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'climate') {
      // For sensors that can only call a URL (for example webhooks).
      if (!isSensorKey_(p.key)) return json_({ ok: false, error: 'unauthorized' });
      return json_(handleClimate_({
        readings: [{
          reading_id: p.reading_id,
          sensor: p.sensor,
          temp_c: firstDefined_(p.temp_c, p.temp, p.t),
          rh_pct: firstDefined_(p.rh_pct, p.hum, p.rh, p.h),
          battery_pct: firstDefined_(p.battery_pct, p.battery, p.bat)
        }]
      }));
    }
    return json_(pingInfo_());
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'invalid JSON' });
  }
  try {
    var action = String(body.action || '');
    if (action === 'climate') {
      if (!isSensorKey_(body.key) && !isApiKey_(body.key)) return json_({ ok: false, error: 'unauthorized' });
      return json_(handleClimate_(body));
    }
    if (!isApiKey_(body.key)) return json_({ ok: false, error: 'unauthorized' });
    switch (action) {
      case 'ping': return json_(pingInfo_());
      case 'sync': return json_(handleSync_(body));
      case 'photo_get': return json_(handlePhotoGet_(body));
      case 'climate_get': return json_(handleClimateGet_(body));
      default: return json_({ ok: false, error: 'unknown action: ' + action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function pingInfo_() {
  return { ok: true, app: 'drinkventory', version: DrinkventoryLogic.VERSION, code_version: CODE_VERSION };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function isApiKey_(k) {
  var key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  return !!key && typeof k === 'string' && k === key;
}

function isSensorKey_(k) {
  var key = PropertiesService.getScriptProperties().getProperty('SENSOR_KEY');
  return !!key && typeof k === 'string' && k === key;
}

function firstDefined_() {
  for (var i = 0; i < arguments.length; i++) {
    if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') return arguments[i];
  }
  return '';
}

// ======================================================================
// Table I/O
// ======================================================================

function loadTable_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" is missing. Run setup() first.');
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  var headers = lastCol > 0
    ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); })
    : [];
  renameLegacyHeaders_(sh, name, headers);
  addMissingHeaders_(sh, name, headers);
  var key = DrinkventoryLogic.KEYS[name];
  var rows = [];
  var rowNum = {};
  if (lastRow >= 2 && lastCol > 0) {
    var vals = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
    for (var i = 0; i < vals.length; i++) {
      var o = rowToObject_(headers, vals[i]);
      if (!o) continue;
      rows.push(o);
      if (o[key] !== '' && o[key] !== undefined) rowNum[String(o[key])] = i + 2;
    }
  }
  return {
    name: name, sheet: sh, headers: headers, rows: rows, rowNum: rowNum,
    lastRow: Math.max(lastRow, 1), textRuns: textRuns_(headers)
  };
}

function rowToObject_(headers, r) {
  var o = {};
  var empty = true;
  for (var j = 0; j < headers.length; j++) {
    var h = headers[j];
    if (!h) continue;
    var v = r[j];
    if (v instanceof Date) v = v.toISOString();
    if (v === null || v === undefined) v = '';
    v = DrinkventoryLogic.isNumericField(h) ? DrinkventoryLogic.toNumberOrBlank(v) : String(v);
    if (v !== '') empty = false;
    o[h] = v;
  }
  return empty ? null : o;
}

function cellValue_(h, v) {
  if (v === undefined || v === null) return '';
  if (DrinkventoryLogic.isNumericField(h)) return DrinkventoryLogic.toNumberOrBlank(v);
  var s = String(v);
  if (s.charAt(0) === '=') s = "'" + s; // never let user text become a formula
  return s;
}

/** Updates existing rows in place and appends new ones. Keeps user-added columns. */
function writeObjects_(t, objs) {
  if (!objs.length) return;
  var key = DrinkventoryLogic.KEYS[t.name];
  var appends = [];
  var appendKeys = [];
  objs.forEach(function (o) {
    var values = t.headers.map(function (h) { return cellValue_(h, o[h]); });
    var row = t.rowNum[String(o[key])];
    if (row) {
      t.sheet.getRange(row, 1, 1, t.headers.length).setValues([values]);
    } else {
      appends.push(values);
      appendKeys.push(String(o[key]));
    }
  });
  var first = appendRows_(t, appends);
  appendKeys.forEach(function (k, i) { t.rowNum[k] = first + i; });
}

function appendObjects_(t, objs) {
  if (!objs.length) return;
  appendRows_(t, objs.map(function (o) {
    return t.headers.map(function (h) { return cellValue_(h, o[h]); });
  }));
}

function appendRows_(t, rows) {
  if (!rows.length) return t.lastRow + 1;
  var sh = t.sheet;
  var start = t.lastRow + 1;
  var overflow = start + rows.length - 1 - sh.getMaxRows();
  if (overflow > 0) sh.insertRowsAfter(sh.getMaxRows(), overflow + 200);
  t.textRuns.forEach(function (run) {
    sh.getRange(start, run[0], rows.length, run[1]).setNumberFormat('@');
  });
  sh.getRange(start, 1, rows.length, t.headers.length).setValues(rows);
  t.lastRow = start + rows.length - 1;
  return start;
}

function stripToSchema_(rows, table) {
  var fields = DrinkventoryLogic.SCHEMA[table];
  return rows.map(function (r) {
    var o = {};
    fields.forEach(function (f) { o[f] = r[f] === undefined ? '' : r[f]; });
    return o;
  });
}

// ======================================================================
// Sync
// ======================================================================

function handleSync_(body) {
  var ops = Array.isArray(body.ops) ? body.ops : [];
  if (ops.length > MAX_OPS_PER_REQUEST) return { ok: false, error: 'too many ops in one request' };

  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ss = getSpreadsheet_();
    var t = {};
    DATA_TABLES.forEach(function (n) {
      // Tabs added in later versions (settings in 2.3) are created on the first sync.
      if (!ss.getSheetByName(n)) ensureSheet_(ss, n, DrinkventoryLogic.SCHEMA[n]);
      t[n] = loadTable_(ss, n);
    });
    var state = { products: t.products.rows, bottles: t.bottles.rows, events: t.events.rows, settings: t.settings.rows };
    var seen = {};
    t.ops.rows.forEach(function (r) { seen[String(r.op_id)] = true; });

    var dirtyProducts = {};
    var dirtyBottles = {};
    var dirtySettings = {};
    var newEvents = [];
    var newOps = [];
    var results = [];
    var now = new Date().toISOString();

    ops.forEach(function (op) {
      var opId = op && op.op_id ? String(op.op_id) : '';
      if (!opId) { results.push({ op_id: '', status: 'error', error: 'op_id missing' }); return; }
      if (seen[opId]) { results.push({ op_id: opId, status: 'duplicate' }); return; }
      var res = applyServerOp_(state, op);
      seen[opId] = true;
      var result = { op_id: opId, status: res.status };
      if (res.status === 'applied') {
        res.products.forEach(function (p) { dirtyProducts[p.product_id] = p; });
        res.bottles.forEach(function (b) { dirtyBottles[b.bottle_id] = b; });
        (res.settings || []).forEach(function (s) { dirtySettings[s.key] = s; });
        newEvents = newEvents.concat(res.events);
        if (res.photo_id) result.photo_id = res.photo_id;
      } else {
        result.error = res.error;
      }
      results.push(result);
      newOps.push({
        op_id: opId, received_at: now, ts: String(op.ts || ''), user: String(op.user || ''),
        kind: String(op.kind || ''), result: res.status === 'applied' ? 'applied' : 'error: ' + res.error
      });
    });

    writeObjects_(t.products, values_(dirtyProducts));
    writeObjects_(t.bottles, values_(dirtyBottles));
    writeObjects_(t.settings, values_(dirtySettings));
    appendObjects_(t.events, newEvents);
    appendObjects_(t.ops, newOps);
    SpreadsheetApp.flush();

    return {
      ok: true,
      version: DrinkventoryLogic.VERSION,
      code_version: CODE_VERSION,
      server_time: now,
      results: results,
      snapshot: {
        products: stripToSchema_(state.products, 'products'),
        bottles: stripToSchema_(state.bottles, 'bottles'),
        events: stripToSchema_(state.events, 'events'),
        settings: stripToSchema_(state.settings, 'settings')
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function values_(o) {
  return Object.keys(o).map(function (k) { return o[k]; });
}

function applyServerOp_(state, op) {
  if (op.kind === 'set_photo') return { status: 'error', error: 'set_photo is internal; send a photo op' };
  if (op.kind !== 'photo') return DrinkventoryLogic.applyOp(state, op);

  var d = op.data || {};
  var pid = DrinkventoryLogic.clean(d.product_id);
  if (!DrinkventoryLogic.find(state.products, 'product_id', pid)) return { status: 'error', error: 'unknown product: ' + pid };
  if (!d.data) return { status: 'error', error: 'photo data missing' };
  if (String(d.data).length > MAX_PHOTO_BASE64) return { status: 'error', error: 'photo too large' };
  var fileId;
  try {
    fileId = savePhoto_(String(op.op_id), String(d.data));
  } catch (err) {
    return { status: 'error', error: 'photo save failed: ' + (err && err.message ? err.message : err) };
  }
  var res = DrinkventoryLogic.applyOp(state, {
    op_id: op.op_id, kind: 'set_photo', ts: op.ts, user: op.user,
    data: { product_id: pid, photo_id: fileId }
  });
  if (res.status === 'applied') res.photo_id = fileId;
  return res;
}

// ======================================================================
// Photos
// ======================================================================

function photoFolder_() {
  var id = PropertiesService.getScriptProperties().getProperty('PHOTO_FOLDER_ID');
  if (!id) throw new Error('Run setup() first.');
  return DriveApp.getFolderById(id);
}

function savePhoto_(opId, dataUrl) {
  var folder = photoFolder_();
  var name = 'photo-' + opId.replace(/[^A-Za-z0-9_-]/g, '') + '.jpg';
  var existing = folder.getFilesByName(name);
  if (existing.hasNext()) return existing.next().getId();
  var m = dataUrl.match(/^data:([^;,]+)[^,]*,(.*)$/);
  var mime = m ? m[1] : 'image/jpeg';
  var b64 = m ? m[2] : dataUrl;
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) throw new Error('unsupported image type: ' + mime);
  var blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, name);
  return folder.createFile(blob).getId();
}

function handlePhotoGet_(body) {
  var id = DrinkventoryLogic.clean(body.photo_id);
  if (!id) return { ok: false, error: 'photo_id missing' };
  var folderId = photoFolder_().getId();
  var file;
  try { file = DriveApp.getFileById(id); } catch (e) { return { ok: false, error: 'photo not found' }; }
  // Only serve files from the photo folder.
  var inFolder = false;
  var parents = file.getParents();
  while (parents.hasNext()) { if (parents.next().getId() === folderId) { inFolder = true; break; } }
  if (!inFolder) return { ok: false, error: 'photo not found' };
  var blob = file.getBlob();
  return {
    ok: true,
    photo_id: id,
    data: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes())
  };
}

// ======================================================================
// Climate
// ======================================================================

function handleClimate_(body) {
  var input = Array.isArray(body.readings) ? body.readings : [body];
  if (input.length > 200) return { ok: false, error: 'too many readings in one request' };
  var nowDate = new Date();
  var now = nowDate.toISOString();
  var clean = [];
  var errors = [];
  input.forEach(function (r, i) {
    r = r || {};
    var temp = DrinkventoryLogic.toNumberOrBlank(r.temp_c);
    var rh = DrinkventoryLogic.toNumberOrBlank(r.rh_pct);
    var bat = DrinkventoryLogic.toNumberOrBlank(r.battery_pct);
    if (temp === '' && rh === '') { errors.push(i + ': no values'); return; }
    if (temp !== '' && (temp < -40 || temp > 85)) { errors.push(i + ': temperature out of range'); return; }
    if (rh !== '' && (rh < 0 || rh > 100)) { errors.push(i + ': humidity out of range'); return; }
    if (bat !== '' && (bat < 0 || bat > 100)) bat = '';
    var sensor = DrinkventoryLogic.clean(r.sensor).slice(0, 40) || 'cellar';
    var ts = parseDeviceTs_(r.ts, nowDate);
    var rid = DrinkventoryLogic.clean(r.reading_id).slice(0, 80) || (sensor + '-' + ts);
    clean.push({ reading_id: rid, ts: ts, sensor: sensor, temp_c: temp, rh_pct: rh, battery_pct: bat, received_at: now });
  });
  if (!clean.length) return { ok: false, error: errors.join('; ') || 'no readings' };

  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ss = getSpreadsheet_();
    var sh = ss.getSheetByName('climate') || ensureSheet_(ss, 'climate', DrinkventoryLogic.SCHEMA.climate);
    var t = tableHeaderOnly_(sh, 'climate');
    var recent = recentKeys_(t, 500);
    var fresh = clean.filter(function (r) {
      if (recent[r.reading_id]) return false;
      recent[r.reading_id] = true;
      return true;
    });
    appendObjects_(t, fresh);
    return { ok: true, stored: fresh.length, duplicates: clean.length - fresh.length, errors: errors };
  } finally {
    lock.releaseLock();
  }
}

function parseDeviceTs_(v, nowDate) {
  if (v === undefined || v === null || v === '') return nowDate.toISOString();
  var d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  if (isNaN(d.getTime())) return nowDate.toISOString();
  var diff = d.getTime() - nowDate.getTime();
  // Accept backfilled readings up to one year old; reject clocks that were never set.
  if (diff > 3600 * 1000 || diff < -366 * 24 * 3600 * 1000) return nowDate.toISOString();
  return d.toISOString();
}

/** Table descriptor without loading all rows (the climate tab grows fast). */
function tableHeaderOnly_(sh, name) {
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  return {
    name: name, sheet: sh, headers: headers, rows: [], rowNum: {},
    lastRow: Math.max(sh.getLastRow(), 1), textRuns: textRuns_(headers)
  };
}

function recentKeys_(t, n) {
  var out = {};
  var col = t.headers.indexOf(DrinkventoryLogic.KEYS[t.name]) + 1;
  if (col < 1 || t.lastRow < 2) return out;
  var count = Math.min(n, t.lastRow - 1);
  t.sheet.getRange(t.lastRow - count + 1, col, count, 1).getValues()
    .forEach(function (r) { if (r[0] !== '') out[String(r[0])] = true; });
  return out;
}

/** Reads the last rows of the climate tab and returns readings newer than the cutoff. */
function recentReadings_(sh, cutoff, maxRows) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var count = Math.min(maxRows, lastRow - 1);
  var vals = sh.getRange(lastRow - count + 1, 1, count, lastCol).getValues();
  var out = [];
  vals.forEach(function (r) {
    var o = rowToObject_(headers, r);
    if (!o) return;
    var d = new Date(o.ts);
    if (isNaN(d.getTime()) || d < cutoff) return;
    o._date = d;
    out.push(o);
  });
  return out;
}

function handleClimateGet_(body) {
  var days = Math.max(1, Math.min(730, Number(body.days) || 7));
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName('climate');
  if (!sh) return { ok: true, days: days, bucket: 'none', series: [], latest: {} };
  var now = new Date();
  var cutoff = new Date(now.getTime() - days * 86400000);
  // Assumes at most one reading per 2 minutes and sensor.
  var readings = recentReadings_(sh, cutoff, days * 720 * 3);
  var bucket = body.raw === true ? 'raw' : (days <= 2 ? 'raw' : (days <= 21 ? 'hour' : 'day'));
  var tz = Session.getScriptTimeZone() || 'Etc/UTC';
  var groups = {};
  var latest = {};
  readings.forEach(function (r) {
    if (!latest[r.sensor] || r._date >= latest[r.sensor]._date) latest[r.sensor] = r;
    var key;
    if (bucket === 'raw') key = r.ts + '|' + r.reading_id;
    else if (bucket === 'hour') key = Utilities.formatDate(r._date, tz, "yyyy-MM-dd'T'HH:00");
    else key = Utilities.formatDate(r._date, tz, 'yyyy-MM-dd');
    var g = groups[r.sensor + '|' + key];
    if (!g) {
      g = groups[r.sensor + '|' + key] = {
        sensor: r.sensor, t: bucket === 'raw' ? r.ts : key, n: 0,
        temp_sum: 0, temp_n: 0, temp_min: '', temp_max: '',
        rh_sum: 0, rh_n: 0, rh_min: '', rh_max: ''
      };
    }
    g.n += 1;
    if (r.temp_c !== '') {
      g.temp_sum += r.temp_c; g.temp_n += 1;
      g.temp_min = g.temp_min === '' ? r.temp_c : Math.min(g.temp_min, r.temp_c);
      g.temp_max = g.temp_max === '' ? r.temp_c : Math.max(g.temp_max, r.temp_c);
    }
    if (r.rh_pct !== '') {
      g.rh_sum += r.rh_pct; g.rh_n += 1;
      g.rh_min = g.rh_min === '' ? r.rh_pct : Math.min(g.rh_min, r.rh_pct);
      g.rh_max = g.rh_max === '' ? r.rh_pct : Math.max(g.rh_max, r.rh_pct);
    }
  });
  var series = values_(groups).map(function (g) {
    return {
      sensor: g.sensor, t: g.t, n: g.n,
      temp: g.temp_n ? round1_(g.temp_sum / g.temp_n) : '', temp_min: g.temp_min, temp_max: g.temp_max,
      rh: g.rh_n ? round1_(g.rh_sum / g.rh_n) : '', rh_min: g.rh_min, rh_max: g.rh_max
    };
  }).sort(function (a, b) { return a.t < b.t ? -1 : (a.t > b.t ? 1 : 0); });
  var latestOut = {};
  Object.keys(latest).forEach(function (s) {
    var r = latest[s];
    latestOut[s] = { ts: r.ts, temp_c: r.temp_c, rh_pct: r.rh_pct, battery_pct: r.battery_pct };
  });
  return {
    ok: true, days: days, bucket: bucket, tz: tz, series: series, latest: latestOut,
    limits: climateConfig_(PropertiesService.getScriptProperties())
  };
}

function round1_(x) { return Math.round(x * 10) / 10; }

// ======================================================================
// Climate alerts (optional, e-mail)
// ======================================================================

function climateConfig_(props) {
  function num(k) {
    var v = DrinkventoryLogic.toNumberOrBlank(props.getProperty(k));
    return v === '' ? DrinkventoryLogic.toNumberOrBlank(ALERT_DEFAULTS[k]) : v;
  }
  return {
    temp_min: num('ALERT_TEMP_MIN'), temp_max: num('ALERT_TEMP_MAX'),
    rh_min: num('ALERT_RH_MIN'), rh_max: num('ALERT_RH_MAX'),
    stale_min: num('ALERT_STALE_MIN')
  };
}

function installClimateAlerts() {
  removeClimateAlerts();
  ScriptApp.newTrigger('checkClimate').timeBased().everyHours(1).create();
  Logger.log('Hourly climate check installed.');
}

function removeClimateAlerts() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'checkClimate') ScriptApp.deleteTrigger(tr);
  });
}

/** Sends one e-mail when the alert state changes (problem starts or ends). */
function checkClimate() {
  var props = PropertiesService.getScriptProperties();
  var cfg = climateConfig_(props);
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName('climate');
  var now = new Date();
  var latest = {};
  if (sh) {
    recentReadings_(sh, new Date(now.getTime() - 7 * 86400000), 3000).forEach(function (r) {
      if (!latest[r.sensor] || r._date >= latest[r.sensor]._date) latest[r.sensor] = r;
    });
  }
  var flags = [];
  var lines = [];
  var sensors = Object.keys(latest).sort();
  if (!sensors.length) { flags.push('no-data'); lines.push('No climate readings in the last 7 days.'); }
  sensors.forEach(function (s) {
    var r = latest[s];
    var ageMin = Math.round((now - r._date) / 60000);
    var desc = s + ': ' + r.temp_c + ' °C, ' + r.rh_pct + ' % RH (' + ageMin + ' min ago)';
    var f = [];
    if (ageMin > cfg.stale_min) f.push('stale');
    if (r.temp_c !== '' && r.temp_c < cfg.temp_min) f.push('temp-low');
    if (r.temp_c !== '' && r.temp_c > cfg.temp_max) f.push('temp-high');
    if (r.rh_pct !== '' && r.rh_pct < cfg.rh_min) f.push('rh-low');
    if (r.rh_pct !== '' && r.rh_pct > cfg.rh_max) f.push('rh-high');
    f.forEach(function (x) { flags.push(s + ':' + x); });
    lines.push(desc + (f.length ? '  ->  ' + f.join(', ') : '  ->  ok'));
  });
  var state = flags.length ? flags.join('|') : 'ok';
  var last = props.getProperty('ALERT_LAST_STATE') || 'ok';
  Logger.log('Climate state: ' + state);
  if (state === last) return state;
  props.setProperty('ALERT_LAST_STATE', state);
  var to = props.getProperty('ALERT_EMAIL') || Session.getEffectiveUser().getEmail();
  if (!to) return state;
  var subject = state === 'ok' ? 'Drinkventory: cellar climate back in range' : 'Drinkventory: cellar climate alert: ' + flags.join(', ');
  var bodyText = lines.join('\n') +
    '\n\nLimits: ' + cfg.temp_min + '–' + cfg.temp_max + ' °C, ' + cfg.rh_min + '–' + cfg.rh_max +
    ' % RH, stale after ' + cfg.stale_min + ' min.\nChange limits in Apps Script > Project Settings > Script properties.';
  MailApp.sendEmail(to, subject, bodyText);
  return state;
}

/*
 * Minimal in-memory mock of the Google Apps Script services used by Code.gs.
 * It imitates one important Sheets behaviour: a string such as "000123" or
 * "2019-05-01" written into a cell WITHOUT plain-text format becomes a number
 * or a date. This catches missing text formats.
 */
'use strict';
const crypto = require('crypto');

function iter(list) {
  let i = 0;
  return { hasNext: () => i < list.length, next: () => list[i++] };
}

class MockRange {
  constructor(sheet, r, c, nr, nc) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`bad range ${r},${c},${nr},${nc}`);
    if (r + nr - 1 > sheet.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    Object.assign(this, { sheet, r, c, nr, nc });
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) {
        const v = this.sheet.get(this.r + i, this.c + j);
        row.push(v === undefined ? '' : v);
      }
      out.push(row);
    }
    return out;
  }
  setValue(v) { this.setValues([[v]]); return this; }
  setValues(vals) {
    if (vals.length !== this.nr) throw new Error(`row count mismatch ${vals.length} vs ${this.nr}`);
    vals.forEach((row, i) => {
      if (row.length !== this.nc) throw new Error(`col count mismatch ${row.length} vs ${this.nc}`);
      row.forEach((v, j) => this.sheet.set(this.r + i, this.c + j, v));
    });
    return this;
  }
  setNumberFormat(fmt) {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.fmt[`${this.r + i}:${this.c + j}`] = fmt;
    return this;
  }
  setFontWeight() { return this; }
}

class MockSheet {
  constructor(name) { this.name = name; this.cells = {}; this.fmt = {}; this.maxRows = 1000; }
  get(r, c) { return this.cells[`${r}:${c}`]; }
  set(r, c, v) {
    const isText = this.fmt[`${r}:${c}`] === '@';
    if (typeof v === 'string') {
      if (v.startsWith("'")) v = v.slice(1);
      else if (v.startsWith('=')) v = '#FORMULA:' + v;
      else if (!isText && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
      else if (!isText && /^\d{4}-\d{2}-\d{2}/.test(v)) v = new Date(v);
    }
    if (isText && typeof v === 'number') v = String(v);
    this.cells[`${r}:${c}`] = v;
  }
  getName() { return this.name; }
  getLastRow() {
    let m = 0;
    for (const k of Object.keys(this.cells)) {
      const v = this.cells[k];
      if (v !== '' && v !== undefined && v !== null) m = Math.max(m, Number(k.split(':')[0]));
    }
    return m;
  }
  getLastColumn() {
    let m = 0;
    for (const k of Object.keys(this.cells)) {
      const v = this.cells[k];
      if (v !== '' && v !== undefined && v !== null) m = Math.max(m, Number(k.split(':')[1]));
    }
    return m;
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, n) { this.maxRows += n; }
  getRange(r, c, nr = 1, nc = 1) { return new MockRange(this, r, c, nr, nc); }
  setFrozenRows() {}
}

function createGas() {
  const props = {};
  const sheets = {};
  const mail = [];
  const triggers = [];
  const logs = [];
  const folders = {};
  const files = {};

  function makeFolder(id, name) {
    const f = {
      id, name, children: [],
      getId: () => id,
      getName: () => name,
      createFolder: (n) => makeFolder('folder-' + crypto.randomUUID(), n),
      getFilesByName: (n) => iter(Object.values(files).filter((x) => x.parent === id && x.name === n).map((x) => x.api)),
      createFile: (blob) => {
        const fid = 'file-' + crypto.randomUUID();
        files[fid] = makeFile(fid, blob.name, id, blob);
        return files[fid].api;
      }
    };
    folders[id] = f;
    return f;
  }
  function makeFile(id, name, parent, blob) {
    const rec = { id, name, parent, blob };
    rec.api = {
      getId: () => id,
      getName: () => name,
      getParents: () => iter([folders[parent]]),
      getBlob: () => blob
    };
    return rec;
  }
  makeFolder('root', 'My Drive');
  files['ss1'] = makeFile('ss1', 'Drinkventory', 'root', null);

  const ss = {
    getId: () => 'ss1',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new MockSheet(n))
  };

  const env = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: () => ss,
      flush: () => {},
      getUi: () => { throw new Error('no UI in tests'); }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); }
      })
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name, getBytes: () => bytes, getContentType: () => mime }),
      formatDate: (d, tz, fmt) => {
        const iso = d.toISOString();
        if (fmt === 'yyyy-MM-dd') return iso.slice(0, 10);
        if (fmt === "yyyy-MM-dd'T'HH:00") return iso.slice(0, 13) + ':00';
        throw new Error('format not mocked: ' + fmt);
      }
    },
    DriveApp: {
      getFolderById: (id) => { if (!folders[id]) throw new Error('no folder'); return folders[id]; },
      getFileById: (id) => { if (!files[id]) throw new Error('no file'); return files[id].api; },
      getRootFolder: () => folders.root
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; } })
    },
    Session: {
      getScriptTimeZone: () => 'Etc/UTC',
      getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' })
    },
    MailApp: { sendEmail: (to, subject, body) => mail.push({ to, subject, body }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ everyHours: () => ({ create: () => triggers.push({ getHandlerFunction: () => fn }) }) }) })
    },
    Logger: { log: (s) => logs.push(String(s)) },
    console
  };
  return { env, state: { props, sheets, mail, triggers, logs, folders, files } };
}

module.exports = { createGas };

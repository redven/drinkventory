/*
 * Cellar web app: views, local-first changes, sync with the Apps Script backend.
 * Depends on: CellarLogic (logic.js), Store (store.js), Scanner (scanner.js),
 * jsQR and Chart.js (vendor/).
 */
(function () {
  'use strict';

  var L = window.CellarLogic;
  var S = L.stats;

  var app = {
    state: { products: [], bottles: [], events: [] },
    settings: Store.settings(),
    pending: [],
    lastSync: '',
    syncing: false,
    syncAgain: false,
    syncPromise: null,
    syncError: '',
    rejected: [],
    unseenRejected: 0,
    batch: null,
    batchCount: 0,
    scanMode: 'look',
    lastSource: '',
    outCount: 0,
    lastProductId: '',
    signature: '',
    cellar: { q: '', cat: 'all', status: 'stock', sort: 'name' },
    climate: { days: 14, data: null, loadedAt: 0, loading: false, error: '' },
    charts: [],
    view: ''
  };

  // ==================================================================
  // Utilities
  // ==================================================================

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function nowIso() { return new Date().toISOString(); }

  function today() {
    var d = new Date();
    var m = d.getMonth() + 1; var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtAgo(iso) {
    if (!iso) return 'never';
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return fmtDate(iso);
  }

  function fmtNum(n, digits) {
    if (n === '' || n === null || n === undefined || isNaN(n)) return '';
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits === undefined ? 1 : digits });
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function configured() { return !!(app.settings.apiUrl && app.settings.apiKey); }

  function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

  function product(id) { return L.find(app.state.products, 'product_id', id); }
  function bottle(code) { return L.find(app.state.bottles, 'bottle_id', code); }

  function locations() {
    var m = {};
    app.state.bottles.forEach(function (b) { if (b.location) m[b.location] = (m[b.location] || 0) + 1; });
    return Object.keys(m).sort(function (a, b) { return m[b] - m[a]; });
  }

  function sources() {
    var m = {};
    app.state.bottles.forEach(function (b) { if (b.source) m[b.source] = (m[b.source] || 0) + 1; });
    return Object.keys(m).sort(function (a, b) { return m[b] - m[a]; });
  }

  function distinct(field) {
    var m = {};
    app.state.products.forEach(function (p) { if (p[field]) m[p[field]] = true; });
    return Object.keys(m).sort();
  }

  function datalist(id, values) {
    return '<datalist id="' + id + '">' + values.map(function (v) { return '<option value="' + esc(v) + '">'; }).join('') + '</datalist>';
  }

  function stockCount(pid) {
    return app.state.bottles.filter(function (b) { return b.product_id === pid && L.isInStock(b); }).length;
  }

  function typeLabel(t) { var i = L.typeInfo(t); return i ? i.label : ''; }

  function signature(s) {
    var max = '';
    s.products.forEach(function (p) { if (p.updated_at > max) max = p.updated_at; });
    s.bottles.forEach(function (b) { if (b.updated_at > max) max = b.updated_at; });
    return [s.products.length, s.bottles.length, s.events.length, max].join('|');
  }

  // ==================================================================
  // Toast and dialog
  // ==================================================================

  var toastTimer = null;
  function toast(msg, opts) {
    opts = opts || {};
    var el = $('#toast');
    el.className = 'toast show' + (opts.error ? ' error' : '');
    el.innerHTML = '<span>' + esc(msg) + '</span>' + (opts.action ? '<button type="button" class="toast-btn">' + esc(opts.action) + '</button>' : '');
    if (opts.action) {
      $('.toast-btn', el).onclick = function () { hideToast(); opts.onAction(); };
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, opts.error ? 7000 : 5000);
  }
  function hideToast() { var el = $('#toast'); el.className = 'toast'; }

  function confirmDialog(title, text, okLabel) {
    return new Promise(function (resolve) {
      var dlg = $('#dlg');
      dlg.innerHTML = '<form method="dialog" class="dlg-form"><h2 id="dlgTitle">' + esc(title) + '</h2><p class="dlg-text">' + esc(text) + '</p>' +
        '<div class="dlg-actions"><button value="cancel" class="btn">Cancel</button><button value="ok" class="btn primary">' + esc(okLabel) + '</button></div></form>';
      dlg.addEventListener('close', function () { resolve(dlg.returnValue === 'ok'); }, { once: true });
      dlg.returnValue = '';
      dlg.showModal();
    });
  }

  // ==================================================================
  // Changes (local first) and sync
  // ==================================================================

  function applyLocal(state, op) {
    if (op.kind === 'photo') {
      return L.applyOp(state, {
        op_id: op.op_id, kind: 'set_photo', ts: op.ts, user: op.user,
        data: { product_id: op.data.product_id, photo_id: 'local:' + op.op_id }
      });
    }
    return L.applyOp(state, op);
  }

  /** Validates and applies ops locally, stores them in the outbox, then syncs. */
  function commit(ops) {
    var stamped = ops.map(function (o) {
      return { op_id: uuid(), kind: o.kind, ts: nowIso(), user: app.settings.user || 'me', data: o.data };
    });
    var draft = cloneState(app.state);
    for (var i = 0; i < stamped.length; i++) {
      var res = applyLocal(draft, stamped[i]);
      if (res.status !== 'applied') {
        toast('Not saved: ' + res.error, { error: true });
        return Promise.resolve(null);
      }
    }
    app.state = draft;
    var writes = stamped.filter(function (o) { return o.kind === 'photo'; }).map(function (o) {
      return Store.put('photos', 'local:' + o.op_id, o.data.data);
    });
    return Promise.all(writes)
      .then(function () { return Store.addOps(stamped); })
      .then(function () { return Store.put('kv', 'state', app.state); })
      .then(refreshPending)
      .then(function () { app.signature = signature(app.state); scheduleSync(); return stamped; })
      .catch(function (err) {
        toast('Could not store the change on this phone: ' + err.message, { error: true });
        return null;
      });
  }

  function refreshPending() {
    return Store.outbox().then(function (rows) { app.pending = rows; updateSyncBadge(); });
  }

  function api(action, payload, timeoutMs) {
    var s = app.settings;
    if (!s.apiUrl || !s.apiKey) return Promise.reject(new Error('Backend not set up. Open Settings.'));
    var body = JSON.stringify(Object.assign({ action: action, key: s.apiKey }, payload || {}));
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 45000) : null;
    // Plain text body: no CORS preflight, which Apps Script does not answer.
    return fetch(s.apiUrl, { method: 'POST', body: body, redirect: 'follow', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('Server answered with status ' + r.status + '.');
        return r.text();
      })
      .then(function (txt) {
        var j;
        try { j = JSON.parse(txt); } catch (e) {
          throw new Error('The backend did not answer with data. Check that the URL ends with /exec and that the deployment allows access for "Anyone".');
        }
        if (!j.ok) throw new Error(j.error === 'unauthorized' ? 'The backend rejected the app key. Check it in Settings.' : (j.error || 'Server error.'));
        return j;
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') throw new Error('The backend did not answer in time.');
        if (err instanceof TypeError) throw new Error('No connection to the backend.');
        throw err;
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  function takeChunk(rows) {
    var out = []; var size = 0;
    for (var i = 0; i < rows.length && out.length < 20; i++) {
      var len = JSON.stringify(rows[i].op).length;
      if (out.length && size + len > 3500000) break;
      out.push(rows[i]); size += len;
    }
    return out;
  }

  var syncTimer = null;
  function scheduleSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncNow(false); }, delay === undefined ? 1500 : delay);
  }

  function syncNow(manual) {
    if (!configured()) {
      if (manual) toast('Connect the backend in Settings first.');
      return Promise.resolve();
    }
    if (app.syncing) { app.syncAgain = true; return app.syncPromise; }
    app.syncing = true;
    app.syncError = '';
    updateSyncBadge();
    app.syncPromise = doSync().then(function (rejectedCount) {
      if (manual && !rejectedCount) toast('Synced');
    }, function (err) {
      app.syncError = err.message || String(err);
      if (manual) toast('Sync failed: ' + app.syncError, { error: true });
    }).then(function () {
      app.syncing = false;
      updateSyncBadge();
      if (app.syncAgain) { app.syncAgain = false; scheduleSync(300); }
    });
    return app.syncPromise;
  }

  async function doSync() {
    var rows = await Store.outbox();
    var last = null;
    var rejectedNow = [];
    do {
      var chunk = takeChunk(rows);
      var res = await api('sync', { ops: chunk.map(function (r) { return r.op; }) }, 90000);
      last = res;
      var byId = {};
      res.results.forEach(function (r) { byId[r.op_id] = r; });
      var done = [];
      for (var i = 0; i < chunk.length; i++) {
        var row = chunk[i];
        var r = byId[row.op.op_id];
        if (!r) continue;
        done.push(row.seq);
        if (r.status === 'error') {
          rejectedNow.push({ ts: nowIso(), kind: row.op.kind, data: summarizeOp(row.op), error: r.error });
        }
        if (row.op.kind === 'photo' && r.photo_id) {
          var local = await Store.get('photos', 'local:' + row.op.op_id);
          if (local) { await Store.put('photos', r.photo_id, local); await Store.del('photos', 'local:' + row.op.op_id); }
        }
      }
      await Store.removeOps(done);
      rows = rows.filter(function (x) { return done.indexOf(x.seq) < 0; });
      if (!done.length) break;
    } while (rows.length);

    var remaining = await Store.outbox();
    var st = last.snapshot;
    remaining.forEach(function (row) { applyLocal(st, row.op); });
    app.state = st;
    app.pending = remaining;
    app.lastSync = nowIso();
    await Store.put('kv', 'state', st);
    await Store.put('kv', 'lastSync', app.lastSync);
    if (rejectedNow.length) {
      app.rejected = rejectedNow.concat(app.rejected).slice(0, 50);
      app.unseenRejected += rejectedNow.length;
      await Store.put('kv', 'rejected', app.rejected);
      await Store.put('kv', 'unseenRejected', app.unseenRejected);
      toast(rejectedNow.length + ' change(s) rejected by the backend. Details in Settings.', { error: true });
    }
    var sig = signature(st);
    if (sig !== app.signature) {
      app.signature = sig;
      softRender();
    }
    return rejectedNow.length;
  }

  function summarizeOp(op) {
    var d = op.data || {};
    if (op.kind === 'event') return (L.EVENT_LABELS[d.type] || d.type) + ' ' + (d.bottle_id || '');
    if (op.kind === 'create_bottle') return 'add ' + (d.bottle_id || '');
    if (op.kind === 'upsert_product') return 'product ' + (d.producer || d.name || d.product_id || '');
    return op.kind;
  }

  function updateSyncBadge() {
    var el = $('#syncBadge');
    if (!el) return;
    var txt; var cls = '';
    if (!configured()) { txt = 'Not connected'; cls = 'warn'; }
    else if (app.unseenRejected) { txt = app.unseenRejected + ' rejected, tap to see'; cls = 'warn'; }
    else if (app.syncing) { txt = 'Syncing'; cls = 'busy'; }
    else if (app.syncError) { txt = app.pending.length ? app.pending.length + ' waiting, offline' : 'Sync failed'; cls = 'warn'; }
    else if (app.pending.length) { txt = app.pending.length + ' waiting'; }
    else { txt = 'Synced ' + fmtAgo(app.lastSync); }
    el.textContent = txt;
    el.className = 'sync-badge ' + cls;
    el.title = app.syncError || '';
  }

  // ==================================================================
  // Photos
  // ==================================================================

  var photoMem = {};
  function getPhoto(id) {
    if (!id) return Promise.resolve(null);
    if (photoMem[id]) return Promise.resolve(photoMem[id]);
    return Store.get('photos', id).then(function (v) {
      if (v) { photoMem[id] = v; return v; }
      if (id.indexOf('local:') === 0 || !configured() || !navigator.onLine) return null;
      return api('photo_get', { photo_id: id }, 30000).then(function (r) {
        photoMem[id] = r.data;
        return Store.put('photos', id, r.data).then(function () { return r.data; });
      }).catch(function () { return null; });
    });
  }

  function hydratePhotos(root) {
    $$('img[data-photo]', root).forEach(function (img) {
      getPhoto(img.getAttribute('data-photo')).then(function (src) {
        if (src) { img.src = src; img.classList.add('loaded'); }
      });
    });
  }

  function resizeImage(file, maxSide) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.round(img.naturalWidth * scale); var h = Math.round(img.naturalHeight * scale);
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read the image.')); };
      img.src = url;
    });
  }

  // ==================================================================
  // Router
  // ==================================================================

  function parts() {
    return location.hash.replace(/^#\/?/, '').split('/').filter(function (x) { return x !== ''; }).map(function (x) {
      try { return decodeURIComponent(x); } catch (e) { return x; }
    });
  }

  function go(path) { location.hash = '#/' + path; }

  function destroyCharts() {
    app.charts.forEach(function (c) { try { c.destroy(); } catch (e) { /* ignore */ } });
    app.charts = [];
  }

  function render() {
    var p = parts();
    var name = p[0] || 'scan';
    if (name !== 'scan') Scanner.stop();
    destroyCharts();
    var main = $('#main');
    var nav = { scan: 'scan', new: 'scan', b: 'cellar', p: 'cellar', cellar: 'cellar', stats: 'stats', settings: 'settings' }[name] || 'scan';
    $$('.tab').forEach(function (t) { t.setAttribute('aria-current', t.dataset.tab === nav ? 'page' : 'false'); });
    app.view = p.join('/');
    var views = {
      scan: viewScan,
      new: function () { viewNew(main, L.normalizeCode(p[1] || '')); },
      b: function () { if (p[2] === 'edit') viewBottleEdit(main, p[1]); else viewBottle(main, p[1]); },
      p: function () { if (p[2] === 'edit') viewProductEdit(main, p[1]); else viewProduct(main, p[1]); },
      cellar: viewCellar,
      stats: viewStats,
      settings: viewSettings
    };
    (views[name] || viewScan)(main);
    main.scrollTop = 0;
    window.scrollTo(0, 0);
    updateSyncBadge();
  }

  /** Re-render after background data changes, but never under an open form or dialog. */
  function softRender() {
    var p = parts();
    var dlgOpen = $('#dlg').open;
    if (dlgOpen || p[0] === 'new' || p[2] === 'edit' || p[0] === 'settings') { updateSyncBadge(); return; }
    if ((p[0] || 'scan') === 'scan') { updateScanSide(); return; }
    render();
  }

  // ==================================================================
  // View: scan
  // ==================================================================

  function viewScan(main) {
    main.innerHTML =
      '<section class="scan">' +
      (configured() ? '' : '<p class="hint">This phone works offline until you connect the backend in <a href="#/settings">Settings</a>.</p>') +
      '<div class="seg scan-mode" role="group" aria-label="What a scan does">' +
      '<button type="button" class="seg-btn" data-act="scan-mode" data-mode="look" aria-pressed="' + (app.scanMode === 'look') + '">Look up</button>' +
      '<button type="button" class="seg-btn" data-act="scan-mode" data-mode="out" aria-pressed="' + (app.scanMode === 'out') + '">Take out</button>' +
      '</div>' +
      '<div id="modeSlot"></div>' +
      '<div class="viewfinder' + (app.scanMode === 'out' && !app.batch ? ' out-mode' : '') + '">' +
      '<video id="cam" playsinline muted autoplay></video>' +
      '<div class="frame" aria-hidden="true"></div>' +
      '<p class="cam-msg" id="camMsg">Starting camera</p>' +
      '<button type="button" class="torch" id="torchBtn" data-act="torch" hidden>Light</button>' +
      '</div>' +
      '<form class="manual" id="manualForm" autocomplete="off">' +
      '<label for="manualCode">Sticker number</label>' +
      '<div class="inline"><input id="manualCode" name="code" autocapitalize="characters" spellcheck="false" placeholder="e.g. 000123">' +
      '<button class="btn" type="submit">Go</button></div>' +
      '</form>' +
      '<div id="activitySlot"></div>' +
      '</section>';
    updateScanSide();
    $('#manualForm').onsubmit = function (e) {
      e.preventDefault();
      var v = $('#manualCode').value;
      if (v.trim()) { handleCode(v); $('#manualCode').value = ''; }
    };
    var msg = $('#camMsg');
    Scanner.start($('#cam'), handleCode).then(function () {
      msg.hidden = true;
      if (Scanner.hasTorch()) $('#torchBtn').hidden = false;
    }).catch(function (err) {
      msg.hidden = false;
      msg.textContent = 'Camera not available (' + (err && err.name ? err.name : err) + '). Allow camera access for this app, or type the sticker number below.';
    });
  }

  function updateScanSide() {
    var slot = $('#modeSlot');
    if (!slot) return;
    var vf = $('.viewfinder');
    if (vf) vf.classList.toggle('out-mode', app.scanMode === 'out' && !app.batch);
    $$('[data-act=scan-mode]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.mode === app.scanMode)); });
    if (app.batch) {
      var p = product(app.batch.product_id);
      slot.innerHTML = '<div class="banner" role="status"><p><strong>Adding bottles of ' + esc(L.productLabel(p)) + '.</strong> ' +
        'Scan the next sticker. ' + app.batchCount + ' added so far.</p>' +
        '<button type="button" class="btn" data-act="batch-stop">Stop adding</button></div>';
    } else if (app.scanMode === 'out') {
      slot.innerHTML = '<div class="banner out" role="status"><p><strong>Take-out mode.</strong> Every scanned bottle leaves the stock. ' +
        (app.outCount ? app.outCount + ' taken out so far.' : '') + '</p></div>';
    } else {
      slot.innerHTML = '';
    }
    var ev = app.state.events.slice().sort(function (a, b) { return a.ts < b.ts ? 1 : -1; }).slice(0, 6);
    var act = $('#activitySlot');
    if (!ev.length) {
      act.innerHTML = '<p class="empty">No bottles yet. Stick a label on a bottle and scan it to add the first one.</p>';
      return;
    }
    act.innerHTML = '<h2>Recent</h2><ul class="list">' + ev.map(function (e) {
      return '<li><a href="#/b/' + encodeURIComponent(e.bottle_id) + '" class="row">' +
        '<span class="row-main"><span class="row-title">' + esc(L.EVENT_LABELS[e.type] || e.type) + ': ' + esc(L.productLabel(product(e.product_id))) + '</span>' +
        '<span class="row-sub">' + esc(e.bottle_id) + ', ' + esc(fmtAgo(e.ts)) + (e.user ? ', ' + esc(e.user) : '') + '</span></span></a></li>';
    }).join('') + '</ul>';
  }

  function flash() {
    var vf = $('.viewfinder');
    if (!vf) return;
    vf.classList.remove('hit');
    void vf.offsetWidth;
    vf.classList.add('hit');
  }

  function handleCode(raw) {
    var code = L.normalizeCode(raw);
    if (!code) return;
    flash();
    var b = bottle(code);
    var known = b && b.status !== 'void';
    if (app.batch) {
      if (known && b.product_id === app.batch.product_id) { toast('Already added: ' + code); return; }
      if (known) { go('b/' + encodeURIComponent(code)); return; }
      addFromBatch(code);
      return;
    }
    if (app.scanMode === 'out') {
      if (!known) {
        toast('Sticker ' + code + ' is not in the cellar.', { action: 'Add', onAction: function () { go('new/' + encodeURIComponent(code)); } });
        return;
      }
      if (b.status !== 'in_stock') { toast('Already taken out: ' + code); return; }
      takeOut(code, function () { app.outCount += 1; updateScanSide(); });
      return;
    }
    if (known) { go('b/' + encodeURIComponent(code)); return; }
    go('new/' + encodeURIComponent(code));
  }

  function addFromBatch(code) {
    var bt = app.batch;
    commit([{ kind: 'create_bottle', data: {
      bottle_id: code, product_id: bt.product_id, location: bt.location, acquired_date: bt.acquired_date, source: bt.source
    } }]).then(function (ok) {
      if (!ok) return;
      app.batchCount += 1;
      updateScanSide();
      toast('Added ' + code, { action: 'Undo', onAction: function () {
        commit([{ kind: 'event', data: { type: 'void', bottle_id: code } }]).then(function () {
          app.batchCount = Math.max(0, app.batchCount - 1); updateScanSide();
        });
      } });
    });
  }

  // ==================================================================
  // Bottle actions
  // ==================================================================

  function takeOut(code, after) {
    var p = product((bottle(code) || {}).product_id);
    commit([{ kind: 'event', data: { type: 'out', bottle_id: code } }]).then(function (ok) {
      if (!ok) return;
      toast('Taken out: ' + L.productLabel(p), { action: 'Undo', onAction: function () {
        commit([{ kind: 'event', data: { type: 'restore', bottle_id: code } }]).then(function (r) {
          if (!r) return;
          if (app.scanMode === 'out' && app.outCount) { app.outCount -= 1; }
          softRender();
        });
      } });
      if (after) after();
    });
  }

  function backInStock(code) {
    commit([{ kind: 'event', data: { type: 'restore', bottle_id: code } }]).then(function (ok) {
      if (ok) { toast('Back in stock: ' + code); render(); }
    });
  }

  function moveDialog(code) {
    var b = bottle(code);
    if (!b) return;
    var locs = locations();
    var dlg = $('#dlg');
    dlg.innerHTML = '<form method="dialog" class="dlg-form" autocomplete="off">' +
      '<h2 id="dlgTitle">Move bottle</h2>' +
      '<p class="dlg-sub"><span class="serif">' + esc(L.productLabel(product(b.product_id))) + '</span>, sticker ' + esc(code) + '</p>' +
      field('location', 'New location', '', 'list="dl_loc2" required') + datalist('dl_loc2', locs) +
      '<div class="chips">' + locs.filter(function (l) { return l !== b.location; }).slice(0, 8).map(function (l) {
        return '<button type="button" class="chip-btn" data-fill-loc="' + esc(l) + '">' + esc(l) + '</button>';
      }).join('') + '</div>' +
      '<div class="dlg-actions"><button value="cancel" class="btn" formnovalidate>Cancel</button>' +
      '<button value="ok" class="btn primary">Move</button></div></form>';
    var form = $('form', dlg);
    $$('[data-fill-loc]', dlg).forEach(function (c) {
      c.onclick = function () { form.location.value = c.getAttribute('data-fill-loc'); };
    });
    dlg.returnValue = '';
    dlg.addEventListener('close', function () {
      if (dlg.returnValue !== 'ok') return;
      var loc = String(form.location.value || '').trim();
      if (!loc) { toast('Enter a location.', { error: true }); return; }
      commit([{ kind: 'event', data: { type: 'move', bottle_id: code, location: loc } }]).then(function (ok) {
        if (ok) { toast('Moved to ' + loc); render(); }
      });
    }, { once: true });
    dlg.showModal();
  }

  function removeBottle(code) {
    confirmDialog('Remove bottle',
      'Use this when the sticker is on the wrong bottle or the entry is a mistake. The bottle leaves all lists, ' +
      'the history stays in the Sheet, and you can use the sticker again.', 'Remove').then(function (ok) {
      if (!ok) return;
      commit([{ kind: 'event', data: { type: 'void', bottle_id: code } }]).then(function (r) {
        if (r) { toast('Removed: ' + code); go('scan'); }
      });
    });
  }

  function findOnlineLink(p, cls) {
    var q = L.searchQuery(p);
    if (!q) return '';
    return '<a class="btn ' + (cls || '') + '" href="https://www.google.com/search?q=' + encodeURIComponent(q) +
      '" target="_blank" rel="noopener">Find online</a>';
  }

  // ==================================================================
  // Product form (shared by "new bottle" and "edit product")
  // ==================================================================

  function typeSelect(value) {
    var groups = { wine: 'Wine', spirit: 'Spirits', other: 'Other' };
    return '<select name="type" id="f_type" required>' + (value ? '' : '<option value="">Choose</option>') +
      Object.keys(groups).map(function (g) {
        return '<optgroup label="' + groups[g] + '">' + L.TYPES.filter(function (t) { return t.category === g; }).map(function (t) {
          return '<option value="' + t.id + '"' + (t.id === value ? ' selected' : '') + '>' + esc(t.label) + '</option>';
        }).join('') + '</optgroup>';
      }).join('') + '</select>';
  }

  function field(name, label, value, attrs) {
    attrs = attrs || '';
    return '<label class="field"><span>' + esc(label) + '</span><input name="' + name + '" value="' + esc(value) + '" ' + attrs + '></label>';
  }

  function productFields(p) {
    p = p || {};
    var cat = L.categoryOf(p.type);
    return '<div class="pf" data-cat="' + (p.type ? cat : 'none') + '">' +
      '<label class="field"><span>Type</span>' + typeSelect(p.type) + '</label>' +
      field('producer', 'Producer or winery', p.producer, 'autocapitalize="words" list="dl_producer"') +
      '<div class="only-spirit">' + field('distillery', 'Distillery', p.distillery, 'autocapitalize="words" list="dl_distillery"') + '</div>' +
      field('name', 'Name of the wine or bottling', p.name, 'autocapitalize="words"') +
      '<div class="grid2">' +
      field('vintage', 'Vintage', p.vintage, 'placeholder="2019 or NV" autocapitalize="characters"') +
      '<div class="only-spirit">' + field('age', 'Age', p.age, 'placeholder="12 or NAS"') + '</div>' +
      '</div>' +
      '<div class="grid2">' +
      field('country', 'Country', p.country, 'list="dl_country" autocapitalize="words"') +
      field('region', 'Region', p.region, 'list="dl_region" autocapitalize="words"') +
      '</div>' +
      '<div class="only-wine">' + field('grapes', 'Grapes', p.grapes, 'autocapitalize="words" list="dl_grapes"') + '</div>' +
      '<div class="only-spirit">' + field('cask', 'Cask', p.cask, 'placeholder="e.g. sherry butt"') + '</div>' +
      '<div class="grid2">' +
      field('abv', 'Alcohol (% vol)', p.abv, 'inputmode="decimal"') +
      field('volume_ml', 'Volume (ml)', p.volume_ml, 'inputmode="numeric"') +
      '</div>' +
      '<div class="only-wine"><div class="grid2">' +
      field('drink_from', 'Drink from (year)', p.drink_from, 'inputmode="numeric"') +
      field('drink_to', 'Drink until (year)', p.drink_to, 'inputmode="numeric"') +
      '</div></div>' +
      '<div class="photo-field">' +
      '<img class="photo-preview" alt=""' + (p.photo_id ? ' data-photo="' + esc(p.photo_id) + '"' : '') + '>' +
      '<label class="btn file-btn"><input type="file" accept="image/*" class="photo-input visually-hidden">' + (p.photo_id ? 'Replace label photo' : 'Add label photo') + '</label>' +
      '<input type="hidden" name="photo_data">' +
      '</div>' +
      datalist('dl_producer', distinct('producer')) + datalist('dl_distillery', distinct('distillery')) +
      datalist('dl_country', distinct('country')) + datalist('dl_region', distinct('region')) +
      datalist('dl_grapes', distinct('grapes')) +
      '</div>';
  }

  function bindProductFields(root) {
    var pf = $('.pf', root);
    var sel = $('select[name=type]', pf);
    var vol = $('input[name=volume_ml]', pf);
    sel.addEventListener('change', function () {
      var cat = L.categoryOf(sel.value);
      pf.setAttribute('data-cat', sel.value ? cat : 'none');
      if (!vol.value) vol.value = cat === 'spirit' ? 700 : (cat === 'wine' ? 750 : '');
    });
    var input = $('.photo-input', pf);
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f) return;
      resizeImage(f, 1280).then(function (data) {
        $('input[name=photo_data]', pf).value = data;
        var img = $('.photo-preview', pf);
        img.src = data; img.classList.add('loaded');
      }).catch(function (e) { toast(e.message, { error: true }); });
    });
    hydratePhotos(pf);
  }

  function readProductFields(root) {
    var pf = $('.pf', root);
    var out = {};
    L.SCHEMA.products.forEach(function (f) {
      var el = pf.querySelector('[name="' + f + '"]');
      if (el) out[f] = el.value;
    });
    // Keep fields of the other category empty so the Sheet stays clean.
    var cat = L.categoryOf(out.type);
    if (cat !== 'spirit') { out.distillery = ''; out.age = ''; out.cask = ''; }
    if (cat !== 'wine') { out.grapes = ''; out.drink_from = ''; out.drink_to = ''; }
    delete out.photo_id;
    return { data: out, photo: $('input[name=photo_data]', pf).value };
  }

  function validateProduct(d) {
    if (!d.type) return 'Choose a type.';
    if (!d.producer && !d.name && !d.distillery) return 'Enter a producer, distillery or name.';
    return '';
  }

  // ==================================================================
  // View: new bottle
  // ==================================================================

  function productSearch(q) {
    var tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    var list = app.state.products.map(function (p) {
      var hay = [p.producer, p.distillery, p.name, p.vintage, p.region, p.country, p.age].join(' ').toLowerCase();
      return { p: p, hay: hay };
    }).filter(function (x) { return tokens.every(function (t) { return x.hay.indexOf(t) >= 0; }); });
    list.sort(function (a, b) { return a.p.updated_at < b.p.updated_at ? 1 : -1; });
    return list.slice(0, 8).map(function (x) { return x.p; });
  }

  function viewNew(main, code) {
    if (!code) { go('scan'); return; }
    var existing = bottle(code);
    if (existing && existing.status !== 'void') { go('b/' + encodeURIComponent(code)); return; }
    var last = app.lastProductId ? product(app.lastProductId) : null;
    var locs = locations();
    main.innerHTML =
      '<section class="page">' +
      '<header class="page-head"><h1>New bottle</h1><span class="code-chip">' + esc(code) + '</span></header>' +
      '<form id="intakeForm" novalidate>' +
      '<fieldset class="group"><legend>Product</legend>' +
      '<input type="hidden" name="product_id" id="chosenId">' +
      '<div id="chosen" class="chosen" hidden></div>' +
      '<div id="chooser">' +
      (last ? '<button type="button" class="choice" data-act="use-product" data-id="' + esc(last.product_id) + '"><span class="choice-k">Same as last</span>' + esc(L.productLabel(last)) + '</button>' : '') +
      (app.state.products.length ? '<input type="search" id="productSearch" placeholder="Search your products" autocomplete="off"><ul id="productResults" class="list compact"></ul>' : '') +
      '<button type="button" class="btn" data-act="new-product">New product</button>' +
      '</div>' +
      '<div id="newProduct" hidden>' + productFields({}) + '</div>' +
      '</fieldset>' +
      '<fieldset class="group"><legend>This bottle</legend>' +
      '<div class="grid2">' +
      field('location', 'Location', last ? lastLocationFor(last.product_id) : (locs[0] || ''), 'list="dl_loc" placeholder="e.g. Rack A, row 3"') +
      field('acquired_date', 'Acquired', today(), 'type="date"') +
      '</div>' + datalist('dl_loc', locs) +
      field('source', 'Source (optional)', app.lastSource || '', 'list="dl_src" placeholder="shop, winery, gift from …"') + datalist('dl_src', sources()) +
      '</fieldset>' +
      '<label class="check"><input type="checkbox" name="keep_adding"> Add more bottles of this product next</label>' +
      '<div class="form-actions"><button class="btn primary" type="submit">Add bottle</button><a class="btn quiet" href="#/scan">Cancel</a></div>' +
      '</form></section>';

    var form = $('#intakeForm');
    bindProductFields(form);
    var search = $('#productSearch');
    var results = $('#productResults');
    function showResults() {
      if (!search) return;
      var q = search.value.trim();
      var list = q ? productSearch(q) : productSearch('').slice(0, 5);
      results.innerHTML = list.map(function (p) {
        var n = stockCount(p.product_id);
        return '<li><button type="button" class="row" data-act="use-product" data-id="' + esc(p.product_id) + '">' +
          '<span class="row-main"><span class="row-title serif">' + esc(L.productLabel(p)) + '</span>' +
          '<span class="row-sub">' + esc(typeLabel(p.type)) + (n ? ', ' + n + ' in stock' : '') + '</span></span></button></li>';
      }).join('') || '<li class="empty">No match. Create a new product.</li>';
    }
    if (search) { search.addEventListener('input', showResults); showResults(); }
    if (!app.state.products.length) ACTIONS['new-product']();

    form.onsubmit = function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var ops = [];
      var pid = fd.get('product_id');
      if (!$('#newProduct').hidden) {
        var pf = readProductFields(form);
        var bad = validateProduct(pf.data);
        if (bad) { toast(bad, { error: true }); return; }
        pid = 'p_' + uuid().slice(0, 13);
        pf.data.product_id = pid;
        ops.push({ kind: 'upsert_product', data: pf.data });
        if (pf.photo) ops.push({ kind: 'photo', data: { product_id: pid, data: pf.photo } });
      } else if (!pid) {
        toast('Choose a product or create a new one.', { error: true });
        return;
      }
      var bottleData = { bottle_id: code, product_id: pid, location: fd.get('location'), acquired_date: fd.get('acquired_date'), source: fd.get('source') };
      ops.push({ kind: 'create_bottle', data: bottleData });
      commit(ops).then(function (ok) {
        if (!ok) return;
        app.lastProductId = pid;
        app.lastSource = bottleData.source;
        toast('Added ' + code);
        if (fd.get('keep_adding')) {
          app.batch = { product_id: pid, location: bottleData.location, acquired_date: bottleData.acquired_date, source: bottleData.source };
          app.batchCount = 1;
          go('scan');
        } else {
          go('b/' + encodeURIComponent(code));
        }
      });
    };
  }

  function lastLocationFor(pid) {
    var bs = app.state.bottles.filter(function (b) { return b.product_id === pid && b.location; })
      .sort(function (a, b) { return a.updated_at < b.updated_at ? 1 : -1; });
    return bs.length ? bs[0].location : '';
  }

  function chooseProduct(id) {
    var p = product(id);
    if (!p) return;
    $('#chosenId').value = id;
    var chosen = $('#chosen');
    chosen.hidden = false;
    chosen.innerHTML = '<p class="serif chosen-name">' + esc(L.productLabel(p)) + '</p><p class="row-sub">' + esc(typeLabel(p.type)) + '</p>' +
      '<button type="button" class="btn quiet" data-act="change-product">Change</button>';
    $('#chooser').hidden = true;
    $('#newProduct').hidden = true;
    var loc = $('#intakeForm input[name=location]');
    var l = lastLocationFor(id);
    if (l && loc) loc.value = l;
  }

  // ==================================================================
  // View: bottle
  // ==================================================================

  function facts(p) {
    var cat = L.categoryOf(p.type);
    var rows = [];
    function add(k, v) { if (v !== '' && v !== undefined && v !== null) rows.push([k, v]); }
    add('Type', typeLabel(p.type));
    add('Region', [p.region, p.country].filter(Boolean).join(', '));
    if (cat === 'wine') {
      add('Grapes', p.grapes);
      if (p.drink_from !== '' || p.drink_to !== '') add('Drink window', (p.drink_from || '?') + ' to ' + (p.drink_to || '?'));
    }
    if (cat === 'spirit') {
      add('Distillery', p.distillery);
      add('Age', p.age);
      add('Cask', p.cask);
    }
    add('Alcohol', p.abv !== '' ? fmtNum(p.abv) + ' % vol' : '');
    add('Volume', p.volume_ml !== '' ? fmtNum(p.volume_ml, 0) + ' ml' : '');
    return '<dl class="facts">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>';
  }

  function windowChip(p) {
    var s = S.drinkWindowStatus(p, new Date().getFullYear());
    var map = { young: 'Too young', ready: 'Ready', past: 'Past window' };
    return map[s] ? '<span class="chip win-' + s + '">' + map[s] + '</span>' : '';
  }

  function eventLine(e) {
    var where = (e.type === 'move' || e.type === 'intake') && e.location ? ' to ' + esc(e.location) : '';
    return '<li class="ev ev-' + esc(e.type) + '"><p class="ev-title">' + esc(L.EVENT_LABELS[e.type] || e.type) + where + '</p>' +
      '<p class="ev-meta">' + esc(fmtDateTime(e.ts)) + (e.user ? ', ' + esc(e.user) : '') + '</p></li>';
  }

  function labelBlock(p) {
    var cat = L.categoryOf(p.type);
    return '<article class="label">' +
      (p.photo_id ? '<img class="label-photo" alt="Label photo" data-photo="' + esc(p.photo_id) + '">' : '') +
      '<p class="label-producer">' + esc(cat === 'spirit' ? (p.distillery || p.producer) : p.producer) + '</p>' +
      '<h1 class="label-name">' + esc([p.name, p.vintage].filter(Boolean).join(' ') || L.productLabel(p)) + '</h1>' +
      '<p class="label-type">' + esc([typeLabel(p.type), p.region].filter(Boolean).join(', ')) + ' ' + windowChip(p) + '</p>' +
      '</article>';
  }

  function viewBottle(main, code) {
    code = L.normalizeCode(code);
    var b = bottle(code);
    if (!b) {
      main.innerHTML = '<section class="page"><p class="empty">Sticker ' + esc(code) + ' is not in the cellar yet.</p>' +
        '<p><a class="btn primary" href="#/new/' + encodeURIComponent(code) + '">Add this bottle</a></p></section>';
      return;
    }
    var p = product(b.product_id) || L.blankRecord('products');
    var st = b.status;
    var events = app.state.events.filter(function (e) { return e.bottle_id === code; }).sort(function (a, c) { return a.ts < c.ts ? 1 : -1; });
    var others = app.state.bottles.filter(function (x) { return x.product_id === b.product_id && x.bottle_id !== code && L.isInStock(x); }).length;

    var actions = '';
    if (st === 'in_stock') {
      actions = '<button type="button" class="btn primary" data-act="take-out" data-code="' + esc(code) + '">Take out</button>' +
        '<button type="button" class="btn" data-act="move" data-code="' + esc(code) + '">Move</button>' + findOnlineLink(p);
    } else if (st === 'out') {
      actions = '<button type="button" class="btn primary" data-act="restore" data-code="' + esc(code) + '">Back in stock</button>' +
        findOnlineLink(p) + '<a class="btn" href="#/p/' + encodeURIComponent(b.product_id) + '">Product</a>';
    } else {
      actions = '<a class="btn primary" href="#/new/' + encodeURIComponent(code) + '">Use sticker for a new bottle</a>';
    }

    var tagLine = L.STATUS_LABELS[st] + (st === 'in_stock' && b.location ? ', ' + b.location : '') +
      (st === 'out' && b.out_at ? ' ' + fmtDate(b.out_at) : '');
    main.innerHTML =
      '<section class="page bottle">' +
      '<div class="tag-hang"><div class="necktag st-' + esc(st) + '">' +
      '<span class="hole" aria-hidden="true"></span>' +
      '<p class="tag-code">' + esc(code) + '</p>' +
      '<p class="tag-status">' + esc(tagLine) + '</p>' +
      '</div></div>' +
      labelBlock(p) +
      '<div class="action-grid">' + actions + '</div>' +
      '<p class="others"><a href="#/p/' + encodeURIComponent(b.product_id) + '">' + (others ? others + ' more of this product in stock' : 'No other bottle of this product in stock') + '</a></p>' +
      '<details class="more"><summary>Details</summary>' + facts(p) +
      ((b.acquired_date || b.source) ? '<dl class="facts">' +
        (b.acquired_date ? '<dt>Acquired</dt><dd>' + esc(fmtDate(b.acquired_date)) + '</dd>' : '') +
        (b.source ? '<dt>Source</dt><dd>' + esc(b.source) + '</dd>' : '') + '</dl>' : '') +
      '</details>' +
      '<h2>History</h2><ol class="timeline">' + events.map(eventLine).join('') + '</ol>' +
      '<div class="quiet-actions">' +
      '<a class="btn quiet" href="#/p/' + encodeURIComponent(b.product_id) + '/edit">Edit product</a>' +
      (st !== 'void' ? '<a class="btn quiet" href="#/b/' + encodeURIComponent(code) + '/edit">Edit bottle</a>' : '') +
      (st !== 'void' ? '<button type="button" class="btn quiet danger" data-act="remove" data-code="' + esc(code) + '">Remove</button>' : '') +
      '</div></section>';
    hydratePhotos(main);
  }

  // ==================================================================
  // View: product
  // ==================================================================

  function viewProduct(main, pid) {
    var p = product(pid);
    if (!p) { main.innerHTML = '<section class="page"><p class="empty">Product not found.</p></section>'; return; }
    var bottles = app.state.bottles.filter(function (b) { return b.product_id === pid && b.status !== 'void'; });
    var stock = bottles.filter(L.isInStock);
    var out = bottles.filter(function (b) { return b.status === 'out'; })
      .sort(function (a, b) { return a.out_at < b.out_at ? 1 : -1; });

    function bottleRow(b) {
      return '<li><a class="row" href="#/b/' + encodeURIComponent(b.bottle_id) + '"><span class="code-chip small">' + esc(b.bottle_id) + '</span>' +
        '<span class="row-main"><span class="row-title">' + (b.status === 'in_stock' ? esc(b.location || 'No location') : 'Taken out ' + esc(fmtDate(b.out_at))) + '</span>' +
        ((b.acquired_date || b.source) ? '<span class="row-sub">' + [b.acquired_date ? 'Acquired ' + esc(fmtDate(b.acquired_date)) : '', b.source ? esc(b.source) : ''].filter(Boolean).join(', ') + '</span>' : '') + '</span></a></li>';
    }

    main.innerHTML =
      '<section class="page">' +
      labelBlock(p) +
      '<div class="action-grid">' +
      '<button type="button" class="btn primary" data-act="add-bottles" data-id="' + esc(pid) + '">Add bottles</button>' +
      findOnlineLink(p) +
      '<a class="btn" href="#/p/' + encodeURIComponent(pid) + '/edit">Edit product</a>' +
      '</div>' +
      '<h2>In stock (' + stock.length + ')</h2>' +
      (stock.length ? '<ul class="list">' + stock.map(bottleRow).join('') + '</ul>' : '<p class="empty">None in stock.</p>') +
      facts(p) +
      (out.length ? '<h2>Taken out (' + out.length + ')</h2><ul class="list">' + out.map(bottleRow).join('') + '</ul>' : '') +
      '</section>';
    hydratePhotos(main);
  }

  function viewProductEdit(main, pid) {
    var p = product(pid);
    if (!p) { main.innerHTML = '<section class="page"><p class="empty">Product not found.</p></section>'; return; }
    main.innerHTML = '<section class="page"><header class="page-head"><h1>Edit product</h1></header>' +
      '<form id="productForm" novalidate>' + productFields(p) +
      '<div class="form-actions"><button class="btn primary" type="submit">Save product</button>' +
      '<a class="btn quiet" href="#/p/' + encodeURIComponent(pid) + '">Cancel</a></div></form></section>';
    var form = $('#productForm');
    bindProductFields(form);
    form.onsubmit = function (e) {
      e.preventDefault();
      var pf = readProductFields(form);
      var bad = validateProduct(pf.data);
      if (bad) { toast(bad, { error: true }); return; }
      pf.data.product_id = pid;
      var ops = [{ kind: 'upsert_product', data: pf.data }];
      if (pf.photo) ops.push({ kind: 'photo', data: { product_id: pid, data: pf.photo } });
      commit(ops).then(function (ok) {
        if (ok) { toast('Saved product'); go('p/' + encodeURIComponent(pid)); }
      });
    };
  }

  function viewBottleEdit(main, code) {
    code = L.normalizeCode(code);
    var b = bottle(code);
    if (!b) { go('scan'); return; }
    var products = app.state.products.slice().sort(function (a, c) { return L.productLabel(a).localeCompare(L.productLabel(c)); });
    main.innerHTML = '<section class="page"><header class="page-head"><h1>Edit bottle</h1><span class="code-chip">' + esc(code) + '</span></header>' +
      '<form id="bottleForm" novalidate><fieldset class="group">' +
      '<label class="field"><span>Product</span><select name="product_id">' + products.map(function (p) {
        return '<option value="' + esc(p.product_id) + '"' + (p.product_id === b.product_id ? ' selected' : '') + '>' + esc(L.productLabel(p)) + '</option>';
      }).join('') + '</select></label>' +
      '<div class="grid2">' + field('location', 'Location', b.location, 'list="dl_loc"') +
      field('acquired_date', 'Acquired', b.acquired_date, 'type="date"') + '</div>' + datalist('dl_loc', locations()) +
      field('source', 'Source', b.source, 'list="dl_src"') + datalist('dl_src', sources()) +
      '</fieldset><div class="form-actions"><button class="btn primary" type="submit">Save bottle</button>' +
      '<a class="btn quiet" href="#/b/' + encodeURIComponent(code) + '">Cancel</a></div></form></section>';
    $('#bottleForm').onsubmit = function (e) {
      e.preventDefault();
      var fd = new FormData(e.target);
      commit([{ kind: 'update_bottle', data: {
        bottle_id: code, product_id: fd.get('product_id'), location: fd.get('location'), acquired_date: fd.get('acquired_date'), source: fd.get('source')
      } }]).then(function (ok) { if (ok) { toast('Saved bottle'); go('b/' + encodeURIComponent(code)); } });
    };
  }

  // ==================================================================
  // View: cellar list
  // ==================================================================

  function viewCellar(main) {
    var f = app.cellar;
    function seg(group, value, label) {
      return '<button type="button" class="seg-btn" data-act="filter" data-group="' + group + '" data-value="' + value + '" aria-pressed="' + (f[group] === value) + '">' + label + '</button>';
    }
    main.innerHTML =
      '<section class="page cellar">' +
      '<div class="filters">' +
      '<input type="search" id="cellarSearch" placeholder="Search" aria-label="Search producer, name, region, location, source or sticker" value="' + esc(f.q) + '" autocomplete="off">' +
      '<div class="seg" role="group" aria-label="Category">' + seg('cat', 'all', 'All') + seg('cat', 'wine', 'Wine') + seg('cat', 'spirit', 'Spirits') + '</div>' +
      '<div class="seg" role="group" aria-label="Status">' + seg('status', 'stock', 'In stock') + seg('status', 'out', 'Taken out') + '</div>' +
      '<label class="field inline-field"><span>Sort</span><select id="cellarSort">' +
      [['name', 'Name'], ['location', 'Location'], ['vintage', 'Vintage'], ['window', 'Drink by'], ['recent', 'Most recent'], ['count', 'Most bottles']].map(function (o) {
        return '<option value="' + o[0] + '"' + (f.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></label>' +
      '</div><div id="cellarList"></div></section>';
    var search = $('#cellarSearch');
    search.addEventListener('input', function () { f.q = search.value; renderCellarList(); });
    $('#cellarSort').addEventListener('change', function (e) { f.sort = e.target.value; renderCellarList(); });
    renderCellarList();
  }

  function renderCellarList() {
    var f = app.cellar;
    var pm = {};
    app.state.products.forEach(function (p) { pm[p.product_id] = p; });
    var tokens = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    var bottles = app.state.bottles.filter(function (b) {
      if (f.status === 'stock' ? b.status !== 'in_stock' : b.status !== 'out') return false;
      var p = pm[b.product_id] || {};
      if (f.cat !== 'all' && L.categoryOf(p.type) !== f.cat) return false;
      if (tokens.length) {
        var hay = [p.producer, p.distillery, p.name, p.vintage, p.region, p.country, p.grapes, p.age, b.location, b.source, b.bottle_id, typeLabel(p.type)].join(' ').toLowerCase();
        if (!tokens.every(function (t) { return hay.indexOf(t) >= 0; })) return false;
      }
      return true;
    });
    var groups = {};
    bottles.forEach(function (b) {
      var g = groups[b.product_id] || (groups[b.product_id] = { p: pm[b.product_id] || L.blankRecord('products'), bottles: [], locs: {}, latest: '' });
      g.bottles.push(b);
      if (b.location) g.locs[b.location] = true;
      var t = f.status === 'out' ? b.out_at : b.created_at;
      if (t > g.latest) g.latest = t;
    });
    var list = Object.keys(groups).map(function (k) { return groups[k]; });
    var sorters = {
      name: function (a, b) { return L.productLabel(a.p).localeCompare(L.productLabel(b.p)); },
      location: function (a, b) { return Object.keys(a.locs).sort().join().localeCompare(Object.keys(b.locs).sort().join()) || sorters.name(a, b); },
      vintage: function (a, b) { return String(a.p.vintage || '9999').localeCompare(String(b.p.vintage || '9999')); },
      window: function (a, b) {
        var ta = L.toNumberOrBlank(a.p.drink_to); var tb = L.toNumberOrBlank(b.p.drink_to);
        return (ta === '' ? 9999 : ta) - (tb === '' ? 9999 : tb);
      },
      recent: function (a, b) { return a.latest < b.latest ? 1 : -1; },
      count: function (a, b) { return b.bottles.length - a.bottles.length; }
    };
    list.sort(sorters[f.sort] || sorters.name);
    var el = $('#cellarList');
    if (!list.length) {
      el.innerHTML = app.state.bottles.length
        ? '<p class="empty">No bottles match this filter.</p>'
        : '<p class="empty">The cellar is empty. Scan a sticker to add the first bottle.</p><p><a class="btn primary" href="#/scan">Scan a sticker</a></p>';
      return;
    }
    el.innerHTML = '<p class="count">' + bottles.length + ' bottles, ' + list.length + ' products</p><ul class="list products">' + list.map(function (g) {
      var p = g.p; var cat = L.categoryOf(p.type);
      var sub = [typeLabel(p.type), p.region].filter(Boolean).join(', ');
      var tail = f.status === 'out' ? (g.latest ? 'Last ' + fmtDate(g.latest) : '') : Object.keys(g.locs).sort().slice(0, 3).join(', ');
      return '<li><a class="row" href="#/p/' + encodeURIComponent(p.product_id) + '">' +
        '<span class="count-badge cat-' + cat + '">' + g.bottles.length + '</span>' +
        '<span class="row-main"><span class="row-kicker">' + esc(cat === 'spirit' ? (p.distillery || p.producer) : p.producer) + '</span>' +
        '<span class="row-title serif">' + esc([p.name, p.vintage].filter(Boolean).join(' ') || L.productLabel(p)) + '</span>' +
        '<span class="row-sub">' + esc(sub) + (tail ? '. ' + esc(tail) : '') + '</span></span>' +
        (f.status === 'stock' ? windowChip(p) : '') + '</a></li>';
    }).join('') + '</ul>';
  }

  // ==================================================================
  // View: statistics
  // ==================================================================

  function chartBase() {
    return {
      ink: cssVar('--ink'), ink2: cssVar('--ink-2'), muted: cssVar('--muted'),
      grid: cssVar('--grid'), axis: cssVar('--axis'), surface: cssVar('--surface'),
      wine: cssVar('--series-wine'), spirit: cssVar('--series-spirit'), other: cssVar('--series-other')
    };
  }

  function chartDefaults() {
    if (!window.Chart) return;
    var c = chartBase();
    Chart.defaults.font.family = cssVar('--sans');
    Chart.defaults.font.size = 12;
    Chart.defaults.color = c.muted;
    Chart.defaults.borderColor = c.grid;
    Chart.defaults.animation = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 250 };
    Chart.defaults.plugins.tooltip.backgroundColor = c.ink;
    Chart.defaults.plugins.tooltip.titleColor = c.surface;
    Chart.defaults.plugins.tooltip.bodyColor = c.surface;
    Chart.defaults.plugins.tooltip.padding = 8;
    Chart.defaults.plugins.tooltip.cornerRadius = 6;
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.boxHeight = 10;
    Chart.defaults.plugins.legend.labels.color = c.ink2;
    Chart.defaults.maintainAspectRatio = false;
  }

  function axes(c, horizontal, stacked) {
    var valueAxis = { beginAtZero: true, stacked: !!stacked, grid: { color: c.grid, drawTicks: false }, border: { display: false }, ticks: { precision: 0, padding: 6 } };
    var catAxis = { stacked: !!stacked, grid: { display: false }, border: { color: c.axis }, ticks: { padding: 4, autoSkip: true } };
    return horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis };
  }

  function barChart(id, labels, values, color, horizontal) {
    var el = document.getElementById(id);
    if (!el || !window.Chart) return;
    var c = chartBase();
    app.charts.push(new Chart(el, {
      type: 'bar',
      data: { labels: labels, datasets: [{ data: values, backgroundColor: color, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 18, barPercentage: 0.7 }] },
      options: { indexAxis: horizontal ? 'y' : 'x', scales: axes(c, horizontal), plugins: { legend: { display: false } } }
    }));
  }

  function hBarBlock(id, title, rows, label) {
    if (!rows.length) return '';
    return '<h2>' + esc(title) + '</h2><div class="chart" style="height:' + (60 + rows.length * 28) + 'px"><canvas id="' + id + '" role="img" aria-label="' + esc(label) + '"></canvas></div>';
  }

  function viewStats(main) {
    chartDefaults();
    var c = chartBase();
    var year = new Date().getFullYear();
    var sum = S.summary(app.state);
    var win = S.drinkWindows(app.state, year);
    var outs = S.outByMonth(app.state, 24);
    var byType = S.stockBy(app.state, 'type');
    var byCountry = S.stockBy(app.state, 'country').slice(0, 10);
    var byLoc = S.stockBy(app.state, 'location').slice(0, 12);
    var bySource = S.stockBy(app.state, 'source').slice(0, 10);
    var hasSource = bySource.some(function (x) { return x.key !== '(not set)'; });
    var vint = S.vintageHistogram(app.state);
    var users = S.perUser(app.state);
    var anyOut = outs.wine.concat(outs.spirit, outs.other).some(function (x) { return x > 0; });

    main.innerHTML =
      '<section class="page stats">' +
      '<h1 class="sr-only">Statistics</h1>' +
      '<div class="figures">' +
      fig(sum.total, 'bottles in stock', sum.wine + ' wine, ' + sum.spirit + ' spirits' + (sum.other ? ', ' + sum.other + ' other' : '')) +
      fig(sum.products, 'different products', sum.locations + ' locations') +
      fig(sum.out12m, 'taken out in 12 months', '') +
      '</div>' +

      '<h2>Drinking windows</h2>' +
      '<div class="windows">' +
      winCell('ready', win.counts.ready, 'Ready') + winCell('young', win.counts.young, 'Too young') +
      winCell('past', win.counts.past, 'Past window') + winCell('unknown', win.counts.unknown, 'No window set') +
      '</div>' +
      (win.next.length ? '<h3>Drink next</h3><ul class="list compact">' + win.next.slice(0, 8).map(function (x) {
        var locs = {};
        x.bottles.forEach(function (bb) { if (bb.location) locs[bb.location] = true; });
        return '<li><a class="row" href="#/p/' + encodeURIComponent(x.product.product_id) + '"><span class="count-badge cat-wine">' + x.bottles.length + '</span>' +
          '<span class="row-main"><span class="row-title serif">' + esc(L.productLabel(x.product)) + '</span>' +
          '<span class="row-sub">' + esc((x.product.drink_from || '?') + ' to ' + (x.product.drink_to || '?')) + (Object.keys(locs).length ? ', ' + esc(Object.keys(locs).join(', ')) : '') + '</span></span>' + windowChip(x.product) + '</a></li>';
      }).join('') + '</ul>' : '') +

      '<h2>Bottles taken out per month</h2>' +
      (anyOut ? '<div class="chart tall"><canvas id="chOut" role="img" aria-label="Bottles taken out per month, last 24 months, by category"></canvas></div>' : '<p class="empty">No bottles taken out yet.</p>') +

      (byType.length ? hBarBlock('chType', 'Stock by type', byType, 'Bottles in stock by type') : '<h2>Stock</h2><p class="empty">No bottles in stock.</p>') +
      hBarBlock('chLoc', 'Stock by location', byLoc, 'Bottles in stock by location') +
      hBarBlock('chCountry', 'Stock by country', byCountry, 'Bottles in stock by country') +
      (hasSource ? hBarBlock('chSource', 'Stock by source', bySource, 'Bottles in stock by source') : '') +
      (vint.length ? '<h2>Wine vintages in stock</h2><div class="chart"><canvas id="chVint" role="img" aria-label="Wine bottles in stock by vintage"></canvas></div>' : '') +

      (users.length ? '<h2>Who added and took out</h2><table class="table"><thead><tr><th>Person</th><th>Added</th><th>Taken out</th></tr></thead><tbody>' +
        users.map(function (u) { return '<tr><td>' + esc(u.user) + '</td><td>' + u.added + '</td><td>' + u.out + '</td></tr>'; }).join('') +
        '</tbody></table>' : '') +

      '<h2>Cellar climate</h2><div id="climate"></div>' +
      '<p class="footnote">Raw data: the Google Sheet. Load it in Python with analysis/load_cellar.py.</p>' +
      '</section>';

    if (anyOut) {
      var labels = outs.labels.map(function (k) { var d = new Date(k + '-01T12:00:00'); return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }); });
      var ds = [
        { label: 'Wine', data: outs.wine, backgroundColor: c.wine },
        { label: 'Spirits', data: outs.spirit, backgroundColor: c.spirit }
      ];
      if (outs.other.some(function (x) { return x > 0; })) ds.push({ label: 'Other', data: outs.other, backgroundColor: c.other });
      ds.forEach(function (d) { d.borderColor = c.surface; d.borderWidth = 1; d.borderRadius = 2; d.maxBarThickness = 14; });
      app.charts.push(new Chart($('#chOut'), {
        type: 'bar',
        data: { labels: labels, datasets: ds },
        options: {
          scales: axes(c, false, true),
          plugins: { legend: { display: true, position: 'top', align: 'start' }, tooltip: { mode: 'index', intersect: false } }
        }
      }));
    }
    barChart('chType', byType.map(function (x) { return x.key; }), byType.map(function (x) { return x.n; }), c.other, true);
    barChart('chLoc', byLoc.map(function (x) { return x.key; }), byLoc.map(function (x) { return x.n; }), c.other, true);
    barChart('chCountry', byCountry.map(function (x) { return x.key; }), byCountry.map(function (x) { return x.n; }), c.other, true);
    if (hasSource) barChart('chSource', bySource.map(function (x) { return x.key; }), bySource.map(function (x) { return x.n; }), c.other, true);
    barChart('chVint', vint.map(function (x) { return x.key; }), vint.map(function (x) { return x.n; }), c.wine, false);
    renderClimate();
  }

  function fig(value, label, sub) {
    return '<div class="fig"><p class="fig-v">' + esc(value) + '</p><p class="fig-l">' + esc(label) + '</p>' + (sub ? '<p class="fig-s">' + esc(sub) + '</p>' : '') + '</div>';
  }

  function winCell(cls, n, label) {
    return '<div class="win win-' + cls + '"><p class="win-n">' + n + '</p><p class="win-l">' + esc(label) + '</p></div>';
  }

  // ---------- climate ----------

  function renderClimate() {
    var el = $('#climate');
    if (!el) return;
    if (!configured()) { el.innerHTML = '<p class="empty">Connect the backend in Settings to see climate data.</p>'; return; }
    var cl = app.climate;
    var ranges = [[2, '2 days'], [14, '2 weeks'], [90, '3 months'], [365, '1 year']];
    var head = '<div class="seg" role="group" aria-label="Climate period">' + ranges.map(function (r) {
      return '<button type="button" class="seg-btn" data-act="climate-days" data-days="' + r[0] + '" aria-pressed="' + (cl.days === r[0]) + '">' + r[1] + '</button>';
    }).join('') + '</div>';
    var fresh = cl.data && cl.data.days === cl.days && Date.now() - cl.loadedAt < 5 * 60000;
    if (!fresh && !cl.loading) {
      cl.loading = true; cl.error = '';
      api('climate_get', { days: cl.days }, 60000).then(function (d) {
        cl.data = d; cl.loadedAt = Date.now();
      }).catch(function (e) { cl.error = e.message; }).then(function () {
        cl.loading = false;
        if ((parts()[0] || '') === 'stats') renderClimate();
      });
    }
    if (cl.loading && !cl.data) { el.innerHTML = head + '<p class="empty">Loading climate data</p>'; return; }
    if (cl.error && !cl.data) { el.innerHTML = head + '<p class="empty">Climate data not available: ' + esc(cl.error) + '</p>'; return; }
    var d = cl.data;
    if (!d || !d.series.length) {
      el.innerHTML = head + '<p class="empty">No readings yet. Set up a sensor as described in sensor/README.md.</p>';
      return;
    }
    var sensors = Object.keys(d.latest).sort();
    var lim = d.limits || {};
    var now = '<ul class="list compact">' + sensors.map(function (s) {
      var r = d.latest[s];
      var tBad = r.temp_c !== '' && (r.temp_c < lim.temp_min || r.temp_c > lim.temp_max);
      var hBad = r.rh_pct !== '' && (r.rh_pct < lim.rh_min || r.rh_pct > lim.rh_max);
      return '<li class="row"><span class="row-main"><span class="row-title">' +
        '<span class="' + (tBad ? 'out' : '') + '">' + fmtNum(r.temp_c) + ' °C</span>, <span class="' + (hBad ? 'out' : '') + '">' + fmtNum(r.rh_pct, 0) + ' % RH</span>' +
        ((tBad || hBad) ? ' <span class="chip warn-chip">outside limits</span>' : '') + '</span>' +
        '<span class="row-sub">' + esc(s) + ', ' + esc(fmtAgo(r.ts)) + (r.battery_pct !== '' ? ', battery ' + fmtNum(r.battery_pct, 0) + ' %' : '') + '</span></span></li>';
    }).join('') + '</ul>';
    el.innerHTML = head + now +
      '<h3>Temperature (°C)</h3><div class="chart"><canvas id="chTemp" role="img" aria-label="Cellar temperature"></canvas></div>' +
      '<h3>Relative humidity (%)</h3><div class="chart"><canvas id="chRh" role="img" aria-label="Cellar relative humidity"></canvas></div>' +
      '<p class="footnote">Limits ' + fmtNum(lim.temp_min) + ' to ' + fmtNum(lim.temp_max) + ' °C and ' + fmtNum(lim.rh_min, 0) + ' to ' + fmtNum(lim.rh_max, 0) +
      ' % RH. ' + (d.bucket === 'raw' ? 'Single readings.' : (d.bucket === 'hour' ? 'Hourly mean, band shows minimum to maximum.' : 'Daily mean, band shows minimum to maximum.')) + '</p>';
    climateChart('chTemp', d, sensors, 'temp', lim.temp_min, lim.temp_max);
    climateChart('chRh', d, sensors, 'rh', lim.rh_min, lim.rh_max);
  }

  function climateChart(id, d, sensors, key, lo, hi) {
    var el = document.getElementById(id);
    if (!el || !window.Chart) return;
    var c = chartBase();
    var colors = [c.other, c.wine, c.spirit];
    var shown = sensors.slice(0, 3);
    var times = [];
    var seen = {};
    d.series.forEach(function (r) { if (!seen[r.t]) { seen[r.t] = true; times.push(r.t); } });
    times.sort();
    var dates = times.map(function (t) {
      return new Date(d.bucket === 'day' ? t + 'T12:00:00' : (d.bucket === 'hour' ? t + ':00' : t));
    });
    var labels = dates.map(function (dt, i) {
      if (isNaN(dt.getTime())) return times[i];
      return d.bucket === 'day' ? dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
        : dt.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    });
    var spanDays = dates.length > 1 ? (dates[dates.length - 1] - dates[0]) / 86400000 : 0;
    var ticks = dates.map(function (dt, i) {
      if (isNaN(dt.getTime())) return times[i];
      if (spanDays <= 1.5) return dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    });
    var datasets = [];
    shown.forEach(function (s, i) {
      var map = {};
      d.series.forEach(function (r) { if (r.sensor === s) map[r.t] = r; });
      var mean = times.map(function (t) { var r = map[t]; return r && r[key] !== '' ? r[key] : null; });
      if (shown.length === 1 && d.bucket !== 'raw') {
        var mins = times.map(function (t) { var r = map[t]; return r && r[key + '_min'] !== '' ? r[key + '_min'] : null; });
        var maxs = times.map(function (t) { var r = map[t]; return r && r[key + '_max'] !== '' ? r[key + '_max'] : null; });
        datasets.push({ label: 'Minimum', data: mins, borderWidth: 0, pointRadius: 0, fill: false, band: true });
        datasets.push({ label: 'Maximum', data: maxs, borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: hexA(colors[0], 0.18), band: true });
      }
      datasets.push({ label: s, data: mean, borderColor: colors[i], backgroundColor: colors[i], borderWidth: 2, pointRadius: 0, pointHitRadius: 8, tension: 0.25, spanGaps: true });
    });
    [[lo, 'Lower limit'], [hi, 'Upper limit']].forEach(function (x) {
      if (x[0] === '' || x[0] === undefined) return;
      datasets.push({ label: x[1], data: times.map(function () { return x[0]; }), borderColor: c.muted, borderDash: [4, 4], borderWidth: 1, pointRadius: 0, limit: true });
    });
    app.charts.push(new Chart(el, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, border: { color: c.axis }, ticks: { maxTicksLimit: 5, maxRotation: 0, callback: function (v, i) { return ticks[i]; } } },
          y: { grid: { color: c.grid, drawTicks: false }, border: { display: false }, ticks: { padding: 6 } }
        },
        plugins: {
          legend: { display: shown.length > 1, position: 'top', align: 'start', labels: { filter: function (it, data) { var ds = data.datasets[it.datasetIndex]; return !ds.band && !ds.limit; } } },
          tooltip: { filter: function (it) { return !it.dataset.limit; } }
        }
      }
    }));
  }

  function hexA(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (x) { return x + x; }).join('');
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ==================================================================
  // View: settings
  // ==================================================================

  function viewSettings(main) {
    var s = app.settings;
    if (app.unseenRejected) { app.unseenRejected = 0; Store.put('kv', 'unseenRejected', 0); }
    main.innerHTML =
      '<section class="page settings">' +
      '<header class="page-head"><h1>Settings</h1></header>' +
      '<form id="settingsForm" autocomplete="off" novalidate><fieldset class="group">' +
      field('user', 'Your name (shown in the history)', s.user, 'autocapitalize="words" required') +
      field('apiUrl', 'Backend URL (Apps Script web app, ends with /exec)', s.apiUrl, 'type="url" inputmode="url" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec"') +
      field('apiKey', 'App key (from the Sheet menu Cellar > Setup / show keys)', s.apiKey, 'spellcheck="false" autocapitalize="off"') +
      '</fieldset><div class="form-actions"><button class="btn primary" type="submit">Save and connect</button>' +
      '<button class="btn" type="button" data-act="test-conn">Test connection</button></div></form>' +

      '<h2>Sync</h2><dl class="facts">' +
      '<dt>Last sync</dt><dd>' + esc(app.lastSync ? fmtDateTime(app.lastSync) : 'never') + '</dd>' +
      '<dt>Changes waiting</dt><dd>' + app.pending.length + '</dd>' +
      (app.syncError ? '<dt>Last error</dt><dd class="out">' + esc(app.syncError) + '</dd>' : '') +
      '<dt>On this phone</dt><dd>' + app.state.products.length + ' products, ' + app.state.bottles.length + ' bottles, ' + app.state.events.length + ' history entries</dd>' +
      '</dl><div class="form-actions"><button class="btn" type="button" data-act="sync">Sync now</button></div>' +

      (app.rejected.length ? '<h2>Rejected changes</h2><p class="footnote">The backend refused these changes, usually because the other phone changed the same bottle first.</p><ul class="list compact">' +
        app.rejected.map(function (r) { return '<li class="row"><span class="row-main"><span class="row-title">' + esc(r.data) + '</span><span class="row-sub">' + esc(r.error) + ', ' + esc(fmtDateTime(r.ts)) + '</span></span></li>'; }).join('') +
        '</ul><div class="form-actions"><button class="btn quiet" type="button" data-act="clear-rejected">Clear this list</button></div>' : '') +

      '<h2>Data</h2><div class="form-actions">' +
      '<button class="btn" type="button" data-act="export">Export JSON</button>' +
      '<button class="btn quiet danger" type="button" data-act="reset-local">Reset this phone</button></div>' +
      '<p class="footnote">Reset clears the copy on this phone and loads everything again from the Sheet. The Sheet is not changed.</p>' +
      '<p class="footnote">Drinkventory ' + esc(L.VERSION) + '</p>' +
      '</section>';

    $('#settingsForm').onsubmit = function (e) {
      e.preventDefault();
      var fd = new FormData(e.target);
      var url = String(fd.get('apiUrl') || '').trim();
      if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec\/?$/.test(url)) {
        toast('The URL does not look like an Apps Script web app URL (…/macros/s/…/exec). Saved anyway.', { error: true });
      }
      app.settings = { user: String(fd.get('user') || '').trim(), apiUrl: url, apiKey: String(fd.get('apiKey') || '').trim() };
      Store.saveSettings(app.settings);
      app.syncError = '';
      updateSyncBadge();
      if (configured()) syncNow(true).then(function () { render(); });
      else toast('Saved');
    };
  }

  // ==================================================================
  // Click actions
  // ==================================================================

  var ACTIONS = {
    'take-out': function (el) { takeOut(el.dataset.code, function () { render(); }); },
    restore: function (el) { backInStock(el.dataset.code); },
    move: function (el) { moveDialog(el.dataset.code); },
    remove: function (el) { removeBottle(el.dataset.code); },
    'scan-mode': function (el) {
      app.scanMode = el.dataset.mode;
      app.outCount = 0;
      if (app.scanMode === 'out') { app.batch = null; app.batchCount = 0; }
      updateScanSide();
    },
    sync: function () { if (app.unseenRejected) go('settings'); else syncNow(true); },
    'batch-stop': function () { app.batch = null; app.batchCount = 0; updateScanSide(); },
    'use-product': function (el) { chooseProduct(el.dataset.id); },
    'change-product': function () { $('#chosen').hidden = true; $('#chooser').hidden = false; $('#chosenId').value = ''; },
    'new-product': function () {
      $('#chooser').hidden = true;
      $('#newProduct').hidden = false;
      $('#chosenId').value = '';
      var sel = $('#f_type'); if (sel) sel.focus();
    },
    'add-bottles': function (el) {
      var pid = el.dataset.id;
      app.batch = { product_id: pid, location: lastLocationFor(pid), acquired_date: today(), source: app.lastSource || '' };
      app.batchCount = 0;
      app.scanMode = 'look';
      go('scan');
    },
    torch: function (el) {
      var on = el.getAttribute('aria-pressed') !== 'true';
      Scanner.torch(on).then(function (ok) { if (ok) el.setAttribute('aria-pressed', String(on)); });
    },
    filter: function (el) { app.cellar[el.dataset.group] = el.dataset.value; viewCellar($('#main')); },
    'climate-days': function (el) { app.climate.days = Number(el.dataset.days); destroyClimateCharts(); renderClimate(); },
    'test-conn': function () {
      var form = $('#settingsForm');
      var saved = app.settings;
      app.settings = { user: saved.user, apiUrl: form.apiUrl.value.trim(), apiKey: form.apiKey.value.trim() };
      api('ping', {}, 20000).then(function (r) { toast('Connected. Backend version ' + r.version + '.'); }, function (e) { toast(e.message, { error: true }); })
        .then(function () { app.settings = saved; });
    },
    'clear-rejected': function () { app.rejected = []; Store.put('kv', 'rejected', []); render(); },
    export: function () {
      var blob = new Blob([JSON.stringify(app.state, null, 2)], { type: 'application/json' });
      var name = 'cellar-export-' + today() + '.json';
      var file = window.File ? new File([blob], name, { type: 'application/json' }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'Drinkventory export' }).catch(function () { /* cancelled */ });
        return;
      }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    },
    'reset-local': function () {
      var warn = app.pending.length ? ' ' + app.pending.length + ' change(s) are not synced yet and will be lost.' : '';
      confirmDialog('Reset this phone', 'Delete the local copy and load everything again from the Sheet?' + warn, 'Reset').then(function (ok) {
        if (!ok) return;
        Promise.all([Store.clear('kv'), Store.clear('outbox'), Store.clear('photos')]).then(function () {
          photoMem = {};
          app.state = { products: [], bottles: [], events: [] };
          app.pending = []; app.lastSync = ''; app.rejected = []; app.unseenRejected = 0;
          app.signature = '';
          render();
          syncNow(true);
        });
      });
    }
  };

  function destroyClimateCharts() {
    app.charts = app.charts.filter(function (ch) {
      var id = ch.canvas && ch.canvas.id;
      if (id === 'chTemp' || id === 'chRh') { ch.destroy(); return false; }
      return true;
    });
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var fn = ACTIONS[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el, e); }
  });

  // ==================================================================
  // Start
  // ==================================================================

  async function init() {
    try {
      var st = await Store.get('kv', 'state');
      if (st && st.products) app.state = st;
      app.lastSync = (await Store.get('kv', 'lastSync')) || '';
      app.rejected = (await Store.get('kv', 'rejected')) || [];
      app.unseenRejected = (await Store.get('kv', 'unseenRejected')) || 0;
      await refreshPending();
    } catch (e) {
      toast('Local storage is not available: ' + e.message, { error: true });
    }
    app.signature = signature(app.state);
    Store.persist();
    window.addEventListener('hashchange', render);
    render();
    if (!app.settings.user && configured()) toast('Enter your name in Settings so the history shows who did what.');
    syncNow(false);
    window.addEventListener('online', function () { syncNow(false); });
    window.addEventListener('offline', updateSyncBadge);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        syncNow(false);
        var cam = $('#cam');
        if ((parts()[0] || 'scan') === 'scan' && (!cam || !cam.srcObject)) render();
      } else {
        Scanner.stop();
      }
    });
    setInterval(function () { if (document.visibilityState === 'visible') syncNow(false); }, 90000);
    setInterval(updateSyncBadge, 30000);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline cache unavailable */ });
    }
  }

  // Exposed for tests and debugging in the browser console.
  window.CellarApp = { app: app, commit: commit, syncNow: syncNow, render: render, handleCode: handleCode };

  init();
})();

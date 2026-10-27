/*
 * Drinkventory shared logic.
 *
 * The same file runs in two places:
 *   - in the browser:        docs/js/logic.js
 *   - in Google Apps Script: apps-script/Logic.gs
 * Keep both copies identical (tests/backend.test.js verifies this).
 *
 * State shape: { products: [], bottles: [], events: [] }
 * An op is: { op_id, kind, ts (ISO string), user, data: {...} }
 * applyOp() validates first, then mutates the state, and returns a patch:
 *   { status: 'applied', products: [...], bottles: [...], events: [...] }
 *   { status: 'error', error: 'message' }
 *
 * Bottle status: in_stock -> out (taken out) -> in_stock (back in stock)
 *                any -> void (removed: wrong sticker or mistake; sticker can be reused)
 */
var DrinkventoryLogic = (function () {
  'use strict';

  var VERSION = '2.1.1';

  var SCHEMA = {
    products: [
      'product_id', 'type', 'producer', 'name', 'vintage', 'distillery', 'age', 'cask',
      'country', 'region', 'grapes', 'abv', 'volume_ml', 'drink_from', 'drink_to', 'photo_id',
      'created_at', 'created_by', 'updated_at'
    ],
    bottles: [
      'bottle_id', 'product_id', 'status', 'location', 'acquired_date', 'tags', 'out_at',
      'created_at', 'created_by', 'updated_at'
    ],
    events: ['event_id', 'ts', 'user', 'type', 'bottle_id', 'product_id', 'location'],
    ops: ['op_id', 'received_at', 'ts', 'user', 'kind', 'result'],
    climate: ['reading_id', 'ts', 'sensor', 'temp_c', 'rh_pct', 'battery_pct', 'received_at']
  };

  var KEYS = { products: 'product_id', bottles: 'bottle_id', events: 'event_id', ops: 'op_id', climate: 'reading_id' };

  var NUMERIC_FIELDS = ['abv', 'volume_ml', 'drink_from', 'drink_to', 'temp_c', 'rh_pct', 'battery_pct'];

  var TYPES = [
    { id: 'red', label: 'Red wine', category: 'wine' },
    { id: 'white', label: 'White wine', category: 'wine' },
    { id: 'rose', label: 'Rosé', category: 'wine' },
    { id: 'orange', label: 'Orange wine', category: 'wine' },
    { id: 'sparkling', label: 'Sparkling', category: 'wine' },
    { id: 'sweet', label: 'Sweet wine', category: 'wine' },
    { id: 'fortified', label: 'Fortified', category: 'wine' },
    { id: 'whisky', label: 'Whisky', category: 'spirit' },
    { id: 'rum', label: 'Rum', category: 'spirit' },
    { id: 'brandy', label: 'Brandy / Cognac', category: 'spirit' },
    { id: 'gin', label: 'Gin', category: 'spirit' },
    { id: 'agave', label: 'Tequila / Mezcal', category: 'spirit' },
    { id: 'other_spirit', label: 'Other spirit', category: 'spirit' },
    { id: 'other', label: 'Other', category: 'other' }
  ];

  var STATUS_LABELS = { in_stock: 'In stock', out: 'Taken out', void: 'Removed' };

  var EVENT_LABELS = {
    intake: 'Added', move: 'Moved', out: 'Taken out', restore: 'Back in stock',
    void: 'Removed', edit: 'Edited'
  };

  var EVENT_TYPES = ['move', 'out', 'restore', 'void'];
  var META_FIELDS = ['product_id', 'created_at', 'created_by', 'updated_at'];
  var PRODUCT_FIELDS = SCHEMA.products.filter(function (f) { return META_FIELDS.indexOf(f) < 0; });
  var BOTTLE_EDIT_FIELDS = ['product_id', 'location', 'acquired_date', 'tags'];

  // ---------- small helpers ----------

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function clean(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  function isNumericField(f) { return NUMERIC_FIELDS.indexOf(f) >= 0; }

  function toNumberOrBlank(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return isFinite(v) ? v : '';
    var s = String(v).trim().replace(',', '.');
    if (s === '') return '';
    var n = Number(s);
    return isFinite(n) ? n : '';
  }

  function fail(msg) { throw new Error(msg); }

  /** Comma-separated text (grapes, tags) as a list: trimmed, no blanks, no case-insensitive duplicates. */
  function splitList(v) {
    var seen = {};
    return clean(v).split(',').map(function (x) { return x.replace(/\s+/g, ' ').trim(); }).filter(function (x) {
      var k = x.toLowerCase();
      if (!x || seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  function normalizeList(v) { return splitList(v).join(', '); }

  function listHas(v, item) {
    var k = clean(item).toLowerCase();
    return splitList(v).some(function (x) { return x.toLowerCase() === k; });
  }

  /** Older versions stored a single free-text "source" per bottle; it becomes the first tag. */
  function bottleTags(d) {
    return normalizeList(has(d, 'tags') ? d.tags : d.source);
  }

  function upgradeState(state) {
    (state.bottles || []).forEach(function (b) {
      if (b.tags === undefined) b.tags = normalizeList(b.source);
      delete b.source;
    });
    return state;
  }

  function find(list, key, id) {
    if (!list || id === '' || id === null || id === undefined) return null;
    var sid = String(id);
    for (var i = 0; i < list.length; i++) {
      if (String(list[i][key]) === sid) return list[i];
    }
    return null;
  }

  function typeInfo(id) {
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === id) return TYPES[i];
    return null;
  }

  function categoryOf(type) {
    var t = typeInfo(type);
    return t ? t.category : 'other';
  }

  function blankRecord(table) {
    var o = {};
    SCHEMA[table].forEach(function (f) { o[f] = ''; });
    return o;
  }

  function isInStock(b) { return !!b && b.status === 'in_stock'; }

  /** Turns any scanned or typed sticker payload into a bottle ID. */
  function normalizeCode(raw) {
    var s = clean(raw);
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) {
      var m = s.match(/[#?&]b=([^&#]+)/);
      if (m) {
        s = safeDecode(m[1]);
      } else {
        var path = s.replace(/^https?:\/\/[^\/]+/i, '').replace(/[?#].*$/, '');
        var segs = path.split('/').filter(function (x) { return x.length > 0; });
        s = segs.length ? safeDecode(segs[segs.length - 1]) : '';
      }
    }
    s = s.replace(/\s+/g, '').toUpperCase();
    if (s.length > 64) s = s.slice(0, 64);
    return s;
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function productLabel(p) {
    if (!p) return '(unknown product)';
    var parts = [];
    if (categoryOf(p.type) === 'spirit') {
      parts.push(p.distillery || p.producer);
      if (p.name) parts.push(p.name);
      if (p.age !== '' && p.age !== undefined && p.age !== null) {
        var age = String(p.age);
        var inName = new RegExp('(^|\\D)' + age.replace(/[^\w]/g, '') + '(\\D|$)').test(String(p.name || ''));
        if (!inName) parts.push(/^\d+$/.test(age) ? age + ' y' : age);
      }
      if (p.vintage) parts.push(String(p.vintage));
    } else {
      parts.push(p.producer);
      if (p.name) parts.push(p.name);
      if (p.vintage) parts.push(String(p.vintage));
    }
    var label = parts.filter(function (x) { return x !== '' && x !== undefined && x !== null; }).join(' ');
    return label || '(unnamed)';
  }

  /** Google search query for the "Find online" button. */
  function searchQuery(p) {
    if (!p) return '';
    var q = productLabel(p);
    if (categoryOf(p.type) === 'spirit' && p.producer && p.distillery && p.producer !== p.distillery) q = p.producer + ' ' + q;
    if (p.volume_ml !== '' && p.volume_ml !== undefined && p.volume_ml !== null && categoryOf(p.type) === 'spirit') q += ' ' + p.volume_ml + 'ml';
    return q;
  }

  function makeEvent(op, type, b) {
    return {
      event_id: String(op.op_id),
      ts: String(op.ts),
      user: clean(op.user),
      type: type,
      bottle_id: b.bottle_id,
      product_id: b.product_id,
      location: b.location
    };
  }

  // ---------- op handlers ----------

  function upsertProduct(state, op) {
    var d = op.data || {};
    var id = clean(d.product_id);
    if (!id) fail('product_id missing');
    var p = find(state.products, 'product_id', id);
    var isNew = !p;
    var upd = {};
    PRODUCT_FIELDS.forEach(function (f) {
      if (has(d, f)) upd[f] = isNumericField(f) ? toNumberOrBlank(d[f]) : clean(d[f]);
    });
    if (has(upd, 'grapes')) upd.grapes = normalizeList(upd.grapes);
    if (has(upd, 'type') && upd.type !== '' && !typeInfo(upd.type)) fail('unknown type: ' + upd.type);
    if (isNew) {
      if (!upd.type) fail('type missing');
      if (!upd.producer && !upd.name && !upd.distillery) fail('producer, distillery or name required');
    } else if (has(upd, 'type') && upd.type === '') {
      fail('type cannot be empty');
    }
    if (upd.drink_from !== undefined && upd.drink_to !== undefined &&
        upd.drink_from !== '' && upd.drink_to !== '' && upd.drink_from > upd.drink_to) {
      fail('drink window: "from" is after "to"');
    }
    if (isNew) {
      p = blankRecord('products');
      p.product_id = id;
      p.created_at = String(op.ts);
      p.created_by = clean(op.user);
    }
    Object.keys(upd).forEach(function (f) { p[f] = upd[f]; });
    p.updated_at = String(op.ts);
    if (isNew) state.products.push(p);
    return { products: [p] };
  }

  function createBottle(state, op) {
    var d = op.data || {};
    var id = normalizeCode(d.bottle_id);
    if (!id) fail('sticker code missing');
    var pid = clean(d.product_id);
    if (!find(state.products, 'product_id', pid)) fail('unknown product: ' + pid);
    var b = find(state.bottles, 'bottle_id', id);
    if (b && b.status !== 'void') fail('sticker ' + id + ' is already in use');
    var fresh = !b;
    if (fresh) {
      b = blankRecord('bottles');
      b.bottle_id = id;
    } else {
      // Reuse of a sticker that was removed by mistake.
      SCHEMA.bottles.forEach(function (f) { if (f !== 'bottle_id') b[f] = ''; });
    }
    b.product_id = pid;
    b.status = 'in_stock';
    b.location = clean(d.location);
    b.acquired_date = clean(d.acquired_date);
    b.tags = bottleTags(d);
    b.created_at = String(op.ts);
    b.created_by = clean(op.user);
    b.updated_at = String(op.ts);
    if (fresh) state.bottles.push(b);
    var ev = makeEvent(op, 'intake', b);
    state.events.push(ev);
    return { bottles: [b], events: [ev] };
  }

  function updateBottle(state, op) {
    var d = op.data || {};
    var b = find(state.bottles, 'bottle_id', normalizeCode(d.bottle_id));
    if (!b) fail('unknown sticker: ' + clean(d.bottle_id));
    if (b.status === 'void') fail('bottle was removed');
    var upd = {};
    BOTTLE_EDIT_FIELDS.forEach(function (f) { if (has(d, f)) upd[f] = clean(d[f]); });
    if (has(d, 'tags') || has(d, 'source')) upd.tags = bottleTags(d);
    if (has(upd, 'product_id') && !find(state.products, 'product_id', upd.product_id)) {
      fail('unknown product: ' + upd.product_id);
    }
    var changed = Object.keys(upd).filter(function (f) { return String(b[f]) !== String(upd[f]); });
    if (!changed.length) return {};
    changed.forEach(function (f) { b[f] = upd[f]; });
    b.updated_at = String(op.ts);
    var ev = makeEvent(op, changed.length === 1 && changed[0] === 'location' ? 'move' : 'edit', b);
    state.events.push(ev);
    return { bottles: [b], events: [ev] };
  }

  function bottleEvent(state, op) {
    var d = op.data || {};
    var type = clean(d.type);
    if (EVENT_TYPES.indexOf(type) < 0) fail('unknown event type: ' + type);
    var b = find(state.bottles, 'bottle_id', normalizeCode(d.bottle_id));
    if (!b) fail('unknown sticker: ' + clean(d.bottle_id));
    var st = b.status;
    var ts = String(op.ts);
    var next = {};

    switch (type) {
      case 'move':
        if (st === 'void') fail('bottle was removed');
        if (!clean(d.location)) fail('location missing');
        next.location = clean(d.location);
        break;
      case 'out':
        if (st !== 'in_stock') fail('bottle is not in stock');
        next.status = 'out';
        next.out_at = ts;
        break;
      case 'restore':
        if (st !== 'out') fail('bottle is not taken out');
        next.status = 'in_stock';
        next.out_at = '';
        break;
      case 'void':
        if (st === 'void') fail('bottle was already removed');
        next.status = 'void';
        break;
    }

    Object.keys(next).forEach(function (f) { b[f] = next[f]; });
    b.updated_at = ts;
    var ev = makeEvent(op, type, b);
    state.events.push(ev);
    return { bottles: [b], events: [ev] };
  }

  function setPhoto(state, op) {
    var d = op.data || {};
    var p = find(state.products, 'product_id', clean(d.product_id));
    if (!p) fail('unknown product: ' + clean(d.product_id));
    if (!clean(d.photo_id)) fail('photo_id missing');
    p.photo_id = clean(d.photo_id);
    p.updated_at = String(op.ts);
    return { products: [p] };
  }

  /** Renames a tag on every bottle; an empty new name deletes it. No history entries. */
  function renameTag(state, op) {
    var d = op.data || {};
    var from = clean(d.from).toLowerCase();
    if (!from) fail('tag missing');
    var to = normalizeList(d.to);
    var changed = [];
    state.bottles.forEach(function (b) {
      if (!listHas(b.tags, from)) return;
      var next = normalizeList(splitList(b.tags).map(function (t) { return t.toLowerCase() === from ? to : t; }).join(','));
      if (next === b.tags) return;
      b.tags = next;
      b.updated_at = String(op.ts);
      changed.push(b);
    });
    return { bottles: changed };
  }

  var HANDLERS = {
    upsert_product: upsertProduct,
    create_bottle: createBottle,
    update_bottle: updateBottle,
    event: bottleEvent,
    set_photo: setPhoto,
    rename_tag: renameTag
  };

  function applyOp(state, op) {
    try {
      if (!op || typeof op !== 'object') fail('op is not an object');
      if (!clean(op.op_id)) fail('op_id missing');
      if (!clean(op.ts)) fail('ts missing');
      var handler = HANDLERS[op.kind];
      if (!handler) fail('unknown op kind: ' + op.kind);
      var patch = handler(state, op) || {};
      return {
        status: 'applied',
        products: patch.products || [],
        bottles: patch.bottles || [],
        events: patch.events || []
      };
    } catch (e) {
      return { status: 'error', error: (e && e.message) ? e.message : String(e) };
    }
  }

  // ---------- statistics (used by the web app) ----------

  function productMap(state) {
    var m = {};
    state.products.forEach(function (p) { m[String(p.product_id)] = p; });
    return m;
  }

  function stockBottles(state) {
    return state.bottles.filter(isInStock);
  }

  function countBy(items, keyFn) {
    var m = {};
    items.forEach(function (it) {
      var k = keyFn(it);
      if (k === '' || k === null || k === undefined) k = '(not set)';
      k = String(k);
      m[k] = (m[k] || 0) + 1;
    });
    return Object.keys(m).map(function (k) { return { key: k, n: m[k] }; })
      .sort(function (a, b) { return b.n - a.n || (a.key < b.key ? -1 : 1); });
  }

  function drinkWindowStatus(p, year) {
    if (!p || categoryOf(p.type) !== 'wine') return 'n/a';
    var from = toNumberOrBlank(p.drink_from);
    var to = toNumberOrBlank(p.drink_to);
    if (from === '' && to === '') return 'unknown';
    if (from !== '' && year < from) return 'young';
    if (to !== '' && year > to) return 'past';
    return 'ready';
  }

  function monthKey(d) {
    var m = d.getMonth() + 1;
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m;
  }

  /** Bottles taken out per month (net of "back in stock" corrections), by category. */
  function outByMonth(state, nMonths, now) {
    now = now || new Date();
    var pm = productMap(state);
    var labels = [];
    var idx = {};
    for (var i = nMonths - 1; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      idx[monthKey(d)] = labels.length;
      labels.push(monthKey(d));
    }
    var zero = function () { return labels.map(function () { return 0; }); };
    var series = { wine: zero(), spirit: zero(), other: zero() };
    state.bottles.forEach(function (b) {
      if (b.status !== 'out' || !b.out_at) return;
      var d = new Date(b.out_at);
      if (isNaN(d.getTime())) return;
      var k = monthKey(d);
      if (!has(idx, k)) return;
      series[categoryOf((pm[String(b.product_id)] || {}).type)][idx[k]] += 1;
    });
    return { labels: labels, wine: series.wine, spirit: series.spirit, other: series.other };
  }

  function summary(state, now) {
    now = now || new Date();
    var pm = productMap(state);
    var stock = stockBottles(state);
    var out = { wine: 0, spirit: 0, other: 0, total: stock.length, products: 0, out12m: 0, locations: 0 };
    var seenProducts = {};
    var seenLoc = {};
    stock.forEach(function (b) {
      var p = pm[String(b.product_id)];
      out[categoryOf(p ? p.type : '')] += 1;
      seenProducts[String(b.product_id)] = true;
      if (b.location) seenLoc[b.location] = true;
    });
    out.products = Object.keys(seenProducts).length;
    out.locations = Object.keys(seenLoc).length;
    var cutoff = new Date(now.getTime() - 365 * 24 * 3600 * 1000);
    state.bottles.forEach(function (b) {
      if (b.status === 'out' && b.out_at && new Date(b.out_at) >= cutoff) out.out12m += 1;
    });
    return out;
  }

  function stockBy(state, field) {
    var pm = productMap(state);
    return countBy(stockBottles(state), function (b) {
      var p = pm[String(b.product_id)] || {};
      if (field === 'type') { var t = typeInfo(p.type); return t ? t.label : '(not set)'; }
      if (field === 'category') return categoryOf(p.type);
      if (field === 'location') return b.location;
      return p[field];
    });
  }

  /**
   * In-stock bottles per item of a comma-separated field: 'grapes' (wine products) or 'tags' (bottles).
   * A bottle counts once for each of its items, so a blend shows up under every grape.
   */
  function stockByList(state, field) {
    var pm = productMap(state);
    var m = {};
    var label = {};
    stockBottles(state).forEach(function (b) {
      var p = pm[String(b.product_id)] || {};
      if (field === 'grapes' && categoryOf(p.type) !== 'wine') return;
      splitList(field === 'grapes' ? p.grapes : b[field]).forEach(function (x) {
        var k = x.toLowerCase();
        if (!label[k]) label[k] = x;
        m[k] = (m[k] || 0) + 1;
      });
    });
    return Object.keys(m).map(function (k) { return { key: label[k], n: m[k] }; })
      .sort(function (a, b) { return b.n - a.n || a.key.localeCompare(b.key); });
  }

  /** All tags with the number of bottles (any status except removed) that carry them. */
  function tagCounts(state) {
    var m = {};
    var label = {};
    state.bottles.forEach(function (b) {
      if (b.status === 'void') return;
      splitList(b.tags).forEach(function (x) {
        var k = x.toLowerCase();
        if (!label[k]) label[k] = x;
        m[k] = (m[k] || 0) + 1;
      });
    });
    return Object.keys(m).map(function (k) { return { key: label[k], n: m[k] }; })
      .sort(function (a, b) { return b.n - a.n || a.key.localeCompare(b.key); });
  }

  /**
   * Does a bottle (with its product) belong to a statistics slice?
   * facet: { kind: 'win' | 'grape' | 'tag' | 'type' | 'country' | 'location', value }
   */
  function matchFacet(facet, b, p, year) {
    p = p || {};
    var v = facet.value;
    switch (facet.kind) {
      case 'win': return drinkWindowStatus(p, year) === v;
      case 'grape': return categoryOf(p.type) === 'wine' && listHas(p.grapes, v);
      case 'tag': return listHas(b.tags, v);
      case 'type': { var t = typeInfo(p.type); return (t ? t.label : '(not set)') === v; }
      case 'country': return (clean(p.country) || '(not set)') === v;
      case 'location': return (clean(b.location) || '(not set)') === v;
    }
    return true;
  }

  function vintageHistogram(state) {
    var pm = productMap(state);
    var m = {};
    stockBottles(state).forEach(function (b) {
      var p = pm[String(b.product_id)] || {};
      if (categoryOf(p.type) !== 'wine') return;
      var v = clean(p.vintage);
      if (!/^\d{4}$/.test(v)) v = 'NV / not set';
      m[v] = (m[v] || 0) + 1;
    });
    return Object.keys(m).sort().map(function (k) { return { key: k, n: m[k] }; });
  }

  function drinkWindows(state, year) {
    var pm = productMap(state);
    var out = { young: 0, ready: 0, past: 0, unknown: 0 };
    var groups = {};
    var next = [];
    stockBottles(state).forEach(function (b) {
      var p = pm[String(b.product_id)];
      var s = drinkWindowStatus(p, year);
      if (s === 'n/a') return;
      out[s] += 1;
      if (s !== 'ready' && s !== 'past') return;
      var k = String(b.product_id);
      if (!groups[k]) { groups[k] = { product: p, status: s, bottles: [] }; next.push(groups[k]); }
      groups[k].bottles.push(b);
    });
    next.sort(function (a, b) {
      var ta = toNumberOrBlank(a.product.drink_to); var tb = toNumberOrBlank(b.product.drink_to);
      ta = ta === '' ? 9999 : ta; tb = tb === '' ? 9999 : tb;
      return ta - tb;
    });
    return { counts: out, next: next };
  }

  function perUser(state) {
    var m = {};
    state.events.forEach(function (ev) {
      if (ev.type !== 'intake' && ev.type !== 'out' && ev.type !== 'restore') return;
      var u = ev.user || '(unknown)';
      if (!m[u]) m[u] = { user: u, added: 0, out: 0 };
      if (ev.type === 'intake') m[u].added += 1;
      if (ev.type === 'out') m[u].out += 1;
      if (ev.type === 'restore') m[u].out -= 1;
    });
    return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return b.added - a.added; });
  }

  // ---------- backend version check ----------

  function compareVersions(a, b) {
    var pa = String(a).split('.'); var pb = String(b).split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = Number(pa[i] || 0); var y = Number(pb[i] || 0);
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  /**
   * Compares the versions in a backend response with this file's VERSION.
   * Code.gs reports code_version (since 2.1.1), Logic.gs reports version.
   * Returns null when both match, otherwise { key, appIsOlder, text }.
   */
  function backendStatus(r) {
    var logicV = clean(r && r.version);
    var codeV = clean(r && r.code_version);
    if (!logicV) return null;
    if (logicV === VERSION && codeV === VERSION) return null;
    var appIsOlder = !!codeV && compareVersions(codeV, VERSION) > 0 && compareVersions(logicV, VERSION) > 0;
    var text = 'Versions do not match: this app ' + VERSION + ', Code.gs ' + (codeV || 'older than 2.1.1') +
      ', Logic.gs ' + logicV + '. ' + (appIsOlder
        ? 'Close the app completely and open it again to load the update.'
        : 'In Apps Script, replace both Code.gs and Logic.gs, then Deploy > Manage deployments > Edit > New version.');
    return { key: logicV + '|' + codeV, appIsOlder: appIsOlder, text: text };
  }

  return {
    VERSION: VERSION,
    compareVersions: compareVersions,
    backendStatus: backendStatus,
    SCHEMA: SCHEMA,
    KEYS: KEYS,
    NUMERIC_FIELDS: NUMERIC_FIELDS,
    TYPES: TYPES,
    STATUS_LABELS: STATUS_LABELS,
    EVENT_LABELS: EVENT_LABELS,
    clean: clean,
    toNumberOrBlank: toNumberOrBlank,
    isNumericField: isNumericField,
    isInStock: isInStock,
    find: find,
    typeInfo: typeInfo,
    categoryOf: categoryOf,
    normalizeCode: normalizeCode,
    productLabel: productLabel,
    searchQuery: searchQuery,
    blankRecord: blankRecord,
    splitList: splitList,
    normalizeList: normalizeList,
    listHas: listHas,
    upgradeState: upgradeState,
    applyOp: applyOp,
    stats: {
      summary: summary,
      stockBy: stockBy,
      stockByList: stockByList,
      tagCounts: tagCounts,
      matchFacet: matchFacet,
      vintageHistogram: vintageHistogram,
      drinkWindows: drinkWindows,
      drinkWindowStatus: drinkWindowStatus,
      outByMonth: outByMonth,
      perUser: perUser,
      countBy: countBy
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = DrinkventoryLogic; }

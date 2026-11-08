/*
 * Statistics per category (wine, spirits, other) for the Stats tab.
 * Phone only: the backend does not use this file, so a change here needs no Apps Script update.
 * Facets: kinds that a tap on a bar or a map country turns into a Cellar filter.
 */
var DrinkStats = (function () {
  'use strict';

  var L = (typeof DrinkventoryLogic !== 'undefined') ? DrinkventoryLogic : require('./logic.js');
  var WM = (typeof WorldMap !== 'undefined') ? WorldMap : require('./worldmap.js');

  var NOT_SET = '(not set)';

  function clean(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function lower(v) { return clean(v).replace(/\s+/g, ' ').toLowerCase(); }

  function productMap(state) {
    var pm = {};
    state.products.forEach(function (p) { pm[String(p.product_id)] = p; });
    return pm;
  }

  /** In-stock bottles (open bottles included) of one category, with their product: [{ b, p }]. */
  function stock(state, cat) {
    var pm = productMap(state);
    var out = [];
    state.bottles.forEach(function (b) {
      if (!L.isInStock(b)) return;
      var p = pm[String(b.product_id)] || {};
      if (!cat || L.categoryOf(p.type) === cat) out.push({ b: b, p: p });
    });
    return out;
  }

  // ---------- keys per facet kind ----------
  // Each returns a list of { key, label } for one bottle; key '' means "not set".

  /** Country: the map key when the map knows the name, else the text itself. */
  function countryKeys(b, p) {
    var t = clean(p.country);
    if (!t) return [{ key: '', label: NOT_SET }];
    var k = WM.resolve(t);
    return [k ? { key: k, label: WM.nameOf(k) } : { key: 'raw:' + lower(t), label: t }];
  }

  function regionKeys(b, p) {
    var t = clean(p.region);
    return [t ? { key: lower(t), label: t } : { key: '', label: NOT_SET }];
  }

  /** Age in years from free text ("12", "12 years", "18yo"); "NAS" for no age statement. */
  function ageOf(p) {
    var t = lower(p.age);
    if (!t) return '';
    if (/\bnas\b|no age|ohne alter/.test(t)) return 'NAS';
    var m = t.match(/(^|\D)(\d{1,2})(?!\d)/);
    if (m && Number(m[2]) > 0) return String(Number(m[2]));
    return 'raw:' + t;
  }

  function ageKeys(b, p) {
    var a = ageOf(p);
    if (!a) return [{ key: '', label: NOT_SET }];
    if (a === 'NAS') return [{ key: 'NAS', label: 'NAS' }];
    if (a.indexOf('raw:') === 0) return [{ key: a, label: clean(p.age) }];
    return [{ key: a, label: a }];
  }

  // Cask families. A cask item can name several ("sherry and bourbon"); one bottle counts once per family.
  // "Wine" is left out when the item names a fortified wine ("Port wine cask" is Port).
  var CASKS = [
    ['Sherry', /sherry|oloroso|pedro xim|\bpx\b|\bfino\b|amontillado|manzanilla|palo cortado|jerez/],
    ['Port', /\bport\b|portwein|tawny|\bruby\b/],
    ['Madeira', /madeira/],
    ['Marsala', /marsala/],
    ['Wine', /wine|wein|\bvin\b|sauternes|bordeaux|burgund|barolo|tokaj|amarone|rioja|barrique|chardonnay|cabernet|pinot|moscatel|muscat/],
    ['Bourbon', /bourbon/],
    ['Rum', /\brum\b|\brhum\b/],
    ['Cognac / brandy', /cognac|armagnac|brandy|calvados/],
    ['Beer', /\bbeer\b|\bbier\b|stout|\bipa\b/],
    ['Mizunara', /mizunara/],
    ['Virgin / new oak', /virgin|new oak|\bstr\b|neue eiche/]
  ];
  var CASK_OTHER = 'Other';

  function caskFamilies(p) {
    var items = L.splitList(p.cask);
    var out = [];
    var FORTIFIED = ['Sherry', 'Port', 'Madeira', 'Marsala'];
    items.forEach(function (x) {
      var t = x.toLowerCase();
      var found = CASKS.filter(function (c) { return c[1].test(t); }).map(function (c) { return c[0]; });
      if (found.some(function (f) { return FORTIFIED.indexOf(f) >= 0; })) found = found.filter(function (f) { return f !== 'Wine'; });
      if (!found.length) found = [CASK_OTHER];
      found.forEach(function (f) { if (out.indexOf(f) < 0) out.push(f); });
    });
    return out;
  }

  function caskKeys(b, p) {
    var f = caskFamilies(p);
    if (!f.length) return [{ key: '', label: NOT_SET }];
    return f.map(function (x) { return { key: x, label: x }; });
  }

  var FACETS = {
    ctry: { title: 'Country', keys: countryKeys },
    region: { title: 'Region', keys: regionKeys },
    age: { title: 'Age', keys: ageKeys },
    cask: { title: 'Cask', keys: caskKeys }
  };

  /** Does a bottle belong to the slice kind=value? Only for the kinds in FACETS. */
  function match(kind, value, b, p) {
    var f = FACETS[kind];
    if (!f) return true;
    return f.keys(b, p || {}).some(function (x) { return x.key === value; });
  }

  /** Bottles per key: [{ key, label, n }], most first; "not set" last. */
  function tally(rows, kind) {
    var m = {};
    rows.forEach(function (r) {
      FACETS[kind].keys(r.b, r.p).forEach(function (x) {
        if (!m[x.key]) m[x.key] = { key: x.key, label: x.label, n: 0 };
        m[x.key].n += 1;
      });
    });
    return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) {
      return (a.key === '') - (b.key === '') || b.n - a.n || a.label.localeCompare(b.label);
    });
  }

  /** Bottles per age: numbers ascending, then NAS, other text, not set. */
  function ages(rows) {
    var rank = function (k) { return k === '' ? 3 : (k === 'NAS' ? 1 : (k.indexOf('raw:') === 0 ? 2 : 0)); };
    return tally(rows, 'age').sort(function (a, b) {
      return rank(a.key) - rank(b.key) || (rank(a.key) === 0 ? Number(a.key) - Number(b.key) : a.label.localeCompare(b.label));
    });
  }

  /** Per-category figures. */
  function summary(state, cat, now) {
    now = now || new Date();
    var rows = stock(state, cat);
    var products = {}; var locs = {}; var countries = {};
    rows.forEach(function (r) {
      products[String(r.b.product_id)] = true;
      if (r.b.location) locs[r.b.location] = true;
      var k = countryKeys(r.b, r.p)[0].key;
      if (k) countries[k] = true;
    });
    var pm = productMap(state);
    var cutoff = new Date(now.getTime() - 365 * 24 * 3600 * 1000);
    var out12m = state.bottles.filter(function (b) {
      return b.status === 'out' && b.out_at && new Date(b.out_at) >= cutoff &&
        L.categoryOf((pm[String(b.product_id)] || {}).type) === cat;
    }).length;
    var byType = {};
    rows.forEach(function (r) {
      var t = L.typeInfo(r.p.type);
      var label = t ? t.label : NOT_SET;
      byType[label] = (byType[label] || 0) + 1;
    });
    var types = Object.keys(byType).map(function (k) { return { key: k, n: byType[k] }; })
      .sort(function (a, b) { return b.n - a.n || a.key.localeCompare(b.key); });
    return {
      total: rows.length, products: Object.keys(products).length, locations: Object.keys(locs).length,
      countries: Object.keys(countries).length, out12m: out12m, types: types
    };
  }

  /** Category counts for the tab buttons. */
  function categoryCounts(state) {
    var out = { wine: 0, spirit: 0, other: 0 };
    stock(state, '').forEach(function (r) { out[L.categoryOf(r.p.type)] += 1; });
    return out;
  }

  /** Simple per-key counts for location, tag and type within a category: [{ key, n }]. */
  function countBy(rows, fn) {
    var m = {}; var label = {};
    rows.forEach(function (r) {
      var v = fn(r);
      (Array.isArray(v) ? v : [v]).forEach(function (x) {
        x = clean(x) || NOT_SET;
        var k = x.toLowerCase();
        if (!label[k]) label[k] = x;
        m[k] = (m[k] || 0) + 1;
      });
    });
    return Object.keys(m).map(function (k) { return { key: label[k], n: m[k] }; })
      .sort(function (a, b) { return (a.key === NOT_SET) - (b.key === NOT_SET) || b.n - a.n || a.key.localeCompare(b.key); });
  }

  /** Country texts the map does not know, with their bottle and product counts: [{ text, n, products }]. */
  function unknownCountries(state, cat) {
    var m = {};
    stock(state, cat).forEach(function (r) {
      var t = clean(r.p.country);
      if (!t || WM.resolve(t)) return;
      var k = t.toLowerCase();
      if (!m[k]) m[k] = { text: t, n: 0, ids: {} };
      m[k].n += 1;
      m[k].ids[String(r.p.product_id)] = true;
    });
    return Object.keys(m).map(function (k) { return { text: m[k].text, n: m[k].n, products: Object.keys(m[k].ids).length }; })
      .sort(function (a, b) { return b.n - a.n; });
  }

  /** Products whose country is this text (case and spaces ignored), any status. */
  function productsWithCountry(state, text) {
    var k = lower(text);
    return state.products.filter(function (p) { return lower(p.country) === k; });
  }

  return {
    NOT_SET: NOT_SET, CASK_OTHER: CASK_OTHER, FACETS: FACETS,
    stock: stock, tally: tally, ages: ages, ageOf: ageOf, caskFamilies: caskFamilies, match: match,
    summary: summary, categoryCounts: categoryCounts, countBy: countBy,
    unknownCountries: unknownCountries, productsWithCountry: productsWithCountry, countryKeys: countryKeys
  };
})();

if (typeof window !== 'undefined') { window.DrinkStats = DrinkStats; }
if (typeof module !== 'undefined' && module.exports) { module.exports = DrinkStats; }

/* Tests for docs/js/worldmap.js (country names, map view, SVG) and docs/js/stats.js (per-category statistics). */
'use strict';
const path = require('path');
const assert = require('assert/strict');

const root = path.join(__dirname, '..');
const WM = require(path.join(root, 'docs/js/worldmap.js'));
const DS = require(path.join(root, 'docs/js/stats.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n' + e.stack); process.exitCode = 1; }
}

console.log('world map and stats');

test('map data: shapes, names, no Antarctica, United Kingdom split for Scotch', () => {
  const keys = WM.data.units.map((u) => u.k);
  assert.ok(keys.length > 200);
  assert.ok(!keys.includes('ATA'));
  for (const k of ['SCT', 'ENG', 'WLS', 'NIR', 'IRL', 'FRA', 'DEU', 'ITA', 'USA', 'JPN', 'LBN', 'MTQ']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('GBR'), 'the UK is a group of four shapes');
  assert.deepEqual(WM.data.groups.GBR.units, ['ENG', 'SCT', 'WLS', 'NIR']);
  for (const u of WM.data.units) {
    assert.match(u.d, /^M[-\d.,]+l/, u.k);
    assert.ok(u.b[2] - u.b[0] < 400, u.k + ': box of the main part, not of the whole globe');
  }
});

test('country names in English, German, codes, with or without accents', () => {
  const cases = {
    France: 'FRA', Frankreich: 'FRA', Deutschland: 'DEU', Germany: 'DEU', 'Österreich': 'AUT', Oesterreich: 'AUT',
    Osterreich: 'AUT', Italien: 'ITA', Scotland: 'SCT', Schottland: 'SCT', ' scotland ': 'SCT', USA: 'USA',
    'United States': 'USA', 'United Kingdom': 'GBR', UK: 'GBR', 'Großbritannien': 'GBR', England: 'ENG',
    Irland: 'IRL', Ireland: 'IRL', Libanon: 'LBN', 'Südafrika': 'ZAF', Suedafrika: 'ZAF', Japan: 'JPN',
    Taiwan: 'TWN', Holland: 'NLD', Martinique: 'MTQ', DE: 'DEU', 'New Zealand': 'NZL', Neuseeland: 'NZL'
  };
  for (const [t, k] of Object.entries(cases)) assert.equal(WM.resolve(t), k, t);
  for (const t of ['', null, undefined, 'Islay', 'Kentucky', 'Scottland']) assert.equal(WM.resolve(t), '', String(t));
});

test('spelling suggestions for unknown names, none for regions', () => {
  assert.equal(WM.suggest('Scottland'), 'Scotland');
  assert.equal(WM.suggest('Frankriech'), 'France');
  assert.equal(WM.suggest('Germnay'), 'Germany');
  assert.equal(WM.suggest('Scotland'), 'Scotland');
  assert.equal(WM.suggest('Islay'), '');
  assert.equal(WM.suggest('Kentucky'), '');
});

test('colour classes and legend', () => {
  assert.deepEqual([1, 2, 3, 4, 6, 7, 12, 13, 99].map(WM.classOf), [1, 2, 2, 3, 3, 4, 4, 5, 5]);
  assert.deepEqual(WM.legend(1).map((l) => l.label), ['1']);
  assert.deepEqual(WM.legend(5).map((l) => l.label), ['1', '2–3', '4–6']);
  assert.deepEqual(WM.legend(40).map((l) => l.label), ['1', '2–3', '4–6', '7–12', '13+']);
});

test('view box: around the countries, minimum width, aspect between 1.25 and 2, inside the world', () => {
  for (const keys of [['DEU', 'ITA', 'FRA', 'ESP'], ['SCT'], ['LUX'], ['USA', 'SCT', 'IRL'], ['NZL', 'DEU'], []]) {
    const [x, y, w, h] = WM.fitBox(keys);
    assert.ok(w >= 110 || w === WM.data.w, keys + ': width');
    assert.ok(w / h >= 1.24 && w / h <= 2.01 || (w === WM.data.w && h === WM.data.h), keys + ': aspect ' + w / h);
    assert.ok(x >= 0 && y >= 0 && x + w <= WM.data.w + 0.1 && y + h <= WM.data.h + 0.1, keys + ': inside');
    for (const k of keys) {
      const u = WM.data.units.find((v) => v.k === k);
      assert.ok(u.b[0] >= x && u.b[2] <= x + w && u.b[1] >= y && u.b[3] <= y + h, k + ' in view');
    }
  }
  assert.deepEqual(WM.fitBox([]), [0, 0, WM.data.w, WM.data.h]);
});

test('SVG: tappable shapes and badges only for countries with bottles; the UK group colours four shapes', () => {
  const svg = WM.render([{ key: 'SCT', n: 7 }, { key: 'IRL', n: 1 }, { key: 'XXX', n: 3 }], { view: 'fit', px: 360 });
  assert.match(svg, /^<svg class="wm" viewBox="[\d. ]+"/);
  assert.equal((svg.match(/<path class="wm-u wm-k/g) || []).length, 2);
  assert.match(svg, /class="wm-u wm-k4"[^>]*data-value="SCT"/);
  assert.equal((svg.match(/<g class="wm-b"/g) || []).length, 2);
  assert.match(svg, /<title>Scotland: 7<\/title>/);
  const uk = WM.render([{ key: 'GBR', n: 2 }], { view: 'world' });
  assert.equal((uk.match(/data-value="GBR"/g) || []).length, 5, 'four shapes and one badge');
  assert.match(uk, /viewBox="0 0 1000 /);
});

test('badges that overlap are pushed apart and get a leader line', () => {
  const svg = WM.render([{ key: 'BEL', n: 3 }, { key: 'LUX', n: 2 }, { key: 'NLD', n: 4 }], { view: 'world', px: 360 });
  const pts = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"\/><text/g)].map((m) => m.slice(1).map(Number));
  assert.equal(pts.length, 3);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      assert.ok(d >= pts[i][2] + pts[j][2] - 0.05, 'badges ' + i + ',' + j + ' do not overlap');
    }
  }
  assert.ok(/class="wm-lead"/.test(svg));
});

// ---------- per-category statistics ----------

const state = {
  products: [
    { product_id: 'w1', type: 'white', country: 'Germany', region: 'Mosel' },
    { product_id: 'w2', type: 'red', country: 'Frankreich', region: 'Bordeaux' },
    { product_id: 's1', type: 'whisky', country: 'Scottland', region: 'Lowland', age: '13', cask: 'Bourbon' },
    { product_id: 's2', type: 'whisky', country: 'Scotland', region: 'Islay', age: 'NAS', cask: 'PX Sherry, Bourbon' },
    { product_id: 's3', type: 'whisky', country: 'Ireland', region: 'Cork', age: '15', cask: 'Bourbon, Sherry, Marsala' },
    { product_id: 's4', type: 'whisky', country: 'USA', region: 'kentucky', age: '7 years', cask: 'American Oak Red Wine' },
    { product_id: 's5', type: 'rum', country: '', age: '', cask: 'blend' },
    { product_id: 's6', type: 'whisky', country: 'scottland', age: '18', cask: 'sherry and bourbon' },
  ],
  bottles: [
    { bottle_id: '1', product_id: 'w1', status: 'in_stock' }, { bottle_id: '2', product_id: 'w1', status: 'in_stock' },
    { bottle_id: '3', product_id: 'w2', status: 'in_stock' }, { bottle_id: '4', product_id: 'w2', status: 'out', out_at: new Date().toISOString() },
    { bottle_id: '5', product_id: 's1', status: 'in_stock' }, { bottle_id: '6', product_id: 's2', status: 'open' },
    { bottle_id: '7', product_id: 's3', status: 'in_stock' }, { bottle_id: '8', product_id: 's4', status: 'in_stock' },
    { bottle_id: '9', product_id: 's5', status: 'in_stock' }, { bottle_id: '10', product_id: 's6', status: 'in_stock' },
    { bottle_id: '11', product_id: 's1', status: 'void' },
  ],
  events: [], settings: [],
};

test('stock per category: open spirits count, removed and taken-out bottles do not', () => {
  assert.equal(DS.stock(state, 'wine').length, 3);
  assert.equal(DS.stock(state, 'spirit').length, 6);
  assert.deepEqual(DS.categoryCounts(state), { wine: 3, spirit: 6, other: 0 });
});

test('summary per category', () => {
  const w = DS.summary(state, 'wine');
  assert.deepEqual([w.total, w.products, w.countries, w.out12m], [3, 2, 2, 1]);
  assert.deepEqual(w.types, [{ key: 'White wine', n: 2 }, { key: 'Red wine', n: 1 }]);
  const s = DS.summary(state, 'spirit');
  assert.equal(s.countries, 4, 'Scotland, Ireland, USA and the unknown "Scottland"');
  assert.equal(s.out12m, 0);
});

test('countries: German and English names merge, unknown names stay as typed, not set last', () => {
  const w = DS.tally(DS.stock(state, 'wine'), 'ctry');
  assert.deepEqual(w.map((x) => [x.key, x.label, x.n]), [['DEU', 'Germany', 2], ['FRA', 'France', 1]]);
  const s = DS.tally(DS.stock(state, 'spirit'), 'ctry');
  assert.deepEqual(s.map((x) => [x.key, x.label, x.n]), [
    ['raw:scottland', 'Scottland', 2], ['IRL', 'Ireland', 1], ['SCT', 'Scotland', 1], ['USA', 'USA', 1], ['', '(not set)', 1]]);
  assert.deepEqual(DS.unknownCountries(state, 'spirit'), [{ text: 'Scottland', n: 2, products: 2 }]);
  assert.deepEqual(DS.productsWithCountry(state, ' SCOTTLAND ').map((p) => p.product_id), ['s1', 's6']);
});

test('ages: numbers ascending, then NAS, then not set', () => {
  const a = DS.ages(DS.stock(state, 'spirit'));
  assert.deepEqual(a.map((x) => [x.key, x.n]), [['7', 1], ['13', 1], ['15', 1], ['18', 1], ['NAS', 1], ['', 1]]);
  assert.equal(DS.ageOf({ age: '1998' }), 'raw:1998', 'a year is not an age');
  assert.equal(DS.ageOf({ age: '18yo' }), '18');
});

test('casks: families, several per bottle, fortified wine is not "Wine"', () => {
  assert.deepEqual(DS.caskFamilies({ cask: 'PX Sherry, Bourbon' }), ['Sherry', 'Bourbon']);
  assert.deepEqual(DS.caskFamilies({ cask: 'Bourbon, Sherry, Marsala' }), ['Bourbon', 'Sherry', 'Marsala']);
  assert.deepEqual(DS.caskFamilies({ cask: 'American Oak Red Wine' }), ['Wine']);
  assert.deepEqual(DS.caskFamilies({ cask: 'sherry and bourbon' }), ['Sherry', 'Bourbon']);
  assert.deepEqual(DS.caskFamilies({ cask: 'Tawny Port wine finish' }), ['Port']);
  assert.deepEqual(DS.caskFamilies({ cask: 'blend' }), ['Other']);
  assert.deepEqual(DS.caskFamilies({ cask: '' }), []);
  const c = DS.tally(DS.stock(state, 'spirit'), 'cask');
  assert.deepEqual(c.map((x) => [x.key, x.n]), [['Bourbon', 4], ['Sherry', 3], ['Marsala', 1], ['Other', 1], ['Wine', 1]]);
});

test('facets match the same bottles that the charts count', () => {
  const rows = DS.stock(state, 'spirit');
  for (const kind of ['ctry', 'region', 'age', 'cask']) {
    for (const t of DS.tally(rows, kind)) {
      const n = rows.filter((r) => DS.match(kind, t.key, r.b, r.p)).length;
      assert.equal(n, t.n, kind + ' ' + t.key);
    }
  }
  assert.ok(DS.match('region', 'kentucky', {}, { region: 'Kentucky' }), 'region ignores case');
});

console.log(passed + ' passed');

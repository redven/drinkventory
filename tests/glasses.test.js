/* Tests for docs/js/glasses.js (RIEDEL glass recommendation) with the generated guide data. */
'use strict';
const path = require('path');
const assert = require('assert/strict');

const root = path.join(__dirname, '..');
const G = require(path.join(root, 'docs/js/glasses.js'));
const GUIDE = require(path.join(root, 'docs/js/glasses-data.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const rec = (p) => G.recommend(Object.assign({ type: 'white', grapes: '', name: '', producer: '', region: '', country: '' }, p));

console.log('glasses');

test('guide data is loaded and every alias points to an entry that was looked up', () => {
  assert.ok(Object.keys(GUIDE.entries).length > 50);
  const missing = [...new Set(Object.values(G.ALIASES))].filter((e) => !(e in GUIDE.entries));
  assert.deepEqual(missing, [], 'aliases without a guide entry');
});

test('every entry with a shape has a riedel.com URL and its glasses', () => {
  for (const [name, e] of Object.entries(GUIDE.entries)) {
    if (!e.shape) continue;
    assert.match(e.url, /^https:\/\/www\.riedel\.com\//, name);
    assert.ok(e.glasses.length > 0, name);
    assert.ok(!e.glasses.some((g) => /grape@riedel/i.test(g)), name + ': wine-friendly glasses removed');
  }
});

test('grape list: percentages decide the order, otherwise as listed', () => {
  assert.deepEqual(G.grapeList({ grapes: 'Kerner 20%, Souvignier Gris 50%, Goldmuskateller 30%' }).map((g) => g.name),
    ['Souvignier Gris', 'Goldmuskateller', 'Kerner']);
  assert.deepEqual(G.grapeList({ grapes: 'Merlot, Cabernet Sauvignon' }).map((g) => g.name), ['Merlot', 'Cabernet Sauvignon']);
  assert.deepEqual(G.grapeList({ grapes: 'Pinot Noir (Spätburgunder) 60,5 %, Pinot Meunier' }).map((g) => [g.name, g.pct]),
    [['Pinot Noir', 60.5], ['Pinot Meunier', null]]);
  assert.deepEqual(G.grapeList({ grapes: '' }), []);
});

test('synonyms: German, Italian and Spanish names find the RIEDEL entry', () => {
  const entryOf = (grapes, extra) => rec(Object.assign({ grapes }, extra)).entry;
  assert.equal(entryOf('Lemberger', { type: 'red' }), 'Blaufränkisch');
  assert.equal(entryOf('Monastrell', { type: 'red' }), 'Mourvèdre');
  assert.equal(entryOf('Tinta Roriz', { type: 'red' }), 'Tempranillo');
  assert.equal(entryOf('Goldmuskateller'), 'Muskateller');
  assert.equal(entryOf('Turbiana'), 'Verdicchio');
  assert.equal(entryOf('Riesling Italico'), 'Welschriesling', 'not Riesling');
  assert.equal(entryOf('Spätburgunder', { type: 'red' }), 'Pinot Noir Old World');
});

test('RIEDEL pages without glasses: same-grape page if there is one, else no glass', () => {
  const mt = rec({ grapes: 'Müller-Thurgau' });
  assert.equal(mt.entry, 'Rivaner');
  assert.match(mt.note, /no glasses on its Müller-Thurgau page; this uses its Rivaner page/);
  assert.equal(rec({ type: 'red', grapes: 'Garnacha' }).entry, 'Cannonau');
  assert.equal(rec({ grapes: 'Gewürztraminer' }).entry, 'Gewürztraminer', 'own page found on retry');
  for (const g of ['Silvaner', 'Pinot Bianco', 'Grauburgunder', 'Weißburgunder']) {
    const r = rec({ grapes: g });
    assert.equal(r.shape, null, g + ': RIEDEL lists no glass');
    assert.deepEqual(r.unmatched, [g]);
  }
  const zw = rec({ type: 'red', grapes: 'Zweigelt' });
  assert.equal(zw.shape, null);
});

test('Merlot: from the RIEDEL glasses named for it, and marked as such', () => {
  const r = rec({ type: 'red', grapes: 'Merlot, Cabernet Sauvignon' });
  assert.equal(r.entry, 'Merlot');
  assert.equal(r.shape, 'Cabernet / Merlot');
  assert.match(r.note, /listed first/);
  assert.match(r.note, /guide page for Merlot shows no glasses; these RIEDEL glasses carry its name/);
  assert.equal(GUIDE.entries['Merlot'].source, 'glass-name');
  assert.equal(GUIDE.entries['Riesling'].source, 'guide');
});

test('Pinot Noir and Syrah: old world by default, new world by country', () => {
  assert.equal(rec({ type: 'red', grapes: 'Pinot Noir' }).shape, 'Pinot Noir / Nebbiolo');
  assert.equal(rec({ type: 'red', grapes: 'Spätburgunder', country: 'Germany' }).entry, 'Pinot Noir Old World');
  assert.equal(rec({ type: 'red', grapes: 'Pinot Noir', country: 'New Zealand' }).entry, 'Pinot Noir New World');
  assert.equal(rec({ type: 'red', grapes: 'Shiraz', country: 'Australia' }).entry, 'Shiraz New World');
  assert.equal(rec({ type: 'red', grapes: 'Syrah', country: 'France' }).entry, 'Syrah Old World');
});

test('Chardonnay: unoaked entry with the oaked glass as alternative', () => {
  const r = rec({ grapes: 'Chardonnay' });
  assert.equal(r.entry, 'Chardonnay (unoaked)');
  assert.equal(r.alt.entry, 'Chardonnay (oaked)');
  assert.equal(r.alt.when, 'if aged in oak');
});

test('blends: first matching grape decides, unknown grapes are reported', () => {
  const r = rec({ grapes: 'Souvignier Gris 50%, Goldmuskateller 30%, Kerner 20%' });
  assert.equal(r.from, 'Goldmuskateller');
  const typo = rec({ grapes: 'Souvignier Gris 50%, Goldmuskatelle 30%' });
  assert.equal(typo.from, 'Goldmuskateller', 'corrected name, not the typo');
  assert.match(typo.note, /Goldmuskateller is the next grape by share\. Read "Goldmuskatelle" as Goldmuskateller\./);
  assert.deepEqual(r.unmatched, ['Souvignier Gris']);
  assert.match(r.note, /no glass for Souvignier Gris; Goldmuskateller is the next grape by share/);
  assert.doesNotMatch(r.note, /largest share/);
  const b = rec({ type: 'red', grapes: 'Cabernet Franc, Merlot' });
  assert.equal(b.from, 'Cabernet Franc');
  assert.match(b.note, /listed first/);
});

test('typos: one letter off in a long grape name is read as the known name', () => {
  const r = rec({ grapes: 'Rieslng' });
  assert.equal(r.entry, 'Riesling');
  assert.match(r.note, /Read "Rieslng" as Riesling\./);
  assert.match(rec({ type: 'red', grapes: 'Spätbugunder' }).note, /as Spätburgunder\./);
  assert.match(rec({ grapes: 'Goldmuskatelle' }).note, /as Goldmuskateller\./);
  assert.equal(rec({ type: 'red', grapes: 'Merlo' }).shape, null, 'short names need an exact match');
  assert.equal(rec({ grapes: 'Pinot Gris' }).shape, null, 'no fuzzy jump to Pinot Grigio data');
});

test('no match: null shape, grapes listed, link to the guide', () => {
  const r = rec({ grapes: 'Souvignier Gris' });
  assert.equal(r.shape, null);
  assert.deepEqual(r.unmatched, ['Souvignier Gris']);
  assert.match(r.url, /riedel\.com/);
  assert.equal(rec({ grapes: '' }).shape, null);
  assert.equal(G.shapeOf({ type: 'white', grapes: 'Souvignier Gris' }), '');
});

test('styles: sparkling, sweet, fortified and rosé ignore the grapes', () => {
  assert.equal(rec({ type: 'sparkling', name: 'Cava Carta Rotiña', region: 'Cava', country: 'Spain' }).entry, 'Cava');
  assert.equal(rec({ type: 'sparkling', producer: 'Pierre Péters', region: 'Champagne', country: 'France', grapes: 'Chardonnay' }).entry, 'Champagne');
  assert.equal(rec({ type: 'sparkling', name: 'Brut Rosé', region: 'Champagne', country: 'France' }).entry, 'Rosé Champagne');
  assert.equal(rec({ type: 'sparkling', name: 'Riesling Sekt brut', country: 'Germany', grapes: 'Riesling' }).entry, 'Sekt');
  assert.equal(rec({ type: 'sparkling', name: 'Ammonites Dosaggio Zero', region: 'Lombardy', country: 'Italy' }).entry, 'Sparkling Wine');
  const ice = rec({ type: 'sweet', name: 'Riesling Eiswein', grapes: 'Riesling' });
  assert.equal(ice.entry, 'Dessertwine', 'RIEDEL ice wine page is empty: dessert wine page');
  assert.equal(ice.from, 'Ice wine');
  assert.match(ice.note, /Ice wine page/);
  assert.equal(rec({ type: 'sweet', name: 'Château X', region: 'Sauternes' }).entry, 'Sauternes');
  assert.equal(rec({ type: 'fortified', name: '20 Year Old Tawny', country: 'Portugal' }).entry, 'Tawny Port');
  assert.equal(rec({ type: 'fortified', name: 'Vintage Port 2011', country: 'Portugal', region: 'Douro' }).entry, 'Vintage Port');
  assert.equal(rec({ type: 'fortified', name: 'Fino', region: 'Jerez' }).entry, 'Sherry');
  assert.equal(rec({ type: 'rose', grapes: 'Grenache' }).entry, 'Rosé');
});

const VELOCE4 = ['Veloce Cabernet / Merlot', 'Veloce Riesling', 'Veloce Pinot Noir / Nebbiolo', 'Veloce Chardonnay'];
const mine = (p) => G.yourGlass(Object.assign({ type: 'white', grapes: '', name: '', producer: '', region: '', country: 'Germany' }, p), VELOCE4);

test('own glasses: collections and shapes come from the RIEDEL data', () => {
  const veloce = G.collections().find((c) => c.collection === 'Veloce');
  assert.ok(veloce, 'Veloce collection');
  for (const g of VELOCE4) assert.ok(veloce.glasses.includes(g), g);
  assert.deepEqual(G.glassInfo('Veloce Chardonnay').shapes, ['Oaked Chardonnay'], 'plain "Chardonnay" glass is the oaked shape');
  assert.deepEqual(G.glassInfo('veloce cabernet/merlot').shapes, ['Cabernet / Merlot'], 'lookup ignores case and slash spacing');
  assert.ok(!G.collections().some((c) => c.glasses.some((g) => /\+|decanter|\bset\b/i.test(g))), 'no sets or decanters to pick');
});

test('own glasses: RIEDEL-listed glass first, then same shape, then a shape RIEDEL lists', () => {
  let y = mine({ grapes: 'Scheurebe' });
  assert.deepEqual([y.main.glass, y.main.how], ['Veloce Riesling', 'listed']);
  y = mine({ type: 'red', grapes: 'Merlot, Cabernet Sauvignon' });
  assert.deepEqual([y.main.glass, y.main.how], ['Veloce Cabernet / Merlot', 'listed']);
  y = mine({ type: 'red', grapes: 'Spätburgunder' });
  assert.equal(y.main.glass, 'Veloce Pinot Noir / Nebbiolo');
  y = mine({ grapes: 'Riesling' });
  assert.deepEqual([y.main.glass, y.main.how], ['Veloce Riesling', 'shape'], 'RIEDEL Riesling page list is cut before Veloce');
  y = mine({ grapes: 'Sauvignon Blanc' });
  assert.deepEqual([y.main.glass, y.main.how, y.main.riedel], ['Veloce Riesling', 'related', 'Veloce Sauvignon Blanc']);
  y = mine({ grapes: 'Chardonnay' });
  assert.equal(y.main.glass, 'Veloce Riesling', 'unoaked');
  assert.equal(y.alt.glass, 'Veloce Chardonnay', 'if aged in oak');
});

test('own glasses: none fits, RIEDEL glass named; no RIEDEL entry: null', () => {
  let y = mine({ type: 'red', grapes: 'Sangiovese' });
  assert.deepEqual([y.main.glass, y.main.how, y.main.riedel], [null, 'none', 'Veloce Syrah / Shiraz']);
  y = mine({ type: 'sparkling', name: 'Cava Brut', region: 'Cava' });
  assert.deepEqual([y.main.glass, y.main.riedel], [null, 'Veloce Champagne Wine Glass']);
  assert.equal(mine({ grapes: 'Silvaner' }), null);
  assert.equal(G.yourGlass({ type: 'white', grapes: 'Riesling' }, []), null, 'no set: no own glass');
});

test('spirits get no recommendation', () => {
  assert.equal(G.recommend({ type: 'whisky', grapes: '' }), null);
  assert.equal(G.shapeOf({ type: 'rum' }), '');
});

module.exports = { passed: () => passed };
if (require.main === module) console.log(`glasses: ${passed} passed`);

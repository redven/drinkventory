/* Runs Code.gs + Logic.gs inside a mocked Apps Script environment. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const { createGas } = require('./gas-mock');

const root = path.join(__dirname, '..');
const logicSrc = fs.readFileSync(path.join(root, 'docs/js/logic.js'), 'utf8');
const codeSrc = fs.readFileSync(path.join(root, 'apps-script/Code.gs'), 'utf8');
const ClientLogic = require(path.join(root, 'docs/js/logic.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n' + e.stack); process.exitCode = 1; }
}

const gas = createGas();
const ctx = vm.createContext(gas.env);
vm.runInContext(logicSrc + '\n' + codeSrc, ctx, { filename: 'gas.js' });
const G = (name) => ctx[name];

function post(body) {
  const out = G('doPost')({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(out.content);
}
function get(params) {
  return JSON.parse(G('doGet')({ parameter: params }).content);
}
function sheetRows(name) {
  const sh = gas.state.sheets[name];
  const lr = sh.getLastRow(); const lc = sh.getLastColumn();
  if (lr < 2) return [];
  return sh.getRange(2, 1, lr - 1, lc).getValues();
}
function header(name) {
  const sh = gas.state.sheets[name];
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
}

let n = 0;
const ts0 = Date.parse('2026-10-20T18:00:00Z');
function op(kind, data, user = 'Stefan') {
  n += 1;
  return { op_id: 'op-' + n, kind, ts: new Date(ts0 + n * 60000).toISOString(), user, data };
}

console.log('backend');
test('apps-script/Logic.gs is identical to docs/js/logic.js', () => {
  assert.equal(fs.readFileSync(path.join(root, 'apps-script/Logic.gs'), 'utf8'), logicSrc);
});

test('CODE_VERSION in Code.gs equals VERSION in logic.js', () => {
  const m = codeSrc.match(/var CODE_VERSION = '([^']+)';/);
  assert.ok(m, 'CODE_VERSION missing in Code.gs');
  assert.equal(m[1], ClientLogic.VERSION, 'raise both versions together');
});

test('version check names the out-of-date file', () => {
  const V = ClientLogic.VERSION;
  const st = (r) => ClientLogic.backendStatus(r);
  assert.equal(st({ version: V, code_version: V }), null, 'match');
  assert.equal(st({}), null, 'no version info: no warning');
  // backend before 2.1.1: Code.gs reports nothing
  let x = st({ version: '2.0.0' });
  assert.match(x.text, /Code\.gs older than 2\.1\.1, Logic\.gs 2\.0\.0/);
  assert.match(x.text, /replace both Code\.gs and Logic\.gs/);
  assert.equal(x.appIsOlder, false);
  // the trap: only Logic.gs replaced
  x = st({ version: V });
  assert.match(x.text, /Code\.gs older than 2\.1\.1, Logic\.gs /);
  // only Code.gs replaced
  x = st({ version: '2.1.0', code_version: V });
  assert.match(x.text, new RegExp('Code\\.gs ' + V.replace(/\./g, '\\.') + ', Logic\\.gs 2\\.1\\.0'));
  // backend newer than the cached app
  x = st({ version: '9.0.0', code_version: '9.0.0' });
  assert.equal(x.appIsOlder, true);
  assert.match(x.text, /open it again/);
  assert.equal(ClientLogic.compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(ClientLogic.compareVersions('2.1', '2.1.0'), 0);
});
let KEY, SENSOR;
const clientState = { products: [], bottles: [], events: [] };
const allOps = [];

test('setup creates tabs, headers, keys, photo folder', () => {
  const keys = G('setup')();
  KEY = keys.apiKey; SENSOR = keys.sensorKey;
  assert.ok(KEY && KEY.length >= 32);
  assert.notEqual(KEY, SENSOR);
  for (const t of ['products', 'bottles', 'events', 'ops', 'climate']) {
    assert.deepEqual(header(t), ClientLogic.SCHEMA[t], t + ' header');
  }
  assert.ok(gas.state.props.PHOTO_FOLDER_ID);
  // setup is idempotent
  const again = G('setup')();
  assert.equal(again.apiKey, KEY);
});

test('unauthorized requests are rejected', () => {
  assert.equal(post({ action: 'ping', key: 'wrong' }).ok, false);
  assert.equal(post({ action: 'sync', key: SENSOR, ops: [] }).ok, false, 'sensor key cannot sync');
  const ping = post({ action: 'ping', key: KEY });
  assert.equal(ping.ok, true);
  assert.equal(ClientLogic.backendStatus(ping), null, 'ping reports matching versions');
  assert.equal(ClientLogic.backendStatus(get({})), null, 'GET ping too');
  assert.equal(ClientLogic.backendStatus(post({ action: 'sync', key: KEY, ops: [] })), null, 'sync too');
});

test('sync: product, photo, bottle with leading zeros', () => {
  const ops = [
    op('upsert_product', { product_id: 'p1', type: 'white', producer: 'Keller', name: 'Riesling GG', vintage: '2019',
      country: 'Germany', region: 'Rheinhessen', abv: '12,5', volume_ml: 750, drink_from: 2024, drink_to: 2035, price_paid: 99 }),
    op('photo', { product_id: 'p1', data: 'data:image/jpeg;base64,' + Buffer.from('fakejpeg').toString('base64') }),
    op('create_bottle', { bottle_id: '000123', product_id: 'p1', location: 'Rack A3', acquired_date: '2026-10-01', source: ' Weinhandlung Erlangen ' }),
    op('create_bottle', { bottle_id: ' 000124 ', product_id: 'p1', location: 'Rack A3', acquired_date: '2026-10-01' })
  ];
  const res = post({ action: 'sync', key: KEY, ops });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.results.map((r) => r.status), ['applied', 'applied', 'applied', 'applied']);
  const photoId = res.results[1].photo_id;
  assert.ok(photoId && photoId.startsWith('file-'));
  // mirror on client side (photo becomes set_photo with the server id)
  ops.forEach((o) => {
    const c = o.kind === 'photo' ? { ...o, kind: 'set_photo', data: { product_id: 'p1', photo_id: photoId } } : o;
    assert.equal(ClientLogic.applyOp(clientState, c).status, 'applied');
    allOps.push(o);
  });
  const b = res.snapshot.bottles.find((x) => x.bottle_id === '000123');
  assert.equal(b.status, 'in_stock');
  assert.equal(b.acquired_date, '2026-10-01');
  assert.equal(b.tags, 'Weinhandlung Erlangen', 'older "source" field becomes a trimmed tag');
  assert.ok(!('price_paid' in b), 'no price field');
  assert.ok(res.snapshot.bottles.find((x) => x.bottle_id === '000124'), 'code trimmed');
  const p = res.snapshot.products[0];
  assert.equal(p.vintage, '2019');
  assert.equal(p.abv, 12.5, 'decimal comma parsed');
  assert.equal(p.photo_id, photoId);
  assert.ok(!('price_paid' in p), 'unknown fields are ignored');
});

test('stored cells keep types (text IDs, ISO dates, numbers)', () => {
  const hb = header('bottles');
  const rows = sheetRows('bottles');
  const r = rows.find((x) => x[hb.indexOf('bottle_id')] === '000123');
  assert.ok(r, 'bottle_id stored as text "000123"');
  assert.equal(typeof r[hb.indexOf('acquired_date')], 'string');
  const hp = header('products');
  assert.equal(sheetRows('products')[0][hp.indexOf('vintage')], '2019');
  assert.equal(sheetRows('products')[0][hp.indexOf('abv')], 12.5);
});

test('duplicate ops are ignored, errors are logged once', () => {
  const dupe = allOps[2];
  const clash = op('create_bottle', { bottle_id: '000123', product_id: 'p1' });
  const res = post({ action: 'sync', key: KEY, ops: [dupe, clash] });
  assert.equal(res.results[0].status, 'duplicate');
  assert.equal(res.results[1].status, 'error');
  assert.match(res.results[1].error, /already in use/);
  assert.equal(sheetRows('bottles').length, 2);
  const res2 = post({ action: 'sync', key: KEY, ops: [clash] });
  assert.equal(res2.results[0].status, 'duplicate', 'failed op not retried');
  const opsRows = sheetRows('ops');
  assert.equal(opsRows.length, 5);
});

test('bottle lifecycle: move, take out, back in stock, remove, reuse sticker', () => {
  const ops = [
    op('event', { type: 'move', bottle_id: '000123', location: '=Fridge' }),
    op('event', { type: 'out', bottle_id: '000123' }, 'Partner'),
    op('event', { type: 'restore', bottle_id: '000123' }),
    op('event', { type: 'out', bottle_id: '000123' }),
    op('update_bottle', { bottle_id: '000124', location: 'Rack B' }),
    op('update_bottle', { bottle_id: '000124', tags: ' Gift from Anna ,vacation,, gift from anna ' })
  ];
  const res = post({ action: 'sync', key: KEY, ops });
  assert.deepEqual(res.results.map((r) => r.status), ['applied', 'applied', 'applied', 'applied', 'applied', 'applied']);
  assert.equal(res.snapshot.bottles.find((x) => x.bottle_id === '000124').tags, 'Gift from Anna, vacation', 'tags trimmed, duplicates dropped');
  assert.equal(res.snapshot.events.find((e) => e.event_id === ops[5].op_id).type, 'edit', 'tag change logs as edit');
  ops.forEach((o) => { ClientLogic.applyOp(clientState, o); allOps.push(o); });
  const b = res.snapshot.bottles.find((x) => x.bottle_id === '000123');
  assert.equal(b.status, 'out');
  assert.equal(b.location, '=Fridge', 'formula-like text round-trips as plain text');
  assert.ok(b.out_at);
  const types = res.snapshot.events.filter((e) => e.bottle_id === '000123').map((e) => e.type);
  assert.deepEqual(types, ['intake', 'move', 'out', 'restore', 'out']);
  assert.equal(res.snapshot.events.find((e) => e.event_id === ops[4].op_id).type, 'move', 'location-only edit logs as move');
  const again = post({ action: 'sync', key: KEY, ops: [op('event', { type: 'out', bottle_id: '000123' })] });
  assert.equal(again.results[0].status, 'error');
  assert.match(again.results[0].error, /not in stock/);
  const back = post({ action: 'sync', key: KEY, ops: [op('event', { type: 'restore', bottle_id: '000124' })] });
  assert.match(back.results[0].error, /not taken out/);
  const old = post({ action: 'sync', key: KEY, ops: [op('event', { type: 'open', bottle_id: '000124' })] });
  assert.match(old.results[0].error, /unknown event type/);
});

test('removed sticker can be reused for another product', () => {
  const ops = [
    op('upsert_product', { product_id: 'p2', type: 'whisky', distillery: 'Springbank', name: '10', age: '10' }),
    op('create_bottle', { bottle_id: 'X-9', product_id: 'p1', location: 'Rack A3' }),
    op('event', { type: 'void', bottle_id: 'x-9' }),
    op('create_bottle', { bottle_id: 'x-9', product_id: 'p2', location: 'Cabinet' })
  ];
  const res = post({ action: 'sync', key: KEY, ops });
  assert.ok(res.results.every((r) => r.status === 'applied'), JSON.stringify(res.results));
  ops.forEach((o) => { ClientLogic.applyOp(clientState, o); allOps.push(o); });
  const b = res.snapshot.bottles.filter((x) => x.bottle_id === 'X-9');
  assert.equal(b.length, 1);
  assert.equal(b[0].product_id, 'p2');
  assert.equal(b[0].status, 'in_stock');
});

test('user-added sheet column survives updates', () => {
  const sh = gas.state.sheets.bottles;
  const col = sh.getLastColumn() + 1;
  sh.set(1, col, 'my_comment');
  const hb = header('bottles');
  const rowIdx = sheetRows('bottles').findIndex((x) => x[hb.indexOf('bottle_id')] === '000124') + 2;
  sh.set(rowIdx, col, 'keep me');
  const o = op('event', { type: 'move', bottle_id: '000124', location: 'Rack B1' });
  const res = post({ action: 'sync', key: KEY, ops: [o] });
  assert.equal(res.results[0].status, 'applied');
  ClientLogic.applyOp(clientState, o); allOps.push(o);
  assert.equal(sh.get(rowIdx, col), 'keep me');
  assert.equal(sh.get(rowIdx, hb.indexOf('location') + 1), 'Rack B1');
  assert.ok(!('my_comment' in res.snapshot.bottles[0]), 'snapshot stripped to schema');
});

test('tags: rename merges, delete removes, on every bottle', () => {
  const ops = [
    op('create_bottle', { bottle_id: '000200', product_id: 'p1', location: 'Rack C', tags: 'Vacation, michi' }),
    op('rename_tag', { from: 'VACATION', to: 'Holiday' }),
    op('rename_tag', { from: 'michi', to: 'holiday' }),
    op('rename_tag', { from: 'gift from anna', to: '' }),
    op('rename_tag', { from: '', to: 'x' })
  ];
  const res = post({ action: 'sync', key: KEY, ops });
  assert.deepEqual(res.results.map((r) => r.status), ['applied', 'applied', 'applied', 'applied', 'error']);
  const tags = (id) => res.snapshot.bottles.find((x) => x.bottle_id === id).tags;
  assert.equal(tags('000200'), 'Holiday', 'renamed, then merged into the existing name');
  assert.equal(tags('000124'), 'Holiday', 'deleted tag gone, renamed tag kept');
  assert.equal(tags('000123'), 'Weinhandlung Erlangen', 'untouched');
  ops.slice(0, 4).forEach((o) => { assert.equal(ClientLogic.applyOp(clientState, o).status, 'applied'); allOps.push(o); });
});

test('server snapshot equals client state after round trip', () => {
  const res = post({ action: 'sync', key: KEY, ops: [] });
  const norm = (s) => JSON.parse(JSON.stringify({
    products: s.products.map((x) => ClientLogic.SCHEMA.products.reduce((o, f) => (o[f] = x[f], o), {})),
    bottles: s.bottles.map((x) => ClientLogic.SCHEMA.bottles.reduce((o, f) => (o[f] = x[f], o), {})),
    events: s.events.map((x) => ClientLogic.SCHEMA.events.reduce((o, f) => (o[f] = x[f], o), {}))
  }));
  assert.deepEqual(norm(res.snapshot), norm(clientState));
});

test('photo_get serves only files from the photo folder', () => {
  const pid = clientState.products[0].photo_id;
  const ok = post({ action: 'photo_get', key: KEY, photo_id: pid });
  assert.equal(ok.ok, true);
  assert.equal(Buffer.from(ok.data.split(',')[1], 'base64').toString(), 'fakejpeg');
  const denied = post({ action: 'photo_get', key: KEY, photo_id: 'ss1' });
  assert.equal(denied.ok, false);
  // same photo op twice does not create a second file
  const before = Object.keys(gas.state.files).length;
  G('savePhoto_')(allOps[1].op_id, allOps[1].data.data);
  assert.equal(Object.keys(gas.state.files).length, before);
});

test('sheet grows beyond max rows', () => {
  gas.state.sheets.events.maxRows = gas.state.sheets.events.getLastRow();
  const ops = [];
  for (let i = 0; i < 5; i++) ops.push(op('event', { type: 'move', bottle_id: '000124', location: 'Shelf ' + i }));
  const res = post({ action: 'sync', key: KEY, ops });
  assert.ok(res.results.every((r) => r.status === 'applied'));
  ops.forEach((o) => { ClientLogic.applyOp(clientState, o); allOps.push(o); });
});

test('climate: POST with sensor key, duplicates, ranges, GET webhook', () => {
  const now = Date.now();
  const res = post({ action: 'climate', key: SENSOR, readings: [
    { reading_id: 'r1', sensor: 'cellar', temp_c: 12.3, rh_pct: 68 },
    { reading_id: 'r1', sensor: 'cellar', temp_c: 12.3, rh_pct: 68 },
    { reading_id: 'r2', sensor: 'cellar', temp_c: 99, rh_pct: 68 },
    { reading_id: 'r3', sensor: 'cellar', ts: new Date(now - 3600e3).toISOString(), temp_c: 12.0, rh_pct: 70, battery_pct: 88 }
  ] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.stored, 2);
  assert.equal(res.duplicates, 1);
  assert.equal(res.errors.length, 1);
  const again = post({ action: 'climate', key: SENSOR, readings: [{ reading_id: 'r3', temp_c: 1 }] });
  assert.equal(again.stored, 0);
  const g = get({ action: 'climate', key: SENSOR, sensor: 'shelly', temp: '13.1', hum: '65' });
  assert.equal(g.ok, true);
  assert.equal(get({ action: 'climate', key: 'nope', temp: '1' }).ok, false);
  assert.equal(post({ action: 'climate_get', key: SENSOR, days: 1 }).ok, false, 'sensor key cannot read');
});

test('climate_get aggregates and returns latest per sensor', () => {
  const raw = post({ action: 'climate_get', key: KEY, days: 1 });
  assert.equal(raw.bucket, 'raw');
  assert.equal(raw.series.length, 3);
  assert.equal(raw.latest.cellar.temp_c, 12.3);
  assert.equal(raw.latest.shelly.rh_pct, 65);
  const hourly = post({ action: 'climate_get', key: KEY, days: 7 });
  assert.equal(hourly.bucket, 'hour');
  assert.ok(hourly.series.every((s) => s.n >= 1 && s.temp !== ''));
  assert.equal(hourly.limits.temp_max, 18);
});

test('climate alerts mail once per state change', () => {
  gas.state.mail.length = 0;
  let s = G('checkClimate')();
  assert.equal(s, 'ok');
  assert.equal(gas.state.mail.length, 0);
  post({ action: 'climate', key: SENSOR, readings: [{ reading_id: 'hot1', sensor: 'cellar', temp_c: 21, rh_pct: 60 }] });
  s = G('checkClimate')();
  assert.equal(s, 'cellar:temp-high');
  assert.equal(gas.state.mail.length, 1);
  G('checkClimate')();
  assert.equal(gas.state.mail.length, 1, 'no repeat mail');
  post({ action: 'climate', key: SENSOR, readings: [{ reading_id: 'ok1', sensor: 'cellar', temp_c: 13, rh_pct: 65 }] });
  G('checkClimate')();
  assert.equal(gas.state.mail.length, 2);
  assert.match(gas.state.mail[1].subject, /back in range/);
  G('installClimateAlerts')();
  G('installClimateAlerts')();
  assert.equal(gas.state.triggers.length, 1);
});

test('stats: grapes and tags count per item, slices match bottles', () => {
  const L = ClientLogic;
  const st = { products: [], bottles: [], events: [] };
  let k = 0;
  const ap = (kind, data) => assert.equal(L.applyOp(st, { op_id: 's' + (++k), ts: '2026-10-27T10:00:00Z', kind, data }).status, 'applied');
  ap('upsert_product', { product_id: 'a', type: 'red', producer: 'X', grapes: 'Merlot,cabernet franc', drink_from: 2020, drink_to: 2030 });
  ap('upsert_product', { product_id: 'b', type: 'red', producer: 'Y', grapes: 'merlot', drink_from: 2035 });
  ap('upsert_product', { product_id: 'c', type: 'whisky', distillery: 'Z', grapes: 'Merlot' });
  ap('create_bottle', { bottle_id: '1', product_id: 'a', tags: 'vacation' });
  ap('create_bottle', { bottle_id: '2', product_id: 'a', tags: 'michi, Vacation' });
  ap('create_bottle', { bottle_id: '3', product_id: 'b' });
  ap('create_bottle', { bottle_id: '4', product_id: 'c' });
  ap('event', { type: 'out', bottle_id: '2' });
  assert.equal(st.products[0].grapes, 'Merlot, cabernet franc', 'grapes normalized');
  assert.deepEqual(L.stats.stockByList(st, 'grapes'), [{ key: 'Merlot', n: 2 }, { key: 'cabernet franc', n: 1 }], 'in-stock wine only, case-insensitive');
  assert.deepEqual(L.stats.stockByList(st, 'tags'), [{ key: 'vacation', n: 1 }]);
  assert.deepEqual(L.stats.tagCounts(st), [{ key: 'vacation', n: 2, products: 0 }, { key: 'michi', n: 1, products: 0 }], 'tag counts include taken-out bottles');
  const pm = { a: st.products[0], b: st.products[1], c: st.products[2] };
  const pick = (facet) => st.bottles.filter((b) => L.isInStock(b) && L.stats.matchFacet(facet, b, pm[b.product_id], 2026)).map((b) => b.bottle_id);
  assert.deepEqual(pick({ kind: 'win', value: 'ready' }), ['1']);
  assert.deepEqual(pick({ kind: 'win', value: 'young' }), ['3']);
  assert.deepEqual(pick({ kind: 'grape', value: 'MERLOT' }), ['1', '3'], 'spirits never match a grape');
  assert.deepEqual(pick({ kind: 'tag', value: 'Vacation' }), ['1']);
  assert.deepEqual(pick({ kind: 'type', value: 'Whisky' }), ['4']);
  assert.deepEqual(pick({ kind: 'location', value: '(not set)' }), ['1', '3', '4']);
  const old = L.upgradeState({ products: [{ product_id: 'q' }], bottles: [{ bottle_id: '9', source: 'Winery' }], events: [] });
  assert.deepEqual(old.bottles[0], { bottle_id: '9', tags: 'Winery' }, 'phone copy from an older version is upgraded');
  assert.equal(old.products[0].tags, '', 'products get an empty tags field');
});

test('product tags apply to every bottle of the product', () => {
  const L = ClientLogic;
  const st = { products: [], bottles: [], events: [] };
  let k = 0;
  const ap = (kind, data) => {
    const r = L.applyOp(st, { op_id: 't' + (++k), ts: '2026-10-27T11:00:00Z', kind, data });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r;
  };
  ap('upsert_product', { product_id: 'a', type: 'red', producer: 'X', tags: ' Christmas , for guests,christmas' });
  ap('upsert_product', { product_id: 'b', type: 'whisky', distillery: 'Y' });
  ap('create_bottle', { bottle_id: '1', product_id: 'a', tags: 'For Guests, gift' });
  ap('create_bottle', { bottle_id: '2', product_id: 'a' });
  ap('create_bottle', { bottle_id: '3', product_id: 'b', tags: 'gift' });
  ap('create_bottle', { bottle_id: '4', product_id: 'a' });
  ap('event', { type: 'out', bottle_id: '4' });
  const pa = st.products[0];
  assert.equal(pa.tags, 'Christmas, for guests', 'normalized, case-insensitive duplicates removed');
  assert.equal(L.effectiveTags(st.bottles[0], pa), 'Christmas, for guests, gift', 'product tags first, no duplicate');
  assert.equal(L.effectiveTags(st.bottles[1], pa), 'Christmas, for guests', 'bottle without own tags inherits');
  assert.deepEqual(L.stats.stockByList(st, 'tags'),
    [{ key: 'Christmas', n: 2 }, { key: 'for guests', n: 2 }, { key: 'gift', n: 2 }], 'in stock, each tag once per bottle');
  assert.deepEqual(L.stats.tagCounts(st),
    [{ key: 'Christmas', n: 3, products: 1 }, { key: 'for guests', n: 3, products: 1 }, { key: 'gift', n: 2, products: 0 }]);
  const pm = { a: pa, b: st.products[1] };
  const pick = (v) => st.bottles.filter((b) => L.isInStock(b) && L.stats.matchFacet({ kind: 'tag', value: v }, b, pm[b.product_id], 2026)).map((b) => b.bottle_id);
  assert.deepEqual(pick('christmas'), ['1', '2'], 'slice by a product tag');
  assert.deepEqual(pick('GIFT'), ['1', '3'], 'slice by a bottle tag');
  // rename merges on products and bottles; delete removes from both
  let r = ap('rename_tag', { from: 'for guests', to: 'Gift' });
  assert.equal(r.products.length, 1);
  assert.equal(pa.tags, 'Christmas, Gift');
  assert.equal(st.bottles[0].tags, 'Gift', 'merged with the existing bottle tag');
  r = ap('rename_tag', { from: 'christmas', to: '' });
  assert.equal(pa.tags, 'Gift');
  assert.deepEqual(L.stats.tagCounts(st).map((t) => t.key), ['Gift']);
  // editing other product fields keeps the tags
  ap('upsert_product', { product_id: 'a', region: 'Rioja' });
  assert.equal(pa.tags, 'Gift');
});

test('sync: product tags are stored in the Sheet', () => {
  const ops = [op('upsert_product', { product_id: 'p1', tags: 'Christmas, christmas, For guests' })];
  const res = post({ action: 'sync', key: KEY, ops });
  assert.equal(res.results[0].status, 'applied');
  ops.forEach((o) => { ClientLogic.applyOp(clientState, o); allOps.push(o); });
  assert.equal(res.snapshot.products.find((x) => x.product_id === 'p1').tags, 'Christmas, For guests');
  const hp = header('products');
  const row = sheetRows('products').find((r) => r[hp.indexOf('product_id')] === 'p1');
  assert.equal(row[hp.indexOf('tags')], 'Christmas, For guests');
});

test('older Sheet without products.tags: the column is added on sync and keeps data', () => {
  const sh = gas.state.sheets.products;
  const hp = header('products');
  const tagCol = hp.indexOf('tags') + 1;
  const lastCol = hp.length;
  // rebuild the tab as a 2.1 Sheet had it: same rows, no tags column
  const rows = sh.getRange(1, 1, sh.getLastRow(), lastCol).getValues();
  const without = rows.map((r) => r.filter((_, j) => j !== tagCol - 1).concat(['']));
  sh.cells = {}; sh.fmt = {};
  sh.getRange(1, 1, without.length, lastCol).setNumberFormat('@').setValues(without);
  assert.equal(header('products').indexOf('tags'), -1, 'test setup: no tags column');
  const before = sheetRows('products').length;
  const o = op('upsert_product', { product_id: 'p2', tags: 'Islay' });
  const res = post({ action: 'sync', key: KEY, ops: [o] });
  ClientLogic.applyOp(clientState, o); allOps.push(o);
  assert.equal(res.results[0].status, 'applied');
  const h2 = header('products');
  assert.equal(h2[h2.length - 1], 'tags', 'tags column appended at the right');
  assert.equal(h2.filter((h) => h === 'tags').length, 1);
  assert.equal(sheetRows('products').length, before, 'no rows lost');
  assert.equal(res.snapshot.products.find((x) => x.product_id === 'p2').tags, 'Islay', 'tag written into the new column');
  assert.equal(res.snapshot.products.find((x) => x.product_id === 'p1').tags, '', 'old product tags were lost with the column (test setup)');
  assert.equal(res.snapshot.products.find((x) => x.product_id === 'p1').producer, 'Keller', 'other fields unchanged');
  const again = post({ action: 'sync', key: KEY, ops: [] });
  assert.equal(header('products').filter((h) => h === 'tags').length, 1, 'no second column on the next sync');
  assert.equal(again.snapshot.products.find((x) => x.product_id === 'p2').tags, 'Islay');
  // keep the shared client copy consistent with the rebuilt Sheet
  clientState.products.find((x) => x.product_id === 'p1').tags = '';
});

test('older Sheet: "source" column is renamed to "tags" and keeps its values', () => {
  const sh = gas.state.sheets.bottles;
  const col = header('bottles').indexOf('tags') + 1;
  sh.set(1, col, 'source');
  const res = post({ action: 'sync', key: KEY, ops: [] });
  assert.equal(header('bottles')[col - 1], 'tags');
  assert.equal(header('bottles').filter((h) => h === 'tags').length, 1);
  assert.equal(res.snapshot.bottles.find((x) => x.bottle_id === '000123').tags, 'Weinhandlung Erlangen');
  sh.set(1, col, 'source');
  G('setup')();
  assert.equal(header('bottles')[col - 1], 'tags', 'setup renames instead of adding a second column');
  assert.equal(header('bottles').filter((h) => h === 'tags').length, 1);
});

test('bad input does not crash the endpoint', () => {
  const out = JSON.parse(G('doPost')({ postData: { contents: '{not json' } }).content);
  assert.equal(out.ok, false);
  const res = post({ action: 'sync', key: KEY, ops: [null, {}, { op_id: 'x1', kind: 'nope', ts: 'now' }, { op_id: 'x2', kind: 'set_photo', ts: 't', data: {} }] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results.map((r) => r.status), ['error', 'error', 'error', 'error']);
});

console.log(`backend: ${passed} passed`);

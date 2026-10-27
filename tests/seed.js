/*
 * Seeds the local test backend with a realistic cellar (two users, two years
 * of history) and 30 days of climate readings. Usage: node seed.js <apiKey> <sensorKey>
 */
'use strict';
const [apiKey, sensorKey] = process.argv.slice(2);
const URL_ = 'http://localhost:8787/exec';
const crypto = require('crypto');

async function post(body) {
  const r = await fetch(URL_, { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(JSON.stringify(j));
  return j;
}

const products = [
  ['p_keller', { type: 'white', producer: 'Keller', name: 'Riesling Kirchspiel GG', vintage: '2019', country: 'Germany', region: 'Rheinhessen', grapes: 'Riesling', abv: 12.5, volume_ml: 750, drink_from: 2024, drink_to: 2035 }],
  ['p_hlr', { type: 'red', producer: 'Huber', name: 'Spätburgunder Alte Reben', vintage: '2018', country: 'Germany', region: 'Baden', grapes: 'Pinot Noir', abv: 13.5, volume_ml: 750, drink_from: 2022, drink_to: 2030 }],
  ['p_barolo', { type: 'red', producer: 'Vietti', name: 'Barolo Castiglione', vintage: '2017', country: 'Italy', region: 'Piedmont', grapes: 'Nebbiolo', abv: 14.5, volume_ml: 750, drink_from: 2025, drink_to: 2040 }],
  ['p_chablis', { type: 'white', producer: 'Domaine William Fèvre', name: 'Chablis Premier Cru Vaillons', vintage: '2020', country: 'France', region: 'Burgundy', grapes: 'Chardonnay', abv: 13, volume_ml: 750, drink_from: 2023, drink_to: 2028 }],
  ['p_rioja', { type: 'red', producer: 'La Rioja Alta', name: 'Viña Ardanza Reserva', vintage: '2016', country: 'Spain', region: 'Rioja', grapes: 'Tempranillo, Garnacha', abv: 14, volume_ml: 750, drink_from: 2021, drink_to: 2026 }],
  ['p_champ', { type: 'sparkling', producer: 'Pierre Péters', name: 'Cuvée de Réserve Blanc de Blancs', vintage: 'NV', country: 'France', region: 'Champagne', abv: 12, volume_ml: 750 }],
  ['p_port', { type: 'fortified', producer: 'Taylor\'s', name: 'Vintage Port', vintage: '2011', country: 'Portugal', region: 'Douro', abv: 20, volume_ml: 750, drink_from: 2030, drink_to: 2060 }],
  ['p_old', { type: 'red', producer: 'Château Musar', name: 'Rouge', vintage: '2005', country: 'Lebanon', region: 'Bekaa Valley', abv: 14, volume_ml: 750, drink_from: 2012, drink_to: 2024 }],
  ['p_spring', { type: 'whisky', producer: 'Springbank', distillery: 'Springbank', name: '15 Year Old', age: '15', cask: 'sherry and bourbon', bottler: 'official', country: 'Scotland', region: 'Campbeltown', abv: 46, volume_ml: 700 }],
  ['p_ardbeg', { type: 'whisky', producer: 'Ardbeg', distillery: 'Ardbeg', name: 'Uigeadail', age: 'NAS', cask: 'bourbon and sherry', bottler: 'official', country: 'Scotland', region: 'Islay', abv: 54.2, volume_ml: 700 }],
  ['p_rum', { type: 'rum', producer: 'Hampden', name: 'Pagos', country: 'Jamaica', abv: 52, volume_ml: 700 }],
  ['p_cognac', { type: 'brandy', producer: 'Jean Fillioux', name: 'Réserve Familiale', country: 'France', region: 'Grande Champagne', abv: 42, volume_ml: 700 }]
];

const plan = [
  ['p_keller', 6, 'Rack A, row 1'], ['p_hlr', 4, 'Rack A, row 2'], ['p_barolo', 3, 'Rack B, row 1'],
  ['p_chablis', 5, 'Fridge'], ['p_rioja', 4, 'Rack B, row 2'], ['p_champ', 3, 'Fridge'],
  ['p_port', 2, 'Rack C'], ['p_old', 2, 'Rack C'], ['p_spring', 2, 'Cabinet'], ['p_ardbeg', 1, 'Cabinet'],
  ['p_rum', 1, 'Cabinet'], ['p_cognac', 1, 'Cabinet']
];

async function main() {
  const now = Date.now();
  const day = 86400000;
  let t = now - 720 * day;
  const ops = [];
  const mk = (kind, data, user) => {
    t += 3600000 * (1 + Math.random() * 6);
    return { op_id: crypto.randomUUID(), kind, ts: new Date(t).toISOString(), user: user || 'Stefan', data };
  };
  products.forEach(([id, d]) => ops.push(mk('upsert_product', { product_id: id, ...d })));
  let code = 1;
  const bottles = [];
  plan.forEach(([pid, n, loc]) => {
    for (let i = 0; i < n; i++) {
      const id = String(code++).padStart(6, '0');
      bottles.push({ id, pid });
      const tags = ['Weinhandlung Erlangen', 'winery, vacation', 'michi', 'gift, birthday', ''][(code + n) % 5];
      ops.push(mk('create_bottle', { bottle_id: id, product_id: pid, location: loc, acquired_date: new Date(t).toISOString().slice(0, 10), tags }));
    }
  });
  // two years of taking bottles out, spread out
  const consume = bottles.filter((b, i) => i % 3 === 0 && !['p_spring', 'p_ardbeg', 'p_rum', 'p_cognac'].includes(b.pid));
  const step = (now - 30 * day - t) / (consume.length + 4);
  consume.forEach((b, i) => {
    t += step;
    ops.push(mk('event', { type: 'out', bottle_id: b.id }, i % 2 ? 'Partner' : 'Stefan'));
  });
  t = now - 25 * day;
  ops.push(mk('event', { type: 'out', bottle_id: bottles.find((b) => b.pid === 'p_spring').id }, 'Partner'));
  ops.push(mk('event', { type: 'move', bottle_id: bottles[1].id, location: 'Fridge' }));

  for (let i = 0; i < ops.length; i += 50) {
    const res = await post({ action: 'sync', key: apiKey, ops: ops.slice(i, i + 50) });
    const bad = res.results.filter((r) => r.status !== 'applied');
    if (bad.length) throw new Error('seed rejected: ' + JSON.stringify(bad));
  }

  // climate: 30 days, one reading per 15 minutes, daily cycle + slow drift
  const readings = [];
  for (let k = 30 * 96; k >= 0; k--) {
    const ts = new Date(now - k * 15 * 60000);
    const h = ts.getUTCHours() + ts.getUTCMinutes() / 60;
    const temp = 12.2 + 0.6 * Math.sin((h - 15) / 24 * 2 * Math.PI) + 0.8 * Math.sin(k / 900) + (Math.random() - 0.5) * 0.15;
    const rh = 67 + 3 * Math.sin(k / 500) + (Math.random() - 0.5) * 1.2;
    readings.push({ reading_id: 'seed-' + k, sensor: 'cellar', ts: ts.toISOString(), temp_c: Math.round(temp * 10) / 10, rh_pct: Math.round(rh * 10) / 10, battery_pct: 91 });
  }
  // the backend only accepts device timestamps up to 7 days old: send older ones without the age check
  let stored = 0;
  for (let i = 0; i < readings.length; i += 200) {
    const r = await post({ action: 'climate', key: sensorKey, readings: readings.slice(i, i + 200) });
    stored += r.stored;
  }
  console.log(JSON.stringify({ ops: ops.length, bottles: bottles.length, climate: stored }));
}
main().catch((e) => { console.error(e); process.exit(1); });

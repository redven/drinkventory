/*
 * Build docs/js/worldmap-data.js: country shapes for the map in Stats.
 *
 * Source: Natural Earth 1:50m "Admin 0 - map units" (public domain), v5.1.2:
 *   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_map_units.geojson
 *
 * Map units split the United Kingdom into England, Scotland, Wales and Northern Ireland,
 * so Scotch whisky gets its own shape. All other map units are merged back into their
 * country, except overseas units with their own ISO code (Martinique, Réunion, ...).
 * Antarctica is left out. Projection: Natural Earth I, 1000 units wide.
 *
 * Usage (once, the output is committed):
 *   cd tools && npm install --no-save mapshaper@0.7.101 d3-geo@3.1.2
 *   curl -sSLo /tmp/ne.geojson <URL above>
 *   node build_worldmap.js /tmp/ne.geojson
 */
'use strict';
const fs = require('fs');
const path = require('path');
const mapshaper = require('mapshaper');
const d3 = require('d3-geo');

const OUT = path.join(__dirname, '..', 'docs', 'js', 'worldmap-data.js');
const WIDTH = 1000;
const SIMPLIFY = 'interval=12000';   // metres: a fixed tolerance keeps small countries (Luxembourg) recognisable
const MIN_AREA = 0.4;    // projected units²; smaller islands are dropped (the largest part of a country stays)
const UK = ['ENG', 'SCT', 'WLS', 'NIR'];

// Extra names people type, English and German. Names from the data (NAME, NAME_EN, NAME_DE, ...) are added too.
const ALIASES = {
  USA: ['USA', 'US', 'U.S.', 'U.S.A.', 'United States', 'America', 'Amerika', 'Vereinigte Staaten von Amerika'],
  GBR: ['United Kingdom', 'UK', 'U.K.', 'Great Britain', 'Britain', 'GB', 'GBR', 'Vereinigtes Königreich', 'Großbritannien', 'Grossbritannien', 'Britannien'],
  SCT: ['Scotland', 'Schottland', 'Écosse', 'Scottish'],
  NIR: ['Northern Ireland', 'Nordirland', 'N. Ireland'],
  NLD: ['Holland', 'The Netherlands'],
  CZE: ['Czech Republic', 'Czechia', 'Tschechien', 'Tschechische Republik'],
  KOR: ['South Korea', 'Korea', 'Südkorea'],
  MKD: ['Macedonia', 'North Macedonia', 'Nordmazedonien', 'Mazedonien'],
  MDA: ['Moldova', 'Moldawien', 'Moldau'],
  LUX: ['Luxemburg'],
  RUS: ['Russia', 'Russland'],
  TWN: ['Taiwan', 'Republic of China'],
  CHE: ['Switzerland', 'Schweiz'],
  AUT: ['Austria', 'Österreich'],
  ZAF: ['South Africa', 'Südafrika', 'RSA'],
  NZL: ['New Zealand', 'Neuseeland', 'NZ'],
  IRL: ['Ireland', 'Irland', 'Republic of Ireland', 'Eire'],
  BIH: ['Bosnia', 'Bosnien'],
  GEO: ['Georgia', 'Georgien', 'Sakartvelo'],
};

function main() {
  const src = process.argv[2];
  if (!src) { console.error('usage: node build_worldmap.js <ne_50m_admin_0_map_units.geojson>'); process.exit(2); }
  const raw = JSON.parse(fs.readFileSync(src, 'utf8'));

  // 1. Key per map unit; names and label points per key.
  const info = {};   // key -> { name, names:Set, labels:[[lon,lat]] }
  const feats = [];
  for (const f of raw.features) {
    const p = f.properties;
    if (p.ADM0_A3 === 'ATA' || p.LABEL_Y < -58) continue;
    const own = p.HOMEPART !== 1 && p.ISO_A3 && p.ISO_A3 !== '-99' && p.ADM0_A3 !== p.ISO_A3;
    const key = p.ADM0_A3 === 'GBR' ? p.GU_A3 : (own ? p.ISO_A3 : p.ADM0_A3);
    const homeOfKey = own || p.ADM0_A3 === 'GBR' || p.HOMEPART === 1;
    const k = info[key] || (info[key] = { name: '', names: new Set(), labels: [] });
    const country = own || p.ADM0_A3 === 'GBR' ? p.NAME_EN || p.NAME : p.ADMIN;
    if (homeOfKey && !k.name) k.name = country === 'United States of America' ? 'USA' : country;
    for (const n of [p.NAME, p.NAME_EN, p.NAME_DE, p.NAME_LONG, p.BRK_NAME, p.FORMAL_EN, p.NAME_ALT, p.NAME_FR]) if (n) k.names.add(n);
    if (homeOfKey) {
      for (const n of [p.ADMIN, p.SOVEREIGNT === p.ADMIN ? p.SOVEREIGNT : null]) if (n && p.ADM0_A3 !== 'GBR') k.names.add(n);
      for (const c of [p.ISO_A2, p.ISO_A3, p.ADM0_A3 === 'GBR' ? null : p.ADM0_A3]) if (c && c !== '-99' && !/^FR-/.test(c)) k.names.add(c);
      k.labels.push([p.LABEL_X, p.LABEL_Y]);
    }
    feats.push({ type: 'Feature', properties: { key }, geometry: f.geometry });
  }
  for (const [key, list] of Object.entries(ALIASES)) {
    if (key === 'GBR') continue;
    if (!info[key]) throw new Error('alias for unknown key ' + key);
    list.forEach((n) => info[key].names.add(n));
  }

  // 2. Dissolve per key (removes inner borders, e.g. in Belgium) and simplify with shared borders.
  const input = { 'in.json': { type: 'FeatureCollection', features: feats } };
  const res = mapshaper.applyCommands(
    `-i in.json -dissolve key -simplify ${SIMPLIFY} keep-shapes -o out.json format=geojson`, input);
  return Promise.resolve(res).then((out) => build(JSON.parse(out['out.json']), info));
}

function build(fc, info) {
  const proj = d3.geoNaturalEarth1().fitWidth(WIDTH, fc);
  const geoPath = d3.geoPath(proj).digits(1);
  const b = geoPath.bounds(fc);
  proj.translate([proj.translate()[0] - b[0][0], proj.translate()[1] - b[0][1]]);
  const height = Math.ceil(b[1][1] - b[0][1]);

  const units = [];
  for (const f of fc.features) {
    const key = f.properties.key;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const parts = polys.map((c) => {
      let g = { type: 'Polygon', coordinates: c };
      // d3 reads a ring with the other winding as "the whole globe except this ring": turn it round.
      if (d3.geoArea(g) > 2 * Math.PI) g = { type: 'Polygon', coordinates: c.map((r) => r.slice().reverse()) };
      return { g, area: geoPath.area(g) };
    }).sort((a, z) => z.area - a.area);
    const kept = parts.filter((x, i) => i === 0 || x.area >= MIN_AREA);
    const geom = { type: 'MultiPolygon', coordinates: kept.map((x) => x.g.coordinates) };
    const d = geoPath(geom);
    if (!d) continue;
    const bb = geoPath.bounds(parts[0].g);
    const k = info[key];
    const lab = k.labels.length ? k.labels : [d3.geoCentroid(parts[0].g)];
    const pt = lab.map((ll) => proj(ll)).reduce((s, p) => [s[0] + p[0] / lab.length, s[1] + p[1] / lab.length], [0, 0]);
    let rel = relative(d);
    // A shape smaller than the rounding step (Vatican) becomes a small diamond at its label point.
    if (!rel) rel = 'M' + (Math.round(pt[0] * 10) / 10) + ',' + (Math.round((pt[1] - 0.4) * 10) / 10) + 'l.4,.4-.4,.4-.4-.4z';
    units.push({
      k: key, n: k.name || key,
      d: rel,
      b: bb.flat().map((v) => Math.round(v)),
      c: pt.map((v) => Math.round(v * 10) / 10),
    });
  }
  units.sort((a, z) => a.k.localeCompare(z.k));

  // Names -> key. Longer, real names win over short codes when two keys share a spelling.
  const names = {};
  const prio = {};
  const add = (n, key) => {
    for (const v of variants(n)) {
      const p = v.length <= 3 ? 1 : 2;
      if (names[v] && names[v] !== key && prio[v] >= p) continue;
      names[v] = key; prio[v] = p;
    }
  };
  for (const u of units) for (const n of info[u.k].names) add(n, u.k);
  ALIASES.GBR.forEach((n) => add(n, 'GBR'));

  const uk = units.filter((u) => UK.includes(u.k));
  const groups = {
    GBR: {
      n: 'United Kingdom', units: UK,
      c: [uk.reduce((s, u) => s + u.c[0], 0) / uk.length, uk.reduce((s, u) => s + u.c[1], 0) / uk.length].map((v) => Math.round(v * 10) / 10),
      b: [Math.min(...uk.map((u) => u.b[0])), Math.min(...uk.map((u) => u.b[1])), Math.max(...uk.map((u) => u.b[2])), Math.max(...uk.map((u) => u.b[3]))],
    },
  };
  const data = {
    source: 'Natural Earth 1:50m Admin 0 map units v5.1.2 (public domain), naturalearthdata.com',
    w: WIDTH, h: height, units, groups, names,
  };
  const js = '/* Generated by tools/build_worldmap.js from Natural Earth (public domain). Do not edit by hand. */\n' +
    'var WORLD_MAP_DATA = ' + JSON.stringify(data) + ';\n' +
    "if (typeof window !== 'undefined') { window.WORLD_MAP_DATA = WORLD_MAP_DATA; }\n" +
    "if (typeof module !== 'undefined' && module.exports) { module.exports = WORLD_MAP_DATA; }\n";
  fs.writeFileSync(OUT, js);
  console.log(`${units.length} shapes, ${Object.keys(names).length} names, ${(js.length / 1024).toFixed(0)} KB -> ${path.relative(path.join(__dirname, '..'), OUT)}`);
}

/**
 * Shorter path text: each ring starts with an absolute "M x,y", then relative "l dx,dy" steps.
 * Steps come from the rounded absolute points, so rounding errors do not add up.
 */
function relative(d) {
  const num = (v) => { const s = String(Math.round(v * 10) / 10); return s.replace(/^(-?)0\./, '$1.'); };
  const pair = (x, y) => { const a = num(x); const b = num(y); return a + (b[0] === '-' ? '' : ',') + b; };
  let out = '';
  for (const ring of d.split('Z').filter(Boolean)) {
    const pts = ring.replace(/^M/, '').split('L').map((p) => p.split(',').map(Number)).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    let s = 'M' + pair(pts[0][0], pts[0][1]) + 'l';
    let prev = pts[0];
    let first = true;
    for (const p of pts.slice(1)) {
      const dx = p[0] - prev[0]; const dy = p[1] - prev[1];
      if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) continue;
      const t = pair(dx, dy);
      s += (first || t[0] === '-' ? '' : ' ') + t;
      first = false;
      prev = p;
    }
    if (!first) out += s + 'z';
  }
  return out;
}

/** Lookup spellings of a name: no accents, ß as ss, and German umlauts also as ae/oe/ue. Same rule as WorldMap.norm. */
function variants(s) {
  const base = String(s).toLowerCase().replace(/ß/g, 'ss');
  const plain = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');
  return Array.from(new Set([plain(base), plain(base.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue'))])).filter(Boolean);
}

main().catch((e) => { console.error(e); process.exit(1); });

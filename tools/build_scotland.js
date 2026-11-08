/*
 * Build docs/js/scotland-data.js: Scotch whisky regions for the Scotland view in Stats.
 *
 * Source: Natural Earth 1:10m "Admin 1 - states, provinces" (public domain), v5.1.2:
 *   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson
 *
 * The regions are built from council areas, so their borders are approximate:
 * - Lowlands: council areas south of the Highland line (Greenock to Dundee).
 * - Speyside: Moray (the legal definition also includes Badenoch and Strathspey).
 * - Highlands: the other mainland council areas.
 * - Islay, Jura, Mull, Arran, Skye, Raasay, Lewis and Harris, Orkney: single islands; together with
 *   "Other islands" they form the group "Islands". Shetland is left out to keep the map compact.
 * - Campbeltown: a point at the town.
 * England, Northern Ireland and Ireland are drawn as grey context.
 *
 * Usage (once, the output is committed):
 *   cd tools && npm install --no-save mapshaper@0.7.101 d3-geo@3.1.2
 *   curl -sSLo /tmp/ne_a1.geojson <URL above>
 *   node build_scotland.js /tmp/ne_a1.geojson
 */
'use strict';
const fs = require('fs');
const path = require('path');
const mapshaper = require('mapshaper');
const d3 = require('d3-geo');

const OUT = path.join(__dirname, '..', 'docs', 'js', 'scotland-data.js');
const WIDTH = 1000;
const SIMPLIFY = 'interval=350';      // metres
const VIEW = [-8.75, 54.55, -0.6, 59.45];   // lon/lat box of the view (Shetland left out)

const LOWLANDS = ['Scottish Borders', 'Dumfries and Galloway', 'Clackmannanshire', 'Falkirk', 'West Lothian', 'Edinburgh',
  'Midlothian', 'East Lothian', 'South Ayrshire', 'North Ayshire', 'Inverclyde', 'Renfrewshire', 'West Dunbartonshire', 'Fife',
  'Dundee', 'North Lanarkshire', 'East Dunbartonshire', 'Glasgow', 'East Renfrewshire', 'East Ayrshire', 'South Lanarkshire'];
const HIGHLANDS = ['Stirling', 'Highland', 'Aberdeenshire', 'Aberdeen', 'Angus', 'Perthshire and Kinross', 'Argyll and Bute'];
// Islands by a point inside them [lon, lat].
const ISLANDS = {
  Islay: [-6.25, 55.75], Jura: [-5.95, 55.95], Mull: [-5.95, 56.45], Arran: [-5.25, 55.58],
  Skye: [-6.25, 57.35], Raasay: [-6.04, 57.40], 'Lewis and Harris': [-6.55, 58.2]
};
const CAMPBELTOWN = [-5.605, 55.425];

// Region names as people write them -> key. Matched as words in the region text, first match wins.
const ALIASES = [
  ['Islay', ['islay']],
  ['Jura', ['jura']],
  ['Mull', ['mull', 'tobermory']],
  ['Arran', ['arran']],
  ['Raasay', ['raasay']],
  ['Skye', ['skye']],
  ['Lewis and Harris', ['lewis', 'harris']],
  ['Orkney', ['orkney', 'orkneys']],
  ['Other islands', ['bute', 'tiree', 'coll', 'uist', 'barra', 'eigg', 'rum', 'colonsay', 'gigha', 'benbecula']],
  ['Campbeltown', ['campbeltown', 'kintyre']],
  ['Speyside', ['speyside', 'spey', 'moray']],
  ['Lowlands', ['lowland', 'lowlands']],
  ['Islands', ['island', 'islands', 'isle', 'isles', 'shetland']],
  ['Highlands', ['highland', 'highlands', 'perthshire', 'aberdeenshire']]
];

function main() {
  const src = process.argv[2];
  if (!src) { console.error('usage: node build_scotland.js <ne_10m_admin_1_states_provinces.geojson>'); process.exit(2); }
  const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
  const feats = [];
  for (const f of raw.features) {
    const p = f.properties;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    if (p.geonunit === 'Scotland') {
      if (p.name === 'Shetland Islands') continue;
      polys.forEach((c) => {
        const g = { type: 'Polygon', coordinates: c };
        let key = null;
        for (const [isl, pt] of Object.entries(ISLANDS)) if (d3.geoContains(g, pt)) key = isl;
        if (!key) {
          if (p.name === 'Orkney') key = 'Orkney';
          else if (p.name === 'Eilean Siar') key = 'Other islands';
          else if (p.name === 'Moray') key = 'Speyside';
          else if (LOWLANDS.includes(p.name)) key = 'Lowlands';
          else if (HIGHLANDS.includes(p.name)) key = polys.length > 1 && c[0].length < 200 ? 'Other islands' : 'Highlands';
          else throw new Error('council area without region: ' + p.name);
        }
        feats.push({ type: 'Feature', properties: { key, kind: 'region' }, geometry: g });
      });
    } else if (p.geonunit === 'England' || p.geonunit === 'Northern Ireland' || p.admin === 'Ireland' || p.admin === 'Isle of Man') {
      const key = p.admin === 'Ireland' ? 'Ireland' : p.geonunit === 'Northern Ireland' ? 'Northern Ireland' : (p.admin === 'Isle of Man' ? 'Isle of Man' : 'England');
      feats.push({ type: 'Feature', properties: { key, kind: 'context' }, geometry: f.geometry });
    }
  }
  const input = { 'in.json': { type: 'FeatureCollection', features: feats } };
  const cmd = `-i in.json -dissolve key copy-fields=kind -simplify ${SIMPLIFY} keep-shapes ` +
    `-clip bbox=${VIEW.join(',')} -o out.json format=geojson`;
  return Promise.resolve(mapshaper.applyCommands(cmd, input)).then((out) => build(JSON.parse(out['out.json'])));
}

function build(fc) {
  // d3 reads a ring with the other winding as "the whole globe except this ring": turn such polygons round.
  const fixPoly = (c) => (d3.geoArea({ type: 'Polygon', coordinates: c }) > 2 * Math.PI ? c.map((r) => r.slice().reverse()) : c);
  fc.features.forEach((f) => {
    const g = f.geometry;
    if (!g) return;
    if (g.type === 'Polygon') g.coordinates = fixPoly(g.coordinates);
    else g.coordinates = g.coordinates.map(fixPoly);
  });
  fc.features = fc.features.filter((f) => f.geometry);
  const regions = fc.features.filter((f) => f.properties.kind === 'region');
  const proj = d3.geoTransverseMercator().rotate([4.5, 0]).fitWidth(WIDTH, { type: 'FeatureCollection', features: regions });
  const geoPath = d3.geoPath(proj).digits(1);
  const bounds = geoPath.bounds({ type: 'FeatureCollection', features: regions });
  const pad = 30;
  proj.translate([proj.translate()[0] - bounds[0][0] + pad, proj.translate()[1] - bounds[0][1] + pad]);
  const height = Math.ceil(bounds[1][1] - bounds[0][1] + 2 * pad);
  const width = Math.ceil(bounds[1][0] - bounds[0][0] + 2 * pad);
  const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((c) => ({ type: 'Polygon', coordinates: c }));
  const round = (v) => Math.round(v * 10) / 10;

  const units = [];
  for (const f of regions) {
    const parts = polysOf(f.geometry).map((g) => ({ g, area: geoPath.area(g) })).sort((a, z) => z.area - a.area);
    const kept = parts.filter((x, i) => i === 0 || x.area >= 2);
    const d = relative(geoPath({ type: 'MultiPolygon', coordinates: kept.map((x) => x.g.coordinates) }));
    const bb = geoPath.bounds(parts[0].g).flat().map(Math.round);
    const c = geoPath.centroid(parts[0].g).map(round);
    units.push({ k: f.properties.key, n: f.properties.key, d, b: bb, c });
  }
  units.sort((a, z) => a.k.localeCompare(z.k));
  const context = fc.features.filter((f) => f.properties.kind === 'context').map((f) => {
    const g = { type: 'MultiPolygon', coordinates: polysOf(f.geometry).map((x) => x.coordinates) };
    return { n: f.properties.key, d: relative(geoPath(g)) };
  }).filter((x) => x.d);

  const islandKeys = units.map((u) => u.k).filter((k) => ['Islay', 'Jura', 'Mull', 'Arran', 'Skye', 'Raasay', 'Lewis and Harris', 'Orkney', 'Other islands'].includes(k));
  const isl = units.filter((u) => islandKeys.includes(u.k) && u.k !== 'Islay');
  const groups = {
    Islands: {
      n: 'Islands', units: islandKeys.filter((k) => k !== 'Islay'),
      c: units.find((u) => u.k === 'Skye').c,
      b: [Math.min(...isl.map((u) => u.b[0])), Math.min(...isl.map((u) => u.b[1])), Math.max(...isl.map((u) => u.b[2])), Math.max(...isl.map((u) => u.b[3]))],
    },
  };
  const cp = proj(CAMPBELTOWN).map(round);
  const points = [{ k: 'Campbeltown', n: 'Campbeltown', c: cp, b: [cp[0] - 1, cp[1] - 1, cp[0] + 1, cp[1] + 1] }];
  const data = {
    source: 'Natural Earth 1:10m Admin 1 v5.1.2 (public domain); regions from council areas, borders approximate',
    w: width, h: height, units, groups, points, context, aliases: ALIASES,
  };
  const js = '/* Generated by tools/build_scotland.js from Natural Earth (public domain). Do not edit by hand. */\n' +
    'var SCOTLAND_DATA = ' + JSON.stringify(data) + ';\n' +
    "if (typeof window !== 'undefined') { window.SCOTLAND_DATA = SCOTLAND_DATA; }\n" +
    "if (typeof module !== 'undefined' && module.exports) { module.exports = SCOTLAND_DATA; }\n";
  fs.writeFileSync(OUT, js);
  console.log(`${units.length} regions (${units.map((u) => u.k).join(', ')}), ${context.length} context shapes, ` +
    `${width}x${height}, ${(js.length / 1024).toFixed(0)} KB -> ${path.relative(path.join(__dirname, '..'), OUT)}`);
}

/** Same compact path text as build_worldmap.js. */
function relative(d) {
  if (!d) return '';
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

main().catch((e) => { console.error(e); process.exit(1); });

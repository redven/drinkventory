/*
 * Build docs/js/regions-data.js: wine regions of Germany, France and Italy for the region views in Stats.
 *
 * Sources:
 * - Germany: Eurostat GISCO NUTS 2021 level 3 (districts), 1:10 million, via Nuts2json:
 *   https://raw.githubusercontent.com/eurostat/Nuts2json/master/pub/v2/2021/4326/10M/nutsrg_3.json
 *   © EuroGeographics for the administrative boundaries. Non-commercial use with this notice only.
 * - France and Italy: Natural Earth 1:10m Admin 1 v5.1.2 (public domain): départements and provinces.
 *
 * A wine region is a set of whole districts (Germany) or départements (France), so its border is approximate.
 * Italy uses its administrative regions, with Trentino and South Tyrol (Alto Adige) apart.
 * The rest of each country is drawn in light grey.
 *
 * Usage (once, the output is committed):
 *   cd tools && npm install --no-save mapshaper@0.7.101 d3-geo@3.1.2
 *   curl -sSLo /tmp/nuts3.json <NUTS URL above>
 *   curl -sSLo /tmp/ne_a1.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson
 *   node build_regions.js /tmp/nuts3.json /tmp/ne_a1.geojson
 */
'use strict';
const fs = require('fs');
const path = require('path');
const mapshaper = require('mapshaper');
const d3 = require('d3-geo');

const OUT = path.join(__dirname, '..', 'docs', 'js', 'regions-data.js');
const WIDTH = 1000;

// ---------- Germany: NUTS-3 codes per Anbaugebiet ----------
const DEU = {
  Ahr: ['DEB12'],
  Mittelrhein: ['DEB1D', 'DEB1A', 'DEB17', 'DEB11', 'DEB18'],
  Mosel: ['DEB1C', 'DEB22', 'DEB25', 'DEB21', 'DEC02'],
  Nahe: ['DEB14'],
  Rheinhessen: ['DEB3J', 'DEB35', 'DEB3B', 'DEB39'],
  Pfalz: ['DEB3C', 'DEB3H', 'DEB33', 'DEB36', 'DEB3I', 'DEB31', 'DEB3D', 'DEB34', 'DEB38'],
  Rheingau: ['DE71D', 'DE714', 'DE71A'],
  'Hessische Bergstraße': ['DE715', 'DE716', 'DE711'],
  Franconia: ['DE26C', 'DE263', 'DE268', 'DE26A', 'DE26B', 'DE262', 'DE267', 'DE269', 'DE264', 'DE261', 'DE25A', 'DE265'],
  Baden: ['DE11B', 'DE128', 'DE125', 'DE126', 'DE123', 'DE122', 'DE134', 'DE124', 'DE121', 'DE133', 'DE132', 'DE131', 'DE139', 'DE138', 'DE147'],
  'Württemberg': ['DE118', 'DE117', 'DE115', 'DE116', 'DE111', 'DE113', 'DE119'],
  'Saale-Unstrut': ['DEE08', 'DEE0B'],
  Saxony: ['DED2E', 'DED21'],
};

// ---------- France: département codes per wine region ----------
const FRA = {
  Alsace: ['67', '68'],
  Champagne: ['51', '10', '02'],
  Burgundy: ['89', '21', '71'],
  Beaujolais: ['69'],
  Jura: ['39'],
  Savoie: ['73', '74'],
  'Rhône': ['26', '07', '84', '30', '42'],
  Provence: ['83', '13', '06', '04'],
  'Languedoc-Roussillon': ['34', '11', '66'],
  'South West': ['24', '46', '47', '81', '82', '31', '32', '40', '64', '65', '12'],
  Bordeaux: ['33'],
  Loire: ['44', '49', '37', '41', '18', '58', '85', '72', '86', '45'],
  Corsica: ['2A', '2B'],
};

// ---------- Italy: administrative region -> display name ----------
const ITA = {
  Piemonte: 'Piedmont', "Valle d'Aosta": 'Aosta Valley', Lombardia: 'Lombardy', Veneto: 'Veneto',
  'Friuli-Venezia Giulia': 'Friuli-Venezia Giulia', Liguria: 'Liguria', 'Emilia-Romagna': 'Emilia-Romagna', Toscana: 'Tuscany',
  Umbria: 'Umbria', Marche: 'Marche', Lazio: 'Lazio', Abruzzo: 'Abruzzo', Molise: 'Molise', Campania: 'Campania',
  Apulia: 'Apulia', Basilicata: 'Basilicata', Calabria: 'Calabria', Sicily: 'Sicily', Sardegna: 'Sardinia',
};

// Region names as people write them (English, German, local) and well-known places -> region. First match wins.
const ALIASES = {
  DEU: [
    ['Hessische Bergstraße', ['hessische bergstraße', 'hessian bergstrasse', 'hessische bergstrasse']],
    ['Saale-Unstrut', ['saale-unstrut', 'saale unstrut', 'freyburg', 'naumburg']],
    ['Mittelrhein', ['mittelrhein', 'middle rhine', 'bacharach', 'boppard']],
    ['Rheinhessen', ['rheinhessen', 'rhinehessen', 'rhine hesse', 'nierstein', 'nackenheim', 'oppenheim', 'westhofen', 'bingen']],
    ['Rheingau', ['rheingau', 'rüdesheim', 'johannisberg', 'hattenheim', 'kiedrich', 'eltville', 'hochheim', 'oestrich', 'geisenheim', 'erbach']],
    ['Mosel', ['mosel', 'moselle', 'mosel-saar-ruwer', 'saar', 'ruwer', 'bernkastel', 'piesport', 'graach', 'wehlen', 'trittenheim', 'zeltingen', 'ürzig', 'erden', 'brauneberg', 'winningen', 'kröv']],
    ['Nahe', ['nahe', 'schlossböckelheim', 'niederhausen', 'monzingen', 'bad kreuznach', 'norheim']],
    ['Pfalz', ['pfalz', 'palatinate', 'rheinpfalz', 'deidesheim', 'forst', 'wachenheim', 'bad dürkheim', 'ungstein', 'kallstadt', 'birkweiler', 'siebeldingen', 'südliche weinstraße', 'mittelhaardt']],
    ['Ahr', ['ahr']],
    ['Franconia', ['franken', 'franconia', 'steigerwald', 'würzburg', 'escherndorf', 'iphofen', 'volkach', 'sulzfeld', 'randersacker']],
    ['Baden', ['baden', 'kaiserstuhl', 'ortenau', 'markgräflerland', 'breisgau', 'tuniberg', 'kraichgau', 'badische bergstraße', 'tauberfranken', 'durbach', 'ihringen', 'bodensee', 'lake constance']],
    ['Württemberg', ['württemberg', 'wurttemberg', 'remstal', 'heilbronn', 'stuttgart']],
    ['Saxony', ['sachsen', 'saxony', 'meißen', 'meissen', 'elbtal', 'radebeul']],
  ],
  FRA: [
    ['Bordeaux', ['bordeaux', 'médoc', 'medoc', 'pauillac', 'margaux', 'saint-julien', 'saint-estèphe', 'saint-émilion', 'st-émilion', 'pomerol', 'graves', 'pessac-léognan', 'sauternes', 'barsac', 'entre-deux-mers', 'fronsac']],
    ['Beaujolais', ['beaujolais', 'morgon', 'fleurie', 'moulin-à-vent', 'brouilly', 'juliénas', 'chiroubles', 'régnié', 'chénas', 'saint-amour']],
    ['Burgundy', ['burgundy', 'bourgogne', 'burgund', 'chablis', 'côte de nuits', 'côte de beaune', "côte d'or", 'mâconnais', 'macon', 'chalonnaise', 'meursault', 'puligny', 'chassagne', 'gevrey', 'vosne', 'nuits-saint-georges', 'pommard', 'volnay', 'pouilly-fuissé']],
    ['Champagne', ['champagne', 'reims', 'épernay', 'côte des blancs', 'montagne de reims', 'vallée de la marne']],
    ['Alsace', ['alsace', 'elsass']],
    ['Loire', ['loire', 'val de loire', 'sancerre', 'pouilly-fumé', 'vouvray', 'muscadet', 'anjou', 'saumur', 'chinon', 'bourgueil', 'touraine', 'savennières', 'menetou-salon', 'quincy', 'reuilly']],
    ['Rhône', ['rhône', 'rhone', 'côtes du rhône', 'châteauneuf-du-pape', 'hermitage', 'crozes-hermitage', 'côte-rôtie', 'condrieu', 'gigondas', 'vacqueyras', 'cornas', 'saint-joseph', 'tavel', 'lirac', 'rasteau', 'ventoux', 'costières de nîmes']],
    ['Provence', ['provence', 'bandol', 'cassis', 'bellet', 'palette']],
    ['Languedoc-Roussillon', ['languedoc', 'roussillon', 'languedoc-roussillon', 'minervois', 'corbières', 'pic saint-loup', 'faugères', 'saint-chinian', 'fitou', 'limoux', 'banyuls', 'collioure', 'maury']],
    ['South West', ['south west', 'southwest', 'sud-ouest', 'sud ouest', 'südwestfrankreich', 'cahors', 'bergerac', 'madiran', 'jurançon', 'gaillac', 'fronton', 'monbazillac', 'irouléguy', 'gascogne']],
    ['Jura', ['jura', 'arbois', "château-chalon", "l'étoile"]],
    ['Savoie', ['savoie', 'savoy', 'savoyen']],
    ['Corsica', ['corsica', 'corse', 'korsika', 'patrimonio', 'ajaccio']],
  ],
  ITA: [
    ['South Tyrol', ['south tyrol', 'südtirol', 'alto adige', 'bozen', 'bolzano', 'eisacktal', 'valle isarco', 'kalterersee', 'kaltern', 'caldaro', 'terlan']],
    ['Trentino', ['trentino', 'trento', 'trient']],
    ['Piedmont', ['piedmont', 'piemonte', 'piemont', 'barolo', 'barbaresco', 'langhe', 'roero', 'asti', 'alba', 'gattinara', 'ghemme', 'gavi', 'monferrato']],
    ['Aosta Valley', ['aosta valley', "valle d'aosta", 'aostatal', 'aosta']],
    ['Lombardy', ['lombardy', 'lombardia', 'lombardei', 'franciacorta', 'lugana', 'valtellina', 'oltrepò pavese', 'oltrepo pavese']],
    ['Veneto', ['veneto', 'venetien', 'valpolicella', 'amarone', 'soave', 'bardolino', 'prosecco', 'valdobbiadene', 'conegliano']],
    ['Friuli-Venezia Giulia', ['friuli', 'friaul', 'friuli-venezia giulia', 'collio', 'colli orientali']],
    ['Liguria', ['liguria', 'ligurien', 'cinque terre']],
    ['Emilia-Romagna', ['emilia-romagna', 'emilia', 'romagna', 'lambrusco']],
    ['Tuscany', ['tuscany', 'toscana', 'toskana', 'chianti', 'montalcino', 'brunello', 'montepulciano', 'bolgheri', 'maremma', 'carmignano', 'morellino', 'san gimignano']],
    ['Umbria', ['umbria', 'umbrien', 'montefalco', 'orvieto', 'torgiano']],
    ['Marche', ['marche', 'marken', 'verdicchio', 'conero']],
    ['Lazio', ['lazio', 'latium', 'frascati']],
    ['Abruzzo', ['abruzzo', 'abruzzen']],
    ['Molise', ['molise']],
    ['Campania', ['campania', 'kampanien', 'taurasi', 'fiano di avellino', 'greco di tufo', 'irpinia']],
    ['Apulia', ['apulia', 'puglia', 'apulien', 'salento', 'manduria']],
    ['Basilicata', ['basilicata', 'vulture']],
    ['Calabria', ['calabria', 'kalabrien', 'cirò']],
    ['Sicily', ['sicily', 'sicilia', 'sizilien', 'etna', 'marsala', 'pantelleria', 'vittoria']],
    ['Sardinia', ['sardinia', 'sardegna', 'sardinien', 'cannonau', 'vermentino di gallura']],
  ],
};

const NOTES = {
  DEU: 'German wine regions (Anbaugebiete), drawn from whole districts, so the areas are larger than the vineyards. Boundaries: © EuroGeographics.',
  FRA: 'French wine regions, drawn from whole départements, so the borders are approximate.',
  ITA: 'Italian regions; South Tyrol and Trentino apart.',
};

/** Lookup spellings, as WorldMap: lower case, no accents, ß as ss, umlauts also as ae/oe/ue, other signs as spaces. */
function variants(s) {
  const base = String(s).toLowerCase().replace(/ß/g, 'ss');
  const plain = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return Array.from(new Set([plain(base), plain(base.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue'))])).filter(Boolean);
}

function main() {
  const [nutsFile, neFile] = process.argv.slice(2);
  if (!nutsFile || !neFile) { console.error('usage: node build_regions.js <nutsrg_3.json> <ne_10m_admin_1.geojson>'); process.exit(2); }
  const nuts = JSON.parse(fs.readFileSync(nutsFile, 'utf8'));
  const ne = JSON.parse(fs.readFileSync(neFile, 'utf8'));

  const deOf = {};
  for (const [k, codes] of Object.entries(DEU)) codes.forEach((c) => { if (deOf[c]) throw new Error('twice: ' + c); deOf[c] = k; });
  const frOf = {};
  for (const [k, codes] of Object.entries(FRA)) codes.forEach((c) => { if (frOf[c]) throw new Error('twice: ' + c); frOf[c] = k; });

  const sets = {
    DEU: nuts.features.filter((f) => /^DE/.test(f.properties.id)).map((f) => feature(f.geometry, deOf[f.properties.id])),
    FRA: ne.features.filter((f) => f.properties.adm0_a3 === 'FRA' && /^FR-(\d\d|2A|2B)$/.test(f.properties.iso_3166_2))
      .map((f) => feature(f.geometry, frOf[f.properties.iso_3166_2.slice(3)])),
    ITA: ne.features.filter((f) => f.properties.adm0_a3 === 'ITA').map((f) => {
      const p = f.properties;
      const k = p.iso_3166_2 === 'IT-BZ' ? 'South Tyrol' : p.iso_3166_2 === 'IT-TN' ? 'Trentino' : ITA[p.region];
      if (!k) throw new Error('Italian region without name: ' + p.region);
      return feature(f.geometry, k);
    }),
  };
  for (const c of ['DEU', 'FRA']) {
    const want = Object.keys(c === 'DEU' ? deOf : frOf).length;
    const got = sets[c].filter((f) => f.properties.kind === 'region').length;
    if (want !== got) throw new Error(c + ': ' + got + ' of ' + want + ' units found');
  }
  const out = {};
  const ROT = { DEU: [-10.4, 0], FRA: [-2.5, 0], ITA: [-12.5, 0] };
  const SIMPLIFY = { DEU: 'interval=500', FRA: 'interval=900', ITA: 'interval=900' };
  let chain = Promise.resolve();
  for (const c of Object.keys(sets)) {
    chain = chain.then(() => mapshaper.applyCommands(
      `-i in.json -dissolve key copy-fields=kind -simplify ${SIMPLIFY[c]} keep-shapes -o out.json format=geojson`,
      { 'in.json': { type: 'FeatureCollection', features: sets[c] } },
    )).then((res) => { out[c] = build(JSON.parse(res['out.json']), ROT[c], c); });
  }
  return chain.then(() => {
    const js = '/* Generated by tools/build_regions.js. Germany: © EuroGeographics for the administrative boundaries (Eurostat GISCO NUTS 2021);\n' +
      ' * France and Italy: Natural Earth (public domain). Do not edit by hand. */\n' +
      'var WINE_REGIONS = ' + JSON.stringify(out) + ';\n' +
      "if (typeof window !== 'undefined') { window.WINE_REGIONS = WINE_REGIONS; }\n" +
      "if (typeof module !== 'undefined' && module.exports) { module.exports = WINE_REGIONS; }\n";
    fs.writeFileSync(OUT, js);
    for (const c of Object.keys(out)) console.log(`${c}: ${out[c].units.length} regions, ${out[c].w}x${out[c].h}`);
    console.log(`${(js.length / 1024).toFixed(0)} KB -> ${path.relative(path.join(__dirname, '..'), OUT)}`);
  });
}

function feature(geometry, key) {
  return { type: 'Feature', properties: key ? { key, kind: 'region' } : { key: '_rest', kind: 'context' }, geometry };
}

function build(fc, rotate, country) {
  const fixPoly = (c) => (d3.geoArea({ type: 'Polygon', coordinates: c }) > 2 * Math.PI ? c.map((r) => r.slice().reverse()) : c);
  fc.features = fc.features.filter((f) => f.geometry);
  fc.features.forEach((f) => {
    const g = f.geometry;
    g.coordinates = g.type === 'Polygon' ? fixPoly(g.coordinates) : g.coordinates.map(fixPoly);
  });
  const proj = d3.geoTransverseMercator().rotate(rotate).fitWidth(WIDTH, fc);
  const geoPath = d3.geoPath(proj).digits(1);
  const bounds = geoPath.bounds(fc);
  const pad = 30;
  proj.translate([proj.translate()[0] - bounds[0][0] + pad, proj.translate()[1] - bounds[0][1] + pad]);
  const width = Math.ceil(bounds[1][0] - bounds[0][0] + 2 * pad);
  const height = Math.ceil(bounds[1][1] - bounds[0][1] + 2 * pad);
  const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((c) => ({ type: 'Polygon', coordinates: c }));
  const round = (v) => Math.round(v * 10) / 10;

  const units = [];
  const context = [];
  for (const f of fc.features) {
    const parts = polysOf(f.geometry).map((g) => ({ g, area: geoPath.area(g) })).sort((a, z) => z.area - a.area);
    const kept = parts.filter((x, i) => i === 0 || x.area >= 3);
    const d = relative(geoPath({ type: 'MultiPolygon', coordinates: kept.map((x) => x.g.coordinates) }));
    if (f.properties.kind === 'context') { context.push({ n: country, d }); continue; }
    units.push({
      k: f.properties.key, n: f.properties.key, d,
      b: geoPath.bounds(parts[0].g).flat().map(Math.round),
      c: geoPath.centroid(parts[0].g).map(round),
    });
  }
  units.sort((a, z) => a.k.localeCompare(z.k));
  const aliases = ALIASES[country].map(([k, words]) => {
    if (!units.some((u) => u.k === k)) throw new Error(country + ': alias for unknown region ' + k);
    return [k, Array.from(new Set(words.flatMap(variants)))];
  });
  return { w: width, h: height, units, groups: {}, points: [], context, aliases, note: NOTES[country] };
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

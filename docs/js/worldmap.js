/*
 * Maps for Stats: country names to map shapes, Scotch whisky regions, and an SVG with one number
 * per country or region. Shapes come from worldmap-data.js and scotland-data.js (Natural Earth,
 * public domain). No network, no library.
 * Runs in the browser (window.WorldMap) and in node for tests (module.exports).
 */
var WorldMap = (function () {
  'use strict';

  var D = (typeof WORLD_MAP_DATA !== 'undefined') ? WORLD_MAP_DATA
    : (typeof require === 'function' ? require('./worldmap-data.js') : null);
  var byKey = {};
  D.units.forEach(function (u) { byKey[u.k] = u; });

  // Colour classes by bottle count: 1, 2-3, 4-6, 7-12, 13+. Fixed, so a colour means the same count every time.
  var CLASS_MIN = [1, 2, 4, 7, 13];

  /** Lookup spellings of a name; same rule as tools/build_worldmap.js. */
  function variants(s) {
    var base = String(s).toLowerCase().replace(/ß/g, 'ss');
    var plain = function (t) {
      return t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');
    };
    var a = plain(base);
    var b = plain(base.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue'));
    return a === b ? [a] : [a, b];
  }

  /** Map key ('FRA', 'SCT', group 'GBR') for a country as typed, or '' if the map does not know it. */
  function resolve(country) {
    var s = String(country === null || country === undefined ? '' : country).trim();
    if (!s) return '';
    var v = variants(s);
    for (var i = 0; i < v.length; i++) if (v[i] && D.names[v[i]]) return D.names[v[i]];
    return '';
  }

  /** Edit distance, for spelling suggestions. */
  function distance(a, b) {
    var prev = []; var cur = [];
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur = [i];
      for (var k = 1; k <= b.length; k++) {
        cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /** The map's name for a misspelt country ("Scottland" -> "Scotland"), or '' if nothing is close. */
  function suggest(country) {
    if (resolve(country)) return nameOf(resolve(country));
    var q = variants(country)[0];
    if (q.length < 4) return '';
    var best = ''; var bestD = Infinity;
    Object.keys(D.names).forEach(function (n) {
      if (n.length < 4 || Math.abs(n.length - q.length) > 2) return;
      var d = distance(q, n);
      if (d < bestD) { bestD = d; best = D.names[n]; }
    });
    return bestD <= (q.length >= 7 ? 2 : 1) ? nameOf(best) : '';
  }

  function nameOf(key) {
    if (D.groups[key]) return D.groups[key].n;
    return byKey[key] ? byKey[key].n : key;
  }

  function classOf(n) {
    var c = 0;
    for (var i = 0; i < CLASS_MIN.length; i++) if (n >= CLASS_MIN[i]) c = i + 1;
    return c;
  }

  /** Legend steps up to the class of the largest count: [{ cls, label }]. */
  function legend(max) {
    var out = [];
    for (var i = 0; i < CLASS_MIN.length && CLASS_MIN[i] <= max; i++) {
      var lo = CLASS_MIN[i];
      var hi = i + 1 < CLASS_MIN.length ? CLASS_MIN[i + 1] - 1 : null;
      out.push({ cls: i + 1, label: hi === null ? lo + '+' : (hi === lo ? String(lo) : lo + '–' + hi) });
    }
    return out;
  }

  // ---------- geometry sets: the world (D) and the Scotch whisky regions (SC) ----------

  function indexOf(G) {
    var ix = { byKey: {}, groupOf: {}, point: {} };
    G.units.forEach(function (u) { ix.byKey[u.k] = u; });
    Object.keys(G.groups || {}).forEach(function (g) { G.groups[g].units.forEach(function (k) { ix.groupOf[k] = g; }); });
    (G.points || []).forEach(function (p) { ix.point[p.k] = p; });
    return ix;
  }
  var IX = indexOf(D);
  var SC = (typeof SCOTLAND_DATA !== 'undefined') ? SCOTLAND_DATA
    : (typeof require === 'function' ? require('./scotland-data.js') : null);
  var SIX = SC ? indexOf(SC) : null;

  function itemOf(G, ix, key) { return (G.groups && G.groups[key]) || ix.byKey[key] || ix.point[key] || null; }
  function onMap(key) { return !!itemOf(D, IX, key); }

  /**
   * View box [x, y, w, h] around the given keys, with a margin, at least 11 % of the map wide,
   * width:height between 1.25 and 2, and inside the map where possible.
   */
  function fitBox(keys, G, ix) {
    G = G || D; ix = ix || IX;
    var MIN_W = 0.11 * G.w;
    var x0 = Infinity; var y0 = Infinity; var x1 = -Infinity; var y1 = -Infinity;
    keys.forEach(function (k) {
      var it = itemOf(G, ix, k);
      if (!it) return;
      var b = it.b;
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
    });
    if (x0 === Infinity) return [0, 0, G.w, G.h];
    var w = x1 - x0; var h = y1 - y0;
    var pad = Math.max(0.01 * G.w, 0.15 * Math.max(w, h));
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    w = x1 - x0; h = y1 - y0;
    if (w < MIN_W) { x0 -= (MIN_W - w) / 2; w = MIN_W; }
    if (w / h < 1.25) { x0 -= (h * 1.25 - w) / 2; w = h * 1.25; }
    if (w / h > 2) { y0 -= (w / 2 - h) / 2; h = w / 2; }
    if (w >= G.w || h >= G.h) return [0, 0, G.w, G.h];
    x0 = Math.min(Math.max(x0, 0), G.w - w);
    y0 = Math.min(Math.max(y0, 0), G.h - h);
    return [x0, y0, w, h].map(function (v) { return Math.round(v * 10) / 10; });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  // ---------- shapes as polygons, for "is this point on land?" ----------

  /** Rings of a compact path ("M x,y l dx,dy ... z"), as flat [x0, y0, x1, y1, ...] arrays with boxes. */
  function ringsOf(d, key) {
    var out = [];
    d.split('M').forEach(function (part) {
      if (!part) return;
      var nums = part.replace(/z/g, '').replace('l', ' ').match(/-?(\d+\.?\d*|\.\d+)/g);
      if (!nums || nums.length < 6) return;
      var pts = []; var x = Number(nums[0]); var y = Number(nums[1]);
      var bb = [x, y, x, y];
      pts.push(x, y);
      for (var i = 2; i + 1 < nums.length; i += 2) {
        x += Number(nums[i]); y += Number(nums[i + 1]);
        pts.push(x, y);
        if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y;
      }
      out.push({ key: key, pts: pts, bb: bb });
    });
    return out;
  }

  var CELLS = 24;
  /** All rings of a geometry set with a grid index, built once. */
  function landOf(G) {
    if (G._land) return G._land;
    var rings = [];
    G.units.forEach(function (u) { rings = rings.concat(ringsOf(u.d, u.k)); });
    (G.context || []).forEach(function (c) { rings = rings.concat(ringsOf(c.d, '')); });
    var cw = G.w / CELLS; var ch = G.h / CELLS;
    var grid = [];
    for (var i = 0; i < CELLS * CELLS; i++) grid.push([]);
    rings.forEach(function (r, idx) {
      var c0 = Math.max(0, Math.floor(r.bb[0] / cw)); var c1 = Math.min(CELLS - 1, Math.floor(r.bb[2] / cw));
      var r0 = Math.max(0, Math.floor(r.bb[1] / ch)); var r1_ = Math.min(CELLS - 1, Math.floor(r.bb[3] / ch));
      for (var cx = c0; cx <= c1; cx++) for (var cy = r0; cy <= r1_; cy++) grid[cy * CELLS + cx].push(idx);
    });
    G._land = { rings: rings, grid: grid, cw: cw, ch: ch };
    return G._land;
  }

  function inRing(r, x, y) {
    if (x < r.bb[0] || x > r.bb[2] || y < r.bb[1] || y > r.bb[3]) return false;
    var p = r.pts; var inside = false;
    for (var i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      var yi = p[i + 1]; var yj = p[j + 1];
      if ((yi > y) !== (yj > y) && x < (p[j] - p[i]) * (y - yi) / (yj - yi) + p[i]) inside = !inside;
    }
    return inside;
  }

  /** Key of the shape under a point: a unit key, '' for context land, null for sea. */
  function shapeAt(land, x, y) {
    var cx = Math.floor(x / land.cw); var cy = Math.floor(y / land.ch);
    if (cx < 0 || cy < 0 || cx >= CELLS || cy >= CELLS) return null;
    var list = land.grid[cy * CELLS + cx];
    for (var i = 0; i < list.length; i++) { var r = land.rings[list[i]]; if (inRing(r, x, y)) return r.key; }
    return null;
  }

  // ---------- number badges ----------

  var INSIDE_PX = 44;   // default: a shape at least this wide and high (on screen) keeps its number inside

  /** Do segments p1-p2 and p3-p4 cross? */
  function crosses(p1, p2, p3, p4) {
    function side(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
    var d1 = side(p3, p4, p1); var d2 = side(p3, p4, p2); var d3 = side(p1, p2, p3); var d4 = side(p1, p2, p4);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  }

  function segDist(p, a, b) {
    var dx = b[0] - a[0]; var dy = b[1] - a[1];
    var t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
    var x = a[0] + t * dx - p[0]; var y = a[1] + t * dy - p[1];
    return Math.sqrt(x * x + y * y);
  }

  /**
   * Badge positions. A badge stays on a large shape. For a small shape or a point it goes outside,
   * with a leader line. Candidates lie on rings around the shape; the best one keeps clear of the
   * shapes with bottles (its own first), other badges, crossing lines and the map edge, and prefers sea.
   * items: [{ key, n, anchor:[x,y], box:[x0,y0,x1,y1], r, units:[unit keys] }] in map units.
   * shapeAtFn(x, y): unit key, '' (other land) or null (sea). Adds x, y and outside to each item.
   */
  function placeBadges(items, vb, unit, shapeAtFn, insidePx) {
    insidePx = insidePx || INSIDE_PX;
    var placed = [];
    var lines = [];
    var gap = 3 * unit;
    var owner = {};
    items.forEach(function (it) { (it.units || []).forEach(function (k) { owner[k] = it; }); });
    items.forEach(function (it) {
      var bw = (it.box[2] - it.box[0]) / unit; var bh = (it.box[3] - it.box[1]) / unit;
      it.outside = !(bw >= insidePx && bh >= insidePx);
      if (!it.outside) { it.x = it.anchor[0]; it.y = it.anchor[1]; placed.push(it); }
    });
    var ring = [];
    for (var s = 0; s < 8; s++) ring.push([Math.cos(s * Math.PI / 4) * 0.95, Math.sin(s * Math.PI / 4) * 0.95]);
    var out = items.filter(function (it) { return it.outside; }).sort(function (a, b) { return b.n - a.n || (a.key < b.key ? -1 : 1); });
    out.forEach(function (it) {
      var ax = it.anchor[0]; var ay = it.anchor[1];
      var half = Math.sqrt(Math.pow(it.box[2] - it.box[0], 2) + Math.pow(it.box[3] - it.box[1], 2)) / 2;
      var best = null;
      [1, 1.5, 2.1, 3].forEach(function (f) {
        var R = (Math.min(half, 30 * unit) + it.r + 10 * unit) * f;
        for (var deg = 0; deg < 360; deg += 15) {
          var a = deg * Math.PI / 180;
          var x = ax + R * Math.cos(a); var y = ay + R * Math.sin(a);
          var score = R / unit * 0.8;
          var m = 2 * unit;
          if (x - it.r < vb[0] + m || y - it.r < vb[1] + m || x + it.r > vb[0] + vb[2] - m || y + it.r > vb[1] + vb[3] - m) score += 1e6;
          for (var i = 0; i < placed.length; i++) {
            var p = placed[i];
            var d = Math.sqrt((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y));
            if (d < p.r + it.r + gap) score += 1e5;
            if (p !== it && segDist([p.x, p.y], [ax, ay], [x, y]) < p.r) score += 3000;
          }
          for (var j = 0; j < lines.length; j++) if (crosses([ax, ay], [x, y], lines[j][0], lines[j][1])) score += 2000;
          if (score < 1e5) {
            for (var q = -1; q < ring.length; q++) {
              var sx = q < 0 ? x : x + ring[q][0] * it.r; var sy = q < 0 ? y : y + ring[q][1] * it.r;
              var hit = shapeAtFn(sx, sy);
              if (hit === null) continue;
              var o = owner[hit];
              score += o === it ? 300 : (o ? 150 : 14);
            }
            // The line should not run across other countries with bottles.
            for (var t = 0.2; t < 0.9; t += 0.2) {
              var lh = shapeAtFn(ax + (x - ax) * t, ay + (y - ay) * t);
              if (lh !== null && owner[lh] && owner[lh] !== it) score += 60;
            }
          }
          if (!best || score < best.score) best = { x: x, y: y, score: score };
        }
      });
      it.x = best.x; it.y = best.y;
      placed.push(it);
      lines.push([[ax, ay], [it.x, it.y]]);
    });
    return items;
  }

  /**
   * SVG text for a map.
   * G: geometry set; rows: [{ key, n }]; keys not in G are ignored.
   * opts: { view: 'fit' | 'full', px: rendered width in CSS pixels, kind: facet kind for taps, insidePx, cls,
   *         title: fn(key, n) -> tooltip text, name: fn(key) -> name, label: accessible description }
   * Shapes, points and badges with bottles carry data-act="facet" data-kind=<kind> data-value=<key>.
   */
  function draw(G, ix, rows, opts) {
    var count = {};
    rows.forEach(function (r) { if (itemOf(G, ix, r.key)) count[r.key] = (count[r.key] || 0) + r.n; });
    var keys = Object.keys(count);
    var vb = opts.view === 'full' ? [0, 0, G.w, G.h] : fitBox(keys, G, ix);
    var unit = vb[2] / Math.max(120, opts.px || 360);   // map units per CSS pixel
    var name = opts.name || function (k) { var it = itemOf(G, ix, k); return it ? it.n : k; };
    var title = opts.title || function (k, n) { return name(k) + ': ' + n; };
    var tap = function (key) { return ' data-act="facet" data-kind="' + opts.kind + '" data-value="' + esc(key) + '"'; };

    var context = (G.context || []).map(function (c) { return '<path class="wm-ctx" d="' + c.d + '"/>'; }).join('');
    var shapes = G.units.map(function (u) {
      var key = count[u.k] ? u.k : (ix.groupOf[u.k] && count[ix.groupOf[u.k]] ? ix.groupOf[u.k] : '');
      if (!key) return '<path class="wm-u" d="' + u.d + '"/>';
      var n = count[key];
      return '<path class="wm-u wm-k' + classOf(n) + '" d="' + u.d + '"' + tap(key) + '><title>' + esc(title(key, n)) + '</title></path>';
    }).join('');
    var points = (G.points || []).map(function (p) {
      var n = count[p.k];
      return '<circle class="wm-pt' + (n ? ' wm-k' + classOf(n) : '') + '" cx="' + p.c[0] + '" cy="' + p.c[1] + '" r="' + r1(4 * unit) + '"' +
        (n ? tap(p.k) + '><title>' + esc(title(p.k, n)) + '</title></circle>' : '/>');
    }).join('');

    var items = keys.map(function (k) {
      var it = itemOf(G, ix, k);
      var digits = String(count[k]).length;
      var units = G.groups && G.groups[k] ? G.groups[k].units.filter(function (u) { return !count[u]; }) : (ix.byKey[k] ? [k] : []);
      return { key: k, n: count[k], anchor: it.c, box: it.b, r: (digits > 2 ? 13 : 10) * unit, units: units };
    });
    var land = landOf(G);
    placeBadges(items, vb, unit, function (x, y) { return shapeAt(land, x, y); }, opts.insidePx);

    var lead = items.filter(function (p) { return p.outside; }).map(function (p) {
      return '<line class="wm-lead" x1="' + r1(p.anchor[0]) + '" y1="' + r1(p.anchor[1]) + '" x2="' + r1(p.x) + '" y2="' + r1(p.y) + '"/>' +
        '<circle class="wm-dot" cx="' + r1(p.anchor[0]) + '" cy="' + r1(p.anchor[1]) + '" r="' + r1(1.8 * unit) + '"/>';
    }).join('');
    var badges = items.map(function (p) {
      return '<g class="wm-b"' + tap(p.key) + '><title>' + esc(title(p.key, p.n)) + '</title>' +
        '<circle cx="' + r1(p.x) + '" cy="' + r1(p.y) + '" r="' + r1(p.r) + '"/>' +
        '<text x="' + r1(p.x) + '" y="' + r1(p.y) + '" dy=".35em" font-size="' + r1(11 * unit) + '">' + p.n + '</text></g>';
    }).join('');

    return '<svg class="wm' + (opts.cls ? ' ' + opts.cls : '') + '" viewBox="' + vb.join(' ') + '" role="img" aria-label="' + esc(opts.label || 'Map') + '">' +
      '<rect class="wm-sea" x="' + vb[0] + '" y="' + vb[1] + '" width="' + vb[2] + '" height="' + vb[3] + '"/>' +
      context + shapes + points + lead + badges + '</svg>';
  }

  /** World map. opts.view: 'fit' (your countries) or 'world'. Taps: kind "ctry". */
  function render(rows, opts) {
    opts = opts || {};
    return draw(D, IX, rows, {
      view: opts.view === 'world' ? 'full' : 'fit', px: opts.px, kind: 'ctry', title: opts.title,
      name: nameOf, label: opts.label || 'World map'
    });
  }

  // ---------- Scotch whisky regions ----------

  /** Region key ('Islay', 'Skye', 'Islands', ...) for a region as typed, or '' if none fits. */
  function scotlandRegion(text) {
    if (!SC) return '';
    var t = ' ' + variants(text || '')[0] + ' ';
    if (!t.trim()) return '';
    for (var i = 0; i < SC.aliases.length; i++) {
      var words = SC.aliases[i][1];
      for (var j = 0; j < words.length; j++) if (t.indexOf(' ' + words[j] + ' ') >= 0) return SC.aliases[i][0];
    }
    return '';
  }

  /** Scotland map with whisky regions. Taps: kind "wregion". */
  function renderScotland(rows, opts) {
    opts = opts || {};
    // Only Highlands and Lowlands are large enough to keep their number inside.
    return draw(SC, SIX, rows, { view: 'full', px: opts.px, kind: 'wregion', title: opts.title, cls: 'wm-sc', insidePx: 90, label: opts.label || 'Map of Scotland' });
  }

  function r1(v) { return Math.round(v * 100) / 100; }

  return {
    data: D, scotland: SC, resolve: resolve, suggest: suggest, nameOf: nameOf, onMap: onMap, classOf: classOf, legend: legend,
    fitBox: fitBox, render: render, renderScotland: renderScotland, scotlandRegion: scotlandRegion, placeBadges: placeBadges,
    variants: variants, CLASS_MIN: CLASS_MIN
  };
})();

if (typeof window !== 'undefined') { window.WorldMap = WorldMap; }
if (typeof module !== 'undefined' && module.exports) { module.exports = WorldMap; }

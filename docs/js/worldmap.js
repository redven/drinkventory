/*
 * World map for Stats: country names to map shapes, and an SVG with one number per country.
 * Shapes come from worldmap-data.js (Natural Earth, public domain). No network, no library.
 * Runs in the browser (window.WorldMap) and in node for tests (module.exports).
 */
var WorldMap = (function () {
  'use strict';

  var D = (typeof WORLD_MAP_DATA !== 'undefined') ? WORLD_MAP_DATA
    : (typeof require === 'function' ? require('./worldmap-data.js') : null);
  var byKey = {};
  var groupOfUnit = {};
  D.units.forEach(function (u) { byKey[u.k] = u; });
  Object.keys(D.groups).forEach(function (g) { D.groups[g].units.forEach(function (k) { groupOfUnit[k] = g; }); });

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

  function boxOf(key) { return D.groups[key] ? D.groups[key].b : (byKey[key] ? byKey[key].b : null); }
  function pointOf(key) { return D.groups[key] ? D.groups[key].c : (byKey[key] ? byKey[key].c : null); }
  function onMap(key) { return !!(D.groups[key] || byKey[key]); }

  /**
   * View box [x, y, w, h] around the given keys, with a margin, at least MIN_W wide,
   * width:height between 1.25 and 2, and inside the world where possible.
   */
  function fitBox(keys) {
    var MIN_W = 110;
    var x0 = Infinity; var y0 = Infinity; var x1 = -Infinity; var y1 = -Infinity;
    keys.forEach(function (k) {
      var b = boxOf(k);
      if (!b) return;
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
    });
    if (x0 === Infinity) return [0, 0, D.w, D.h];
    var w = x1 - x0; var h = y1 - y0;
    var pad = Math.max(10, 0.15 * Math.max(w, h));
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    w = x1 - x0; h = y1 - y0;
    if (w < MIN_W) { x0 -= (MIN_W - w) / 2; w = MIN_W; }
    if (w / h < 1.25) { x0 -= (h * 1.25 - w) / 2; w = h * 1.25; }
    if (w / h > 2) { y0 -= (w / 2 - h) / 2; h = w / 2; }
    if (w >= D.w || h >= D.h) return [0, 0, D.w, D.h];
    x0 = Math.min(Math.max(x0, 0), D.w - w);
    y0 = Math.min(Math.max(y0, 0), D.h - h);
    return [x0, y0, w, h].map(function (v) { return Math.round(v * 10) / 10; });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  /**
   * Badge positions: start at each country's label point, then push overlapping badges apart.
   * pts: [{ x, y, r }] in map units; changed in place.
   */
  function spread(pts) {
    for (var it = 0; it < 60; it++) {
      var moved = false;
      for (var i = 0; i < pts.length; i++) {
        for (var j = i + 1; j < pts.length; j++) {
          var a = pts[i]; var b = pts[j];
          var dx = b.x - a.x; var dy = b.y - a.y;
          var d = Math.sqrt(dx * dx + dy * dy);
          var need = a.r + b.r + a.gap;
          if (d >= need) continue;
          if (d < 1e-6) { dx = 1; dy = 0; d = 1; }
          var push = (need - d) / 2;
          a.x -= dx / d * push; a.y -= dy / d * push;
          b.x += dx / d * push; b.y += dy / d * push;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  /**
   * SVG text for the map.
   * rows: [{ key, n }] with keys from resolve(); keys not on the map are ignored.
   * opts: { view: 'fit' | 'world', px: rendered width in CSS pixels, title: fn(key, n) -> tooltip text,
   *         label: accessible description }
   * Shapes and number badges with bottles carry data-act="facet" data-kind="ctry" data-value=<key>.
   */
  function render(rows, opts) {
    opts = opts || {};
    var count = {};
    rows.forEach(function (r) { if (onMap(r.key)) count[r.key] = (count[r.key] || 0) + r.n; });
    var keys = Object.keys(count);
    var vb = opts.view === 'world' ? [0, 0, D.w, D.h] : fitBox(keys);
    var unit = vb[2] / Math.max(120, opts.px || 360);   // map units per CSS pixel
    var title = opts.title || function (k, n) { return nameOf(k) + ': ' + n; };

    var shapes = D.units.map(function (u) {
      var key = count[u.k] ? u.k : (groupOfUnit[u.k] && count[groupOfUnit[u.k]] ? groupOfUnit[u.k] : '');
      if (!key) return '<path class="wm-u" d="' + u.d + '"/>';
      var n = count[key];
      return '<path class="wm-u wm-k' + classOf(n) + '" d="' + u.d + '" data-act="facet" data-kind="ctry" data-value="' + esc(key) + '">' +
        '<title>' + esc(title(key, n)) + '</title></path>';
    }).join('');

    var pts = keys.map(function (k) {
      var c = pointOf(k);
      var digits = String(count[k]).length;
      return { key: k, n: count[k], x0: c[0], y0: c[1], x: c[0], y: c[1], r: (digits > 2 ? 13 : 10) * unit, gap: 2 * unit };
    }).sort(function (a, b) { return b.n - a.n; });
    spread(pts);

    var badges = pts.map(function (p) {
      var dx = p.x - p.x0; var dy = p.y - p.y0;
      var lead = Math.sqrt(dx * dx + dy * dy) > p.r * 0.8
        ? '<line class="wm-lead" x1="' + r1(p.x0) + '" y1="' + r1(p.y0) + '" x2="' + r1(p.x) + '" y2="' + r1(p.y) + '"/>' +
          '<circle class="wm-dot" cx="' + r1(p.x0) + '" cy="' + r1(p.y0) + '" r="' + r1(1.6 * unit) + '"/>'
        : '';
      return lead + '<g class="wm-b" data-act="facet" data-kind="ctry" data-value="' + esc(p.key) + '">' +
        '<title>' + esc(title(p.key, p.n)) + '</title>' +
        '<circle cx="' + r1(p.x) + '" cy="' + r1(p.y) + '" r="' + r1(p.r) + '"/>' +
        '<text x="' + r1(p.x) + '" y="' + r1(p.y) + '" dy=".35em" font-size="' + r1(11 * unit) + '">' + p.n + '</text></g>';
    }).join('');

    return '<svg class="wm" viewBox="' + vb.join(' ') + '" role="img" aria-label="' + esc(opts.label || 'World map') + '">' +
      '<rect class="wm-sea" x="' + vb[0] + '" y="' + vb[1] + '" width="' + vb[2] + '" height="' + vb[3] + '"/>' +
      shapes + badges + '</svg>';
  }

  function r1(v) { return Math.round(v * 100) / 100; }

  return {
    data: D, resolve: resolve, suggest: suggest, nameOf: nameOf, onMap: onMap, classOf: classOf, legend: legend,
    fitBox: fitBox, render: render, variants: variants, CLASS_MIN: CLASS_MIN
  };
})();

if (typeof window !== 'undefined') { window.WorldMap = WorldMap; }
if (typeof module !== 'undefined' && module.exports) { module.exports = WorldMap; }

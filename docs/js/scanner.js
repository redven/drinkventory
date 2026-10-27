/*
 * Live QR scanning with the rear camera.
 * Uses the native BarcodeDetector where it exists, otherwise jsQR on a
 * downscaled centre crop of the video frame.
 */
var Scanner = (function () {
  'use strict';

  var stream = null;
  var video = null;
  var canvas = null;
  var ctx = null;
  var timer = null;
  var detector = null;
  var onCode = null;
  var last = { code: '', t: 0 };
  var running = false;
  var INTERVAL_MS = 120;
  var REPEAT_MS = 2500;

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function makeDetector() {
    if (!('BarcodeDetector' in window)) return Promise.resolve(null);
    try {
      return window.BarcodeDetector.getSupportedFormats().then(function (f) {
        return f.indexOf('qr_code') >= 0 ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
      }).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function start(videoEl, callback) {
    stop();
    if (!supported()) return Promise.reject(new Error('This browser has no camera access.'));
    video = videoEl;
    onCode = callback;
    canvas = canvas || document.createElement('canvas');
    ctx = ctx || canvas.getContext('2d', { willReadFrequently: true });
    running = true;
    return makeDetector().then(function (d) {
      detector = d;
      return navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
    }).then(function (s) {
      if (!running) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = s;
      video.setAttribute('playsinline', '');
      video.muted = true;
      video.srcObject = s;
      return video.play().then(function () { loop(); });
    });
  }

  function stop() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (video) { try { video.pause(); video.srcObject = null; } catch (e) { /* ignore */ } }
  }

  function emit(raw) {
    var now = Date.now();
    if (raw === last.code && now - last.t < REPEAT_MS) return;
    last = { code: raw, t: now };
    if (onCode) onCode(raw);
  }

  function loop() {
    if (!running) return;
    var done = function () { if (running) timer = setTimeout(loop, INTERVAL_MS); };
    if (!video || video.readyState < 2 || !video.videoWidth) { done(); return; }
    if (detector) {
      detector.detect(video).then(function (codes) {
        if (codes && codes.length && codes[0].rawValue) emit(codes[0].rawValue);
      }).catch(function () { detector = null; }).then(done);
      return;
    }
    try {
      var vw = video.videoWidth;
      var vh = video.videoHeight;
      var side = Math.min(vw, vh) * 0.8;
      var scale = Math.min(1, 520 / side);
      var w = Math.round(side * scale);
      canvas.width = w;
      canvas.height = w;
      ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, w, w);
      var img = ctx.getImageData(0, 0, w, w);
      var res = window.jsQR ? window.jsQR(img.data, w, w, { inversionAttempts: 'attemptBoth' }) : null;
      if (res && res.data) emit(res.data);
    } catch (e) { /* frame not ready */ }
    done();
  }

  /** Torch on/off where the platform exposes it. Returns false if unsupported. */
  function torch(on) {
    if (!stream) return Promise.resolve(false);
    var track = stream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return Promise.resolve(false);
    var caps = track.getCapabilities();
    if (!caps || !caps.torch) return Promise.resolve(false);
    return track.applyConstraints({ advanced: [{ torch: !!on }] }).then(function () { return true; }, function () { return false; });
  }

  function hasTorch() {
    if (!stream) return false;
    var track = stream.getVideoTracks()[0];
    try { return !!(track && track.getCapabilities && track.getCapabilities().torch); } catch (e) { return false; }
  }

  return { start: start, stop: stop, supported: supported, torch: torch, hasTorch: hasTorch };
})();

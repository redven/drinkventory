/*
 * Local storage on the phone.
 *   IndexedDB "cellar":
 *     kv      last snapshot of the data (state), misc values
 *     outbox  changes not yet confirmed by the server (in order)
 *     photos  label photos as data URLs, keyed by photo_id or "local:<op_id>"
 *   localStorage "cellar.settings": backend URL, key, user name
 */
var Store = (function () {
  'use strict';

  var DB_NAME = 'cellar';
  var DB_VERSION = 1;
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  /** Runs fn(store) in a transaction and resolves with the last request's result. */
  function run(storeName, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var req = fn(tx.objectStore(storeName));
        tx.oncomplete = function () { resolve(req ? req.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('transaction aborted')); };
      });
    });
  }

  var api = {
    get: function (store, key) { return run(store, 'readonly', function (s) { return s.get(key); }); },
    put: function (store, key, value) { return run(store, 'readwrite', function (s) { return key === null ? s.put(value) : s.put(value, key); }); },
    del: function (store, key) { return run(store, 'readwrite', function (s) { return s.delete(key); }); },
    all: function (store) { return run(store, 'readonly', function (s) { return s.getAll(); }); },
    clear: function (store) { return run(store, 'readwrite', function (s) { return s.clear(); }); },

    addOps: function (ops) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('outbox', 'readwrite');
          var s = tx.objectStore('outbox');
          ops.forEach(function (op) { s.add({ op: op }); });
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    },
    outbox: function () {
      return api.all('outbox').then(function (rows) {
        return rows.sort(function (a, b) { return a.seq - b.seq; });
      });
    },
    removeOps: function (seqs) {
      if (!seqs.length) return Promise.resolve();
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('outbox', 'readwrite');
          var s = tx.objectStore('outbox');
          seqs.forEach(function (q) { s.delete(q); });
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    },

    settings: function () {
      try {
        var s = JSON.parse(localStorage.getItem('cellar.settings') || '{}');
        return { apiUrl: s.apiUrl || '', apiKey: s.apiKey || '', user: s.user || '' };
      } catch (e) {
        return { apiUrl: '', apiKey: '', user: '' };
      }
    },
    saveSettings: function (s) {
      try { localStorage.setItem('cellar.settings', JSON.stringify(s)); return true; } catch (e) { return false; }
    },
    persist: function () {
      // Ask the browser not to evict our data (no effect where unsupported).
      try { if (navigator.storage && navigator.storage.persist) return navigator.storage.persist(); } catch (e) { /* ignore */ }
      return Promise.resolve(false);
    }
  };
  return api;
})();

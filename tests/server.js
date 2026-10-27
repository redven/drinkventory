/*
 * Local test servers:
 *   http://localhost:8787/exec  Code.gs running in the Apps Script mock (cross-origin, like the real backend)
 *   http://localhost:8080/      static web app from docs/
 * Prints the keys as JSON on the first line of stdout.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { createGas } = require('./gas-mock');

const root = path.join(__dirname, '..');
const gas = createGas();
const ctx = vm.createContext(gas.env);
vm.runInContext(
  fs.readFileSync(path.join(root, 'docs/js/logic.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(root, 'apps-script/Code.gs'), 'utf8'), ctx);
const keys = ctx.setup();

http.createServer((req, res) => {
  const send = (out) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(out.content);
  };
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/exec') { res.writeHead(404); res.end(); return; }
  if (req.method === 'GET') { send(ctx.doGet({ parameter: Object.fromEntries(url.searchParams) })); return; }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (process.env.SLOW) setTimeout(() => send(ctx.doPost({ postData: { contents: body } })), Number(process.env.SLOW));
      else send(ctx.doPost({ postData: { contents: body } }));
    });
    return;
  }
  res.writeHead(405); res.end();
}).listen(8787);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, 'docs', path.normalize(p));
  if (!file.startsWith(path.join(root, 'docs'))) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8080);

console.log(JSON.stringify(keys));

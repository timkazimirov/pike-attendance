// Local preview: serves public/ and runs apps-script/Code.gs against an
// in-memory fake of the Google services it uses. No dependencies.
//
//   node dev/server.mjs        → http://localhost:5173  (admin password: pike-dev)
//
// Data lives in memory and resets when the server restarts.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 5173;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pike-dev';
const LATENCY_MS = Number(process.env.LATENCY ?? 300);
const TZ = 'America/Los_Angeles';

// ---------- Fake Google services ----------

class FakeRange {
  constructor(sheet, row, col, rows, cols) {
    Object.assign(this, { sheet, row, col, rows, cols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.cols; c++) line.push(src[this.col - 1 + c] ?? '');
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return this;
  }
  getValue() { return this.getValues()[0][0]; }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  setFormula(f) { return this.setValue(f); }
  clearContent() {
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) this.sheet.set(this.row + r, this.col + c, '');
    return this;
  }
  setFontWeight() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; }
  getName() { return this.name; }
  set(row, col, v) {
    while (this.data.length < row) this.data.push([]);
    this.data[row - 1][col - 1] = v;
  }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) {
      if ((this.data[i] || []).some(v => v !== '' && v != null)) return i + 1;
    }
    return 0;
  }
  getRange(a, b, rows = 1, cols = 1) {
    if (typeof a === 'string') {
      const m = /^([A-Z]+)(\d+)$/.exec(a);
      return new FakeRange(this, Number(m[2]), m[1].charCodeAt(0) - 64, 1, 1);
    }
    return new FakeRange(this, a, b, rows, cols);
  }
  appendRow(values) {
    const row = this.getLastRow() + 1;
    values.forEach((v, c) => this.set(row, c + 1, v));
    return this;
  }
  deleteRow(row) { this.data.splice(row - 1, 1); return this; }
  setFrozenRows() { return this; }
  hideColumns() { return this; }
}

const book = {
  sheets: [new FakeSheet('Sheet1')],
  getSheetByName(name) { return this.sheets.find(s => s.name === name) || null; },
  insertSheet(name) { const s = new FakeSheet(name); this.sheets.push(s); return s; },
  deleteSheet(sheet) { this.sheets = this.sheets.filter(s => s !== sheet); },
  getSheets() { return [...this.sheets]; },
  getId() { return 'local-dev-sheet'; },
  getUrl() { return `http://localhost:${PORT}/__sheet`; },
  getSpreadsheetTimeZone() { return TZ; },
};

const props = new Map([['ADMIN_PASSWORD', ADMIN_PASSWORD]]);

const services = {
  console,
  SpreadsheetApp: { getActiveSpreadsheet: () => book, openById: () => book },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: k => props.get(k) ?? null,
      setProperty: (k, v) => { props.set(k, String(v)); },
    }),
  },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: text => ({ text, setMimeType() { return this; } }),
  },
  Session: { getScriptTimeZone: () => TZ },
  Utilities: {
    // Apps Script returns Java-style signed bytes.
    computeHmacSha256Signature: (value, key) =>
      [...crypto.createHmac('sha256', key).update(value).digest()].map(b => (b > 127 ? b - 256 : b)),
    getUuid: () => crypto.randomUUID(),
    formatDate: (date, tz) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
  },
};

const gs = vm.createContext(services);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps-script/Code.gs'), 'utf8'), gs, { filename: 'Code.gs' });
vm.runInContext('setup()', gs);

// ---------- HTTP ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api') {
    let body = '';
    for await (const chunk of req) body += chunk;
    await new Promise(r => setTimeout(r, LATENCY_MS));
    const out = req.method === 'POST' ? gs.doPost({ postData: { contents: body } }) : gs.doGet();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(out.text);
  }

  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'] });
    return res.end("window.PIKE_CONFIG = { API_URL: '/api' };\n");
  }

  if (url.pathname === '/__sheet') {
    res.writeHead(200, { 'content-type': 'application/json' });
    const dump = Object.fromEntries(book.sheets.map(s => [s.name, s.data]));
    return res.end(JSON.stringify(dump, null, 2));
  }

  // Static files, with Vercel-style clean URLs (/admin → /admin/index.html).
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  else if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file)) return res.writeHead(404).end('Not found');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ΠΚΑ attendance dev server → http://localhost:${PORT}  (admin: /admin, password "${ADMIN_PASSWORD}")`);
});

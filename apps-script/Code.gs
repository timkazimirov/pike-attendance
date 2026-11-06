/**
 * ΠΚΑ Iota Pi — attendance backend.
 *
 * Lives inside the Google Sheet (Extensions → Apps Script) and is deployed as a
 * web app. The website at pike.timkazimirov.com sends it JSON POSTs.
 * Setup steps are in README.md.
 */

const QR_STEP_SEC = 15;          // the projected QR code changes this often
const QR_GRACE_STEPS = 4;        // a scanned code stays valid for about a minute
const TICKET_TTL_SEC = 15 * 60;  // time allowed to type your name after scanning

const EVENTS = 'Events';
const ATTENDANCE = 'Attendance';
const ROSTER = 'Roster';

const EVENT_COLS = ['ID', 'Event', 'Date', 'Open', 'Created', 'Secret'];
const ATT_COLS = ['Timestamp', 'Event', 'Name', 'Method', 'Event ID', 'Device', 'Check-in ID'];
const ROSTER_COLS = ['Name'];

class UserError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'error';
  }
}

const ROUTES = {
  // public
  open: openCheckin_,
  checkin: checkin_,
  // officers
  login: admin_(() => ({})),
  events: admin_(listEvents_),
  create: admin_(createEvent_),
  event: admin_(eventDetail_),
  setOpen: admin_(setOpen_),
  add: admin_(addManual_),
  remove: admin_(removeAttendee_),
  deleteEvent: admin_(deleteEvent_),
};

// ---------- HTTP ----------

function doGet() {
  return json_({ ok: true, service: 'pike-attendance' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request.', code: 'bad' });
  }
  const route = ROUTES[req.action];
  if (!route) return json_({ ok: false, error: 'Unknown action.', code: 'bad' });
  try {
    return json_(Object.assign({ ok: true }, route(req)));
  } catch (err) {
    if (err instanceof UserError) return json_({ ok: false, error: err.message, code: err.code });
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'Something went wrong. Try again.', code: 'server' });
  }
}

// ---------- Check-in (public) ----------

/** Phone scanned the projected QR: verify the rotating code, hand back a ticket. */
function openCheckin_(req) {
  const ev = requireOpenEvent_(req.e);
  const step = Math.floor(nowSec_() / QR_STEP_SEC);
  const t = String(req.t || '').toLowerCase();
  let valid = false;
  for (let s = step - QR_GRACE_STEPS; s <= step + 2 && !valid; s++) valid = t === qrToken_(ev, s);
  if (!valid) throw new UserError('The code on screen changes every few seconds. Scan it again.', 'expired');

  const issued = nowSec_();
  return {
    event: publicEvent_(ev),
    ticket: issued + '.' + sign_(ev, 'ticket:' + issued),
    ticketExpires: (issued + TICKET_TTL_SEC) * 1000,
    roster: readRoster_(),
  };
}

function checkin_(req) {
  const name = cleanName_(req.name);
  const device = String(req.device || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
  return withLock_(() => {
    const ev = requireOpenEvent_(req.e);
    if (!ticketValid_(ev, req.ticket)) {
      throw new UserError('Your check-in timed out. Scan the QR code again.', 'expired');
    }
    const list = readAttendance_(ev.id);
    const key = nameKey_(name);
    const existing = list.find(a => nameKey_(a.name) === key);
    if (existing) return { event: publicEvent_(ev), name: existing.name, time: existing.time, already: true };

    const other = device && list.find(a => a.device === device);
    if (other) {
      throw new UserError('This phone already checked in ' + other.name + '. Everyone checks in on their own phone.', 'device');
    }
    const rec = appendAttendance_(ev, name, 'QR', device);
    return { event: publicEvent_(ev), name: rec.name, time: rec.time, already: false };
  });
}

// ---------- Admin ----------

function admin_(fn) {
  return req => {
    const pw = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
    if (!pw) {
      throw new UserError('No admin password yet. In the Google Sheet use the ΠΚΑ Attendance menu → Set admin password.', 'setup');
    }
    if (String(req.pw || '') !== pw) throw new UserError('Wrong password.', 'auth');
    return fn(req);
  };
}

function listEvents_() {
  const counts = {};
  readAttendance_().forEach(a => { counts[a.eventId] = (counts[a.eventId] || 0) + 1; });
  const events = readEvents_()
    .sort((a, b) => b.date.localeCompare(a.date) || b.row - a.row)
    .map(ev => Object.assign(publicEvent_(ev), { open: ev.open, count: counts[ev.id] || 0 }));
  return { events, sheetUrl: book_().getUrl() };
}

function createEvent_(req) {
  const name = safeText_(req.name, 80) || 'Chapter Meeting';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.date) ? req.date : Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
  return withLock_(() => {
    const taken = new Set(readEvents_().map(ev => ev.id));
    let id;
    do id = randomId_(6); while (taken.has(id));
    const secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    sheet_(EVENTS).appendRow([id, name, date, true, new Date(), secret]);
    return { event: { id, name, date, open: true } };
  });
}

function eventDetail_(req) {
  const ev = requireEvent_(req.id);
  const attendees = readAttendance_(ev.id).map(a => ({ id: a.id, name: a.name, time: a.time, method: a.method }));
  return {
    event: Object.assign(publicEvent_(ev), { open: ev.open, secret: ev.secret }),
    attendees,
    serverTime: Date.now(),
    qrStep: QR_STEP_SEC,
  };
}

function setOpen_(req) {
  const ev = requireEvent_(req.id);
  sheet_(EVENTS).getRange(ev.row, 4).setValue(!!req.open);
  return { open: !!req.open };
}

function addManual_(req) {
  const name = cleanName_(req.name);
  return withLock_(() => {
    const ev = requireEvent_(req.id);
    const key = nameKey_(name);
    if (readAttendance_(ev.id).some(a => nameKey_(a.name) === key)) {
      throw new UserError(name + ' is already checked in.', 'duplicate');
    }
    return { attendee: appendAttendance_(ev, name, 'Manual', '') };
  });
}

function removeAttendee_(req) {
  return withLock_(() => {
    const a = readAttendance_().find(x => x.id === String(req.checkinId || ''));
    if (a) sheet_(ATTENDANCE).deleteRow(a.row);
    return {};
  });
}

function deleteEvent_(req) {
  return withLock_(() => {
    const ev = requireEvent_(req.id);
    const sh = sheet_(ATTENDANCE);
    const n = sh.getLastRow() - 1;
    if (n > 0) {
      const rows = sh.getRange(2, 1, n, ATT_COLS.length).getValues();
      const keep = rows.filter(r => String(r[4]) !== ev.id);
      if (keep.length < rows.length) {
        sh.getRange(2, 1, n, ATT_COLS.length).clearContent();
        if (keep.length) sh.getRange(2, 1, keep.length, ATT_COLS.length).setValues(keep);
      }
    }
    sheet_(EVENTS).deleteRow(ev.row);
    return {};
  });
}

// ---------- Sheet menu & setup ----------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ΠΚΑ Attendance')
    .addItem('Set admin password…', 'setAdminPassword')
    .addItem('Set up / repair tabs', 'setup')
    .addToUi();
}

function setAdminPassword() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(
    'Admin password',
    'Officers type this at pike.timkazimirov.com/admin. Use 8+ characters.',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const pw = res.getResponseText().trim();
  if (pw.length < 8) {
    ui.alert('Use at least 8 characters.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('ADMIN_PASSWORD', pw);
  setup();
  ui.alert('Password saved. Next: Deploy → New deployment → Web app (see README).');
}

function setup() {
  const book = book_();
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', book.getId());
  [EVENTS, ATTENDANCE, ROSTER].forEach(name => sheet_(name));

  if (!book.getSheetByName('Totals')) {
    book.insertSheet('Totals').getRange('A1').setFormula(
      '=IFERROR(QUERY(Attendance!C:C, "select C, count(C) where C is not null group by C ' +
      'order by count(C) desc label count(C) \'Events attended\'", 1), "No check-ins yet")'
    );
  }
  if (!book.getSheetByName('By Event')) {
    book.insertSheet('By Event').getRange('A1').setFormula(
      '=IFERROR(QUERY(Attendance!B:C, "select C, count(C) where C is not null group by C pivot B", 1), "No check-ins yet")'
    );
  }
  const blank = book.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && book.getSheets().length > 1) book.deleteSheet(blank);
}

// ---------- Data ----------

function book_() {
  return SpreadsheetApp.getActiveSpreadsheet() ||
    SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
}

function sheet_(name) {
  const book = book_();
  let sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    const cols = name === EVENTS ? EVENT_COLS : name === ATTENDANCE ? ATT_COLS : ROSTER_COLS;
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (name === EVENTS) sh.hideColumns(6);
  }
  return sh;
}

function readEvents_() {
  const sh = sheet_(EVENTS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, EVENT_COLS.length).getValues()
    .map((r, i) => ({
      row: i + 2,
      id: String(r[0]).trim(),
      name: String(r[1]),
      date: ymd_(r[2]),
      open: r[3] === true || String(r[3]).toUpperCase() === 'TRUE',
      secret: String(r[5]),
    }))
    .filter(ev => ev.id && ev.secret);
}

/** All check-ins, or just one event's when eventId is given. */
function readAttendance_(eventId) {
  const sh = sheet_(ATTENDANCE);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const out = [];
  sh.getRange(2, 1, n, ATT_COLS.length).getValues().forEach((r, i) => {
    const evId = String(r[4]);
    if (!r[2] || (eventId && evId !== eventId)) return;
    out.push({
      row: i + 2,
      eventId: evId,
      name: String(r[2]),
      method: String(r[3]),
      device: String(r[5]),
      id: String(r[6]),
      time: iso_(r[0]),
    });
  });
  return out;
}

function appendAttendance_(ev, name, method, device) {
  const at = new Date();
  const id = Utilities.getUuid().slice(0, 8);
  sheet_(ATTENDANCE).appendRow([at, ev.date + ' ' + ev.name, name, method, ev.id, device, id]);
  return { id, name, method, time: at.toISOString() };
}

function readRoster_() {
  const sh = book_().getSheetByName(ROSTER);
  if (!sh || sh.getLastRow() < 2) return [];
  const names = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
    .map(r => String(r[0]).trim())
    .filter(Boolean);
  return Array.from(new Set(names)).sort().slice(0, 1000);
}

function requireEvent_(id) {
  const ev = readEvents_().find(x => x.id === String(id || '').trim());
  if (!ev) throw new UserError('Event not found.', 'notfound');
  return ev;
}

function requireOpenEvent_(id) {
  const ev = readEvents_().find(x => x.id === String(id || '').trim());
  if (!ev) throw new UserError("This QR code isn't for an active event.", 'notfound');
  if (!ev.open) throw new UserError('Check-in for ' + ev.name + ' is closed.', 'closed');
  return ev;
}

function publicEvent_(ev) {
  return { id: ev.id, name: ev.name, date: ev.date };
}

// ---------- Codes ----------

/** HMAC of the event id + message with the event's secret. The admin page computes the same thing. */
function sign_(ev, msg) {
  return Utilities.computeHmacSha256Signature(ev.id + ':' + msg, ev.secret)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2))
    .join('')
    .slice(0, 20);
}

function qrToken_(ev, step) {
  return sign_(ev, 'qr:' + step).slice(0, 10);
}

function ticketValid_(ev, ticket) {
  const m = /^(\d+)\.([0-9a-f]{20})$/.exec(String(ticket || ''));
  if (!m) return false;
  const age = nowSec_() - Number(m[1]);
  return age >= -60 && age <= TICKET_TTL_SEC && sign_(ev, 'ticket:' + m[1]) === m[2];
}

// ---------- Helpers ----------

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new UserError('Lots of people checking in. Try again.', 'busy');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Trims, strips characters Sheets would treat as a formula, and caps length. */
function safeText_(raw, max) {
  return String(raw || '').replace(/\s+/g, ' ').trim().replace(/^[=+\-@]+/, '').trim().slice(0, max);
}

function cleanName_(raw) {
  let name = safeText_(raw, 60);
  if (name.length < 2) throw new UserError('Enter your full name.', 'name');
  // "jake smith" / "JAKE SMITH" / "Jake smith" → "Jake Smith"; leaves "McDonald" alone.
  if (name === name.toUpperCase()) name = name.toLowerCase();
  return name.split(' ')
    .map(w => (w === w.toLowerCase() ? w.replace(/(^|['-])(\S)/g, (m, p, c) => p + c.toUpperCase()) : w))
    .join(' ');
}

function nameKey_(name) {
  return String(name).toLowerCase().replace(/[\s.'-]/g, '');
}

function randomId_(len) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

let TZ_;
function tz_() {
  return TZ_ || (TZ_ = book_().getSpreadsheetTimeZone() || Session.getScriptTimeZone());
}

function ymd_(v) {
  return v instanceof Date ? Utilities.formatDate(v, tz_(), 'yyyy-MM-dd') : String(v).trim().slice(0, 10);
}

function iso_(v) {
  return v instanceof Date ? v.toISOString() : String(v);
}

function nowSec_() {
  return Math.floor(Date.now() / 1000);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

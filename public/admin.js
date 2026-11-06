// Officer panel: /admin  (#/ = events, #/event/<id> = one event)

(() => {
  const app = document.getElementById('app');
  const present = document.getElementById('present');
  const sheetLink = document.getElementById('sheet-link');
  const logoutBtn = document.getElementById('logout');
  const PW_KEY = 'pike:admin';
  const POLL_MS = 5000;

  let pw = store.get(PW_KEY) || '';
  let pollTimer = null;
  let current = null;     // { event, attendees, offset, step } for the open event page
  let presentTimer = null;
  let lastStep = null;
  let wakeLock = null;
  let view = 0;           // bumped on every navigation so stale requests/timers can tell

  setSheetLink(store.get('pike:sheet'));
  logoutBtn.addEventListener('click', logout);
  $('[data-close]', present).addEventListener('click', closePresent);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePresent(); });
  window.addEventListener('hashchange', route);
  route();

  function adminApi(action, data = {}, opts) {
    return api(action, { ...data, pw }, opts).catch(err => {
      if (err.code === 'auth') logout();
      throw err;
    });
  }

  function logout() {
    store.remove(PW_KEY);
    pw = '';
    route();
  }

  function route() {
    view++;
    clearInterval(pollTimer);
    closePresent();
    current = null;
    logoutBtn.hidden = !pw;
    if (!pw) return showLogin();
    const m = location.hash.match(/^#\/event\/([\w-]+)$/);
    return m ? showEvent(m[1]) : showDashboard();
  }

  // ---------- Login ----------

  function showLogin() {
    document.title = 'ΠΚΑ Attendance · Admin';
    mount(app, 'tpl-login');
    const form = $('#login-form', app);
    const input = $('#pw', app);
    const msg = $('[data-msg]', app);
    const button = $('button', form);
    input.focus();
    form.addEventListener('submit', async e => {
      e.preventDefault();
      button.disabled = true;
      msg.textContent = '';
      try {
        await api('login', { pw: input.value }, { retries: 1 });
        pw = input.value;
        store.set(PW_KEY, pw);
        route();
      } catch (err) {
        msg.textContent = err.message;
        button.disabled = false;
        input.select();
      }
    });
  }

  // ---------- Events list ----------

  async function showDashboard() {
    document.title = 'ΠΚΑ Attendance · Admin';
    mount(app, 'tpl-dashboard');
    const form = $('#new-event', app);
    const msg = $('[data-msg]', app);
    const list = $('#events', app);
    $('#ev-date', app).value = todayYmd();

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const button = $('button', form);
      button.disabled = true;
      msg.textContent = '';
      try {
        const r = await adminApi('create', { name: $('#ev-name', app).value, date: $('#ev-date', app).value });
        location.hash = '#/event/' + r.event.id;
      } catch (err) {
        msg.textContent = err.message;
        button.disabled = false;
      }
    });

    try {
      const r = await adminApi('events', {}, { retries: 2 });
      setSheetLink(r.sheetUrl);
      list.replaceChildren(...(r.events.length
        ? r.events.map(eventRow)
        : [el('p', 'No events yet. Create one above.', 'muted')]));
    } catch (err) {
      list.replaceChildren(el('p', err.message, 'msg'));
    }
  }

  function eventRow(ev) {
    const row = el('a', null, 'event-row');
    row.href = '#/event/' + ev.id;
    const info = el('div');
    info.append(
      el('div', ev.name, 'title'),
      el('div', fmtDate(ev.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }), 'sub'),
    );
    const pill = el('span');
    setStatus(pill, ev.open);
    const count = el('div', ev.count, 'count');
    count.append(el('small', 'checked in'));
    row.append(info, pill, count);
    return row;
  }

  // ---------- One event ----------

  async function showEvent(id) {
    const myView = view;
    mount(app, 'tpl-event');
    const q = sel => $(sel, app);
    const msg = q('[data-msg]');
    const addForm = q('[data-add]');
    const addInput = q('#add-name');

    q('[data-present]').addEventListener('click', openPresent);
    q('[data-csv]').addEventListener('click', downloadCsv);

    q('[data-toggle]').addEventListener('click', async e => {
      const button = e.currentTarget;
      button.disabled = true;
      msg.textContent = '';
      try {
        await adminApi('setOpen', { id, open: !current.event.open });
        await load();
      } catch (err) {
        msg.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    });

    addForm.addEventListener('submit', async e => {
      e.preventDefault();
      const name = addInput.value.trim();
      if (!name) return;
      const button = $('button', addForm);
      button.disabled = true;
      msg.textContent = '';
      try {
        await adminApi('add', { id, name });
        addInput.value = '';
        await load();
      } catch (err) {
        msg.textContent = err.message;
      } finally {
        button.disabled = false;
        addInput.focus();
      }
    });

    q('[data-delete]').addEventListener('click', async () => {
      if (!current) return;
      const n = current.attendees.length;
      if (!confirm(`Delete "${current.event.name}" and its ${n} check-in${n === 1 ? '' : 's'}? This can't be undone.`)) return;
      try {
        await adminApi('deleteEvent', { id });
        location.hash = '#/';
      } catch (err) {
        msg.textContent = err.message;
      }
    });

    await load();
    if (myView === view) pollTimer = setInterval(load, POLL_MS);

    async function load() {
      try {
        const r = await adminApi('event', { id }, { retries: 1 });
        if (myView !== view) return;
        // Keep the first clock offset so the QR doesn't flicker between steps on every poll.
        const offset = current && current.event.id === id ? current.offset : r.serverTime - Date.now();
        current = { event: r.event, attendees: r.attendees, offset, step: r.qrStep };
        paint();
        if (msg.dataset.poll) msg.textContent = msg.dataset.poll = '';
      } catch (err) {
        if (myView !== view) return;
        if (!current) q('[data-name]').textContent = err.message;
        else msg.textContent = msg.dataset.poll = err.message;
      }
    }

    function paint() {
      const { event: ev, attendees } = current;
      document.title = `${ev.name} · ΠΚΑ Attendance`;
      q('[data-date]').textContent = fmtDate(ev.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      q('[data-name]').textContent = ev.name;
      setStatus(q('[data-status]'), ev.open);
      q('[data-toggle]').textContent = ev.open ? 'Close check-in' : 'Reopen check-in';
      q('[data-toggle]').disabled = false;
      q('[data-present]').disabled = false;
      q('[data-count]').textContent = attendees.length;
      q('[data-empty]').hidden = attendees.length > 0;
      q('[data-list]').replaceChildren(...attendees.map((a, i) => attendeeRow(a, i + 1)).reverse());
      paintPresent();
    }

    function attendeeRow(a, n) {
      const li = el('li');
      const who = el('span', a.name, 'who');
      if (a.method === 'Manual') who.append(el('span', 'manual', 'tag'));
      const time = el('time', fmtTime(a.time));
      time.dateTime = a.time;
      const x = el('button', '×', 'x');
      x.type = 'button';
      x.title = 'Remove ' + a.name;
      x.setAttribute('aria-label', 'Remove ' + a.name);
      x.addEventListener('click', async () => {
        if (!confirm(`Remove ${a.name} from this event?`)) return;
        x.disabled = true;
        try {
          await adminApi('remove', { checkinId: a.id });
          await load();
        } catch (err) {
          msg.textContent = err.message;
          x.disabled = false;
        }
      });
      li.append(el('span', n, 'n'), who, time, x);
      return li;
    }
  }

  function downloadCsv() {
    if (!current) return;
    const { event: ev, attendees } = current;
    const rows = [
      ['Name', 'Checked in', 'Method', 'Event', 'Date'],
      ...attendees.map(a => [a.name, new Date(a.time).toLocaleString(), a.method, ev.name, ev.date]),
    ];
    const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
    const link = el('a');
    link.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `pike-${ev.date}-${slug(ev.name)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // ---------- Projector mode ----------

  function openPresent() {
    if (!current) return;
    present.hidden = false;
    document.body.classList.add('presenting');
    document.documentElement.requestFullscreen?.().catch(() => {});
    navigator.wakeLock?.request('screen').then(l => { wakeLock = l; }).catch(() => {});
    lastStep = null;
    paintPresent();
    tick();
    presentTimer = setInterval(tick, 200);
  }

  function closePresent() {
    if (present.hidden) return;
    present.hidden = true;
    document.body.classList.remove('presenting');
    clearInterval(presentTimer);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }

  /** Redraw the QR whenever the 15-second step changes; animate the countdown bar. */
  async function tick() {
    if (!current) return;
    const ev = current.event;
    const stepMs = current.step * 1000;
    const now = Date.now() + current.offset;
    const step = Math.floor(now / stepMs);
    $('.qr-timer span', present).style.transform = `scaleX(${1 - (now % stepMs) / stepMs})`;
    if (step === lastStep) return;
    lastStep = step;
    const token = (await hmacHex(ev.secret, `${ev.id}:qr:${step}`)).slice(0, 10);
    if (step === lastStep) drawQr(`${location.origin}/?e=${ev.id}&t=${token}`);
  }

  function paintPresent() {
    if (present.hidden || !current) return;
    const { event: ev, attendees } = current;
    $('[data-p-event]', present).textContent = ev.name;
    $('[data-p-date]', present).textContent = fmtDate(ev.date);
    $('[data-p-count]', present).textContent = attendees.length;
    $('[data-p-closed]', present).hidden = ev.open;
    $('[data-p-cta]', present).hidden = !ev.open;
    const recent = attendees.slice(-5).reverse();
    const list = $('[data-p-recent]', present);
    const key = recent.map(a => a.id).join();
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      list.replaceChildren(...recent.map(a => el('li', a.name)));
    }
  }

  function drawQr(text) {
    const closed = $('[data-p-closed]', present);
    if (typeof qrcode !== 'function') {
      closed.textContent = "QR library didn't load. Check the internet connection.";
      closed.hidden = false;
      return;
    }
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    }
    const svg = document.getElementById('qr');
    svg.setAttribute('viewBox', `-3 -3 ${n + 6} ${n + 6}`);
    svg.firstElementChild.setAttribute('d', d);
    present.dataset.url = text;
  }

  // Same HMAC the Apps Script backend computes in sign_().
  async function hmacHex(key, msg) {
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
    return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
  }

  // ---------- Small helpers ----------

  function setSheetLink(url) {
    if (!url) return;
    store.set('pike:sheet', url);
    sheetLink.href = url;
    sheetLink.hidden = false;
  }

  function setStatus(pill, open) {
    pill.className = 'pill' + (open ? ' open' : '');
    pill.textContent = open ? 'Open' : 'Closed';
    pill.hidden = false;
  }

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';
  }
})();

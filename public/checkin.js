// Check-in page: /?e=<event id>&t=<rotating code from the projected QR>

(() => {
  const view = document.getElementById('view');
  const params = new URLSearchParams(location.search);
  const eventId = (params.get('e') || '').trim();
  const token = (params.get('t') || '').trim();

  const ERROR_TITLES = {
    expired: 'QR code expired',
    closed: 'Check-in is closed',
    notfound: "That code didn't work",
    device: 'Already used on this phone',
    network: "Can't connect",
    config: 'Not set up yet',
  };

  start();

  async function start() {
    if (!eventId) return mount(view, 'tpl-idle');

    const done = store.get('pike:done:' + eventId);
    if (done) return showDone(done, true);

    if (!token) {
      // Reloaded after scanning: reuse the ticket from this tab if it's still good.
      const saved = store.get('pike:ticket:' + eventId, 'session');
      if (saved && saved.expires > Date.now() + 15000) return showForm(saved);
      return mount(view, 'tpl-idle');
    }

    mount(view, 'tpl-loading');
    try {
      const r = await api('open', { e: eventId, t: token }, { retries: 3 });
      const session = { event: r.event, ticket: r.ticket, expires: r.ticketExpires, roster: r.roster || [] };
      store.set('pike:ticket:' + eventId, session, 'session');
      // Drop the one-time code from the address bar so it can't be copied around.
      history.replaceState(null, '', location.pathname + '?e=' + encodeURIComponent(eventId));
      showForm(session);
    } catch (err) {
      showError(err);
    }
  }

  function showForm(session) {
    mount(view, 'tpl-form');
    $('[data-event]', view).textContent = session.event.name;
    $('[data-date]', view).textContent = fmtDate(session.event.date);

    const form = $('form', view);
    const input = $('#name', view);
    const button = $('button', form);
    const msg = $('[data-msg]', view);

    input.value = store.get('pike:name') || '';
    if (session.roster.length) {
      const list = $('#roster', view);
      session.roster.forEach(n => list.append(new Option(n)));
      input.setAttribute('list', 'roster');
    }
    if (!input.value) input.focus();

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (name.split(' ').length < 2) {
        msg.textContent = 'Enter your first and last name.';
        input.focus();
        return;
      }
      button.disabled = true;
      button.textContent = 'Checking in…';
      msg.textContent = '';
      try {
        const r = await api('checkin', { e: eventId, ticket: session.ticket, name, device: deviceId() }, { retries: 3 });
        const done = { name: r.name, time: r.time, already: r.already, event: r.event };
        store.set('pike:name', r.name);
        store.set('pike:done:' + eventId, done);
        store.remove('pike:ticket:' + eventId, 'session');
        showDone(done, false);
      } catch (err) {
        if (['expired', 'closed', 'notfound', 'device'].includes(err.code)) return showError(err);
        msg.textContent = err.message;
        button.disabled = false;
        button.textContent = 'Attend';
      }
    });
  }

  function showDone(d, returning) {
    mount(view, 'tpl-done');
    const first = d.name.split(' ')[0];
    $('[data-title]', view).textContent = d.already || returning ? "You're checked in" : `You're in, ${first}!`;
    $('[data-name]', view).textContent = d.name;
    $('[data-event]', view).textContent = `${d.event.name} · ${fmtDate(d.event.date, { month: 'short', day: 'numeric' })}`;
    $('[data-time]', view).textContent = (d.already ? 'Already checked in at ' : 'Checked in at ') + fmtTime(d.time);
  }

  function showError(err) {
    mount(view, 'tpl-error');
    $('[data-title]', view).textContent = ERROR_TITLES[err.code] || 'Something went wrong';
    $('[data-msg]', view).textContent = err.message;
    const retry = $('[data-retry]', view);
    retry.hidden = err.code !== 'network';
    retry.onclick = () => location.reload();
  }

  function deviceId() {
    let id = store.get('pike:device');
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
      store.set('pike:device', id);
    }
    return id;
  }
})();

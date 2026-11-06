// Shared helpers for the check-in page and the admin panel.

const CONFIG = window.PIKE_CONFIG || {};

const $ = (sel, root = document) => root.querySelector(sel);

/** localStorage / sessionStorage that never throws (private mode, blocked storage). */
const store = {
  area(kind) {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  },
  get(key, kind) {
    try {
      const v = this.area(kind).getItem(key);
      return v == null ? null : JSON.parse(v);
    } catch {
      return null;
    }
  },
  set(key, value, kind) {
    try { this.area(kind).setItem(key, JSON.stringify(value)); } catch {}
  },
  remove(key, kind) {
    try { this.area(kind).removeItem(key); } catch {}
  },
};

class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * POST {action, ...data} to the Apps Script backend. No custom headers, so the
 * browser sends a "simple" text/plain request and skips the CORS preflight.
 * Network failures and "busy" responses are retried `retries` times.
 */
async function api(action, data = {}, { retries = 0 } = {}) {
  if (!CONFIG.API_URL || CONFIG.API_URL.startsWith('PASTE')) {
    throw new ApiError("This site isn't connected to the Google Sheet yet (set API_URL in config.js).", 'config');
  }
  const body = JSON.stringify({ action, ...data });
  for (let attempt = 0; ; attempt++) {
    const res = await once();
    if (res.ok) return res;
    if (!res.retry || attempt >= retries) throw new ApiError(res.error, res.code);
    await sleep(500 * 2 ** attempt + Math.random() * 700);
  }

  async function once() {
    try {
      const r = await fetch(CONFIG.API_URL, { method: 'POST', body });
      const json = await r.json();
      return json.ok ? json : { ...json, retry: json.code === 'busy' || json.code === 'server' };
    } catch {
      return { ok: false, retry: true, code: 'network', error: "Couldn't reach the server. Check your connection and try again." };
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Replace a container's contents with a <template>'s contents. */
function mount(container, templateId) {
  container.replaceChildren(document.getElementById(templateId).content.cloneNode(true));
  return container;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDate(ymd, opts = { weekday: 'long', month: 'long', day: 'numeric' }) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!d) return String(ymd);
  return new Date(y, m - 1, d).toLocaleDateString([], opts);
}

function fmtTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

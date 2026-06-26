// molt · monolithic admin slab. Zero-dep vanilla JS. Polls the broker read/admin endpoints on a
// timer (~2s) and tails the live SSE event stream. Every panel is independently fault-isolated: if its
// endpoint 404s/500s/errors the panel shows "unavailable" rather than breaking the whole page (the
// backend admin modules may still be landing).

const $ = (id) => document.getElementById(id);

// Path prefix the dashboard is served under ('' locally, '/grid' behind the prod ALB). Derived from the
// <base> the broker injects (document.baseURI) — no inline script, so it's CSP-safe. `api()` prepends it
// to a leading-slash path; the resulting URL is relative to origin and resolves under both /dashboard/
// and /grid/dashboard/ (ALB-prefix safe).
const PREFIX = new URL(document.baseURI).pathname.replace(/\/dashboard\/?$/, '');
const api = (path) => PREFIX + path;

// Operator key (optional). Sent as `Authorization: Bearer <id.secret>` — the header name + scheme the
// broker's authOk() expects. Stored in this browser's localStorage only; never sent anywhere but the
// broker. Without it: control writes (POST /admin/config) get 401, danger knob values show '***', and
// the gated read-views (reputation, event stream) come back empty/redacted.
const opKey = () => (localStorage.getItem('molt_op_key') || '').trim();
const authHeaders = () => {
  const k = opKey();
  return k ? { authorization: 'Bearer ' + k } : {};
};

// Wire the operator-key field (moved out of an inline <script> for CSP). Pre-fill from storage, save on
// change, refresh immediately so pasting a key gives instant feedback, and re-open the SSE stream so the
// live log unlocks without a reload.
(function initKeyField() {
  const el = $('op-key');
  if (!el) return;
  el.value = opKey();
  el.addEventListener('change', () => {
    localStorage.setItem('molt_op_key', el.value.trim());
    refresh();
    openStream();
  });
})();

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function getJSON(path) {
  const res = await fetch(api(path), { headers: authHeaders() });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// Run a panel renderer in isolation: catch fetch/parse errors and paint "unavailable" instead of
// letting one missing endpoint break the whole refresh.
async function panel(elId, fn) {
  try {
    await fn();
  } catch (e) {
    const el = $(elId);
    if (el) el.innerHTML = `<div class="unavailable">unavailable — ${escapeHtml(e.message)}</div>`;
  }
}

function badge(status) {
  const s = String(status ?? '');
  return `<span class="badge b-${escapeHtml(s)}">${escapeHtml(s.replace(/_/g, ' '))}</span>`;
}

// ---- toast / inline status line for POST results ----------------------------
let toastTimer = null;
function toast(kind, msg) {
  const el = $('toast');
  if (!el) return;
  el.className = 'toast ' + kind;
  el.textContent = msg;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// ---- Summary (big glanceable numbers) ---------------------------------------
function fmt(n) {
  if (n == null) return '–';
  return typeof n === 'number' ? n.toLocaleString() : String(n);
}

async function renderSummary() {
  const s = await getJSON('/admin/summary'); // { workers, queueByCapability, fuel, readiness }
  const w = s.workers || {};
  const online = w.online ?? (Array.isArray(s.workers) ? s.workers.length : undefined);
  const idle = w.idle;
  const busy = w.busy;

  // Queue depth: sum queueByCapability, supporting both {cap:count} and [{capability,pending}] shapes.
  const qbc = s.queueByCapability;
  let queueDepth = 0;
  let starvedCaps = 0;
  const capList = normalizeQueue(qbc);
  for (const c of capList) {
    queueDepth += Number(c.pending) || 0;
    if (c.starved) starvedCaps += 1;
  }

  const fuel = s.fuel;
  const fuelBal = fuel && typeof fuel === 'object' ? (fuel.balance ?? fuel.available ?? fuel.total) : fuel;
  const rd = s.readiness || {};
  const rstate = rd.status || (rd.ready === false ? 'starved' : rd.ready === true ? 'ready' : '–');

  const cards = [
    { n: fmt(online), l: 'workers online', sub: idle != null ? `${fmt(idle)} idle · ${fmt(busy)} busy` : '', cls: online ? 'good' : '' },
    { n: fmt(queueDepth), l: 'queue depth', sub: capList.length ? `${capList.length} capabilities` : '', cls: queueDepth ? 'accent' : '' },
    { n: fmt(starvedCaps), l: 'starved caps', sub: 'no online worker', cls: starvedCaps ? 'bad' : 'good' },
    { n: fmt(fuelBal), l: 'fuel balance', sub: fuel && fuel.account ? escapeHtml(fuel.account) : '', cls: 'accent' },
    { n: escapeHtml(rstate), l: 'readiness', sub: '', cls: rstate === 'starved' ? 'bad' : rstate === 'idle' ? '' : 'good' },
  ];
  $('summary').innerHTML = cards
    .map((c) => `<div class="bignum ${c.cls}"><div class="n">${c.n}</div><div class="l">${c.l}</div>${c.sub ? `<div class="sub">${c.sub}</div>` : ''}</div>`)
    .join('');

  // Readiness panel (fed off the same summary payload).
  renderReadiness(rd);
}

function renderReadiness(rd) {
  const el = $('readiness');
  if (!el) return;
  if (!rd || Object.keys(rd).length === 0) { el.innerHTML = `<div class="empty">no readiness data</div>`; return; }
  const st = rd.status || (rd.ready ? 'ready' : 'not ready');
  const jobs = rd.jobs || {};
  const wk = rd.workers || {};
  el.innerHTML = `
    <div class="ready-state ready-${escapeHtml(st)}">${escapeHtml(st)}</div>
    <div class="ready-meta">
      ${jobs.pending_total != null ? `<span>pending ${fmt(jobs.pending_total)} · claimable ${fmt(jobs.claimable_now)} · starved ${fmt(jobs.starved)} · blocked ${fmt(jobs.blocked)}</span>` : ''}
      ${wk.online != null ? `<span>workers ${fmt(wk.online)} (${fmt(wk.idle)} idle / ${fmt(wk.busy)} busy)</span>` : ''}
    </div>`;
}

// Normalize queueByCapability into [{capability, pending, starved}]. Accepts:
//   { "cap": 3, ... }                          (object map)
//   [ { capability, pending, starved? }, ... ] (array)
function normalizeQueue(qbc) {
  if (!qbc) return [];
  if (Array.isArray(qbc)) {
    return qbc.map((c) => ({
      capability: c.capability ?? c.cap ?? '(none)',
      pending: c.pending ?? c.count ?? c.depth ?? 0,
      starved: c.starved === true || c.online === 0 || c.workers === 0,
    }));
  }
  if (typeof qbc === 'object') {
    return Object.entries(qbc).map(([capability, v]) => {
      if (v != null && typeof v === 'object') {
        return { capability, pending: v.pending ?? v.count ?? 0, starved: v.starved === true || v.online === 0 };
      }
      return { capability, pending: Number(v) || 0, starved: false };
    });
  }
  return [];
}

// ---- Queue / demand by capability -------------------------------------------
// Combine the summary's queueByCapability with the capabilities that have NO online worker (from the
// worker roster) so starvation is highlighted even if the summary doesn't flag it.
async function renderQueue() {
  let caps = [];
  let onlineCaps = new Set();
  // worker roster (best-effort) to compute which capabilities have a live worker
  try {
    const workers = await getJSON('/workers');
    for (const w of workers) {
      if (w.online || w.status === 'online') {
        const wc = (w.capabilities || (w.manifest && w.manifest.capabilities) || []);
        for (const c of wc) onlineCaps.add(c);
      }
    }
  } catch { /* roster optional */ }

  try {
    const s = await getJSON('/admin/summary');
    caps = normalizeQueue(s.queueByCapability);
  } catch {
    // fall back to /jobs aggregation if summary is unavailable
    const jobs = await getJSON('/jobs');
    const m = new Map();
    for (const j of jobs) {
      if (j.status !== 'pending') continue;
      const k = j.capability_required || '(none)';
      m.set(k, (m.get(k) || 0) + 1);
    }
    caps = [...m.entries()].map(([capability, pending]) => ({ capability, pending, starved: false }));
  }

  const el = $('queue');
  if (!caps.length) { el.innerHTML = `<div class="empty">queue empty</div>`; return; }
  caps.sort((a, b) => (b.pending || 0) - (a.pending || 0));
  el.innerHTML = caps
    .map((c) => {
      const starved = c.starved || (c.capability !== '(none)' && !onlineCaps.has(c.capability) && (c.pending || 0) > 0);
      return `<div class="cap-row ${starved ? 'starve' : ''}">
        <span class="cap">${escapeHtml(c.capability)}</span>
        ${starved ? `<span class="tag">starved</span>` : ''}
        <span class="count">${fmt(c.pending)}</span>
      </div>`;
    })
    .join('');
}

// ---- Workers ----------------------------------------------------------------
async function renderWorkers() {
  const workers = await getJSON('/workers');
  const el = $('workers');
  if (!workers.length) { el.innerHTML = `<div class="empty">no workers online — molt worker start</div>`; return; }
  el.innerHTML = workers
    .map((w) => {
      const caps = w.capabilities || (w.manifest && w.manifest.capabilities) || [];
      const owner = w.owner || w.owner_id;
      const slots = `${escapeHtml(w.active_slots)}/${escapeHtml(w.max_slots)}`;
      return `<div class="worker">
        <div class="wid">${escapeHtml(w.id)} ${badge(w.status || (w.online ? 'online' : 'offline'))}</div>
        <div class="meta">${owner ? `owner ${escapeHtml(owner)} · ` : ''}slots ${slots}${w.trust_tier ? ` · tier ${escapeHtml(w.trust_tier)}` : ''}</div>
        ${caps.length ? `<div class="caps">${caps.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('')}</div>` : ''}
      </div>`;
    })
    .join('');
}

// ---- Deliberations (quorum) -------------------------------------------------
async function renderDeliberations() {
  const data = await getJSON('/deliberations');
  const panels = Array.isArray(data) ? data : data.panels || data.deliberations || [];
  const el = $('deliberations');
  if (!panels.length) { el.innerHTML = `<div class="empty">no active deliberations</div>`; return; }
  el.innerHTML = panels
    .map((p) => {
      const pid = p.panel_id || p.id;
      const seats = p.seats || p.rows || [];
      const seatHtml = seats
        .map((s) => {
          const role = s.seat_role || s.role || '?';
          const status = s.status || 'pending';
          const worker = s.worker || s.worker_id || s.assigned_worker_id;
          const isJudge = /judge/i.test(role);
          return `<span class="seat s-${escapeHtml(status)} ${isJudge ? 'judge' : ''}">
            <span class="dot2"></span>
            <span class="role">${escapeHtml(role)}</span>
            ${worker ? `<span class="sw">${escapeHtml(worker)}</span>` : ''}
          </span>`;
        })
        .join('');
      const hasJudge = seats.some((s) => /judge/i.test(s.seat_role || s.role || ''));
      return `<div class="delib">
        <div class="phead"><span class="pid">${escapeHtml(pid)}</span>${p.status ? badge(p.status) : ''}</div>
        <div class="seats">${seatHtml || '<span class="empty">no seats</span>'}</div>
        ${hasJudge ? `<div class="house-note">⚖ judge seat is the house (premium judge)</div>` : ''}
      </div>`;
    })
    .join('');
}

// ---- Reputation -------------------------------------------------------------
async function renderReputation() {
  const data = await getJSON('/reputation'); // [] when unauthed
  const el = $('reputation');
  const rows = Array.isArray(data) ? data : data.reputation || [];
  if (!rows.length) {
    el.innerHTML = opKey()
      ? `<div class="empty">no reputation recorded yet</div>`
      : `<div class="empty">operator key required for reputation detail</div>`;
    return;
  }
  // Flatten to per-worker per-capability bars. Accept either flat rows {worker,capability,trust_score}
  // or grouped {worker, reputation:[{capability,trust_score}]}.
  const flat = [];
  // Escape who/capability at read time (broker is trusted, but reputation rows echo worker-supplied
  // capability strings) so the render below interpolates already-safe values.
  for (const r of rows) {
    if (Array.isArray(r.reputation)) {
      for (const c of r.reputation) flat.push({ who: escapeHtml(r.worker || r.worker_id || r.id), capability: escapeHtml(c.capability), score: Number(c.trust_score) });
    } else {
      flat.push({ who: escapeHtml(r.worker || r.worker_id || r.id), capability: escapeHtml(r.capability), score: Number(r.trust_score ?? r.score) });
    }
  }
  el.innerHTML = flat
    .map((f) => {
      const pct = Math.max(0, Math.min(100, Math.round((f.score || 0) * 100)));
      const cls = pct < 40 ? 'low' : pct < 70 ? 'mid' : '';
      return `<div class="rep-row">
        <span class="who">${f.who}</span>
        <span class="cap">${f.capability}</span>
        <span class="bar ${cls}"><span style="width:${pct}%"></span></span>
        <span class="score">${isNaN(f.score) ? '–' : f.score.toFixed(2)}</span>
      </div>`;
    })
    .join('');
}

// ---- Control: runtime config knobs ------------------------------------------
// mutability tiers render differently:
//   live    🟢 -> input + Apply (POST /admin/config), source badge
//   restart 🟡 -> input + Apply + "restart to apply" badge, pendingOverride shown
//   deploy  ⚪ -> read-only value + envVar name (no input)
//   danger  🔴 -> read-only, red badge, NO control; value may be '***' when unauthed
async function renderConfig() {
  const data = await getJSON('/admin/config'); // { knobs: [...] }
  const knobs = data.knobs || [];
  const el = $('config');
  if (!knobs.length) { el.innerHTML = `<div class="empty">no config knobs</div>`; return; }

  // group by `group`
  const groups = new Map();
  for (const k of knobs) {
    const g = k.group || 'general';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(k);
  }

  const parts = [];
  for (const [gname, items] of groups) {
    const rows = items.map((k) => knobRow(k)).join('');
    parts.push(`<div class="cfg-group"><div class="gname">${escapeHtml(gname)}</div>${rows}</div>`);
  }
  el.innerHTML = parts.join('');

  // wire live/restart Apply buttons (non-bool knobs read their value from the text input)
  el.querySelectorAll('[data-apply]').forEach((btn) => {
    const input = $('k-' + btn.dataset.apply);
    btn.addEventListener('click', () => applyKnob(btn.dataset.apply, input ? input.value : ''));
  });

  // wire live/restart bool toggles (deploy/danger switches are locked + have no checkbox to bind)
  el.querySelectorAll('[data-toggle]').forEach((cb) => {
    cb.addEventListener('change', () => applyKnob(cb.dataset.toggle, cb.checked));
  });

  // Click-to-reveal for LOCKED rows. One delegated listener on the config container (re-bound each
  // render alongside the others above). A click anywhere on a `.has-howto` row — the locked switch, the
  // row body, or the "set via env ▸" hint — toggles its inline howto panel. Live/restart toggles are
  // unaffected: their checkbox lives in a non-`.has-howto` row, so this handler never sees them.
  el.addEventListener('click', onConfigClick);

  // Re-apply panels the operator had open before this re-render (poll rebuilds the DOM every 2s).
  markOpenHowtos(el);
}

function onConfigClick(e) {
  const row = e.target.closest('.has-howto[data-howto]');
  if (!row) return;
  const key = row.dataset.howto;
  if (!key) return;
  if (openHowtos.has(key)) openHowtos.delete(key);
  else openHowtos.add(key);
  applyHowtoState(row.closest('#config') || row.parentElement, key);
}

// Reflect openHowtos for one key (or, from markOpenHowtos, for all rows) onto the DOM: the row gets
// `.howto-open`, the panel gets `.open`, and the hint's caret/aria flips.
function applyHowtoState(scope, key) {
  if (!scope) return;
  const row = scope.querySelector(`.has-howto[data-howto="${cssEscape(key)}"]`);
  const panel = scope.querySelector(`.howto[data-howto-for="${cssEscape(key)}"]`);
  const open = openHowtos.has(key);
  if (row) {
    row.classList.toggle('howto-open', open);
    const hint = row.querySelector('.howto-hint');
    if (hint) hint.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (panel) panel.classList.toggle('open', open);
}

function markOpenHowtos(scope) {
  for (const key of openHowtos) applyHowtoState(scope, key);
}

function tierOf(k) {
  if (k.danger) return 'danger';
  return k.mutability || 'live';
}

function srcBadge(source) {
  if (!source) return '';
  return `<span class="src src-${escapeHtml(source)}">${escapeHtml(source)}</span>`;
}

// Interpret a bool knob's value. Returns 'on' | 'off' | 'unknown'. A redacted danger knob arrives as
// the string '***' (the operator key is missing), which we render as a neutral locked/unknown switch
// rather than guessing on/off. Everything else maps real booleans + the canonical env spellings.
function boolState(value) {
  if (value === '***') return 'unknown';
  if (value === true) return 'on';
  if (value === false) return 'off';
  const s = String(value ?? '').trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return 'on';
  return 'off';
}

function tierBadgeHtml(tier) {
  if (tier === 'restart') return `<span class="tier tier-restart">🟡 restart</span>`;
  if (tier === 'deploy') return `<span class="tier tier-deploy">⚪ deploy</span>`;
  if (tier === 'danger') return `<span class="tier tier-danger">🔴 danger</span>`;
  return `<span class="tier tier-live">🟢 live</span>`;
}

// Which locked rows currently have their "how to change this" panel revealed. Keyed by knob key so the
// open/closed state survives the 2s poll re-render (rows are rebuilt from scratch each refresh). Toggled
// by the delegated click handler in renderConfig; re-applied after each render by markOpenHowtos().
const openHowtos = new Set();

function hasHowto(k) {
  return Array.isArray(k.howto) && k.howto.length > 0;
}

// The clickable affordance shown on a locked row: a hint button that flips label when the panel is open.
// It's a <button> (keyboard-focusable) carrying data-howto=<key>; the delegated handler reads that. The
// whole row is also clickable, but the button makes the affordance obvious + accessible.
function howtoHint(k) {
  if (!hasHowto(k)) return '';
  return `<button type="button" class="howto-hint" data-howto="${escapeHtml(k.key)}" aria-expanded="false" title="how do I change this?">set via env <span class="caret">▸</span></button>`;
}

// The inline panel rendered directly under a locked row. Hidden until .open. Each server-supplied howto
// line is escaped and placed on its own monospace line so `export FOO=...` reads like a copyable snippet.
function howtoPanel(k) {
  if (!hasHowto(k)) return '';
  const lines = k.howto.map((ln) => `<div class="howto-line">${escapeHtml(String(ln))}</div>`).join('');
  return `<div class="howto" data-howto-for="${escapeHtml(k.key)}">${lines}</div>`;
}

function knobRow(k) {
  const tier = tierOf(k);
  const label = `<div class="klabel"><div class="kname">${escapeHtml(k.label || k.key)}</div>${k.envVar ? `<div class="kenv">${escapeHtml(k.envVar)}</div>` : ''}</div>`;
  const valStr = k.value === undefined || k.value === null ? '' : String(k.value);

  // ---- bool knobs render as toggle switches -----------------------------------
  if (k.type === 'bool') {
    const state = boolState(k.value);
    const checked = state === 'on';
    // live/restart bools are interactive (POST via toggle); deploy/danger bools are display-only —
    // setOverride rejects them server-side, so we lock the switch and never POST.
    const locked = tier === 'deploy' || tier === 'danger';
    const unknown = state === 'unknown';
    const swClasses = ['switch', checked ? 'on' : 'off', locked ? 'locked' : '', unknown ? 'unknown' : '']
      .filter(Boolean)
      .join(' ');
    const sw = locked
      ? `<span class="${swClasses}" role="img" aria-label="${unknown ? 'locked, value hidden' : checked ? 'on, locked' : 'off, locked'}"><span class="track"></span><span class="lock">🔒</span></span>`
      : `<label class="${swClasses}"><input type="checkbox" data-toggle="${escapeHtml(k.key)}"${checked ? ' checked' : ''} /><span class="track"></span></label>`;

    const danger = tier === 'danger';
    const restart = tier === 'restart';
    const pending = restart && k.pendingOverride != null && k.pendingOverride !== ''
      ? `<span class="pending-override">pending → ${escapeHtml(String(k.pendingOverride))}</span>`
      : '';
    // Locked bool rows (deploy/danger) become click-to-reveal; live/restart toggles stay flip-and-POST.
    if (locked && hasHowto(k)) {
      return `<div class="knob has-howto${danger ? ' danger' : ''}" data-key="${escapeHtml(k.key)}" data-howto="${escapeHtml(k.key)}">
        ${label}
        ${sw}
        ${tierBadgeHtml(tier)}
        ${srcBadge(k.source)}
        ${pending}
        ${howtoHint(k)}
      </div>${howtoPanel(k)}`;
    }
    return `<div class="knob${danger ? ' danger' : ''}" data-key="${escapeHtml(k.key)}">
      ${label}
      ${sw}
      ${tierBadgeHtml(tier)}
      ${srcBadge(k.source)}
      ${pending}
    </div>`;
  }

  if (tier === 'danger') {
    return `<div class="knob danger${hasHowto(k) ? ' has-howto' : ''}" data-key="${escapeHtml(k.key)}"${hasHowto(k) ? ` data-howto="${escapeHtml(k.key)}"` : ''}>
      ${label}
      <span class="kvalstatic">${escapeHtml(valStr)}</span>
      <span class="tier tier-danger">🔴 danger</span>
      ${howtoHint(k)}
    </div>${howtoPanel(k)}`;
  }
  if (tier === 'deploy') {
    return `<div class="knob${hasHowto(k) ? ' has-howto' : ''}" data-key="${escapeHtml(k.key)}"${hasHowto(k) ? ` data-howto="${escapeHtml(k.key)}"` : ''}>
      ${label}
      <span class="kvalstatic">${escapeHtml(valStr)}</span>
      <span class="tier tier-deploy">⚪ deploy</span>
      ${howtoHint(k)}
    </div>${howtoPanel(k)}`;
  }
  // live or restart non-bool -> input + Apply
  const restart = tier === 'restart';
  const pending = restart && k.pendingOverride != null && k.pendingOverride !== ''
    ? `<span class="pending-override">pending → ${escapeHtml(String(k.pendingOverride))}</span>`
    : '';
  return `<div class="knob" data-key="${escapeHtml(k.key)}">
    ${label}
    <input class="kval" id="k-${escapeHtml(k.key)}" value="${escapeHtml(valStr)}" autocomplete="off" spellcheck="false" />
    <button class="apply" data-apply="${escapeHtml(k.key)}">Apply</button>
    ${tierBadgeHtml(tier)}
    ${srcBadge(k.source)}
    ${pending}
  </div>`;
}

// applyKnob(key, value) — POST a single override. `value` is supplied explicitly by the caller: the
// text Apply button passes its input string; a bool toggle passes the checkbox boolean. Both share
// this one POST path so live/restart knobs of either shape go through the same broker contract.
async function applyKnob(key, value) {
  const btn = document.querySelector(`[data-apply="${cssEscape(key)}"]`);
  const toggle = document.querySelector(`[data-toggle="${cssEscape(key)}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  if (toggle) { toggle.disabled = true; }
  try {
    const res = await fetch(api('/admin/config'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ key, value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false || body.error) {
      const msg = body.error || `HTTP ${res.status}`;
      toast('err', `✗ ${key}: ${msg}${res.status === 401 ? ' (set operator key)' : ''}`);
    } else if (body.restartRequired || body.restart_required) {
      toast('warn', `⟳ ${key} set — restart to apply${body.pendingOverride != null ? ` (pending ${body.pendingOverride})` : ''}`);
    } else {
      const applied = body.value !== undefined ? body.value : value;
      toast('ok', `✓ ${key} = ${applied}${body.source ? ` (${body.source})` : ''}`);
    }
  } catch (e) {
    toast('err', `✗ ${key}: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Apply'; }
    if (toggle) { toggle.disabled = false; }
    renderConfigSafe(); // reflect the new state (re-renders the toggle from the server's truth)
  }
}

// CSS.escape fallback for the attribute selector (older engines / safety).
function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\\]]/g, '\\$&');
}

// ---- Live event stream (SSE) ------------------------------------------------
let es = null;
const MAX_EVENTS = 200;

function openStream() {
  if (es) { es.close(); es = null; }
  // EventSource can't set an Authorization header, so the broker gates the live data by the same
  // `authed` notion: an anonymous caller gets an open-but-empty stream. To get live events the key
  // must be passed — we forward it as a query param fallback in addition to the header path used by
  // polling. The broker reads Authorization for SSE; without header support we still connect (and
  // will show whatever the broker streams to anonymous callers). We append the key as ?key= so a
  // broker that accepts it there can authorize the stream.
  const k = opKey();
  const qs = k ? `?key=${encodeURIComponent(k)}` : '';
  try {
    es = new EventSource(api('/events/stream') + qs);
  } catch {
    return; // SSE unsupported — polling still drives the rest of the slab
  }
  const live = $('ev-live');
  es.addEventListener('hello', (e) => {
    let info = {};
    try { info = JSON.parse(e.data); } catch { /* ignore */ }
    if (live) {
      live.textContent = info.live ? '· live' : '· connected (anon)';
      live.className = info.live ? 'live' : 'dim';
    }
  });
  es.onmessage = (e) => {
    let evt = null;
    try { evt = JSON.parse(e.data); } catch { return; }
    appendEvent(evt);
  };
  es.onerror = () => {
    if (live) { live.textContent = '· reconnecting…'; live.className = 'dim'; }
  };
}

function appendEvent(e) {
  const el = $('events');
  if (!el) return;
  const t = e.created_at ? new Date(e.created_at).toLocaleTimeString() : new Date().toLocaleTimeString();
  const row = document.createElement('div');
  row.className = 'ev';
  // Escape every field at the interpolation site; broker events always carry event_type/entity_id.
  row.innerHTML = `<span class="et">${escapeHtml(t)}</span><span class="ee">${escapeHtml(e.event_type)}</span><span class="ed">${escapeHtml(e.entity_id)}</span>`;
  el.prepend(row);
  while (el.childElementCount > MAX_EVENTS) el.removeChild(el.lastChild);
}

// Seed the feed once from the buffered /events endpoint (the SSE stream only carries events from
// connect-time forward).
async function seedEvents() {
  try {
    const events = await getJSON('/events?limit=60');
    const el = $('events');
    el.innerHTML = '';
    for (const e of [...events].reverse()) appendEvent(e);
  } catch { /* gated/empty — the SSE stream will fill it */ }
}

// ---- Refresh loop -----------------------------------------------------------
const renderConfigSafe = () => panel('config', renderConfig);

async function refresh() {
  try {
    await getJSON('/health');
    $('broker-status').className = 'status ok';
    $('broker-status').innerHTML = '<span class="dot"></span> broker online';
  } catch {
    $('broker-status').className = 'status down';
    $('broker-status').innerHTML = '<span class="dot"></span> broker unreachable';
  }
  await Promise.all([
    panel('summary', renderSummary),
    panel('queue', renderQueue),
    panel('workers', renderWorkers),
    panel('deliberations', renderDeliberations),
    panel('reputation', renderReputation),
    renderConfigSafe(),
  ]);
}

refresh();
seedEvents();
openStream();
setInterval(refresh, 2000);

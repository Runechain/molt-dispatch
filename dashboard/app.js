// Zero-dep dashboard. Polls the broker read endpoints and re-renders.

const $ = (id) => document.getElementById(id);

// Path prefix the dashboard is served under ('' locally, '/grid' behind the prod ALB). Set by the
// inline bootstrap in index.html from location.pathname; every broker call is prefixed with it.
const PREFIX = String(window.MOLT_PREFIX || '').replace(/\/$/, '');
const api = (path) => PREFIX + path;

async function getJSON(path) {
  const res = await fetch(api(path));
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function badge(status) {
  const s = String(status ?? '');
  return `<span class="badge b-${escapeHtml(s)}">${escapeHtml(s.replace(/_/g, ' '))}</span>`;
}

function jobRow(j) {
  const dep = j.depends_on?.length
    ? `<span class="dep">⇠ ${escapeHtml(j.depends_on.join(', '))}</span>`
    : '';
  const adapter = j.adapter_hint ? `<span class="adapter">${escapeHtml(j.adapter_hint)}</span>` : '';
  return `<div class="job">
    <span class="jid">${escapeHtml(j.id)}</span>
    <span class="jkey">${escapeHtml(j.job_key || j.type)}</span>
    ${adapter}${dep}
    ${badge(j.status)}
  </div>`;
}

async function renderObjectives() {
  const objectives = await getJSON('/objectives');
  const el = $('objectives');
  if (!objectives.length) {
    el.innerHTML = `<div class="empty">No objectives yet. Create one with:  molt objective create -f examples/waitlist-objective.json</div>`;
    return;
  }
  const parts = [];
  for (const o of objectives) {
    const jobs = await getJSON(`/jobs?objective=${o.id}`);
    const approve =
      o.status === 'ready_for_approval'
        ? `<button class="approve-btn" data-approve="${o.id}">▸ approve &amp; merge</button>`
        : '';
    parts.push(`<div class="card">
      <div class="obj-head">
        <div><span class="obj-title">${escapeHtml(o.title)}</span> <span class="obj-id">${o.id}</span></div>
        ${badge(o.status)}
      </div>
      <div class="jobs">${jobs.map(jobRow).join('')}</div>
      ${approve}
    </div>`);
  }
  el.innerHTML = parts.join('');
  el.querySelectorAll('[data-approve]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'merging…';
      const r = await fetch(api(`/objectives/${btn.dataset.approve}/approve`), { method: 'POST' }).then((x) => x.json());
      if (r.error) {
        btn.textContent = '✗ ' + r.error;
      }
      refresh();
    })
  );
}

async function renderWorkers() {
  const workers = await getJSON('/workers');
  const el = $('workers');
  if (!workers.length) {
    el.innerHTML = `<div class="empty">No workers online. Start one:  molt worker start</div>`;
    return;
  }
  el.innerHTML = workers
    .map((w) => {
      const rep = (w.reputation || [])
        .map(
          (r) => `<div class="rep-row">
            <span class="cap">${escapeHtml(r.capability)}</span>
            <span class="bar"><span style="width:${Math.round(Number(r.trust_score) * 100)}%"></span></span>
            <span>${escapeHtml(r.trust_score)}</span>
          </div>`
        )
        .join('');
      return `<div class="card worker">
        <div class="wid">${escapeHtml(w.id)} ${badge(w.status)}</div>
        <div class="meta">slots ${escapeHtml(w.active_slots)}/${escapeHtml(w.max_slots)} · trust tier ${escapeHtml(w.trust_tier)}</div>
        ${rep ? `<div class="rep">${rep}</div>` : ''}
      </div>`;
    })
    .join('');
}

async function renderEvents() {
  const events = await getJSON('/events?limit=60');
  const el = $('events');
  el.innerHTML = events
    .map((e) => {
      const t = new Date(e.created_at).toLocaleTimeString();
      return `<div class="ev"><span class="et">${escapeHtml(t)}</span><span class="ee">${escapeHtml(e.event_type)}</span><span class="ed">${escapeHtml(e.entity_id)}</span></div>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function refresh() {
  try {
    await getJSON('/health');
    $('broker-status').className = 'status ok';
    $('broker-status').innerHTML = '<span class="dot"></span> broker online';
    await Promise.all([renderObjectives(), renderWorkers(), renderEvents()]);
  } catch {
    $('broker-status').className = 'status down';
    $('broker-status').innerHTML = '<span class="dot"></span> broker unreachable';
  }
}

refresh();
setInterval(refresh, 2000);

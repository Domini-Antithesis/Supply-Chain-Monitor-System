'use strict';

const CATEGORY_ORDER = ['Critical', 'High', 'Medium', 'Low'];
const CATEGORY_CLASS = {
  Critical: 'status-critical',
  High: 'status-high',
  Medium: 'status-medium',
  Low: 'status-low',
};

const $ = (id) => document.getElementById(id);
const statusClass = (category) => CATEGORY_CLASS[category] || 'status-unknown';

function text(el, value) {
  el.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function showError(message) {
  const el = $('error-notice');
  el.textContent = message;
  el.hidden = !message;
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

/* ---------- rendering ---------- */

function renderStats(stats) {
  text($('kpi-signals'), stats.totalSignals);
  text($('kpi-alerts'), stats.alertsSent);
  text($('kpi-score'), stats.averageScore);
  text($('kpi-suppliers'), stats.suppliersMonitored);

  const counts = stats.byCategory || {};
  const max = Math.max(1, ...CATEGORY_ORDER.map((c) => counts[c] || 0));
  const container = $('breakdown');
  container.innerHTML = '';

  for (const category of CATEGORY_ORDER) {
    const count = counts[category] || 0;
    const row = document.createElement('div');
    row.className = 'bar-row';

    const label = document.createElement('div');
    label.className = 'bar-label';
    const swatch = document.createElement('span');
    swatch.className = `swatch ${statusClass(category)}`;
    label.append(swatch, document.createTextNode(category));

    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = `bar-fill ${statusClass(category)}`;
    fill.style.width = `${(count / max) * 100}%`;
    track.appendChild(fill);

    const value = document.createElement('div');
    value.className = 'bar-value';
    value.textContent = String(count);

    row.append(label, track, value);
    container.appendChild(row);
  }
}

function emptyRow(tbody, colspan, message) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colspan;
  td.className = 'empty';
  td.textContent = message;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function renderAlerts(alerts) {
  const tbody = $('alerts-body');
  tbody.innerHTML = '';

  if (!alerts.length) {
    emptyRow(tbody, 6, 'No signals logged yet. The pipeline writes here after its first hourly run.');
    return;
  }

  for (const alert of alerts) {
    const tr = document.createElement('tr');

    const detected = document.createElement('td');
    detected.textContent = formatDate(alert.detectedAt);

    const supplier = document.createElement('td');
    const supplierName = document.createElement('div');
    supplierName.className = 'cell-strong';
    supplierName.textContent = alert.supplier || '—';
    const region = document.createElement('div');
    region.className = 'cell-sub';
    region.textContent = alert.region || '';
    supplier.append(supplierName, region);

    const article = document.createElement('td');
    article.className = 'article-cell';
    if (alert.url) {
      const link = document.createElement('a');
      link.href = alert.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = alert.title || alert.url;
      article.appendChild(link);
    } else {
      article.textContent = alert.title || '—';
    }
    if (alert.source) {
      const source = document.createElement('div');
      source.className = 'cell-sub';
      source.textContent = alert.source;
      article.appendChild(source);
    }

    const score = document.createElement('td');
    score.className = 'num';
    score.textContent = alert.riskScore === null ? '—' : String(alert.riskScore);

    const risk = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge';
    const dot = document.createElement('span');
    dot.className = `swatch ${statusClass(alert.riskCategory)}`;
    badge.append(dot, document.createTextNode(alert.riskCategory || 'Unknown'));
    risk.appendChild(badge);

    const alerted = document.createElement('td');
    if (alert.alertSent) {
      alerted.innerHTML = '<span class="tick">✓</span>';
      alerted.title = (alert.channels || []).join(', ');
    } else {
      alerted.innerHTML = '<span class="dash">—</span>';
    }

    tr.append(detected, supplier, article, score, risk, alerted);
    tbody.appendChild(tr);
  }
}

function renderWatchlist(entries) {
  const tbody = $('watchlist-body');
  tbody.innerHTML = '';

  if (!entries.length) {
    emptyRow(tbody, 6, 'No suppliers being monitored yet. Add one below.');
    return;
  }

  for (const entry of entries) {
    const tr = document.createElement('tr');

    const supplier = document.createElement('td');
    supplier.className = 'cell-strong';
    supplier.textContent = entry.supplier || '—';

    const region = document.createElement('td');
    region.textContent = entry.region || '—';

    const query = document.createElement('td');
    query.textContent = entry.query || '—';

    const threshold = document.createElement('td');
    threshold.className = 'num';
    const thresholdInput = document.createElement('input');
    thresholdInput.type = 'number';
    thresholdInput.min = '0';
    thresholdInput.max = '100';
    thresholdInput.value = String(entry.riskThreshold);
    thresholdInput.className = 'threshold-input';
    thresholdInput.addEventListener('change', async () => {
      try {
        await api(`/api/watchlist/${entry.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ riskThreshold: Number(thresholdInput.value) }),
        });
        showError('');
        refresh();
      } catch (err) {
        showError(err.message);
      }
    });
    threshold.appendChild(thresholdInput);

    const active = document.createElement('td');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = entry.active;
    toggle.addEventListener('change', async () => {
      try {
        await api(`/api/watchlist/${entry.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ active: toggle.checked }),
        });
        showError('');
        refresh();
      } catch (err) {
        showError(err.message);
      }
    });
    active.appendChild(toggle);

    const actions = document.createElement('td');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-link';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Stop monitoring ${entry.supplier}?`)) return;
      try {
        await api(`/api/watchlist/${entry.id}`, { method: 'DELETE' });
        showError('');
        refresh();
      } catch (err) {
        showError(err.message);
      }
    });
    actions.appendChild(remove);

    tr.append(supplier, region, query, threshold, active, actions);
    tbody.appendChild(tr);
  }
}

/* ---------- data loading ---------- */

async function refresh() {
  try {
    const health = await api('/api/health');
    $('setup-notice').hidden = health.airtableConfigured;
    if (!health.airtableConfigured) {
      renderStats({ byCategory: {} });
      renderAlerts([]);
      renderWatchlist([]);
      showError(''); // clear any error left over from before Airtable was configured
      return;
    }

    const [stats, alertsData, watchlistData] = await Promise.all([
      api('/api/stats'),
      api('/api/alerts?limit=50'),
      api('/api/watchlist'),
    ]);

    renderStats(stats);
    renderAlerts(alertsData.alerts);
    renderWatchlist(watchlistData.watchlist);
    showError('');
    $('last-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    showError(err.message);
  }
}

$('refresh').addEventListener('click', refresh);

$('watchlist-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const errorEl = $('form-error');
  errorEl.hidden = true;

  try {
    await api('/api/watchlist', {
      method: 'POST',
      body: JSON.stringify({
        supplier: data.get('supplier'),
        region: data.get('region'),
        query: data.get('query'),
        riskThreshold: Number(data.get('riskThreshold')),
        active: true,
      }),
    });
    form.reset();
    form.querySelector('[name="riskThreshold"]').value = '70';
    refresh();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

refresh();
setInterval(refresh, 60000);

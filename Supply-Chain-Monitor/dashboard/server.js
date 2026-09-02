#!/usr/bin/env node
/**
 * Dashboard backend for Supply Chain Monitor.
 *
 * Serves the static dashboard and proxies Airtable so that the Airtable token
 * stays server-side and never reaches the browser. Deliberately dependency-free
 * (Node's built-in http) so the stack needs no npm install and no build step.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.DASHBOARD_PORT || 8080);
const PROJECT_DIR = process.env.PROJECT_DIR || path.join(__dirname, '..');
const ENV_PATH = path.join(PROJECT_DIR, '.env');
const ENV_EXAMPLE_PATH = path.join(PROJECT_DIR, '.env.example');
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || '';
const ALERTS_TABLE = process.env.AIRTABLE_ALERTS_TABLE_NAME || 'Disruption Alerts';
const WATCHLIST_TABLE = process.env.AIRTABLE_WATCHLIST_TABLE_NAME || 'Watchlist';

const PUBLIC_DIR = path.join(__dirname, 'public');
const RECORD_ID = /^rec[A-Za-z0-9]{10,}$/;
const PLACEHOLDER = /^replace-with-/i;
const airtableConfigured = () =>
  Boolean(AIRTABLE_API_KEY) && !PLACEHOLDER.test(AIRTABLE_API_KEY) && Boolean(AIRTABLE_BASE_ID) && !PLACEHOLDER.test(AIRTABLE_BASE_ID);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function airtable(tableOrPath, { method = 'GET', query = {}, body } = {}) {
  if (!airtableConfigured()) {
    const err = new Error('Airtable is not configured. Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID in .env.');
    err.status = 503;
    throw err;
  }
  const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableOrPath}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.append(k, v);

  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {
    parsed = text;
  }
  if (!res.ok) {
    const err = new Error(
      `Airtable request failed (HTTP ${res.status}). ${parsed && parsed.error ? JSON.stringify(parsed.error) : ''}`
    );
    err.status = res.status === 404 ? 404 : 502;
    throw err;
  }
  return parsed;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error('Request body is not valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const alertFromRecord = (r) => ({
  id: r.id,
  detectedAt: r.fields['Detected At'] || null,
  supplier: r.fields.Supplier || '',
  region: r.fields.Region || '',
  title: r.fields['Article Title'] || '',
  url: r.fields['Article URL'] || '',
  source: r.fields.Source || '',
  publishedAt: r.fields['Published At'] || null,
  riskScore: typeof r.fields['Risk Score'] === 'number' ? r.fields['Risk Score'] : null,
  riskCategory: r.fields['Risk Category'] || 'Unknown',
  reasoning: r.fields['Risk Reasoning'] || '',
  thresholdUsed: typeof r.fields['Risk Threshold Used'] === 'number' ? r.fields['Risk Threshold Used'] : null,
  alertSent: Boolean(r.fields['Alert Sent']),
  channels: r.fields['Alert Channels'] || [],
});

const watchlistFromRecord = (r) => ({
  id: r.id,
  supplier: r.fields.Supplier || '',
  region: r.fields.Region || '',
  query: r.fields['Search Query'] || '',
  riskThreshold: typeof r.fields['Risk Threshold'] === 'number' ? r.fields['Risk Threshold'] : 70,
  active: Boolean(r.fields.Active),
});

function watchlistFields(payload) {
  const fields = {};
  if (typeof payload.supplier === 'string') fields.Supplier = payload.supplier.trim();
  if (typeof payload.region === 'string') fields.Region = payload.region.trim();
  if (typeof payload.query === 'string') fields['Search Query'] = payload.query.trim();
  if (payload.riskThreshold !== undefined) {
    const n = Number(payload.riskThreshold);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw Object.assign(new Error('riskThreshold must be a number between 0 and 100.'), { status: 400 });
    }
    fields['Risk Threshold'] = Math.round(n);
  }
  if (payload.active !== undefined) fields.Active = Boolean(payload.active);
  return fields;
}

/* ---------- first-run setup ---------- */

/** Reads .env into a plain object. Returns {} when it does not exist yet. */
function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const values = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) values[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
  return values;
}

// Setup counts as done only when the values that actually make the system work
// are present — not merely because a .env file exists. Someone who copies
// .env.example to .env and stops there would otherwise be locked out of the
// setup page by a file that configures nothing.
const REQUIRED_FOR_SETUP = ['N8N_OWNER_EMAIL', 'N8N_OWNER_PASSWORD', 'AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID'];

function setupComplete() {
  const values = readEnvFile();
  return REQUIRED_FOR_SETUP.every((key) => {
    const v = values[key];
    return Boolean(v) && !PLACEHOLDER.test(v);
  });
}

/**
 * Rewrites .env.example line by line, substituting submitted values while
 * keeping every explanatory comment intact — so the generated .env still reads
 * like the documented template rather than a bare key dump.
 */
function renderEnv(template, values) {
  const quoted = (v) => {
    const clean = String(v).replace(/[\r\n]/g, '').trim();
    return /[\s#"']/.test(clean) ? `"${clean.replace(/"/g, '\\"')}"` : clean;
  };
  const seen = new Set();
  const lines = template.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    if (!(key in values) || values[key] === undefined || values[key] === '') return line;
    seen.add(key);
    return `${key}=${quoted(values[key])}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key) && value !== undefined && value !== '') lines.push(`${key}=${quoted(value)}`);
  }
  return lines.join('\n');
}

const SETUP_FIELDS = {
  N8N_OWNER_EMAIL: { required: true, label: 'n8n login email' },
  N8N_OWNER_PASSWORD: { required: true, label: 'n8n login password' },
  NEWSAPI_KEY: { required: true, label: 'NewsAPI key' },
  GROQ_API_KEY: { required: true, label: 'Groq API key' },
  AIRTABLE_API_KEY: { required: true, label: 'Airtable token' },
  AIRTABLE_BASE_ID: { required: true, label: 'Airtable base ID' },
  SLACK_WEBHOOK_URL: { required: true, label: 'Slack webhook URL' },
  ALERT_EMAIL_TO: { required: true, label: 'Alert recipient email' },
  SMTP_HOST: { required: false, label: 'SMTP host' },
  SMTP_PORT: { required: false, label: 'SMTP port' },
  SMTP_USER: { required: false, label: 'SMTP username' },
  SMTP_PASSWORD: { required: false, label: 'SMTP password' },
};

async function testCredential(service, payload) {
  const timeout = AbortSignal.timeout(12000);
  try {
    if (service === 'newsapi') {
      const res = await fetch(`https://newsapi.org/v2/top-headlines?country=us&pageSize=1&apiKey=${encodeURIComponent(payload.NEWSAPI_KEY || '')}`, { signal: timeout });
      if (res.ok) return { ok: true, message: 'Key accepted by NewsAPI.' };
      if (res.status === 401) return { ok: false, message: 'NewsAPI rejected this key.' };
      if (res.status === 429) return { ok: false, message: 'Key is valid but the daily free-tier quota is exhausted.' };
      return { ok: false, message: `NewsAPI returned HTTP ${res.status}.` };
    }

    if (service === 'groq') {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${payload.GROQ_API_KEY || ''}` },
        signal: timeout,
      });
      if (res.ok) return { ok: true, message: 'Key accepted by Groq.' };
      if (res.status === 401) return { ok: false, message: 'Groq rejected this key.' };
      return { ok: false, message: `Groq returned HTTP ${res.status}.` };
    }

    if (service === 'airtable') {
      const baseId = String(payload.AIRTABLE_BASE_ID || '');
      if (!/^app[A-Za-z0-9]{10,}$/.test(baseId)) {
        return { ok: false, message: 'Base ID should look like appXXXXXXXXXXXXXX.' };
      }
      const res = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
        headers: { Authorization: `Bearer ${payload.AIRTABLE_API_KEY || ''}` },
        signal: timeout,
      });
      if (res.ok) return { ok: true, message: 'Token and base verified, including schema access.' };
      if (res.status === 401) return { ok: false, message: 'Airtable rejected this token.' };
      if (res.status === 403) {
        return { ok: false, message: 'Token lacks the schema.bases:read/write scopes on this base.' };
      }
      if (res.status === 404) return { ok: false, message: 'No base with that ID is visible to this token.' };
      return { ok: false, message: `Airtable returned HTTP ${res.status}.` };
    }

    if (service === 'slack') {
      const url = String(payload.SLACK_WEBHOOK_URL || '');
      if (!/^https:\/\/hooks\.slack\.com\//.test(url)) {
        return { ok: false, message: 'That does not look like a Slack incoming webhook URL.' };
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Supply Chain Monitor: setup test message. You can ignore this.' }),
        signal: timeout,
      });
      if (res.ok) return { ok: true, message: 'Test message posted to your Slack channel.' };
      return { ok: false, message: `Slack returned HTTP ${res.status}.` };
    }

    return { ok: false, message: `Unknown service "${service}".` };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { ok: false, message: 'The request timed out — check your internet connection.' };
    }
    return { ok: false, message: `Could not reach the service: ${err.message}` };
  }
}

async function fetchAlerts(limit = 100) {
  const data = await airtable(encodeURIComponent(ALERTS_TABLE), {
    query: {
      maxRecords: String(Math.min(Math.max(limit, 1), 100)),
      'sort[0][field]': 'Detected At',
      'sort[0][direction]': 'desc',
    },
  });
  return (data.records || []).map(alertFromRecord);
}

const routes = [
  {
    method: 'GET',
    match: (p) => p === '/api/health',
    handle: async () => ({
      status: 200,
      body: {
        ok: true,
        airtableConfigured: airtableConfigured(),
        setupComplete: setupComplete(),
        alertsTable: ALERTS_TABLE,
        watchlistTable: WATCHLIST_TABLE,
      },
    }),
  },
  {
    method: 'GET',
    match: (p) => p === '/api/setup/status',
    handle: async () => ({
      status: 200,
      body: {
        // Once .env exists the wizard is closed for good — first run only.
        setupComplete: setupComplete(),
        airtableLive: airtableConfigured(),
      },
    }),
  },
  {
    method: 'POST',
    match: (p) => p === '/api/setup/test',
    handle: async (req) => {
      const payload = await readBody(req);
      const result = await testCredential(String(payload.service || ''), payload);
      return { status: 200, body: result };
    },
  },
  {
    method: 'POST',
    match: (p) => p === '/api/setup',
    handle: async (req) => {
      if (setupComplete()) {
        throw Object.assign(
          new Error('Setup has already been completed. Edit .env directly to change configuration.'),
          { status: 409 }
        );
      }
      const payload = await readBody(req);

      const values = {};
      const missing = [];
      for (const [key, spec] of Object.entries(SETUP_FIELDS)) {
        const raw = payload[key];
        const value = typeof raw === 'string' ? raw.trim() : raw;
        if (!value) {
          if (spec.required) missing.push(spec.label);
          continue;
        }
        values[key] = value;
      }
      if (missing.length) {
        throw Object.assign(new Error(`Still missing: ${missing.join(', ')}.`), { status: 400 });
      }
      if (String(values.N8N_OWNER_PASSWORD).length < 8) {
        throw Object.assign(new Error('The n8n password must be at least 8 characters, with an uppercase letter and a number.'), { status: 400 });
      }

      // SMTP is optional, but only as a complete set — bootstrap requires all
      // three to create the credential, and a partial fill (e.g. username and
      // password typed in, but the host field left on its placeholder text)
      // silently produces a system where email looks configured but isn't.
      const smtpProvided = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'].filter((k) => values[k]);
      if (smtpProvided.length > 0 && smtpProvided.length < 3) {
        const smtpMissing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']
          .filter((k) => !values[k])
          .map((k) => SETUP_FIELDS[k].label);
        throw Object.assign(
          new Error(`Email is partially filled in. Either complete it or leave all of it blank for Slack-only. Still missing: ${smtpMissing.join(', ')}.`),
          { status: 400 }
        );
      }

      // Generated rather than asked for — it protects n8n's own credential
      // store and there is no reason a human should have to invent it.
      //
      // But never regenerate one that already exists: n8n seals its stored
      // credentials with this key, so replacing it on a stack that has already
      // run leaves n8n unable to decrypt them ("encryption key mismatch").
      const existingKey = readEnvFile().N8N_ENCRYPTION_KEY;
      values.N8N_ENCRYPTION_KEY =
        existingKey && !PLACEHOLDER.test(existingKey)
          ? existingKey
          : crypto.randomBytes(32).toString('hex');

      if (!fs.existsSync(ENV_EXAMPLE_PATH)) {
        throw Object.assign(new Error('.env.example is missing, so the .env file cannot be generated.'), { status: 500 });
      }
      const template = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
      fs.writeFileSync(ENV_PATH, renderEnv(template, values), { encoding: 'utf-8', mode: 0o600 });

      return {
        status: 201,
        body: {
          ok: true,
          written: '.env',
          next: 'docker compose up -d',
          message: 'Configuration saved. Apply it by running "docker compose up -d" in the Supply-Chain-Monitor folder.',
        },
      };
    },
  },
  {
    method: 'GET',
    match: (p) => p === '/api/alerts',
    handle: async (req, url) => {
      const limit = Number(url.searchParams.get('limit') || 50);
      const alerts = await fetchAlerts(limit);
      return { status: 200, body: { alerts } };
    },
  },
  {
    method: 'GET',
    match: (p) => p === '/api/stats',
    handle: async () => {
      const alerts = await fetchAlerts(100);
      const byCategory = { Low: 0, Medium: 0, High: 0, Critical: 0 };
      let scoreSum = 0;
      let scoreCount = 0;
      for (const a of alerts) {
        if (byCategory[a.riskCategory] === undefined) byCategory[a.riskCategory] = 0;
        byCategory[a.riskCategory] += 1;
        if (typeof a.riskScore === 'number') {
          scoreSum += a.riskScore;
          scoreCount += 1;
        }
      }
      let watchlistCount = null;
      try {
        const wl = await airtable(encodeURIComponent(WATCHLIST_TABLE), { query: { maxRecords: '100' } });
        watchlistCount = (wl.records || []).filter((r) => r.fields.Active).length;
      } catch (e) {
        watchlistCount = null;
      }
      return {
        status: 200,
        body: {
          totalSignals: alerts.length,
          alertsSent: alerts.filter((a) => a.alertSent).length,
          byCategory,
          averageScore: scoreCount ? Math.round(scoreSum / scoreCount) : null,
          suppliersMonitored: watchlistCount,
          lastDetectedAt: alerts.length ? alerts[0].detectedAt : null,
        },
      };
    },
  },
  {
    method: 'GET',
    match: (p) => p === '/api/watchlist',
    handle: async () => {
      const data = await airtable(encodeURIComponent(WATCHLIST_TABLE), { query: { maxRecords: '100' } });
      return { status: 200, body: { watchlist: (data.records || []).map(watchlistFromRecord) } };
    },
  },
  {
    method: 'POST',
    match: (p) => p === '/api/watchlist',
    handle: async (req) => {
      const payload = await readBody(req);
      const fields = watchlistFields(payload);
      if (!fields.Supplier || !fields['Search Query']) {
        throw Object.assign(new Error('supplier and query are both required.'), { status: 400 });
      }
      if (fields['Risk Threshold'] === undefined) fields['Risk Threshold'] = 70;
      if (fields.Active === undefined) fields.Active = true;
      const data = await airtable(encodeURIComponent(WATCHLIST_TABLE), {
        method: 'POST',
        body: { records: [{ fields }], typecast: true },
      });
      return { status: 201, body: { entry: watchlistFromRecord(data.records[0]) } };
    },
  },
  {
    method: 'PATCH',
    match: (p) => p.startsWith('/api/watchlist/'),
    handle: async (req, url) => {
      const id = url.pathname.split('/').pop();
      if (!RECORD_ID.test(id)) throw Object.assign(new Error('Invalid record id.'), { status: 400 });
      const payload = await readBody(req);
      const fields = watchlistFields(payload);
      if (Object.keys(fields).length === 0) {
        throw Object.assign(new Error('No updatable fields supplied.'), { status: 400 });
      }
      const data = await airtable(`${encodeURIComponent(WATCHLIST_TABLE)}/${id}`, {
        method: 'PATCH',
        body: { fields, typecast: true },
      });
      return { status: 200, body: { entry: watchlistFromRecord(data) } };
    },
  },
  {
    method: 'DELETE',
    match: (p) => p.startsWith('/api/watchlist/'),
    handle: async (req, url) => {
      const id = url.pathname.split('/').pop();
      if (!RECORD_ID.test(id)) throw Object.assign(new Error('Invalid record id.'), { status: 400 });
      await airtable(`${encodeURIComponent(WATCHLIST_TABLE)}/${id}`, { method: 'DELETE' });
      return { status: 200, body: { deleted: id } };
    },
  },
];

function serveStatic(req, res, pathname) {
  // A fresh install lands on the setup wizard instead of an empty dashboard.
  if (pathname === '/' && !setupComplete()) {
    res.writeHead(302, { Location: '/setup' });
    res.end();
    return;
  }
  if (pathname === '/setup' || pathname === '/setup/') {
    pathname = '/setup.html';
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    // Never cache: this page's content (Airtable configuration state, alert
    // data) can change between one load and the next, and a stale cached copy
    // is exactly the kind of "why is this wrong" confusion this project has
    // no room for.
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = routes.find((r) => r.method === req.method && r.match(url.pathname));

  if (!route) {
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const { status, body } = await route.handle(req, url);
    sendJson(res, status, body);
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message || 'Internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`[dashboard] listening on http://localhost:${PORT}`);
  if (!airtableConfigured()) {
    console.log('[dashboard] WARNING: Airtable is not configured — the dashboard will load but show no data.');
  }
});

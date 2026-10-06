#!/usr/bin/env node
/**
 * One-shot first-boot setup for Supply Chain Monitor.
 *
 * Turns a bare n8n container + an empty Airtable base into a running pipeline:
 *   1. waits for n8n to answer
 *   2. creates the n8n owner account (if this is a fresh instance)
 *   3. provisions the two Airtable tables and seeds an example watchlist
 *   4. creates the SMTP credential inside n8n
 *   5. imports both workflows, wires the SMTP credential in, and activates them
 *
 * Every step is idempotent — re-running it on an already-configured stack is a
 * no-op rather than a duplicate. Runs on Node's built-in fetch; no dependencies.
 */

const fs = require('fs');
const path = require('path');

const N8N_BASE_URL = process.env.N8N_BASE_URL || 'http://n8n:5678';
const OWNER_EMAIL = process.env.N8N_OWNER_EMAIL || '';
const OWNER_PASSWORD = process.env.N8N_OWNER_PASSWORD || '';
const OWNER_FIRST = process.env.N8N_OWNER_FIRST_NAME || 'Supply';
const OWNER_LAST = process.env.N8N_OWNER_LAST_NAME || 'Monitor';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || '';
const ALERTS_TABLE = process.env.AIRTABLE_ALERTS_TABLE_NAME || 'Disruption Alerts';
const WATCHLIST_TABLE = process.env.AIRTABLE_WATCHLIST_TABLE_NAME || 'Watchlist';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || '';
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false') === 'true';
const SMTP_CREDENTIAL_NAME = 'Supply Chain Monitor SMTP';

const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR || '/workflows';

const PLACEHOLDER = /^replace-with-/i;
const isSet = (v) => Boolean(v) && !PLACEHOLDER.test(v);

const log = (msg) => console.log(`[bootstrap] ${msg}`);
const warn = (msg) => console.log(`[bootstrap] WARNING: ${msg}`);

let authCookie = '';

async function api(pathname, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${N8N_BASE_URL}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authCookie ? { Cookie: authCookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed, raw: res };
}

async function airtable(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for the REST API specifically, not just /healthz — n8n answers /healthz
 * a few seconds before /rest/settings is actually serving, and a settings call
 * made in that window comes back unusable.
 */
async function waitForN8n() {
  const deadline = Date.now() + 180000;
  let lastSeen = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await api('/rest/settings');
      if (res.ok && res.body?.data?.userManagement) {
        log('n8n is up and its REST API is serving.');
        return res.body.data.userManagement;
      }
      lastSeen = `HTTP ${res.status}`;
    } catch (e) {
      lastSeen = e.message;
    }
    await sleep(3000);
  }
  throw new Error(`n8n REST API never became ready at ${N8N_BASE_URL} within 3 minutes (last saw: ${lastSeen}).`);
}

async function ensureOwner(userManagement) {
  const needsSetup = userManagement?.showSetupOnFirstLoad;

  if (needsSetup === undefined) {
    throw new Error('Could not determine whether n8n has an owner account yet — refusing to guess.');
  }

  if (needsSetup) {
    if (!isSet(OWNER_EMAIL) || !isSet(OWNER_PASSWORD)) {
      throw new Error(
        'This is a fresh n8n instance but N8N_OWNER_EMAIL / N8N_OWNER_PASSWORD are not set in .env. ' +
          'Set them (password needs 8+ characters, one uppercase letter and one number) and re-run.'
      );
    }
    const res = await api('/rest/owner/setup', {
      method: 'POST',
      body: {
        email: OWNER_EMAIL,
        firstName: OWNER_FIRST,
        lastName: OWNER_LAST,
        password: OWNER_PASSWORD,
      },
    });
    if (!res.ok) {
      throw new Error(`Could not create the n8n owner account: ${JSON.stringify(res.body)}`);
    }
    // Owner setup already returns a session, so a separate login is unnecessary.
    const setCookie = res.raw.headers.get('set-cookie');
    if (setCookie) authCookie = setCookie.split(';')[0];
    log(`Created n8n owner account for ${OWNER_EMAIL}.`);
  } else {
    log('n8n owner account already exists — skipping.');
  }
}

async function login() {
  if (authCookie) {
    log('Already authenticated from owner setup.');
    return;
  }
  // n8n has used different field names for this across versions; try both.
  const attempts = [
    { emailOrLdapLoginId: OWNER_EMAIL, password: OWNER_PASSWORD },
    { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  ];
  for (const body of attempts) {
    const res = await api('/rest/login', { method: 'POST', body });
    if (res.ok) {
      const setCookie = res.raw.headers.get('set-cookie');
      if (setCookie) {
        authCookie = setCookie.split(';')[0];
        log('Authenticated against n8n.');
        return;
      }
    }
  }
  throw new Error('Could not log in to n8n with the configured owner credentials.');
}

const alertsTableSchema = {
  name: ALERTS_TABLE,
  description: 'Every scored supply chain signal. "Alert Sent" marks the ones that crossed the alert threshold.',
  fields: [
    { name: 'Article Title', type: 'singleLineText' },
    { name: 'Detected At', type: 'dateTime', options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' } },
    { name: 'Supplier', type: 'singleLineText' },
    { name: 'Region', type: 'singleLineText' },
    { name: 'Article URL', type: 'url' },
    { name: 'Source', type: 'singleLineText' },
    { name: 'Published At', type: 'dateTime', options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' } },
    { name: 'Risk Score', type: 'number', options: { precision: 0 } },
    {
      name: 'Risk Category',
      type: 'singleSelect',
      options: { choices: [{ name: 'Low' }, { name: 'Medium' }, { name: 'High' }, { name: 'Critical' }] },
    },
    { name: 'Risk Reasoning', type: 'multilineText' },
    { name: 'Risk Threshold Used', type: 'number', options: { precision: 0 } },
    { name: 'Alert Sent', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
    {
      name: 'Alert Channels',
      type: 'multipleSelects',
      options: { choices: [{ name: 'Slack' }, { name: 'Email' }] },
    },
  ],
};

const watchlistTableSchema = {
  name: WATCHLIST_TABLE,
  description: 'Suppliers and regions monitored each hour. Edit here — no need to touch n8n.',
  fields: [
    { name: 'Supplier', type: 'singleLineText' },
    { name: 'Region', type: 'singleLineText' },
    { name: 'Search Query', type: 'multilineText' },
    { name: 'Risk Threshold', type: 'number', options: { precision: 0 } },
    { name: 'Active', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
  ],
};

const seedWatchlistRows = [
  {
    fields: {
      Supplier: 'Acme Components',
      Region: 'Taiwan',
      'Search Query':
        '"Acme Components" AND (strike OR shortage OR delay OR disruption OR flood OR earthquake OR factory OR port OR shipping)',
      'Risk Threshold': 70,
      Active: true,
    },
  },
  {
    fields: {
      Supplier: 'Meridian Textiles',
      Region: 'Vietnam',
      'Search Query':
        '"Meridian Textiles" AND (strike OR shortage OR delay OR disruption OR flood OR factory OR shipping OR port)',
      'Risk Threshold': 60,
      Active: true,
    },
  },
  {
    fields: {
      Supplier: 'Northbay Electronics',
      Region: 'South Korea',
      'Search Query':
        '"Northbay Electronics" AND (strike OR shortage OR delay OR disruption OR factory OR shipping OR export)',
      'Risk Threshold': 75,
      Active: true,
    },
  },
];

async function ensureAirtableTables() {
  if (!isSet(AIRTABLE_API_KEY) || !isSet(AIRTABLE_BASE_ID)) {
    warn('AIRTABLE_API_KEY / AIRTABLE_BASE_ID not set — skipping Airtable provisioning. The pipeline cannot run until these are filled in.');
    return;
  }

  const listUrl = `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`;
  const existing = await airtable(listUrl);
  if (!existing.ok) {
    warn(
      `Could not read the Airtable base schema (HTTP ${existing.status}). ` +
        'Check AIRTABLE_BASE_ID and that the token has the schema.bases:read and schema.bases:write scopes. ' +
        `Response: ${JSON.stringify(existing.body)}`
    );
    return;
  }

  const existingNames = (existing.body.tables || []).map((t) => t.name);

  for (const schema of [alertsTableSchema, watchlistTableSchema]) {
    if (existingNames.includes(schema.name)) {
      log(`Airtable table "${schema.name}" already exists — skipping.`);
      continue;
    }
    const created = await airtable(listUrl, { method: 'POST', body: schema });
    if (created.ok) {
      log(`Created Airtable table "${schema.name}".`);
    } else {
      warn(`Could not create Airtable table "${schema.name}" (HTTP ${created.status}): ${JSON.stringify(created.body)}`);
    }
  }

  await seedWatchlist();
}

async function seedWatchlist() {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(WATCHLIST_TABLE)}?maxRecords=1`;
  const current = await airtable(url);
  if (!current.ok) {
    warn(`Could not read the watchlist table (HTTP ${current.status}) — skipping seed.`);
    return;
  }
  if ((current.body.records || []).length > 0) {
    log('Watchlist already has entries — skipping seed.');
    return;
  }
  const createUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(WATCHLIST_TABLE)}`;
  const res = await airtable(createUrl, { method: 'POST', body: { records: seedWatchlistRows, typecast: true } });
  if (res.ok) {
    log(`Seeded the watchlist with ${seedWatchlistRows.length} example suppliers — replace these with your real ones.`);
  } else {
    warn(`Could not seed the watchlist (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  }
}

async function ensureSmtpCredential() {
  if (!isSet(SMTP_HOST) || !isSet(SMTP_USER)) {
    warn('SMTP_HOST / SMTP_USER not set — skipping the email credential. Slack alerts will still work; email alerts will not.');
    return null;
  }

  const existing = await api('/rest/credentials');
  const list = existing.body?.data || [];
  const found = list.find((c) => c.name === SMTP_CREDENTIAL_NAME);
  if (found) {
    log(`SMTP credential "${SMTP_CREDENTIAL_NAME}" already exists — skipping.`);
    return found.id;
  }

  const res = await api('/rest/credentials', {
    method: 'POST',
    body: {
      name: SMTP_CREDENTIAL_NAME,
      type: 'smtp',
      data: {
        user: SMTP_USER,
        password: SMTP_PASSWORD,
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        disableStartTls: false,
      },
    },
  });

  if (!res.ok) {
    warn(`Could not create the SMTP credential: ${JSON.stringify(res.body)}`);
    return null;
  }
  const id = res.body?.data?.id;
  log(`Created SMTP credential "${SMTP_CREDENTIAL_NAME}".`);
  return id;
}

function applySmtpCredential(workflow, credentialId) {
  if (!credentialId) return workflow;
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.emailSend') {
      node.credentials = { smtp: { id: credentialId, name: SMTP_CREDENTIAL_NAME } };
    }
  }
  return workflow;
}

async function activateWorkflow(id, name) {
  // n8n exposes activation slightly differently across versions; try both shapes.
  let res = await api(`/rest/workflows/${id}`, { method: 'PATCH', body: { active: true } });
  if (!res.ok) {
    res = await api(`/rest/workflows/${id}/activate`, { method: 'POST', body: {} });
  }
  if (res.ok) {
    log(`Activated "${name}".`);
  } else {
    warn(`Imported "${name}" but could not activate it automatically: ${JSON.stringify(res.body)}. Toggle it Active in the n8n UI.`);
  }
}

/**
 * Patches an already-imported workflow's Send Email Alert node(s) to point at
 * the current SMTP credential, if they aren't already. No-op when there's
 * nothing to attach or nothing has changed, so this is safe to call every run.
 */
async function ensureSmtpCredentialAttached(workflowId, name, smtpCredentialId) {
  if (!smtpCredentialId) return;

  const full = await api(`/rest/workflows/${workflowId}`);
  const workflow = full.body?.data;
  if (!workflow || !Array.isArray(workflow.nodes)) return;

  let changed = false;
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.emailSend' && node.credentials?.smtp?.id !== smtpCredentialId) {
      node.credentials = { smtp: { id: smtpCredentialId, name: SMTP_CREDENTIAL_NAME } };
      changed = true;
    }
  }
  if (!changed) return;

  const res = await api(`/rest/workflows/${workflowId}`, {
    method: 'PATCH',
    body: { nodes: workflow.nodes },
  });
  if (res.ok) {
    log(`Attached SMTP credential to "${name}".`);
  } else {
    warn(`Could not attach SMTP credential to "${name}": ${JSON.stringify(res.body)}`);
  }
}

async function importWorkflows(smtpCredentialId) {
  if (!fs.existsSync(WORKFLOWS_DIR)) {
    throw new Error(`Workflow directory not found: ${WORKFLOWS_DIR}`);
  }
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    warn(`No workflow JSON files found in ${WORKFLOWS_DIR}.`);
    return;
  }

  const existing = await api('/rest/workflows');
  const existingList = existing.body?.data || [];

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8'));
    const prepared = applySmtpCredential(raw, smtpCredentialId);

    const already = existingList.find((w) => w.name === prepared.name);
    if (already) {
      log(`Workflow "${prepared.name}" already imported.`);
      // An already-imported workflow is skipped past the code below that
      // attaches the SMTP credential to a brand-new import — so on every
      // later run (e.g. after the user fixes SMTP_HOST and re-runs bootstrap)
      // this is the only place that credential ever gets attached.
      await ensureSmtpCredentialAttached(already.id, prepared.name, smtpCredentialId);
      await activateWorkflow(already.id, prepared.name);
      continue;
    }

    const res = await api('/rest/workflows', {
      method: 'POST',
      body: {
        name: prepared.name,
        nodes: prepared.nodes,
        connections: prepared.connections,
        settings: prepared.settings || { executionOrder: 'v1' },
        active: false,
      },
    });

    if (!res.ok) {
      warn(`Could not import "${prepared.name}": ${JSON.stringify(res.body)}`);
      continue;
    }
    const id = res.body?.data?.id;
    log(`Imported "${prepared.name}".`);
    await activateWorkflow(id, prepared.name);
  }
}

async function main() {
  log('Starting first-boot setup...');
  const userManagement = await waitForN8n();
  await ensureOwner(userManagement);
  await login();
  await ensureAirtableTables();
  const smtpCredentialId = await ensureSmtpCredential();
  await importWorkflows(smtpCredentialId);
  log('Setup complete.');
  log(`n8n UI:     http://localhost:${process.env.N8N_UI_PORT || '5678'}`);
  log(`Dashboard:  http://localhost:${process.env.DASHBOARD_HOST_PORT || '8101'}`);
}

main().catch((err) => {
  console.error(`[bootstrap] FAILED: ${err.message}`);
  process.exit(1);
});

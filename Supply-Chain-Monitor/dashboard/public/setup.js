'use strict';

const form = document.getElementById('setup-form');
const errorEl = document.getElementById('setup-error');

async function api(path, options) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

function collect(names) {
  const payload = {};
  for (const name of names) {
    const field = form.elements[name];
    if (field) payload[name] = field.value.trim();
  }
  return payload;
}

/* ---------- per-service "test this key" buttons ---------- */

for (const button of document.querySelectorAll('[data-test]')) {
  button.addEventListener('click', async () => {
    const service = button.dataset.test;
    const fields = button.dataset.fields.split(',');
    const result = document.querySelector(`[data-result="${service}"]`);

    const payload = collect(fields);
    const empty = fields.filter((f) => !payload[f]);
    if (empty.length) {
      result.textContent = 'Fill the field above first.';
      result.className = 'test-result test-fail';
      return;
    }

    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Testing…';
    result.textContent = '';
    result.className = 'test-result';

    try {
      const data = await api('/api/setup/test', {
        method: 'POST',
        body: JSON.stringify({ service, ...payload }),
      });
      result.textContent = (data.ok ? '✓ ' : '✕ ') + data.message;
      result.className = `test-result ${data.ok ? 'test-pass' : 'test-fail'}`;
    } catch (err) {
      result.textContent = `✕ ${err.message}`;
      result.className = 'test-result test-fail';
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });
}

/* ---------- submit ---------- */

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.hidden = true;

  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = 'Saving…';

  const payload = {};
  for (const field of form.elements) {
    if (field.name) payload[field.name] = field.value.trim();
  }

  try {
    await api('/api/setup', { method: 'POST', body: JSON.stringify(payload) });
    form.hidden = true;
    document.querySelector('.intro-card').hidden = true;
    document.getElementById('done-panel').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    submit.disabled = false;
    submit.textContent = 'Save configuration';
  }
});

/* ---------- if setup already ran, don't offer it again ---------- */

api('/api/setup/status')
  .then((status) => {
    if (status.setupComplete) {
      document.getElementById('already-done').hidden = false;
      document.getElementById('setup-body').hidden = true;
    }
  })
  .catch(() => {
    /* leave the form usable if the status check itself fails */
  });

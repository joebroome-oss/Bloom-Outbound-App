// Thin wrapper around Apollo's REST API (https://docs.apollo.io/reference).
// Uses the account's own Apollo API key (Settings -> Integrations -> API in Apollo),
// which is different from the OAuth connection Cowork uses — this app talks to
// Apollo directly, with no Cowork/Claude round-trip.

const APOLLO_BASE = 'https://api.apollo.io/api/v1';
const EXISTING_DEAL_LABEL = 'Bloom: Existing Deal';
const CONFIRMED_SENT_LABEL = 'Bloom: Confirmed Sent';

function isConfigured() {
  return Boolean(process.env.APOLLO_API_KEY);
}

async function apolloFetch(path, options = {}) {
  if (!isConfigured()) {
    const err = new Error('Apollo API key not configured');
    err.code = 'apollo_not_configured';
    throw err;
  }
  const res = await fetch(`${APOLLO_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': process.env.APOLLO_API_KEY,
      ...(options.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((json && (json.error || json.message)) || `Apollo API error (${res.status})`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Targeted lookup by exact email — never a broad search. Mirrors the safeguard
// baked into the original Cowork workflow: q_keywords is the contact's exact
// email address only.
async function findContactByEmail(email) {
  const json = await apolloFetch('/contacts/search', {
    method: 'POST',
    body: JSON.stringify({ q_keywords: email, per_page: 1 }),
  });
  const contacts = json.contacts || [];
  return contacts[0] || null;
}

async function createDraft({ contactId, subject, bodyHtml }) {
  return apolloFetch('/emailer_messages', {
    method: 'POST',
    body: JSON.stringify({ contact_id: contactId, subject, body_html: bodyHtml }),
  });
}

async function getEmailAccounts() {
  const json = await apolloFetch('/email_accounts', { method: 'GET' });
  return json.email_accounts || [];
}

async function sendNow(messageId, sendFrom) {
  return apolloFetch(`/emailer_messages/${messageId}/send_now`, {
    method: 'POST',
    body: JSON.stringify({ surface: 'bloom_outbound_site', send_from: sendFrom }),
  });
}

async function checkSendStatus(messageId) {
  return apolloFetch('/emailer_messages/email_send_status', {
    method: 'POST',
    body: JSON.stringify({ id: messageId }),
  });
}

async function getLabels() {
  const json = await apolloFetch('/labels', { method: 'GET' });
  return json.labels || json || [];
}

// Apollo's Update a Contact endpoint treats `label_names` as a REPLACE, not an
// append ("Passing new values will overwrite existing lists" per the docs) —
// unlike the Cowork side's apollo_labels_add_entity_ids_to_label_names tool,
// which adds without disturbing other list membership. So here we resolve the
// contact's current label ids to names first and merge in the new one, rather
// than clobbering whatever lists they were already on.
async function addLabel(contact, labelName) {
  const contactId = contact.id;
  const currentLabelIds = contact.label_ids || [];
  let names = [];
  if (currentLabelIds.length) {
    const labels = await getLabels();
    const byId = {};
    (labels || []).forEach((l) => { byId[l.id] = l.name; });
    names = currentLabelIds.map((id) => byId[id]).filter(Boolean);
  }
  if (!names.includes(labelName)) names.push(labelName);
  return apolloFetch(`/contacts/${contactId}`, {
    method: 'PATCH',
    body: JSON.stringify({ label_names: names }),
  });
}

// Permanently stops the automated sequence for this contact (Joe is already in
// a live deal conversation with them elsewhere). Tomorrow's Cowork scheduled
// run checks for this list and writes a permanent "stopped": true into
// bloom_send_log.json.
async function addExistingDealLabel(contact) {
  return addLabel(contact, EXISTING_DEAL_LABEL);
}

// Confirms the contact's currently-pending step was actually sent (via this
// site, the Cowork artifact, or some other channel entirely) without stopping
// the sequence. Tomorrow's Cowork scheduled run checks for this list, logs the
// pending step as sent, advances to the next step on the normal cadence, and
// then removes the label again — it's a one-shot signal, not a permanent tag,
// so it never wrongly auto-confirms a later, different step.
async function addConfirmedSentLabel(contact) {
  return addLabel(contact, CONFIRMED_SENT_LABEL);
}

module.exports = {
  isConfigured,
  findContactByEmail,
  createDraft,
  sendNow,
  checkSendStatus,
  getEmailAccounts,
  getLabels,
  addLabel,
  addExistingDealLabel,
  addConfirmedSentLabel,
  EXISTING_DEAL_LABEL,
  CONFIRMED_SENT_LABEL,
};

// Thin wrapper around Apollo's REST API (https://docs.apollo.io/reference).
// Uses the account's own Apollo API key (Settings -> Integrations -> API in Apollo),
// which is different from the OAuth connection Cowork uses — this app talks to
// Apollo directly, with no Cowork/Claude round-trip.

const APOLLO_BASE = 'https://api.apollo.io/api/v1';

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

async function sendNow(messageId) {
  return apolloFetch(`/emailer_messages/${messageId}/send_now`, {
    method: 'POST',
    body: JSON.stringify({ surface: 'bloom_outbound_site' }),
  });
}

async function checkSendStatus(messageId) {
  return apolloFetch('/emailer_messages/email_send_status', {
    method: 'POST',
    body: JSON.stringify({ id: messageId }),
  });
}

module.exports = { isConfigured, findContactByEmail, createDraft, sendNow, checkSendStatus };

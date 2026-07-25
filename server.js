require('dotenv').config();
const express = require('express');
const path = require('path');

const apollo = require('./lib/apollo');
const store = require('./lib/store');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const SYNC_SECRET = process.env.SYNC_SECRET || '';

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function textToHtml(text) {
  return String(text)
    .split(/\n\n+/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, apolloConfigured: apollo.isConfigured() });
});

app.get('/api/queue', (req, res) => {
  res.json(store.getQueue());
});

// Called once a day by whatever computes "what's due today" (right now, the
// Cowork/Claude scheduled task — research + reconciliation logic still lives
// there; this endpoint just receives the result). Protected by a shared secret
// so only that job can overwrite the queue.
app.post('/api/sync', (req, res) => {
  if (!SYNC_SECRET) {
    return res.status(503).json({
      error: 'sync_not_configured',
      message: 'Set SYNC_SECRET in the environment before enabling daily sync.',
    });
  }
  if (req.get('x-sync-secret') !== SYNC_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { today, queue } = req.body || {};
  if (!today || !Array.isArray(queue)) {
    return res.status(400).json({ error: 'invalid_payload', message: 'Body must be { today, queue: [...] }.' });
  }
  const data = store.setQueue({ today, queue });
  res.json({ ok: true, count: data.queue.length });
});

app.post('/api/items/:id/send', async (req, res) => {
  const { id } = req.params;
  const { to, subject, body } = req.body || {};
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'invalid_payload', message: 'to, subject, and body are required.' });
  }
  if (!apollo.isConfigured()) {
    return res.status(503).json({
      error: 'apollo_not_configured',
      message: "Apollo API key not set on the server yet — add APOLLO_API_KEY to enable sending.",
    });
  }
  try {
    const contact = await apollo.findContactByEmail(to);
    if (!contact) {
      return res.status(422).json({
        error: 'contact_not_found',
        message: `Could not find ${to} in Apollo by exact email — nothing was sent.`,
      });
    }
    const draft = await apollo.createDraft({ contactId: contact.id, subject, bodyHtml: textToHtml(body) });
    const messageId = draft && draft.emailer_message && draft.emailer_message.id;
    if (!messageId) {
      return res.status(502).json({ error: 'no_draft_id', message: 'Apollo did not return a draft id — nothing was sent.' });
    }

    const sendResult = await apollo.sendNow(messageId);
    const msg = sendResult && sendResult.emailer_message;
    const status = msg && msg.status;

    if (status === 'failed') {
      const reason = (msg && (msg.failure_reason || msg.not_sent_reason)) || 'unknown reason';
      return res.json({ status: 'failed', message: `Apollo reported the send failed: ${reason}` });
    }
    if (status === 'scheduled' || status === 'delayed') {
      store.markStatus(id, 'sent');
      return res.json({
        status: 'queued',
        message: (msg && msg.schedule_delayed_reason) || 'Queued in Apollo — will deliver automatically.',
      });
    }
    store.markStatus(id, 'sent');
    return res.json({ status: 'completed', message: 'Sent.' });
  } catch (err) {
    console.error('Send failed', err);
    return res.status(502).json({ error: 'apollo_error', message: err.message || 'Apollo call failed.' });
  }
});

app.post('/api/items/:id/hold', (req, res) => {
  const data = store.markStatus(req.params.id, 'held');
  res.json({ ok: true, data });
});

// Placeholder — the research/drafting brain (WebSearch + copy generation)
// still lives in the Cowork scheduled task for now. Wire this up once that
// logic moves server-side too.
app.post('/api/research-more', (req, res) => {
  res.status(501).json({
    error: 'not_implemented',
    message: 'Researching new accounts isn\'t wired up in the standalone site yet — trigger "Go for more" from the Cowork artifact for now.',
  });
});

app.listen(PORT, () => {
  console.log(`Bloom outbound app listening on port ${PORT}`);
  console.log(`Apollo configured: ${apollo.isConfigured()}`);
});

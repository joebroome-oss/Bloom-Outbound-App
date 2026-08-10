require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const apollo = require('./lib/apollo');
const store = require('./lib/store');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const SYNC_SECRET = process.env.SYNC_SECRET || '';
const MAILBOX_EMAIL = process.env.MAILBOX_EMAIL || 'joe.broome@usebloom.com';

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

    const accounts = await apollo.getEmailAccounts();
    const mailbox = accounts.find((a) => a.email === MAILBOX_EMAIL) || accounts.find((a) => a.default) || accounts[0];
    if (!mailbox) {
      return res.status(422).json({
        error: 'no_mailbox',
        message: 'Could not find a linked sending mailbox in Apollo — nothing was sent.',
      });
    }

    const sendResult = await apollo.sendNow(messageId, { email_account_id: mailbox.id, email: mailbox.email });
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

// General-purpose override, not scoped to "today": marks a queue item done
// for whenever this dashboard is showing something that's already actually
// been sent — whether that was earlier today (e.g. a same-day re-sync after a
// copy fix reset it to 'pending') or on a previous day. Never triggers a
// duplicate send. Also flags the contact in Apollo with a one-shot "Bloom:
// Confirmed Sent" label (mirrors "existing-deal" below) so tomorrow's Cowork
// scheduled run permanently logs the pending step as sent and advances the
// sequence to its next step on the normal cadence — without this, an item
// only hidden in this file's queue.json would resurface the next time the
// daily sync overwrites it, since that overwrite doesn't carry statuses
// forward. Requires the contact's email (`to`) so we can look them up in
// Apollo; still marks the item done locally even if the Apollo call fails, so
// Joe isn't blocked, but logs the failure.
app.post('/api/items/:id/already-sent', async (req, res) => {
  const { id } = req.params;
  const { to } = req.body || {};
  let apolloWarning = null;
  if (!to) {
    apolloWarning = 'No contact email provided — marked done here only; this may resurface tomorrow if Apollo never confirms it independently.';
  } else if (!apollo.isConfigured()) {
    apolloWarning = 'Apollo API key not set on the server yet — marked done here only; this may resurface tomorrow.';
  } else {
    try {
      const contact = await apollo.findContactByEmail(to);
      if (!contact) {
        apolloWarning = `Could not find ${to} in Apollo by exact email — marked done here only; this may resurface tomorrow.`;
      } else {
        await apollo.addConfirmedSentLabel(contact);
      }
    } catch (err) {
      console.error('Already-sent Apollo flag failed', err);
      apolloWarning = 'Could not flag this contact in Apollo — marked done here only; this may resurface tomorrow.';
    }
  }
  const data = store.markStatus(id, 'already_sent');
  res.json({ ok: true, data, warning: apolloWarning });
});

// Permanently stops the automated sequence for this contact because Joe is
// already in a live deal conversation with them elsewhere — distinct from
// "already sent", which is just a one-time skip. Adds the contact to a fixed
// Apollo list; tomorrow's Cowork scheduled run checks that list and writes a
// permanent "stopped" flag into bloom_send_log.json so they're never queued
// again. Requires the contact's email (`to`) so we can look them up in Apollo.
app.post('/api/items/:id/existing-deal', async (req, res) => {
  const { id } = req.params;
  const { to } = req.body || {};
  if (!to) {
    return res.status(400).json({ error: 'invalid_payload', message: 'to (contact email) is required.' });
  }
  if (!apollo.isConfigured()) {
    return res.status(503).json({
      error: 'apollo_not_configured',
      message: 'Apollo API key not set on the server yet — add APOLLO_API_KEY to flag existing deals.',
    });
  }
  try {
    const contact = await apollo.findContactByEmail(to);
    if (!contact) {
      return res.status(422).json({
        error: 'contact_not_found',
        message: `Could not find ${to} in Apollo by exact email — nothing was flagged.`,
      });
    }
    await apollo.addExistingDealLabel(contact);
    const data = store.markStatus(id, 'existing_deal');
    return res.json({ ok: true, data });
  } catch (err) {
    console.error('Existing-deal flag failed', err);
    return res.status(502).json({ error: 'apollo_error', message: err.message || 'Apollo call failed.' });
  }
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

// Self-heal for public/index.html.
//
// index.html's static head is ~300KB of embedded base64 @font-face data. That's
// too large to safely push through any text-generating tool call — on
// 2026-07-30 an attempt to hand-edit index.html through the GitHub Contents API
// silently corrupted/stripped the font (verified: an LLM cannot reliably
// retype ~90k tokens of dense base64 without transcription errors, and
// GitHub's Contents API has no "edit in place" or blob-reuse option exposed
// to us — every update requires resending the full file as text). The same
// "index.html fix blocked by file size" problem was already hit once before,
// on 2026-07-28 (see git log), and worked around by avoiding the file instead
// of fixing the real issue.
//
// Rather than ever hand-editing that blob again, we rebuild it here at boot,
// every time: fetch a known-good historical commit of index.html (still has
// the original font, just the OLD interactive script) straight from GitHub's
// raw content API, keep everything up to the start of the interactive
// <style>/<script> block, and append the CURRENT public/app-script.html
// (small, safe to hand-edit normally, and always kept up to date) in its
// place. This runs on every boot and is a no-op once index.html already has
// both the font and the latest interactive block, so it's safe to leave in
// permanently.
const OLD_FONT_INTACT_SHA = '93b31affe9f9c82271db6f35ef97168d61ee3f44';
const OLD_FONT_INTACT_URL = `https://raw.githubusercontent.com/joebroome-oss/Bloom-Outbound-App/${OLD_FONT_INTACT_SHA}/public/index.html`;

async function ensureIndexHtmlHealthy() {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const scriptPath = path.join(__dirname, 'public', 'app-script.html');
  try {
    const current = fs.readFileSync(indexPath, 'utf8');
    const hasFont = current.includes('@font-face');
    const hasLatestButtons = current.includes('existing-deal') && current.includes('already-sent');
    if (hasFont && hasLatestButtons) {
      console.log('index.html already has font + latest interactive block — no rebuild needed.');
      return;
    }
    console.log(`index.html unhealthy (font: ${hasFont}, latest buttons: ${hasLatestButtons}) — rebuilding...`);

    const res = await fetch(OLD_FONT_INTACT_URL);
    if (!res.ok) throw new Error(`Could not fetch known-good index.html (HTTP ${res.status})`);
    const oldFull = await res.text();

    const marker = '<style>\n.send-error { margin-top';
    let idx = oldFull.indexOf(marker);
    if (idx === -1) {
      const first = oldFull.indexOf('<style>');
      idx = oldFull.indexOf('<style>', first + 1);
    }
    if (idx === -1 || idx < 1000) {
      throw new Error('Could not locate the interactive block boundary in the known-good file — leaving index.html as-is.');
    }

    const head = oldFull.slice(0, idx);
    const tail = fs.readFileSync(scriptPath, 'utf8');
    const rebuilt = head + tail;

    if (!rebuilt.includes('@font-face') || rebuilt.length < 250000) {
      throw new Error('Rebuilt index.html failed sanity checks — leaving existing file in place.');
    }

    fs.writeFileSync(indexPath, rebuilt);
    console.log(`index.html rebuilt successfully (${rebuilt.length} bytes).`);
  } catch (err) {
    console.error('ensureIndexHtmlHealthy failed (leaving index.html as-is):', err.message);
  }
}

ensureIndexHtmlHealthy().then(() => {
  app.listen(PORT, () => {
    console.log(`Bloom outbound app listening on port ${PORT}`);
    console.log(`Apollo configured: ${apollo.isConfigured()}`);
  });
});

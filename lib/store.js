// Simple file-backed store for today's queue. Good enough for a single-tenant
// v1 — swap for a real database (Postgres/SQLite) once this needs to hold
// multiple users' ICPs, contact lists, and history.

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'queue.json');

function load() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { today: null, queue: [] };
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function getQueue() {
  return load();
}

// Called by the daily sync job (the Cowork scheduled task, or anything else
// that computes "what's due today"). Every incoming item starts 'pending'.
function setQueue({ today, queue }) {
  const withStatus = (queue || []).map((item) => ({ status: 'pending', ...item }));
  const data = { today, queue: withStatus };
  save(data);
  return data;
}

function markStatus(id, status) {
  const data = load();
  const item = (data.queue || []).find((q) => q.id === id);
  if (item) item.status = status;
  save(data);
  return data;
}

module.exports = { getQueue, setQueue, markStatus };

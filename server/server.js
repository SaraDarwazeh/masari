/* مصاري — server: static app + REST API backed by SQLite. Single-user, password-protected. */
'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 4471;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('SESSION_SECRET env var is required — set it in .env (see .env.example)');
  process.exit(1);
}

const db = new Database(process.env.DB_PATH || '/data/masari.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS auth (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at TEXT NOT NULL);
`);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));
app.use(session({
  secret: SESSION_SECRET,
  name: 'masari.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

/* ---- brute-force guard on login (in-memory, per-process) ---- */
const attempts = new Map(); // ip -> {count, until}
function cooldownSecondsLeft(ip) {
  const a = attempts.get(ip);
  if (a && a.until && Date.now() < a.until) return Math.ceil((a.until - Date.now()) / 1000);
  return 0;
}
function recordFail(ip) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count++;
  if (a.count >= 5) { a.until = Date.now() + 30000; a.count = 0; }
  attempts.set(ip, a);
}
function recordSuccess(ip) { attempts.delete(ip); }

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  res.status(401).json({ error: 'unauthorized' });
}

const getAuthRow = () => db.prepare('SELECT password_hash FROM auth WHERE id = 1').get();

app.get('/api/status', (req, res) => {
  res.json({ hasPassword: !!getAuthRow(), authenticated: !!(req.session && req.session.authed) });
});

app.post('/api/setup', (req, res) => {
  if (getAuthRow()) return res.status(403).json({ error: 'already-setup' });
  const { password } = req.body || {};
  if (!password || String(password).length < 4) return res.status(400).json({ error: 'weak-password' });
  const hash = bcrypt.hashSync(String(password), 12);
  db.prepare('INSERT INTO auth (id, password_hash) VALUES (1, ?)').run(hash);
  req.session.authed = true;
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const wait = cooldownSecondsLeft(ip);
  if (wait) return res.status(429).json({ error: 'cooldown', wait });
  const row = getAuthRow();
  const { password } = req.body || {};
  if (!row || !password || !bcrypt.compareSync(String(password), row.password_hash)) {
    recordFail(ip);
    return res.status(401).json({ error: 'invalid' });
  }
  recordSuccess(ip);
  req.session.authed = true;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => res.json({ ok: true }));
});

app.post('/api/change-password', requireAuth, (req, res) => {
  const row = getAuthRow();
  const { oldPassword, newPassword } = req.body || {};
  if (!row || !bcrypt.compareSync(String(oldPassword || ''), row.password_hash)) {
    return res.status(401).json({ error: 'invalid-old' });
  }
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: 'weak-password' });
  db.prepare('UPDATE auth SET password_hash = ? WHERE id = 1').run(bcrypt.hashSync(String(newPassword), 12));
  res.json({ ok: true });
});

app.get('/api/state', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM state WHERE id = 1').get();
  res.json(row ? JSON.parse(row.data) : null);
});

app.put('/api/state', requireAuth, (req, res) => {
  const data = JSON.stringify(req.body || {});
  db.prepare(`
    INSERT INTO state (id, data, updated_at) VALUES (1, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(data);
  res.json({ ok: true });
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => console.log(`مصاري server on :${PORT}`));

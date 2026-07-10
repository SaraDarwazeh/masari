/* مصاري — server: static app + REST API backed by SQLite. Multi-user, password-protected. */
'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
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
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS user_state (
    user_id    INTEGER PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

/* ---- one-time migration from single-user schema (v1) to multi-user (v2) ---- */
(function migrate() {
  const hasOldAuth = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth'").get();
  const hasOldState = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state'").get();
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0 || !hasOldAuth) return;
  const oldAuth = db.prepare('SELECT password_hash FROM auth WHERE id = 1').get();
  if (!oldAuth) return;
  const insert = db.transaction(() => {
    const res = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('owner', ?, 'owner')").run(oldAuth.password_hash);
    const ownerId = res.lastInsertRowid;
    if (hasOldState) {
      const oldState = db.prepare('SELECT data FROM state WHERE id = 1').get();
      if (oldState) {
        db.prepare("INSERT INTO user_state (user_id, data, updated_at) VALUES (?, ?, datetime('now'))").run(ownerId, oldState.data);
      }
    }
  });
  insert();
  console.log('Migrated single-user data → owner account (username: "owner")');
  /* Old `auth` and `state` tables are intentionally left in place as a safety net. */
})();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));
app.use(session({
  store: new SqliteStore({
    client: db,
    // rows live in a `sessions` table in the same DB, so logins survive
    // server restarts / redeploys. Expired rows are swept hourly.
    expired: { clear: true, intervalMs: 60 * 60 * 1000 },
  }),
  secret: SESSION_SECRET,
  name: 'masari.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true, // slide the 30-day expiry forward on every request while she's active
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

/* ---- brute-force guard on login (in-memory, per-process) ---- */
const attempts = new Map();
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
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'unauthorized' });
}
function requireOwner(req, res, next) {
  if (req.session && req.session.userId && req.session.role === 'owner') return next();
  res.status(403).json({ error: 'forbidden' });
}

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,18}[a-z0-9])?$/;
const findUserByName = name => db.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?').get(name);
const findUserById   = id   => db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id);
const userCount      = ()   => db.prepare('SELECT COUNT(*) AS c FROM users').get().c;

app.get('/api/status', (req, res) => {
  const authed = !!(req.session && req.session.userId);
  const user = authed ? findUserById(req.session.userId) : null;
  res.json({ hasUsers: userCount() > 0, authenticated: authed, user });
});

/* First-run setup: creates the owner. Locked once any user exists. */
app.post('/api/setup', (req, res) => {
  if (userCount() > 0) return res.status(403).json({ error: 'already-setup' });
  const { username, password } = req.body || {};
  const name = String(username||'').trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return res.status(400).json({ error: 'bad-username' });
  if (!password || String(password).length < 4) return res.status(400).json({ error: 'weak-password' });
  const hash = bcrypt.hashSync(String(password), 12);
  const info = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'owner')").run(name, hash);
  req.session.userId = info.lastInsertRowid;
  req.session.role = 'owner';
  res.json({ ok: true });
});

/* Self-registration: anyone with the app URL can create their own account
   (always role 'user', never 'owner') without the owner seeing their password. */
app.post('/api/register', (req, res) => {
  if (userCount() === 0) return res.status(403).json({ error: 'no-owner-yet' });
  const ip = req.ip;
  const wait = cooldownSecondsLeft(ip);
  if (wait) return res.status(429).json({ error: 'cooldown', wait });
  const { username, password } = req.body || {};
  const name = String(username||'').trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return res.status(400).json({ error: 'bad-username' });
  if (!password || String(password).length < 4) return res.status(400).json({ error: 'weak-password' });
  if (findUserByName(name)) { recordFail(ip); return res.status(409).json({ error: 'username-taken' }); }
  const hash = bcrypt.hashSync(String(password), 12);
  const info = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')").run(name, hash);
  recordSuccess(ip);
  req.session.userId = info.lastInsertRowid;
  req.session.role = 'user';
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const wait = cooldownSecondsLeft(ip);
  if (wait) return res.status(429).json({ error: 'cooldown', wait });
  const { username, password } = req.body || {};
  const name = String(username||'').trim().toLowerCase();
  const row = name ? findUserByName(name) : null;
  if (!row || !password || !bcrypt.compareSync(String(password), row.password_hash)) {
    recordFail(ip);
    return res.status(401).json({ error: 'invalid' });
  }
  recordSuccess(ip);
  req.session.userId = row.id;
  req.session.role = row.role;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => res.json({ ok: true }));
});

app.post('/api/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.session.userId);
  if (!row || !bcrypt.compareSync(String(oldPassword || ''), row.password_hash)) {
    return res.status(401).json({ error: 'invalid-old' });
  }
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: 'weak-password' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(newPassword), 12), req.session.userId);
  res.json({ ok: true });
});

app.post('/api/change-username', requireAuth, (req, res) => {
  const name = String((req.body || {}).username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return res.status(400).json({ error: 'bad-username' });
  const existing = findUserByName(name);
  if (existing && existing.id !== req.session.userId) return res.status(409).json({ error: 'username-taken' });
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(name, req.session.userId);
  res.json({ ok: true });
});

/* ---- per-user state ---- */
app.get('/api/state', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM user_state WHERE user_id = ?').get(req.session.userId);
  res.json(row ? JSON.parse(row.data) : null);
});

app.put('/api/state', requireAuth, (req, res) => {
  const data = JSON.stringify(req.body || {});
  db.prepare(`
    INSERT INTO user_state (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(req.session.userId, data);
  res.json({ ok: true });
});

/* ---- owner-only user management ---- */
app.get('/api/users', requireOwner, (req, res) => {
  const rows = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY role DESC, created_at').all();
  res.json({ users: rows });
});

app.post('/api/users', requireOwner, (req, res) => {
  const { username, password } = req.body || {};
  const name = String(username||'').trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return res.status(400).json({ error: 'bad-username' });
  if (!password || String(password).length < 4) return res.status(400).json({ error: 'weak-password' });
  if (findUserByName(name)) return res.status(409).json({ error: 'username-taken' });
  const hash = bcrypt.hashSync(String(password), 12);
  const info = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')").run(name, hash);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/users/:id', requireOwner, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'bad-id' });
  if (targetId === req.session.userId) return res.status(400).json({ error: 'cannot-delete-self' });
  const target = findUserById(targetId);
  if (!target) return res.status(404).json({ error: 'not-found' });
  if (target.role === 'owner') return res.status(400).json({ error: 'cannot-delete-owner' });
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ ok: true });
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => console.log(`مصاري server on :${PORT}`));

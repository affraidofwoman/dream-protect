import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Dossiers
export const DATA = path.join(process.cwd(), 'data');
fs.mkdirSync(DATA, { recursive: true });
const DB_FILE = process.env.DATABASE_PATH?.trim() || path.join(DATA, 'dream.sqlite');

// Base SQLite
const raw = new DatabaseSync(DB_FILE, { timeout: 5000, enableForeignKeyConstraints: true });
const statements = new Map();
export const db = {
  exec: (sql) => raw.exec(sql),
  prepare(sql) {
    let stmt = statements.get(sql);
    if (!stmt) statements.set(sql, (stmt = raw.prepare(sql)));
    return stmt;
  },
  close: () => raw.close(),
};
for (const pragma of ['journal_mode = WAL', 'synchronous = NORMAL', 'busy_timeout = 5000', 'temp_store = MEMORY']) {
  try {
    db.exec(`PRAGMA ${pragma}`);
  } catch {}
}

// Transactions imbriquées
let depth = 0;
export function transaction(fn) {
  const point = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${point}`);
  depth++;
  try {
    const out = fn();
    depth--;
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${point}`);
    return out;
  } catch (error) {
    depth--;
    try {
      db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${point}`);
    } catch {}
    throw error;
  }
}

// Tables
db.exec(`
CREATE TABLE IF NOT EXISTS guilds(id TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS owners(user_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wl(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,kind TEXT NOT NULL,level INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id,kind));
CREATE TABLE IF NOT EXISTS hierarchy(guild_id TEXT NOT NULL,name TEXT NOT NULL,level INTEGER NOT NULL,role_id TEXT,PRIMARY KEY(guild_id,name));
CREATE TABLE IF NOT EXISTS linked_roles(guild_id TEXT NOT NULL,role_id TEXT NOT NULL,name TEXT NOT NULL,level INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,role_id));
CREATE TABLE IF NOT EXISTS command_permissions(guild_id TEXT NOT NULL,command TEXT NOT NULL,min_level INTEGER NOT NULL DEFAULT 0,levels TEXT NOT NULL DEFAULT '[]',roles TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,command));
CREATE TABLE IF NOT EXISTS settings(guild_id TEXT NOT NULL,scope TEXT NOT NULL,scope_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(guild_id,scope,scope_id,key));
CREATE TABLE IF NOT EXISTS bot_access(guild_id TEXT NOT NULL,bot_id TEXT NOT NULL,bot_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',inviter_id TEXT,server_owner_id TEXT,requested_at INTEGER NOT NULL,decided_at INTEGER,decided_by TEXT,invite_url TEXT,PRIMARY KEY(guild_id,bot_id));
CREATE TABLE IF NOT EXISTS log_channels(guild_id TEXT NOT NULL,key TEXT NOT NULL,channel_id TEXT,category_id TEXT,mirror_id TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,key));
CREATE TABLE IF NOT EXISTS log_messages(guild_id TEXT NOT NULL,message_id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,category TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,actor_id TEXT,result TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS panels(guild_id TEXT NOT NULL,key TEXT NOT NULL,channel_id TEXT,message_id TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,key));
CREATE TABLE IF NOT EXISTS embeds(guild_id TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,key));
CREATE TABLE IF NOT EXISTS sanctions(id INTEGER PRIMARY KEY AUTOINCREMENT,guild_id TEXT NOT NULL,target_id TEXT NOT NULL,actor_id TEXT NOT NULL,type TEXT NOT NULL,reason TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bl(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id,kind));
CREATE TABLE IF NOT EXISTS wet_global(user_id TEXT PRIMARY KEY,reason TEXT,actor_id TEXT,origin_guild TEXT,level INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dog(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id));
CREATE TABLE IF NOT EXISTS leashes(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,holder_id TEXT NOT NULL,nickname TEXT NOT NULL,original TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id));
CREATE TABLE IF NOT EXISTS locks(guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,channel_id));
CREATE TABLE IF NOT EXISTS badwords(guild_id TEXT NOT NULL,word TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,word));
CREATE TABLE IF NOT EXISTS protected_channels(guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,min_level INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,channel_id));
CREATE TABLE IF NOT EXISTS protected_roles(guild_id TEXT NOT NULL,role_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,role_id));
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY AUTOINCREMENT,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,creator_id TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,closed_at INTEGER);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,label TEXT NOT NULL,amount INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS prices(guild_id TEXT NOT NULL,key TEXT NOT NULL,label TEXT NOT NULL,amount INTEGER NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(guild_id,key));
CREATE TABLE IF NOT EXISTS subs(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,label TEXT NOT NULL,until INTEGER,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id,label));
CREATE TABLE IF NOT EXISTS contrib(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,amount INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id));
CREATE TABLE IF NOT EXISTS giveaways(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,message_id TEXT,prize TEXT NOT NULL,winners INTEGER NOT NULL DEFAULT 1,ends_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_by TEXT NOT NULL,entries TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS mass_ops(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,actor_id TEXT NOT NULL,role_id TEXT NOT NULL,filter_id TEXT,targets TEXT NOT NULL,done TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS voices(guild_id TEXT NOT NULL,channel_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,private INTEGER NOT NULL DEFAULT 0,temporary INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,guild_id TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,target TEXT,data TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS emergency(guild_id TEXT PRIMARY KEY,active INTEGER NOT NULL DEFAULT 0,actor_id TEXT,reason TEXT,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_guild ON audit(guild_id,created_at);
CREATE INDEX IF NOT EXISTS idx_sanctions_target ON sanctions(guild_id,target_id);
CREATE INDEX IF NOT EXISTS idx_payments_guild ON payments(guild_id,status);
CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets(channel_id,status);
`);

// Colonnes ajoutées
for (const sql of [
  'ALTER TABLE tickets ADD COLUMN type TEXT',
  'ALTER TABLE tickets ADD COLUMN staff_id TEXT',
  'ALTER TABLE tickets ADD COLUMN reason TEXT',
  'ALTER TABLE tickets ADD COLUMN transcript TEXT',
  'ALTER TABLE payments ADD COLUMN method TEXT',
  'ALTER TABLE payments ADD COLUMN note TEXT',
  'ALTER TABLE payments ADD COLUMN actor_id TEXT',
  'ALTER TABLE bl ADD COLUMN reason TEXT',
  'ALTER TABLE bl ADD COLUMN actor_id TEXT',
  'ALTER TABLE prices ADD COLUMN description TEXT',
  'ALTER TABLE locks ADD COLUMN source TEXT',
  'ALTER TABLE protected_channels ADD COLUMN role_id TEXT',
  'ALTER TABLE giveaways ADD COLUMN role_id TEXT',
  'ALTER TABLE payments ADD COLUMN credited INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE payments ADD COLUMN seller_id TEXT',
]) {
  try {
    db.exec(sql);
  } catch {}
}

// Signal de changement
export const changes = new EventEmitter();
changes.setMaxListeners(20);

// Petits outils
export const now = () => Date.now();
export const parse = (v, fallback = {}) => {
  try {
    return JSON.parse(v) ?? fallback;
  } catch {
    return fallback;
  }
};
export const json = (v) => JSON.stringify(v ?? {});
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const idOf = (x) => {
  const id = String(x ?? '').replace(/[<@!#&>\s]/g, '');
  return /^\d{17,20}$/.test(id) ? id : null;
};
export const clip = (v, n) => {
  const t = String(v ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
export const plural = (n, word, many = `${word}s`) => `${n} ${n > 1 ? many : word}`;
export const money = (cents, cur = '€') => {
  const v = (Number(cents) || 0) / 100;
  return `${v.toLocaleString('fr-FR', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })} ${cur}`;
};
export const toCents = (v) => {
  const n = Number(
    String(v ?? '')
      .replace(',', '.')
      .replace(/[^\d.]/g, ''),
  );
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
export function duration(v) {
  const m = String(v ?? '')
    .trim()
    .match(/^(\d+)\s*(s|m|min|h|j|d)$/i);
  if (!m) return null;
  const unit = { s: 1e3, m: 6e4, min: 6e4, h: 36e5, j: 864e5, d: 864e5 }[m[2].toLowerCase()];
  return Number(m[1]) * unit;
}

// Minuteurs
const timers = [];
export function every(ms, fn) {
  const t = setInterval(
    () =>
      Promise.resolve()
        .then(fn)
        .catch((e) => console.error('[tâche]', e?.message || e)),
    ms,
  );
  t.unref?.();
  timers.push(t);
  return t;
}
export function stopTimers() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

// Configuration serveur
export const DEFAULT = {
  theme: { color: '#5865F2', preset: null },
  logGuild: null,
  stats: { voice: false, category: null, channels: {} },
  ticket: { categoryId: null, roles: {} },
  welcome: { channelId: null, text: 'Bienvenue {membre} sur **{serveur}** !', roleId: null },
  rules: { text: null, roleId: null },
  voice: { creatorId: null },
  payment: { methods: ['PayPal', 'Virement'], currency: '€' },
  texts: { explain: null, contrib: null },
  protect: { roles: true },
};
const cache = new Map();
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = b && v && typeof b === 'object' && typeof v === 'object' && !Array.isArray(b) && !Array.isArray(v) ? merge(b, v) : v;
  }
  return out;
}
export function cfg(gid) {
  const hit = cache.get(gid);
  if (hit) return hit;
  const row = db.prepare('SELECT data FROM guilds WHERE id=?').get(gid);
  const out = merge(structuredClone(DEFAULT), row ? parse(row.data) : {});
  cache.set(gid, out);
  return out;
}
export function setCfg(gid, fn) {
  const next = structuredClone(cfg(gid));
  fn(next);
  db.prepare('INSERT INTO guilds(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(gid, json(next));
  cache.set(gid, next);
  return next;
}

// Réglages ciblés
const SCOPES = ['GLOBAL', 'ROLE', 'WL', 'USER', 'COMMAND'];
export function settingSet(gid, scope, scopeId, key, value) {
  if (!SCOPES.includes(scope)) throw new Error('Portée inconnue.');
  db.prepare(
    'INSERT INTO settings(guild_id,scope,scope_id,key,value) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,scope,scope_id,key) DO UPDATE SET value=excluded.value',
  ).run(gid, scope, String(scopeId || '*'), key, json({ v: value }));
}
export function settingGet(gid, scope, scopeId, key) {
  const row = db
    .prepare('SELECT value FROM settings WHERE guild_id=? AND scope=? AND scope_id=? AND key=?')
    .get(gid, scope, String(scopeId || '*'), key);
  return row ? parse(row.value).v : undefined;
}
export function settingDel(gid, scope, scopeId, key) {
  db.prepare('DELETE FROM settings WHERE guild_id=? AND scope=? AND scope_id=? AND key=?').run(gid, scope, String(scopeId || '*'), key);
}

// Journal interne
export function audit(gid, actorId, action, target = null, data = null) {
  try {
    db.prepare('INSERT INTO audit(guild_id,actor_id,action,target,data,created_at) VALUES(?,?,?,?,?,?)').run(
      gid,
      String(actorId || 'système'),
      action,
      target ? String(target) : null,
      json(data),
      now(),
    );
  } catch {}
}

// Anti spam
const cooldowns = new Map();
export function cooldown(key, ms) {
  const until = cooldowns.get(key) || 0;
  if (until > now()) throw new Error(`Doucement, réessaie dans ${Math.ceil((until - now()) / 1000)} s.`);
  cooldowns.set(key, now() + ms);
  if (cooldowns.size > 5000) for (const [k, t] of cooldowns) if (t < now()) cooldowns.delete(k);
}
const windows = new Map();
export function burst(key, limit, windowMs) {
  const list = (windows.get(key) || []).filter((t) => t > now() - windowMs);
  list.push(now());
  windows.set(key, list);
  return list.length > limit;
}
export function resetBurst(key) {
  windows.delete(key);
}

// Ménage régulier
export function prune() {
  const month = now() - 30 * 864e5;
  for (const [sql, ...args] of [
    ['DELETE FROM audit WHERE created_at<?', month],
    ['DELETE FROM log_messages WHERE created_at<?', month],
    ["DELETE FROM mass_ops WHERE status<>'pending' AND created_at<?", now() - 7 * 864e5],
    ["DELETE FROM giveaways WHERE status='done' AND ends_at<?", month],
    ['DELETE FROM embeds WHERE updated_at<?', now() - 7 * 864e5],
    ['DELETE FROM subs WHERE until IS NOT NULL AND until<?', now()],
  ]) {
    try {
      db.prepare(sql).run(...args);
    } catch {}
  }
}

// Sauvegardes
export function backup(keep = 10) {
  const dir = path.join(DATA, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dream-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite'))
    .sort();
  for (const f of files.slice(0, -keep)) fs.rmSync(path.join(dir, f), { force: true });
  return { file: path.basename(file), count: Math.min(files.length, keep) };
}

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import play from '@iamtraction/play-dl';
import {
  Client, GatewayIntentBits, Partials, PermissionFlagsBits, PermissionsBitField, ChannelType, Options,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  Routes, REST, AttachmentBuilder, WebhookClient, AuditLogEvent, MessageFlags
} from 'discord.js';
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior,
  entersState
} from '@discordjs/voice';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });
const rawDb = new DatabaseSync(process.env.DATABASE_PATH || path.join(DATA, 'dream.sqlite'), { timeout: 5000, enableForeignKeyConstraints: true });
// Requetes en cache
const stmtCache = new Map();
const db = {
  exec(...args) { return rawDb.exec(...args); },
  prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) { stmt = rawDb.prepare(sql); stmtCache.set(sql, stmt); }
    return stmt;
  }
};
for (const pragma of [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA cache_size = -16000'
]) { try { db.exec(pragma); } catch {} }
function sqliteSelfTest() {
  const positional = db.prepare('SELECT ? AS value').get('dream-ok');
  if (positional?.value !== 'dream-ok') throw new Error('SQLite self-test positionnel échoué.');
  const named = db.prepare('SELECT :value AS value').get({ value: 'dream-ok' });
  if (named?.value !== 'dream-ok') throw new Error('SQLite self-test nommé échoué.');
}
sqliteSelfTest();
let txDepth = 0;
const transaction = (fn) => {
  const point = `sp${txDepth}`;
  db.exec(txDepth === 0 ? 'BEGIN' : `SAVEPOINT ${point}`);
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    db.exec(txDepth === 0 ? 'COMMIT' : `RELEASE ${point}`);
    return result;
  } catch (error) {
    txDepth--;
    try { db.exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${point}`); } catch {}
    throw error;
  }
};

db.exec(`
CREATE TABLE IF NOT EXISTS guilds(id TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wl(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,kind TEXT NOT NULL,level INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id,kind));
CREATE TABLE IF NOT EXISTS wl_cmd(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,command TEXT NOT NULL,allow INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id,command));
CREATE TABLE IF NOT EXISTS owners(user_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS role_meta(guild_id TEXT NOT NULL,role_id TEXT NOT NULL,type TEXT NOT NULL,owner_id TEXT,wl_level INTEGER NOT NULL,interaction INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(guild_id,role_id));
CREATE TABLE IF NOT EXISTS role_access(guild_id TEXT NOT NULL,role_id TEXT NOT NULL,user_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,role_id,user_id));
CREATE TABLE IF NOT EXISTS wl_role(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,grade TEXT NOT NULL,anchor_role_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id));
CREATE TABLE IF NOT EXISTS protected_roles(guild_id TEXT NOT NULL,role_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,role_id));
CREATE TABLE IF NOT EXISTS pv(guild_id TEXT NOT NULL,channel_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,level INTEGER NOT NULL,access_mode TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pv_access(guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,user_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,channel_id,user_id));
CREATE TABLE IF NOT EXISTS bl(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id,kind));
CREATE TABLE IF NOT EXISTS sanctions(id INTEGER PRIMARY KEY AUTOINCREMENT,guild_id TEXT NOT NULL,target_id TEXT NOT NULL,actor_id TEXT NOT NULL,type TEXT NOT NULL,reason TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending_sanctions(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,target_id TEXT NOT NULL,actor_id TEXT NOT NULL,type TEXT,reason TEXT NOT NULL,duration_ms INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS logs(guild_id TEXT NOT NULL,category TEXT NOT NULL,channel_id TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,category));
CREATE TABLE IF NOT EXISTS log_messages(guild_id TEXT NOT NULL,message_id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,category TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,actor_id TEXT,result TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY AUTOINCREMENT,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,creator_id TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,closed_at INTEGER);
CREATE TABLE IF NOT EXISTS messages(guild_id TEXT NOT NULL,message_id TEXT NOT NULL,channel_id TEXT NOT NULL,owner_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,message_id));
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,label TEXT NOT NULL,amount INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS prices(guild_id TEXT NOT NULL,key TEXT NOT NULL,label TEXT NOT NULL,amount INTEGER NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(guild_id,key));
CREATE TABLE IF NOT EXISTS locks(guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,channel_id));
CREATE TABLE IF NOT EXISTS dog(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id));
CREATE TABLE IF NOT EXISTS wet(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,level INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id));
CREATE TABLE IF NOT EXISTS stats(guild_id TEXT PRIMARY KEY,message_id TEXT,channel_id TEXT,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS user_ui(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,color TEXT,footer TEXT,image TEXT,banner TEXT,PRIMARY KEY(guild_id,user_id));
CREATE TABLE IF NOT EXISTS command_config(guild_id TEXT NOT NULL,command TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,visible INTEGER NOT NULL DEFAULT 1,channel_id TEXT,PRIMARY KEY(guild_id,command));
CREATE TABLE IF NOT EXISTS config_setup(guild_id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 1,completed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS custom_emojis(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,emoji_id TEXT PRIMARY KEY,emoji_name TEXT NOT NULL,source_url TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS custom_commands(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,command_name TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id,command_name));
CREATE TABLE IF NOT EXISTS custom_prefixes(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,prefix TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id),UNIQUE(guild_id,prefix));
CREATE TABLE IF NOT EXISTS custom_aliases(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,alias TEXT NOT NULL,target TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id,alias));
CREATE TABLE IF NOT EXISTS custom_emoji_cleanup(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,actor_id TEXT NOT NULL,keep_ids TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id));
CREATE TABLE IF NOT EXISTS music_queue(guild_id TEXT NOT NULL,position INTEGER NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,duration TEXT,provider TEXT,added_by TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,position));
CREATE TABLE IF NOT EXISTS bot_access(guild_id TEXT NOT NULL,bot_id TEXT NOT NULL,bot_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',inviter_id TEXT,server_owner_id TEXT,requested_at INTEGER NOT NULL,decided_at INTEGER,decided_by TEXT,invite_url TEXT,PRIMARY KEY(guild_id,bot_id));
CREATE TABLE IF NOT EXISTS custom_config(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,webhook_name TEXT,webhook_avatar TEXT,color TEXT,footer TEXT,private_voice_persist INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(guild_id,user_id));
`);

try { db.exec('ALTER TABLE pending_sanctions ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE locks ADD COLUMN source TEXT'); } catch {}

// Migrations legeres
for (const statement of [
  'ALTER TABLE custom_config ADD COLUMN personal_role_id TEXT',
  'ALTER TABLE custom_config ADD COLUMN personal_text_channel_id TEXT',
  'ALTER TABLE custom_config ADD COLUMN personal_voice_channel_id TEXT',
  'ALTER TABLE custom_config ADD COLUMN private_voice_active INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE custom_config ADD COLUMN webhook_id TEXT',
  'ALTER TABLE custom_config ADD COLUMN webhook_token TEXT'
]) { try { db.exec(statement); } catch {} }

db.exec(`
CREATE TABLE IF NOT EXISTS hierarchy(guild_id TEXT NOT NULL,name TEXT NOT NULL,level INTEGER NOT NULL,role_id TEXT,PRIMARY KEY(guild_id,name));
CREATE TABLE IF NOT EXISTS linked_roles(guild_id TEXT NOT NULL,role_id TEXT NOT NULL,name TEXT NOT NULL,level INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,role_id));
CREATE TABLE IF NOT EXISTS settings(guild_id TEXT NOT NULL,scope TEXT NOT NULL,scope_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(guild_id,scope,scope_id,key));
CREATE TABLE IF NOT EXISTS command_permissions(guild_id TEXT NOT NULL,command TEXT NOT NULL,min_level INTEGER NOT NULL DEFAULT 0,levels TEXT NOT NULL DEFAULT '[]',roles TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,command));
CREATE TABLE IF NOT EXISTS log_channels(guild_id TEXT NOT NULL,key TEXT NOT NULL,channel_id TEXT,category_id TEXT,mirror_id TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,key));
CREATE TABLE IF NOT EXISTS panels(guild_id TEXT NOT NULL,key TEXT NOT NULL,channel_id TEXT,message_id TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,key));
CREATE TABLE IF NOT EXISTS embeds(guild_id TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,key));
CREATE TABLE IF NOT EXISTS badwords(guild_id TEXT NOT NULL,word TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,word));
CREATE TABLE IF NOT EXISTS protected_channels(guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,min_level INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,channel_id));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,guild_id TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,target TEXT,data TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS emergency(guild_id TEXT PRIMARY KEY,active INTEGER NOT NULL DEFAULT 0,actor_id TEXT,reason TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS subs(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,label TEXT NOT NULL,until INTEGER,created_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id,label));
CREATE TABLE IF NOT EXISTS contrib(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,amount INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id));
CREATE TABLE IF NOT EXISTS giveaways(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,message_id TEXT,prize TEXT NOT NULL,winners INTEGER NOT NULL DEFAULT 1,ends_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_by TEXT NOT NULL,entries TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS mass_ops(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,actor_id TEXT NOT NULL,role_id TEXT NOT NULL,filter_id TEXT,targets TEXT NOT NULL,done TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_guild ON audit(guild_id,created_at);
CREATE INDEX IF NOT EXISTS idx_sanctions_target ON sanctions(guild_id,target_id);
CREATE INDEX IF NOT EXISTS idx_payments_guild ON payments(guild_id,status);
`);

for (const statement of [
  'ALTER TABLE tickets ADD COLUMN type TEXT',
  'ALTER TABLE tickets ADD COLUMN staff_id TEXT',
  'ALTER TABLE tickets ADD COLUMN reason TEXT',
  'ALTER TABLE tickets ADD COLUMN transcript TEXT',
  'ALTER TABLE payments ADD COLUMN method TEXT',
  'ALTER TABLE payments ADD COLUMN note TEXT',
  'ALTER TABLE payments ADD COLUMN actor_id TEXT',
  'ALTER TABLE bl ADD COLUMN reason TEXT',
  'ALTER TABLE bl ADD COLUMN actor_id TEXT',
  "ALTER TABLE command_permissions ADD COLUMN roles TEXT NOT NULL DEFAULT '[]'"
]) { try { db.exec(statement); } catch {} }

const timers = [];
const every = (ms, fn) => { const t = setInterval(fn, ms); timers.push(t); return t; };
const stopTimers = () => { for (const t of timers) clearInterval(t); timers.length = 0; };
const now = () => Date.now();
const parse = v => { try { return JSON.parse(v); } catch { return {}; } };
const json = v => JSON.stringify(v ?? {});
const ENV_OWNERS = new Set((process.env.OWNER_IDS || '').split(/[ ,;]+/).map(x => x.trim()).filter(Boolean));
const ownerIds = () => ENV_OWNERS;
let ownerSet = null;
const refreshOwners = () => { ownerSet = new Set([...ENV_OWNERS, ...db.prepare('SELECT user_id FROM owners').all().map(x => x.user_id)]); return ownerSet; };
for (const id of ENV_OWNERS) db.prepare('INSERT OR IGNORE INTO owners(user_id,created_at) VALUES(?,?)').run(id, now());
refreshOwners();

// ─────────────────────── Niveaux ───────────────────────
const HIERARCHY = [['SYS+',100],['SYS',90],['OWNER',80]];
const pvLabel = (gid, n) => n === 95 ? 'CUSTOM+' : levelLabel(gid, n);
const DEFAULT = {
  prefix: '=',
  prefixes: ['=','+','&','.','-'],
  ui: { color:'#5865F2', error:'#ED4245', ok:'#57F287', warn:'#FEE75C', footer:'DREAM', image:null, banner:null },
  logs: { auto:true, categories:['modération','accès','rôles','tickets','paiements','musique','système'] },
  stats: { auto:true, interval:10, channelId:null },
  roles: { protect:true, removeUnauthorized:true, interactionRoles:[], protectedMinLevel:0 },
  music: { enabled:true, volume:70, channelId:null },
  community: { welcome:true, welcomeChannelId:null, autoroles:[], reactionRoles:true, personalVoice:true },
  ticket: { categoryId:null, staffRoleId:null, types:[['sanction','Sanction'],['contribution','Contribution'],['bataillon','Bataillon Confirmé'],['autre','Autre']] },
  payment: { channelId:null, methods:['PayPal','Lydia','Virement'], currency:'€' },
  protectChannel: { channelId:null },
  automation: { health:5, backup:30 },
  configuration: { welcome:{enabled:true,channelId:null,template:'Bienvenue {member} !'}, channels:{auto:true}, logs:{global:true,ticket:true,moderator:true,access:true,roles:true,music:true,payment:true,system:true}, destinations:{}, commands:{}, ticketCategory:null, welcomeCategory:null }
};
const cfgCache = new Map();
const mergeDeep = (base, over) => {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    const b = out[k], o = over[k];
    out[k] = (b && o && typeof b === 'object' && typeof o === 'object' && !Array.isArray(b) && !Array.isArray(o)) ? mergeDeep(b, o) : o;
  }
  return out;
};
function cfg(gid) {
  const hit = cfgCache.get(gid);
  if (hit) return hit;
  const r = db.prepare('SELECT data FROM guilds WHERE id=?').get(gid);
  if (!r) db.prepare('INSERT OR IGNORE INTO guilds(id,data) VALUES(?,?)').run(gid, json(DEFAULT));
  const out = mergeDeep(structuredClone(DEFAULT), r ? parse(r.data) : {});
  cfgCache.set(gid, out);
  return out;
}
function setCfg(gid, fn) {
  const c = structuredClone(cfg(gid));
  fn(c);
  db.prepare('INSERT INTO guilds(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(gid, json(c));
  cfgCache.set(gid, c);
  return c;
}
function color(v,fallback) { return /^#[0-9A-Fa-f]{6}$/.test(String(v || '')) ? String(v) : fallback; }
function safeUrl(v) {
  const raw = String(v || '').trim();
  if (!raw || raw.length > 2000) return null;
  try { const u = new URL(raw); return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : null; }
  catch { return null; }
}
function imageUrl(v) {
  const u = safeUrl(v);
  if (!u) return null;
  return /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(u) || /(cdn|media)\.discordapp\.(com|net)/i.test(u) ? u : null;
}
const cleanId = x => String(x || '').replace(/[<@!#&>\s]/g, '').trim();
const clip = (v, n) => { const t = String(v ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const kv = pairs => pairs.filter(p => p && p[1] !== null && p[1] !== undefined && p[1] !== '').map(([k, v]) => `**${k}** · ${v}`).join('\n');
const bullets = lines => lines.filter(Boolean).map(l => `• ${l}`).join('\n');
const bar = (value, max, width = 12) => { const n = Math.max(0, Math.min(width, Math.round((Number(value) || 0) / Math.max(1, Number(max) || 1) * width))); return `${'▰'.repeat(n)}${'▱'.repeat(width - n)}`; };
const money = (cents, cur) => `${(Number(cents) || 0) / 100}${cur}`;
const when = ms => `<t:${Math.floor(Number(ms) / 1000)}:R>`;
function embed(gid, o={}) {
  const c=cfg(gid), e=new EmbedBuilder().setColor(color(o.color,c.ui.color));
  if(o.title)e.setTitle(clip(o.title,256));
  if(o.description)e.setDescription(clip(o.description,4096));
  const fields=(o.fields||[]).filter(f=>f&&f.name&&f.value!==undefined&&f.value!==null&&String(f.value).length).slice(0,25)
    .map(f=>({name:clip(f.name,256),value:clip(f.value,1024),inline:!!f.inline}));
  if(fields.length)e.addFields(fields);
  if(o.footer!==false)e.setFooter({text:clip(o.footer||c.ui.footer,2048)});
  if(o.author)e.setAuthor(typeof o.author==='string'?{name:clip(o.author,256)}:o.author);
  if(o.url)e.setURL(o.url);
  if(o.timestamp)e.setTimestamp(o.timestamp===true?new Date():o.timestamp);
  const thumb=safeUrl(o.thumbnail), pic=safeUrl(o.image);
  if(thumb)e.setThumbnail(thumb);
  if(pic)e.setImage(pic);
  return e;
}
function embedFor(gid,uid,o={}){const t=themeFor(gid,{uid,command:o.command});return embed(gid,{...o,color:o.color||t.color,footer:o.footer||t.footer,image:o.image||t.image||undefined});}
const row = (...x) => new ActionRowBuilder().addComponents(...x);
const btn = (id,label,style=ButtonStyle.Secondary,emoji=null) => { const b=new ButtonBuilder().setCustomId(id).setLabel(clip(label,80)).setStyle(style); if(emoji)b.setEmoji(emoji); return b; };
const sel = (id,placeholder,options) => {
  const list=(options||[]).slice(0,25).map(o=>({...o,label:clip(o.label,100),description:o.description?clip(o.description,100):undefined}));
  const m=new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(clip(placeholder,150));
  if(!list.length)return m.addOptions([{label:'Rien à afficher',value:'__vide'}]).setDisabled(true);
  return m.addOptions(list);
};
const userSel = id => new UserSelectMenuBuilder().setCustomId(id).setPlaceholder('Choisir un membre');
const roleSel = id => new RoleSelectMenuBuilder().setCustomId(id).setPlaceholder('Choisir un rôle');
const channelSel = (id,types=null) => { const x=new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder('Choisir un salon'); if(types) x.setChannelTypes(types); return x; };
function modal(id,title,fields) {
  const m=new ModalBuilder().setCustomId(id).setTitle(clip(title,45));
  for(const f of fields.slice(0,5)){
    const t=new TextInputBuilder().setCustomId(f.id).setLabel(clip(f.label,45)).setStyle(f.style||TextInputStyle.Short).setRequired(f.required ?? true);
    if(f.placeholder)t.setPlaceholder(clip(f.placeholder,100));
    if(f.value)t.setValue(clip(f.value,4000));
    m.addComponents(row(t));
  }
  return m;
}

// ─────────────────── Permissions ───────────────────
function globalOwner(uid) { return (ownerSet || refreshOwners()).has(uid); }
function rank(gid,uid) {
  if(globalOwner(uid)) return 999;
  const key=`${gid}:${uid}`, hit=rankCache.get(key);
  if(hit && hit.at>Date.now()-5000) return hit.value;
  const rows=db.prepare("SELECT level FROM wl WHERE guild_id=? AND user_id=? AND kind!='WLCUSTOMPLUS'").all(gid,uid);
  const wl=rows.length ? Math.max(...rows.map(x=>x.level)) : -1;
  const value=Math.max(wl,roleRank(gid,uid));
  rankCache.set(key,{value,at:Date.now()});
  return value;
}
function hasKind(gid,uid,kind) { return globalOwner(uid) || !!db.prepare('SELECT 1 FROM wl WHERE guild_id=? AND user_id=? AND kind=?').get(gid,uid,kind); }
function hasCustomPlus(gid,uid) { return globalOwner(uid) || hasKind(gid,uid,'WLCUSTOMPLUS'); }
const DEFAULT_PREFIXES = ['=','+','&','.','-'];
const RESERVED_PREFIXES = new Set(['/']);
function customPrefix(gid,uid){ return db.prepare('SELECT prefix FROM custom_prefixes WHERE guild_id=? AND user_id=?').get(gid,uid)?.prefix || null; }
function validCustomPrefix(v){ const p=String(v||'').trim(); return p.length>=1 && p.length<=4 && !/[\s\u0000-\u001F]/.test(p) && !RESERVED_PREFIXES.has(p) && !DEFAULT_PREFIXES.includes(p) && !p.startsWith('<') && !p.startsWith('@') && !p.startsWith('#'); }
function setCustomPrefix(gid,uid,prefix){ if(!validCustomPrefix(prefix)) throw new Error('Préfixe invalide. Utilise 1 à 4 caractères sans espace et pas "/".'); const conflict=db.prepare('SELECT user_id FROM custom_prefixes WHERE guild_id=? AND prefix=? AND user_id<>?').get(gid,prefix,uid); if(conflict)throw new Error('Ce préfixe est déjà utilisé par une autre personne sur ce serveur.'); db.prepare('INSERT INTO custom_prefixes(guild_id,user_id,prefix,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET prefix=excluded.prefix,updated_at=excluded.updated_at').run(gid,uid,prefix,now(),now()); }
function clearCustomScope(gid,uid){ db.prepare('DELETE FROM custom_prefixes WHERE guild_id=? AND user_id=?').run(gid,uid); db.prepare('DELETE FROM custom_commands WHERE guild_id=? AND user_id=?').run(gid,uid); db.prepare('DELETE FROM custom_aliases WHERE guild_id=? AND user_id=?').run(gid,uid); db.prepare('DELETE FROM custom_emoji_cleanup WHERE guild_id=? AND user_id=?').run(gid,uid); }
const PERSONAL_ALIAS_TARGETS=new Set(['dream','music','ticket','role','stats','prix','ui']);
function setPersonalAlias(gid,uid,alias,target){alias=String(alias||'').toLowerCase().replace(/[^a-z0-9_-]/g,'-').slice(0,32);target=String(target||'').toLowerCase();if(alias.length<2||!PERSONAL_ALIAS_TARGETS.has(target))throw new Error('Alias invalide ou fonction non autorisée.');if(DEFAULT_PREFIXES.some(p=>alias.startsWith(p)))throw new Error('Le nom ne doit pas commencer par un préfixe.');db.prepare('INSERT INTO custom_aliases(guild_id,user_id,alias,target,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,user_id,alias) DO UPDATE SET target=excluded.target,updated_at=excluded.updated_at').run(gid,uid,alias,target,now(),now());return alias;}
function pvRank(gid,uid) {
  if(globalOwner(uid)) return 999;
  const rows=db.prepare("SELECT level FROM wl WHERE guild_id=? AND user_id=? AND kind='WLPV'").all(gid,uid);
  let level=rows.length?Math.max(...rows.map(x=>x.level)):-1;
  if(hasKind(gid,uid,'WLCUSTOMPLUS')) level=Math.max(level,95);
  return level;
}
function hasPVAccess(gid,uid){ return globalOwner(uid) || hasKind(gid,uid,'WLPV') || hasCustomPlus(gid,uid); }
function customConfig(gid,uid){return db.prepare('SELECT * FROM custom_config WHERE guild_id=? AND user_id=?').get(gid,uid)||null;}
function ensureCustomConfig(gid,uid){db.prepare('INSERT OR IGNORE INTO custom_config(guild_id,user_id,webhook_name,webhook_avatar,color,footer,private_voice_persist) VALUES(?,?,?,?,?,?,?)').run(gid,uid,null,null,null,null,0);return customConfig(gid,uid);}
function customRoleId(gid,uid){return customConfig(gid,uid)?.personal_role_id||null;}
function customVoiceId(gid,uid){return customConfig(gid,uid)?.personal_voice_channel_id||null;}
function customTextId(gid,uid){return customConfig(gid,uid)?.personal_text_channel_id||null;}
function memberHasCustomRole(guild,uid,ownerId){const rid=customRoleId(guild.id,ownerId);return !!(rid&&guild.members.cache.get(uid)?.roles.cache.has(rid));}
function pvLevelForOwner(gid,uid){return pvRank(gid,uid);}
function customEmojiBase(user){let n=(user.username||user.globalName||'user').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9_]/g,'').toLowerCase();if(!n)n='user';if(/^\d/.test(n))n=`u${n}`;return n.slice(0,26);}
function customEmojiRows(gid,uid){return db.prepare('SELECT * FROM custom_emojis WHERE guild_id=? AND user_id=? ORDER BY created_at').all(gid,uid);}
function customEmojiName(guild,user,used){const base=customEmojiBase(user);for(let n=1;n<=10;n++){const name=`${base}${n}`.slice(0,32);if(!used.has(name)&&!guild.emojis.cache.some(e=>e.name===name))return name;}throw new Error('Les 10 noms d’emojis disponibles sont déjà utilisés.');}
async function customWebhook(guild,uid,channel){
  const c=ensureCustomConfig(guild.id,uid); if(!channel?.isTextBased()) return null;
  let id=c.webhook_id, token=c.webhook_token; let hook=id&&token?new WebhookClient({id,token}):null;
  if(hook) return hook;
  const hooks=await channel.fetchWebhooks().catch(()=>null); const existing=hooks?.find(w=>w.owner?.id===guild.client.user?.id&&w.name===`DREAM-CUSTOM-${uid}`);
  if(existing?.token){db.prepare('UPDATE custom_config SET webhook_id=?,webhook_token=? WHERE guild_id=? AND user_id=?').run(existing.id,existing.token,guild.id,uid);return new WebhookClient({id:existing.id,token:existing.token});}
  const created=await channel.createWebhook({name:`DREAM-CUSTOM-${uid}`}).catch(()=>null); if(!created?.token)return null;
  db.prepare('UPDATE custom_config SET webhook_id=?,webhook_token=? WHERE guild_id=? AND user_id=?').run(created.id,created.token,guild.id,uid); return new WebhookClient({id:created.id,token:created.token});
}
async function sendCustomPanel(guild,uid,channel,payload){
  const c=ensureCustomConfig(guild.id,uid); const hook=await customWebhook(guild,uid,channel); if(!hook) return null;
  const member=await guild.members.fetch(uid).catch(()=>null); const username=(c.webhook_name||member?.displayName||'CUSTOM+').slice(0,80); const avatar=c.webhook_avatar||member?.displayAvatarURL({extension:'png',size:128});
  return hook.send({username,avatarURL:avatar,embeds:[embedFor(guild.id,uid,payload)],allowedMentions:{parse:[]}}).catch(()=>null);
}
function customPlusDescription(gid,uid){const rows=customEmojiRows(gid,uid);const c=ensureCustomConfig(gid,uid);return `😀 **Emojis** ${rows.length}/10  •  🎨 **Webhook** ${c.webhook_name||'par défaut'}  •  🔒 **PV persistante** ${c.private_voice_persist?'ON':'OFF'}\n\nRôle perso • vocale perso • PV CUSTOM+ • configuration perso • raccourcis • panneaux.`;}
function can(gid,uid,cmd,minLevel=0,kind=null) {
  if(globalOwner(uid)) return true;
  if(kind && !hasKind(gid,uid,kind)) return false;
  return allowCmd(gid,uid,cmd,null,minLevel);
}
function botAccess(gid,botId){return db.prepare('SELECT * FROM bot_access WHERE guild_id=? AND bot_id=?').get(gid,botId)||null;}
function botAccepted(gid,botId){const x=botAccess(gid,botId);return !!x&&x.status==='accepted';}
function assertBotAccepted(gid,client){if(gid&&client?.user&&!botAccepted(gid,client.user.id))throw new Error('DREAM est en attente d’acceptation pour ce serveur.');}
const INVITE_PERMS={Commu:['ViewChannel','SendMessages','EmbedLinks','AttachFiles','ReadMessageHistory','ManageChannels','ManageRoles','Connect','Speak','ManageWebhooks'],Protect:['ViewChannel','SendMessages','EmbedLinks','AttachFiles','ReadMessageHistory','ManageChannels','ManageRoles','ManageMessages','KickMembers','BanMembers','ModerateMembers','ViewAuditLog','ManageWebhooks','ManageGuildExpressions','MoveMembers','MuteMembers','DeafenMembers','ManageNicknames']};
function oauthInvite(clientId,name='Protect'){const perms=PermissionsBitField.resolve(INVITE_PERMS[name]||INVITE_PERMS.Protect);return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${perms.toString()}`;}
const PERMISSION_LABELS={Administrator:'Administrateur',ViewAuditLog:'Voir le journal des audits',ManageGuild:'Gérer le serveur',ManageChannels:'Gérer les salons',ManageRoles:'Gérer les rôles',ManageWebhooks:'Gérer les webhooks',ManageMessages:'Gérer les messages',ManageThreads:'Gérer les fils',CreatePublicThreads:'Créer des fils publics',CreatePrivateThreads:'Créer des fils privés',SendMessages:'Envoyer des messages',EmbedLinks:'Intégrer des liens',AttachFiles:'Joindre des fichiers',ReadMessageHistory:'Lire l’historique',Connect:'Se connecter',Speak:'Parler',MuteMembers:'Rendre muet',DeafenMembers:'Rendre sourd',MoveMembers:'Déplacer les membres',KickMembers:'Expulser des membres',BanMembers:'Bannir des membres',ModerateMembers:'Modérer les membres',ManageGuildExpressions:'Gérer les expressions',ManageEmojisAndStickers:'Gérer les emojis et stickers',MentionEveryone:'Mentionner @everyone/@here',ManageNicknames:'Gérer les pseudos',ChangeNickname:'Changer son pseudo'};
const PERMISSION_KEYS=Object.keys(PermissionFlagsBits).filter(k=>typeof PermissionFlagsBits[k]==='bigint');
function permissionPanel(guild,key){const bit=PermissionFlagsBits[key];if(bit===undefined)return {title:'🔐 Permissions',description:'Permission inconnue.'};const roles=guild.roles.cache.filter(r=>r.id!==guild.id&&r.permissions.has(bit)).sort((a,b)=>b.position-a.position);const members=[...guild.members.cache.values()].filter(m=>!m.user.bot&&m.permissions.has(bit));return {title:`🔐 Permissions • ${PERMISSION_LABELS[key]||key}`,description:`**Rôles**\n${[...roles.values()].slice(0,12).map(r=>`${r} • ${r.members.size} membre${r.members.size>1?'s':''}`).join('\n')||'Aucun'}\n\n**Membres effectifs**\n${members.slice(0,12).map(m=>`<@${m.id}>`).join('\n')||'Aucun détecté dans le cache.'}${roles.size>12||members.length>12?'\n\n… liste abrégée.':''}`};}
function wlPanel(guild,kind='ALL'){const rows=db.prepare('SELECT * FROM wl WHERE guild_id=? ORDER BY level DESC,user_id').all(guild.id);const filtered=kind==='ALL'?rows:rows.filter(x=>x.kind===kind);return {title:'🛡️ WL • Serveur',description:`${filtered.slice(0,20).map(x=>`<@${x.user_id}> — **${levelLabel(guild.id,x.level)}** • ${x.kind}`).join('\n')||'Aucune WL enregistrée.'}${filtered.length>20?'\n\n… liste abrégée.':''}`};}
function botAccessPanel(guild){const rows=db.prepare('SELECT * FROM bot_access WHERE guild_id=? ORDER BY bot_name').all(guild.id);return {title:'🔗 DREAM • Accès bot',description:rows.map(x=>{const m=guild.members.cache.get(x.bot_id);const perms=m?.permissions?.toArray?.().slice(0,18).map(k=>PERMISSION_LABELS[k]||k).join(' • ')||'Permissions non disponibles';return `${x.status==='accepted'?'🟢':x.status==='rejected'?'🔴':'🟠'} **${x.bot_name}** • ${x.status}\nAjouté par : ${x.inviter_id?`<@${x.inviter_id}>`:'Inconnu'}\nOwner : ${x.server_owner_id?`<@${x.server_owner_id}>`:'Inconnu'}\nPermissions actuelles : ${perms}${x.invite_url?`\n[Réinviter](${x.invite_url})`:''}`;}).join('\n\n')||'Aucune intégration enregistrée.'};}
function requireAccess(gid,uid,cmd,minLevel=0,kind=null) {
  if(globalOwner(uid)) return true;
  if(kind && !hasKind(gid,uid,kind)) throw new Error('Accès WL spécifique requis pour cette commande.');
  if(!allowCmd(gid,uid,cmd,null,minLevel)) throw new Error('Accès refusé ou hiérarchie insuffisante.');
  return true;
}
function higher(gid,actor,target) { return rank(gid,actor)>rank(gid,target); }
function setWL(gid,uid,kind,level) { clearRankCache(gid,uid); db.prepare('INSERT INTO wl(guild_id,user_id,kind,level,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,user_id,kind) DO UPDATE SET level=excluded.level,updated_at=excluded.updated_at').run(gid,uid,kind,level,now(),now()); }
function delWL(gid,uid,kind=null) { clearRankCache(gid,uid); if(kind)db.prepare('DELETE FROM wl WHERE guild_id=? AND user_id=? AND kind=?').run(gid,uid,kind); else db.prepare('DELETE FROM wl WHERE guild_id=? AND user_id=?').run(gid,uid); }
const WL_ROLE_GRADES = { OWNER: 1, SYS: 2, 'SYS+': 3 };
function wlRole(gid, uid) { return db.prepare('SELECT * FROM wl_role WHERE guild_id=? AND user_id=?').get(gid, uid) || null; }
function setWLRole(gid, uid, grade, anchorRoleId) {
  db.prepare('INSERT INTO wl_role(guild_id,user_id,grade,anchor_role_id,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET grade=excluded.grade,anchor_role_id=excluded.anchor_role_id,updated_at=excluded.updated_at').run(gid,uid,grade,anchorRoleId||null,now(),now());
}
function canGrantWLRole(gid, actorId, targetGrade) {
  if(globalOwner(actorId)) return true;
  const r=rank(gid,actorId), sys=levelByName(gid,'SYS')??90;
  const need=levelByName(gid,targetGrade)??(targetGrade==='SYS+'?100:targetGrade==='SYS'?90:80);
  return r>=sys && r>=need;
}
function isProtectedRole(gid, role) {
  if(!role || !role.id || role.managed || role.id===role.guild?.id || role.id===gid) return true;
  if(db.prepare('SELECT 1 FROM protected_roles WHERE guild_id=? AND role_id=?').get(gid,role.id)) return true;
  const meta=db.prepare('SELECT * FROM role_meta WHERE guild_id=? AND role_id=?').get(gid,role.id);
  return !!(meta && meta.interaction===0 && meta.type==='PROTECTED');
}
function wlRoleCanManage(gid, uid, role) {
  if(globalOwner(uid)) return true;
  if(!role || role.managed || role.id===role.guild.id) return false;
  const cfgGuild=role.guild;
  const me=cfgGuild.members.me;
  if(!me || role.position>=me.roles.highest.position) return false;
  if(isProtectedRole(gid,role)) return false;
  const x=wlRole(gid,uid);
  if(!x) return false;
  const grade=WL_ROLE_GRADES[x.grade] || 0;
  if(grade===3) return role.position < me.roles.highest.position;
  const anchor=x.anchor_role_id ? cfgGuild.roles.cache.get(x.anchor_role_id) : null;
  if(!anchor || anchor.managed || anchor.id===cfgGuild.id) return false;
  return role.position <= anchor.position;
}
function wlRoleScopeDescription(gid,uid) {
  const x=wlRole(gid,uid); if(!x) return 'Aucune WL rôle.';
  if(x.grade==='SYS+') return 'Tous les rôles gérables sous le rôle le plus haut du bot, sauf les rôles protégés.';
  const anchor=x.anchor_role_id ? guilds.get(gid)?.roles.cache.get(x.anchor_role_id) : null;
  return anchor ? `Le rôle sélectionné ${anchor} et tous les rôles situés en dessous, sauf les rôles protégés.` : 'Rôle de référence non défini.';
}


// ────────────────────────── Logs ──────────────────────────
async function log(guild,category,title,description,actor=null,result='OK') {
  if(!guild)return null;
  const c=cfg(guild.id);
  if(LEGACY_LOG[category] && Array.isArray(c.logs.categories) && c.logs.categories.length && !c.logs.categories.includes(category)) return null;
  return logTo(guild,category,{title,description,actor,result});
}

const logDeleteLocks = new Set();
async function findMessageDeleteActor(guild, channelId, authorId=null, bulk=false) {
  if(!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
  const type = bulk ? AuditLogEvent.MessageBulkDelete : AuditLogEvent.MessageDelete;
  const audit = await guild.fetchAuditLogs({type, limit: 10}).catch(()=>null);
  if(!audit) return null;
  const cutoff = Date.now() - 15000;
  const entry = audit.entries.find(e => {
    if(e.createdTimestamp < cutoff) return false;
    if(e.extra?.channel?.id !== channelId) return false;
    if(bulk) return true;
    return !authorId || !e.target?.id || e.target.id === authorId;
  });
  return entry?.executor?.id || null;
}

async function restoreDeletedLog(message) {
  if(!message?.guild || !message.channelId || logDeleteLocks.has(message.id)) return;
  if(burstHit(message.guild.id,'logRestore',25,60000)) return;
  const rec = db.prepare('SELECT * FROM log_messages WHERE message_id=?').get(message.id);
  if(!rec) return;
  logDeleteLocks.add(message.id);
  try {
    const guild=message.guild;
    const actor=await findMessageDeleteActor(guild,rec.channel_id);
    const ping=actor ? `<@${actor}>` : 'Membre non identifié';
    const ch=guild.channels.cache.get(rec.channel_id) || await guild.channels.fetch(rec.channel_id).catch(()=>null);
    if(!ch?.isTextBased()) return;
    const attempt=await ch.send({
      embeds:[embed(guild.id,{
        title:'⚠️ Tentative de suppression',
        description:`Une tentative de suppression d’un message de logs a été détectée.\n\n**Auteur de la tentative :** ${ping}\n**Message concerné :** \`${message.id}\``,
        fields:[{name:'Action',value:'Le message de logs va être recréé automatiquement.',inline:false}]
      })],
      allowedMentions:{parse: actor ? ['users'] : []}
    }).catch(()=>null);
    if(attempt){
      db.prepare('INSERT OR REPLACE INTO log_messages(guild_id,message_id,channel_id,category,title,description,actor_id,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(guild.id,attempt.id,rec.channel_id,rec.category,'⚠️ Tentative de suppression',`Une tentative de suppression d’un message de logs a été détectée. Auteur : ${ping}. Message concerné : ${message.id}.`,actor||null,'ATTEMPT',now());
    }
    const recreated=await ch.send({
      embeds:[embed(guild.id,{title:rec.title,description:rec.description,fields:rec.actor_id?[{name:'Membre',value:`<@${rec.actor_id}>`,inline:true},{name:'Résultat',value:rec.result,inline:true}]:[]})],
      allowedMentions:{parse:[]},
      reason:'DREAM log auto-restoration'
    }).catch(()=>null);
    if(recreated){
      db.prepare('INSERT OR REPLACE INTO log_messages(guild_id,message_id,channel_id,category,title,description,actor_id,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(guild.id,recreated.id,rec.channel_id,rec.category,rec.title,rec.description,rec.actor_id||null,rec.result,now());
      db.prepare('DELETE FROM log_messages WHERE message_id=?').run(message.id);
    }
  } finally {
    setTimeout(()=>logDeleteLocks.delete(message.id),5000);
  }
}
async function ensureLogs(g) {
  return ensureLogTree(g);
}

async function restoreDeletedLogBulk(messages, channel) {
  if(!channel?.guild) return;
  const rows=[...messages].map(([,m])=>db.prepare('SELECT * FROM log_messages WHERE message_id=?').get(m.id)).filter(Boolean);
  if(!rows.length)return;
  const actor=await findMessageDeleteActor(channel.guild,channel.id,null,true);
  const ping=actor?`<@${actor}>`:'Membre non identifié';
  const attempt=await channel.send({embeds:[embed(channel.guild.id,{title:'⚠️ Tentative de suppression',description:`Une suppression en masse de messages de logs a été détectée.\n\n**Auteur de la tentative :** ${ping}\n**Messages concernés :** ${rows.length}`,fields:[{name:'Action',value:'Les messages de logs concernés sont recréés automatiquement.'}]})],allowedMentions:{parse:actor?['users']:[]}}).catch(()=>null);
  if(attempt)db.prepare('INSERT OR REPLACE INTO log_messages(guild_id,message_id,channel_id,category,title,description,actor_id,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(channel.guild.id,attempt.id,channel.id,rows[0].category,'⚠️ Tentative de suppression',`Suppression en masse détectée. Auteur : ${ping}. Messages concernés : ${rows.length}.`,actor||null,'ATTEMPT',now());
  for(const rec of rows){
    const recreated=await channel.send({embeds:[embed(channel.guild.id,{title:rec.title,description:rec.description,fields:rec.actor_id?[{name:'Membre',value:`<@${rec.actor_id}>`,inline:true},{name:'Résultat',value:rec.result,inline:true}]:[]})],allowedMentions:{parse:[]},reason:'DREAM bulk log auto-restoration'}).catch(()=>null);
    if(recreated)db.prepare('INSERT OR REPLACE INTO log_messages(guild_id,message_id,channel_id,category,title,description,actor_id,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(channel.guild.id,recreated.id,channel.id,rec.category,rec.title,rec.description,rec.actor_id||null,rec.result,now());
    db.prepare('DELETE FROM log_messages WHERE message_id=?').run(rec.message_id);
  }
}

function roleAllowed(gid,uid,role) {
  if(!role) return false;
  if(role.managed || role.id===role.guild.id) return true;
  if(isProtectedRole(gid,role)) return globalOwner(uid) || rank(gid,uid)>=Math.max(ownerLevel(gid),cfg(gid).roles.protectedMinLevel||0);
  const meta=db.prepare('SELECT * FROM role_meta WHERE guild_id=? AND role_id=?').get(gid,role.id);
  if(meta?.interaction===1) return true;
  if(meta?.type==='PERSONAL') return meta.owner_id===uid || !!db.prepare('SELECT 1 FROM role_access WHERE guild_id=? AND role_id=? AND user_id=?').get(gid,role.id,uid);
  if(!meta) return false;
  return rank(gid,uid)>=meta.wl_level;
}
function canTouchRole(gid,uid,role) {
  if(globalOwner(uid)) return !role?.managed && role?.id!==role?.guild?.id && !isProtectedRole(gid,role);
  if(!role || role.managed || role.id===role.guild.id) return false;
  const me=role.guild.members.me;
  if(!me || role.position>=me.roles.highest.position) return false;
  if(isProtectedRole(gid,role)) return false;
  const wl=wlRole(gid,uid);
  if(wl) return wlRoleCanManage(gid,uid,role);
  const meta=db.prepare('SELECT * FROM role_meta WHERE guild_id=? AND role_id=?').get(gid,role.id);
  if(meta?.type==='PERSONAL') return meta.owner_id===uid || !!db.prepare('SELECT 1 FROM role_access WHERE guild_id=? AND role_id=? AND user_id=?').get(gid,role.id,uid);
  return false;
}
async function protectMemberRoles(g,member){
  if(!member || !cfg(g.id).roles.protect)return;
  const additions=member.roles.cache.filter(r=>!r.managed && r.id!==g.id);
  for(const r of additions.values()){
    const meta=db.prepare('SELECT * FROM role_meta WHERE guild_id=? AND role_id=?').get(g.id,r.id);
    const protectedFlag=!!db.prepare('SELECT 1 FROM protected_roles WHERE guild_id=? AND role_id=?').get(g.id,r.id);
    if(!meta && !protectedFlag)continue;
    if(roleAllowed(g.id,member.id,r))continue;
    if(cfg(g.id).roles.removeUnauthorized) await member.roles.remove(r,'DREAM protection').catch(()=>{});
    await log(g,'rôles','Rôle protégé retiré',`<@${member.id}> a reçu ${r} sans accès autorisé.`,member.id,'Bloqué');
  }
}

// Passe complete
async function protectRoles(g){
  if(!cfg(g.id).roles.protect)return 0;
  const managed=new Set([
    ...db.prepare('SELECT role_id FROM protected_roles WHERE guild_id=?').all(g.id).map(x=>x.role_id),
    ...db.prepare('SELECT role_id FROM role_meta WHERE guild_id=?').all(g.id).map(x=>x.role_id)
  ]);
  if(!managed.size)return 0;
  let checked=0;
  for(const member of g.members.cache.values()){
    if(member.user.bot)continue;
    if(![...member.roles.cache.keys()].some(id=>managed.has(id)))continue;
    await protectMemberRoles(g,member);
    checked++;
  }
  return checked;
}

// ───────────────────── Sanctions ─────────────────────
const SANCTION_LABELS={WARN:'Avertissement',TIMEOUT:'Timeout',KICK:'Expulsion',BAN:'Bannissement'};
function sanctionLabel(type){return SANCTION_LABELS[type]||type;}
function sanctionPreview(gid,target,reason,type=null){return {title:'🛡️ DREAM • Sanction',description:`**Membre**
<@${target.id}>

**Action**
${type?`⚠️ ${sanctionLabel(type)}`:'Choisis une action'}

**Raison**
${reason||'—'}

${type?'Vérifie puis confirme.':'Aucune action ne sera appliquée avant ta confirmation.'}`};}
function createPendingSanction(gid,actor,target,reason,type=null){const id=`${gid}-${actor.id}-${target.id}-${now()}-${Math.random().toString(36).slice(2,8)}`;db.prepare('INSERT INTO pending_sanctions(id,guild_id,target_id,actor_id,type,reason,duration_ms,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,gid,target.id,actor.id,type,reason||'—',0,now(),now()+10*60*1000);return id;}
function getPendingSanction(id){const x=db.prepare('SELECT * FROM pending_sanctions WHERE id=?').get(id);if(!x)return null;if(x.expires_at<now()){db.prepare('DELETE FROM pending_sanctions WHERE id=?').run(id);return null;}return x;}
function clearPendingSanction(id){db.prepare('DELETE FROM pending_sanctions WHERE id=?').run(id);}
function sanctionActionRow(id){return row(sel(`sanction:type:${id}`,'Choisir la sanction',[{label:'Avertissement',value:'WARN',description:'Enregistrer un avertissement'},{label:'Timeout',value:'TIMEOUT',description:'Restreindre temporairement le membre'},{label:'Expulsion',value:'KICK',description:'Retirer le membre du serveur'},{label:'Bannissement',value:'BAN',description:'Bannir le membre'}]));}
function sanctionConfirmRows(id){return [row(btn(`sanction:confirm:${id}`,'Confirmer',ButtonStyle.Danger),btn(`sanction:cancel:${id}`,'Annuler',ButtonStyle.Secondary))];}
async function executeSanction(guild,actor,target,type,reason='—',durationMs=null){
  if(!higher(guild.id,actor.id,target.id))throw new Error('Tu ne peux pas agir sur une personne de niveau égal ou supérieur.');
  const r=rank(guild.id,actor.id), t=rank(guild.id,target.id); if(r<=t)throw new Error('Hiérarchie insuffisante.');
  if(type==='WARN'){}
  else if(type==='TIMEOUT'){if(!durationMs||durationMs<1000||durationMs>28*24*60*60*1000)throw new Error('Durée de timeout invalide.');await target.timeout(durationMs,`DREAM • ${reason}`);}
  else if(type==='KICK')await target.kick(`DREAM • ${reason}`);
  else if(type==='BAN')await target.ban({reason:`DREAM • ${reason}`});
  else throw new Error('Sanction inconnue.');
  db.prepare('INSERT INTO sanctions(guild_id,target_id,actor_id,type,reason,created_at) VALUES(?,?,?,?,?,?)').run(guild.id,target.id,actor.id,type,reason,now());
  await target.send({embeds:[embed(guild.id,{title:'⚠️ DREAM • Sanction',description:`Action : **${sanctionLabel(type)}**\nServeur : **${guild.name}**\nRaison : ${reason}${type==='TIMEOUT'?`\nDurée : **${Math.round(durationMs/60000)} min**`:''}`,color:cfg(guild.id).ui.warn})]}).catch(()=>{});
  await log(guild,'modération',`Sanction • ${sanctionLabel(type)}`,`<@${target.id}>\nRaison : ${reason}${type==='TIMEOUT'?`\nDurée : ${Math.round(durationMs/60000)} min`:''}`,actor.id);
}
async function requestSanction(ctx,target,reason='—',presetType=null,hidden=true){
  const gid=ctx.guild.id, actor=ctx.member||ctx.member;
  const id=createPendingSanction(gid,ctx.user?.id||ctx.author.id,target,reason,presetType);
  const payload={embeds:[embed(gid,sanctionPreview(gid,target,reason,presetType))],components:presetType?sanctionConfirmRows(id):[sanctionActionRow(id)],allowedMentions:{parse:[]}};
  if(ctx.reply)return ctx.reply(hidden?{...payload,flags:MessageFlags.Ephemeral}:payload);
  return ctx.channel.send(payload);
}

// ─────────────────────── Musique ───────────────────────
const MUSIC_COOKIE_DIR=path.join(ROOT,'cookies');
function readCookieFile(name){const file=path.join(MUSIC_COOKIE_DIR,name);try{const raw=fs.readFileSync(file,'utf8').trim();return raw||null;}catch{return null;}}
function loadMusicAuth(){
  fs.mkdirSync(MUSIC_COOKIE_DIR,{recursive:true});
  const youtube=readCookieFile('youtube.cookie');
  if(youtube){try{play.setToken({youtube:{cookie:youtube}});}catch{}}
  const soundcloudId=process.env.SOUNDCLOUD_CLIENT_ID?.trim();
  if(soundcloudId){try{play.setToken({soundcloud:{client_id:soundcloudId}});}catch{}}
  return {youtube:!!youtube,soundcloud:!!soundcloudId,spotify:!!readCookieFile('spotify.cookie'),deezer:!!readCookieFile('deezer.cookie'),freezer:!!readCookieFile('freezer.cookie')};
}
const MUSIC_AUTH=loadMusicAuth();
const MUSIC_PAGE_SIZE=25;
function httpJson(url,headers={}){return new Promise((resolve,reject)=>{https.get(url,{headers},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{const parsed=JSON.parse(data);if(res.statusCode>=200&&res.statusCode<300)resolve(parsed);else reject(new Error(`HTTP ${res.statusCode}`));}catch(e){reject(e);}});}).on('error',reject);});}
async function spotifyToken(){const id=process.env.SPOTIFY_CLIENT_ID?.trim(),secret=process.env.SPOTIFY_CLIENT_SECRET?.trim();if(!id||!secret)return null;const auth=Buffer.from(`${id}:${secret}`).toString('base64');return new Promise((resolve,reject)=>{const req=https.request('https://accounts.spotify.com/api/token',{method:'POST',headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength('grant_type=client_credentials')}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{const j=JSON.parse(d);resolve(j.access_token||null);}catch{resolve(null);}})});req.on('error',reject);req.write('grant_type=client_credentials');req.end();});}
function extractProviderId(url,provider){try{const u=new URL(url);const parts=u.pathname.split('/').filter(Boolean);if(provider==='Spotify'){const idx=parts.findIndex(x=>['playlist','album','track'].includes(x));return idx>=0?parts[idx+1]:null;}if(provider==='Deezer'){const m=u.pathname.match(/(?:playlist|album|track)\/(\d+)/i);return m?.[1]||null;}return null;}catch{return null;}}
function musicProvider(url){
  try{const h=new URL(url).hostname.replace(/^www\./,'').toLowerCase();if(h.includes('youtube')||h==='youtu.be')return 'YouTube';if(h.includes('soundcloud'))return 'SoundCloud';if(h.includes('spotify'))return 'Spotify';if(h.includes('deezer'))return 'Deezer';if(h.includes('freezer'))return 'Freezer';}catch{}
  return 'Lien';
}
function isPlaylistUrl(url){try{const u=new URL(url);return /youtube\.com|youtu\.be|soundcloud\.com|spotify\.com|deezer\.com/i.test(u.hostname) && /playlist|sets|album|artist|collection|mix/i.test(u.pathname+u.search);}catch{return false;}}
async function resolveMusicSingle(url){
  const provider=musicProvider(url);
  if(provider==='Spotify'||provider==='Deezer'||provider==='Freezer'){
    const info=await play.search(url,{limit:1}).catch(()=>[]); const hit=info?.[0];
    if(hit?.url)return {url:hit.url,title:hit.title||url,provider};
    throw new Error(`${provider} a été reconnu, mais aucun titre lisible n’a été trouvé.`);
  }
  if(provider==='YouTube'||provider==='SoundCloud'){
    const info=await play.video_info(url).catch(()=>null);
    if(info?.video_details?.url)return {url:info.video_details.url,title:info.video_details.title||url,provider,duration:info.video_details.durationRaw||'?'};
  }
  return {url,title:url,provider,duration:'?'};
}
async function resolveMusicInput(input){
  const url=input.trim();
  if(!isPlaylistUrl(url))return [await resolveMusicSingle(url)];
  const provider=musicProvider(url); const out=[];
  if(provider==='YouTube'&&typeof play.playlist==='function'){
    const pl=await play.playlist(url).catch(()=>null); const videos=pl?.all_videos?await pl.all_videos().catch(()=>[]):(pl?.videos||[]);
    for(const v of videos||[])if(v?.url)out.push({url:v.url,title:v.title||v.url,provider:'YouTube',duration:v.durationRaw||'?'});
  }else if(provider==='SoundCloud'&&typeof play.soundcloud==='function'){
    const sc=await play.soundcloud(url).catch(()=>null); const tracks=Array.isArray(sc)?sc:(sc?.tracks||[]);
    for(const v of tracks)if(v?.url)out.push({url:v.url,title:v.name||v.title||v.url,provider:'SoundCloud',duration:v.duration||'?'});
  }else if(provider==='Spotify'){
    const token=await spotifyToken().catch(()=>null); const id=extractProviderId(url,'Spotify');
    if(token&&id){
      let next=`https://api.spotify.com/v1/playlists/${id}/tracks?limit=100`;
      while(next){const data=await httpJson(next,{Authorization:`Bearer ${token}`});for(const it of data.items||[]){const t=it.track;if(t?.name){const q=`${t.name} ${(t.artists||[]).map(a=>a.name).join(' ')} audio`;const hit=(await play.search(q,{limit:1}).catch(()=>[]))?.[0];if(hit?.url)out.push({url:hit.url,title:t.name,provider:'Spotify',duration:t.duration_ms?`${Math.round(t.duration_ms/60000)}:${String(Math.floor(t.duration_ms/1000)%60).padStart(2,'0')}`:'?'});}}next=data.next||null;}
    }else return [await resolveMusicSingle(url)];
  }else if(provider==='Deezer'){
    const id=extractProviderId(url,'Deezer');
    if(id){
      let next=`https://api.deezer.com/playlist/${id}/tracks?limit=100`;
      while(next){const data=await httpJson(next);for(const t of data.data||[]){const q=`${t.title} ${t.artist?.name||''} audio`;const hit=(await play.search(q,{limit:1}).catch(()=>[]))?.[0];if(hit?.url)out.push({url:hit.url,title:t.title,provider:'Deezer',duration:t.duration?`${Math.floor(t.duration/60)}:${String(t.duration%60).padStart(2,'0')}`:'?'});}next=data.next||null;}
    }else return [await resolveMusicSingle(url)];
  }else return [await resolveMusicSingle(url)];
  if(!out.length)throw new Error('La playlist est vide, inaccessible ou aucun titre lisible n’a été trouvé.');
  return out;
}

const queues=new Map();
function qkey(gid){return gid;}
function queue(gid){if(!queues.has(gid))queues.set(gid,{items:[],index:0,connection:null,player:null,text:null,voice:null,volume:0.7,loading:false});return queues.get(gid);}
function saveMusicQueue(gid){const q=queue(gid);transaction(()=>{db.prepare('DELETE FROM music_queue WHERE guild_id=?').run(gid);const ins=db.prepare('INSERT INTO music_queue(guild_id,position,title,url,duration,provider,added_by,created_at) VALUES(?,?,?,?,?,?,?,?)');q.items.forEach((x,n)=>ins.run(gid,n,x.title||x.url,x.url,x.duration||'?',x.provider||'Lien',x.addedBy||null,x.createdAt||now()));});}
function restoreMusicQueue(gid){const q=queue(gid);if(q.items.length)return q;q.items=db.prepare('SELECT * FROM music_queue WHERE guild_id=? ORDER BY position').all(gid).map(x=>({url:x.url,title:x.title,duration:x.duration||'?',provider:x.provider||'Lien',addedBy:x.added_by||null,createdAt:x.created_at}));return q;}
async function playNext(gid,tries=0){
  const q=restoreMusicQueue(gid);
  if(q.loading||!q.items.length||!q.voice)return;
  if(!q.connection){q.loading=false;return;}
  if(tries>=5){q.loading=false;if(q.text)q.text.send({content:'⚠️ Trop d’échecs de lecture, file mise en pause.'}).catch(()=>{});return;}
  q.loading=true;
  const item=q.items[0];
  const skip=async(reason)=>{
    q.items.shift();saveMusicQueue(gid);q.loading=false;
    if(reason&&q.text)await q.text.send({content:`⚠️ Morceau ignoré : ${String(reason).slice(0,180)}`}).catch(()=>{});
    return playNext(gid,tries+1).catch(()=>{});
  };
  try{
    const stream=await play.stream(item.url,{quality:2});
    const resource=createAudioResource(stream.stream,{inputType:stream.type,inlineVolume:true});
    resource.volume?.setVolume(q.volume);
    if(!q.player)q.player=createAudioPlayer({behaviors:{noSubscriber:NoSubscriberBehavior.Pause}});
    q.connection.subscribe(q.player);
    q.player.removeAllListeners(AudioPlayerStatus.Idle);
    q.player.removeAllListeners('error');
    q.player.once(AudioPlayerStatus.Idle,()=>{q.items.shift();saveMusicQueue(gid);q.loading=false;playNext(gid).catch(()=>{});});
    q.player.once('error',err=>{skip(err?.message).catch(()=>{});});
    q.player.play(resource);
  }catch(e){ await skip(e?.message||e); }
}
async function addMusic(guild,member,input){const vc=member.voice.channel;if(!vc)throw new Error('Rejoins un vocal.');const entries=await resolveMusicInput(input);const q=restoreMusicQueue(guild.id);if(!q.connection){q.connection=joinVoiceChannel({channelId:vc.id,guildId:guild.id,adapterCreator:guild.voiceAdapterCreator,selfDeaf:true});q.voice=vc;q.text=null;q.connection.on(VoiceConnectionStatus.Disconnected,()=>{q.connection=null;});await entersState(q.connection,VoiceConnectionStatus.Ready,15_000);}for(const resolved of entries){let title=resolved.title||resolved.url;if(!resolved.duration||resolved.duration==='?'){const info=await play.video_info(resolved.url).catch(()=>null);title=info?.video_details?.title||title;resolved.duration=info?.video_details?.durationRaw||'?';}q.items.push({...resolved,title,addedBy:member.id,createdAt:now()});}saveMusicQueue(guild.id);await playNext(guild.id);return {count:entries.length,first:entries[0]?.title||input};}
function musicQueueEmbed(gid,page=1){const q=restoreMusicQueue(gid);const total=Math.max(1,Math.ceil(q.items.length/MUSIC_PAGE_SIZE));const p=Math.min(Math.max(1,page),total);const start=(p-1)*MUSIC_PAGE_SIZE;const items=q.items.slice(start,start+MUSIC_PAGE_SIZE);return {total,page:p,embed:embed(gid,{title:'🎵 DREAM • File musicale',description:items.length?items.map((x,n)=>`${start+n+1}. **${String(x.title).slice(0,80)}** • ${x.provider||'Lien'}`).join('\n'):`**File vide**\nAjoute une musique ou une playlist.`,footer:`Page ${p}/${total} • ${q.items.length} titre${q.items.length>1?'s':''}`})};}



// ───────────────────── Commandes ─────────────────────
const COMMAND_CATALOG = [
  ['dream','Centre DREAM','general'],['wl','Gestion WL','access'],['wl-role','WL rôle','roles'],['music','Musique','music'],['logs','Logs','logs'],['role','Gestion rôles','roles'],['ticket','Tickets','ticket'],['payment','Paiements','payment'],['message','Messages','messages'],['ui','Interface','general'],['stats','Statistiques','stats'],['role-acces','Accès rôle','roles'],['addrole','Ajouter rôle','roles'],['delrole','Retirer rôle','roles'],['dog-add','DOG +','access'],['dog-del','DOG -','access'],['wet-info','WET info','moderation'],['prix','Prix','payment'],['lock','Lock','moderation'],['unlock','Unlock','moderation'],['wet','WET','moderation'],['giveaways','Giveaways','community']
];
COMMAND_CATALOG.push(
  ['help','Aide','general'],['profil','Profil','general'],['setup','Mise en place','config'],
  ['tableaux','Tableaux','config'],['hierarchie','Hiérarchie','config'],['configuration','Configuration','config'],
  ['explain','Contribuer en bref','payment'],['contrib','Contribuer','payment'],
  ['perm','Tarifs rôles','payment'],['acces','Tarifs WL','payment'],['abo','Abonnements','payment'],
  ['protect','Salons réservés','moderation'],['add','Créditer','payment'],['del','Retirer un rôle','roles'],
  ['giveaway','Giveaway','community'],['smash','Smash or pass','community'],['wet','WET','moderation']
);
const COMMAND_LABEL = new Map(COMMAND_CATALOG.map(x=>[x[0],x[1]]));
const cmdConfigReady = new Set();
function ensureCommandConfig(gid){
  if(cmdConfigReady.has(gid))return;
  const ins=db.prepare('INSERT OR IGNORE INTO command_config(guild_id,command,active,visible,channel_id) VALUES(?,?,1,1,NULL)');
  transaction(()=>COMMAND_CATALOG.forEach(([n])=>ins.run(gid,n)));
  cmdConfigReady.add(gid);
}
function commandCfg(gid,cmd){ ensureCommandConfig(gid); return db.prepare('SELECT * FROM command_config WHERE guild_id=? AND command=?').get(gid,cmd); }
function setCommandCfg(gid,cmd,patch){
  ensureCommandConfig(gid); const x=commandCfg(gid,cmd); const active=patch.active==null?x.active:(patch.active?1:0); const visible=patch.visible==null?x.visible:(patch.visible?1:0); const channelId=patch.channelId===undefined?x.channel_id:patch.channelId;
  db.prepare('UPDATE command_config SET active=?,visible=?,channel_id=? WHERE guild_id=? AND command=?').run(active,visible,channelId||null,gid,cmd);
}
function configChannel(g,kind){
  const c=cfg(g.id); const map={global:c.configuration?.destinations?.global, ticket:c.configuration?.destinations?.ticket, moderator:c.configuration?.destinations?.moderator, welcome:c.configuration?.welcome?.channelId, giveaways:c.configuration?.destinations?.giveaways};
  const id=map[kind]; return id?g.channels.cache.get(id)||null:null;
}
async function sendFromCommu(g, payload, kind='global'){
  const ch=configChannel(g,kind)||configChannel(g,'global')||g.systemChannel;
  if(!ch)return null; return ch.send(payload).catch(()=>null);
}
async function autoSetup(g){
  if(!botAccepted(g.id,clients.two.user?.id))return;
  const c=cfg(g.id); if(c.configuration?.channels?.auto===false)return;
  const wanted=[['global','dream','🌙・dream'],['moderator','moderation','🛡️・moderation'],['ticket','tickets','🎫・tickets'],['giveaways','giveaways','🎁・giveaways'],['welcome','welcome','👋・welcome']];
  for(const [key,cat,name] of wanted){
    let id=c.configuration.destinations?.[key]||null; let ch=id?g.channels.cache.get(id):null;
    if(!ch && key==='welcome')ch=c.community.welcomeChannelId?g.channels.cache.get(c.community.welcomeChannelId):null;
    if(!ch)ch=await g.channels.create({name,type:ChannelType.GuildText,reason:'DREAM configuration auto setup'}).catch(()=>null);
    if(ch){ setCfg(g.id,x=>{x.configuration.destinations[key]=ch.id;if(key==='welcome')x.configuration.welcome.channelId=ch.id;}); }
  }
  await ensureLogs(g);
  const commuGuild=clients.one.guilds.cache.get(g.id);
  if(commuGuild){ const main=configChannel(commuGuild,'global')||commuGuild.systemChannel; if(main){ const existing=await main.messages.fetch({limit:20}).catch(()=>null); const found=existing?.find(x=>x.author.id===clients.one.user?.id && x.embeds?.[0]?.title?.includes('DREAM • Centre')); if(!found) await main.send({embeds:[embed(g.id,{title:'🌙 DREAM • Centre communautaire',description:'Le serveur est configuré. Utilise les panneaux ci-dessous pour accéder aux fonctions communautaires.'}),],components:[row(btn('dream:home','Ouvrir le centre',ButtonStyle.Primary))]}).catch(()=>{}); } }
}

async function publishConfiguredPanels(g){
  const cg=clients.one.guilds.cache.get(g.id); if(!cg)return;
  const targets=[
    ['ticket','🎫 DREAM • Tickets','Choisis directement le motif de ton ticket.'],
    ['giveaways','🎁 DREAM • Giveaways','Les giveaways configurés sur ce serveur seront publiés ici.'],
    ['global','🌙 DREAM • Centre','Le centre communautaire DREAM est disponible ici.']
  ];
  for(const [kind,title,description] of targets){ const ch=configChannel(cg,kind)||cg.systemChannel; if(!ch)continue; const recent=await ch.messages.fetch({limit:20}).catch(()=>null); const found=recent?.find(m=>m.author.id===clients.one.user?.id&&m.embeds?.[0]?.title===title); if(!found){const ticketRows=cfg(g.id).ticket.types.map(([v,l])=>btn(`ticket:open:${v}`,l,ButtonStyle.Secondary));const components=kind==='ticket'?[row(...ticketRows.slice(0,4))]:[row(btn(kind==='giveaways'?'dream:home':'dream:home',kind==='giveaways'?'Voir les concours':'Ouvrir le centre',ButtonStyle.Primary))];await ch.send({embeds:[embed(g.id,{title,description})],components}).catch(()=>{});} }
}

function configurationEmbed(g){
  ensureCommandConfig(g.id); const c=cfg(g.id), rows=db.prepare('SELECT * FROM command_config WHERE guild_id=? ORDER BY command').all(g.id);
  const active=rows.filter(x=>x.active).length, visible=rows.filter(x=>x.visible).length;
  const logs=Object.entries(c.configuration.logs||{}).filter(([,v])=>v).map(([k])=>k).join(' • ')||'Aucun';
  const dest=c.configuration.destinations||{};
  return embed(g.id,{title:'⚙️ DREAM • Configuration',description:[
    '**Centre de contrôle du serveur**',
    `🧩 **Commandes**  ${active}/${rows.length} actives • ${visible}/${rows.length} visibles`,
    `📍 **Salons**  ${Object.values(dest).filter(Boolean).length} configurés`,
    `📚 **Logs**  ${logs}`,
    `🎨 **UI**  ${c.ui.color} • ${c.ui.footer||'DREAM'}`,
    `👋 **Bienvenue**  ${c.configuration.welcome.enabled?'🟢 Activée':'🔴 Désactivée'}`,
    '',
    `🌙 **Commu** publie • 🛡️ **Protect** configure et protège`,
    `🔄 Réparation globale : **30 min** • mises à jour événementielles : **instantanées**`
  ].join('\n'),fields:[
    {name:'Global',value:dest.global?`<#${dest.global}>`:'—',inline:true},
    {name:'Modération',value:dest.moderator?`<#${dest.moderator}>`:'—',inline:true},
    {name:'Tickets',value:dest.ticket?`<#${dest.ticket}>`:'—',inline:true},
    {name:'Giveaways',value:dest.giveaways?`<#${dest.giveaways}>`:'—',inline:true},
    {name:'Bienvenue',value:c.configuration.welcome.channelId?`<#${c.configuration.welcome.channelId}>`:'—',inline:true}
  ]});
}
async function openCustomConfiguration(i){
  ensureCustomConfig(i.guildId,i.user.id);
  return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'✨ CUSTOM+ • Configuration personnelle',description:customPlusDescription(i.guildId,i.user.id),fields:[{name:'📋 Commandes personnelles',value:'Créer ou renommer uniquement les raccourcis autorisés.',inline:false},{name:'😀 Emojis personnels',value:'Ajouter jusqu’à 10 emojis au serveur, automatiquement nommés avec ton pseudo.',inline:false},{name:'🖼️ Panneaux',value:'Préparer tes affiches et contenus dans ton espace personnel et les destinations autorisées.',inline:false},{name:'🔊 Vocale',value:'Gérer ta vocale perso et, si ton niveau le permet, conserver sa confidentialité après ton départ.',inline:false}]})],components:[row(btn('custom:emojis','😀 Mes emojis'),btn('custom:commands','📋 Mes commandes')),row(btn('custom:prefix','⌨️ Mon préfixe'),btn('custom:appearance','🎨 Apparence')),row(btn('custom:voice','🔊 Ma vocale'),btn('custom:role','🎨 Mon rôle')),row(btn('configuration','Fermer'))],flags:MessageFlags.Ephemeral});
}
async function customEmojiPanel(i){
  const rows=customEmojiRows(i.guildId,i.user.id);
  const desc=rows.length?rows.map((x,n)=>`${n+1}. <:${x.emoji_name}:${x.emoji_id}> **${x.emoji_name}**`).join('\n'):'Aucun emoji personnel pour le moment.';
  return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'😀 CUSTOM+ • Mes emojis',description:`${desc}\n\n**Utilisation :** ${rows.length}/10\nLes emojis sont ajoutés au serveur par le bot : Nitro n’est pas nécessaire pour les utiliser ici.`})],components:[row(btn('custom:emoji:add','Ajouter un emoji',ButtonStyle.Primary),btn('custom:emoji:delete','Supprimer')),row(btn('custom:configuration','Retour'))],flags:MessageFlags.Ephemeral});
}
async function customCommandsPanel(i){
  const rows=db.prepare('SELECT * FROM custom_commands WHERE guild_id=? AND user_id=? ORDER BY command_name').all(i.guildId,i.user.id);
  const desc=rows.length?rows.map(x=>`• \`/${x.command_name}\` — ${x.active?'🟢 active':'🔴 inactive'} — ${x.kind}`).join('\n'):'Aucun raccourci personnel enregistré.';
  return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'📋 CUSTOM+ • Mes commandes',description:`${desc}\n\nLes raccourcis sont personnels, utilisables avec ton préfixe et limités aux fonctions prévues par DREAM.`})],components:[row(btn('custom:command:add','Créer un raccourci',ButtonStyle.Primary),btn('custom:alias','Renommer une commande')),row(btn('custom:prefix','Préfixe')),row(btn('custom:configuration','Retour'))],flags:MessageFlags.Ephemeral});
}
async function customAppearancePanel(i){const c=ensureCustomConfig(i.guildId,i.user.id);return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'🎨 CUSTOM+ • Apparence',description:`**Nom webhook :** ${c.webhook_name||'non configuré'}\n**Couleur :** ${c.color||cfg(i.guildId).ui.color}\n**Footer :** ${c.footer||cfg(i.guildId).ui.footer}\n\nLe vrai nom du bot Discord ne peut pas être modifié ici.`})],components:[row(btn('custom:appearance:name','Nom webhook'),btn('custom:appearance:color','Couleur')),row(btn('custom:appearance:footer','Footer'),btn('custom:configuration','Retour'))],flags:MessageFlags.Ephemeral});}
async function customRolePanel(i){
  if(!hasCustomPlus(i.guildId,i.user.id)) throw new Error('WL CUSTOM+ requise.');
  const c=ensureCustomConfig(i.guildId,i.user.id); const role=c.personal_role_id?i.guild.roles.cache.get(c.personal_role_id):null;
  if(!role) return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'🎨 CUSTOM+ • Mon rôle',description:'Ton rôle personnel n’est pas encore disponible. Le prochain refresh automatique tentera de le recréer.'})],flags:MessageFlags.Ephemeral});
  const access=db.prepare('SELECT user_id FROM role_access WHERE guild_id=? AND role_id=? ORDER BY created_at').all(i.guildId,role.id);
  return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'🎨 CUSTOM+ • Mon rôle',description:`**Rôle :** ${role}
**Position :** ${role.position}
**Accès personnalisés :** ${access.length}

Ce rôle reste limité à ton espace CUSTOM+ et ne peut pas devenir un rôle protégé ou dépasser la hiérarchie du bot.`})],components:[row(btn('custom:role:access','👥 Gérer les accès')),row(btn('custom:configuration','Retour'))],flags:MessageFlags.Ephemeral});
}

async function customVoicePanel(i){
  if(!hasCustomPlus(i.guildId,i.user.id)) throw new Error('WL CUSTOM+ requise.');
  const c=ensureCustomConfig(i.guildId,i.user.id);
  const level=pvRank(i.guildId,i.user.id);
  const voiceId=customVoiceId(i.guildId,i.user.id);
  const voice=voiceId?i.guild.channels.cache.get(voiceId):null;
  const canPersist=level>=95;
  const desc=[
    `**Vocale :** ${voice||'en cours de création'}`,
    `**Niveau PV :** ${level>=999?'OWNER GLOBAL':pvLabel(i.guildId,level)}`,
    `**Confidentialité actuelle :** ${c.private_voice_active?'🔒 Privée':'🟢 Publique'}`,
    `**Après ton départ :** ${c.private_voice_persist?'🔒 Reste privée':'↩️ Redevient publique'}`,
    `**Confidentialité persistante :** ${canPersist?(c.private_voice_persist?'🟢 Activée':'⚪ Désactivée'):'🔒 Non disponible'}`,
    '',
    'Tu peux gérer uniquement les membres présents dans ta propre vocale. Les actions ne s’appliquent jamais aux autres vocaux.',
    canPersist?'Tu peux aussi conserver la confidentialité après ton départ.':'La confidentialité cesse lorsque tu quittes la vocale.'
  ].join('\n');
  const components=[row(btn('custom:voice:privacy',c.private_voice_active?'🔓 Rendre publique':'🔒 Rendre privée',ButtonStyle.Primary),btn('custom:voice:access','👥 Gérer les accès')),row(btn('custom:voice:mute','🔇 Mute'),btn('custom:voice:kick','↩️ Déconnecter'))];
  if(canPersist) components.push(row(btn('custom:voice:persist',c.private_voice_persist?'↩️ Revenir au mode normal après départ':'🔒 Garder privée après mon départ',ButtonStyle.Secondary)));
  components.push(row(btn('custom:configuration','Retour')));
  return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'🔊 CUSTOM+ • Ma vocale',description:desc})],components,flags:MessageFlags.Ephemeral});
}

async function provisionCustomPlus(guild,uid){
  if(!hasCustomPlus(guild.id,uid)) return;
  const member=await guild.members.fetch(uid).catch(()=>null); if(!member)return;
  const c=ensureCustomConfig(guild.id,uid);
  let role=c.personal_role_id?guild.roles.cache.get(c.personal_role_id):null;
  if(!role){
    role=await guild.roles.create({name:`CUSTOM+ • ${member.displayName}`.slice(0,100),reason:'DREAM CUSTOM+ personal role'}).catch(()=>null);
    if(role){
      db.prepare('UPDATE custom_config SET personal_role_id=? WHERE guild_id=? AND user_id=?').run(role.id,guild.id,uid);
      db.prepare('INSERT OR REPLACE INTO role_meta(guild_id,role_id,type,owner_id,wl_level,interaction,data) VALUES(?,?,?,?,?,?,?)').run(guild.id,role.id,'PERSONAL',uid,95,0,json({customPlus:true}));
    }
  }
  if(role&&!member.roles.cache.has(role.id)) await member.roles.add(role,'DREAM CUSTOM+ personal role').catch(()=>{});
  let text=c.personal_text_channel_id?guild.channels.cache.get(c.personal_text_channel_id):null;
  if(!text){
    text=await guild.channels.create({name:`🎨・${customEmojiBase(member.user)}`.slice(0,100),type:ChannelType.GuildText,permissionOverwrites:[{id:guild.id,deny:[PermissionFlagsBits.ViewChannel]},{id:uid,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]}],reason:'DREAM CUSTOM+ personal space'}).catch(()=>null);
    if(text){db.prepare('UPDATE custom_config SET personal_text_channel_id=? WHERE guild_id=? AND user_id=?').run(text.id,guild.id,uid);if(role)await text.permissionOverwrites.edit(role,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true},'DREAM CUSTOM+ role access').catch(()=>{});}
  }
  let voice=c.personal_voice_channel_id?guild.channels.cache.get(c.personal_voice_channel_id):null;
  if(!voice){
    voice=await guild.channels.create({name:`🔊・${customEmojiBase(member.user)}`.slice(0,100),type:ChannelType.GuildVoice,permissionOverwrites:[{id:guild.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect]},{id:uid,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak]}],reason:'DREAM CUSTOM+ personal voice'}).catch(()=>null);
    if(voice){
      if(role)await voice.permissionOverwrites.edit(role,{ViewChannel:true,Connect:true,Speak:true},'DREAM CUSTOM+ role access').catch(()=>{});
      db.prepare('UPDATE custom_config SET personal_voice_channel_id=? WHERE guild_id=? AND user_id=?').run(voice.id,guild.id,uid);
    }
  }
  if(voice){
    const privateNow=!!ensureCustomConfig(guild.id,uid).private_voice_active;
    db.prepare('INSERT INTO pv(guild_id,channel_id,owner_id,level,access_mode,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET owner_id=excluded.owner_id,level=excluded.level,access_mode=excluded.access_mode').run(guild.id,voice.id,uid,Math.max(95,pvLevelForOwner(guild.id,uid)),privateNow?'DENY':'OPEN',now());
    await voice.permissionOverwrites.edit(guild.roles.everyone,{Connect:privateNow?false:null},'DREAM CUSTOM+ voice refresh').catch(()=>{});
    await voice.permissionOverwrites.edit(uid,{ViewChannel:true,Connect:true,Speak:true},'DREAM CUSTOM+ owner refresh').catch(()=>{});
    if(role)await voice.permissionOverwrites.edit(role,{ViewChannel:true,Connect:true,Speak:true},'DREAM CUSTOM+ role refresh').catch(()=>{});
  }
}


async function openConfiguration(i){
  if(hasCustomPlus(i.guildId,i.user.id) && rank(i.guildId,i.user.id)<(levelByName(i.guildId,'SYS')??90)) return openCustomConfiguration(i);
  requireAccess(i.guildId,i.user.id,'configuration',90);
  ensureCommandConfig(i.guildId);
  return i.reply({embeds:[configurationEmbed(i.guild)],components:[row(sel('config:section','Choisir ce que tu veux régler',[{label:'Installation',value:'install',description:'Catégories, salons, panneaux, réparation'},{label:'Commandes',value:'commands',description:'Activer, masquer, rediriger'},{label:'Salons',value:'channels',description:'Toutes les destinations'},{label:'Logs',value:'logs',description:'Catégories et destinations'},{label:'Permissions',value:'permissions',description:'Permissions et détenteurs'},{label:'WL',value:'wl',description:'WL interne et membres'},{label:'Accès bot',value:'access',description:'Accès DREAM de ce serveur'},{label:'Interface',value:'ui',description:'Couleurs et apparence'},{label:'Bienvenue',value:'welcome',description:'Catégorie, salon et message'}])),row(btn('config:apply','Tout installer',ButtonStyle.Primary),btn('config:status','État'))],flags:MessageFlags.Ephemeral});
}
async function configSection(i,v){if(v==='install')return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Installation',description:'DREAM peut créer ou réparer les catégories, salons, logs et panneaux manquants. Tu peux aussi tout choisir manuellement.'})],components:[row(btn('config:install:all','Tout installer',ButtonStyle.Primary),btn('config:install:preview','Prévisualiser')),row(btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});if(v==='commands')return configCommandPanel(i);if(v==='channels')return configChannelsPanel(i);if(v==='logs')return configLogsPanel(i);if(v==='permissions')return configPermissionsPanel(i);if(v==='wl')return configWLPanel(i);if(v==='access')return configAccessPanel(i);if(v==='ui')return configUI(i);if(v==='welcome')return configWelcome(i);return openConfiguration(i);}
async function configPermissionsPanel(i,page=0){const max=Math.ceil(PERMISSION_KEYS.length/25);const keys=PERMISSION_KEYS.slice(page*25,(page+1)*25);return i.reply({embeds:[embed(i.guildId,{title:`🔐 Permissions • Serveur (${page+1}/${max})`,description:'Choisis une permission pour voir les rôles et membres qui la possèdent. Toutes les permissions Discord sont couvertes.'})],components:[row(sel(`config:permission:${page}`,'Choisir une permission',keys.map(k=>({label:PERMISSION_LABELS[k]||k,value:k,description:k})))),row(btn(page>0?`config:permissionPage:${page-1}`:'config:permissionDisabledPrev','← Précédent'),btn(page<max-1?`config:permissionPage:${page+1}`:'config:permissionDisabledNext','Suivant →')),row(btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});}
async function configWLPanel(i){return i.reply({embeds:[embed(i.guildId,wlPanel(i.guild))],components:[row(sel('config:wl','Filtrer la WL',[{label:'Toute la WL',value:'ALL',description:'Tous les accès internes'},{label:'WL principale',value:'WLSYS',description:'Accès hiérarchiques'},{label:'WL rôle',value:'WLROLE',description:'Gestion des rôles'},{label:'WL PV',value:'WLPV',description:'Gestion des PV'},{label:'Protect',value:'WLPROTECT',description:'Accès Protect'},{label:'Paiements',value:'WLPAIEMENT',description:'Accès paiements'},{label:'CUSTOM+',value:'WLCUSTOMPLUS',description:'Espace CUSTOM+'}])),row(btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});}
async function configAccessPanel(i){return i.reply({embeds:[embed(i.guildId,botAccessPanel(i.guild))],components:[row(btn('config:access:refresh','Actualiser'),btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});}
async function configChannelsPanel(i){return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Salons • Serveur',description:'Chaque destination peut être choisie. Les catégories ticket et bienvenue sont séparées pour permettre un vrai setup propre.'})],components:[row(channelSel('config:channel:global')),row(channelSel('config:channel:moderator')),row(channelSel('config:channel:ticket')),row(channelSel('config:channel:giveaways')),row(channelSel('config:channel:welcome')),row(channelSel('config:category:ticket',[ChannelType.GuildCategory])),row(channelSel('config:category:welcome',[ChannelType.GuildCategory])),row(btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});}
async function configLogsPanel(i){const c=cfg(i.guildId);const vals=Object.entries(c.configuration.logs||{}).map(([k,v])=>({label:k,value:k,description:v?'Activé':'Désactivé'}));return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Logs • Serveur',description:'Active ou désactive chaque famille. DREAM répare les destinations supprimées.'})],components:[row(sel('config:log','Choisir un log',vals)),row(btn('config:repairlogs','Réparer maintenant',ButtonStyle.Primary),btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});}
async function configUI(i){const c=cfg(i.guildId);return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Interface',description:`Couleur : **${c.ui.color}**\nErreur : **${c.ui.error}**\nSuccès : **${c.ui.ok}**\nAvertissement : **${c.ui.warn}**\nFooter : **${c.ui.footer}**`})],components:[row(btn('config:color','Couleurs'),btn('config:footer','Footer')),row(btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});}
async function configWelcome(i){const c=cfg(i.guildId);return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Bienvenue',description:`**Statut** : ${c.configuration.welcome.enabled?'🟢 Activée':'🔴 Désactivée'}\n**Salon** : ${c.configuration.welcome.channelId?`<#${c.configuration.welcome.channelId}>`:'Non défini'}\n**Catégorie** : ${c.configuration.destinations?.welcomeCategory?`<#${c.configuration.destinations.welcomeCategory}>`:'Non définie'}\n**Message** : ${c.configuration.welcome.template}\n\nVariables : \`{member}\` • \`{server}\``})],components:[row(channelSel('config:channel:welcome')),row(channelSel('config:category:welcome',[ChannelType.GuildCategory])),row(btn('config:welcomeToggle',c.configuration.welcome.enabled?'Désactiver':'Activer'),btn('config:welcomeText','Modifier le texte')),row(btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});}
async function configStatus(i){return i.reply({embeds:[configurationEmbed(i.guild)],components:[row(btn('config:apply','Réparer / appliquer maintenant',ButtonStyle.Primary),btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});}

function statsText(g){
  const members=g.memberCount, bots=g.members.cache.filter(m=>m.user.bot).size, humans=Math.max(0,members-bots);
  const channels=g.channels.cache.size, roles=g.roles.cache.filter(r=>r.id!==g.id).size;
  return {members,bots,humans,channels,roles};
}
async function updateStats(g) {
  const c=cfg(g.id); if(!c.stats.auto)return;
  let ch=c.stats.channelId?g.channels.cache.get(c.stats.channelId):null;
  if(!ch){ ch=await g.channels.create({name:'📊・stats',type:ChannelType.GuildText,reason:'DREAM stats'}).catch(()=>null); if(!ch)return; setCfg(g.id,x=>x.stats.channelId=ch.id); }
  const s=statsText(g), old=db.prepare('SELECT message_id FROM stats WHERE guild_id=?').get(g.id); let msg=old?.message_id?await ch.messages.fetch(old.message_id).catch(()=>null):null;
  const e=embed(g.id,{title:'📊 DREAM • Statistiques',description:`Membres : **${s.members}**\nHumains : **${s.humans}**\nBots : **${s.bots}**\nSalons : **${s.channels}**\nRôles : **${s.roles}**`,image:c.ui.image||undefined});
  if(msg)await msg.edit({embeds:[e]}).catch(()=>{msg=null}); if(!msg)msg=await ch.send({embeds:[e]}).catch(()=>null);
  if(msg)db.prepare('INSERT INTO stats(guild_id,message_id,channel_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET message_id=excluded.message_id,channel_id=excluded.channel_id,updated_at=excluded.updated_at').run(g.id,msg.id,ch.id,now());
}

async function repairLocks(g){
  for(const x of db.prepare('SELECT * FROM locks WHERE guild_id=?').all(g.id)){const ch=g.channels.cache.get(x.channel_id);if(ch)await ch.permissionOverwrites.edit(g.roles.everyone,{SendMessages:false},'DREAM lock repair').catch(()=>{});}
}
async function refreshManagedMessages(g){
  const rows=db.prepare('SELECT * FROM messages WHERE guild_id=?').all(g.id);
  for(const rec of rows){
    try{
      const ch=await g.channels.fetch(rec.channel_id).catch(()=>null);
      if(!ch?.isTextBased())continue;
      const msg=await ch.messages.fetch(rec.message_id).catch(()=>null);
      if(!msg)continue;
      const payload=parse(rec.payload)||{};
      await msg.edit({embeds:[embedFor(g.id,rec.owner_id,payload)]}).catch(()=>{});
    }catch{}
  }
  await publishConfiguredPanels(g);
}

const instantRefreshTimers=new Map();
function scheduleInstantRefresh(g, reason='update'){
  if(!g || instantRefreshTimers.has(g.id))return;
  instantRefreshTimers.set(g.id,setTimeout(async()=>{
    instantRefreshTimers.delete(g.id);
    try{
      if(botAccepted(g.id,clients.two.user?.id)) await updateStats(g);
    }catch{}
  },1500));
}

async function welcomePanel(g){
  const d=cfg(g.id).configuration?.destinations||{};
  const ch=(d.global?g.channels.cache.get(d.global):null)||g.systemChannel;
  if(!ch?.isTextBased())return null;
  const tiers=tierRows(g.id).length;
  const logs=[...LOG_NAMES.keys()].filter(k=>logChannel(g,k)).length;
  return publishPanel(g,'accueil','🌙 DREAM · tableau de bord',
    [kv([['Échelle de rôles',tiers?`${tiers} rôle${tiers>1?'s':''}`:'à régler'],['Salons de logs',`${logs}/${LOG_NAMES.size}`]]),'','Tout se règle depuis les boutons ci-dessous.'].join('\n'),
    [row(btn('setup:run','Tout mettre en place',ButtonStyle.Primary),btn('setup:tiers','Régler la hiérarchie'),btn('setup:help','Voir les commandes'))],ch).catch(()=>null);
}
async function refreshGuild(g){
  if(!botAccepted(g.id,clients.two.user?.id))return;
  cfg(g.id);
  ensureCommandConfig(g.id);
  ensureHierarchy(g.id);
  syncLinkedLevels(g.id);
  await autoSetup(g);
  await ensureLogTree(g);
  await repairLocks(g);
  await updateStats(g);
  await refreshManagedMessages(g);
  for(const x of db.prepare("SELECT user_id FROM wl WHERE guild_id=? AND kind='WLCUSTOMPLUS'").all(g.id)) await provisionCustomPlus(g,x.user_id);
  await syncCustomCommands(g).catch(()=>{});
  for(const x of db.prepare('SELECT * FROM custom_emojis WHERE guild_id=?').all(g.id)){if(!g.emojis.cache.has(x.emoji_id))db.prepare('DELETE FROM custom_emojis WHERE guild_id=? AND emoji_id=?').run(g.id,x.emoji_id);}
  pruneHistory(g.id);
  await welcomePanel(g).catch(()=>{});
  await startupCheck(g).catch(()=>{});
  await refreshTables(g).catch(()=>{});
  pruneAudit();
}

async function backup(){
  const dir=path.join(DATA,'backups');fs.mkdirSync(dir,{recursive:true});
  const dest=path.join(dir,`dream-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`); try{fs.copyFileSync(process.env.DATABASE_PATH||path.join(DATA,'dream.sqlite'),dest);}catch{}
  const files=fs.readdirSync(dir).sort();for(const f of files.slice(0,-10))fs.rmSync(path.join(dir,f),{force:true});
  const last=Number(settingGet('global','GLOBAL','*','backup.loggedAt')||0);
  if(now()-last<24*60*60*1000)return;
  settingSet('global','GLOBAL','*','backup.loggedAt',now());
  for(const g of clients.two.guilds.cache.values()){
    if(!botAccepted(g.id,clients.two.user?.id))continue;
    await logTo(g,'backup',{title:'💾 Sauvegarde',description:kv([['Archives conservées',Math.min(files.length,10)],['Base',path.basename(process.env.DATABASE_PATH||'dream.sqlite')]]),mirror:false,result:'Quotidien'}).catch(()=>{});
  }
}

const cacheLimits={
  MessageManager:0,
  PresenceManager:0,
  ReactionManager:0,
  GuildMemberManager:{maxSize:500,keepOverLimit:m=>Boolean(m?.user?.bot)}
};
const clients={
  one:new Client({makeCache:Options.cacheWithLimits(cacheLimits),intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.GuildModeration],partials:[Partials.Channel,Partials.Message]}),
  two:new Client({makeCache:Options.cacheWithLimits(cacheLimits),intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.GuildModeration],partials:[Partials.Channel,Partials.Message]})
};
const guilds=new Map();

async function ownerPanel(m){
  const ids=db.prepare('SELECT user_id FROM owners ORDER BY created_at').all().map(x=>`<@${x.user_id}>`).join('\n')||'Aucun.';
  return m.reply({embeds:[embed(m.guild.id,{title:'👑 DREAM • Owners',description:ids,footer:'`.owner <id>` pour basculer un accès'})],allowedMentions:{parse:[]}});
}
async function openFAQ(i,topic='home'){const pages={home:['☑️ La FAQ DREAM','Choisis simplement ce que tu veux connaître.'],general:['📌 FAQ • Général','Serveur, fonctionnement et accès DREAM.'],tickets:['🎫 FAQ • Tickets','Création, catégories, fermeture et suivi.'],wl:['🛡️ FAQ • WL','Niveaux internes, droits et hiérarchie.'],bot:['🤖 FAQ • Bots','Commu, Protect et validation d’intégration.']};const [title,description]=pages[topic]||pages.home;const components=topic==='home'?[row(btn('faq:general','Général'),btn('faq:tickets','Tickets'),btn('faq:wl','WL'),btn('faq:bot','Bots'))]:[row(btn('faq:home','Retour FAQ'))];return i.reply({embeds:[embed(i.guildId,{title,description})],components,flags:MessageFlags.Ephemeral});}
// ────────────────────── Panneaux ──────────────────────
async function openDream(i,section='home'){
  const gid=i.guildId;
  const pages={
    home:['🏠 DREAM','Choisis ce que tu veux gérer.'],
    wl:['🔐 WL','Accès, grades, permissions et CUSTOM+.'],
    roles:['🎨 Rôles','Créer, gérer et protéger les rôles.'],
    vocal:['🔊 Vocal','PV, vocale perso et accès.'],
    music:['🎵 Musique',`Lecture et file illimitée • ${MUSIC_AUTH.youtube?'YouTube 🟢':'YouTube ⚪'} • ${MUSIC_AUTH.soundcloud?'SoundCloud 🟢':'SoundCloud ⚪'} • ${MUSIC_AUTH.spotify?'Spotify 🟢':'Spotify ⚪'} • ${MUSIC_AUTH.deezer?'Deezer 🟢':'Deezer ⚪'}`],
    server:['🛡️ Serveur','Logs, tickets, paiements et réglages.'],
    content:['📝 Contenu','Messages, panneaux et contenus du serveur.'],
    stats:['📊 Stats','Informations du serveur, mises à jour automatiquement.'],
    logs:['📚 Logs','Vérifier ou réparer les journaux.'],
    tickets:['🎫 Tickets','Ouvrir, fermer et réparer les tickets.'],
    payments:['💳 Paiements','Prix et suivi des paiements.'],
    messages:['📝 Messages','Créer, modifier ou convertir un message.'],
    settings:['⚙️ Réglages','Interface, communauté et automatisation.'],
    pv:['🔊 PV','Gérer la PV du vocal actuel.']
  };
  const [title,description]=pages[section]||pages.home;
  const e=embed(gid,{title,description});
  let components=[];
  if(section==='home')components=[row(btn('dream:wl','WL'),btn('dream:roles','Rôles'),btn('dream:vocal','Vocal'),btn('dream:music','Musique')),row(btn('dream:server','Serveur'),btn('dream:content','Contenu'),btn('dream:stats','Stats'))];
  if(section==='wl')components=[row(btn('wl:add','Ajouter'),btn('wl:list','Membres'),btn('wl:commands','Permissions'),btn('customplus:manage','CUSTOM+')),row(btn('dream:home','Retour'))];
  if(section==='roles')components=[row(btn('role:create','Créer'),btn('role:access','Accès'),btn('role:personal','Personnel')),row(btn('role:presets','Presets'),btn('role:protect','Protection'),btn('wlrole:panel','WL rôle')),row(btn('dream:home','Retour'))];
  if(section==='vocal')components=[row(btn('pv:create','Activer PV'),btn('pv:access','Accès'),btn('pv:info','Infos')),row(btn('dream:home','Retour'))];
  if(section==='music')components=[row(btn('music:add','Ajouter'),btn('music:queue','File'),btn('music:next','Suivant'),btn('music:stop','Stop')),row(btn('dream:home','Retour'))];
  if(section==='server')components=[row(btn('dream:logs','Logs'),btn('dream:tickets','Tickets'),btn('dream:payments','Paiements'),btn('dream:settings','Réglages')),row(btn('dream:home','Retour'))];
  if(section==='content')components=[row(btn('dream:messages','Messages'),btn('dream:settings','Panneaux'),btn('faq:home','FAQ')),row(btn('dream:home','Retour'))];
  if(section==='logs')components=[row(btn('logs:repair','Réparer'),btn('logs:toggle','Automatique')),row(btn('dream:server','Retour'))];
  if(section==='tickets')components=[row(btn('ticket:open','Ouvrir'),btn('ticket:close','Fermer ici'),btn('ticket:repair','Réparer')),row(btn('dream:server','Retour'))];
  if(section==='payments')components=[row(btn('pay:add','Ajouter'),btn('pay:list','Liste'),btn('pay:prices','Prix')),row(btn('dream:server','Retour'))];
  if(section==='messages')components=[row(btn('msg:create','Créer'),btn('msg:edit','Modifier'),btn('msg:v2','Convertir')),row(btn('dream:content','Retour'))];
  if(section==='settings')components=[row(btn('set:ui','Interface'),btn('set:community','Communauté'),btn('set:auto','Automatique')),row(btn('dream:server','Retour'))];
  if(section==='stats')components=[row(btn('stats:refresh','Actualiser'),btn('stats:auto','Automatique')),row(btn('dream:home','Retour'))];
  if(section==='pv')components=[row(btn('pv:create','Activer ici'),btn('pv:access','Accès'),btn('pv:info','Infos')),row(btn('dream:vocal','Retour'))];
  return i.reply({embeds:[e],components,flags:MessageFlags.Ephemeral});
}

async function handleButton(i){
  const gid=i.guildId;
  const [scope,action,extra,...rest]=i.customId.split(':');
  if(scope==='config'){
    requireAccess(i.guildId,i.user.id,'configuration',90);
    if(action==='section')return configSection(i,extra);
    if(action==='permissionPage'){const page=Number(extra||0);return configPermissionsPanel(i,Number.isFinite(page)&&page>=0?page:0);}
    if(action==='permissionDisabledPrev'||action==='permissionDisabledNext')return configPermissionsPanel(i,0);
    if(action==='access'&&extra==='refresh')return configAccessPanel(i);
    if(action==='apply'){await autoSetup(i.guild);await ensureLogs(i.guild);await repairLocks(i.guild);await protectRoles(i.guild);await updateStats(i.guild);await refreshManagedMessages(i.guild);return i.update({embeds:[configurationEmbed(i.guild)],components:[row(btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});}
    if(action==='install'&&extra==='all'){await autoSetup(i.guild);await ensureLogs(i.guild);return i.update({embeds:[configurationEmbed(i.guild)],components:[row(btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});}
    if(action==='install'&&extra==='preview'){const c=cfg(i.guildId);return i.reply({embeds:[embed(i.guildId,{title:'🔎 Installation • Aperçu',description:`Catégorie ticket : ${c.configuration.destinations?.ticketCategory?'définie':'à définir/créer'}\nSalon ticket : ${c.configuration.destinations?.ticket?'défini':'à définir/créer'}\nCatégorie bienvenue : ${c.configuration.destinations?.welcomeCategory?'définie':'à définir/créer'}\nSalon bienvenue : ${c.configuration.welcome.channelId?'défini':'à définir/créer'}`})],components:[row(btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});}
    if(action==='repairlogs'){await ensureLogs(i.guild);return i.reply({content:'✅ Logs vérifiés et réparés.',flags:MessageFlags.Ephemeral});}
  }

  if(scope==='faq'){return openFAQ(i,action==='home'?'home':action);}

  if(scope==='customcleanup'){
    if(!globalOwner(i.user.id)&&rank(i.guildId,i.user.id)<(levelByName(i.guildId,'SYS+')??100))throw new Error('Accès insuffisant.');
    const target=extra;const pending=db.prepare('SELECT * FROM custom_emoji_cleanup WHERE guild_id=? AND user_id=?').get(i.guildId,target);if(!pending)throw new Error('Cette demande n’est plus disponible.');
    if(action==='confirm'||action==='keepall'||action==='deleteall'){
      const keep=action==='keepall'?customEmojiRows(i.guildId,target).map(x=>x.emoji_id):(action==='deleteall'?parse('[]'):parse(pending.keep_ids));const keepSet=new Set(keep);const rows=customEmojiRows(i.guildId,target);
      for(const x of rows)if(!keepSet.has(x.emoji_id)){const e=i.guild.emojis.cache.get(x.emoji_id);if(e)await e.delete('CUSTOM+ removed - cleanup').catch(()=>{});db.prepare('DELETE FROM custom_emojis WHERE guild_id=? AND emoji_id=?').run(i.guildId,x.emoji_id);}
      db.prepare('DELETE FROM custom_emoji_cleanup WHERE guild_id=? AND user_id=?').run(i.guildId,target);
      return i.update({embeds:[embed(i.guildId,{title:'😀 Emojis traités',description:`<@${target}> : **${keepSet.size}** emoji${keepSet.size>1?'s':''} conservé${keepSet.size>1?'s':''}.`})],components:[]});
    }
  }

  if(i.customId==='configuration') return openConfiguration(i);
  if(scope==='customplus'&&action==='manage'){if(!globalOwner(i.user.id)&&rank(i.guildId,i.user.id)<(levelByName(i.guildId,'SYS+')??100))throw new Error('Seuls les Owner/SYS+ peuvent gérer CUSTOM+.');return i.reply({embeds:[embed(i.guildId,{title:'✨ CUSTOM+ • Attribution',description:'Sélectionne un membre pour activer ou retirer sa WL CUSTOM+.\n\nCUSTOM+ reste une WL spécialisée : elle ne donne pas les pouvoirs généraux de SYS+.'})],components:[row(userSel('customplus:user')),row(btn('dream:wl','Retour'))],flags:MessageFlags.Ephemeral});}
  if(scope==='custom'&&action==='configuration'&&extra===undefined) return openCustomConfiguration(i);
  if(scope==='custom'&&action==='emojis'&&extra===undefined) return customEmojiPanel(i);
  if(scope==='custom'&&action==='commands'&&extra===undefined) return customCommandsPanel(i);
  if(scope==='custom'&&action==='appearance'&&extra===undefined) return customAppearancePanel(i);
  if(scope==='custom'&&action==='voice'&&extra===undefined) return customVoicePanel(i);
  if(scope==='custom'&&action==='emoji'&&extra==='add'){ if(!hasCustomPlus(i.guildId,i.user.id)) throw new Error('WL CUSTOM+ requise.'); return i.showModal(modal('custom:emoji:add:modal','Ajouter un emoji',[{id:'url',label:'Lien direct vers PNG, JPG ou GIF',placeholder:'https://…'}])); }
  if(scope==='custom'&&action==='emoji'&&extra==='delete'){ const rows=customEmojiRows(i.guildId,i.user.id); if(!rows.length) throw new Error('Tu n’as aucun emoji personnel.'); return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'🗑️ CUSTOM+ • Supprimer un emoji',description:'Choisis l’emoji à retirer.'})],components:[row(sel('custom:emoji:remove','Choisir un emoji',rows.map(x=>({label:x.emoji_name,value:x.emoji_id}))))],flags:MessageFlags.Ephemeral}); }
  if(scope==='custom'&&action==='command'&&extra==='add'){ if(!hasCustomPlus(i.guildId,i.user.id)) throw new Error('WL CUSTOM+ requise.'); return i.showModal(modal('custom:command:add:modal','Créer un raccourci CUSTOM+',[{id:'name',label:'Nom de la commande',placeholder:'mes-prix'},{id:'kind',label:'Fonction autorisée',placeholder:'tarifs, réseaux, contact…'},{id:'content',label:'Contenu du panneau',style:TextInputStyle.Paragraph,placeholder:'Texte de ton panneau'}])); }
  if(scope==='custom'&&action==='prefix'){ if(!hasCustomPlus(i.guildId,i.user.id)) throw new Error('WL CUSTOM+ requise.'); return i.showModal(modal('custom:prefix:modal','Préfixe personnel',[{id:'prefix',label:'Ton préfixe (1 à 4 caractères)',placeholder:'!',value:customPrefix(i.guildId,i.user.id)||'!'}])); }
  if(scope==='custom'&&action==='alias'){ if(!hasCustomPlus(i.guildId,i.user.id)) throw new Error('WL CUSTOM+ requise.'); return i.showModal(modal('custom:alias:modal','Renommer une commande pour toi',[{id:'alias',label:'Nouveau nom',placeholder:'mes-stats'},{id:'target',label:'Commande existante',placeholder:'stats, music, ticket…'}])); }
  if(scope==='custom'&&action==='appearance'&&extra==='name') return i.showModal(modal('custom:appearance:name:modal','Nom du webhook',[{id:'name',label:'Nom affiché',placeholder:'Alex • Tarifs'}]));
  if(scope==='custom'&&action==='appearance'&&extra==='color') return i.showModal(modal('custom:appearance:color:modal','Couleur personnelle',[{id:'color',label:'Couleur #RRGGBB',placeholder:'#5865F2'}]));
  if(scope==='custom'&&action==='appearance'&&extra==='footer') return i.showModal(modal('custom:appearance:footer:modal','Footer personnel',[{id:'footer',label:'Footer',placeholder:'Alex • DREAM'}]));
  if(scope==='custom'&&action==='role'&&extra===undefined) return customRolePanel(i);
  if(scope==='custom'&&action==='role'&&extra==='access'){
    if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');
    const rid=customRoleId(i.guildId,i.user.id); if(!rid)throw new Error('Rôle personnel introuvable.');
    return i.showModal(modal(`custom:role:access:modal:${rid}`,'Accès du rôle personnel',[{id:'user',label:'ID, mention ou nom',required:false,placeholder:'Laisser vide pour afficher les accès'}]));
  }
  if(scope==='custom'&&action==='voice'&&extra===undefined)return customVoicePanel(i);
  if(scope==='custom'&&action==='voice'&&extra==='access'){
    if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');
    const vc=i.guild.channels.cache.get(customVoiceId(i.guildId,i.user.id)); if(!vc)throw new Error('Vocale personnelle introuvable.');
    return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'👥 CUSTOM+ • Accès vocal',description:'Ajoute ou retire un accès personnalisé à ta propre vocale.'})],components:[row(userSel('custom:voice:access:user')),row(btn('custom:voice','Retour'))],flags:MessageFlags.Ephemeral});
  }
  if(scope==='custom'&&action==='voice'&&extra==='mute'){
    if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');
    const vc=i.guild.channels.cache.get(customVoiceId(i.guildId,i.user.id)); if(!vc||!vc.members.size)throw new Error('Personne n’est actuellement dans ta vocale.');
    return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'🔇 CUSTOM+ • Mute',description:'Choisis un membre présent dans ta vocale.'})],components:[row(userSel('custom:voice:mute:user')),row(btn('custom:voice','Retour'))],flags:MessageFlags.Ephemeral});
  }
  if(scope==='custom'&&action==='voice'&&extra==='kick'){
    if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');
    const vc=i.guild.channels.cache.get(customVoiceId(i.guildId,i.user.id)); if(!vc||!vc.members.size)throw new Error('Personne n’est actuellement dans ta vocale.');
    return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'↩️ CUSTOM+ • Déconnexion',description:'Choisis un membre présent dans ta vocale.'})],components:[row(userSel('custom:voice:kick:user')),row(btn('custom:voice','Retour'))],flags:MessageFlags.Ephemeral});
  }
  if(scope==='custom'&&action==='voice'&&extra==='privacy'){
    if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');
    ensureCustomConfig(i.guildId,i.user.id); const c=customConfig(i.guildId,i.user.id); const vc=i.guild.channels.cache.get(customVoiceId(i.guildId,i.user.id)); if(!vc)throw new Error('Vocale personnelle introuvable.');
    const next=Number(!c.private_voice_active); db.prepare('UPDATE custom_config SET private_voice_active=? WHERE guild_id=? AND user_id=?').run(next,i.guildId,i.user.id);
    db.prepare('INSERT INTO pv(guild_id,channel_id,owner_id,level,access_mode,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET owner_id=excluded.owner_id,level=excluded.level,access_mode=excluded.access_mode').run(i.guildId,vc.id,i.user.id,Math.max(95,pvLevelForOwner(i.guildId,i.user.id)),next?'DENY':'OPEN',now());
    if(next){await vc.permissionOverwrites.edit(i.guild.roles.everyone,{Connect:false},'CUSTOM+ PV privée').catch(()=>{});await vc.permissionOverwrites.edit(i.user.id,{ViewChannel:true,Connect:true,Speak:true},'CUSTOM+ PV owner').catch(()=>{});}else{await vc.permissionOverwrites.edit(i.guild.roles.everyone,{Connect:null},'CUSTOM+ PV publique').catch(()=>{});}
    return customVoicePanel(i);
  }
  if(scope==='custom'&&action==='voice'&&extra==='persist'){
    if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');
    ensureCustomConfig(i.guildId,i.user.id); const c=customConfig(i.guildId,i.user.id); db.prepare('UPDATE custom_config SET private_voice_persist=? WHERE guild_id=? AND user_id=?').run(Number(!c.private_voice_persist),i.guildId,i.user.id); return customVoicePanel(i);
  }

  if(scope==='route'&&action==='send'){ const cmd=extra; const channelId=rest[0]; const ch=i.guild.channels.cache.get(channelId); if(!ch)throw new Error('Le salon configuré est introuvable.'); return i.update({content:`📍 Pour **/${cmd}**, le salon prévu est ${ch}. Ouvre ce salon puis relance la commande.`,embeds:[],components:[]}); }
  if(scope==='route'&&action==='here'){ return i.update({content:`ℹ️ **/${extra}** sera utilisée dans **${i.channel}** pour cette fois. La configuration du serveur reste inchangée.`,embeds:[],components:[]}); }
  if(scope==='config') {
    if(action==='commands') return configCommandPanel(i);
    if(action==='channels') return configChannelsPanel(i);
    if(action==='logs') return configLogsPanel(i);
    if(action==='ui') return configUI(i);
    if(action==='welcome') return configWelcome(i);
    if(action==='status') return configStatus(i);
    if(action==='apply'){ await autoSetup(i.guild); await ensureLogs(i.guild); return i.update({embeds:[configurationEmbed(i.guild)],components:[row(btn('config:commands','Commandes'),btn('config:channels','Salons auto'),btn('config:logs','Logs'),btn('config:ui','Couleurs')),row(btn('config:welcome','Bienvenue'),btn('config:apply','Tout installer'),btn('config:status','État'))]}); }
    if(action==='repairlogs'){ await ensureLogs(i.guild); return i.reply({content:'✅ Les logs ont été vérifiés et réparés.',flags:MessageFlags.Ephemeral}); }
    if(action==='welcomeToggle'){ setCfg(i.guildId,c=>c.configuration.welcome.enabled=!c.configuration.welcome.enabled); return configWelcome(i); }
    if(action==='welcomeText') return i.showModal(modal('config:welcomeText:modal','Message de bienvenue',[{id:'text',label:'Message',style:TextInputStyle.Paragraph,placeholder:'Bienvenue {member} !',value:cfg(i.guildId).configuration.welcome.template}]));
    if(action==='color') return i.showModal(modal('config:color:modal','Couleurs des embeds',[{id:'main',label:'Couleur principale',placeholder:'#5865F2',value:cfg(i.guildId).ui.color},{id:'error',label:'Couleur erreur',placeholder:'#ED4245',value:cfg(i.guildId).ui.error},{id:'ok',label:'Couleur succès',placeholder:'#57F287',value:cfg(i.guildId).ui.ok},{id:'warn',label:'Couleur avertissement',placeholder:'#FEE75C',value:cfg(i.guildId).ui.warn}]));
    if(action==='footer') return i.showModal(modal('config:footer:modal','Footer global',[{id:'footer',label:'Footer',placeholder:'DREAM',value:cfg(i.guildId).ui.footer}]));
  }
  if(scope==='dream')return openDream(i,action);
  if(scope==='wl'){
    requireAccess(i.guildId,i.user.id,'wl',50);
    if(action==='add')return i.reply({content:'Choisis le membre puis le niveau.',components:[row(userSel('wl:user')),row(sel('wl:level','Niveau',levelOptions(i.guildId)))],flags:MessageFlags.Ephemeral});
    if(action==='list'){const rows=db.prepare('SELECT * FROM wl WHERE guild_id=? ORDER BY level DESC').all(i.guildId);return i.reply({embeds:[embed(i.guildId,{title:'🔐 WL • Liste',description:rows.map(x=>`<@${x.user_id}> — **${levelLabel(gid,x.level)}** — ${x.kind}`).join('\n')||'Aucun accès.'})],flags:MessageFlags.Ephemeral});}
    if(action==='commands')return i.reply({embeds:[embed(i.guildId,{title:'🔐 WL • Commandes',description:'Les accès sont hiérarchiques et peuvent être affinés par utilisateur via la table de permissions.'})],flags:MessageFlags.Ephemeral});
  }
  if(scope==='wlrole'){
    if(action==='panel'){
      requireAccess(i.guildId,i.user.id,'wl-role',90);
      const mine=wlRole(i.guildId,i.user.id);
      return i.reply({embeds:[embed(i.guildId,{title:'🛡️ WL rôle',description:`La WL rôle est indépendante des rôles Discord.\n\n**Ton grade :** ${mine?.grade||'Aucun'}\n**Portée :** ${wlRoleScopeDescription(i.guildId,i.user.id)}\n\n**OWNER / SYS :** rôle sélectionné + tous les rôles en dessous.\n**SYS+ :** tous les rôles gérables sous le plus haut rôle du bot.\n**Exception :** un rôle protégé ne peut jamais être distribué par cette WL.`})],components:[row(btn('wlrole:assign','Attribuer / modifier'),btn('wlrole:list','Liste')),row(btn('dream:roles','Retour'))],flags:MessageFlags.Ephemeral});
    }
    if(action==='assign'){
      requireAccess(i.guildId,i.user.id,'wl-role',90);
      return i.reply({content:'Choisis le membre puis son grade. Le rôle de référence sera demandé seulement pour OWNER et SYS.',components:[row(userSel('wlrole:user'))],flags:MessageFlags.Ephemeral});
    }
    if(action==='list'){
      requireAccess(i.guildId,i.user.id,'wl-role',90);
      const rows=db.prepare("SELECT * FROM wl_role WHERE guild_id=? ORDER BY CASE grade WHEN 'SYS+' THEN 3 WHEN 'SYS' THEN 2 ELSE 1 END DESC, created_at").all(i.guildId);
      const description=rows.map(x=>{ const ref=x.anchor_role_id?`rôle de référence : <@&${x.anchor_role_id}>`:'tous les rôles gérables'; return `<@${x.user_id}> — **${x.grade}** — ${ref}`; }).join('\n') || 'Aucun membre configuré.';
      return i.reply({embeds:[embed(i.guildId,{title:'🛡️ WL rôle • Liste',description})],allowedMentions:{parse:[]},flags:MessageFlags.Ephemeral});
    }
  }
  if(scope==='role'){
    if(!globalOwner(i.user.id) && !wlRole(i.guildId,i.user.id)) throw new Error('WL rôle requise.');
    if(action==='create')return i.showModal(modal('role:create:modal','Créer un rôle',[{id:'name',label:'Nom du rôle',placeholder:'Ex : Dream • Premium'}]));
    if(action==='access')return i.reply({content:'Choisis le rôle.',components:[row(roleSel('role:access:role'))],flags:MessageFlags.Ephemeral});
    if(action==='personal')return i.showModal(modal('role:personal:modal','Rôle personnel',[{id:'name',label:'Nom du rôle',placeholder:'Mon rôle'}]));
    if(action==='presets')return i.reply({embeds:[embed(i.guildId,{title:'🎨 Presets',description:'4 presets prêts à l’emploi : Aurora, Sunset, Ocean, Lavender. Le rôle peut ensuite être modifié via le panneau couleur.'})],components:[row(sel('role:preset','Choisir un preset',[{label:'Aurora',value:'aurora'},{label:'Sunset',value:'sunset'},{label:'Ocean',value:'ocean'},{label:'Lavender',value:'lavender'}]))],flags:MessageFlags.Ephemeral});
    if(action==='protect'){
      requireAccess(i.guildId,i.user.id,'role-protect',90);
      return i.reply({content:'Choisis le rôle à protéger. Un rôle protégé ne pourra jamais être distribué par la WL rôle.',components:[row(roleSel('role:protect:select'))],flags:MessageFlags.Ephemeral});
    }
  }
  if(scope==='pv'){
    if(!hasPVAccess(i.guildId,i.user.id))throw new Error('WL PV ou CUSTOM+ requise.');
    if(action==='create'){const ch=i.member.voice.channel;if(!ch)throw new Error('Rejoins un vocal.');if(hasCustomPlus(i.guildId,i.user.id)&&!hasKind(i.guildId,i.user.id,'WLPV')&&customVoiceId(i.guildId,i.user.id)!==ch.id)throw new Error('CUSTOM+ gère uniquement sa vocale personnelle.');const old=db.prepare('SELECT * FROM pv WHERE channel_id=?').get(ch.id);if(old&&!higher(i.guildId,i.user.id,old.owner_id))throw new Error('Ce PV appartient à une hiérarchie supérieure.');const level=pvRank(i.guildId,i.user.id);if(level<0)throw new Error('WL PV requise.');db.prepare('INSERT INTO pv(guild_id,channel_id,owner_id,level,access_mode,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET owner_id=excluded.owner_id,level=excluded.level,access_mode=excluded.access_mode').run(i.guildId,ch.id,i.user.id,level,'DENY',now());await ch.permissionOverwrites.edit(i.guild.roles.everyone,{Connect:false},'DREAM PV').catch(()=>{});await ch.permissionOverwrites.edit(i.member,{Connect:true},'DREAM PV owner').catch(()=>{});return i.reply({content:`🔊 PV activée ici. Niveau : **${pvLabel(i.guildId,level)}**.`,flags:MessageFlags.Ephemeral});}
    if(action==='access')return i.showModal(modal('pv:access:modal','Accès PV',[{id:'user',label:'ID, mention ou nom',placeholder:'123456789...'}]));
    if(action==='info'){const x=db.prepare('SELECT * FROM pv WHERE guild_id=? AND channel_id=?').get(i.guildId,i.member.voice.channelId||'');return i.reply({embeds:[embed(i.guildId,{title:'🔊 PV • Infos',description:x?`Propriétaire : <@${x.owner_id}>\nNiveau : **${levelLabel(gid,x.level)}**\nAccès : **${x.access_mode}**`:'Aucun PV ici.'})],flags:MessageFlags.Ephemeral});}
  }
  if(scope==='music'&&action==='page'){
    const qv=musicQueueEmbed(i.guildId,Number(extra||1));
    return i.update({embeds:[qv.embed],components:[row(btn(`music:page:${Math.max(1,qv.page-1)}`,'◀️'),btn(`music:page:${Math.min(qv.total,qv.page+1)}`,'▶️')),row(btn('music:add','Ajouter'),btn('music:stop','Stop'))]});
  }
  if(scope==='music'){
    requireAccess(i.guildId,i.user.id,'music',0);
    const q=queue(i.guildId);
    if(action==='add')return i.showModal(modal('music:add:modal','Ajouter à la file',[{id:'url',label:'URL / playlist',placeholder:'YouTube, SoundCloud, Spotify, Deezer…'}]));
    if(action==='queue'){const qv=musicQueueEmbed(i.guildId,1);return i.reply({embeds:[qv.embed],components:[row(btn('music:page:1','◀️'),btn(`music:page:${Math.min(qv.total,2)}`,'▶️')),row(btn('music:add','Ajouter'),btn('music:stop','Stop'))],flags:MessageFlags.Ephemeral});}
    if(action==='next'){if(q.player)q.player.stop();return i.reply({content:'⏭️ Suivant.',flags:MessageFlags.Ephemeral});}
    if(action==='stop'){q.items=[];saveMusicQueue(i.guildId);q.player?.stop();q.connection?.destroy();q.connection=null;q.voice=null;return i.reply({content:'⏹️ Musique arrêtée.',flags:MessageFlags.Ephemeral});}
  }
  if(scope==='logs'){
    requireAccess(i.guildId,i.user.id,'logs',50);
    if(action==='repair'){await ensureLogs(i.guild);return i.reply({content:'✅ Logs vérifiés et réparés.',flags:MessageFlags.Ephemeral});}
    if(action==='toggle'){setCfg(i.guildId,c=>c.logs.auto=!c.logs.auto);return i.reply({content:`✅ Auto logs : **${cfg(i.guildId).logs.auto?'ON':'OFF'}**`,flags:MessageFlags.Ephemeral});}
  }
  if(scope==='ticket'){
    if(action==='open'){const type=extra||'autre';const typeLabel=(cfg(i.guildId).ticket.types.find(x=>x[0]===type)||['autre','Autre'])[1];const base=`ticket-${type}-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,90);const ch=await i.guild.channels.create({name:base,type:ChannelType.GuildText,parent:cfg(i.guildId).ticket.categoryId||cfg(i.guildId).configuration.destinations?.ticketCategory||undefined,permissionOverwrites:[{id:i.guild.id,deny:[PermissionFlagsBits.ViewChannel]},{id:i.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]}]});db.prepare('INSERT INTO tickets(guild_id,channel_id,creator_id,status,created_at) VALUES(?,?,?,?,?)').run(i.guildId,ch.id,i.user.id,'OPEN',now());await ch.send({embeds:[embed(i.guildId,{title:`🎫 Ticket • ${typeLabel}`,description:`Bienvenue ${i.user}.\n\nDécris ta demande ici.`})],components:[row(btn('ticket:close','Fermer',ButtonStyle.Danger))]});await log(i.guild,'tickets','Ticket ouvert',`${ch} • ${typeLabel} par <@${i.user.id}>`,i.user.id);return i.reply({content:`✅ ${ch}`,flags:MessageFlags.Ephemeral});}
    if(action==='close'){const t=db.prepare('SELECT * FROM tickets WHERE guild_id=? AND channel_id=? AND status=?').get(i.guildId,i.channelId,'OPEN');if(!t)throw new Error('Ce salon n’est pas un ticket ouvert.');if(t.creator_id!==i.user.id)requireAccess(i.guildId,i.user.id,'ticket-close',40,'WLTICKET');db.prepare('UPDATE tickets SET status=?,closed_at=? WHERE id=?').run('CLOSED',now(),t.id);await log(i.guild,'tickets','Ticket fermé',`Salon <#${i.channelId}>`,i.user.id);return i.reply({content:'🔒 Ticket fermé.',flags:MessageFlags.Ephemeral});}
    if(action==='repair'){for(const t of db.prepare('SELECT * FROM tickets WHERE guild_id=? AND status=?').all(i.guildId,'OPEN'))if(!i.guild.channels.cache.has(t.channel_id))db.prepare('UPDATE tickets SET status=?,closed_at=? WHERE id=?').run('CLOSED',now(),t.id);return i.reply({content:'✅ Tickets vérifiés.',flags:MessageFlags.Ephemeral});}
  }
  if(scope==='pay'){
    requireAccess(i.guildId,i.user.id,'payment',50,'WLPAIEMENT');
    if(action==='add')return i.showModal(modal('pay:add:modal','Ajouter un paiement',[{id:'user',label:'ID / mention',placeholder:'123...'},{id:'amount',label:'Montant',placeholder:'10.00'},{id:'label',label:'Libellé',placeholder:'Commande'},{id:'status',label:'Statut',placeholder:'PENDING / PAID / REFUSED'}]));
    if(action==='list'){const rows=db.prepare('SELECT * FROM payments WHERE guild_id=? ORDER BY created_at DESC LIMIT 20').all(i.guildId);return i.reply({embeds:[embed(i.guildId,{title:'💳 Paiements',description:rows.map(x=>`#${x.id} • <@${x.user_id}> • ${x.amount} ${cfg(i.guildId).payment.currency} • ${x.status}`).join('\n')||'Aucun paiement.'})],flags:MessageFlags.Ephemeral});}
    if(action==='prices')return i.reply({embeds:[embed(i.guildId,{title:'💳 Prix',description:(db.prepare('SELECT * FROM prices WHERE guild_id=? AND active=1 ORDER BY label').all(i.guildId).map(x=>`**${x.label}** — ${x.amount} ${cfg(i.guildId).payment.currency}`).join('\n')||'Aucun prix.')})],flags:MessageFlags.Ephemeral});
  }
  if(scope==='msg'){
    requireAccess(i.guildId,i.user.id,'message',50);
    if(action==='create')return i.showModal(modal('msg:create:modal','Créer un message',[{id:'channel',label:'ID du salon',placeholder:'123...'},{id:'title',label:'Titre',required:false},{id:'description',label:'Description',style:TextInputStyle.Paragraph},{id:'color',label:'Couleur #HEX',required:false,placeholder:'#5865F2'}]));
    if(action==='edit')return i.showModal(modal('msg:edit:modal','Modifier un message',[{id:'message',label:'ID du message',placeholder:'123...'},{id:'title',label:'Titre',required:false},{id:'description',label:'Description',style:TextInputStyle.Paragraph,required:false},{id:'color',label:'Couleur #HEX',required:false}]));
    if(action==='v2')return i.showModal(modal('msg:v2:modal','Convertir V1 → V2',[{id:'message',label:'ID du message',placeholder:'123...'}]));
  }
  if(scope==='set'){
    requireAccess(i.guildId,i.user.id,'ui',50);
    if(action==='ui'&&extra==='color')return i.showModal(modal('set:usercolor:modal','Couleur personnelle',[{id:'color',label:'Couleur #HEX',placeholder:'#5865F2'}]));
    if(action==='ui'&&extra==='footer')return i.showModal(modal('set:userfooter:modal','Footer personnel',[{id:'footer',label:'Footer',placeholder:'DREAM'}]));
    if(action==='ui')return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'⚙️ UI',description:`Couleur globale : **${cfg(i.guildId).ui.color}**\nFooter global : **${cfg(i.guildId).ui.footer}**\nTon override : ${db.prepare('SELECT 1 FROM user_ui WHERE guild_id=? AND user_id=?').get(i.guildId,i.user.id)?'activé':'aucun'}`})],components:[row(btn('set:ui:color','Couleur personnelle'),btn('set:ui:footer','Footer personnel'))],flags:MessageFlags.Ephemeral});
    if(action==='community')return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Communauté',description:`Bienvenue : **${cfg(i.guildId).community.welcome?'ON':'OFF'}**\nRôles auto : **${cfg(i.guildId).community.autoroles.length}**\nPV : **${cfg(i.guildId).community.personalVoice?'ON':'OFF'}**`})],flags:MessageFlags.Ephemeral});
    if(action==='auto')return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Automatisation',description:`Logs : **${cfg(i.guildId).logs.auto?'ON':'OFF'}**\nStats : **${cfg(i.guildId).stats.auto?'ON':'OFF'}**\nRéparation globale : toutes les 30 minutes + contrôles instantanés.`})],flags:MessageFlags.Ephemeral});
  }
  if(scope==='stats'){
    requireAccess(i.guildId,i.user.id,'stats',0);
    if(action==='refresh'){await updateStats(i.guild);return i.reply({content:'📊 Statistiques actualisées.',flags:MessageFlags.Ephemeral});}
    if(action==='auto'){setCfg(i.guildId,c=>c.stats.auto=!c.stats.auto);return i.reply({content:`📊 Auto stats : **${cfg(i.guildId).stats.auto?'ON':'OFF'}**`,flags:MessageFlags.Ephemeral});}
  }
}

async function handleSelect(i){
  const gid=i.guildId;
  const [scope,action,extra]=i.customId.split(':');
  if(scope==='config'){
    requireAccess(i.guildId,i.user.id,'configuration',90);
    if(action==='section')return configSection(i,i.values[0]);
    if(action==='permission'){const parts=i.customId.split(':');return i.reply({embeds:[embed(i.guildId,permissionPanel(i.guild,i.values[0]))],components:[row(btn(`config:permissionPage:${parts[2]||0}`,'Changer de page'),btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});}
    if(action==='wl')return i.update({embeds:[embed(i.guildId,wlPanel(i.guild,i.values[0]))],components:[row(btn('configuration','Retour'))],flags:MessageFlags.Ephemeral});
    if(action==='channel'){const k=extra,id=i.values[0];setCfg(i.guildId,c=>{c.configuration.destinations[k]=id;if(k==='welcome')c.configuration.welcome.channelId=id;});return i.reply({content:`✅ Salon ${k} enregistré : <#${id}>`,flags:MessageFlags.Ephemeral});}
    if(action==='category'){const k=extra,id=i.values[0];setCfg(i.guildId,c=>{c.configuration.destinations[k+'Category']=id;if(k==='ticket')c.ticket.categoryId=id;});return i.reply({content:`✅ Catégorie ${k} enregistrée : <#${id}>`,flags:MessageFlags.Ephemeral});}
    if(action==='log'){const k=i.values[0];setCfg(i.guildId,c=>c.configuration.logs[k]=!c.configuration.logs[k]);return i.reply({content:`✅ Log **${k}** ${cfg(i.guildId).configuration.logs[k]?'activé':'désactivé'}.`,flags:MessageFlags.Ephemeral});}
  }

  if(scope==='customcleanup'&&action==='keep'){
    if(!globalOwner(i.user.id)&&rank(i.guildId,i.user.id)<(levelByName(i.guildId,'SYS+')??100))throw new Error('Accès insuffisant.');
    const target=extra;const pending=db.prepare('SELECT * FROM custom_emoji_cleanup WHERE guild_id=? AND user_id=?').get(i.guildId,target);if(!pending)throw new Error('Cette demande n’est plus disponible.');
    db.prepare('UPDATE custom_emoji_cleanup SET keep_ids=?,actor_id=?,created_at=? WHERE guild_id=? AND user_id=?').run(json(i.values),i.user.id,now(),i.guildId,target);
    return i.update({embeds:[embed(i.guildId,{title:'😀 Choix enregistré',description:`**${i.values.length}** emoji${i.values.length>1?'s':''} seront conservés.`})],components:[row(btn(`customcleanup:confirm:${target}`,'Confirmer',ButtonStyle.Primary),btn(`customcleanup:deleteall:${target}`,'Tout supprimer',ButtonStyle.Danger))]});
  }

  if(scope==='config'&&action==='command'){ const cmd=i.values[0]; const x=commandCfg(i.guildId,cmd); return i.reply({embeds:[embed(i.guildId,{title:`⚙️ Configuration • /${cmd}`,description:`**Statut :** ${x.active?'🟢 Active':'🔴 Inactive'}
**Visibilité :** ${x.visible?'👁️ Visible':'🙈 Masquée'}
**Salon :** ${x.channel_id?`<#${x.channel_id}>`:'aucun salon imposé'}

Tu peux basculer chaque option ci-dessous.`})],components:[row(btn(`config:cmdactive:${cmd}`,x.active?'Désactiver':'Activer'),btn(`config:cmdvisible:${cmd}`,x.visible?'Masquer':'Afficher')),row(channelSel(`config:cmdchannel:${cmd}`)),row(btn('config:commands','Retour'))],flags:MessageFlags.Ephemeral}); }
  if(scope==='config'&&action==='cmdactive'){const cmd=extra;setCommandCfg(i.guildId,cmd,{active:!commandCfg(i.guildId,cmd).active});return i.reply({content:`✅ /${cmd} ${commandCfg(i.guildId,cmd).active?'activée':'désactivée'}.`,flags:MessageFlags.Ephemeral});}
  if(scope==='config'&&action==='cmdvisible'){const cmd=extra;setCommandCfg(i.guildId,cmd,{visible:!commandCfg(i.guildId,cmd).visible});return i.reply({content:`✅ /${cmd} ${commandCfg(i.guildId,cmd).visible?'visible':'masquée'}.`,flags:MessageFlags.Ephemeral});}
  if(scope==='config'&&action==='cmdchannel'){const cmd=extra;setCommandCfg(i.guildId,cmd,{channelId:i.values[0]});return i.reply({content:`✅ /${cmd} sera dirigée vers <#${i.values[0]}>.`,flags:MessageFlags.Ephemeral});}
  if(scope==='config'&&action==='global'&&extra==='channel'){setCfg(i.guildId,c=>c.configuration.destinations.global=i.values[0]);return i.reply({content:`✅ Salon global : <#${i.values[0]}>`,flags:MessageFlags.Ephemeral});}
  if(scope==='config'&&action==='moderator'&&extra==='channel'){setCfg(i.guildId,c=>c.configuration.destinations.moderator=i.values[0]);return i.reply({content:`✅ Salon modérateur : <#${i.values[0]}>`,flags:MessageFlags.Ephemeral});}
  if(scope==='config'&&action==='ticket'&&extra==='channel'){setCfg(i.guildId,c=>c.configuration.destinations.ticket=i.values[0]);return i.reply({content:`✅ Salon ticket : <#${i.values[0]}>`,flags:MessageFlags.Ephemeral});}
  if(scope==='config'&&action==='giveaways'&&extra==='channel'){setCfg(i.guildId,c=>c.configuration.destinations.giveaways=i.values[0]);return i.reply({content:`✅ Salon giveaways : <#${i.values[0]}>`,flags:MessageFlags.Ephemeral});}
  if(scope==='config'&&action==='log'){const key=i.values[0];setCfg(i.guildId,c=>{c.configuration.logs[key]=!c.configuration.logs[key]; const map={global:'système',ticket:'tickets',moderator:'modération',access:'accès',roles:'rôles',music:'musique',payment:'paiements',system:'système'}; const cat=map[key]; if(cat){const set=new Set(c.logs.categories); if(c.configuration.logs[key])set.add(cat); else set.delete(cat); c.logs.categories=[...set];}});return configLogsPanel(i);}

  if(scope==='custom'&&action==='voice'&&extra==='access'&&i.isUserSelectMenu()){
    const vc=i.guild.channels.cache.get(customVoiceId(i.guildId,i.user.id)); if(!vc)throw new Error('Vocale personnelle introuvable.'); const uid=i.values[0];
    if(uid===i.user.id)throw new Error('Tu es déjà propriétaire de ta vocale.');
    const ex=db.prepare('SELECT 1 FROM pv_access WHERE guild_id=? AND channel_id=? AND user_id=?').get(i.guildId,vc.id,uid);
    if(ex){db.prepare('DELETE FROM pv_access WHERE guild_id=? AND channel_id=? AND user_id=?').run(i.guildId,vc.id,uid);await vc.permissionOverwrites.edit(uid,{Connect:false},'CUSTOM+ access removed').catch(()=>{});}else{db.prepare('INSERT OR IGNORE INTO pv_access(guild_id,channel_id,user_id,created_at) VALUES(?,?,?,?)').run(i.guildId,vc.id,uid,now());await vc.permissionOverwrites.edit(uid,{ViewChannel:true,Connect:true},'CUSTOM+ access added').catch(()=>{});}
    return i.reply({content:ex?'✅ Accès vocal retiré.':'✅ Accès vocal ajouté.',flags:MessageFlags.Ephemeral});
  }
  if(scope==='custom'&&action==='voice'&&extra==='mute'&&i.isUserSelectMenu()){
    const vc=i.guild.channels.cache.get(customVoiceId(i.guildId,i.user.id)); const member=vc?.members.get(i.values[0]); if(!vc||!member)throw new Error('Ce membre n’est pas dans ta vocale.'); await member.voice.setMute(true,'CUSTOM+ mute').catch(()=>{throw new Error('Impossible de mute ce membre.');}); return i.reply({content:`🔇 <@${member.id}> a été mute dans ta vocale.`,flags:MessageFlags.Ephemeral});
  }
  if(scope==='custom'&&action==='voice'&&extra==='kick'&&i.isUserSelectMenu()){
    const vc=i.guild.channels.cache.get(customVoiceId(i.guildId,i.user.id)); const member=vc?.members.get(i.values[0]); if(!vc||!member)throw new Error('Ce membre n’est pas dans ta vocale.'); await member.voice.disconnect('CUSTOM+ disconnect').catch(()=>{throw new Error('Impossible de déconnecter ce membre.');}); return i.reply({content:`↩️ <@${member.id}> a été déconnecté de ta vocale.`,flags:MessageFlags.Ephemeral});
  }
  if(scope==='customplus'&&action==='user'){
    if(!globalOwner(i.user.id)&&rank(i.guildId,i.user.id)<(levelByName(i.guildId,'SYS+')??100))throw new Error('Seuls les Owner/SYS+ peuvent gérer CUSTOM+.');
    const uid=i.values[0];
    if(uid===i.user.id&&!globalOwner(i.user.id))throw new Error('SYS+ ne peut pas s’attribuer CUSTOM+ à lui-même.');
    const targetRank=rank(i.guildId,uid); if(!globalOwner(i.user.id)&&targetRank>=rank(i.guildId,i.user.id))throw new Error('Tu ne peux pas attribuer CUSTOM+ à une personne de niveau égal ou supérieur.');
    const ex=hasKind(i.guildId,uid,'WLCUSTOMPLUS');
    if(ex){
      db.prepare('DELETE FROM wl WHERE guild_id=? AND user_id=? AND kind=?').run(i.guildId,uid,'WLCUSTOMPLUS');
      clearCustomScope(i.guildId,uid);
      const c=customConfig(i.guildId,uid);
      if(c?.personal_voice_channel_id){db.prepare('DELETE FROM pv_access WHERE guild_id=? AND channel_id=?').run(i.guildId,c.personal_voice_channel_id);db.prepare('DELETE FROM pv WHERE guild_id=? AND channel_id=?').run(i.guildId,c.personal_voice_channel_id);const vc=i.guild.channels.cache.get(c.personal_voice_channel_id);if(vc)await vc.permissionOverwrites.edit(i.guild.roles.everyone,{Connect:null},'CUSTOM+ removed').catch(()=>{});}
      if(c?.personal_role_id){const member=await i.guild.members.fetch(uid).catch(()=>null);if(member)await member.roles.remove(c.personal_role_id,'CUSTOM+ removed').catch(()=>{});}
      const emojis=customEmojiRows(i.guildId,uid);
      if(emojis.length){db.prepare('INSERT INTO custom_emoji_cleanup(guild_id,user_id,actor_id,keep_ids,created_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET actor_id=excluded.actor_id,keep_ids=excluded.keep_ids,created_at=excluded.created_at').run(i.guildId,uid,i.user.id,json([]),now());return i.reply({embeds:[embed(i.guildId,{title:'✨ CUSTOM+ retirée',description:`<@${uid}> n’a plus CUSTOM+.\n\n**${emojis.length} emoji${emojis.length>1?'s':''}** restent associés à son espace. Choisis ceux à **garder**.`})],components:[row(new StringSelectMenuBuilder().setCustomId(`customcleanup:keep:${uid}`).setPlaceholder('Choisir les emojis à garder').setMinValues(0).setMaxValues(Math.min(10,emojis.length)).addOptions(emojis.map(x=>({label:x.emoji_name,value:x.emoji_id})))),row(btn(`customcleanup:deleteall:${uid}`,'Tout supprimer',ButtonStyle.Danger),btn(`customcleanup:keepall:${uid}`,'Tout garder',ButtonStyle.Success))],flags:MessageFlags.Ephemeral});}
      return i.reply({embeds:[embed(i.guildId,{title:'✨ CUSTOM+ retirée',description:`La WL CUSTOM+ de <@${uid}> a été retirée. Aucun emoji personnel à traiter.`})],flags:MessageFlags.Ephemeral});
    }
    setWL(i.guildId,uid,'WLCUSTOMPLUS',95); await provisionCustomPlus(i.guild,uid);
    return i.reply({embeds:[embed(i.guildId,{title:'✨ CUSTOM+ activée',description:`<@${uid}> possède maintenant **CUSTOM+**.\n\n• rôle personnel\n• salon personnel\n• vocale personnelle\n• PV niveau CUSTOM+\n• configuration personnelle\n• jusqu’à 10 emojis personnels`})],flags:MessageFlags.Ephemeral});
  }
  if(scope==='custom'&&action==='emoji'&&extra==='remove'){if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');const id=i.values[0];const rec=db.prepare('SELECT * FROM custom_emojis WHERE guild_id=? AND user_id=? AND emoji_id=?').get(i.guildId,i.user.id,id);if(!rec)throw new Error('Emoji introuvable.');const e=i.guild.emojis.cache.get(id);if(e)await e.delete('CUSTOM+ emoji removed').catch(()=>{});db.prepare('DELETE FROM custom_emojis WHERE guild_id=? AND user_id=? AND emoji_id=?').run(i.guildId,i.user.id,id);return customEmojiPanel(i);}
  if(scope==='role'&&action==='preset'){
    const presets={aurora:['#6EE7F2','#8B5CF6'],sunset:['#FF7A59','#FFB347'],ocean:['#00C6FF','#0072FF'],lavender:['#C084FC','#F0ABFC']};
    return i.reply({embeds:[embed(i.guildId,{title:'🎨 Preset choisi',description:`**${i.values[0]}**\nCouleurs : ${presets[i.values[0]].join(' → ')}`})],flags:MessageFlags.Ephemeral});
  }
  if(scope==='role'&&action==='protect'&&extra==='select'){
    requireAccess(i.guildId,i.user.id,'role-protect',90);
    const role=i.guild.roles.cache.get(i.values[0]);
    if(!role || role.managed || role.id===i.guild.id) throw new Error('Rôle invalide.');
    const ex=db.prepare('SELECT 1 FROM protected_roles WHERE guild_id=? AND role_id=?').get(i.guildId,role.id);
    if(ex) db.prepare('DELETE FROM protected_roles WHERE guild_id=? AND role_id=?').run(i.guildId,role.id);
    else db.prepare('INSERT INTO protected_roles(guild_id,role_id,created_at) VALUES(?,?,?)').run(i.guildId,role.id,now());
    return i.reply({content:ex?`🔓 ${role} n’est plus protégé.`:`🔒 ${role} est maintenant protégé. La WL rôle ne pourra pas le distribuer.`,flags:MessageFlags.Ephemeral});
  }
  if(scope==='role'&&action==='access'&&extra==='role'){
    return i.showModal(modal(`role:access:modal:${i.values[0]}`,'Accès du rôle',[{id:'user',label:'ID, mention ou nom',required:false,placeholder:'Laisser vide pour afficher la liste'}]));
  }
  if(scope==='slash'&&action==='addrole'&&extra==='role'){if(!globalOwner(i.user.id)&&!wlRole(i.guildId,i.user.id))throw new Error('Accès WL rôle requis.');const role=i.guild.roles.cache.get(i.values[0]);if(!role||!wlRoleCanManage(i.guildId,i.user.id,role))throw new Error('Rôle non autorisé par ta WL rôle.');await i.member.roles.add(role,'DREAM addrole');return i.reply({content:'✅ Rôle ajouté.',flags:MessageFlags.Ephemeral});}
  if(scope==='slash'&&action==='delrole'&&extra==='role'){if(!globalOwner(i.user.id)&&!wlRole(i.guildId,i.user.id))throw new Error('Accès WL rôle requis.');const role=i.guild.roles.cache.get(i.values[0]);if(!role||!wlRoleCanManage(i.guildId,i.user.id,role))throw new Error('Rôle non autorisé par ta WL rôle.');await i.member.roles.remove(role,'DREAM delrole');return i.reply({content:'✅ Rôle retiré.',flags:MessageFlags.Ephemeral});}
  if(scope==='slash'&&action==='dog-add'&&extra==='user'){requireCmd(i.guildId,i.user.id,'/dog-add');db.prepare('INSERT OR IGNORE INTO dog(guild_id,user_id,created_at) VALUES(?,?,?)').run(i.guildId,i.values[0],now());return i.reply({content:'🐕 Ajouté à DOG.',flags:MessageFlags.Ephemeral});}
  if(scope==='slash'&&action==='dog-del'&&extra==='user'){requireCmd(i.guildId,i.user.id,'/dog-del');db.prepare('DELETE FROM dog WHERE guild_id=? AND user_id=?').run(i.guildId,i.values[0]);return i.reply({content:'🐕 Retiré de DOG.',flags:MessageFlags.Ephemeral});}
  if(scope==='wlrole'&&action==='user'){
    requireAccess(i.guildId,i.user.id,'wl-role',90);
    return i.reply({content:`Membre sélectionné : <@${i.values[0]}>. Choisis maintenant son grade.`,components:[row(sel(`wlrole:grade:${i.values[0]}`,'Grade WL rôle',[{label:'OWNER',value:'OWNER'},{label:'SYS',value:'SYS'},{label:'SYS+',value:'SYS+'}]))],flags:MessageFlags.Ephemeral});
  }
  if(scope==='wlrole'&&action==='grade'){
    requireAccess(i.guildId,i.user.id,'wl-role',90);
    const uid=extra, grade=i.values[0];
    if(!canGrantWLRole(i.guildId,i.user.id,grade)) throw new Error('Tu ne peux pas attribuer ce grade WL rôle.');
    if(!globalOwner(i.user.id) && rank(i.guildId,uid)>=rank(i.guildId,i.user.id)) throw new Error('Tu ne peux pas configurer une personne de niveau égal ou supérieur.');
    if(grade==='SYS+') { setWLRole(i.guildId,uid,'SYS+',null); return i.reply({content:`✅ <@${uid}> possède maintenant la WL rôle **SYS+**.\nPortée : tous les rôles gérables sous le plus haut rôle du bot, sauf les rôles protégés.`,flags:MessageFlags.Ephemeral}); }
    return i.reply({content:`Grade **${grade}** sélectionné pour <@${uid}>. Choisis le rôle de référence.`,components:[row(roleSel(`wlrole:anchor:${uid}:${grade}`))],flags:MessageFlags.Ephemeral});
  }
  if(scope==='wlrole'&&action==='anchor'){
    requireAccess(i.guildId,i.user.id,'wl-role',90);
    const uid=extra, grade=i.customId.split(':')[3];
    if(!canGrantWLRole(i.guildId,i.user.id,grade)) throw new Error('Tu ne peux pas attribuer ce grade WL rôle.');
    const role=i.guild.roles.cache.get(i.values[0]);
    if(!role || role.managed || role.id===i.guild.id) throw new Error('Rôle de référence invalide.');
    if(isProtectedRole(i.guildId,role)) throw new Error('Le rôle protégé ne peut pas servir de rôle de référence.');
    if(grade==='SYS+' && role.position>=i.guild.members.me.roles.highest.position) throw new Error('Le rôle de référence doit rester sous le plus haut rôle du bot.');
    setWLRole(i.guildId,uid,grade,role.id);
    return i.reply({content:`✅ <@${uid}> possède maintenant la WL rôle **${grade}**.
Rôle de référence : ${role}
Portée : ${grade==='SYS+'?'tous les rôles gérables sous le plus haut rôle du bot, sauf les rôles protégés.':`ce rôle et tous ceux qui sont en dessous, sauf les rôles protégés.`}`,flags:MessageFlags.Ephemeral});
  }

  if(scope==='wl'&&action==='user'){
    requireAccess(i.guildId,i.user.id,'wl-grant',80);
    const uid=i.values[0];
    return i.reply({content:`Membre choisi : <@${uid}>. Choisis maintenant son niveau.`,components:[row(sel(`wl:level:${uid}`,'Niveau WL',levelOptions(i.guildId)))],flags:MessageFlags.Ephemeral});
  }
  if(scope==='wl'&&action==='level'){
    requireAccess(i.guildId,i.user.id,'wl-grant',80);
    const uid=extra; const level=Number(i.values[0]);
    if(!uid||!Number.isFinite(level))throw new Error('Sélection WL invalide.');
    if(!globalOwner(i.user.id)&&rank(i.guildId,i.user.id)<=level)throw new Error('Tu ne peux pas attribuer ton niveau ou un niveau supérieur.');
    setWL(i.guildId,uid,'WLSYS',level);
    return i.reply({content:`✅ <@${uid}> est maintenant **${levelLabel(gid,level)}**.`,flags:MessageFlags.Ephemeral});
  }
}

async function handleModal(i){
  const gid=i.guildId;
  const [scope,action,sub]=i.customId.split(':');
  if(scope==='custom'&&action==='emoji'&&sub==='add'){
    if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');
    const count=customEmojiRows(i.guildId,i.user.id).length;if(count>=10)throw new Error('Limite atteinte : 10 emojis personnels maximum.');
    const raw=i.fields.getTextInputValue('url').trim();if(!/^https?:\/\/[^\s]+$/i.test(raw))throw new Error('Le lien doit être une URL HTTP ou HTTPS valide.');
    const url=new URL(raw);if(['localhost','127.0.0.1','0.0.0.0','::1'].includes(url.hostname)||/^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(url.hostname))throw new Error('Cette adresse n’est pas autorisée.');
    const res=await fetch(url,{redirect:'follow'});if(!res.ok)throw new Error(`Le fichier n’est pas accessible (${res.status}).`);const type=(res.headers.get('content-type')||'').split(';')[0].toLowerCase();if(!['image/png','image/jpeg','image/gif'].includes(type))throw new Error('Format accepté : PNG, JPG/JPEG ou GIF.');const len=Number(res.headers.get('content-length')||0);if(len&&len>262144)throw new Error('L’image dépasse 256 Ko.');const buf=Buffer.from(await res.arrayBuffer());if(buf.length>262144)throw new Error('L’image dépasse 256 Ko.');
    if(!i.guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions))throw new Error('Protect doit avoir la permission **Gérer les expressions** pour ajouter des emojis.');const name=customEmojiName(i.guild,i.user,new Set(customEmojiRows(i.guildId,i.user.id).map(x=>x.emoji_name)));const created=await i.guild.emojis.create({attachment:buf,name,reason:`CUSTOM+ de ${i.user.tag}`});db.prepare('INSERT INTO custom_emojis(guild_id,user_id,emoji_id,emoji_name,source_url,created_at) VALUES(?,?,?,?,?,?)').run(i.guildId,i.user.id,created.id,name,raw,now());return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'😀 Emoji ajouté',description:`${created} **${name}** a été ajouté au serveur.\n\n**Emplacements restants :** ${10-customEmojiRows(i.guildId,i.user.id).length}/10`})],flags:MessageFlags.Ephemeral});
  }
  if(scope==='custom'&&action==='alias'&&sub==='modal'){ if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.'); const alias=setPersonalAlias(i.guildId,i.user.id,i.fields.getTextInputValue('alias'),i.fields.getTextInputValue('target')); return i.reply({content:`✅ **${customPrefix(i.guildId,i.user.id)||'préfixe'}${alias}** est maintenant ton raccourci personnel.`,flags:MessageFlags.Ephemeral}); }
  if(scope==='custom'&&action==='prefix'&&sub==='modal'){ if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.'); setCustomPrefix(i.guildId,i.user.id,i.fields.getTextInputValue('prefix').trim()); return i.reply({content:`✅ Ton préfixe personnel est maintenant **${customPrefix(i.guildId,i.user.id)}**. Il ne fonctionne que pour toi et disparaîtra si CUSTOM+ est retirée.`,flags:MessageFlags.Ephemeral}); }
  if(scope==='custom'&&action==='command'&&sub==='add'){if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');let name=i.fields.getTextInputValue('name').trim().toLowerCase().replace(/^\//,'').replace(/[^a-z0-9_-]/g,'-').replace(/-+/g,'-').slice(0,32);if(name.length<2)throw new Error('Nom de commande invalide.');const kind=i.fields.getTextInputValue('kind').trim().toLowerCase().slice(0,32);const content=i.fields.getTextInputValue('content').slice(0,4000);const allowed=new Set(['tarifs','prix','réseaux','reseaux','contact','infos','information']);if(!allowed.has(kind))throw new Error('Fonction non autorisée. Utilise tarifs, réseaux, contact ou infos.');const other=db.prepare('SELECT user_id FROM custom_commands WHERE guild_id=? AND command_name=? AND user_id<>?').get(i.guildId,name,i.user.id);if(other)throw new Error('Ce raccourci est déjà utilisé par une autre personne. Choisis un autre nom.');db.prepare('INSERT INTO custom_commands(guild_id,user_id,command_name,kind,payload,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,user_id,command_name) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,active=1,updated_at=excluded.updated_at').run(i.guildId,i.user.id,name,kind,json({content}),1,now(),now());await syncCustomCommands(i.guild);return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'📋 Raccourci enregistré',description:`**${customPrefix(i.guildId,i.user.id)||'préfixe'}${name}** → **${kind}**\n\nLe raccourci est personnel et n’est pas enregistré comme commande slash.`})],flags:MessageFlags.Ephemeral});}
  if(scope==='custom'&&action==='appearance'&&sub==='name'){const v=i.fields.getTextInputValue('name').trim().slice(0,80);ensureCustomConfig(i.guildId,i.user.id);db.prepare('UPDATE custom_config SET webhook_name=? WHERE guild_id=? AND user_id=?').run(v||null,i.guildId,i.user.id);return customAppearancePanel(i);}
  if(scope==='custom'&&action==='appearance'&&sub==='color'){const v=color(i.fields.getTextInputValue('color'),cfg(i.guildId).ui.color);ensureCustomConfig(i.guildId,i.user.id);db.prepare('UPDATE custom_config SET color=? WHERE guild_id=? AND user_id=?').run(v,i.guildId,i.user.id);return customAppearancePanel(i);}
  if(scope==='custom'&&action==='appearance'&&sub==='footer'){const v=i.fields.getTextInputValue('footer').trim().slice(0,100);ensureCustomConfig(i.guildId,i.user.id);db.prepare('UPDATE custom_config SET footer=? WHERE guild_id=? AND user_id=?').run(v||null,i.guildId,i.user.id);return customAppearancePanel(i);}

  if(scope==='config'&&action==='color'){ const vals={main:i.fields.getTextInputValue('main'),error:i.fields.getTextInputValue('error'),ok:i.fields.getTextInputValue('ok'),warn:i.fields.getTextInputValue('warn')}; if(!Object.values(vals).every(v=>/^#[0-9A-Fa-f]{6}$/.test(v)))throw new Error('Chaque couleur doit être au format #RRGGBB.'); setCfg(i.guildId,c=>{c.ui.color=vals.main;c.ui.error=vals.error;c.ui.ok=vals.ok;c.ui.warn=vals.warn;}); return i.reply({embeds:[embed(i.guildId,{title:'🎨 Configuration enregistrée',description:'Les couleurs globales ont été mises à jour. Les prochains embeds utiliseront automatiquement cette palette.'})],flags:MessageFlags.Ephemeral}); }
  if(scope==='config'&&action==='footer'){const v=i.fields.getTextInputValue('footer').slice(0,100);setCfg(i.guildId,c=>c.ui.footer=v||'DREAM');return i.reply({embeds:[embed(i.guildId,{title:'✏️ Footer enregistré',description:`Le footer global est maintenant **${v||'DREAM'}**.`})],flags:MessageFlags.Ephemeral});}
  if(scope==='config'&&action==='welcomeText'){const v=i.fields.getTextInputValue('text').slice(0,1000);setCfg(i.guildId,c=>c.configuration.welcome.template=v);return i.reply({embeds:[embed(i.guildId,{title:'👋 Bienvenue • Message enregistré',description:'Le nouveau texte sera utilisé par Commu pour les prochaines arrivées.'})],flags:MessageFlags.Ephemeral});}

  if(scope==='role'&&action==='create'){
    if(!globalOwner(i.user.id) && !wlRole(i.guildId,i.user.id)) throw new Error('WL rôle requise.');
    const r=await i.guild.roles.create({name:i.fields.getTextInputValue('name'),reason:'DREAM role create'});db.prepare('INSERT OR REPLACE INTO role_meta(guild_id,role_id,type,owner_id,wl_level,interaction,data) VALUES(?,?,?,?,?,?,?)').run(i.guildId,r.id,'MANAGED',null,rank(i.guildId,i.user.id),0,json({}));await log(i.guild,'rôles','Rôle créé',`${r} par <@${i.user.id}>`,i.user.id);return i.reply({content:`✅ ${r} créé.`,flags:MessageFlags.Ephemeral});
  }
  if(scope==='role'&&action==='personal'){
    if(!globalOwner(i.user.id) && !wlRole(i.guildId,i.user.id)) throw new Error('WL rôle requise.');const r=await i.guild.roles.create({name:i.fields.getTextInputValue('name'),reason:'DREAM personal role'});db.prepare('INSERT OR REPLACE INTO role_meta(guild_id,role_id,type,owner_id,wl_level,interaction,data) VALUES(?,?,?,?,?,?,?)').run(i.guildId,r.id,'PERSONAL',i.user.id,rank(i.guildId,i.user.id),0,json({}));await i.member.roles.add(r,'DREAM personal role');return i.reply({content:`🎨 ${r} est ton rôle personnel.`,flags:MessageFlags.Ephemeral});
  }
  if(scope==='custom'&&action==='role'&&sub==='access'&&i.customId.split(':')[3]==='modal'){
    if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');
    const roleId=i.customId.split(':')[4]; const role=i.guild.roles.cache.get(roleId); if(!role||roleId!==customRoleId(i.guildId,i.user.id))throw new Error('Rôle personnel introuvable.');
    const raw=cleanTarget(i.fields.getTextInputValue('user'));
    if(!raw){const rows=db.prepare('SELECT user_id FROM role_access WHERE guild_id=? AND role_id=? ORDER BY created_at').all(i.guildId,roleId);return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'👥 Accès • Rôle personnel',description:rows.map(x=>`<@${x.user_id}>`).join('\n')||'Aucun accès supplémentaire.',footer:`${rows.length} accès`})],allowedMentions:{parse:[]},flags:MessageFlags.Ephemeral});}
    if(raw===i.user.id)throw new Error('Tu es déjà propriétaire de ce rôle.');
    const ex=db.prepare('SELECT 1 FROM role_access WHERE guild_id=? AND role_id=? AND user_id=?').get(i.guildId,roleId,raw);
    if(ex)db.prepare('DELETE FROM role_access WHERE guild_id=? AND role_id=? AND user_id=?').run(i.guildId,roleId,raw);else db.prepare('INSERT OR IGNORE INTO role_access(guild_id,role_id,user_id,created_at) VALUES(?,?,?,?)').run(i.guildId,roleId,raw,now());
    return i.reply({content:ex?'✅ Accès au rôle retiré.':'✅ Accès au rôle ajouté.',flags:MessageFlags.Ephemeral});
  }
  if(scope==='role'&&action==='access'&&sub==='modal'){
    if(!globalOwner(i.user.id) && !wlRole(i.guildId,i.user.id)) throw new Error('WL rôle requise.');
    const roleId=i.customId.split(':')[3]; const role=i.guild.roles.cache.get(roleId); if(!role)throw new Error('Rôle introuvable.');
    if(!canTouchRole(i.guildId,i.user.id,role))throw new Error('Rôle non autorisé.');
    const raw=cleanTarget(i.fields.getTextInputValue('user'));
    if(!raw){const rows=db.prepare('SELECT user_id FROM role_access WHERE guild_id=? AND role_id=? ORDER BY created_at').all(i.guildId,roleId);return i.reply({embeds:[embed(i.guildId,{title:'🔐 Accès du rôle',description:rows.slice(0,10).map(x=>`<@${x.user_id}>`).join('\n')||'Personne.',footer:`Page 1 • ${rows.length} accès`})],flags:MessageFlags.Ephemeral});}
    if(!higher(i.guildId,i.user.id,raw))throw new Error('Hiérarchie insuffisante.');
    const ex=db.prepare('SELECT 1 FROM role_access WHERE guild_id=? AND role_id=? AND user_id=?').get(i.guildId,roleId,raw);
    if(ex)db.prepare('DELETE FROM role_access WHERE guild_id=? AND role_id=? AND user_id=?').run(i.guildId,roleId,raw);else db.prepare('INSERT INTO role_access(guild_id,role_id,user_id,created_at) VALUES(?,?,?,?)').run(i.guildId,roleId,raw,now());
    return i.reply({content:ex?'✅ Accès retiré.':'✅ Accès ajouté.',flags:MessageFlags.Ephemeral});
  }
  if(scope==='pv'&&action==='access'){
    if(!hasPVAccess(i.guildId,i.user.id))throw new Error('WL PV ou CUSTOM+ requise.');const x=db.prepare('SELECT * FROM pv WHERE guild_id=? AND channel_id=?').get(i.guildId,i.member.voice.channelId||'');if(!x)throw new Error('Aucune PV ici.');if(hasCustomPlus(i.guildId,i.user.id)&&!hasKind(i.guildId,i.user.id,'WLPV')&&x.channel_id!==customVoiceId(i.guildId,i.user.id))throw new Error('CUSTOM+ gère uniquement sa vocale personnelle.');const raw=i.fields.getTextInputValue('user').replace(/[<@!>]/g,'');if(!higher(i.guildId,i.user.id,raw))throw new Error('Tu ne peux pas donner accès à une hiérarchie égale ou supérieure.');const ex=db.prepare('SELECT 1 FROM pv_access WHERE guild_id=? AND channel_id=? AND user_id=?').get(i.guildId,x.channel_id,raw);if(ex){db.prepare('DELETE FROM pv_access WHERE guild_id=? AND channel_id=? AND user_id=?').run(i.guildId,x.channel_id,raw);await i.guild.channels.cache.get(x.channel_id)?.permissionOverwrites.edit(raw,{Connect:false},'DREAM PV access removed').catch(()=>{});}else{db.prepare('INSERT INTO pv_access(guild_id,channel_id,user_id,created_at) VALUES(?,?,?,?)').run(i.guildId,x.channel_id,raw,now());await i.guild.channels.cache.get(x.channel_id)?.permissionOverwrites.edit(raw,{Connect:true},'DREAM PV access added').catch(()=>{});}return i.reply({content:ex?'✅ Accès PV retiré.':'✅ Accès PV ajouté.',flags:MessageFlags.Ephemeral});
  }
  if(scope==='music'&&action==='add'){
    requireAccess(i.guildId,i.user.id,'music',0); await i.deferReply({flags:MessageFlags.Ephemeral}); const result=await addMusic(i.guild,i.member,i.fields.getTextInputValue('url')); return i.editReply({embeds:[embed(i.guildId,{title:'🎵 Ajouté à la file',description:`**${result.count}** titre${result.count>1?'s':''} ajouté${result.count>1?'s':''}.\nPremier : **${String(result.first).slice(0,120)}**\n\nLa file n’a **aucune limite de taille**.`})]});
  }
  if(scope==='pay'&&action==='add'){
    requireAccess(i.guildId,i.user.id,'payment',50,'WLPAIEMENT');const uid=i.fields.getTextInputValue('user').replace(/[<@!>]/g,'');const amount=Number(i.fields.getTextInputValue('amount').replace(',','.'));if(!Number.isFinite(amount))throw new Error('Montant invalide.');db.prepare('INSERT INTO payments(guild_id,user_id,label,amount,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(i.guildId,uid,i.fields.getTextInputValue('label'),amount,i.fields.getTextInputValue('status').toUpperCase(),now(),now());await log(i.guild,'paiements','Paiement ajouté',`<@${uid}> • ${amount} ${cfg(i.guildId).payment.currency}`,i.user.id);return i.reply({content:'💳 Paiement enregistré.',flags:MessageFlags.Ephemeral});
  }
  if(scope==='msg'&&action==='create'){
    requireAccess(i.guildId,i.user.id,'message',50);const ch=await i.guild.channels.fetch(i.fields.getTextInputValue('channel'));if(!ch?.isTextBased())throw new Error('Salon invalide.');const payload={title:i.fields.getTextInputValue('title'),description:i.fields.getTextInputValue('description'),color:color(i.fields.getTextInputValue('color'),cfg(i.guildId).ui.color)};const msg=await ch.send({embeds:[embedFor(i.guildId,i.user.id,payload)]});db.prepare('INSERT OR REPLACE INTO messages(guild_id,message_id,channel_id,owner_id,version,payload,updated_at) VALUES(?,?,?,?,?,?,?)').run(i.guildId,msg.id,ch.id,i.user.id,2,json(payload),now());return i.reply({content:`📝 Message créé : ${msg}`,flags:MessageFlags.Ephemeral});
  }
  if(scope==='msg'&&action==='edit'){
    requireAccess(i.guildId,i.user.id,'message',50);const id=i.fields.getTextInputValue('message');const rec=db.prepare('SELECT * FROM messages WHERE guild_id=? AND message_id=?').get(i.guildId,id);if(!rec)throw new Error('Message non enregistré par DREAM.');if(rec.owner_id!==i.user.id&&!globalOwner(i.user.id)&&rank(i.guildId,i.user.id)<50)throw new Error('Accès propriétaire requis.');const ch=await i.guild.channels.fetch(rec.channel_id);const msg=await ch.messages.fetch(id);const old=parse(rec.payload),payload={...old,title:i.fields.getTextInputValue('title')||old.title,description:i.fields.getTextInputValue('description')||old.description,color:color(i.fields.getTextInputValue('color'),old.color||cfg(i.guildId).ui.color)};await msg.edit({embeds:[embedFor(i.guildId,i.user.id,payload)]});db.prepare('UPDATE messages SET payload=?,version=?,updated_at=? WHERE guild_id=? AND message_id=?').run(json(payload),2,now(),i.guildId,id);return i.reply({content:'✅ Message modifié.',flags:MessageFlags.Ephemeral});
  }
  if(scope==='msg'&&action==='v2'){
    requireAccess(i.guildId,i.user.id,'message',50);const id=i.fields.getTextInputValue('message');const rec=db.prepare('SELECT * FROM messages WHERE guild_id=? AND message_id=?').get(i.guildId,id);if(!rec)throw new Error('Message introuvable dans le registre DREAM.');const payload=parse(rec.payload);const ch=await i.guild.channels.fetch(rec.channel_id);const msg=await ch.messages.fetch(id);await msg.edit({embeds:[embedFor(i.guildId,i.user.id,{...payload,title:payload.title||'DREAM',description:payload.description||' ',color:payload.color||cfg(i.guildId).ui.color})]});db.prepare('UPDATE messages SET version=2,updated_at=? WHERE guild_id=? AND message_id=?').run(now(),i.guildId,id);return i.reply({content:'✨ Conversion V1 → V2 terminée en conservant les données.',flags:MessageFlags.Ephemeral});
  }
  if(scope==='set'&&action==='usercolor'&&sub==='modal'){const v=color(i.fields.getTextInputValue('color'),cfg(i.guildId).ui.color);db.prepare('INSERT INTO user_ui(guild_id,user_id,color,footer,image,banner) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET color=excluded.color').run(i.guildId,i.user.id,v,null,null,null);return i.reply({content:`🎨 Couleur personnelle enregistrée : **${v}**`,flags:MessageFlags.Ephemeral});}
  if(scope==='set'&&action==='userfooter'&&sub==='modal'){const v=i.fields.getTextInputValue('footer').slice(0,100);db.prepare('INSERT INTO user_ui(guild_id,user_id,color,footer,image,banner) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET footer=excluded.footer').run(i.guildId,i.user.id,null,v,null,null);return i.reply({content:'✅ Footer personnel enregistré.',flags:MessageFlags.Ephemeral});}
  if(scope==='set'&&action==='ui'){
    requireAccess(i.guildId,i.user.id,'ui',50);return i.reply({content:'Utilise les réglages dédiés du panneau pour appliquer une valeur précise.',flags:MessageFlags.Ephemeral});
  }
}

async function syncCustomCommands(guild){ return guild; }

// ────────────────── Interactions ──────────────────
async function handleInteraction(i){
  try{
    if(i.isButton() && (i.customId.startsWith('integration:accept:')||i.customId.startsWith('integration:reject:'))){if(!globalOwner(i.user.id))throw new Error('Seul un owner DREAM peut valider cette intégration.');const [,action,gid,botId]=i.customId.split(':');const x=botAccess(gid,botId);if(!x)throw new Error('Demande introuvable.');if(action==='accept'){db.prepare("UPDATE bot_access SET status='accepted',decided_at=?,decided_by=? WHERE guild_id=? AND bot_id=?").run(now(),i.user.id,gid,botId);const c=[clients.one,clients.two].find(v=>v.user?.id===botId);const g=c?.guilds.cache.get(gid);if(g&&c===clients.two)await refreshGuild(g).catch(()=>{});return i.update({embeds:[embed(gid,{title:'✅ DREAM • Intégration acceptée',description:`**${x.bot_name}** est maintenant actif sur ce serveur.`})],components:[]});}db.prepare("UPDATE bot_access SET status='rejected',decided_at=?,decided_by=? WHERE guild_id=? AND bot_id=?").run(now(),i.user.id,gid,botId);const c=[clients.one,clients.two].find(v=>v.user?.id===botId);const g=c?.guilds.cache.get(gid);if(g)await g.leave().catch(()=>{});return i.update({embeds:[embed(gid,{title:'⛔ DREAM • Intégration refusée',description:`**${x.bot_name}** quitte le serveur.`})],components:[]});}
    if(!i.guildId)return;
    assertBotAccepted(i.guildId,i.client);
    if(!i.isChatInputCommand()&&await extraComponent(i))return;
    if(i.isButton())return await handleButton(i);
    if(i.isStringSelectMenu()||i.isUserSelectMenu()||i.isRoleSelectMenu()||i.isChannelSelectMenu())return await handleSelect(i);
    if(i.isModalSubmit())return await handleModal(i);
    if(i.isChatInputCommand()){
      const n=i.commandName;
      if(i.client===clients.one && PROTECT_CMDS.has(n)) return;
      if(i.client===clients.two && !PROTECT_CMDS.has(n)) return;
      if(await extraSlash(i))return;
      const cc=commandCfg(i.guildId,n);
      if(cc && !cc.active) throw new Error('Cette commande est désactivée sur ce serveur.');
      if(cc && !cc.visible) throw new Error('Cette commande est masquée sur ce serveur.');
      const dest=cc?.channel_id ? i.guild.channels.cache.get(cc.channel_id) : null;
      if(dest && i.channelId!==dest.id){ return i.reply({embeds:[embed(i.guildId,{title:'📍 Mauvais salon',description:`Cette commande est configurée pour ${dest}.

Tu peux soit l’envoyer dans le salon configuré, soit confirmer pour l’envoyer ici.`})],components:[row(btn(`route:send:${n}:${dest.id}`,'Envoyer dans le bon salon',ButtonStyle.Primary),btn(`route:here:${n}`,'Envoyer ici',ButtonStyle.Secondary))],flags:MessageFlags.Ephemeral}); }
      if(n==='dream')return openDream(i);
      if(n==='wl')return openDream(i,'wl');
      if(n==='wl-role')return handleButton({ ...i, customId:'wlrole:panel' });
      if(n==='music')return openDream(i,'music');
      if(n==='logs'){requireAccess(i.guildId,i.user.id,'logs',50);await ensureLogs(i.guild);return i.reply({content:'✅ Logs créés/vérifiés.',flags:MessageFlags.Ephemeral});}
      if(n==='role')return openDream(i,'roles');
      if(n==='ticket')return openDream(i,'tickets');
      if(n==='payment')return openDream(i,'payments');
      if(n==='message')return openDream(i,'messages');
      if(n==='ui')return openDream(i,'settings');
      if(n==='role-acces')return openDream(i,'roles');
      if(n==='addrole'||n==='delrole')return i.reply({content:'Choisis le rôle à gérer.',components:[row(roleSel(`slash:${n}:role`))],flags:MessageFlags.Ephemeral});
      if(n==='dog-add'||n==='dog-del')return i.reply({content:'Choisis le membre.',components:[row(userSel(`slash:${n}:user`))],flags:MessageFlags.Ephemeral});
      if(n==='prix')return openDream(i,'payments');
      if(n==='stats'){await updateStats(i.guild);return i.reply({embeds:[embed(i.guildId,{title:'📊 Statistiques',description:Object.entries(statsText(i.guild)).map(([k,v])=>`**${k}** : ${v}`).join('\n')})],flags:MessageFlags.Ephemeral});}
      if(n==='lock'||n==='unlock'){requireCmd(i.guildId,i.user.id,n);const lock=n==='lock';if(lock){db.prepare('INSERT OR IGNORE INTO locks(guild_id,channel_id,created_at) VALUES(?,?,?)').run(i.guildId,i.channelId,now());await i.channel.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:false},'DREAM lock');}else{db.prepare('DELETE FROM locks WHERE guild_id=? AND channel_id=?').run(i.guildId,i.channelId);await i.channel.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:null},'DREAM unlock');}return i.reply({content:lock?'🔒 Verrouillé.':'🔓 Déverrouillé.',flags:MessageFlags.Ephemeral});}
    }
  }catch(e){const msg=String(e?.message||e).slice(0,1900);if(i.deferred||i.replied)return i.followUp({content:`⛔ ${msg}`,flags:MessageFlags.Ephemeral}).catch(()=>{});return i.reply({content:`⛔ ${msg}`,flags:MessageFlags.Ephemeral}).catch(()=>{});}
}

function cleanTarget(x){return cleanId(x);}
// ────────────────────── Prefixes ──────────────────────
async function handlePrefix(m){
  if(m.author.bot||!m.guild)return;
  if(!botAccepted(m.guild.id,m.client.user.id))return;
  const t=m.content.trim(), low=t.toLowerCase(), gid=m.guild.id;
  const myPrefix=hasCustomPlus(gid,m.author.id)?customPrefix(gid,m.author.id):null;
  if(emergencyOn(gid)&&!globalOwner(m.author.id)&&rank(gid,m.author.id)<(levelByName(gid,'SYS')??90)&&!/^=urgence/i.test(t))return;
  const personalText=myPrefix && t.startsWith(myPrefix) ? t.slice(myPrefix.length).trim() : null;
  try{
    if(personalText!==null && personalText){
      const [cmdRaw,...args]=personalText.split(/\s+/), cmd=cmdRaw.toLowerCase();
      if(cmd==='prefix') return m.reply(`✨ Ton préfixe personnel : **${myPrefix}**`);
      if(cmd==='raccourcis'||cmd==='shortcuts'){const rows=db.prepare('SELECT command_name,kind FROM custom_commands WHERE guild_id=? AND user_id=? AND active=1 ORDER BY command_name').all(gid,m.author.id);const aliases=db.prepare('SELECT alias,target FROM custom_aliases WHERE guild_id=? AND user_id=? ORDER BY alias').all(gid,m.author.id);const all=[...rows.map(x=>`**${myPrefix}${x.command_name}** → ${x.kind}`),...aliases.map(x=>`**${myPrefix}${x.alias}** → ${x.target}`)];return m.reply({embeds:[embedFor(gid,m.author.id,{title:'✨ CUSTOM+ • Raccourcis',description:all.join('\n')||'Aucun raccourci.'})]});}
      const alias=db.prepare('SELECT target FROM custom_aliases WHERE guild_id=? AND user_id=? AND alias=?').get(gid,m.author.id,cmd);
      if(alias){ if(alias.target==='dream') return openDream({guildId:gid,user:m.author,member:m.member,guild:m.guild,channelId:m.channelId,reply:o=>m.reply(o)}); if(alias.target==='music') return openDream({guildId:gid,user:m.author,member:m.member,guild:m.guild,channelId:m.channelId,reply:o=>m.reply(o)},'music'); if(alias.target==='ticket') return openDream({guildId:gid,user:m.author,member:m.member,guild:m.guild,channelId:m.channelId,reply:o=>m.reply(o)},'tickets'); if(alias.target==='role') return openDream({guildId:gid,user:m.author,member:m.member,guild:m.guild,channelId:m.channelId,reply:o=>m.reply(o)},'roles'); if(alias.target==='stats'){await updateStats(m.guild);return m.reply({embeds:[embedFor(gid,m.author.id,{title:'📊 Statistiques',description:Object.entries(statsText(m.guild)).map(([k,v])=>`**${k}** : ${v}`).join('\n')})]});} if(alias.target==='prix') return openDream({guildId:gid,user:m.author,member:m.member,guild:m.guild,channelId:m.channelId,reply:o=>m.reply(o)},'payments'); if(alias.target==='ui') return openDream({guildId:gid,user:m.author,member:m.member,guild:m.guild,channelId:m.channelId,reply:o=>m.reply(o)},'settings'); }
      const rec=db.prepare('SELECT * FROM custom_commands WHERE guild_id=? AND user_id=? AND command_name=? AND active=1').get(gid,m.author.id,cmd);
      if(rec){const allowedChannel=customTextId(gid,m.author.id);if(allowedChannel&&m.channelId!==allowedChannel)return m.reply(`📍 Ce raccourci est réservé à <#${allowedChannel}>.`);const payload=parse(rec.payload);const sent=await sendCustomPanel(m.guild,m.author.id,m.channel,{title:`${rec.kind==='tarifs'||rec.kind==='prix'?'💰':rec.kind==='réseaux'||rec.kind==='reseaux'?'🔗':'📌'} ${cmd}`,description:payload.content||' '});if(!sent)throw new Error('Impossible de publier ton panneau personnalisé ici.');return;}
    }
    if(await extraPrefix(m))return;
    const protectOnly=/^(?:\.owner|=pv|=acces|&blinfo|&(?:un)?bl|&derank|\+ban|\-baninfo|\+(?:lock|unlock)|\/wet-info|\/wet(?:=pa)?|\/dog-(?:add|del))/i.test(t);
    if(protectOnly && m.client!==clients.two) return;
    if(/^\.owner(?:\s|$)/i.test(t)){
      if(!globalOwner(m.author.id))return;
      const target=cleanTarget(t.split(/\s+/)[1]);if(!target)return ownerPanel(m);
      if(target===m.author.id)throw new Error('Tu ne peux pas retirer ton propre accès owner.');
      const ex=!!db.prepare('SELECT 1 FROM owners WHERE user_id=?').get(target);if(ex)db.prepare('DELETE FROM owners WHERE user_id=?').run(target);else db.prepare('INSERT INTO owners(user_id,created_at) VALUES(?,?)').run(target,now());return m.reply(ex?`✅ <@${target}> retiré des owners.`:`✅ <@${target}> ajouté aux owners.`);
    }
    if(/^=pv$/i.test(t)){if(!hasPVAccess(gid,m.author.id))throw new Error('WL PV ou CUSTOM+ requise.');const ch=m.member.voice.channel;if(!ch)throw new Error('Rejoins un vocal.');if(hasCustomPlus(gid,m.author.id)&&!hasKind(gid,m.author.id,'WLPV')&&customVoiceId(gid,m.author.id)!==ch.id)throw new Error('CUSTOM+ gère uniquement sa vocale personnelle.');const old=db.prepare('SELECT * FROM pv WHERE channel_id=?').get(ch.id);if(old&&!higher(gid,m.author.id,old.owner_id))throw new Error('PV appartenant à une hiérarchie supérieure.');const level=pvRank(gid,m.author.id);if(level<0)throw new Error('WL PV requise.');db.prepare('INSERT INTO pv(guild_id,channel_id,owner_id,level,access_mode,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET owner_id=excluded.owner_id,level=excluded.level,access_mode=excluded.access_mode').run(gid,ch.id,m.author.id,level,'DENY',now());await ch.permissionOverwrites.edit(m.guild.roles.everyone,{Connect:false},'DREAM PV').catch(()=>{});await ch.permissionOverwrites.edit(m.user,{Connect:true},'DREAM PV owner').catch(()=>{});return m.reply(`🔊 PV activée ici. Niveau : **${pvLabel(i.guildId,level)}**.`);}
    if(/^=acces(?:\s|$)/i.test(t)){if(!hasPVAccess(gid,m.author.id))throw new Error('WL PV ou CUSTOM+ requise.');const x=db.prepare('SELECT * FROM pv WHERE guild_id=? AND channel_id=?').get(gid,m.member.voice.channelId||'');if(!x)throw new Error('Aucune PV ici.');if(hasCustomPlus(gid,m.author.id)&&!hasKind(gid,m.author.id,'WLPV')&&x.channel_id!==customVoiceId(gid,m.author.id))throw new Error('CUSTOM+ gère uniquement sa vocale personnelle.');const target=cleanTarget(t.split(/\s+/)[1]);if(!target){const a=db.prepare('SELECT user_id FROM pv_access WHERE guild_id=? AND channel_id=?').all(gid,x.channel_id);return m.reply(`**Accès PV**\n${a.map(z=>`<@${z.user_id}>`).join('\n')||'Personne.'}`);}if(!higher(gid,m.author.id,target))throw new Error('Hiérarchie insuffisante.');const ex=!!db.prepare('SELECT 1 FROM pv_access WHERE guild_id=? AND channel_id=? AND user_id=?').get(gid,x.channel_id,target);if(ex){db.prepare('DELETE FROM pv_access WHERE guild_id=? AND channel_id=? AND user_id=?').run(gid,x.channel_id,target);await m.guild.channels.cache.get(x.channel_id)?.permissionOverwrites.edit(target,{Connect:false},'DREAM PV access removed').catch(()=>{});}else{db.prepare('INSERT INTO pv_access(guild_id,channel_id,user_id,created_at) VALUES(?,?,?,?)').run(gid,x.channel_id,target,now());await m.guild.channels.cache.get(x.channel_id)?.permissionOverwrites.edit(target,{Connect:true},'DREAM PV access added').catch(()=>{});}return m.reply(ex?'✅ Accès retiré.':'✅ Accès ajouté.');}
    if(/^&blinfo$/i.test(t)){requireCmd(gid,m.author.id,'&blinfo');const a=db.prepare('SELECT user_id FROM bl WHERE guild_id=? AND kind=?').all(gid,'BL');return m.reply(`**BL**\n${a.map(x=>`<@${x.user_id}>`).join('\n')||'Personne.'}`);}
    if(/^\+(?:kick|expulse)(?:\s|$)/i.test(t)){requireCmd(gid,m.author.id,'+kick');const target=cleanTarget(t.split(/\s+/)[1]);const mem=await m.guild.members.fetch(target);return requestSanction({guild:m.guild,member:m.member,author:m.author,channel:m.channel,user:m.author,reply:o=>m.reply(o)},mem,t.split(/\s+/).slice(2).join(' ')||'—','KICK',false);}
    if(/^\+timeout(?:\s|$)/i.test(t)){requireCmd(gid,m.author.id,'+timeout');const target=cleanTarget(t.split(/\s+/)[1]);const mem=await m.guild.members.fetch(target);return requestSanction({guild:m.guild,member:m.member,author:m.author,channel:m.channel,user:m.author,reply:o=>m.reply(o)},mem,t.split(/\s+/).slice(2).join(' ')||'—','TIMEOUT',false);}
    if(/^\+warn(?:\s|$)/i.test(t)){requireCmd(gid,m.author.id,'+warn');const target=cleanTarget(t.split(/\s+/)[1]);const mem=await m.guild.members.fetch(target);return requestSanction({guild:m.guild,member:m.member,author:m.author,channel:m.channel,user:m.author,reply:o=>m.reply(o)},mem,t.split(/\s+/).slice(2).join(' ')||'—','WARN',false);}
    if(/^\+ban(?:\s|$)/i.test(t)){requireCmd(gid,m.author.id,'+ban');const target=cleanTarget(t.split(/\s+/)[1]);const mem=await m.guild.members.fetch(target);return requestSanction({guild:m.guild,member:m.member,author:m.author,channel:m.channel,user:m.author,reply:o=>m.reply(o)},mem,t.split(/\s+/).slice(2).join(' ')||'—','BAN',false);}
    if(/^-baninfo(?:\s|$)/i.test(t)){requireCmd(gid,m.author.id,'-baninfo');const target=cleanTarget(t.split(/\s+/)[1]);const a=db.prepare('SELECT * FROM sanctions WHERE guild_id=? AND target_id=? ORDER BY created_at DESC LIMIT 20').all(gid,target);return m.reply(`**Sanctions**\n${a.map(x=>`${x.type} • ${new Date(x.created_at).toLocaleString('fr-FR')} • ${x.reason||'—'}`).join('\n')||'Aucune.'}`);}
    if(/^\+(?:lock|unlock)$/i.test(t)){const lock=/^\+lock$/i.test(t);requireCmd(gid,m.author.id,lock?'+lock':'+unlock');if(lock){db.prepare('INSERT OR IGNORE INTO locks(guild_id,channel_id,created_at) VALUES(?,?,?)').run(gid,m.channel.id,now());await m.channel.permissionOverwrites.edit(m.guild.roles.everyone,{SendMessages:false},'DREAM lock');}else{db.prepare('DELETE FROM locks WHERE guild_id=? AND channel_id=?').run(gid,m.channel.id);await m.channel.permissionOverwrites.edit(m.guild.roles.everyone,{SendMessages:null},'DREAM unlock');}return m.reply(lock?'🔒 Verrouillé.':'🔓 Déverrouillé.');}
    if(/^=faq$/i.test(t)){return m.reply({embeds:[embed(gid,{title:'☑️ La FAQ DREAM',description:'Choisis un sujet : Général • Tickets • WL • Bots'})],components:[row(btn('faq:general','Général'),btn('faq:tickets','Tickets'),btn('faq:wl','WL'),btn('faq:bot','Bots'))]});}
    if(/^=(?:hierarchy|perms)$/i.test(t)){
      requireCmd(gid,m.author.id,'=ui');
      if(/^=hierarchy$/i.test(t))return m.reply({embeds:[embedFor(gid,m.author.id,{title:'📚 Hiérarchie',description:ladderText(gid,m.guild),footer:`Niveaux ${TIER_MIN} à ${TIER_MAX} pour les rôles · au-dessus = accès internes`})]});
      const mine=CMD_ACCESS.filter(e=>allowCmd(gid,m.author.id,e[0])).map(e=>cmdRuleText(gid,e[0]));
      return m.reply({embeds:[embedFor(gid,m.author.id,{title:'🔐 Tes droits',description:mine.join('\n').slice(0,4000)||'Aucun droit particulier.',footer:`${levelNameFor(gid,m.author.id)} · ${mine.length} commande${mine.length>1?'s':''}`})]});
    }
    if(/^=wlrole$/i.test(t)){if(!globalOwner(m.author.id)&&rank(gid,m.author.id)<(levelByName(gid,'SYS')??90))throw new Error('Accès WL rôle requis.');const x=wlRole(gid,m.author.id);return m.reply({embeds:[embed(gid,{title:'🛡️ WL rôle',description:`Grade : **${x?.grade||'Aucun'}**\n${wlRoleScopeDescription(gid,m.author.id)}\n\nOWNER / SYS : rôle sélectionné + tous les rôles sous celui-ci.\nSYS+ : tous les rôles gérables sous le plus haut rôle du bot.\n🔒 Les rôles protégés restent interdits.`})]});}
    if(/^=ui$/i.test(t)){requireCmd(gid,m.author.id,'=ui');return m.reply({embeds:[embed(gid,{title:'⚙️ DREAM • UI',description:`Couleur : **${cfg(gid).ui.color}**\nFooter : **${cfg(gid).ui.footer}**\nImage : ${cfg(gid).ui.image||'aucune'}`})]});}
    if(/^=edit(?:\s|$)/i.test(t)||/^=v2(?:\s|$)/i.test(t)){
      requireAccess(gid,m.author.id,'message',50); const isV2=/^=v2/i.test(t); const reply=m.reference?.messageId; const id=cleanTarget(t.split(/\s+/)[1])||reply; if(!id)throw new Error('Réponds au message ou donne son ID.'); const rec=db.prepare('SELECT * FROM messages WHERE guild_id=? AND message_id=?').get(gid,id); if(!rec)throw new Error('Message non enregistré par DREAM.'); if(rec.owner_id!==m.author.id&&!globalOwner(m.author.id)&&rank(gid,m.author.id)<50)throw new Error('Accès propriétaire requis.'); const ch=await m.guild.channels.fetch(rec.channel_id); const msg=await ch.messages.fetch(id); const old=parse(rec.payload); const payload={...old, title:old.title||'DREAM', description:old.description||' ', color:old.color||cfg(gid).ui.color}; await msg.edit({embeds:[embed(gid,payload)]}); db.prepare('UPDATE messages SET version=?,payload=?,updated_at=? WHERE guild_id=? AND message_id=?').run(2,json(payload),now(),gid,id); return m.reply(isV2?'✨ V1 → V2 terminée.':'✅ Message modifié.');
    }
    if(/^\+(?:pic|banner)(?:\s|$)/i.test(t)){
      const cmd=t.toLowerCase().startsWith('+pic')?'+pic':'+banner'; requireAccess(gid,m.author.id,cmd,50); let url=t.split(/\s+/)[1]; if(!url&&m.reference?.messageId){const ref=await m.channel.messages.fetch(m.reference.messageId).catch(()=>null); url=ref?.attachments.first()?.url||ref?.embeds?.[0]?.data?.image?.url||ref?.embeds?.[0]?.data?.thumbnail?.url;} if(!url)url=m.attachments.first()?.url; const safe=imageUrl(url); if(!safe)throw new Error('Image refusée. Donne un lien direct en .png, .jpg, .gif ou .webp.'); setCfg(gid,c=>c.ui[cmd==='+pic'?'image':'banner']=safe); await logTo(m.guild,'commande',{title:cmd==='+pic'?'🖼️ Image mise à jour':'🏞️ Bannière mise à jour',description:safe,actor:m.author.id,mirror:false}); return m.reply({embeds:[embedFor(gid,m.author.id,{title:'✅ Média enregistré',description:cmd==='+pic'?'Il apparaîtra sur les embeds du serveur.':'Elle est enregistrée.',image:safe})]});
    }
    if(/^\/role-acces(?:\s|$)/i.test(t)){
      if(!globalOwner(m.author.id) && !wlRole(gid,m.author.id)) throw new Error('WL rôle requise.');
      const parts=t.split(/\s+/); const roleId=cleanTarget(parts[1]); const target=cleanTarget(parts[2]); const role=m.guild.roles.cache.get(roleId);
      if(!role)throw new Error('Rôle introuvable.'); if(!canTouchRole(gid,m.author.id,role))throw new Error('Rôle non autorisé.');
      if(!target){const rows=db.prepare('SELECT user_id FROM role_access WHERE guild_id=? AND role_id=? ORDER BY created_at').all(gid,roleId);const page=Math.max(1,Number(parts[3]||1));const start=(page-1)*10;const shown=rows.slice(start,start+10);return m.reply({embeds:[embed(gid,{title:'🔐 Accès du rôle',description:shown.map(x=>`<@${x.user_id}>`).join('\n')||'Personne.',footer:`Page ${page} • ${rows.length} accès`})],allowedMentions:{parse:[]}});}
      if(!higher(gid,m.author.id,target))throw new Error('Hiérarchie insuffisante.'); const ex=!!db.prepare('SELECT 1 FROM role_access WHERE guild_id=? AND role_id=? AND user_id=?').get(gid,roleId,target); if(ex)db.prepare('DELETE FROM role_access WHERE guild_id=? AND role_id=? AND user_id=?').run(gid,roleId,target);else db.prepare('INSERT INTO role_access(guild_id,role_id,user_id,created_at) VALUES(?,?,?,?)').run(gid,roleId,target,now());return m.reply(ex?'✅ Accès retiré.':'✅ Accès ajouté.');
    }
    if(/^\/addrole\b/i.test(t)){if(!globalOwner(m.author.id)&&!wlRole(gid,m.author.id))throw new Error('Accès WL rôle requis.');const target=cleanTarget(t.split(/\s+/)[1]);const role=m.guild.roles.cache.get(target);if(!role||!wlRoleCanManage(gid,m.author.id,role))throw new Error('Rôle non autorisé par ta WL rôle.');await m.member.roles.add(role,'DREAM addrole');return m.reply('✅ Rôle ajouté.');}
    if(/^\/delrole\b/i.test(t)){if(!globalOwner(m.author.id)&&!wlRole(gid,m.author.id))throw new Error('Accès WL rôle requis.');const target=cleanTarget(t.split(/\s+/)[1]);const role=m.guild.roles.cache.get(target);if(!role||!wlRoleCanManage(gid,m.author.id,role))throw new Error('Rôle non autorisé par ta WL rôle.');await m.member.roles.remove(role,'DREAM delrole');return m.reply('✅ Rôle retiré.');}
    if(/^\/dog-(?:add|del)\b/i.test(t)){requireCmd(gid,m.author.id,t.toLowerCase().startsWith('/dog-add')?'/dog-add':'/dog-del');const target=cleanTarget(t.split(/\s+/)[1]);const add=t.toLowerCase().startsWith('/dog-add');if(add)db.prepare('INSERT OR IGNORE INTO dog(guild_id,user_id,created_at) VALUES(?,?,?)').run(gid,target,now());else db.prepare('DELETE FROM dog WHERE guild_id=? AND user_id=?').run(gid,target);return m.reply(add?'🐕 Ajouté à DOG.':'🐕 Retiré de DOG.');}
  }catch(e){return m.reply(`⛔ ${String(e.message||e).slice(0,1900)}`).catch(()=>{});}
}


// Niveaux liés
const rankCache=new Map();
function clearRankCache(gid=null,uid=null){
  if(!gid)return rankCache.clear();
  if(!uid){for(const k of [...rankCache.keys()])if(k.startsWith(`${gid}:`))rankCache.delete(k);return;}
  rankCache.delete(`${gid}:${uid}`);
}
function guildOf(gid){return guilds.get(gid)||clients?.two?.guilds?.cache?.get(gid)||clients?.one?.guilds?.cache?.get(gid)||null;}
const TIER_MIN=1,TIER_MAX=79;
function ensureHierarchy(gid){
  if(db.prepare('SELECT 1 FROM hierarchy WHERE guild_id=? LIMIT 1').get(gid))return;
  const ins=db.prepare('INSERT OR IGNORE INTO hierarchy(guild_id,name,level,role_id) VALUES(?,?,?,NULL)');
  for(const [n,v] of HIERARCHY)ins.run(gid,n,v);
}
function systemRows(gid){ensureHierarchy(gid);return db.prepare('SELECT name,level,role_id FROM hierarchy WHERE guild_id=? ORDER BY level DESC').all(gid);}
function tierRows(gid){return db.prepare('SELECT role_id,name,level FROM linked_roles WHERE guild_id=? ORDER BY level DESC').all(gid);}
function hierarchyRows(gid){
  const sys=systemRows(gid).map(x=>({name:x.name,level:x.level,role_id:x.role_id,system:1}));
  const tiers=tierRows(gid).map(x=>({name:x.name,level:x.level,role_id:x.role_id,system:0}));
  return [...sys,...tiers].sort((a,b)=>b.level-a.level);
}
function levelByName(gid,name){ensureHierarchy(gid);return db.prepare('SELECT level FROM hierarchy WHERE guild_id=? AND name=?').get(gid,name)?.level??null;}
function ownerLevel(gid){return levelByName(gid,'OWNER')??80;}
function levelLabel(gid,level){
  if(level>=999)return 'OWNER GLOBAL';
  if(level<0)return 'Aucun';
  const sys=db.prepare('SELECT name FROM hierarchy WHERE guild_id=? AND level=?').get(gid,level)?.name;
  if(sys)return sys;
  const tier=db.prepare('SELECT name FROM linked_roles WHERE guild_id=? AND level=? ORDER BY name LIMIT 1').get(gid,level)?.name;
  return tier||`Niveau ${level}`;
}
function levelNameFor(gid,uid){return levelLabel(gid,rank(gid,uid));}
function tierOf(gid,roleId){return db.prepare('SELECT * FROM linked_roles WHERE guild_id=? AND role_id=?').get(gid,roleId)||null;}
function setTier(gid,role,level,actorId=null){
  const v=Number(level);
  if(!Number.isInteger(v)||v<TIER_MIN||v>TIER_MAX)throw new Error(`Niveau invalide. Choisis un entier entre ${TIER_MIN} et ${TIER_MAX}.`);
  if(!role?.id)throw new Error('Rôle introuvable.');
  if(role.managed)throw new Error('Un rôle de bot ne peut pas porter un niveau.');
  if(actorId&&!globalOwner(actorId)){
    const mine=rank(gid,actorId);
    if(v>=mine)throw new Error('Tu ne peux pas placer un niveau au-dessus ou égal au tien.');
    const old=tierOf(gid,role.id);
    if(old&&old.level>=mine)throw new Error('Ce rôle est au-dessus de ton niveau.');
  }
  db.prepare('INSERT INTO linked_roles(guild_id,role_id,name,level,created_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,role_id) DO UPDATE SET name=excluded.name,level=excluded.level').run(gid,role.id,String(role.name||role.id).slice(0,80),v,now());
  clearRankCache(gid);
}
function delTier(gid,roleId,actorId=null){
  const old=tierOf(gid,roleId);
  if(!old)throw new Error('Ce rôle ne porte aucun niveau.');
  if(actorId&&!globalOwner(actorId)&&old.level>=rank(gid,actorId))throw new Error('Ce rôle est au-dessus de ton niveau.');
  db.prepare('DELETE FROM linked_roles WHERE guild_id=? AND role_id=?').run(gid,roleId);
  clearRankCache(gid);
  return old;
}
function setHierarchyLevel(gid,name,level){
  ensureHierarchy(gid);
  if(!systemRows(gid).some(x=>x.name===name))throw new Error('Niveau système inconnu.');
  const v=Number(level);
  if(!Number.isInteger(v)||v<=TIER_MAX||v>998)throw new Error(`Un niveau système doit rester au-dessus de ${TIER_MAX}.`);
  db.prepare('UPDATE hierarchy SET level=? WHERE guild_id=? AND name=?').run(v,gid,name);
  clearRankCache(gid);
}
function linkHierarchyRole(gid,name,roleId){
  if(!systemRows(gid).some(x=>x.name===name))throw new Error('Niveau système inconnu.');
  const level=levelByName(gid,name);
  db.prepare('UPDATE hierarchy SET role_id=? WHERE guild_id=? AND name=?').run(roleId||null,gid,name);
  db.prepare('DELETE FROM linked_roles WHERE guild_id=? AND name=?').run(gid,name);
  if(roleId)db.prepare('INSERT INTO linked_roles(guild_id,role_id,name,level,created_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,role_id) DO UPDATE SET name=excluded.name,level=excluded.level').run(gid,roleId,name,level,now());
  clearRankCache(gid);
}
function syncLinkedLevels(gid){
  for(const h of systemRows(gid))if(h.role_id)db.prepare('UPDATE linked_roles SET level=?,name=? WHERE guild_id=? AND role_id=?').run(h.level,h.name,gid,h.role_id);
  clearRankCache(gid);
}
function roleRank(gid,uid){
  const rows=db.prepare('SELECT role_id,level FROM linked_roles WHERE guild_id=?').all(gid);
  if(!rows.length)return -1;
  const m=guildOf(gid)?.members?.cache?.get(uid);if(!m)return -1;
  let best=-1;for(const r of rows)if(m.roles.cache.has(r.role_id)&&r.level>best)best=r.level;
  return best;
}
function levelOptions(gid){
  const seen=new Set();
  return hierarchyRows(gid).filter(x=>{const k=String(x.level);if(seen.has(k))return false;seen.add(k);return true;})
    .slice(0,25).map(x=>({label:`${x.name} · ${x.level}`,value:String(x.level),description:x.system?'accès interne':'rôle de l’échelle'}));
}
function ladderText(gid,guild=null){
  const rows=hierarchyRows(gid);
  if(!rows.length)return 'Aucun niveau.';
  return rows.map(x=>{
    const tag=x.role_id?`<@&${x.role_id}>`:(x.system?'_accès interne_':'rôle supprimé');
    return `\`${String(x.level).padStart(3,' ')}\` ${x.system?'🔒':'🎭'} **${x.name}** · ${tag}`;
  }).join('\n');
}
function ladderPanel(gid){
  return [
    row(roleSel('tier:add')),
    row(btn('tier:refresh','Rafraîchir'),btn('tier:remove','Retirer un rôle',ButtonStyle.Danger),btn('tier:system','Accès internes'))
  ];
}

// Presets couleurs
const COLOR_PRESETS={
  'Océan':{color:'#1F6FEB',ok:'#2DD4BF',warn:'#38BDF8',error:'#F87171'},
  'Violet':{color:'#8B5CF6',ok:'#A78BFA',warn:'#C4B5FD',error:'#F87171'},
  'Rouge':{color:'#EF4444',ok:'#FCA5A5',warn:'#FDBA74',error:'#B91C1C'},
  'Émeraude':{color:'#10B981',ok:'#34D399',warn:'#FDE047',error:'#EF4444'},
  'Or':{color:'#F59E0B',ok:'#FCD34D',warn:'#FBBF24',error:'#DC2626'},
  'Sombre':{color:'#2B2D31',ok:'#4E5058',warn:'#6B7280',error:'#991B1B'},
  'Rose':{color:'#EC4899',ok:'#F9A8D4',warn:'#FBCFE8',error:'#BE123C'}
};
const SETTING_SCOPES=['GLOBAL','ROLE','WL','USER','COMMAND'];
function settingSet(gid,scope,scopeId,key,value){
  if(!SETTING_SCOPES.includes(scope))throw new Error('Portée inconnue.');
  db.prepare('INSERT INTO settings(guild_id,scope,scope_id,key,value) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,scope,scope_id,key) DO UPDATE SET value=excluded.value').run(gid,scope,String(scopeId||'*'),key,json({v:value}));
}
function settingDel(gid,scope,scopeId,key){db.prepare('DELETE FROM settings WHERE guild_id=? AND scope=? AND scope_id=? AND key=?').run(gid,scope,String(scopeId||'*'),key);}
function settingGet(gid,scope,scopeId,key){
  const r=db.prepare('SELECT value FROM settings WHERE guild_id=? AND scope=? AND scope_id=? AND key=?').get(gid,scope,String(scopeId||'*'),key);
  return r?parse(r.value).v:undefined;
}
function resolveSetting(gid,key,ctx={}){
  let out=settingGet(gid,'GLOBAL','*',key);
  const m=ctx.member||(ctx.uid?guildOf(gid)?.members?.cache?.get(ctx.uid):null);
  if(m){
    const roles=[...m.roles.cache.values()].sort((a,b)=>a.position-b.position);
    for(const r of roles){const v=settingGet(gid,'ROLE',r.id,key);if(v!==undefined)out=v;}
  }
  if(ctx.uid){
    const lvl=rank(gid,ctx.uid);
    if(lvl>=0){const v=settingGet(gid,'WL',String(lvl),key);if(v!==undefined)out=v;}
    const u=settingGet(gid,'USER',ctx.uid,key);if(u!==undefined)out=u;
  }
  if(ctx.command){const v=settingGet(gid,'COMMAND',ctx.command,key);if(v!==undefined)out=v;}
  return out;
}
function themeFor(gid,ctx={}){
  const c=cfg(gid);
  const preset=COLOR_PRESETS[resolveSetting(gid,'preset',ctx)||'']||null;
  const u=ctx.uid?db.prepare('SELECT * FROM user_ui WHERE guild_id=? AND user_id=?').get(gid,ctx.uid):null;
  return {
    color:color(resolveSetting(gid,'color',ctx)||u?.color||preset?.color,c.ui.color),
    ok:color(preset?.ok,c.ui.ok),warn:color(preset?.warn,c.ui.warn),error:color(preset?.error,c.ui.error),
    footer:resolveSetting(gid,'footer',ctx)||u?.footer||c.ui.footer,
    image:resolveSetting(gid,'image',ctx)||u?.image||c.ui.image||null
  };
}


// Arborescence logs
const LOG_TREE=[
  ['Logs · Sanctions',[['wet','wet-log'],['bl','bl-log'],['ban','ban-log'],['badword','badword-log'],['clear','clear-log']]],
  ['Logs · Rôles & Accès',[['role','role-log'],['wl','wl-log'],['perm','perm-log'],['abo','abo-log'],['autorole','autorole-log']]],
  ['Logs · Économie',[['contrib','contrib-log'],['vente','vente-log'],['paiement','paiement-log']]],
  ['Logs · Tickets',[['ticket','ticket-logs']]],
  ['Logs · Serveur',[['membre','membre-log'],['salon','salon-log'],['commande','commande-log'],['backup','backup-log'],['bataillon','bataillon-log'],['sante','sante-log']]],
  ['Logs · Fun & Vocal',[['dog','dog-log'],['giveaway','giveaway-log'],['musique','musique-log']]]
];
const LOG_NAMES=new Map(LOG_TREE.flatMap(([,ch])=>ch));
const LEGACY_LOG={'modération':'ban','accès':'wl','rôles':'role','tickets':'ticket','paiements':'paiement','musique':'musique','système':'sante'};
function logKey(category){return LOG_NAMES.has(category)?category:(LEGACY_LOG[category]||'sante');}
function logChannel(g,key){
  const rec=db.prepare('SELECT channel_id FROM log_channels WHERE guild_id=? AND key=?').get(g.id,key);
  return rec?.channel_id?g.channels.cache.get(rec.channel_id)||null:null;
}
function mirrorChannel(g,key){
  const rec=db.prepare('SELECT mirror_id FROM log_channels WHERE guild_id=? AND key=?').get(g.id,key);
  if(rec?.mirror_id)return g.channels.cache.get(rec.mirror_id)||null;
  const d=cfg(g.id).configuration?.destinations||{};
  const id=d.serverLogs||d.moderator||null;
  return id?g.channels.cache.get(id)||null:null;
}
function setMirror(gid,key,channelId){
  db.prepare('INSERT INTO log_channels(guild_id,key,channel_id,category_id,mirror_id,created_at) VALUES(?,?,NULL,NULL,?,?) ON CONFLICT(guild_id,key) DO UPDATE SET mirror_id=excluded.mirror_id').run(gid,key,channelId||null,now());
}
async function ensureLogTree(g){
  const me=g?.members?.me;
  if(!me?.permissions?.has(PermissionFlagsBits.ManageChannels))return {created:0,kept:0};
  let created=0,kept=0;
  const hide=[{id:g.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]},{id:me.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.ReadMessageHistory]}];
  for(const [catName,chans] of LOG_TREE){
    let cat=g.channels.cache.find(c=>c.type===ChannelType.GuildCategory&&c.name===catName)||null;
    if(!cat){cat=await g.channels.create({name:catName,type:ChannelType.GuildCategory,permissionOverwrites:hide,reason:'DREAM logs'}).catch(()=>null);if(cat)created++;}
    if(!cat)continue;
    for(const [key,name] of chans){
      const rec=db.prepare('SELECT * FROM log_channels WHERE guild_id=? AND key=?').get(g.id,key);
      let ch=rec?.channel_id?g.channels.cache.get(rec.channel_id):null;
      if(!ch)ch=g.channels.cache.find(c=>c.type===ChannelType.GuildText&&c.name===name&&c.parentId===cat.id)||null;
      if(!ch){ch=await g.channels.create({name,type:ChannelType.GuildText,parent:cat.id,permissionOverwrites:hide,reason:'DREAM logs'}).catch(()=>null);if(ch)created++;}
      else{
        kept++;
        if(ch.parentId!==cat.id)await ch.setParent(cat.id,{lockPermissions:false,reason:'DREAM logs'}).catch(()=>{});
        await ch.permissionOverwrites.edit(g.roles.everyone,{ViewChannel:false,SendMessages:false},'DREAM logs').catch(()=>{});
      }
      if(ch)db.prepare('INSERT INTO log_channels(guild_id,key,channel_id,category_id,mirror_id,created_at) VALUES(?,?,?,?,NULL,?) ON CONFLICT(guild_id,key) DO UPDATE SET channel_id=excluded.channel_id,category_id=excluded.category_id').run(g.id,key,ch.id,cat.id,now());
    }
  }
  return {created,kept};
}
async function logTo(g,category,o={}){
  if(!g)return null;
  const key=logKey(category);
  let ch=logChannel(g,key);
  if(!ch){await ensureLogTree(g);ch=logChannel(g,key);}
  const fields=o.fields||(o.actor?[{name:'Membre',value:`<@${o.actor}>`,inline:true},{name:'Résultat',value:o.result||'OK',inline:true}]:[]);
  const payload={embeds:[embed(g.id,{title:o.title,description:o.description||'—',fields,timestamp:true})],allowedMentions:{parse:[]}};
  let message=null;
  if(ch)message=await ch.send(payload).catch(()=>null);
  if(message)db.prepare('INSERT OR REPLACE INTO log_messages(guild_id,message_id,channel_id,category,title,description,actor_id,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(g.id,message.id,ch.id,key,o.title||'Log',o.description||'—',o.actor||null,o.result||'OK',now());
  if(o.mirror!==false){const m=mirrorChannel(g,key);if(m&&m.id!==ch?.id)await m.send(payload).catch(()=>{});}
  return message;
}

// Tableaux permanents
const PAY_ICON={'En attente':'🕗','Payé':'✅','Refusé':'⛔','Remboursé':'↩️','À vérifier':'🔎'};
const PAY_STATUS=Object.keys(PAY_ICON);
const TABLE_DEFS=[
  ['acces','🔐 Tableau des accès'],
  ['commandes','📋 Tableau des commandes'],
  ['wl','🛡️ Tableau WL'],
  ['hierarchie','📚 Tableau hiérarchie'],
  ['protect','🛰️ Tableau Protect'],
  ['paiements','💳 Tableau paiements'],
  ['prix','💰 Tableau prix'],
  ['roles','🎨 Tableau rôles'],
  ['config','⚙️ Tableau configuration']
];
const TABLE_CATEGORY='Tableaux · DREAM';
function cut(list,max=20){const a=[...list];return a.length>max?a.slice(0,max).concat([`… ${a.length-max} de plus`]):a;}
function tableBody(g,key){
  const gid=g.id,cur=cfg(gid).payment.currency;
  if(key==='acces'){
    const rows=db.prepare('SELECT user_id,kind,level FROM wl WHERE guild_id=? ORDER BY level DESC').all(gid);
    return cut(rows.map(x=>`<@${x.user_id}> — **${levelLabel(gid,x.level)}** · ${x.kind}`)).join('\n')||'Aucun accès enregistré.';
  }
  if(key==='commandes'){
    ensureCommandConfig(gid);
    const rows=db.prepare('SELECT * FROM command_config WHERE guild_id=? ORDER BY command').all(gid);
    const perms=[...new Set([...Object.keys(CMD_DEFAULT_LEVEL),...db.prepare('SELECT command FROM command_permissions WHERE guild_id=?').all(gid).map(x=>x.command)])].sort();
    return [cut(rows.map(x=>`${x.active?'🟢':'🔴'} **${COMMAND_LABEL.get(x.command)||x.command}**${x.channel_id?` · <#${x.channel_id}>`:''}`),12).join('\n')||'Aucune commande.','',cut(perms.map(c=>cmdRuleText(gid,c)),14).join('\n')].join('\n');
  }
  if(key==='wl'){
    const kinds=db.prepare('SELECT kind,COUNT(*) AS n FROM wl WHERE guild_id=? GROUP BY kind ORDER BY kind').all(gid);
    const roleWl=db.prepare('SELECT grade,COUNT(*) AS n FROM wl_role WHERE guild_id=? GROUP BY grade').all(gid);
    return [kinds.map(x=>`**${x.kind}** — ${x.n}`).join('\n')||'Aucune WL.','',roleWl.map(x=>`WL rôle **${x.grade}** — ${x.n}`).join('\n')||'Aucune WL rôle.'].join('\n');
  }
  if(key==='hierarchie')return hierarchyRows(gid).map(x=>`**${x.level}** · ${x.name}${x.role_id?` → <@&${x.role_id}>`:''}`).join('\n')||'Hiérarchie vide.';
  if(key==='protect'){
    const roles=db.prepare('SELECT role_id FROM protected_roles WHERE guild_id=?').all(gid);
    const chans=db.prepare('SELECT channel_id,min_level FROM protected_channels WHERE guild_id=?').all(gid);
    const em=db.prepare('SELECT * FROM emergency WHERE guild_id=?').get(gid);
    return [`Protection rôles : **${cfg(gid).roles.protect?'active':'inactive'}**`,`Verrouillage d'urgence : **${em?.active?'ACTIF':'inactif'}**`,'',`**Rôles protégés**\n${cut(roles.map(x=>`<@&${x.role_id}>`),10).join(' ')||'Aucun'}`,'',`**Salons réservés**\n${cut(chans.map(x=>`<#${x.channel_id}> — ${levelLabel(gid,x.min_level)}`),10).join('\n')||'Aucun'}`].join('\n');
  }
  if(key==='paiements'){
    const rows=db.prepare('SELECT status,COUNT(*) AS n,SUM(amount) AS total FROM payments WHERE guild_id=? GROUP BY status').all(gid);
    const last=db.prepare('SELECT * FROM payments WHERE guild_id=? ORDER BY created_at DESC LIMIT 8').all(gid);
    const max=Math.max(1,...rows.map(x=>x.n));
    const encaisse=rows.filter(x=>x.status==='Payé').reduce((a,x)=>a+(x.total||0),0);
    return [
      kv([['Encaissé',money(encaisse,cur)],['Lignes',rows.reduce((a,x)=>a+x.n,0)]]),
      '',
      rows.map(x=>`${PAY_ICON[x.status]||'•'} ${bar(x.n,max,8)} **${x.status}** · ${x.n} · ${money(x.total,cur)}`).join('\n')||'Aucun paiement.',
      '',
      '**Derniers mouvements**',
      last.map(x=>`${PAY_ICON[x.status]||'•'} <@${x.user_id}> · ${x.label} · ${money(x.amount,cur)}`).join('\n')||'—'
    ].join('\n');
  }
  if(key==='prix'){
    const rows=db.prepare('SELECT * FROM prices WHERE guild_id=? AND active=1 ORDER BY amount DESC').all(gid);
    return cut(rows.map(x=>`**${x.label}** — ${x.amount/100}${cur}`)).join('\n')||'Aucun prix configuré.';
  }
  if(key==='roles'){
    const rows=db.prepare('SELECT * FROM role_meta WHERE guild_id=? ORDER BY wl_level DESC').all(gid);
    return cut(rows.map(x=>`<@&${x.role_id}> — ${x.type}${x.interaction?' · réaction':''}`)).join('\n')||'Aucun rôle géré.';
  }
  if(key==='config'){
    const c=cfg(gid),d=c.configuration?.destinations||{};
    const logs=db.prepare('SELECT COUNT(*) AS n FROM log_channels WHERE guild_id=? AND channel_id IS NOT NULL').get(gid)?.n||0;
    const tables=db.prepare('SELECT COUNT(*) AS n FROM panels WHERE guild_id=? AND message_id IS NOT NULL').get(gid)?.n||0;
    const tiers=tierRows(gid).length;
    return [
      kv([
        ['Préfixes',c.prefixes.map(p=>'`'+p+'`').join(' ')],
        ['Thème',`${resolveSetting(gid,'preset')||'personnalisé'} · ${c.ui.color}`],
        ['Rôles sur l’échelle',tiers||'aucun'],
        ['Protection des rôles',c.roles.protect?'🟢 active':'🔴 inactive']
      ]),
      '',
      `${bar(logs,LOG_NAMES.size,10)} Salons de logs **${logs}/${LOG_NAMES.size}**`,
      `${bar(tables,TABLE_DEFS.length,10)} Tableaux **${tables}/${TABLE_DEFS.length}**`,
      '',
      kv([
        ['Bienvenue',d.welcome?`<#${d.welcome}>`:'non défini'],
        ['Tickets',d.ticket?`<#${d.ticket}>`:'non défini'],
        ['Modération',d.moderator?`<#${d.moderator}>`:'non défini'],
        ['Statistiques',c.stats.channelId?`<#${c.stats.channelId}>`:'non défini']
      ])
    ].join('\n');
  }
  return '—';
}
async function tablesChannel(g){
  const rec=db.prepare("SELECT channel_id FROM panels WHERE guild_id=? AND key='__channel'").get(g.id);
  let ch=rec?.channel_id?g.channels.cache.get(rec.channel_id):null;
  if(ch)return ch;
  if(!g.members?.me?.permissions?.has(PermissionFlagsBits.ManageChannels))return null;
  const hide=[{id:g.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]}];
  let cat=g.channels.cache.find(c=>c.type===ChannelType.GuildCategory&&c.name===TABLE_CATEGORY)||null;
  if(!cat)cat=await g.channels.create({name:TABLE_CATEGORY,type:ChannelType.GuildCategory,permissionOverwrites:hide,reason:'DREAM tableaux'}).catch(()=>null);
  ch=g.channels.cache.find(c=>c.type===ChannelType.GuildText&&c.name==='tableaux'&&c.parentId===cat?.id)||null;
  if(!ch)ch=await g.channels.create({name:'tableaux',type:ChannelType.GuildText,parent:cat?.id||null,permissionOverwrites:hide,reason:'DREAM tableaux'}).catch(()=>null);
  if(ch)db.prepare("INSERT INTO panels(guild_id,key,channel_id,message_id,updated_at) VALUES(?,'__channel',?,NULL,?) ON CONFLICT(guild_id,key) DO UPDATE SET channel_id=excluded.channel_id,updated_at=excluded.updated_at").run(g.id,ch.id,now());
  return ch;
}
async function refreshTables(g){
  if(!g)return 0;
  const ch=await tablesChannel(g);if(!ch)return 0;
  let n=0;
  for(const [key,title] of TABLE_DEFS){
    let body='—';
    try{body=tableBody(g,key);}catch{body='Tableau indisponible.';}
    const e=embed(g.id,{title,description:String(body).slice(0,4000),footer:`Mis à jour • ${new Date().toLocaleString('fr-FR')}`});
    const rec=db.prepare('SELECT * FROM panels WHERE guild_id=? AND key=?').get(g.id,key);
    let msg=rec?.message_id?await ch.messages.fetch(rec.message_id).catch(()=>null):null;
    if(msg)await msg.edit({embeds:[e]}).catch(()=>{msg=null;});
    if(!msg)msg=await ch.send({embeds:[e]}).catch(()=>null);
    if(msg){db.prepare('INSERT INTO panels(guild_id,key,channel_id,message_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,key) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id,updated_at=excluded.updated_at').run(g.id,key,ch.id,msg.id,now());n++;}
  }
  return n;
}
async function runSetup(g,actorId){
  ensureHierarchy(g.id);
  ensureCommandConfig(g.id);
  syncLinkedLevels(g.id);
  const steps=[];
  const tree=await ensureLogTree(g);
  steps.push(['Logs',`${tree.created} créé${tree.created>1?'s':''} · ${tree.kept} déjà en place`]);
  await autoSetup(g).catch(()=>{});
  steps.push(['Salons','destinations vérifiées']);
  const tables=await refreshTables(g);
  steps.push(['Tableaux',`${tables}/${TABLE_DEFS.length} à jour`]);
  await repairLocks(g).catch(()=>{});
  await updateStats(g).catch(()=>{});
  const checked=await protectRoles(g).catch(()=>0);
  steps.push(['Rôles',`${checked} membre${checked>1?'s':''} vérifié${checked>1?'s':''}`]);
  pruneHistory(g.id);
  const issues=await startupCheck(g).catch(()=>[]);
  audit(g.id,actorId,'setup',null,{steps:steps.length});
  return {steps,issues,tiers:tierRows(g.id).length};
}
function setupEmbed(g,uid,result){
  return embedFor(g.id,uid,{
    title:'🚀 Mise en place terminée',
    description:kv(result.steps),
    fields:[
      {name:result.issues.length?'⚠️ À regarder':'✅ Tout est en place',value:result.issues.length?bullets(result.issues):'Aucun point bloquant.',inline:false},
      ...(result.tiers?[]:[{name:'🎭 Prochaine étape',value:'Aucun rôle sur l’échelle. Lance `=hierarchie` et place tes rôles.',inline:false}])
    ],
    timestamp:true
  });
}
const tableTimers=new Map();
function scheduleTables(g){
  if(!g||tableTimers.has(g.id))return;
  tableTimers.set(g.id,setTimeout(async()=>{tableTimers.delete(g.id);try{await refreshTables(g);}catch{}},4000));
}


// DM sanctions
const DM_TITLES={BL:'🛡️ Sanction',UNBL:'✅ Bonne nouvelle',BAN:'🛡️ Sanction',UNBAN:'✅ Bonne nouvelle',DERANK:'📉 Accès retirés',WET:'🛡️ Sanction',ACCESS_ADD:'🔑 Nouvel accès',ACCESS_DEL:'🔑 Accès retiré',ABO:'💳 Abonnement'};
const DM_BODY={
  BL:(g,o)=>`Tu as été blacklist de **${g.name}** ${o.duration||'définitivement'}.`,
  UNBL:g=>`Ta blacklist sur **${g.name}** a été retirée. Tu peux revenir tranquillement.`,
  BAN:g=>`Tu as été banni de **${g.name}**.`,
  UNBAN:g=>`Ton bannissement sur **${g.name}** a été levé.`,
  DERANK:g=>`Tes accès sur **${g.name}** ont été retirés.`,
  WET:g=>`Tu as été WET depuis **${g.name}**. L'accès est coupé partout.`,
  ACCESS_ADD:(g,o)=>`Tu as reçu l'accès **${o.label}** sur **${g.name}**. Bienvenue dans l'équipe.`,
  ACCESS_DEL:(g,o)=>`Ton accès **${o.label}** sur **${g.name}** a été retiré.`,
  ABO:(g,o)=>`Ton abonnement **${o.label}** sur **${g.name}** est actif.`
};
const DM_GOOD=new Set(['UNBL','UNBAN','ACCESS_ADD','ABO']);
async function notify(guild,userId,kind,o={}){
  if(!guild||!userId||resolveSetting(guild.id,'dm',{uid:userId})===false)return false;
  const body=DM_BODY[kind];if(!body)return false;
  const user=await clients.two.users.fetch(userId).catch(()=>null);if(!user)return false;
  const lines=[body(guild,o)];
  if(o.reason)lines.push(`Raison : ${o.reason}`);
  lines.push(DM_GOOD.has(kind)?'À bientôt sur le serveur.':"Si tu penses qu'il s'agit d'une erreur, contacte un gérant.");
  const sent=await user.send({embeds:[embed(guild.id,{title:DM_TITLES[kind],description:lines.join('\n\n'),footer:guild.name})]}).catch(()=>null);
  return !!sent;
}

// Garde-fous
const cooldowns=new Map();
function cooldown(key,ms){
  const until=cooldowns.get(key)||0;
  if(until>now())throw new Error(`Patiente ${Math.ceil((until-now())/1000)} s avant de recommencer.`);
  cooldowns.set(key,now()+ms);
}
const rateWindows=new Map();
function rateLimit(key,limit,windowMs){
  const arr=(rateWindows.get(key)||[]).filter(t=>t>now()-windowMs);
  arr.push(now());rateWindows.set(key,arr);
  if(arr.length>limit)throw new Error("Trop d'actions d'un coup. Réessaie dans un instant.");
}
function audit(gid,actorId,action,target=null,data=null){
  try{db.prepare('INSERT INTO audit(guild_id,actor_id,action,target,data,created_at) VALUES(?,?,?,?,?,?)').run(gid,String(actorId||'system'),action,target?String(target):null,json(data||{}),now());}catch{}
}
function pruneAudit(){try{db.prepare('DELETE FROM audit WHERE created_at<?').run(now()-30*24*60*60*1000);}catch{}}
function pruneHistory(gid){
  try{
    db.prepare('DELETE FROM log_messages WHERE guild_id=? AND created_at<?').run(gid,now()-30*24*60*60*1000);
    db.prepare('DELETE FROM log_messages WHERE guild_id=? AND message_id NOT IN (SELECT message_id FROM log_messages WHERE guild_id=? ORDER BY created_at DESC LIMIT 2000)').run(gid,gid);
    db.prepare('DELETE FROM pending_sanctions WHERE guild_id=? AND expires_at<?').run(gid,now());
    db.prepare("DELETE FROM mass_ops WHERE guild_id=? AND status<>'pending' AND created_at<?").run(gid,now()-7*24*60*60*1000);
    db.prepare("DELETE FROM giveaways WHERE guild_id=? AND status='done' AND ends_at<?").run(gid,now()-30*24*60*60*1000);
    db.prepare('DELETE FROM embeds WHERE guild_id=? AND updated_at<?').run(gid,now()-7*24*60*60*1000);
    db.prepare('DELETE FROM subs WHERE guild_id=? AND until IS NOT NULL AND until<?').run(gid,now());
  }catch{}
}
function emergencyOn(gid){return !!db.prepare('SELECT 1 FROM emergency WHERE guild_id=? AND active=1').get(gid);}
async function emergencySet(g,actorId,reason,active){
  const me=g.members?.me;
  if(!me?.permissions?.has(PermissionFlagsBits.ManageChannels))throw new Error('Permission « Gérer les salons » manquante.');
  const texts=[...g.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText||c.type===ChannelType.GuildAnnouncement);
  for(const ch of texts){
    if(active){
      await ch.permissionOverwrites.edit(g.roles.everyone,{SendMessages:false},'DREAM urgence').catch(()=>{});
      db.prepare("INSERT OR IGNORE INTO locks(guild_id,channel_id,created_at,source) VALUES(?,?,?,'emergency')").run(g.id,ch.id,now());
    }else if(db.prepare("SELECT 1 FROM locks WHERE guild_id=? AND channel_id=? AND source='emergency'").get(g.id,ch.id)){
      await ch.permissionOverwrites.edit(g.roles.everyone,{SendMessages:null},'DREAM urgence levée').catch(()=>{});
      db.prepare("DELETE FROM locks WHERE guild_id=? AND channel_id=? AND source='emergency'").run(g.id,ch.id);
    }
  }
  db.prepare('INSERT INTO emergency(guild_id,active,actor_id,reason,created_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET active=excluded.active,actor_id=excluded.actor_id,reason=excluded.reason,created_at=excluded.created_at').run(g.id,active?1:0,String(actorId||'system'),reason||'—',now());
  audit(g.id,actorId,active?'emergency.on':'emergency.off',null,{reason});
  await logTo(g,'sante',{title:active?'🚨 Verrouillage d\'urgence':'✅ Urgence levée',description:`${active?'Tous les salons écrits sont verrouillés.':'Les salons sont déverrouillés.'}\nRaison : ${reason||'—'}`,actor:actorId});
  scheduleTables(g);
  return texts.length;
}
const burst=new Map();
function burstHit(gid,kind,limit,windowMs){
  const key=`${gid}:${kind}`;
  const arr=(burst.get(key)||[]).filter(t=>t>now()-windowMs);
  arr.push(now());burst.set(key,arr);
  return arr.length>limit;
}
async function guardBurst(g,kind,actorId,limit,windowMs,label){
  if(!burstHit(g.id,kind,limit,windowMs))return false;
  burst.set(`${g.id}:${kind}`,[]);
  audit(g.id,actorId||'inconnu',`burst.${kind}`,null,{limit,windowMs});
  await logTo(g,'salon',{title:'🚨 Activité anormale',description:`${label}\nSeuil : **${limit}** en ${Math.round(windowMs/1000)} s.`,actor:actorId||null,result:'Bloqué'});
  if(!emergencyOn(g.id))await emergencySet(g,actorId||'system',`Activité anormale : ${label}`,true).catch(()=>{});
  return true;
}
async function startupCheck(g){
  const issues=[];
  const me=g.members?.me;
  for(const [key,label] of [['ManageRoles','Gérer les rôles'],['ManageChannels','Gérer les salons'],['BanMembers','Bannir'],['ModerateMembers','Modérer'],['ViewAuditLog','Journal des audits']])
    if(!me?.permissions?.has(PermissionFlagsBits[key]))issues.push(`Permission manquante : ${label}`);
  const missing=[...LOG_NAMES.keys()].filter(k=>!logChannel(g,k));
  if(missing.length)issues.push(`Salons de logs à créer : ${missing.length}`);
  const tables=db.prepare('SELECT COUNT(*) AS n FROM panels WHERE guild_id=? AND message_id IS NOT NULL').get(g.id)?.n||0;
  if(tables<TABLE_DEFS.length)issues.push(`Tableaux à reconstruire : ${TABLE_DEFS.length-tables}`);
  const orphans=db.prepare('SELECT role_id FROM linked_roles WHERE guild_id=?').all(g.id).filter(x=>!g.roles.cache.has(x.role_id));
  for(const o of orphans){db.prepare('DELETE FROM linked_roles WHERE guild_id=? AND role_id=?').run(g.id,o.role_id);db.prepare('UPDATE hierarchy SET role_id=NULL WHERE guild_id=? AND role_id=?').run(g.id,o.role_id);}
  if(orphans.length)issues.push(`Rôles liés supprimés : ${orphans.length}`);
  if(issues.length)await logTo(g,'sante',{title:'🩺 Contrôle de démarrage',description:issues.map(x=>`• ${x}`).join('\n'),result:'Réparation'});
  return issues;
}

// Rôle en masse
const MASS_ROLE_MAX=250;
function massPrepare(g,actorId,role,filterRole){
  if(!canTouchRole(g.id,actorId,role)&&!globalOwner(actorId))throw new Error("Ce rôle n'est pas autorisé par ta WL rôle.");
  if(isProtectedRole(g.id,role))throw new Error('Rôle protégé.');
  const pool=[...g.members.cache.values()].filter(m=>!m.user.bot&&!m.roles.cache.has(role.id)&&(!filterRole||m.roles.cache.has(filterRole.id)));
  if(!pool.length)throw new Error('Aucun membre à mettre à jour dans le cache.');
  if(pool.length>MASS_ROLE_MAX)throw new Error(`Trop de membres (${pool.length}). La limite est de ${MASS_ROLE_MAX}.`);
  const id=`${g.id}-${actorId}-${now()}`;
  db.prepare('INSERT INTO mass_ops(id,guild_id,actor_id,role_id,filter_id,targets,done,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,g.id,actorId,role.id,filterRole?.id||null,json(pool.map(m=>m.id)),json([]),'pending',now());
  return {id,count:pool.length};
}
async function massRun(g,id,actorId){
  const op=db.prepare('SELECT * FROM mass_ops WHERE id=? AND guild_id=?').get(id,g.id);
  if(!op||op.status!=='pending')throw new Error('Opération introuvable ou déjà traitée.');
  if(op.actor_id!==actorId&&!globalOwner(actorId))throw new Error("Cette opération n'est pas la tienne.");
  const role=g.roles.cache.get(op.role_id);if(!role)throw new Error('Rôle supprimé.');
  const targets=parse(op.targets)||[],done=[];
  db.prepare("UPDATE mass_ops SET status='running' WHERE id=?").run(id);
  for(const uid of targets){
    const m=g.members.cache.get(uid)||await g.members.fetch(uid).catch(()=>null);
    if(!m)continue;
    if(await m.roles.add(role,'DREAM massiveroleadd').then(()=>true).catch(()=>false))done.push(uid);
    await new Promise(r=>setTimeout(r,250));
  }
  db.prepare("UPDATE mass_ops SET status='done',done=? WHERE id=?").run(json(done),id);
  audit(g.id,actorId,'massrole.run',role.id,{count:done.length});
  await logTo(g,'role',{title:'🎨 Rôle ajouté en masse',description:`Rôle : ${role}\nMembres : **${done.length}/${targets.length}**`,actor:actorId});
  scheduleTables(g);
  return done.length;
}
async function massUndo(g,id,actorId){
  const op=db.prepare('SELECT * FROM mass_ops WHERE id=? AND guild_id=?').get(id,g.id);
  if(!op||op.status!=='done')throw new Error('Rien à annuler.');
  const role=g.roles.cache.get(op.role_id);if(!role)throw new Error('Rôle supprimé.');
  const done=parse(op.done)||[];
  for(const uid of done){
    const m=g.members.cache.get(uid)||await g.members.fetch(uid).catch(()=>null);
    if(m)await m.roles.remove(role,'DREAM massiveroleadd annulé').catch(()=>{});
    await new Promise(r=>setTimeout(r,250));
  }
  db.prepare("UPDATE mass_ops SET status='undone' WHERE id=?").run(id);
  audit(g.id,actorId,'massrole.undo',role.id,{count:done.length});
  await logTo(g,'role',{title:'↩️ Rôle en masse annulé',description:`Rôle : ${role}\nMembres : **${done.length}**`,actor:actorId});
  return done.length;
}

// Aide adaptative
const CMD_ACCESS=[
  ['/help','Ce message','base'],
  ['/profil','Ton profil','base'],
  ['/explain','En bref','base'],
  ['/contrib','En détail','base'],
  ['/smash','Smash or pass','base'],
  ['/perm','Rôles','tarifs'],
  ['/acces','Whitelist','tarifs'],
  ['/abo','Abonnements','tarifs'],
  ['=ui','Fiche d\'un membre','outils'],
  ['=default','Chercheur','outils'],
  ['+pic','Image','outils'],
  ['+banner','Bannière','outils'],
  ['=pv','Vocale privée','outils'],
  ['=acces','Accès vocale','outils'],
  ['+ban','Bannir','sanctions'],
  ['+unban','Débannir','sanctions'],
  ['-baninfo','Détail ban','sanctions'],
  ['&bl','Blacklist','sanctions'],
  ['&unbl','Retirer la blacklist','sanctions'],
  ['&blinfo','Détail blacklist','sanctions'],
  ['&derank','Retirer les accès','sanctions'],
  ['/wet','Ban global','sanctions'],
  ['/wet-info','Détail WET','sanctions'],
  ['&clear','Effacer','salons'],
  ['+badword','Mots interdits','salons'],
  ['+lock','Lock','salons'],
  ['+unlock','Unlock','salons'],
  ['&lockall','Tout le serveur','salons'],
  ['/protect','Salons réservés','salons'],
  ['/wl','Donner un accès','acces'],
  ['/addrole','Ajouter un rôle','acces'],
  ['/delrole','Retirer un rôle','acces'],
  ['+massiveroleadd','Rôle en masse','acces'],
  ['/add','Donner','suivi'],
  ['/del','Retirer un rôle','suivi'],
  ['/logs','Transactions','suivi'],
  ['/payment','Paiements','suivi'],
  ['/dog-add','DOG +','fun'],
  ['/dog-del','DOG -','fun'],
  ['/giveaway','Giveaway','fun'],
  ['=logs','Créer les logs','admin'],
  ['=tableaux','Reconstruire les tableaux','admin'],
  ['=reglement','Publier le règlement','admin'],
  ['=panneau','Panneaux de rôles','admin'],
  ['=couleur','Thème du serveur','admin'],
  ['=mirror','Double log','admin'],
  ['=setup','Tout mettre en place','admin'],
  ['=hierarchie','Hiérarchie des rôles','admin'],
  ['=droits','Droits des commandes','admin'],
  ['=urgence','Verrouillage d\'urgence','admin'],
  ['/configuration','Tout configurer','admin']
];
const CMD_GROUPS=[
  ['base','🏠','Pour tout le monde'],
  ['tarifs','💰','Tarifs'],
  ['outils','🧰','Tes outils'],
  ['sanctions','🛡️','Sanctions'],
  ['salons','🧹','Tenir les salons'],
  ['acces','🔑','Donner des accès'],
  ['suivi','📒','Créditer et suivre'],
  ['fun','🎉','Fun'],
  ['admin','⚙️','Administration']
];
function canUse(gid,uid,entry){return allowCmd(gid,uid,entry[0]);}
function helpEmbed(gid,uid){
  ensureCommandConfig(gid);
  const hidden=new Set(db.prepare('SELECT command FROM command_config WHERE guild_id=? AND (active=0 OR visible=0)').all(gid).map(x=>x.command));
  const fields=[];
  let total=0;
  for(const [key,icon,label] of CMD_GROUPS){
    const lines=CMD_ACCESS.filter(e=>e[2]===key&&!hidden.has(e[0].replace(/^[/=+&-]/,''))&&canUse(gid,uid,e)).map(e=>`\`${e[0]}\` ${e[1]}`);
    if(!lines.length)continue;
    total+=lines.length;
    fields.push({name:`${icon} ${label}`,value:lines.join('\n'),inline:false});
  }
  return embedFor(gid,uid,{
    title:'☑️ Tes commandes',
    description:total?'Seules les commandes que tu peux lancer sont listées.':'Aucune commande disponible pour le moment.',
    fields,
    footer:`${levelNameFor(gid,uid)} · ${total} commande${total>1?'s':''}`
  });
}


// Panneaux persistants
async function publishPanel(g,key,title,description,components=[],channel=null){
  const rec=db.prepare('SELECT * FROM panels WHERE guild_id=? AND key=?').get(g.id,key);
  const ch=channel||(rec?.channel_id?g.channels.cache.get(rec.channel_id):null);
  if(!ch)throw new Error('Indique un salon pour ce panneau.');
  const e=embed(g.id,{title,description});
  let msg=rec?.message_id&&rec.channel_id===ch.id?await ch.messages.fetch(rec.message_id).catch(()=>null):null;
  if(msg)await msg.edit({embeds:[e],components}).catch(()=>{msg=null;});
  if(!msg)msg=await ch.send({embeds:[e],components}).catch(()=>null);
  if(!msg)throw new Error('Publication impossible dans ce salon.');
  db.prepare('INSERT INTO panels(guild_id,key,channel_id,message_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,key) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id,updated_at=excluded.updated_at').run(g.id,key,ch.id,msg.id,now());
  return msg;
}
const RULES_DEFAULT='1. Respecte tout le monde.\n2. Pas de pub, pas de spam.\n3. Contenus interdits : zéro tolérance.\n4. Les décisions du staff sont appliquées.\n\nEn validant, tu acceptes le règlement.';
async function publishRules(g,channel=null){
  const text=resolveSetting(g.id,'rules.text')||RULES_DEFAULT;
  const roleId=resolveSetting(g.id,'rules.role')||null;
  const components=roleId?[row(btn('rules:accept',"J'accepte",ButtonStyle.Success))]:[];
  return publishPanel(g,'reglement','📜 Règlement',text,components,channel);
}
async function publishRolePanel(g,key,title,roleIds,channel=null){
  const roles=roleIds.map(id=>g.roles.cache.get(id)).filter(Boolean);
  if(!roles.length)throw new Error('Aucun rôle valide pour ce panneau.');
  settingSet(g.id,'GLOBAL','*',`panel.${key}`,roles.map(r=>r.id));
  const options=roles.slice(0,25).map(r=>({label:r.name.slice(0,100),value:r.id}));
  const menu=new StringSelectMenuBuilder().setCustomId(`rolepanel:${key}`).setPlaceholder('Choisis tes rôles').setMinValues(0).setMaxValues(options.length).addOptions(options);
  return publishPanel(g,`panel-${key}`,title,'Sélectionne ce qui te correspond. Tu peux revenir le changer.',[new ActionRowBuilder().addComponents(menu)],channel);
}

// Tickets
async function ticketTranscript(ch){
  const all=[];let before=null;
  for(let i=0;i<10;i++){
    const batch=await ch.messages.fetch({limit:100,...(before?{before}:{})}).catch(()=>null);
    if(!batch?.size)break;
    all.push(...batch.values());before=batch.last().id;
    if(batch.size<100)break;
  }
  const lines=all.reverse().map(m=>`[${new Date(m.createdTimestamp).toLocaleString('fr-FR')}] ${m.author.tag}: ${m.content||(m.embeds.length?'[embed]':'')}${m.attachments.size?` (${m.attachments.size} fichier(s))`:''}`);
  return lines.join('\n')||'Aucun message.';
}
async function closeTicket(i,reason='—'){
  const t=db.prepare('SELECT * FROM tickets WHERE guild_id=? AND channel_id=? AND status=?').get(i.guildId,i.channelId,'OPEN');
  if(!t)throw new Error("Ce salon n'est pas un ticket ouvert.");
  if(t.creator_id!==i.user.id)requireAccess(i.guildId,i.user.id,'ticket-close',40,'WLTICKET');
  const text=await ticketTranscript(i.channel);
  db.prepare('UPDATE tickets SET status=?,closed_at=?,staff_id=?,reason=?,transcript=? WHERE id=?').run('CLOSED',now(),i.user.id,reason,text.slice(0,200000),t.id);
  const typeLabel=(cfg(i.guildId).ticket.types.find(x=>x[0]===t.type)||[t.type||'autre','Autre'])[1];
  const file=new AttachmentBuilder(Buffer.from(text,'utf8'),{name:`ticket-${t.id}.txt`});
  const fields=[
    {name:'Ticket',value:`#${t.id}`,inline:true},
    {name:'Catégorie',value:typeLabel,inline:true},
    {name:'Utilisateur',value:`<@${t.creator_id}>`,inline:true},
    {name:'Staff',value:`<@${i.user.id}>`,inline:true},
    {name:'Ouvert le',value:new Date(t.created_at).toLocaleString('fr-FR'),inline:true},
    {name:'Motif',value:String(reason).slice(0,1000),inline:false}
  ];
  const ch=logChannel(i.guild,'ticket');
  if(ch)await ch.send({embeds:[embed(i.guildId,{title:'🎫 Ticket fermé',description:`Salon <#${i.channelId}>`,fields})],files:[file],allowedMentions:{parse:[]}}).catch(()=>{});
  const mirror=mirrorChannel(i.guild,'ticket');
  if(mirror&&mirror.id!==ch?.id)await mirror.send({embeds:[embed(i.guildId,{title:'🎫 Ticket fermé',description:`Salon <#${i.channelId}>`,fields})],allowedMentions:{parse:[]}}).catch(()=>{});
  audit(i.guildId,i.user.id,'ticket.close',String(t.id),{reason});
  await i.channel.permissionOverwrites.edit(t.creator_id,{SendMessages:false},'DREAM ticket fermé').catch(()=>{});
  return t;
}

// Giveaways
function parseDuration(v){
  const m=String(v||'').trim().match(/^(\d+)\s*(m|h|j|d)$/i);
  if(!m)return null;
  const n=Number(m[1]),u=m[2].toLowerCase();
  return n*(u==='m'?60e3:u==='h'?3600e3:86400e3);
}
async function openGiveaway(g,channel,creatorId,prize,winners,durationMs){
  const id=`${g.id}-${now()}`;
  const ends=now()+durationMs;
  const msg=await channel.send({embeds:[embed(g.id,{title:'🎁 Giveaway',description:`**${prize}**\n\nGagnants : **${winners}**\nFin : <t:${Math.floor(ends/1000)}:R>`})],components:[row(btn(`gw:join:${id}`,'Participer',ButtonStyle.Success),btn(`gw:list:${id}`,'Participants'))]});
  db.prepare('INSERT INTO giveaways(id,guild_id,channel_id,message_id,prize,winners,ends_at,status,created_by,entries) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,g.id,channel.id,msg.id,prize,winners,ends,'open',creatorId,json([]));
  await logTo(g,'giveaway',{title:'🎁 Giveaway lancé',description:`**${prize}** · ${winners} gagnant(s)\nSalon <#${channel.id}>`,actor:creatorId});
  return id;
}
async function drawGiveaway(gw){
  const g=guildOf(gw.guild_id);if(!g)return;
  const ch=g.channels.cache.get(gw.channel_id);
  const entries=parse(gw.entries)||[];
  const pool=[...entries];const winners=[];
  while(winners.length<gw.winners&&pool.length)winners.push(...pool.splice(Math.floor(Math.random()*pool.length),1));
  db.prepare("UPDATE giveaways SET status='done',entries=? WHERE id=?").run(json(entries),gw.id);
  const text=winners.length?winners.map(x=>`<@${x}>`).join(' '):'Personne n\'a participé.';
  if(ch){
    await ch.send({embeds:[embed(g.id,{title:'🎉 Résultat du giveaway',description:`**${gw.prize}**\n\n${text}`})]}).catch(()=>{});
    const msg=gw.message_id?await ch.messages.fetch(gw.message_id).catch(()=>null):null;
    if(msg)await msg.edit({components:[]}).catch(()=>{});
  }
  await logTo(g,'giveaway',{title:'🎉 Giveaway terminé',description:`**${gw.prize}**\nGagnants : ${text}`,result:`${entries.length} participant(s)`});
}
async function tickGiveaways(){
  for(const gw of db.prepare("SELECT * FROM giveaways WHERE status='open' AND ends_at<=?").all(now()))await drawGiveaway(gw).catch(()=>{});
}

// Fiche membre
function memberCard(g,uid){
  const gid=g.id;
  const wl=db.prepare('SELECT kind,level FROM wl WHERE guild_id=? AND user_id=? ORDER BY level DESC').all(gid,uid);
  const bl=db.prepare('SELECT * FROM bl WHERE guild_id=? AND user_id=?').get(gid,uid);
  const sanc=db.prepare('SELECT type,COUNT(*) AS n FROM sanctions WHERE guild_id=? AND target_id=? GROUP BY type').all(gid,uid);
  const pay=db.prepare('SELECT COUNT(*) AS n,SUM(amount) AS total FROM payments WHERE guild_id=? AND user_id=? AND status=?').get(gid,uid,'Payé');
  const c=db.prepare('SELECT amount FROM contrib WHERE guild_id=? AND user_id=?').get(gid,uid);
  const subsRows=db.prepare('SELECT label,until FROM subs WHERE guild_id=? AND user_id=?').all(gid,uid);
  const cur=cfg(gid).payment.currency;
  const m=g.members?.cache?.get(uid)||null;
  const joined=m?.joinedTimestamp?when(m.joinedTimestamp):null;
  return {
    title:'🪪 Fiche membre',
    description:kv([
      ['Membre',`<@${uid}>`],
      ['Niveau',levelNameFor(gid,uid)],
      ['Arrivée',joined],
      ['État',bl?'⛔ Blacklist':'🟢 Rien à signaler']
    ]),
    thumbnail:m?.displayAvatarURL?.({extension:'png',size:128})||undefined,
    fields:[
      {name:'🔑 Accès',value:wl.map(x=>`${x.kind} · ${levelLabel(gid,x.level)}`).join('\n')||'Aucun',inline:true},
      {name:'💳 Abonnements',value:subsRows.map(x=>`${x.label}${x.until?` · ${when(x.until)}`:''}`).join('\n')||'Aucun',inline:true},
      {name:'🛡️ Sanctions',value:sanc.map(x=>`${sanctionLabel(x.type)} · ${x.n}`).join('\n')||'Aucune',inline:false},
      {name:'📒 Paiements',value:`${pay?.n||0} réglé${(pay?.n||0)>1?'s':''} · ${money(pay?.total,cur)}`,inline:true},
      {name:'➕ Contribution',value:money(c?.amount,cur),inline:true}
    ],
    timestamp:true
  };
}

// Mots interdits
function badwords(gid){return db.prepare('SELECT word FROM badwords WHERE guild_id=?').all(gid).map(x=>x.word);}
function hitBadword(gid,content){
  const low=String(content||'').toLowerCase();
  return badwords(gid).find(w=>low.includes(w))||null;
}
async function enforceBadwords(m){
  if(!m.guild||m.author.bot)return false;
  if(globalOwner(m.author.id)||allowCmd(m.guild.id,m.author.id,'+badword',m.member))return false;
  const hit=hitBadword(m.guild.id,m.content);if(!hit)return false;
  await m.delete().catch(()=>{});
  await logTo(m.guild,'badword',{title:'🚫 Mot interdit',description:`Salon <#${m.channelId}>\nMot : **${hit}**`,actor:m.author.id,result:'Supprimé'});
  return true;
}
async function enforceProtectedChannel(m){
  if(!m.guild||m.author.bot)return false;
  const rec=db.prepare('SELECT min_level FROM protected_channels WHERE guild_id=? AND channel_id=?').get(m.guild.id,m.channelId);
  if(!rec)return false;
  if(globalOwner(m.author.id)||rank(m.guild.id,m.author.id)>=rec.min_level)return false;
  await m.delete().catch(()=>{});
  return true;
}


// Accès par commande
const CMD_DEFAULT_LEVEL={
  '=ui':10,'=default':10,'=pv':10,'=acces':10,'+pic':20,'+banner':20,
  '/addrole':20,'/delrole':20,
  '&derank':30,
  '+ban':40,'+unban':40,'-baninfo':40,'+kick':40,'+timeout':40,'+warn':40,
  '&clear':40,'+badword':40,'/add':40,'/del':40,'=giveaway':40,'/giveaway':40,
  '+lock':50,'+unlock':50,'/protect':50,'/wet':50,'/wet-info':50,'/logs':50,'/payment':50,'message':50,
  '&bl':80,'&unbl':80,'&blinfo':80,'/wl':80,'/dog-add':80,'/dog-del':80,
  '=logs':80,'=tableaux':80,'=reglement':80,'=panneau':80,'=couleur':80,'=mirror':80,
  '&lockall':90,'&unlockall':90,'=urgence':90,'+massiveroleadd':90,'=hierarchie':90,'=droits':90,'=setup':90,'/configuration':90,
  'dream':0,'help':0,'profil':0,'music':0,'stats':0,'ticket':0,'role':0,'prix':0,'giveaways':0,'role-acces':20,
  'addrole':20,'delrole':20,'ticket-close':40,'ui':50,'logs':50,'payment':50,'wl':50,
  'wl-grant':80,'configuration':90,'role-protect':90,'wl-role':90
};
function cmdRule(gid,cmd,fallback=0){
  const row=db.prepare('SELECT min_level,roles FROM command_permissions WHERE guild_id=? AND command=?').get(gid,cmd);
  const roles=row?parse(row.roles):null;
  return {minLevel:row?row.min_level:(CMD_DEFAULT_LEVEL[cmd]??fallback),roles:Array.isArray(roles)?roles.filter(x=>typeof x==='string'):[],custom:!!row};
}
function setCommandPerm(gid,cmd,minLevel,roles){
  const v=Number(minLevel);
  if(!Number.isInteger(v)||v<0||v>998)throw new Error('Niveau invalide.');
  db.prepare('INSERT INTO command_permissions(guild_id,command,min_level,levels,roles,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,command) DO UPDATE SET min_level=excluded.min_level,roles=excluded.roles,updated_at=excluded.updated_at').run(gid,cmd,v,'[]',json(roles||[]),now());
}
function clearCommandPerm(gid,cmd){db.prepare('DELETE FROM command_permissions WHERE guild_id=? AND command=?').run(gid,cmd);}
function allowCmd(gid,uid,cmd,member=null,fallback=0){
  if(globalOwner(uid))return true;
  const explicit=db.prepare('SELECT allow FROM wl_cmd WHERE guild_id=? AND user_id=? AND command=?').get(gid,uid,cmd);
  if(explicit)return !!explicit.allow;
  const r=rank(gid,uid);
  if(r>=ownerLevel(gid))return true;
  const {minLevel,roles}=cmdRule(gid,cmd,fallback);
  if(roles.length){
    const m=member||guildOf(gid)?.members?.cache?.get(uid);
    return !!m&&roles.some(x=>m.roles.cache.has(x));
  }
  return r>=minLevel;
}
function requireCmd(gid,uid,cmd,member=null){
  if(!allowCmd(gid,uid,cmd,member))throw new Error('Accès refusé ou hiérarchie insuffisante.');
  return true;
}
function cmdRuleText(gid,cmd){
  const {minLevel,roles,custom}=cmdRule(gid,cmd);
  const base=roles.length?roles.map(x=>`<@&${x}>`).join(' '):`niveau **${minLevel}** (${levelLabel(gid,minLevel)}) et au-dessus`;
  return `\`${cmd}\` → ${base}${custom?'':' · _par défaut_'}`;
}
function guardTarget(gid,actorId,targetId){
  if(actorId===targetId)throw new Error('Tu ne peux pas te cibler toi-même.');
  if(globalOwner(targetId)&&!globalOwner(actorId))throw new Error('Cible protégée.');
  if(!higher(gid,actorId,targetId))throw new Error('Tu ne peux pas agir sur une personne de niveau égal ou supérieur.');
}
function argsOf(t){
  const parts=t.trim().split(/\s+/);
  return {cmd:parts[0].toLowerCase(),args:parts.slice(1),rest:t.trim().slice(parts[0].length).trim()};
}
async function applyWet(g,actorId,targetId,reason='—'){
  guardTarget(g.id,actorId,targetId);
  const level=Math.max(0,rank(g.id,targetId));
  db.prepare('INSERT INTO wet(guild_id,user_id,level,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET level=excluded.level,updated_at=excluded.updated_at').run(g.id,targetId,level,now(),now());
  db.prepare('INSERT OR IGNORE INTO bl(guild_id,user_id,kind,created_at,reason,actor_id) VALUES(?,?,?,?,?,?)').run(g.id,targetId,'WET',now(),reason,actorId);
  delWL(g.id,targetId);
  await notify(g,targetId,'WET',{reason});
  const mem=await g.members.fetch(targetId).catch(()=>null);
  if(mem)await mem.ban({reason:`DREAM WET • ${reason}`}).catch(()=>{});
  await logTo(g,'wet',{title:'🚫 WET appliqué',description:`<@${targetId}>\nRaison : ${reason}`,actor:actorId});
  audit(g.id,actorId,'wet',targetId,{reason});
  scheduleTables(g);
  return level;
}
function wetList(gid,actorId){
  const r=globalOwner(actorId)?999:rank(gid,actorId);
  return db.prepare('SELECT * FROM wet WHERE guild_id=? ORDER BY level DESC').all(gid).filter(x=>x.level<=r);
}

// Commandes supplémentaires
const EXTRA_PROTECT=/^(?:=logs|=tableaux|=hierarchie|=urgence|=mirror|=couleur|=reglement|=panneau|=default|&clear|&lockall|&unlockall|&bl|&unbl|&derank|\+unban|\+badword|\+massiveroleadd|\/protect|\/wl|\/payment|\/add|\/del|\/wet|\/wet-info|=droits|=setup)(?:\s|$)/i;
async function extraPrefix(m){
  const t=m.content.trim(),gid=m.guild.id,uid=m.author.id;
  if(!/^[=+&\-/]/.test(t))return false;
  const {cmd,args,rest}=argsOf(t);
  const known=new Set(['=help','/help','=logs','=tableaux','=hierarchie','=urgence','=mirror','=couleur','=reglement','=panneau','=default','=giveaway','=smash','&clear','&lockall','&unlockall','&bl','&unbl','&derank','+unban','+badword','+massiveroleadd','/protect','/profil','/explain','/contrib','/perm','/acces','/abo','/logs','/add','/del','/payment','/wl','/wet','/wet-info','=droits','=setup']);
  if(!known.has(cmd))return false;
  if(EXTRA_PROTECT.test(t)&&m.client!==clients.two)return true;
  if(!EXTRA_PROTECT.test(t)&&m.client!==clients.one&&clients.one.guilds.cache.has(gid))return true;
  const g=m.guild,reply=o=>m.reply(typeof o==='string'?{content:o,allowedMentions:{parse:[]}}:{...o,allowedMentions:o.allowedMentions||{parse:[]}});
  cooldown(`${gid}:${uid}:${cmd}`,1500);

  if(cmd==='=help'||cmd==='/help')return !!await reply({embeds:[helpEmbed(gid,uid)]});

  if(cmd==='=logs'){
    requireCmd(gid,uid,'=logs');
    const r=await ensureLogTree(g);
    await logTo(g,'sante',{title:'🗂️ Logs vérifiés',description:kv([['Créés',r.created],['Conservés',r.kept]]),actor:uid});
    scheduleTables(g);
    const present=[...LOG_NAMES.keys()].filter(k=>logChannel(g,k)).length;
    return !!await reply({embeds:[embedFor(gid,uid,{
      title:'🗂️ Logs prêts',
      description:`${bar(present,LOG_NAMES.size,12)} **${present}/${LOG_NAMES.size}** salons\n\n${kv([['Créés',r.created],['Déjà en place',r.kept]])}`,
      fields:LOG_TREE.map(([cat,chans])=>({name:cat,value:chans.map(([k,n])=>`${logChannel(g,k)?'🟢':'🔴'} ${n}`).join('\n'),inline:true})),
      timestamp:true
    })]});
  }
  if(cmd==='=tableaux'){
    requireCmd(gid,uid,'=tableaux');
    const n=await refreshTables(g);
    const ch=db.prepare("SELECT channel_id FROM panels WHERE guild_id=? AND key='__channel'").get(gid)?.channel_id;
    return !!await reply({embeds:[embedFor(gid,uid,{
      title:'📊 Tableaux à jour',
      description:`${bar(n,TABLE_DEFS.length,12)} **${n}/${TABLE_DEFS.length}**${ch?`\n\nIls vivent dans <#${ch}> et se mettent à jour tout seuls.`:''}`,
      fields:[{name:'Contenu',value:TABLE_DEFS.map(([,t])=>t).join('\n'),inline:false}],
      timestamp:true
    })]});
  }
  if(cmd==='=mirror'){
    requireCmd(gid,uid,'=mirror');
    const key=args[0];
    if(!key||!LOG_NAMES.has(key))return !!await reply(`Clés disponibles : ${[...LOG_NAMES.keys()].map(k=>`\`${k}\``).join(' ')}`);
    const target=args[1]==='off'?null:(cleanId(args[1]||'')||m.channelId);
    setMirror(gid,key,target);
    return !!await reply(target?`✅ Double log **${key}** → <#${target}>.`:`✅ Double log **${key}** désactivé.`);
  }
  if(cmd==='=couleur'){
    const names=Object.keys(COLOR_PRESETS);
    if(!args.length)return !!await reply({embeds:[embedFor(gid,uid,{title:'🎨 Couleurs',description:names.map(n=>`**${n}** — ${COLOR_PRESETS[n].color}`).join('\n')+'\n\n`=couleur <nom>` pour le serveur · `=couleur moi <nom>` pour toi.'})]});
    if(args[0].toLowerCase()==='moi'){
      const name=names.find(n=>n.toLowerCase()===args.slice(1).join(' ').toLowerCase());
      if(!name)throw new Error('Preset inconnu.');
      settingSet(gid,'USER',uid,'preset',name);
      return !!await reply(`🎨 Ton thème : **${name}**.`);
    }
    requireCmd(gid,uid,'=couleur');
    const name=names.find(n=>n.toLowerCase()===args.join(' ').toLowerCase());
    if(!name)throw new Error('Preset inconnu.');
    settingSet(gid,'GLOBAL','*','preset',name);
    setCfg(gid,c=>c.ui.color=COLOR_PRESETS[name].color);
    scheduleTables(g);
    return !!await reply(`🎨 Thème du serveur : **${name}**.`);
  }
  if(cmd==='=setup'){
    requireCmd(gid,uid,'=setup');
    cooldown(`${gid}:setup`,60e3);
    const info=await m.reply({embeds:[embedFor(gid,uid,{title:'🚀 Mise en place',description:'Création des salons, des logs et des tableaux…'})]}).catch(()=>null);
    const result=await runSetup(g,uid);
    const payload={embeds:[setupEmbed(g,uid,result)]};
    if(info)await info.edit(payload).catch(()=>{});else await reply(payload);
    return true;
  }
  if(cmd==='=hierarchie'){
    const open=o=>reply({embeds:[embedFor(gid,uid,{title:'📚 Hiérarchie',description:ladderText(gid,g),footer:`Niveaux ${TIER_MIN} à ${TIER_MAX} pour les rôles · au-dessus = accès internes`})],components:allowCmd(gid,uid,'=hierarchie')?ladderPanel(gid):[]});
    if(!args.length)return !!await open();
    requireCmd(gid,uid,'=hierarchie');
    const sub=args[0].toLowerCase();
    if(sub==='ajouter'){
      const role=g.roles.cache.get(cleanId(args[1]||''));
      if(!role)throw new Error('Indique un rôle.');
      setTier(gid,role,args[2],uid);
      audit(gid,uid,'tier.set',role.id,{level:Number(args[2])});
      await logTo(g,'perm',{title:'📚 Niveau attribué',description:`${role} → **${Number(args[2])}**`,actor:uid});
      scheduleTables(g);
      return !!await open();
    }
    if(sub==='retirer'){
      const roleId=cleanId(args[1]||'');
      const old=delTier(gid,roleId,uid);
      audit(gid,uid,'tier.del',roleId,{level:old.level});
      await logTo(g,'perm',{title:'📚 Niveau retiré',description:`<@&${roleId}> n'a plus de niveau.`,actor:uid});
      scheduleTables(g);
      return !!await open();
    }
    if(sub==='interne'){
      const name=args.slice(1,-1).join(' ').toUpperCase().replace('SYS +','SYS+');
      const roleId=args[args.length-1]==='off'?null:cleanId(args[args.length-1]||'');
      if(roleId&&!g.roles.cache.has(roleId))throw new Error('Rôle introuvable.');
      if(!globalOwner(uid)&&(levelByName(gid,name)??999)>=rank(gid,uid))throw new Error('Accès interne au-dessus du tien.');
      linkHierarchyRole(gid,name,roleId);
      audit(gid,uid,'hierarchy.link',name,{roleId});
      await logTo(g,'perm',{title:'📚 Accès interne lié',description:`**${name}** ${roleId?`→ <@&${roleId}>`:'délié'}`,actor:uid});
      scheduleTables(g);
      return !!await open();
    }
    throw new Error('Utilise `ajouter <@rôle> <niveau>`, `retirer <@rôle>` ou `interne OWNER <@rôle>`.');
  }
  if(cmd==='=droits'){
    const list=[...new Set([...Object.keys(CMD_DEFAULT_LEVEL),...db.prepare('SELECT command FROM command_permissions WHERE guild_id=?').all(gid).map(x=>x.command)])].sort();
    if(!args.length)return !!await reply({embeds:[embedFor(gid,uid,{title:'🔐 Droits des commandes',description:list.map(c=>cmdRuleText(gid,c)).join('\n').slice(0,4000),footer:'=droits <commande> <@rôle…> · =droits <commande> niveau <n> · =droits <commande> defaut'})]});
    requireCmd(gid,uid,'=droits');
    const target=args[0].toLowerCase();
    if(!list.includes(target))throw new Error('Commande inconnue.');
    const sub=(args[1]||'').toLowerCase();
    if(!sub)return !!await reply({embeds:[embedFor(gid,uid,{title:'🔐 Droits',description:cmdRuleText(gid,target)})],components:[row(roleSel(`droits:set:${encodeURIComponent(target)}`)),row(btn(`droits:reset:${encodeURIComponent(target)}`,'Remettre par défaut'))]});
    if(sub==='defaut'||sub==='reset'){
      clearCommandPerm(gid,target);
      audit(gid,uid,'perm.reset',target,null);
      scheduleTables(g);
      return !!await reply(`✅ \`${target}\` revient à son réglage par défaut.`);
    }
    if(sub==='niveau'){
      const v=Number(args[2]);
      if(!globalOwner(uid)&&v>=rank(gid,uid))throw new Error('Tu ne peux pas ouvrir une commande au-dessus de ton niveau.');
      setCommandPerm(gid,target,v,[]);
      audit(gid,uid,'perm.level',target,{level:v});
      await logTo(g,'perm',{title:'🔐 Droits modifiés',description:cmdRuleText(gid,target),actor:uid});
      scheduleTables(g);
      return !!await reply(`✅ ${cmdRuleText(gid,target)}`);
    }
    const roles=args.slice(1).map(x=>cleanId(x)).filter(x=>g.roles.cache.has(x));
    if(!roles.length)throw new Error('Indique des rôles, `niveau <n>` ou `defaut`.');
    if(!globalOwner(uid))for(const r of roles){const t=tierOf(gid,r);if(t&&t.level>=rank(gid,uid))throw new Error('Un de ces rôles est au-dessus de ton niveau.');}
    setCommandPerm(gid,target,cmdRule(gid,target).minLevel,roles);
    audit(gid,uid,'perm.roles',target,{roles});
    await logTo(g,'perm',{title:'🔐 Droits modifiés',description:cmdRuleText(gid,target),actor:uid});
    scheduleTables(g);
    return !!await reply(`✅ ${cmdRuleText(gid,target)}`);
  }
  if(cmd==='=urgence'){
    requireCmd(gid,uid,'=urgence');
    const off=args[0]?.toLowerCase()==='off';
    const n=await emergencySet(g,uid,off?'Levée manuelle':(rest||'Verrouillage manuel'),!off);
    return !!await reply(off?`✅ Urgence levée sur **${n}** salons.`:`🚨 **${n}** salons verrouillés.`);
  }
  if(cmd==='&clear'){
    requireCmd(gid,uid,'&clear');
    rateLimit(`${gid}:${uid}:clear`,5,60e3);
    const n=Math.min(100,Math.max(1,Number(args[0])||50));
    const del=await m.channel.bulkDelete(n+1,true).catch(()=>null);
    await logTo(g,'clear',{title:'🧹 Messages effacés',description:`Salon <#${m.channelId}>\nMessages : **${del?.size||0}**`,actor:uid});
    audit(gid,uid,'clear',m.channelId,{count:del?.size||0});
    const info=await m.channel.send({embeds:[embed(gid,{title:'🧹 Nettoyé',description:`**${del?.size||0}** messages supprimés.`})]}).catch(()=>null);
    if(info)setTimeout(()=>info.delete().catch(()=>{}),6000);
    return true;
  }
  if(cmd==='&lockall'||cmd==='&unlockall'){
    requireCmd(gid,uid,cmd);
    const lock=cmd==='&lockall';
    let n=0;
    for(const ch of g.channels.cache.values()){
      if(ch.type!==ChannelType.GuildText&&ch.type!==ChannelType.GuildAnnouncement)continue;
      if(await ch.permissionOverwrites.edit(g.roles.everyone,{SendMessages:lock?false:null},'DREAM lockall').then(()=>true).catch(()=>false)){
        n++;
        if(lock)db.prepare("INSERT OR IGNORE INTO locks(guild_id,channel_id,created_at,source) VALUES(?,?,?,'lockall')").run(gid,ch.id,now());
        else db.prepare("DELETE FROM locks WHERE guild_id=? AND channel_id=? AND source='lockall'").run(gid,ch.id);
      }
    }
    await logTo(g,'salon',{title:lock?'🔒 Serveur verrouillé':'🔓 Serveur déverrouillé',description:`Salons : **${n}**`,actor:uid});
    audit(gid,uid,lock?'lockall':'unlockall',null,{count:n});
    return !!await reply(lock?`🔒 **${n}** salons verrouillés.`:`🔓 **${n}** salons déverrouillés.`);
  }
  if(cmd==='&bl'||cmd==='&unbl'){
    const add=cmd==='&bl';
    requireCmd(gid,uid,cmd);
    const target=cleanTarget(args[0]);
    if(!target)throw new Error('Indique le membre.');
    guardTarget(gid,uid,target);
    const reason=args.slice(1).join(' ')||'—';
    if(add)db.prepare('INSERT INTO bl(guild_id,user_id,kind,created_at,reason,actor_id) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,user_id,kind) DO UPDATE SET reason=excluded.reason,actor_id=excluded.actor_id').run(gid,target,'BL',now(),reason,uid);
    else db.prepare('DELETE FROM bl WHERE guild_id=? AND user_id=? AND kind=?').run(gid,target,'BL');
    await notify(g,target,add?'BL':'UNBL',{reason:add?reason:null});
    await logTo(g,'bl',{title:add?'⛔ Blacklist ajoutée':'✅ Blacklist retirée',description:`<@${target}>${add?`\nRaison : ${reason}`:''}`,actor:uid});
    audit(gid,uid,add?'bl.add':'bl.del',target,{reason});
    scheduleTables(g);
    return !!await reply(add?'⛔ Blacklist appliquée.':'✅ Blacklist retirée.');
  }
  if(cmd==='&derank'){
    requireCmd(gid,uid,'&derank');
    const target=cleanTarget(args[0]);
    if(!target)throw new Error('Indique le membre.');
    guardTarget(gid,uid,target);
    delWL(gid,target);
    db.prepare('DELETE FROM wl_role WHERE guild_id=? AND user_id=?').run(gid,target);
    clearRankCache(gid,target);
    await notify(g,target,'DERANK',{reason:args.slice(1).join(' ')||null});
    await logTo(g,'wl',{title:'📉 Accès retirés',description:`<@${target}>`,actor:uid});
    audit(gid,uid,'derank',target,null);
    scheduleTables(g);
    return !!await reply('✅ Accès retirés.');
  }
  if(cmd==='+unban'){
    requireCmd(gid,uid,'+unban');
    const target=cleanTarget(args[0]);
    if(!target)throw new Error('Indique un identifiant.');
    await g.bans.remove(target,`DREAM • ${args.slice(1).join(' ')||'—'}`);
    await notify(g,target,'UNBAN',{});
    await logTo(g,'ban',{title:'✅ Débannissement',description:`<@${target}>\nRaison : ${args.slice(1).join(' ')||'—'}`,actor:uid});
    audit(gid,uid,'unban',target,null);
    return !!await reply('✅ Débanni.');
  }
  if(cmd==='+badword'){
    requireCmd(gid,uid,'+badword');
    const sub=(args[0]||'list').toLowerCase();
    if(sub==='list'){const list=badwords(gid);return !!await reply({embeds:[embedFor(gid,uid,{title:'🚫 Mots interdits',description:list.length?list.map(w=>`\`${w}\``).join(' '):'Aucun mot enregistré.'})]});}
    const word=args.slice(1).join(' ').toLowerCase().trim();
    if(!word)throw new Error('Indique le mot.');
    if(sub==='add')db.prepare('INSERT OR IGNORE INTO badwords(guild_id,word,created_at) VALUES(?,?,?)').run(gid,word,now());
    else if(sub==='del')db.prepare('DELETE FROM badwords WHERE guild_id=? AND word=?').run(gid,word);
    else throw new Error('Utilise `add`, `del` ou `list`.');
    await logTo(g,'badword',{title:sub==='add'?'🚫 Mot ajouté':'✅ Mot retiré',description:`\`${word}\``,actor:uid});
    return !!await reply(sub==='add'?'✅ Mot ajouté.':'✅ Mot retiré.');
  }
  if(cmd==='+massiveroleadd'){
    requireCmd(gid,uid,'+massiveroleadd');
    cooldown(`${gid}:${uid}:mass`,60e3);
    const role=g.roles.cache.get(cleanId(args[0]));
    if(!role)throw new Error('Rôle introuvable.');
    const filter=args[1]?g.roles.cache.get(cleanId(args[1])):null;
    await g.members.fetch().catch(()=>{});
    const op=massPrepare(g,uid,role,filter);
    return !!await reply({embeds:[embedFor(gid,uid,{title:'🎨 Rôle en masse',description:`Rôle : ${role}\nMembres concernés : **${op.count}**${filter?`\nFiltre : ${filter}`:''}\n\nConfirme pour appliquer.`})],components:[row(btn(`mass:run:${op.id}`,'Confirmer',ButtonStyle.Danger),btn(`mass:cancel:${op.id}`,'Annuler'))]});
  }
  if(cmd==='/protect'){
    requireCmd(gid,uid,'/protect');
    if((args[0]||'').toLowerCase()==='list'||!args.length){
      const rows=db.prepare('SELECT * FROM protected_channels WHERE guild_id=?').all(gid);
      return !!await reply({embeds:[embedFor(gid,uid,{title:'🛰️ Salons réservés',description:rows.map(x=>`<#${x.channel_id}> — ${levelLabel(gid,x.min_level)}`).join('\n')||'Aucun salon réservé.',footer:'/protect #salon <niveau>'})]});
    }
    const chId=cleanId(args[0])||m.channelId;
    if(!g.channels.cache.has(chId))throw new Error('Salon introuvable.');
    const named=args.slice(1).join(' ');
    if(!named){db.prepare('DELETE FROM protected_channels WHERE guild_id=? AND channel_id=?').run(gid,chId);await logTo(g,'salon',{title:'🛰️ Réservation retirée',description:`<#${chId}>`,actor:uid});scheduleTables(g);return !!await reply('✅ Salon libéré.');}
    const lvl=Number(named)||levelByName(gid,hierarchyRows(gid).find(x=>x.name.toLowerCase()===named.toLowerCase())?.name||'');
    if(lvl==null||Number.isNaN(lvl))throw new Error('Niveau inconnu.');
    if(rank(gid,uid)<999&&lvl>rank(gid,uid))throw new Error('Tu ne peux pas réserver au-dessus de ton niveau.');
    db.prepare('INSERT INTO protected_channels(guild_id,channel_id,min_level,created_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,channel_id) DO UPDATE SET min_level=excluded.min_level').run(gid,chId,lvl,now());
    await logTo(g,'salon',{title:'🛰️ Salon réservé',description:`<#${chId}> — ${levelLabel(gid,lvl)}`,actor:uid});
    scheduleTables(g);
    return !!await reply(`✅ <#${chId}> réservé à **${levelLabel(gid,lvl)}** et au-dessus.`);
  }
  if(cmd==='=reglement'){
    requireCmd(gid,uid,'=reglement');
    const sub=(args[0]||'').toLowerCase();
    if(sub==='texte'){settingSet(gid,'GLOBAL','*','rules.text',rest.slice(6).trim());return !!await reply('✅ Texte du règlement enregistré.');}
    if(sub==='role'){const rid=cleanId(args[1]||'');if(rid&&!g.roles.cache.has(rid))throw new Error('Rôle introuvable.');settingSet(gid,'GLOBAL','*','rules.role',rid||null);return !!await reply(rid?`✅ Rôle d'acceptation : <@&${rid}>.`:'✅ Rôle retiré.');}
    const target=args[0]?g.channels.cache.get(cleanId(args[0])):m.channel;
    await publishRules(g,target||m.channel);
    return !!await reply('📜 Règlement publié.');
  }
  if(cmd==='=panneau'){
    requireCmd(gid,uid,'=panneau');
    const key=(args[0]||'').toLowerCase();
    const titles={regions:'🌍 Régions',profils:'🪪 Rôles de profil',roles:'🎨 Rôles'};
    if(!titles[key])throw new Error('Clés : regions, profils, roles.');
    const ids=args.slice(1).map(x=>cleanId(x)).filter(x=>g.roles.cache.has(x));
    if(!ids.length)throw new Error('Indique au moins un rôle.');
    for(const id of ids)if(isProtectedRole(gid,g.roles.cache.get(id)))throw new Error('Un rôle protégé ne peut pas être public.');
    await publishRolePanel(g,key,titles[key],ids,m.channel);
    return !!await reply('✅ Panneau publié.');
  }
  if(cmd==='=default'){
    requireCmd(gid,uid,'=default');
    const target=cleanTarget(args[0])||uid;
    return !!await reply({embeds:[embedFor(gid,uid,memberCard(g,target))]});
  }
  if(cmd==='/profil'){
    const target=cleanTarget(args[0])||uid;
    if(target!==uid)requireCmd(gid,uid,'=ui');
    return !!await reply({embeds:[embedFor(gid,uid,memberCard(g,target))]});
  }
  if(cmd==='=giveaway'){
    requireCmd(gid,uid,'=giveaway');
    const ms=parseDuration(args[0]);
    const winners=Math.max(1,Math.min(20,Number(args[1])||1));
    const prize=args.slice(2).join(' ');
    if(!ms||!prize)throw new Error('Format : `=giveaway 1h 1 Nitro`.');
    await openGiveaway(g,m.channel,uid,prize.slice(0,200),winners,ms);
    return true;
  }
  if(cmd==='=smash'){
    const target=cleanTarget(args[0]);
    if(!target)throw new Error('Indique un membre.');
    const msg=await m.channel.send({embeds:[embedFor(gid,uid,{title:'🔥 Smash or pass',description:`<@${target}>`})],components:[row(btn('smash:up','Smash',ButtonStyle.Success),btn('smash:down','Pass',ButtonStyle.Danger))],allowedMentions:{parse:[]}});
    db.prepare('INSERT INTO embeds(guild_id,key,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(gid,`smash:${msg.id}`,json({target,up:[],down:[]}),now());
    return true;
  }
  if(cmd==='/explain'||cmd==='/contrib'){
    const short=cmd==='/explain';
    const rows=db.prepare('SELECT * FROM prices WHERE guild_id=? AND active=1 ORDER BY amount DESC').all(gid);
    const cur=cfg(gid).payment.currency;
    const body=short
      ?'Contribuer, c’est soutenir le serveur et débloquer des accès.\n\n`/perm` pour les rôles · `/acces` pour les whitelists · `/abo` pour les abonnements.'
      :`Chaque contribution finance le serveur et ouvre des accès.\n\n**Tarifs actuels**\n${rows.map(x=>`**${x.label}** — ${x.amount/100}${cur}`).join('\n')||'Aucun tarif publié.'}\n\nMoyens de paiement : ${cfg(gid).payment.methods.join(' · ')}`;
    return !!await reply({embeds:[embedFor(gid,uid,{title:short?'💡 En bref':'💡 Contribuer',description:body})]});
  }
  if(cmd==='/perm'||cmd==='/acces'||cmd==='/abo'){
    const cur=cfg(gid).payment.currency;
    const kind=cmd==='/perm'?'perm':cmd==='/acces'?'wl':'abo';
    const rows=db.prepare('SELECT * FROM prices WHERE guild_id=? AND active=1 ORDER BY amount DESC').all(gid).filter(x=>x.key.startsWith(kind));
    const titles={perm:'🔐 Rôles',wl:'🛡️ Whitelist',abo:'💳 Abonnements'};
    return !!await reply({embeds:[embedFor(gid,uid,{title:titles[kind],description:rows.map(x=>`**${x.label}** — ${x.amount/100}${cur}`).join('\n')||'Rien de publié pour le moment.'})]});
  }
  if(cmd==='/logs'){
    requireCmd(gid,uid,'/logs');
    const rows=db.prepare('SELECT * FROM payments WHERE guild_id=? ORDER BY created_at DESC LIMIT 15').all(gid);
    const cur=cfg(gid).payment.currency;
    return !!await reply({embeds:[embedFor(gid,uid,{title:'📒 Transactions',description:rows.map(x=>`${PAY_ICON[x.status]||'•'} <@${x.user_id}> · ${x.label} · ${x.amount/100}${cur}`).join('\n')||'Aucune transaction.'})]});
  }
  if(cmd==='/add'||cmd==='/del'){
    requireCmd(gid,uid,cmd);
    const target=cleanTarget(args[0]);
    if(!target)throw new Error('Indique le membre.');
    if(cmd==='/add'){
      const amount=Math.round(Number(String(args[1]||'').replace(',','.'))*100);
      if(!Number.isFinite(amount)||amount<=0)throw new Error('Montant invalide.');
      db.prepare('INSERT INTO contrib(guild_id,user_id,amount,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET amount=contrib.amount+excluded.amount,updated_at=excluded.updated_at').run(gid,target,amount,now());
      await logTo(g,'contrib',{title:'➕ Contribution',description:`<@${target}> · ${amount/100}${cfg(gid).payment.currency}`,actor:uid});
      audit(gid,uid,'contrib.add',target,{amount});
      scheduleTables(g);
      return !!await reply('✅ Contribution enregistrée.');
    }
    const role=g.roles.cache.get(cleanId(args[1]||''));
    if(!role)throw new Error('Rôle introuvable.');
    if(!canTouchRole(gid,uid,role)&&!globalOwner(uid))throw new Error('Rôle non autorisé.');
    guardTarget(gid,uid,target);
    const mem=await g.members.fetch(target).catch(()=>null);
    if(!mem)throw new Error('Membre introuvable.');
    await mem.roles.remove(role,'DREAM del');
    await logTo(g,'role',{title:'➖ Rôle retiré',description:`<@${target}> · ${role}`,actor:uid});
    return !!await reply('✅ Rôle retiré.');
  }
  if(cmd==='/payment'){
    requireCmd(gid,uid,'/payment');
    const sub=(args[0]||'').toLowerCase();
    const cur=cfg(gid).payment.currency;
    if(sub==='add'){
      const target=cleanTarget(args[1]);
      const amount=Math.round(Number(String(args[2]||'').replace(',','.'))*100);
      const label=args.slice(3).join(' ')||'Paiement';
      if(!target||!Number.isFinite(amount)||amount<=0)throw new Error('Format : `/payment add @membre 10 Nitro`.');
      const info=db.prepare('INSERT INTO payments(guild_id,user_id,label,amount,status,created_at,updated_at,actor_id) VALUES(?,?,?,?,?,?,?,?)').run(gid,target,label.slice(0,100),amount,'En attente',now(),now(),uid);
      await logTo(g,'paiement',{title:'💳 Paiement créé',description:`<@${target}> · ${label} · ${amount/100}${cur}`,actor:uid});
      scheduleTables(g);
      return !!await reply({embeds:[embedFor(gid,uid,{title:'💳 Paiement créé',description:`#${info.lastInsertRowid} · <@${target}> · **${amount/100}${cur}**\nStatut : **En attente**`})],components:[row(sel(`paystatus:${info.lastInsertRowid}`,'Changer le statut',PAY_STATUS.map(s=>({label:s,value:s,emoji:PAY_ICON[s]}))))]});
    }
    const rows=db.prepare('SELECT * FROM payments WHERE guild_id=? ORDER BY created_at DESC LIMIT 12').all(gid);
    return !!await reply({embeds:[embedFor(gid,uid,{title:'💳 Paiements',description:rows.map(x=>`#${x.id} ${PAY_ICON[x.status]||'•'} <@${x.user_id}> · ${x.label} · ${x.amount/100}${cur}`).join('\n')||'Aucun paiement.',footer:'/payment add @membre <montant> <libellé>'})]});
  }
  if(cmd==='/wet'||cmd==='/wet-info'){
    requireCmd(gid,uid,cmd);
    if(cmd==='/wet-info'){
      const rows=wetList(gid,uid);
      return !!await reply({embeds:[embedFor(gid,uid,{title:'🚫 WET',description:rows.map(x=>`<@${x.user_id}> — ${levelLabel(gid,x.level)}`).join('\n')||'Aucun WET visible à ton niveau.',footer:'Les niveaux supérieurs au tien restent masqués.'})]});
    }
    const target=cleanTarget(args[0]);
    if(!target)throw new Error('Indique le membre à WET.');
    const reason=args.slice(1).join(' ')||'—';
    const lvl=await applyWet(g,uid,target,reason);
    return !!await reply(`🚫 WET appliqué à <@${target}> (**${levelLabel(gid,lvl)}**).`);
  }
  if(cmd==='/wl'){
    requireCmd(gid,uid,'/wl');
    return !!await reply({embeds:[embedFor(gid,uid,wlPanel(g))],components:[row(btn('dream:wl','Gérer les accès',ButtonStyle.Primary))]});
  }
  return false;
}


// Slash supplémentaires
const PROTECT_CMDS=new Set(['configuration','setup','wl','wl-role','protect','payment','logs','add','del','wet','wet-info','dog-add','dog-del','tableaux','hierarchie']);
const EXTRA_SLASH=[
  {name:'help',description:'Voir tes commandes'},
  {name:'profil',description:'Voir un profil',options:[{name:'membre',description:'Le membre',type:6,required:false}]},
  {name:'explain',description:'Contribuer, en bref'},
  {name:'contrib',description:'Contribuer, en détail'},
  {name:'perm',description:'Tarifs des rôles'},
  {name:'acces',description:'Tarifs des whitelists'},
  {name:'abo',description:'Tarifs des abonnements'},
  {name:'logs',description:'Voir les transactions'},
  {name:'payment',description:'Gérer les paiements'},
  {name:'protect',description:'Salons réservés',options:[{name:'salon',description:'Le salon',type:7,required:false},{name:'niveau',description:'Niveau minimum',type:3,required:false}]},
  {name:'add',description:'Créditer une contribution',options:[{name:'membre',description:'Le membre',type:6,required:true},{name:'montant',description:'Montant',type:10,required:true}]},
  {name:'del',description:'Retirer un rôle',options:[{name:'membre',description:'Le membre',type:6,required:true},{name:'role',description:'Le rôle',type:8,required:true}]},
  {name:'giveaway',description:'Lancer un giveaway'},
  {name:'smash',description:'Smash or pass',options:[{name:'membre',description:'Le membre',type:6,required:true}]},
  {name:'setup',description:'Tout mettre en place'},
  {name:'tableaux',description:'Reconstruire les tableaux'},
  {name:'hierarchie',description:'Voir la hiérarchie'},
  {name:'addrole',description:'Ajouter un rôle'},
  {name:'delrole',description:'Retirer un rôle'},
  {name:'dog-add',description:'Ajouter à DOG'},
  {name:'dog-del',description:'Retirer de DOG'},
  {name:'wet',description:'Ban global',options:[{name:'membre',description:'Le membre',type:6,required:true},{name:'raison',description:'La raison',type:3,required:false}]},
  {name:'wet-info',description:'Détail WET'}
];
async function extraSlash(i){
  const n=i.commandName,gid=i.guildId,uid=i.user.id,g=i.guild;
  const send=({ephemeral,...o})=>i.reply({...o,...(ephemeral===false?{}:{flags:MessageFlags.Ephemeral}),allowedMentions:{parse:[]}});
  if(n==='help')return !!await send({embeds:[helpEmbed(gid,uid)]});
  if(n==='profil'){
    const target=i.options.getUser('membre')?.id||uid;
    if(target!==uid)requireCmd(gid,uid,'=ui');
    return !!await send({embeds:[embedFor(gid,uid,memberCard(g,target))]});
  }
  if(n==='explain'||n==='contrib'){
    const short=n==='explain',cur=cfg(gid).payment.currency;
    const rows=db.prepare('SELECT * FROM prices WHERE guild_id=? AND active=1 ORDER BY amount DESC').all(gid);
    const body=short
      ?'Contribuer, c’est soutenir le serveur et débloquer des accès.\n\n`/perm` pour les rôles · `/acces` pour les whitelists · `/abo` pour les abonnements.'
      :`Chaque contribution finance le serveur et ouvre des accès.\n\n**Tarifs actuels**\n${rows.map(x=>`**${x.label}** — ${x.amount/100}${cur}`).join('\n')||'Aucun tarif publié.'}\n\nMoyens de paiement : ${cfg(gid).payment.methods.join(' · ')}`;
    return !!await send({embeds:[embedFor(gid,uid,{title:short?'💡 En bref':'💡 Contribuer',description:body})]});
  }
  if(n==='perm'||n==='acces'||n==='abo'){
    const kind=n==='perm'?'perm':n==='acces'?'wl':'abo',cur=cfg(gid).payment.currency;
    const rows=db.prepare('SELECT * FROM prices WHERE guild_id=? AND active=1 ORDER BY amount DESC').all(gid).filter(x=>x.key.startsWith(kind));
    const titles={perm:'🔐 Rôles',wl:'🛡️ Whitelist',abo:'💳 Abonnements'};
    return !!await send({embeds:[embedFor(gid,uid,{title:titles[kind],description:rows.map(x=>`**${x.label}** — ${x.amount/100}${cur}`).join('\n')||'Rien de publié pour le moment.'})]});
  }
  if(n==='logs'){
    requireCmd(gid,uid,'/logs');
    const cur=cfg(gid).payment.currency;
    const rows=db.prepare('SELECT * FROM payments WHERE guild_id=? ORDER BY created_at DESC LIMIT 15').all(gid);
    return !!await send({embeds:[embedFor(gid,uid,{title:'📒 Transactions',description:rows.map(x=>`${PAY_ICON[x.status]||'•'} <@${x.user_id}> · ${x.label} · ${x.amount/100}${cur}`).join('\n')||'Aucune transaction.'})]});
  }
  if(n==='payment'){
    requireCmd(gid,uid,'/payment');
    const cur=cfg(gid).payment.currency;
    const rows=db.prepare('SELECT * FROM payments WHERE guild_id=? ORDER BY created_at DESC LIMIT 12').all(gid);
    return !!await send({embeds:[embedFor(gid,uid,{title:'💳 Paiements',description:rows.map(x=>`#${x.id} ${PAY_ICON[x.status]||'•'} <@${x.user_id}> · ${x.label} · ${x.amount/100}${cur}`).join('\n')||'Aucun paiement.'})],components:[row(btn('pay:new','Nouveau paiement',ButtonStyle.Primary))]});
  }
  if(n==='protect'){
    requireCmd(gid,uid,'/protect');
    const ch=i.options.getChannel('salon'),named=i.options.getString('niveau');
    if(!ch){
      const rows=db.prepare('SELECT * FROM protected_channels WHERE guild_id=?').all(gid);
      return !!await send({embeds:[embedFor(gid,uid,{title:'🛰️ Salons réservés',description:rows.map(x=>`<#${x.channel_id}> — ${levelLabel(gid,x.min_level)}`).join('\n')||'Aucun salon réservé.'})]});
    }
    if(!named){db.prepare('DELETE FROM protected_channels WHERE guild_id=? AND channel_id=?').run(gid,ch.id);scheduleTables(g);return !!await send({content:'✅ Salon libéré.'});}
    const match=hierarchyRows(gid).find(x=>x.name.toLowerCase()===named.toLowerCase());
    const lvl=match?match.level:Number(named);
    if(!Number.isFinite(lvl))throw new Error('Niveau inconnu.');
    if(rank(gid,uid)<999&&lvl>rank(gid,uid))throw new Error('Tu ne peux pas réserver au-dessus de ton niveau.');
    db.prepare('INSERT INTO protected_channels(guild_id,channel_id,min_level,created_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,channel_id) DO UPDATE SET min_level=excluded.min_level').run(gid,ch.id,lvl,now());
    await logTo(g,'salon',{title:'🛰️ Salon réservé',description:`${ch} — ${levelLabel(gid,lvl)}`,actor:uid});
    scheduleTables(g);
    return !!await send({content:`✅ ${ch} réservé à **${levelLabel(gid,lvl)}** et au-dessus.`});
  }
  if(n==='add'){
    requireCmd(gid,uid,'/add');
    const target=i.options.getUser('membre').id;
    const amount=Math.round(i.options.getNumber('montant')*100);
    if(!Number.isFinite(amount)||amount<=0)throw new Error('Montant invalide.');
    db.prepare('INSERT INTO contrib(guild_id,user_id,amount,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET amount=contrib.amount+excluded.amount,updated_at=excluded.updated_at').run(gid,target,amount,now());
    await logTo(g,'contrib',{title:'➕ Contribution',description:`<@${target}> · ${amount/100}${cfg(gid).payment.currency}`,actor:uid});
    scheduleTables(g);
    return !!await send({content:'✅ Contribution enregistrée.'});
  }
  if(n==='del'){
    requireCmd(gid,uid,'/del');
    const target=i.options.getUser('membre').id,role=i.options.getRole('role');
    if(!canTouchRole(gid,uid,g.roles.cache.get(role.id))&&!globalOwner(uid))throw new Error('Rôle non autorisé.');
    guardTarget(gid,uid,target);
    const mem=await g.members.fetch(target).catch(()=>null);
    if(!mem)throw new Error('Membre introuvable.');
    await mem.roles.remove(role.id,'DREAM del');
    await logTo(g,'role',{title:'➖ Rôle retiré',description:`<@${target}> · <@&${role.id}>`,actor:uid});
    return !!await send({content:'✅ Rôle retiré.'});
  }
  if(n==='giveaway'){
    requireCmd(gid,uid,'=giveaway');
    return !!await i.showModal(modal('gw:create','Nouveau giveaway',[
      {id:'prize',label:'Récompense'},
      {id:'winners',label:'Nombre de gagnants',value:'1'},
      {id:'duration',label:'Durée (30m, 2h, 1j)',value:'1h'}
    ]));
  }
  if(n==='smash'){
    const target=i.options.getUser('membre').id;
    const msg=await i.channel.send({embeds:[embedFor(gid,uid,{title:'🔥 Smash or pass',description:`<@${target}>`})],components:[row(btn('smash:up','Smash',ButtonStyle.Success),btn('smash:down','Pass',ButtonStyle.Danger))],allowedMentions:{parse:[]}});
    db.prepare('INSERT INTO embeds(guild_id,key,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(gid,`smash:${msg.id}`,json({target,up:[],down:[]}),now());
    return !!await send({content:'✅ Publié.'});
  }
  if(n==='setup'){
    requireCmd(gid,uid,'=setup');
    cooldown(`${gid}:setup`,60e3);
    await i.deferReply({flags:MessageFlags.Ephemeral});
    const result=await runSetup(g,uid);
    return !!await i.editReply({embeds:[setupEmbed(g,uid,result)]});
  }
  if(n==='tableaux'){
    requireCmd(gid,uid,'=tableaux');
    const c=await refreshTables(g);
    return !!await send({content:`📊 **${c}** tableaux à jour.`});
  }
  if(n==='wet'){
    requireCmd(gid,uid,'/wet');
    const target=i.options.getUser('membre').id;
    const reason=i.options.getString('raison')||'—';
    const lvl=await applyWet(g,uid,target,reason);
    return !!await send({content:`🚫 WET appliqué à <@${target}> (**${levelLabel(gid,lvl)}**).`});
  }
  if(n==='wet-info'){
    requireCmd(gid,uid,'/wet-info');
    const rows=wetList(gid,uid);
    return !!await send({embeds:[embedFor(gid,uid,{title:'🚫 WET',description:rows.map(x=>`<@${x.user_id}> — ${levelLabel(gid,x.level)}`).join('\n')||'Aucun WET visible à ton niveau.',footer:'Les niveaux supérieurs au tien restent masqués.'})]});
  }
  if(n==='hierarchie'){
    const rows=hierarchyRows(gid);
    return !!await send({embeds:[embedFor(gid,uid,{title:'📚 Hiérarchie',description:rows.map(x=>`**${x.level}** · ${x.name}${x.role_id?` → <@&${x.role_id}>`:''}`).join('\n')||'Vide.',footer:'=hierarchie lier <nom> <@rôle>'})]});
  }
  return false;
}

// Composants supplémentaires
async function extraComponent(i){
  const gid=i.guildId,uid=i.user.id,g=i.guild;
  const [scope,action,extra]=i.customId.split(':');
  if(scope==='setup'){
    if(action==='help')return !!await i.reply({embeds:[helpEmbed(gid,uid)],flags:MessageFlags.Ephemeral});
    requireCmd(gid,uid,'=setup');
    if(action==='tiers')return !!await i.reply({embeds:[embedFor(gid,uid,{title:'📚 Hiérarchie',description:ladderText(gid,g),footer:`Niveaux ${TIER_MIN} à ${TIER_MAX} pour les rôles · au-dessus = accès internes`})],components:ladderPanel(gid),flags:MessageFlags.Ephemeral});
    if(action==='run'){
      cooldown(`${gid}:setup`,60e3);
      await i.deferReply({flags:MessageFlags.Ephemeral});
      const result=await runSetup(g,uid);
      await welcomePanel(g).catch(()=>{});
      return !!await i.editReply({embeds:[setupEmbed(g,uid,result)]});
    }
  }
  if(scope==='tier'){
    requireCmd(gid,uid,'=hierarchie');
    const show=()=>({embeds:[embedFor(gid,uid,{title:'📚 Hiérarchie',description:ladderText(gid,g),footer:`Niveaux ${TIER_MIN} à ${TIER_MAX} pour les rôles · au-dessus = accès internes`})],components:ladderPanel(gid)});
    if(action==='refresh')return !!await i.update(show());
    if(action==='add'){
      const roleId=i.values[0];
      const role=g.roles.cache.get(roleId);
      if(!role)throw new Error('Rôle introuvable.');
      const current=tierOf(gid,roleId);
      return !!await i.showModal(modal(`tier:level:${roleId}`,`Niveau de ${role.name}`.slice(0,45),[{id:'level',label:`Niveau entre ${TIER_MIN} et ${TIER_MAX}`,value:String(current?.level||'')}]));
    }
    if(action==='level'){
      const role=g.roles.cache.get(extra);
      setTier(gid,role,i.fields.getTextInputValue('level'),uid);
      audit(gid,uid,'tier.set',extra,{level:Number(i.fields.getTextInputValue('level'))});
      await logTo(g,'perm',{title:'📚 Niveau attribué',description:`<@&${extra}> → **${Number(i.fields.getTextInputValue('level'))}**`,actor:uid});
      scheduleTables(g);
      return !!await i.reply({...show(),flags:MessageFlags.Ephemeral});
    }
    if(action==='remove'){
      const rows=tierRows(gid);
      if(!rows.length)throw new Error('Aucun rôle ne porte de niveau.');
      return !!await i.reply({content:'Choisis le rôle à retirer.',components:[row(sel('tier:drop','Retirer un niveau',rows.slice(0,25).map(x=>({label:`${x.name} · ${x.level}`.slice(0,100),value:x.role_id}))))],flags:MessageFlags.Ephemeral});
    }
    if(action==='drop'){
      const old=delTier(gid,i.values[0],uid);
      audit(gid,uid,'tier.del',i.values[0],{level:old.level});
      await logTo(g,'perm',{title:'📚 Niveau retiré',description:`<@&${i.values[0]}> n'a plus de niveau.`,actor:uid});
      scheduleTables(g);
      return !!await i.update({content:'✅ Niveau retiré.',components:[]});
    }
    if(action==='system'){
      const rows=systemRows(gid);
      return !!await i.reply({embeds:[embedFor(gid,uid,{title:'🔒 Accès internes',description:rows.map(x=>`**${x.name}** · ${x.level} · ${x.role_id?`<@&${x.role_id}>`:'aucun rôle'}`).join('\n'),footer:'=hierarchie interne OWNER <@rôle> · off pour délier'})],flags:MessageFlags.Ephemeral});
    }
  }
  if(scope==='droits'){
    requireCmd(gid,uid,'=droits');
    const cmd=decodeURIComponent(extra||'');
    if(action==='reset'){
      clearCommandPerm(gid,cmd);
      audit(gid,uid,'perm.reset',cmd,null);
      scheduleTables(g);
      return !!await i.update({embeds:[embedFor(gid,uid,{title:'🔐 Droits',description:cmdRuleText(gid,cmd)})],components:[]});
    }
    if(action==='set'){
      const roles=i.values||[];
      if(!globalOwner(uid))for(const r of roles){const t=tierOf(gid,r);if(t&&t.level>=rank(gid,uid))throw new Error('Un de ces rôles est au-dessus de ton niveau.');}
      setCommandPerm(gid,cmd,cmdRule(gid,cmd).minLevel,roles);
      audit(gid,uid,'perm.roles',cmd,{roles});
      await logTo(g,'perm',{title:'🔐 Droits modifiés',description:cmdRuleText(gid,cmd),actor:uid});
      scheduleTables(g);
      return !!await i.update({embeds:[embedFor(gid,uid,{title:'🔐 Droits',description:cmdRuleText(gid,cmd)})],components:[]});
    }
  }
  if(scope==='mass'){
    if(action==='cancel'){db.prepare("UPDATE mass_ops SET status='cancelled' WHERE id=?").run(extra);return !!await i.update({embeds:[embed(gid,{title:'↩️ Annulé',description:'Aucun rôle ajouté.'})],components:[]});}
    if(action==='run'){
      await i.update({embeds:[embed(gid,{title:'⏳ En cours',description:'Ajout des rôles…'})],components:[]});
      const n=await massRun(g,extra,uid);
      return !!await i.followUp({content:`✅ Rôle ajouté à **${n}** membres.`,flags:MessageFlags.Ephemeral,components:[row(btn(`mass:undo:${extra}`,'Annuler cette opération',ButtonStyle.Danger))]});
    }
    if(action==='undo'){const n=await massUndo(g,extra,uid);return !!await i.reply({content:`↩️ Rôle retiré à **${n}** membres.`,flags:MessageFlags.Ephemeral});}
  }
  if(scope==='gw'&&(action==='join'||action==='list')){
    const gw=db.prepare('SELECT * FROM giveaways WHERE id=?').get(extra);
    if(!gw||gw.status!=='open')throw new Error('Ce giveaway est terminé.');
    const entries=parse(gw.entries)||[];
    if(action==='list')return !!await i.reply({content:`🎁 **${entries.length}** participant(s).`,flags:MessageFlags.Ephemeral});
    if(action==='join'){
      if(db.prepare('SELECT 1 FROM bl WHERE guild_id=? AND user_id=?').get(gid,uid))throw new Error('Tu ne peux pas participer.');
      if(entries.includes(uid))return !!await i.reply({content:'Tu participes déjà.',flags:MessageFlags.Ephemeral});
      entries.push(uid);
      db.prepare('UPDATE giveaways SET entries=? WHERE id=?').run(json(entries),extra);
      return !!await i.reply({content:'🎉 Participation enregistrée.',flags:MessageFlags.Ephemeral});
    }
  }
  if(scope==='smash'){
    const key=`smash:${i.message.id}`;
    const rec=db.prepare('SELECT payload FROM embeds WHERE guild_id=? AND key=?').get(gid,key);
    if(!rec)throw new Error('Ce sondage a expiré.');
    const data=parse(rec.payload);
    data.up=(data.up||[]).filter(x=>x!==uid);data.down=(data.down||[]).filter(x=>x!==uid);
    if(action==='up')data.up.push(uid);else data.down.push(uid);
    db.prepare('UPDATE embeds SET payload=?,updated_at=? WHERE guild_id=? AND key=?').run(json(data),now(),gid,key);
    await i.message.edit({embeds:[embed(gid,{title:'🔥 Smash or pass',description:`<@${data.target}>\n\n🔥 **${data.up.length}** · ❄️ **${data.down.length}**`})]}).catch(()=>{});
    return !!await i.reply({content:'✅ Vote pris en compte.',flags:MessageFlags.Ephemeral});
  }
  if(scope==='rules'&&action==='accept'){
    const roleId=resolveSetting(gid,'rules.role');
    if(!roleId)throw new Error('Aucun rôle configuré.');
    const role=g.roles.cache.get(roleId);
    if(!role)throw new Error('Rôle introuvable.');
    await i.member.roles.add(role,'DREAM règlement').catch(()=>{throw new Error('Ajout du rôle impossible.');});
    await logTo(g,'autorole',{title:'📜 Règlement accepté',description:`<@${uid}> → ${role}`,actor:uid,mirror:false});
    return !!await i.reply({content:'✅ Accès débloqué, bonne visite.',flags:MessageFlags.Ephemeral});
  }
  if(scope==='rolepanel'){
    const allowed=resolveSetting(gid,`panel.${action}`)||[];
    const chosen=(i.values||[]).filter(x=>allowed.includes(x));
    for(const id of allowed){
      const role=g.roles.cache.get(id);if(!role||isProtectedRole(gid,role))continue;
      if(chosen.includes(id))await i.member.roles.add(role,'DREAM panneau').catch(()=>{});
      else await i.member.roles.remove(role,'DREAM panneau').catch(()=>{});
    }
    await logTo(g,'autorole',{title:'🎨 Rôles mis à jour',description:`<@${uid}> · ${chosen.length} rôle(s)`,actor:uid,mirror:false});
    return !!await i.reply({content:'✅ Rôles mis à jour.',flags:MessageFlags.Ephemeral});
  }
  if(scope==='paystatus'){
    requireCmd(gid,uid,'/payment');
    const status=i.values[0];
    if(!PAY_STATUS.includes(status))throw new Error('Statut inconnu.');
    const pay=db.prepare('SELECT * FROM payments WHERE id=? AND guild_id=?').get(Number(action),gid);
    if(!pay)throw new Error('Paiement introuvable.');
    db.prepare('UPDATE payments SET status=?,updated_at=? WHERE id=?').run(status,now(),pay.id);
    await logTo(g,'paiement',{title:`${PAY_ICON[status]} Paiement ${status.toLowerCase()}`,description:`#${pay.id} · <@${pay.user_id}> · ${pay.label}`,actor:uid});
    if(status==='Payé')await notify(g,pay.user_id,'ABO',{label:pay.label});
    scheduleTables(g);
    return !!await i.reply({content:`✅ Statut : **${status}**.`,flags:MessageFlags.Ephemeral});
  }
  if(scope==='pay'&&action==='new'){
    requireCmd(gid,uid,'/payment');
    return !!await i.showModal(modal('pay:create','Nouveau paiement',[
      {id:'user',label:'Identifiant du membre'},
      {id:'amount',label:'Montant'},
      {id:'label',label:'Libellé',value:'Paiement'}
    ]));
  }
  if(scope==='ticket'&&action==='close'){
    return !!await i.showModal(modal('tclose:go','Fermer le ticket',[{id:'reason',label:'Motif',style:TextInputStyle.Paragraph,required:false}]));
  }
  if(scope==='tclose'){
    const reason=i.fields.getTextInputValue('reason')||'—';
    await closeTicket(i,reason);
    return !!await i.reply({content:'🔒 Ticket fermé, transcript envoyé.',flags:MessageFlags.Ephemeral});
  }
  if(i.isModalSubmit()&&i.customId==='gw:create'){
    requireCmd(gid,uid,'=giveaway');
    const prize=i.fields.getTextInputValue('prize').slice(0,200);
    const winners=Math.max(1,Math.min(20,Number(i.fields.getTextInputValue('winners'))||1));
    const ms=parseDuration(i.fields.getTextInputValue('duration'));
    if(!ms)throw new Error('Durée invalide. Utilise 30m, 2h ou 1j.');
    await openGiveaway(g,i.channel,uid,prize,winners,ms);
    return !!await i.reply({content:'🎁 Giveaway lancé.',flags:MessageFlags.Ephemeral});
  }
  if(i.isModalSubmit()&&i.customId==='pay:create'){
    requireCmd(gid,uid,'/payment');
    const target=cleanTarget(i.fields.getTextInputValue('user'));
    const amount=Math.round(Number(String(i.fields.getTextInputValue('amount')).replace(',','.'))*100);
    const label=i.fields.getTextInputValue('label').slice(0,100)||'Paiement';
    if(!target||!Number.isFinite(amount)||amount<=0)throw new Error('Membre ou montant invalide.');
    const info=db.prepare('INSERT INTO payments(guild_id,user_id,label,amount,status,created_at,updated_at,actor_id) VALUES(?,?,?,?,?,?,?,?)').run(gid,target,label,amount,'En attente',now(),now(),uid);
    await logTo(g,'paiement',{title:'💳 Paiement créé',description:`<@${target}> · ${label} · ${amount/100}${cfg(gid).payment.currency}`,actor:uid});
    scheduleTables(g);
    return !!await i.reply({embeds:[embedFor(gid,uid,{title:'💳 Paiement créé',description:`#${info.lastInsertRowid} · <@${target}> · **${amount/100}${cfg(gid).payment.currency}**`})],components:[row(sel(`paystatus:${info.lastInsertRowid}`,'Changer le statut',PAY_STATUS.map(s=>({label:s,value:s,emoji:PAY_ICON[s]}))))],flags:MessageFlags.Ephemeral});
  }
  return false;
}

// ───────────────────────── Slash ─────────────────────────
const slash=[
  {name:'dream',description:'Ouvrir le centre DREAM'},
  {name:'music',description:'Ouvrir la musique'},
  {name:'ticket',description:'Ouvrir les tickets'},
  {name:'role',description:'Ouvrir la gestion des rôles'},
  {name:'stats',description:'Voir les statistiques'},
  {name:'ui',description:'Ouvrir les réglages UI'},
  {name:'wl',description:'Ouvrir la gestion WL'},
  {name:'wl-role',description:'Gérer la WL rôle'},
  {name:'configuration',description:'Configurer entièrement le serveur'},

  ...EXTRA_SLASH
].map(x=>({...x,type:1}));

function ensureLegacyBotAccess(c,g){if(!botAccess(g.id,c.user.id))db.prepare('INSERT INTO bot_access(guild_id,bot_id,bot_name,status,requested_at,server_owner_id,invite_url) VALUES(?,?,?,?,?,?,?)').run(g.id,c.user.id,c.user.username,'accepted',now(),g.ownerId,oauthInvite(c.user.id,c===clients.one?'Commu Dream':'Dream Protect'));}
async function createIntegrationRequest(c,g){guilds.set(g.id,g);cfg(g.id);ensureCommandConfig(g.id);let inviter=null;try{if(g.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)){const logs=await g.fetchAuditLogs({type:AuditLogEvent.BotAdd,limit:20});const e=logs.entries.find(x=>x.target?.id===c.user.id&&now()-x.createdTimestamp<15*60*1000);inviter=e?.executor||null;}}catch{}const ownerId=g.ownerId||null,botName=c===clients.one?'Commu Dream':'Dream Protect',invite=oauthInvite(c.user.id,botName);db.prepare("INSERT INTO bot_access(guild_id,bot_id,bot_name,status,inviter_id,server_owner_id,requested_at,invite_url) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,bot_id) DO UPDATE SET status='pending',inviter_id=excluded.inviter_id,server_owner_id=excluded.server_owner_id,requested_at=excluded.requested_at,invite_url=excluded.invite_url,decided_at=NULL,decided_by=NULL").run(g.id,c.user.id,botName,'pending',inviter?.id||null,ownerId,now(),invite);const desc=`Le bot vient d’être ajouté à **${g.name}**.\n\n**Owner** : ${ownerId?`<@${ownerId}>`:'Inconnu'}\n**Ajouté par** : ${inviter?`<@${inviter.id}>`:'Inconnu / journal inaccessible'}\n\nTant que tu n’acceptes pas, **aucune commande, configuration ou action ne peut être exécutée**.`;for(const x of db.prepare('SELECT user_id FROM owners').all()){const u=await c.users.fetch(x.user_id).catch(()=>null);if(u)await u.send({embeds:[embed(g.id,{title:'⚠️ DREAM • Nouvelle intégration',description:desc,fields:[{name:'Lien d’invitation',value:`[Inviter ${botName}](${invite})`} ]})],components:[row(btn(`integration:accept:${g.id}:${c.user.id}`,'Accepter',ButtonStyle.Success),btn(`integration:reject:${g.id}:${c.user.id}`,'Refuser',ButtonStyle.Danger))]}).catch(()=>{});}}
for(const c of [clients.one,clients.two]){c.on('guildCreate',g=>createIntegrationRequest(c,g));c.on('guildDelete',g=>guilds.delete(g.id));}
// ───────────────────── Demarrage ─────────────────────
clients.one.on('clientReady',async()=>{console.log(`Commu Dream connecté : ${clients.one.user.tag}`);for(const g of clients.one.guilds.cache.values()){try{guilds.set(g.id,g);cfg(g.id);ensureCommandConfig(g.id);ensureLegacyBotAccess(clients.one,g);if(botAccepted(g.id,clients.one.user.id))await syncCustomCommands(g);}catch(e){console.error(`Commu Dream, ${g.name} :`,e?.message||e);}}});
clients.two.on('clientReady',async()=>{console.log(`Dream Protect connecté : ${clients.two.user.tag}`);for(const g of clients.two.guilds.cache.values()){try{guilds.set(g.id,g);cfg(g.id);ensureCommandConfig(g.id);ensureLegacyBotAccess(clients.two,g);if(botAccepted(g.id,clients.two.user.id))await refreshGuild(g);}catch(e){console.error(`Dream Protect, ${g.name} :`,e?.message||e);}}console.log(`Dream Protect prêt : ${clients.two.guilds.cache.size} serveur(s)`);});
clients.one.on('interactionCreate',handleInteraction);
clients.two.on('interactionCreate',async i=>{ try {
  if(i.isButton() && (i.customId.startsWith('integration:accept:')||i.customId.startsWith('integration:reject:'))){if(!globalOwner(i.user.id))throw new Error('Seul un owner DREAM peut valider cette intégration.');const [,action,gid,botId]=i.customId.split(':');const x=botAccess(gid,botId);if(!x)throw new Error('Demande introuvable.');if(action==='accept'){db.prepare("UPDATE bot_access SET status='accepted',decided_at=?,decided_by=? WHERE guild_id=? AND bot_id=?").run(now(),i.user.id,gid,botId);const c=[clients.one,clients.two].find(v=>v.user?.id===botId);const g=c?.guilds.cache.get(gid);if(g&&c===clients.two)await refreshGuild(g).catch(()=>{});return i.update({embeds:[embed(gid,{title:'✅ DREAM • Intégration acceptée',description:`**${x.bot_name}** est maintenant actif sur ce serveur.`})],components:[]});}db.prepare("UPDATE bot_access SET status='rejected',decided_at=?,decided_by=? WHERE guild_id=? AND bot_id=?").run(now(),i.user.id,gid,botId);const c=[clients.one,clients.two].find(v=>v.user?.id===botId);const g=c?.guilds.cache.get(gid);if(g)await g.leave().catch(()=>{});return i.update({embeds:[embed(gid,{title:'⛔ DREAM • Intégration refusée',description:`**${x.bot_name}** quitte le serveur.`})],components:[]});}
  if(!i.guildId) return;
  if(i.isStringSelectMenu() && i.customId.startsWith('sanction:type:')){
    const id=i.customId.slice('sanction:type:'.length), p=getPendingSanction(id);
    if(!p || p.actor_id!==i.user.id) throw new Error('Cette demande n’est plus disponible.');
    const type=i.values[0];
    db.prepare('UPDATE pending_sanctions SET type=? WHERE id=?').run(type,id);
    const target=await i.guild.members.fetch(p.target_id).catch(()=>null); if(!target)throw new Error('Membre introuvable.');
    if(type==='TIMEOUT') return i.showModal(modal(`sanction:timeout:${id}`,'Timeout',[{id:'duration',label:'Durée en minutes',placeholder:'10',value:'10'},{id:'reason',label:'Raison',placeholder:p.reason||'—',value:p.reason||'—'}]));
    return i.update({embeds:[embed(i.guildId,sanctionPreview(i.guildId,target,p.reason,type))],components:sanctionConfirmRows(id),allowedMentions:{parse:[]}});
  }
  if(i.isButton() && i.customId.startsWith('sanction:')){
    const parts=i.customId.split(':'), action=parts[1], id=parts.slice(2).join(':'); const p=getPendingSanction(id);
    if(!p || p.actor_id!==i.user.id) throw new Error('Cette demande n’est plus disponible.');
    if(action==='cancel'){clearPendingSanction(id);return i.update({embeds:[embed(i.guildId,{title:'🛡️ Sanction annulée',description:'Aucune action n’a été appliquée.'})],components:[]});}
    if(action==='confirm'){
      if(!p.type)throw new Error('Choisis d’abord une sanction.');
      const target=await i.guild.members.fetch(p.target_id).catch(()=>null);if(!target)throw new Error('Membre introuvable.');
      await executeSanction(i.guild,i.member,target,p.type,p.reason,p.type==='TIMEOUT'?p.duration_ms:null);clearPendingSanction(id);
      return i.update({embeds:[embed(i.guildId,{title:'✅ Sanction appliquée',description:`**${sanctionLabel(p.type)}** → <@${target.id}>
Aucune autre action n’a été appliquée.`})],components:[]});
    }
  }
  if(i.isModalSubmit() && i.customId.startsWith('sanction:timeout:')){
    const id=i.customId.slice('sanction:timeout:'.length), p=getPendingSanction(id);
    if(!p || p.actor_id!==i.user.id) throw new Error('Cette demande n’est plus disponible.');
    const mins=Number(i.fields.getTextInputValue('duration')); if(!Number.isInteger(mins)||mins<1||mins>40320)throw new Error('La durée doit être comprise entre 1 et 40320 minutes.');
    const reason=i.fields.getTextInputValue('reason')?.trim()||p.reason||'—'; db.prepare('UPDATE pending_sanctions SET type=?,reason=?,duration_ms=? WHERE id=?').run('TIMEOUT',reason,mins*60000,id);
    const target=await i.guild.members.fetch(p.target_id).catch(()=>null);if(!target)throw new Error('Membre introuvable.');
    const ms=mins*60000; const description=`**Membre**
<@${target.id}>

**Action**
⚠️ Timeout • **${mins} min**

**Raison**
${reason}

Vérifie puis confirme.`;
    return i.reply({embeds:[embed(i.guildId,{title:'🛡️ DREAM • Sanction',description})],components:[...sanctionConfirmRows(id)],flags:MessageFlags.Ephemeral});
  }
  if(!i.isChatInputCommand()&&await extraComponent(i))return;
  if(!i.isChatInputCommand()) return;
  if(await extraSlash(i))return;
  if(i.commandName==='configuration') return await openConfiguration(i);
  if(i.commandName==='lock'||i.commandName==='unlock'){requireAccess(i.guildId,i.user.id,i.commandName,50);const lock=i.commandName==='lock';if(lock){db.prepare('INSERT OR IGNORE INTO locks(guild_id,channel_id,created_at) VALUES(?,?,?)').run(i.guildId,i.channelId,now());await i.channel.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:false},'Dream Protect lock');}else{db.prepare('DELETE FROM locks WHERE guild_id=? AND channel_id=?').run(i.guildId,i.channelId);await i.channel.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:null},'Dream Protect unlock');}return i.reply({content:lock?'🔒 Verrouillé.':'🔓 Déverrouillé.',flags:MessageFlags.Ephemeral});}
 } catch(e){ if(i.replied||i.deferred)return i.followUp({content:`⛔ ${String(e.message||e).slice(0,1900)}`,flags:MessageFlags.Ephemeral}).catch(()=>{}); return i.reply({content:`⛔ ${String(e.message||e).slice(0,1900)}`,flags:MessageFlags.Ephemeral}).catch(()=>{}); } });

clients.one.on('messageCreate',async m=>{ if(m.author.bot||!m.guild)return; const t=m.content.trim(); if(/^(?:\.owner|=pv|=acces|&blinfo|&(?:un)?bl|&derank|\+(?:ban|kick|expulse|timeout|warn)|\-baninfo|\+(?:lock|unlock)|\/wet-info|\/wet(?:=pa)?|\/dog-(?:add|del))/i.test(t)) return; await handlePrefix(m); });
clients.two.on('messageCreate',async m=>{ await handlePrefix(m); });
for(const c of [clients.one,clients.two]){
  c.on('messageDelete',async m=>{ try { await restoreDeletedLog(m); } catch {} });
  c.on('messageDeleteBulk',async (messages,channel)=>{ try { await restoreDeletedLogBulk(messages,channel); } catch {} });
  c.on('messageUpdate',async (oldMessage,newMessage)=>{
    try{
      const rec=db.prepare('SELECT * FROM log_messages WHERE message_id=?').get(newMessage.id);
      if(!rec || !newMessage.guild)return;
      const expected=rec.title;
      if(newMessage.embeds?.[0]?.title===expected)return;
      const ch=newMessage.channel;
      await newMessage.edit({embeds:[embed(newMessage.guild.id,{title:rec.title,description:rec.description,fields:rec.actor_id?[{name:'Membre',value:`<@${rec.actor_id}>`,inline:true},{name:'Résultat',value:rec.result,inline:true}]:[]})],allowedMentions:{parse:[]},reason:'DREAM log auto-restoration'}).catch(()=>{});
    }catch{}
  });
}
clients.two.on('guildMemberAdd',async m=>{await protectMemberRoles(m.guild,m);});
clients.two.on('guildMemberUpdate',async(o,n)=>{if(n.guild&&cfg(n.guild.id).roles.protect)await protectMemberRoles(n.guild,n);});
clients.two.on('roleCreate',r=>{if(r.guild) scheduleInstantRefresh(r.guild,'roleCreate');});
clients.two.on('roleUpdate',(o,n)=>{if(n.guild && (o.name!==n.name||o.position!==n.position||o.permissions.bitfield!==n.permissions.bitfield)) scheduleInstantRefresh(n.guild,'roleUpdate');});
clients.two.on('roleDelete',r=>{if(r.guild) scheduleInstantRefresh(r.guild,'roleDelete');});
for(const c of [clients.one,clients.two]){
  c.on('guildMemberAdd',m=>scheduleInstantRefresh(m.guild,'memberAdd'));
  c.on('guildMemberRemove',m=>scheduleInstantRefresh(m.guild,'memberRemove'));
  c.on('channelCreate',ch=>{if(ch.guild)scheduleInstantRefresh(ch.guild,'channelCreate');});
  c.on('channelDelete',ch=>{if(ch.guild)scheduleInstantRefresh(ch.guild,'channelDelete');});
}

clients.one.on('guildMemberAdd',async m=>{const c=cfg(m.guild.id);if(c.configuration.welcome.enabled){const ch=c.configuration.welcome.channelId?m.guild.channels.cache.get(c.configuration.welcome.channelId):m.guild.systemChannel;if(ch)ch.send({embeds:[embed(m.guild.id,{title:'Bienvenue 👋',description:c.configuration.welcome.template.replaceAll('{member}',`${m}`).replaceAll('{server}',m.guild.name)})]}).catch(()=>{});}});
clients.two.on('guildMemberAdd',async m=>{const c=cfg(m.guild.id);for(const rid of c.community.autoroles||[])m.roles.add(rid,'Dream Protect autorole').catch(()=>{});});
clients.two.on('voiceStateUpdate',async(o,n)=>{
  const g=n.guild;
  if(o.channelId&&o.channelId!==n.channelId){
    const left=db.prepare('SELECT * FROM pv WHERE guild_id=? AND channel_id=?').get(g.id,o.channelId);
    if(left&&left.owner_id===n.member.id){
      const cc=customConfig(g.id,n.member.id);
      const keep=left.level>=95||!!cc?.private_voice_persist;
      if(!keep){db.prepare('DELETE FROM pv_access WHERE guild_id=? AND channel_id=?').run(g.id,left.channel_id);db.prepare('DELETE FROM pv WHERE guild_id=? AND channel_id=?').run(g.id,left.channel_id);db.prepare('UPDATE custom_config SET private_voice_active=0 WHERE guild_id=? AND user_id=?').run(g.id,left.owner_id);const ch=g.channels.cache.get(left.channel_id);if(ch)await ch.permissionOverwrites.edit(g.roles.everyone,{Connect:null},'DREAM PV ended').catch(()=>{});}
    }
  }
  if(!n.channelId)return;
  const x=db.prepare('SELECT * FROM pv WHERE guild_id=? AND channel_id=?').get(g.id,n.channelId);if(!x||x.access_mode!=='DENY')return;
  if(n.member.id===x.owner_id)return;
  if(pvRank(g.id,n.member.id)>=x.level)return;
  if(memberHasCustomRole(g,n.member.id,x.owner_id))return;
  if(db.prepare('SELECT 1 FROM pv_access WHERE guild_id=? AND channel_id=? AND user_id=?').get(g.id,x.channel_id,n.member.id))return;
  n.disconnect('DREAM PV').catch(()=>{});
});

every(30*60*1000,async()=>{
  for(const g of clients.two.guilds.cache.values())try{await refreshGuild(g);}catch{}
});
every(Math.max(15,Number(process.env.BACKUP_MINUTES||30))*60*1000,backup);

// Surveillance
async function auditActor(g,type,targetId=null){
  if(!g.members?.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog))return null;
  const logs=await g.fetchAuditLogs({type,limit:5}).catch(()=>null);
  const entry=[...(logs?.entries?.values()||[])].find(e=>(!targetId||String(e.target?.id||e.targetId||'')===String(targetId))&&e.createdTimestamp>Date.now()-15000);
  return entry?.executor?.id||null;
}
function isOurBot(id){return id===clients.one.user?.id||id===clients.two.user?.id;}
async function antiEscalation(g,oldM,newM){
  const added=[...newM.roles.cache.keys()].filter(id=>!oldM.roles.cache.has(id));
  if(!added.length)return;
  const linked=added.map(id=>({id,row:db.prepare('SELECT * FROM linked_roles WHERE guild_id=? AND role_id=?').get(g.id,id)})).filter(x=>x.row);
  if(!linked.length)return;
  const actor=await auditActor(g,AuditLogEvent.MemberRoleUpdate,newM.id);
  if(actor&&isOurBot(actor))return;
  clearRankCache(g.id,newM.id);
  const ownerLevel=levelByName(g.id,'OWNER')??80;
  for(const {id,row} of linked){
    if(actor){
      if(globalOwner(actor))continue;
      if(actor!==newM.id&&rank(g.id,actor)>row.level)continue;
    }else if(row.level<ownerLevel)continue;
    const role=g.roles.cache.get(id);
    await newM.roles.remove(id,'DREAM anti-escalade').catch(()=>{});
    await logTo(g,'perm',{title:'🛡️ Escalade bloquée',description:`<@${newM.id}> a reçu ${role||'un rôle lié'} (**${row.name}**) sans autorisation suffisante.`,actor:actor||newM.id,result:'Retiré'});
    audit(g.id,actor||newM.id,'escalation.blocked',newM.id,{role:id,level:row.level});
  }
  clearRankCache(g.id,newM.id);
  scheduleTables(g);
}
const ESCALATION_PERMS=['Administrator','ManageGuild','ManageRoles','ManageChannels','BanMembers'];
clients.two.on('guildMemberUpdate',async(o,n)=>{try{if(n.guild)await antiEscalation(n.guild,o,n);}catch{}});
clients.two.on('roleDelete',async r=>{
  try{
    if(!r.guild)return;
    const linked=db.prepare('SELECT * FROM linked_roles WHERE guild_id=? AND role_id=?').get(r.guild.id,r.id);
    if(linked){
      db.prepare('DELETE FROM linked_roles WHERE guild_id=? AND role_id=?').run(r.guild.id,r.id);
      db.prepare('UPDATE hierarchy SET role_id=NULL WHERE guild_id=? AND role_id=?').run(r.guild.id,r.id);
      clearRankCache(r.guild.id);
    }
    db.prepare('DELETE FROM protected_roles WHERE guild_id=? AND role_id=?').run(r.guild.id,r.id);
    const actor=await auditActor(r.guild,AuditLogEvent.RoleDelete,r.id);
    await logTo(r.guild,'role',{title:'🗑️ Rôle supprimé',description:`**${r.name}**${linked?`\nNiveau lié : **${linked.name}**`:''}`,actor,result:linked?'Lien retiré':'OK'});
    await guardBurst(r.guild,'roleDelete',actor,4,60e3,'Suppressions de rôles en série.');
    scheduleTables(r.guild);
  }catch{}
});
clients.two.on('roleUpdate',async(o,n)=>{
  try{
    if(!n.guild)return;
    const gained=ESCALATION_PERMS.filter(p=>!o.permissions.has(PermissionFlagsBits[p])&&n.permissions.has(PermissionFlagsBits[p]));
    const linked=db.prepare('SELECT * FROM linked_roles WHERE guild_id=? AND role_id=?').get(n.guild.id,n.id);
    if(gained.length){
      const actor=await auditActor(n.guild,AuditLogEvent.RoleUpdate,n.id);
      await logTo(n.guild,'perm',{title:'🔐 Permissions élargies',description:`${n}\nAjouté : ${gained.map(p=>PERMISSION_LABELS[p]||p).join(' · ')}`,actor,result:'À vérifier'});
      audit(n.guild.id,actor||'inconnu','role.perms',n.id,{gained});
    }
    if(linked&&o.name!==n.name){
      db.prepare('UPDATE linked_roles SET name=? WHERE guild_id=? AND role_id=?').run(String(n.name).slice(0,80),n.guild.id,n.id);
      await logTo(n.guild,'role',{title:'✏️ Rôle renommé',description:kv([['Avant',o.name],['Après',n.name],['Niveau',linked.level]])});
      scheduleTables(n.guild);
    }
    if(gained.length||o.position!==n.position)scheduleTables(n.guild);
  }catch{}
});
clients.two.on('channelDelete',async ch=>{
  try{
    if(!ch.guild)return;
    const logRec=db.prepare('SELECT key FROM log_channels WHERE guild_id=? AND channel_id=?').get(ch.guild.id,ch.id);
    const tableRec=db.prepare('SELECT key FROM panels WHERE guild_id=? AND channel_id=?').get(ch.guild.id,ch.id);
    const actor=await auditActor(ch.guild,AuditLogEvent.ChannelDelete,ch.id);
    db.prepare('DELETE FROM protected_channels WHERE guild_id=? AND channel_id=?').run(ch.guild.id,ch.id);
    db.prepare('DELETE FROM locks WHERE guild_id=? AND channel_id=?').run(ch.guild.id,ch.id);
    if(logRec){
      db.prepare('UPDATE log_channels SET channel_id=NULL WHERE guild_id=? AND key=?').run(ch.guild.id,logRec.key);
      await ensureLogTree(ch.guild);
      await logTo(ch.guild,'salon',{title:'♻️ Salon de logs recréé',description:`**${ch.name}** avait été supprimé.`,actor,result:'Réparé'});
    }
    if(tableRec){
      db.prepare('DELETE FROM panels WHERE guild_id=? AND channel_id=?').run(ch.guild.id,ch.id);
      await refreshTables(ch.guild).catch(()=>{});
    }
    if(!logRec&&!tableRec)await logTo(ch.guild,'salon',{title:'🗑️ Salon supprimé',description:`**${ch.name}**`,actor});
    await guardBurst(ch.guild,'channelDelete',actor,4,60e3,'Suppressions de salons en série.');
  }catch{}
});
clients.two.on('channelUpdate',async(o,n)=>{
  try{
    if(!n.guild)return;
    const logRec=db.prepare('SELECT key FROM log_channels WHERE guild_id=? AND channel_id=?').get(n.guild.id,n.id);
    if(!logRec)return;
    const open=n.permissionsFor?.(n.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);
    if(!open)return;
    await n.permissionOverwrites.edit(n.guild.roles.everyone,{ViewChannel:false,SendMessages:false},'DREAM logs').catch(()=>{});
    const actor=await auditActor(n.guild,AuditLogEvent.ChannelOverwriteUpdate,n.id);
    await logTo(n.guild,'salon',{title:'🔒 Salon de logs reprotégé',description:`<#${n.id}> était visible par tout le monde.`,actor,result:'Réparé'});
  }catch{}
});
clients.two.on('messageCreate',async m=>{
  try{
    if(!m.guild||m.author.bot)return;
    if(!botAccepted(m.guild.id,clients.two.user?.id))return;
    if(await enforceProtectedChannel(m))return;
    await enforceBadwords(m);
  }catch{}
});
every(60*1000,()=>{tickGiveaways().catch(()=>{});});

const rest1=new REST({version:'10'}).setToken(process.env.BOT1_TOKEN||'');
const rest2=new REST({version:'10'}).setToken(process.env.BOT2_TOKEN||'');
let closing=false;
async function shutdown(code=0){
  if(closing)return;closing=true;
  try{await backup();}catch{}
  for(const c of [clients.one,clients.two]){try{await c.destroy();}catch{}}
  try{rawDb.close();}catch{}
  process.exit(code);
}
process.on('SIGINT',()=>shutdown(0));
process.on('SIGTERM',()=>shutdown(0));
process.on('unhandledRejection',e=>console.error('Rejet non gere :',e?.message||e));
process.on('uncaughtException',e=>console.error('Exception :',e?.message||e));

(async()=>{
  if(!process.env.BOT1_TOKEN||!process.env.BOT2_TOKEN)throw new Error('BOT1_TOKEN et BOT2_TOKEN sont requis. Renseigne le fichier .env.');
  if(process.env.TEST_MODE==='1'){stopTimers();return;}
  if(process.env.DRY_RUN==='1'){console.log(`Verification a sec : ${slash.length} commandes slash, ${LOG_NAMES.size} salons de logs, ${TABLE_DEFS.length} tableaux.`);return shutdown(0);}
  await clients.one.login(process.env.BOT1_TOKEN); await clients.two.login(process.env.BOT2_TOKEN);
  const ids=(process.env.REGISTER_GUILD_ID||'').split(',').map(x=>x.trim()).filter(Boolean);
  const protectedNames=PROTECT_CMDS;
  const publicSlash=slash.filter(x=>!protectedNames.has(x.name));
  const protectSlash=slash.filter(x=>protectedNames.has(x.name));
  if(ids.length){for(const id of ids){await rest1.put(Routes.applicationGuildCommands(clients.one.user.id,id),{body:publicSlash});await rest2.put(Routes.applicationGuildCommands(clients.two.user.id,id),{body:protectSlash});}}
  else {await rest1.put(Routes.applicationCommands(clients.one.user.id),{body:publicSlash});await rest2.put(Routes.applicationCommands(clients.two.user.id),{body:protectSlash});}
})().catch(async e=>{console.error('Demarrage impossible :',e?.message||e);await shutdown(1);});

// Surface de test
export const internals={
  db,guilds,clients,cfg,setCfg,rank,higher,requireAccess,guardTarget,setWL,delWL,
  ensureHierarchy,hierarchyRows,levelByName,setHierarchyLevel,linkHierarchyRole,levelNameFor,clearRankCache,
  settingSet,settingGet,settingDel,resolveSetting,themeFor,COLOR_PRESETS,
  helpEmbed,CMD_ACCESS,logKey,LOG_NAMES,LOG_TREE,TABLE_DEFS,tableBody,PAY_STATUS,PAY_ICON,
  parseDuration,massPrepare,MASS_ROLE_MAX,canGrantWLRole,isProtectedRole,wlRoleCanManage,canTouchRole,
  badwords,hitBadword,setCommandPerm,clearCommandPerm,cmdRule,cmdRuleText,allowCmd,requireCmd,CMD_DEFAULT_LEVEL,
  systemRows,tierRows,setTier,delTier,tierOf,levelLabel,ladderText,TIER_MIN,TIER_MAX,ownerLevel,
  slash,EXTRA_SLASH,PROTECT_CMDS,globalOwner,
  cooldown,rateLimit,audit,emergencyOn,stopTimers,memberCard,ensureCommandConfig,canUse,CMD_GROUPS,wetList,extraPrefix,extraSlash,extraComponent,
  runSetup,setupEmbed,bar,kv,money,clip,sel,embed,cfgCache,transaction,pruneHistory,protectRoles,welcomePanel,bullets,when,
  safeUrl,imageUrl,cleanId,levelOptions,COMMAND_CATALOG,COMMAND_LABEL,commandCfg
};

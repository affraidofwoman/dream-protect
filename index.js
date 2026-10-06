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
  Routes, REST, AttachmentBuilder, WebhookClient, AuditLogEvent
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
// SQLite Node 24: laisser StatementSync gérer nativement les paramètres.
// `?` est lié par ordre ; `:nom`, `$nom` et `@nom` utilisent l'objet nommé.
// Aucun paramètre artificiel, aucune réécriture SQL.
const db = {
  exec(...args) { return rawDb.exec(...args); },
  prepare(sql, options) {
    const stmt = rawDb.prepare(sql, options);
    return {
      get(...args) { return stmt.get(...args); },
      all(...args) { return stmt.all(...args); },
      run(...args) { return stmt.run(...args); },
      iterate(...args) { return stmt.iterate(...args); },
      columns(...args) { return stmt.columns(...args); },
      get sourceSQL() { return stmt.sourceSQL; },
      get expandedSQL() { return stmt.expandedSQL; },
      close() { return stmt.close(); }
    };
  }
};
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
function sqliteSelfTest() {
  const positional = db.prepare('SELECT ? AS value').get('dream-ok');
  if (positional?.value !== 'dream-ok') throw new Error('SQLite self-test positionnel échoué.');
  const named = db.prepare('SELECT :value AS value').get({ value: 'dream-ok' });
  if (named?.value !== 'dream-ok') throw new Error('SQLite self-test nommé échoué.');
}
sqliteSelfTest();
const transaction = (fn) => {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
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

// Migrations légères pour les versions précédentes.
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
CREATE TABLE IF NOT EXISTS command_permissions(guild_id TEXT NOT NULL,command TEXT NOT NULL,min_level INTEGER NOT NULL DEFAULT 0,levels TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,command));
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
  'ALTER TABLE bl ADD COLUMN actor_id TEXT'
]) { try { db.exec(statement); } catch {} }

const now = () => Date.now();
const parse = v => { try { return JSON.parse(v); } catch { return {}; } };
const json = v => JSON.stringify(v ?? {});
const ownerIds = () => new Set((process.env.OWNER_IDS || '').split(/[ ,;]+/).map(x => x.trim()).filter(Boolean));
for (const id of ownerIds()) db.prepare('INSERT OR IGNORE INTO owners(user_id,created_at) VALUES(?,?)').run(id, now());

const HIERARCHY = [
  ['SYS+',100],['SYS',90],['OWNER',80],['ND Modérateur',75],['ND Administrateur',70],['ND Head Staff',65],['ND Manager',60],
  ['AMBASSADRICE ND',55],['Protect',50],['Univers',45],['Ma',40],['PA',35],['Nova',30],['Void',25]
];
const KIND_LEVEL = { WLSYS: 0, WLROLE: 10, WLPV: 20, WLPROTECT: 30, WLTICKET: 40, WLPAIEMENT: 50, WLCUSTOMPLUS: 95 };
const LEVEL_NAME = n => HIERARCHY.find(([,v]) => v === n)?.[0] || (n >= 999 ? 'OWNER GLOBAL' : 'Aucun');
const PV_LEVEL_NAME = n => n === 95 ? 'CUSTOM+' : LEVEL_NAME(n);
const DEFAULT = {
  prefix: '=',
  prefixes: ['=','+','&','.','-'],
  ui: { color:'#5865F2', error:'#ED4245', ok:'#57F287', warn:'#FEE75C', footer:'DREAM', image:null, banner:null },
  logs: { auto:true, categories:['modération','accès','rôles','tickets','paiements','musique','système'] },
  stats: { auto:true, interval:10, channelId:null },
  roles: { protect:true, removeUnauthorized:true, interactionRoles:[], protectedMinLevel:25 },
  music: { enabled:true, volume:70, channelId:null },
  community: { welcome:true, welcomeChannelId:null, autoroles:[], reactionRoles:true, personalVoice:true },
  ticket: { categoryId:null, staffRoleId:null, types:[['sanction','Sanction'],['contribution','Contribution'],['bataillon','Bataillon Confirmé'],['autre','Autre']] },
  payment: { channelId:null, methods:['PayPal','Lydia','Virement'], currency:'€' },
  protectChannel: { channelId:null },
  automation: { health:5, backup:30 },
  hierarchy: HIERARCHY.map(([n]) => n),
  configuration: { welcome:{enabled:true,channelId:null,template:'Bienvenue {member} !'}, channels:{auto:true}, logs:{global:true,ticket:true,moderator:true,access:true,roles:true,music:true,payment:true,system:true}, destinations:{}, commands:{}, ticketCategory:null, welcomeCategory:null }
};
function cfg(gid) {
  const r = db.prepare('SELECT data FROM guilds WHERE id=?').get(gid);
  if (!r) { db.prepare('INSERT INTO guilds(id,data) VALUES(?,?)').run(gid, json(DEFAULT)); return structuredClone(DEFAULT); }
  const x = parse(r.data);
  const out = structuredClone(DEFAULT);
  for (const k of Object.keys(out)) out[k] = typeof out[k] === 'object' && !Array.isArray(out[k]) ? { ...out[k], ...(x[k] || {}) } : (x[k] ?? out[k]);
  return out;
}
function setCfg(gid, fn) { const c = cfg(gid); fn(c); db.prepare('INSERT INTO guilds(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(gid, json(c)); return c; }
function color(v,fallback) { return /^#[0-9A-Fa-f]{6}$/.test(String(v || '')) ? String(v) : fallback; }
function embed(gid, o={}) {
  const c=cfg(gid), e=new EmbedBuilder().setColor(color(o.color,c.ui.color));
  if(o.title)e.setTitle(o.title); if(o.description)e.setDescription(o.description);
  if(o.fields?.length)e.addFields(o.fields.slice(0,25)); if(o.footer!==false)e.setFooter({text:o.footer||c.ui.footer});
  if(o.thumbnail)e.setThumbnail(o.thumbnail); if(o.image)e.setImage(o.image); return e;
}
function embedFor(gid,uid,o={}){const u=uid?db.prepare('SELECT * FROM user_ui WHERE guild_id=? AND user_id=?').get(gid,uid):null;const c=cfg(gid);return embed(gid,{...o,color:o.color||u?.color||c.ui.color,footer:o.footer||u?.footer||c.ui.footer,image:o.image||u?.image||undefined});}
const row = (...x) => new ActionRowBuilder().addComponents(...x);
const btn = (id,label,style=ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const sel = (id,placeholder,options) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).addOptions(options.slice(0,25));
const userSel = id => new UserSelectMenuBuilder().setCustomId(id).setPlaceholder('Choisir un membre');
const roleSel = id => new RoleSelectMenuBuilder().setCustomId(id).setPlaceholder('Choisir un rôle');
const channelSel = (id,types=null) => { const x=new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder('Choisir un salon'); if(types) x.setChannelTypes(types); return x; };
function modal(id,title,fields) { const m=new ModalBuilder().setCustomId(id).setTitle(title); for(const f of fields) m.addComponents(row(new TextInputBuilder().setCustomId(f.id).setLabel(f.label).setStyle(f.style||TextInputStyle.Short).setRequired(f.required ?? true).setPlaceholder(f.placeholder||'').setValue(f.value||''))); return m; }

function globalOwner(uid) { return ownerIds().has(uid) || !!db.prepare('SELECT 1 FROM owners WHERE user_id=?').get(uid); }
function rank(gid,uid) {
  if(globalOwner(uid)) return 999;
  const rows=db.prepare("SELECT level FROM wl WHERE guild_id=? AND user_id=? AND kind!='WLCUSTOMPLUS'").all(gid,uid);
  return rows.length ? Math.max(...rows.map(x=>x.level)) : -1;
}
function hasKind(gid,uid,kind) { return globalOwner(uid) || !!db.prepare('SELECT 1 FROM wl WHERE guild_id=? AND user_id=? AND kind=?').get(gid,uid,kind); }
function hasCustomPlus(gid,uid) { return globalOwner(uid) || hasKind(gid,uid,'WLCUSTOMPLUS'); }
const DEFAULT_PREFIXES = ['=','+','&','.','-'];
const RESERVED_PREFIXES = new Set(['/']);
function customPrefix(gid,uid){ return db.prepare('SELECT prefix FROM custom_prefixes WHERE guild_id=? AND user_id=?').get(gid,uid)?.prefix || null; }
function allowedPrefixes(gid,uid){ return [...new Set([...DEFAULT_PREFIXES, customPrefix(gid,uid)].filter(Boolean))].sort((a,b)=>b.length-a.length); }
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
  const r=rank(gid,uid); if(r<minLevel)return false;
  const explicit=db.prepare('SELECT allow FROM wl_cmd WHERE guild_id=? AND user_id=? AND command=?').get(gid,uid,cmd);
  return explicit ? !!explicit.allow : r>=minLevel;
}
function botAccess(gid,botId){return db.prepare('SELECT * FROM bot_access WHERE guild_id=? AND bot_id=?').get(gid,botId)||null;}
function botAccepted(gid,botId){const x=botAccess(gid,botId);return !!x&&x.status==='accepted';}
function assertBotAccepted(gid,client){if(gid&&client?.user&&!botAccepted(gid,client.user.id))throw new Error('DREAM est en attente d’acceptation pour ce serveur.');}
const INVITE_PERMS={Commu:['ViewChannel','SendMessages','EmbedLinks','AttachFiles','ReadMessageHistory','ManageChannels','ManageRoles','Connect','Speak','ManageWebhooks'],Protect:['ViewChannel','SendMessages','EmbedLinks','AttachFiles','ReadMessageHistory','ManageChannels','ManageRoles','ManageMessages','KickMembers','BanMembers','ModerateMembers','ViewAuditLog','ManageWebhooks','ManageGuildExpressions','MoveMembers','MuteMembers','DeafenMembers','ManageNicknames']};
function oauthInvite(clientId,name='Protect'){const perms=PermissionsBitField.resolve(INVITE_PERMS[name]||INVITE_PERMS.Protect);return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${perms.toString()}`;}
const PERMISSION_LABELS={Administrator:'Administrateur',ViewAuditLog:'Voir le journal des audits',ManageGuild:'Gérer le serveur',ManageChannels:'Gérer les salons',ManageRoles:'Gérer les rôles',ManageWebhooks:'Gérer les webhooks',ManageMessages:'Gérer les messages',ManageThreads:'Gérer les fils',CreatePublicThreads:'Créer des fils publics',CreatePrivateThreads:'Créer des fils privés',SendMessages:'Envoyer des messages',EmbedLinks:'Intégrer des liens',AttachFiles:'Joindre des fichiers',ReadMessageHistory:'Lire l’historique',Connect:'Se connecter',Speak:'Parler',MuteMembers:'Rendre muet',DeafenMembers:'Rendre sourd',MoveMembers:'Déplacer les membres',KickMembers:'Expulser des membres',BanMembers:'Bannir des membres',ModerateMembers:'Modérer les membres',ManageGuildExpressions:'Gérer les expressions',ManageEmojisAndStickers:'Gérer les emojis et stickers',MentionEveryone:'Mentionner @everyone/@here',ManageNicknames:'Gérer les pseudos',ChangeNickname:'Changer son pseudo'};
const PERMISSION_KEYS=Object.keys(PermissionFlagsBits).filter(k=>typeof PermissionFlagsBits[k]==='bigint');
function permissionPanel(guild,key){const bit=PermissionFlagsBits[key];if(bit===undefined)return {title:'🔐 Permissions',description:'Permission inconnue.'};const roles=guild.roles.cache.filter(r=>r.id!==guild.id&&r.permissions.has(bit)).sort((a,b)=>b.position-a.position);const members=[...guild.members.cache.values()].filter(m=>!m.user.bot&&m.permissions.has(bit));return {title:`🔐 Permissions • ${PERMISSION_LABELS[key]||key}`,description:`**Rôles**\n${[...roles.values()].slice(0,12).map(r=>`${r} • ${r.members.size} membre${r.members.size>1?'s':''}`).join('\n')||'Aucun'}\n\n**Membres effectifs**\n${members.slice(0,12).map(m=>`<@${m.id}>`).join('\n')||'Aucun détecté dans le cache.'}${roles.size>12||members.length>12?'\n\n… liste abrégée.':''}`};}
function wlPanel(guild,kind='ALL'){const rows=db.prepare('SELECT * FROM wl WHERE guild_id=? ORDER BY level DESC,user_id').all(guild.id);const filtered=kind==='ALL'?rows:rows.filter(x=>x.kind===kind);return {title:'🛡️ WL • Serveur',description:`${filtered.slice(0,20).map(x=>`<@${x.user_id}> — **${LEVEL_NAME(x.level)}** • ${x.kind}`).join('\n')||'Aucune WL enregistrée.'}${filtered.length>20?'\n\n… liste abrégée.':''}`};}
function botAccessPanel(guild){const rows=db.prepare('SELECT * FROM bot_access WHERE guild_id=? ORDER BY bot_name').all(guild.id);return {title:'🔗 DREAM • Accès bot',description:rows.map(x=>{const m=guild.members.cache.get(x.bot_id);const perms=m?.permissions?.toArray?.().slice(0,18).map(k=>PERMISSION_LABELS[k]||k).join(' • ')||'Permissions non disponibles';return `${x.status==='accepted'?'🟢':x.status==='rejected'?'🔴':'🟠'} **${x.bot_name}** • ${x.status}\nAjouté par : ${x.inviter_id?`<@${x.inviter_id}>`:'Inconnu'}\nOwner : ${x.server_owner_id?`<@${x.server_owner_id}>`:'Inconnu'}\nPermissions actuelles : ${perms}${x.invite_url?`\n[Réinviter](${x.invite_url})`:''}`;}).join('\n\n')||'Aucune intégration enregistrée.'};}
function requireAccess(gid,uid,cmd,minLevel=0,kind=null) { if(!can(gid,uid,cmd,minLevel,kind)) throw new Error('Accès refusé ou hiérarchie insuffisante.'); }
function requireLevels(gid,uid,cmd,levels,{allowOwner=true}={}) {
  if(allowOwner && globalOwner(uid)) return true;
  const r=rank(gid,uid);
  if(!levels.includes(r)) throw new Error('Accès refusé pour ce niveau WL.');
  const explicit=db.prepare('SELECT allow FROM wl_cmd WHERE guild_id=? AND user_id=? AND command=?').get(gid,uid,cmd);
  if(explicit && !explicit.allow) throw new Error('Cette commande est désactivée pour ton accès.');
  return true;
}
function requireMinAndOwnScope(gid,uid,cmd,minLevel,kind=null){ return requireAccess(gid,uid,cmd,minLevel,kind); }
function higher(gid,actor,target) { return rank(gid,actor)>rank(gid,target); }
function setWL(gid,uid,kind,level) { db.prepare('INSERT INTO wl(guild_id,user_id,kind,level,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,user_id,kind) DO UPDATE SET level=excluded.level,updated_at=excluded.updated_at').run(gid,uid,kind,level,now(),now()); }
function delWL(gid,uid,kind=null) { if(kind)db.prepare('DELETE FROM wl WHERE guild_id=? AND user_id=? AND kind=?').run(gid,uid,kind); else db.prepare('DELETE FROM wl WHERE guild_id=? AND user_id=?').run(gid,uid); }
const WL_ROLE_GRADES = { OWNER: 1, SYS: 2, 'SYS+': 3 };
const WL_ROLE_GRADE_NAME = n => n === 3 ? 'SYS+' : n === 2 ? 'SYS' : 'OWNER';
const WL_ROLE_GRADE_LEVEL = { OWNER: 80, SYS: 90, 'SYS+': 100 };
function wlRole(gid, uid) { return db.prepare('SELECT * FROM wl_role WHERE guild_id=? AND user_id=?').get(gid, uid) || null; }
function wlRoleGrade(gid, uid) { const x=wlRole(gid,uid); return x ? WL_ROLE_GRADES[x.grade] || 0 : 0; }
function setWLRole(gid, uid, grade, anchorRoleId) {
  db.prepare('INSERT INTO wl_role(guild_id,user_id,grade,anchor_role_id,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET grade=excluded.grade,anchor_role_id=excluded.anchor_role_id,updated_at=excluded.updated_at').run(gid,uid,grade,anchorRoleId||null,now(),now());
}
function canGrantWLRole(gid, actorId, targetGrade) {
  if(globalOwner(actorId)) return true;
  const r=rank(gid,actorId);
  return r>=90 && r>=(targetGrade==='SYS+'?100:targetGrade==='SYS'?90:80);
}
function isProtectedRole(gid, role) {
  if(!role || role.managed || role.id===role.guild.id) return true;
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


async function log(guild,category,title,description,actor=null,result='OK') {
  const c=cfg(guild.id); if(!c.logs.categories.includes(category))return null;
  let id=db.prepare('SELECT channel_id FROM logs WHERE guild_id=? AND category=?').get(guild.id,category)?.channel_id;
  let ch=id?guild.channels.cache.get(id):null;
  if(!ch){ ch=await guild.channels.create({name:`logs-${category}`,type:ChannelType.GuildText,reason:'DREAM logs',permissionOverwrites:[{id:guild.roles.everyone.id,allow:[PermissionFlagsBits.ViewChannel],deny:[PermissionFlagsBits.SendMessages,PermissionFlagsBits.ManageMessages]}]}).catch(()=>null); if(ch)db.prepare('INSERT OR REPLACE INTO logs(guild_id,category,channel_id,created_at) VALUES(?,?,?,?)').run(guild.id,category,ch.id,now()); }
  if(!ch)return null;
  const message=await ch.send({embeds:[embed(guild.id,{title,description,fields:actor?[{name:'Membre',value:`<@${actor}>`,inline:true},{name:'Résultat',value:result,inline:true}]:[]})],allowedMentions:{parse:[]}}).catch(()=>null);
  if(message){
    db.prepare('INSERT OR REPLACE INTO log_messages(guild_id,message_id,channel_id,category,title,description,actor_id,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(guild.id,message.id,ch.id,category,title,description,actor||null,result,now());
  }
  return message;
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
async function restoreLogHistory(g, category, channel) {
  const rows=db.prepare('SELECT * FROM log_messages WHERE guild_id=? AND category=? ORDER BY created_at ASC').all(g.id,category);
  for(const rec of rows){
    const sent=await channel.send({embeds:[embed(g.id,{title:rec.title,description:rec.description,fields:rec.actor_id?[{name:'Membre',value:`<@${rec.actor_id}>`,inline:true},{name:'Résultat',value:rec.result,inline:true}]:[]})],allowedMentions:{parse:[]},reason:'DREAM log history restore'}).catch(()=>null);
    if(sent)db.prepare('INSERT OR REPLACE INTO log_messages(guild_id,message_id,channel_id,category,title,description,actor_id,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(g.id,sent.id,channel.id,category,rec.title,rec.description,rec.actor_id||null,rec.result,rec.created_at);
  }
}
async function ensureLogs(g) {
  for(const category of cfg(g.id).logs.categories){
    const id=db.prepare('SELECT channel_id FROM logs WHERE guild_id=? AND category=?').get(g.id,category)?.channel_id;
    const existing=id?g.channels.cache.get(id):null;
    if(existing){ await existing.permissionOverwrites.edit(g.roles.everyone,{SendMessages:false,ManageMessages:false,ViewChannel:true},'DREAM logs protection').catch(()=>{}); continue; }
    const ch=await g.channels.create({name:`logs-${category}`,type:ChannelType.GuildText,reason:'DREAM logs',permissionOverwrites:[{id:g.roles.everyone.id,allow:[PermissionFlagsBits.ViewChannel],deny:[PermissionFlagsBits.SendMessages,PermissionFlagsBits.ManageMessages]}]}).catch(()=>null);
    if(ch){
      db.prepare('INSERT OR REPLACE INTO logs(guild_id,category,channel_id,created_at) VALUES(?,?,?,?)').run(g.id,category,ch.id,now());
      await restoreLogHistory(g,category,ch);
    }
  }
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
  if(isProtectedRole(gid,role)) return globalOwner(uid) || rank(gid,uid)>=25;
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

// Compatibility entry kept for audits; protection is now event-driven to avoid guild-wide scans.
async function protectRoles(g){ return; }

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
async function requestSanction(ctx,target,reason='—',presetType=null,ephemeral=true){
  const gid=ctx.guild.id, actor=ctx.member||ctx.member;
  const id=createPendingSanction(gid,ctx.user?.id||ctx.author.id,target,reason,presetType);
  const payload={embeds:[embed(gid,sanctionPreview(gid,target,reason,presetType))],components:presetType?sanctionConfirmRows(id):[sanctionActionRow(id)],allowedMentions:{parse:[]}};
  if(ctx.reply)return ctx.reply({...payload,ephemeral});
  return ctx.channel.send(payload);
}

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
async function playNext(gid){const q=restoreMusicQueue(gid);if(q.loading||!q.items.length||!q.voice)return;q.loading=true;const item=q.items[0];try{const stream=await play.stream(item.url,{quality:2});const resource=createAudioResource(stream.stream,{inputType:stream.type,inlineVolume:true});resource.volume?.setVolume(q.volume);if(!q.player)q.player=createAudioPlayer({behaviors:{noSubscriber:NoSubscriberBehavior.Pause}});q.connection.subscribe(q.player);q.player.play(resource);q.player.removeAllListeners(AudioPlayerStatus.Idle);q.player.once(AudioPlayerStatus.Idle,()=>{q.items.shift();saveMusicQueue(gid);q.loading=false;playNext(gid).catch(()=>{});});}catch(e){q.items.shift();saveMusicQueue(gid);q.loading=false;if(q.text)q.text.send({content:`⚠️ Lecture impossible : ${String(e.message||e).slice(0,180)}`}).catch(()=>{});playNext(gid).catch(()=>{});}}
async function addMusic(guild,member,input){const vc=member.voice.channel;if(!vc)throw new Error('Rejoins un vocal.');const entries=await resolveMusicInput(input);const q=restoreMusicQueue(guild.id);if(!q.connection){q.connection=joinVoiceChannel({channelId:vc.id,guildId:guild.id,adapterCreator:guild.voiceAdapterCreator,selfDeaf:true});q.voice=vc;q.text=null;q.connection.on(VoiceConnectionStatus.Disconnected,()=>{q.connection=null;});await entersState(q.connection,VoiceConnectionStatus.Ready,15_000);}for(const resolved of entries){let title=resolved.title||resolved.url;if(!resolved.duration||resolved.duration==='?'){const info=await play.video_info(resolved.url).catch(()=>null);title=info?.video_details?.title||title;resolved.duration=info?.video_details?.durationRaw||'?';}q.items.push({...resolved,title,addedBy:member.id,createdAt:now()});}saveMusicQueue(guild.id);await playNext(guild.id);return {count:entries.length,first:entries[0]?.title||input};}
function musicQueueEmbed(gid,page=1){const q=restoreMusicQueue(gid);const total=Math.max(1,Math.ceil(q.items.length/MUSIC_PAGE_SIZE));const p=Math.min(Math.max(1,page),total);const start=(p-1)*MUSIC_PAGE_SIZE;const items=q.items.slice(start,start+MUSIC_PAGE_SIZE);return {total,page:p,embed:embed(gid,{title:'🎵 DREAM • File musicale',description:items.length?items.map((x,n)=>`${start+n+1}. **${String(x.title).slice(0,80)}** • ${x.provider||'Lien'}`).join('\n'):`**File vide**\nAjoute une musique ou une playlist.`,footer:`Page ${p}/${total} • ${q.items.length} titre${q.items.length>1?'s':''}`})};}



const COMMAND_CATALOG = [
  ['dream','Centre DREAM','general'],['wl','Gestion WL','access'],['wl-role','WL rôle','roles'],['music','Musique','music'],['logs','Logs','logs'],['role','Gestion rôles','roles'],['ticket','Tickets','ticket'],['payment','Paiements','payment'],['message','Messages','messages'],['ui','Interface','general'],['stats','Statistiques','stats'],['role-acces','Accès rôle','roles'],['addrole','Ajouter rôle','roles'],['delrole','Retirer rôle','roles'],['dog-add','DOG +','access'],['dog-del','DOG -','access'],['wet-info','WET info','moderation'],['prix','Prix','payment'],['lock','Lock','moderation'],['unlock','Unlock','moderation'],['wet','WET','moderation'],['giveaways','Giveaways','community']
];
const COMMAND_LABEL = new Map(COMMAND_CATALOG.map(x=>[x[0],x[1]]));
function ensureCommandConfig(gid){
  const ins=db.prepare('INSERT OR IGNORE INTO command_config(guild_id,command,active,visible,channel_id) VALUES(?,?,1,1,NULL)');
  transaction(()=>COMMAND_CATALOG.forEach(([n])=>ins.run(gid,n)));
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
  return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'✨ CUSTOM+ • Configuration personnelle',description:customPlusDescription(i.guildId,i.user.id),fields:[{name:'📋 Commandes personnelles',value:'Créer ou renommer uniquement les raccourcis autorisés.',inline:false},{name:'😀 Emojis personnels',value:'Ajouter jusqu’à 10 emojis au serveur, automatiquement nommés avec ton pseudo.',inline:false},{name:'🖼️ Panneaux',value:'Préparer tes affiches et contenus dans ton espace personnel et les destinations autorisées.',inline:false},{name:'🔊 Vocale',value:'Gérer ta vocale perso et, si ton niveau le permet, conserver sa confidentialité après ton départ.',inline:false}]})],components:[row(btn('custom:emojis','😀 Mes emojis'),btn('custom:commands','📋 Mes commandes')),row(btn('custom:prefix','⌨️ Mon préfixe'),btn('custom:appearance','🎨 Apparence')),row(btn('custom:voice','🔊 Ma vocale'),btn('custom:role','🎨 Mon rôle')),row(btn('configuration','Fermer'))],ephemeral:true});
}
async function customEmojiPanel(i){
  const rows=customEmojiRows(i.guildId,i.user.id);
  const desc=rows.length?rows.map((x,n)=>`${n+1}. <:${x.emoji_name}:${x.emoji_id}> **${x.emoji_name}**`).join('\n'):'Aucun emoji personnel pour le moment.';
  return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'😀 CUSTOM+ • Mes emojis',description:`${desc}\n\n**Utilisation :** ${rows.length}/10\nLes emojis sont ajoutés au serveur par le bot : Nitro n’est pas nécessaire pour les utiliser ici.`})],components:[row(btn('custom:emoji:add','Ajouter un emoji',ButtonStyle.Primary),btn('custom:emoji:delete','Supprimer')),row(btn('custom:configuration','Retour'))],ephemeral:true});
}
async function customCommandsPanel(i){
  const rows=db.prepare('SELECT * FROM custom_commands WHERE guild_id=? AND user_id=? ORDER BY command_name').all(i.guildId,i.user.id);
  const desc=rows.length?rows.map(x=>`• \`/${x.command_name}\` — ${x.active?'🟢 active':'🔴 inactive'} — ${x.kind}`).join('\n'):'Aucun raccourci personnel enregistré.';
  return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'📋 CUSTOM+ • Mes commandes',description:`${desc}\n\nLes raccourcis sont personnels, utilisables avec ton préfixe et limités aux fonctions prévues par DREAM.`})],components:[row(btn('custom:command:add','Créer un raccourci',ButtonStyle.Primary),btn('custom:alias','Renommer une commande')),row(btn('custom:prefix','Préfixe')),row(btn('custom:configuration','Retour'))],ephemeral:true});
}
async function customAppearancePanel(i){const c=ensureCustomConfig(i.guildId,i.user.id);return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'🎨 CUSTOM+ • Apparence',description:`**Nom webhook :** ${c.webhook_name||'non configuré'}\n**Couleur :** ${c.color||cfg(i.guildId).ui.color}\n**Footer :** ${c.footer||cfg(i.guildId).ui.footer}\n\nLe vrai nom du bot Discord ne peut pas être modifié ici.`})],components:[row(btn('custom:appearance:name','Nom webhook'),btn('custom:appearance:color','Couleur')),row(btn('custom:appearance:footer','Footer'),btn('custom:configuration','Retour'))],ephemeral:true});}
async function customRolePanel(i){
  if(!hasCustomPlus(i.guildId,i.user.id)) throw new Error('WL CUSTOM+ requise.');
  const c=ensureCustomConfig(i.guildId,i.user.id); const role=c.personal_role_id?i.guild.roles.cache.get(c.personal_role_id):null;
  if(!role) return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'🎨 CUSTOM+ • Mon rôle',description:'Ton rôle personnel n’est pas encore disponible. Le prochain refresh automatique tentera de le recréer.'})],ephemeral:true});
  const access=db.prepare('SELECT user_id FROM role_access WHERE guild_id=? AND role_id=? ORDER BY created_at').all(i.guildId,role.id);
  return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'🎨 CUSTOM+ • Mon rôle',description:`**Rôle :** ${role}
**Position :** ${role.position}
**Accès personnalisés :** ${access.length}

Ce rôle reste limité à ton espace CUSTOM+ et ne peut pas devenir un rôle protégé ou dépasser la hiérarchie du bot.`})],components:[row(btn('custom:role:access','👥 Gérer les accès')),row(btn('custom:configuration','Retour'))],ephemeral:true});
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
    `**Niveau PV :** ${level>=999?'OWNER GLOBAL':PV_LEVEL_NAME(level)}`,
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
  return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'🔊 CUSTOM+ • Ma vocale',description:desc})],components,ephemeral:true});
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
  if(hasCustomPlus(i.guildId,i.user.id) && rank(i.guildId,i.user.id)<90) return openCustomConfiguration(i);
  requireAccess(i.guildId,i.user.id,'configuration',90);
  ensureCommandConfig(i.guildId);
  return i.reply({embeds:[configurationEmbed(i.guild)],components:[row(sel('config:section','Choisir ce que tu veux régler',[{label:'Installation',value:'install',description:'Catégories, salons, panneaux, réparation'},{label:'Commandes',value:'commands',description:'Activer, masquer, rediriger'},{label:'Salons',value:'channels',description:'Toutes les destinations'},{label:'Logs',value:'logs',description:'Catégories et destinations'},{label:'Permissions',value:'permissions',description:'Permissions et détenteurs'},{label:'WL',value:'wl',description:'WL interne et membres'},{label:'Accès bot',value:'access',description:'Accès DREAM de ce serveur'},{label:'Interface',value:'ui',description:'Couleurs et apparence'},{label:'Bienvenue',value:'welcome',description:'Catégorie, salon et message'}])),row(btn('config:apply','Tout installer',ButtonStyle.Primary),btn('config:status','État'))],ephemeral:true});
}
async function configSection(i,v){if(v==='install')return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Installation',description:'DREAM peut créer ou réparer les catégories, salons, logs et panneaux manquants. Tu peux aussi tout choisir manuellement.'})],components:[row(btn('config:install:all','Tout installer',ButtonStyle.Primary),btn('config:install:preview','Prévisualiser')),row(btn('configuration','Retour'))],ephemeral:true});if(v==='commands')return configCommandPanel(i);if(v==='channels')return configChannelsPanel(i);if(v==='logs')return configLogsPanel(i);if(v==='permissions')return configPermissionsPanel(i);if(v==='wl')return configWLPanel(i);if(v==='access')return configAccessPanel(i);if(v==='ui')return configUI(i);if(v==='welcome')return configWelcome(i);return openConfiguration(i);}
async function configPermissionsPanel(i,page=0){const max=Math.ceil(PERMISSION_KEYS.length/25);const keys=PERMISSION_KEYS.slice(page*25,(page+1)*25);return i.reply({embeds:[embed(i.guildId,{title:`🔐 Permissions • Serveur (${page+1}/${max})`,description:'Choisis une permission pour voir les rôles et membres qui la possèdent. Toutes les permissions Discord sont couvertes.'})],components:[row(sel(`config:permission:${page}`,'Choisir une permission',keys.map(k=>({label:PERMISSION_LABELS[k]||k,value:k,description:k})))),row(btn(page>0?`config:permissionPage:${page-1}`:'config:permissionDisabledPrev','← Précédent'),btn(page<max-1?`config:permissionPage:${page+1}`:'config:permissionDisabledNext','Suivant →')),row(btn('configuration','Retour'))],ephemeral:true});}
async function configWLPanel(i){return i.reply({embeds:[embed(i.guildId,wlPanel(i.guild))],components:[row(sel('config:wl','Filtrer la WL',[{label:'Toute la WL',value:'ALL',description:'Tous les accès internes'},{label:'WL principale',value:'WLSYS',description:'Accès hiérarchiques'},{label:'WL rôle',value:'WLROLE',description:'Gestion des rôles'},{label:'WL PV',value:'WLPV',description:'Gestion des PV'},{label:'Protect',value:'WLPROTECT',description:'Accès Protect'},{label:'Paiements',value:'WLPAIEMENT',description:'Accès paiements'},{label:'CUSTOM+',value:'WLCUSTOMPLUS',description:'Espace CUSTOM+'}])),row(btn('configuration','Retour'))],ephemeral:true});}
async function configAccessPanel(i){return i.reply({embeds:[embed(i.guildId,botAccessPanel(i.guild))],components:[row(btn('config:access:refresh','Actualiser'),btn('configuration','Retour'))],ephemeral:true});}
async function configChannelsPanel(i){return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Salons • Serveur',description:'Chaque destination peut être choisie. Les catégories ticket et bienvenue sont séparées pour permettre un vrai setup propre.'})],components:[row(channelSel('config:channel:global')),row(channelSel('config:channel:moderator')),row(channelSel('config:channel:ticket')),row(channelSel('config:channel:giveaways')),row(channelSel('config:channel:welcome')),row(channelSel('config:category:ticket',[ChannelType.GuildCategory])),row(channelSel('config:category:welcome',[ChannelType.GuildCategory])),row(btn('configuration','Retour'))],ephemeral:true});}
async function configLogsPanel(i){const c=cfg(i.guildId);const vals=Object.entries(c.configuration.logs||{}).map(([k,v])=>({label:k,value:k,description:v?'Activé':'Désactivé'}));return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Logs • Serveur',description:'Active ou désactive chaque famille. DREAM répare les destinations supprimées.'})],components:[row(sel('config:log','Choisir un log',vals)),row(btn('config:repairlogs','Réparer maintenant',ButtonStyle.Primary),btn('configuration','Retour'))],ephemeral:true});}
async function configUI(i){const c=cfg(i.guildId);return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Interface',description:`Couleur : **${c.ui.color}**\nErreur : **${c.ui.error}**\nSuccès : **${c.ui.ok}**\nAvertissement : **${c.ui.warn}**\nFooter : **${c.ui.footer}**`})],components:[row(btn('config:color','Couleurs'),btn('config:footer','Footer')),row(btn('configuration','Retour'))],ephemeral:true});}
async function configWelcome(i){const c=cfg(i.guildId);return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Bienvenue',description:`**Statut** : ${c.configuration.welcome.enabled?'🟢 Activée':'🔴 Désactivée'}\n**Salon** : ${c.configuration.welcome.channelId?`<#${c.configuration.welcome.channelId}>`:'Non défini'}\n**Catégorie** : ${c.configuration.destinations?.welcomeCategory?`<#${c.configuration.destinations.welcomeCategory}>`:'Non définie'}\n**Message** : ${c.configuration.welcome.template}\n\nVariables : \`{member}\` • \`{server}\``})],components:[row(channelSel('config:channel:welcome')),row(channelSel('config:category:welcome',[ChannelType.GuildCategory])),row(btn('config:welcomeToggle',c.configuration.welcome.enabled?'Désactiver':'Activer'),btn('config:welcomeText','Modifier le texte')),row(btn('configuration','Retour'))],ephemeral:true});}
async function configStatus(i){return i.reply({embeds:[configurationEmbed(i.guild)],components:[row(btn('config:apply','Réparer / appliquer maintenant',ButtonStyle.Primary),btn('configuration','Retour'))],ephemeral:true});}

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

async function refreshGuild(g){
  if(!botAccepted(g.id,clients.two.user?.id))return;
  cfg(g.id);
  ensureCommandConfig(g.id);
  await autoSetup(g);
  await ensureLogs(g);
  await repairLocks(g);
  await updateStats(g);
  await refreshManagedMessages(g);
  for(const x of db.prepare("SELECT user_id FROM wl WHERE guild_id=? AND kind='WLCUSTOMPLUS'").all(g.id)) await provisionCustomPlus(g,x.user_id);
  await syncCustomCommands(g).catch(()=>{});
  for(const x of db.prepare('SELECT * FROM custom_emojis WHERE guild_id=?').all(g.id)){if(!g.emojis.cache.has(x.emoji_id))db.prepare('DELETE FROM custom_emojis WHERE guild_id=? AND emoji_id=?').run(g.id,x.emoji_id);}
}

async function backup(){
  const dir=path.join(DATA,'backups');fs.mkdirSync(dir,{recursive:true});
  const dest=path.join(dir,`dream-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`); try{fs.copyFileSync(process.env.DATABASE_PATH||path.join(DATA,'dream.sqlite'),dest);}catch{}
  const files=fs.readdirSync(dir).sort();for(const f of files.slice(0,-10))fs.rmSync(path.join(dir,f),{force:true});
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
async function openFAQ(i,topic='home'){const pages={home:['☑️ La FAQ DREAM','Choisis simplement ce que tu veux connaître.'],general:['📌 FAQ • Général','Serveur, fonctionnement et accès DREAM.'],tickets:['🎫 FAQ • Tickets','Création, catégories, fermeture et suivi.'],wl:['🛡️ FAQ • WL','Niveaux internes, droits et hiérarchie.'],bot:['🤖 FAQ • Bots','Commu, Protect et validation d’intégration.']};const [title,description]=pages[topic]||pages.home;const components=topic==='home'?[row(btn('faq:general','Général'),btn('faq:tickets','Tickets'),btn('faq:wl','WL'),btn('faq:bot','Bots'))]:[row(btn('faq:home','Retour FAQ'))];return i.reply({embeds:[embed(i.guildId,{title,description})],components,ephemeral:true});}
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
  return i.reply({embeds:[e],components,ephemeral:true});
}

async function handleButton(i){
  const [scope,action,extra,...rest]=i.customId.split(':');
  if(scope==='config'){
    requireAccess(i.guildId,i.user.id,'configuration',90);
    if(action==='section')return configSection(i,extra);
    if(action==='permissionPage'){const page=Number(extra||0);return configPermissionsPanel(i,Number.isFinite(page)&&page>=0?page:0);}
    if(action==='permissionDisabledPrev'||action==='permissionDisabledNext')return configPermissionsPanel(i,0);
    if(action==='access'&&extra==='refresh')return configAccessPanel(i);
    if(action==='apply'){await autoSetup(i.guild);await ensureLogs(i.guild);await repairLocks(i.guild);await protectRoles(i.guild);await updateStats(i.guild);await refreshManagedMessages(i.guild);return i.update({embeds:[configurationEmbed(i.guild)],components:[row(btn('configuration','Retour'))],ephemeral:true});}
    if(action==='install'&&extra==='all'){await autoSetup(i.guild);await ensureLogs(i.guild);return i.update({embeds:[configurationEmbed(i.guild)],components:[row(btn('configuration','Retour'))],ephemeral:true});}
    if(action==='install'&&extra==='preview'){const c=cfg(i.guildId);return i.reply({embeds:[embed(i.guildId,{title:'🔎 Installation • Aperçu',description:`Catégorie ticket : ${c.configuration.destinations?.ticketCategory?'définie':'à définir/créer'}\nSalon ticket : ${c.configuration.destinations?.ticket?'défini':'à définir/créer'}\nCatégorie bienvenue : ${c.configuration.destinations?.welcomeCategory?'définie':'à définir/créer'}\nSalon bienvenue : ${c.configuration.welcome.channelId?'défini':'à définir/créer'}`})],components:[row(btn('configuration','Retour'))],ephemeral:true});}
    if(action==='repairlogs'){await ensureLogs(i.guild);return i.reply({content:'✅ Logs vérifiés et réparés.',ephemeral:true});}
  }

  if(scope==='faq'){return openFAQ(i,action==='home'?'home':action);}

  if(scope==='customcleanup'){
    if(!globalOwner(i.user.id)&&rank(i.guildId,i.user.id)<100)throw new Error('Accès insuffisant.');
    const target=extra;const pending=db.prepare('SELECT * FROM custom_emoji_cleanup WHERE guild_id=? AND user_id=?').get(i.guildId,target);if(!pending)throw new Error('Cette demande n’est plus disponible.');
    if(action==='confirm'||action==='keepall'||action==='deleteall'){
      const keep=action==='keepall'?customEmojiRows(i.guildId,target).map(x=>x.emoji_id):(action==='deleteall'?parse('[]'):parse(pending.keep_ids));const keepSet=new Set(keep);const rows=customEmojiRows(i.guildId,target);
      for(const x of rows)if(!keepSet.has(x.emoji_id)){const e=i.guild.emojis.cache.get(x.emoji_id);if(e)await e.delete('CUSTOM+ removed - cleanup').catch(()=>{});db.prepare('DELETE FROM custom_emojis WHERE guild_id=? AND emoji_id=?').run(i.guildId,x.emoji_id);}
      db.prepare('DELETE FROM custom_emoji_cleanup WHERE guild_id=? AND user_id=?').run(i.guildId,target);
      return i.update({embeds:[embed(i.guildId,{title:'😀 Emojis traités',description:`<@${target}> : **${keepSet.size}** emoji${keepSet.size>1?'s':''} conservé${keepSet.size>1?'s':''}.`})],components:[]});
    }
  }

  if(i.customId==='configuration') return openConfiguration(i);
  if(scope==='customplus'&&action==='manage'){if(!globalOwner(i.user.id)&&rank(i.guildId,i.user.id)<100)throw new Error('Seuls les Owner/SYS+ peuvent gérer CUSTOM+.');return i.reply({embeds:[embed(i.guildId,{title:'✨ CUSTOM+ • Attribution',description:'Sélectionne un membre pour activer ou retirer sa WL CUSTOM+.\n\nCUSTOM+ reste une WL spécialisée : elle ne donne pas les pouvoirs généraux de SYS+.'})],components:[row(userSel('customplus:user')),row(btn('dream:wl','Retour'))],ephemeral:true});}
  if(scope==='custom'&&action==='configuration'&&extra===undefined) return openCustomConfiguration(i);
  if(scope==='custom'&&action==='emojis'&&extra===undefined) return customEmojiPanel(i);
  if(scope==='custom'&&action==='commands'&&extra===undefined) return customCommandsPanel(i);
  if(scope==='custom'&&action==='appearance'&&extra===undefined) return customAppearancePanel(i);
  if(scope==='custom'&&action==='voice'&&extra===undefined) return customVoicePanel(i);
  if(scope==='custom'&&action==='emoji'&&extra==='add'){ if(!hasCustomPlus(i.guildId,i.user.id)) throw new Error('WL CUSTOM+ requise.'); return i.showModal(modal('custom:emoji:add:modal','Ajouter un emoji',[{id:'url',label:'Lien direct vers PNG, JPG ou GIF',placeholder:'https://…'}])); }
  if(scope==='custom'&&action==='emoji'&&extra==='delete'){ const rows=customEmojiRows(i.guildId,i.user.id); if(!rows.length) throw new Error('Tu n’as aucun emoji personnel.'); return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'🗑️ CUSTOM+ • Supprimer un emoji',description:'Choisis l’emoji à retirer.'})],components:[row(sel('custom:emoji:remove','Choisir un emoji',rows.map(x=>({label:x.emoji_name,value:x.emoji_id}))))],ephemeral:true}); }
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
    return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'👥 CUSTOM+ • Accès vocal',description:'Ajoute ou retire un accès personnalisé à ta propre vocale.'})],components:[row(userSel('custom:voice:access:user')),row(btn('custom:voice','Retour'))],ephemeral:true});
  }
  if(scope==='custom'&&action==='voice'&&extra==='mute'){
    if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');
    const vc=i.guild.channels.cache.get(customVoiceId(i.guildId,i.user.id)); if(!vc||!vc.members.size)throw new Error('Personne n’est actuellement dans ta vocale.');
    return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'🔇 CUSTOM+ • Mute',description:'Choisis un membre présent dans ta vocale.'})],components:[row(userSel('custom:voice:mute:user')),row(btn('custom:voice','Retour'))],ephemeral:true});
  }
  if(scope==='custom'&&action==='voice'&&extra==='kick'){
    if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');
    const vc=i.guild.channels.cache.get(customVoiceId(i.guildId,i.user.id)); if(!vc||!vc.members.size)throw new Error('Personne n’est actuellement dans ta vocale.');
    return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'↩️ CUSTOM+ • Déconnexion',description:'Choisis un membre présent dans ta vocale.'})],components:[row(userSel('custom:voice:kick:user')),row(btn('custom:voice','Retour'))],ephemeral:true});
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
    if(action==='repairlogs'){ await ensureLogs(i.guild); return i.reply({content:'✅ Les logs ont été vérifiés et réparés.',ephemeral:true}); }
    if(action==='welcomeToggle'){ setCfg(i.guildId,c=>c.configuration.welcome.enabled=!c.configuration.welcome.enabled); return configWelcome(i); }
    if(action==='welcomeText') return i.showModal(modal('config:welcomeText:modal','Message de bienvenue',[{id:'text',label:'Message',style:TextInputStyle.Paragraph,placeholder:'Bienvenue {member} !',value:cfg(i.guildId).configuration.welcome.template}]));
    if(action==='color') return i.showModal(modal('config:color:modal','Couleurs des embeds',[{id:'main',label:'Couleur principale',placeholder:'#5865F2',value:cfg(i.guildId).ui.color},{id:'error',label:'Couleur erreur',placeholder:'#ED4245',value:cfg(i.guildId).ui.error},{id:'ok',label:'Couleur succès',placeholder:'#57F287',value:cfg(i.guildId).ui.ok},{id:'warn',label:'Couleur avertissement',placeholder:'#FEE75C',value:cfg(i.guildId).ui.warn}]));
    if(action==='footer') return i.showModal(modal('config:footer:modal','Footer global',[{id:'footer',label:'Footer',placeholder:'DREAM',value:cfg(i.guildId).ui.footer}]));
  }
  if(scope==='dream')return openDream(i,action);
  if(scope==='wl'){
    requireAccess(i.guildId,i.user.id,'wl',50);
    if(action==='add')return i.reply({content:'Choisis le membre puis le niveau.',components:[row(userSel('wl:user')),row(sel('wl:level','Niveau',[...HIERARCHY.map(([n,v])=>({label:n,value:String(v)}))]))],ephemeral:true});
    if(action==='list'){const rows=db.prepare('SELECT * FROM wl WHERE guild_id=? ORDER BY level DESC').all(i.guildId);return i.reply({embeds:[embed(i.guildId,{title:'🔐 WL • Liste',description:rows.map(x=>`<@${x.user_id}> — **${LEVEL_NAME(x.level)}** — ${x.kind}`).join('\n')||'Aucun accès.'})],ephemeral:true});}
    if(action==='commands')return i.reply({embeds:[embed(i.guildId,{title:'🔐 WL • Commandes',description:'Les accès sont hiérarchiques et peuvent être affinés par utilisateur via la table de permissions.'})],ephemeral:true});
  }
  if(scope==='wlrole'){
    if(action==='panel'){
      requireAccess(i.guildId,i.user.id,'wl-role',90);
      const mine=wlRole(i.guildId,i.user.id);
      return i.reply({embeds:[embed(i.guildId,{title:'🛡️ WL rôle',description:`La WL rôle est indépendante des rôles Discord.\n\n**Ton grade :** ${mine?.grade||'Aucun'}\n**Portée :** ${wlRoleScopeDescription(i.guildId,i.user.id)}\n\n**OWNER / SYS :** rôle sélectionné + tous les rôles en dessous.\n**SYS+ :** tous les rôles gérables sous le plus haut rôle du bot.\n**Exception :** un rôle protégé ne peut jamais être distribué par cette WL.`})],components:[row(btn('wlrole:assign','Attribuer / modifier'),btn('wlrole:list','Liste')),row(btn('dream:roles','Retour'))],ephemeral:true});
    }
    if(action==='assign'){
      requireAccess(i.guildId,i.user.id,'wl-role',90);
      return i.reply({content:'Choisis le membre puis son grade. Le rôle de référence sera demandé seulement pour OWNER et SYS.',components:[row(userSel('wlrole:user'))],ephemeral:true});
    }
    if(action==='list'){
      requireAccess(i.guildId,i.user.id,'wl-role',90);
      const rows=db.prepare("SELECT * FROM wl_role WHERE guild_id=? ORDER BY CASE grade WHEN 'SYS+' THEN 3 WHEN 'SYS' THEN 2 ELSE 1 END DESC, created_at").all(i.guildId);
      const description=rows.map(x=>{ const ref=x.anchor_role_id?`rôle de référence : <@&${x.anchor_role_id}>`:'tous les rôles gérables'; return `<@${x.user_id}> — **${x.grade}** — ${ref}`; }).join('\n') || 'Aucun membre configuré.';
      return i.reply({embeds:[embed(i.guildId,{title:'🛡️ WL rôle • Liste',description})],allowedMentions:{parse:[]},ephemeral:true});
    }
  }
  if(scope==='role'){
    if(!globalOwner(i.user.id) && !wlRole(i.guildId,i.user.id)) throw new Error('WL rôle requise.');
    if(action==='create')return i.showModal(modal('role:create:modal','Créer un rôle',[{id:'name',label:'Nom du rôle',placeholder:'Ex : Dream • Premium'}]));
    if(action==='access')return i.reply({content:'Choisis le rôle.',components:[row(roleSel('role:access:role'))],ephemeral:true});
    if(action==='personal')return i.showModal(modal('role:personal:modal','Rôle personnel',[{id:'name',label:'Nom du rôle',placeholder:'Mon rôle'}]));
    if(action==='presets')return i.reply({embeds:[embed(i.guildId,{title:'🎨 Presets',description:'4 presets prêts à l’emploi : Aurora, Sunset, Ocean, Lavender. Le rôle peut ensuite être modifié via le panneau couleur.'})],components:[row(sel('role:preset','Choisir un preset',[{label:'Aurora',value:'aurora'},{label:'Sunset',value:'sunset'},{label:'Ocean',value:'ocean'},{label:'Lavender',value:'lavender'}]))],ephemeral:true});
    if(action==='protect'){
      requireAccess(i.guildId,i.user.id,'role-protect',90);
      return i.reply({content:'Choisis le rôle à protéger. Un rôle protégé ne pourra jamais être distribué par la WL rôle.',components:[row(roleSel('role:protect:select'))],ephemeral:true});
    }
  }
  if(scope==='pv'){
    if(!hasPVAccess(i.guildId,i.user.id))throw new Error('WL PV ou CUSTOM+ requise.');
    if(action==='create'){const ch=i.member.voice.channel;if(!ch)throw new Error('Rejoins un vocal.');if(hasCustomPlus(i.guildId,i.user.id)&&!hasKind(i.guildId,i.user.id,'WLPV')&&customVoiceId(i.guildId,i.user.id)!==ch.id)throw new Error('CUSTOM+ gère uniquement sa vocale personnelle.');const old=db.prepare('SELECT * FROM pv WHERE channel_id=?').get(ch.id);if(old&&!higher(i.guildId,i.user.id,old.owner_id))throw new Error('Ce PV appartient à une hiérarchie supérieure.');const level=pvRank(i.guildId,i.user.id);if(level<0)throw new Error('WL PV requise.');db.prepare('INSERT INTO pv(guild_id,channel_id,owner_id,level,access_mode,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET owner_id=excluded.owner_id,level=excluded.level,access_mode=excluded.access_mode').run(i.guildId,ch.id,i.user.id,level,'DENY',now());await ch.permissionOverwrites.edit(i.guild.roles.everyone,{Connect:false},'DREAM PV').catch(()=>{});await ch.permissionOverwrites.edit(i.member,{Connect:true},'DREAM PV owner').catch(()=>{});return i.reply({content:`🔊 PV activée ici. Niveau : **${PV_LEVEL_NAME(level)}**.`,ephemeral:true});}
    if(action==='access')return i.showModal(modal('pv:access:modal','Accès PV',[{id:'user',label:'ID, mention ou nom',placeholder:'123456789...'}]));
    if(action==='info'){const x=db.prepare('SELECT * FROM pv WHERE guild_id=? AND channel_id=?').get(i.guildId,i.member.voice.channelId||'');return i.reply({embeds:[embed(i.guildId,{title:'🔊 PV • Infos',description:x?`Propriétaire : <@${x.owner_id}>\nNiveau : **${LEVEL_NAME(x.level)}**\nAccès : **${x.access_mode}**`:'Aucun PV ici.'})],ephemeral:true});}
  }
  if(scope==='music'&&action==='page'){
    const qv=musicQueueEmbed(i.guildId,Number(extra||1));
    return i.update({embeds:[qv.embed],components:[row(btn(`music:page:${Math.max(1,qv.page-1)}`,'◀️'),btn(`music:page:${Math.min(qv.total,qv.page+1)}`,'▶️')),row(btn('music:add','Ajouter'),btn('music:stop','Stop'))]});
  }
  if(scope==='music'){
    requireAccess(i.guildId,i.user.id,'music',0);
    const q=queue(i.guildId);
    if(action==='add')return i.showModal(modal('music:add:modal','Ajouter à la file',[{id:'url',label:'URL / playlist',placeholder:'YouTube, SoundCloud, Spotify, Deezer…'}]));
    if(action==='queue'){const qv=musicQueueEmbed(i.guildId,1);return i.reply({embeds:[qv.embed],components:[row(btn('music:page:1','◀️'),btn(`music:page:${Math.min(qv.total,2)}`,'▶️')),row(btn('music:add','Ajouter'),btn('music:stop','Stop'))],ephemeral:true});}
    if(action==='next'){if(q.player)q.player.stop();return i.reply({content:'⏭️ Suivant.',ephemeral:true});}
    if(action==='stop'){q.items=[];saveMusicQueue(i.guildId);q.player?.stop();q.connection?.destroy();q.connection=null;q.voice=null;return i.reply({content:'⏹️ Musique arrêtée.',ephemeral:true});}
  }
  if(scope==='logs'){
    requireAccess(i.guildId,i.user.id,'logs',50);
    if(action==='repair'){await ensureLogs(i.guild);return i.reply({content:'✅ Logs vérifiés et réparés.',ephemeral:true});}
    if(action==='toggle'){setCfg(i.guildId,c=>c.logs.auto=!c.logs.auto);return i.reply({content:`✅ Auto logs : **${cfg(i.guildId).logs.auto?'ON':'OFF'}**`,ephemeral:true});}
  }
  if(scope==='ticket'){
    if(action==='open'){const type=extra||'autre';const typeLabel=(cfg(i.guildId).ticket.types.find(x=>x[0]===type)||['autre','Autre'])[1];const base=`ticket-${type}-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,90);const ch=await i.guild.channels.create({name:base,type:ChannelType.GuildText,parent:cfg(i.guildId).ticket.categoryId||cfg(i.guildId).configuration.destinations?.ticketCategory||undefined,permissionOverwrites:[{id:i.guild.id,deny:[PermissionFlagsBits.ViewChannel]},{id:i.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]}]});db.prepare('INSERT INTO tickets(guild_id,channel_id,creator_id,status,created_at) VALUES(?,?,?,?,?)').run(i.guildId,ch.id,i.user.id,'OPEN',now());await ch.send({embeds:[embed(i.guildId,{title:`🎫 Ticket • ${typeLabel}`,description:`Bienvenue ${i.user}.\n\nDécris ta demande ici.`})],components:[row(btn('ticket:close','Fermer',ButtonStyle.Danger))]});await log(i.guild,'tickets','Ticket ouvert',`${ch} • ${typeLabel} par <@${i.user.id}>`,i.user.id);return i.reply({content:`✅ ${ch}`,ephemeral:true});}
    if(action==='close'){const t=db.prepare('SELECT * FROM tickets WHERE guild_id=? AND channel_id=? AND status=?').get(i.guildId,i.channelId,'OPEN');if(!t)throw new Error('Ce salon n’est pas un ticket ouvert.');if(t.creator_id!==i.user.id)requireAccess(i.guildId,i.user.id,'ticket-close',40,'WLTICKET');db.prepare('UPDATE tickets SET status=?,closed_at=? WHERE id=?').run('CLOSED',now(),t.id);await log(i.guild,'tickets','Ticket fermé',`Salon <#${i.channelId}>`,i.user.id);return i.reply({content:'🔒 Ticket fermé.',ephemeral:true});}
    if(action==='repair'){for(const t of db.prepare('SELECT * FROM tickets WHERE guild_id=? AND status=?').all(i.guildId,'OPEN'))if(!i.guild.channels.cache.has(t.channel_id))db.prepare('UPDATE tickets SET status=?,closed_at=? WHERE id=?').run('CLOSED',now(),t.id);return i.reply({content:'✅ Tickets vérifiés.',ephemeral:true});}
  }
  if(scope==='pay'){
    requireAccess(i.guildId,i.user.id,'payment',50,'WLPAIEMENT');
    if(action==='add')return i.showModal(modal('pay:add:modal','Ajouter un paiement',[{id:'user',label:'ID / mention',placeholder:'123...'},{id:'amount',label:'Montant',placeholder:'10.00'},{id:'label',label:'Libellé',placeholder:'Commande'},{id:'status',label:'Statut',placeholder:'PENDING / PAID / REFUSED'}]));
    if(action==='list'){const rows=db.prepare('SELECT * FROM payments WHERE guild_id=? ORDER BY created_at DESC LIMIT 20').all(i.guildId);return i.reply({embeds:[embed(i.guildId,{title:'💳 Paiements',description:rows.map(x=>`#${x.id} • <@${x.user_id}> • ${x.amount} ${cfg(i.guildId).payment.currency} • ${x.status}`).join('\n')||'Aucun paiement.'})],ephemeral:true});}
    if(action==='prices')return i.reply({embeds:[embed(i.guildId,{title:'💳 Prix',description:(db.prepare('SELECT * FROM prices WHERE guild_id=? AND active=1 ORDER BY label').all(i.guildId).map(x=>`**${x.label}** — ${x.amount} ${cfg(i.guildId).payment.currency}`).join('\n')||'Aucun prix.')})],ephemeral:true});
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
    if(action==='ui')return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'⚙️ UI',description:`Couleur globale : **${cfg(i.guildId).ui.color}**\nFooter global : **${cfg(i.guildId).ui.footer}**\nTon override : ${db.prepare('SELECT 1 FROM user_ui WHERE guild_id=? AND user_id=?').get(i.guildId,i.user.id)?'activé':'aucun'}`})],components:[row(btn('set:ui:color','Couleur personnelle'),btn('set:ui:footer','Footer personnel'))],ephemeral:true});
    if(action==='community')return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Communauté',description:`Bienvenue : **${cfg(i.guildId).community.welcome?'ON':'OFF'}**\nRôles auto : **${cfg(i.guildId).community.autoroles.length}**\nPV : **${cfg(i.guildId).community.personalVoice?'ON':'OFF'}**`})],ephemeral:true});
    if(action==='auto')return i.reply({embeds:[embed(i.guildId,{title:'⚙️ Automatisation',description:`Logs : **${cfg(i.guildId).logs.auto?'ON':'OFF'}**\nStats : **${cfg(i.guildId).stats.auto?'ON':'OFF'}**\nRéparation globale : toutes les 30 minutes + contrôles instantanés.`})],ephemeral:true});
  }
  if(scope==='stats'){
    requireAccess(i.guildId,i.user.id,'stats',0);
    if(action==='refresh'){await updateStats(i.guild);return i.reply({content:'📊 Statistiques actualisées.',ephemeral:true});}
    if(action==='auto'){setCfg(i.guildId,c=>c.stats.auto=!c.stats.auto);return i.reply({content:`📊 Auto stats : **${cfg(i.guildId).stats.auto?'ON':'OFF'}**`,ephemeral:true});}
  }
}

async function handleSelect(i){
  const [scope,action,extra]=i.customId.split(':');
  if(scope==='config'){
    requireAccess(i.guildId,i.user.id,'configuration',90);
    if(action==='section')return configSection(i,i.values[0]);
    if(action==='permission'){const parts=i.customId.split(':');return i.reply({embeds:[embed(i.guildId,permissionPanel(i.guild,i.values[0]))],components:[row(btn(`config:permissionPage:${parts[2]||0}`,'Changer de page'),btn('configuration','Retour'))],ephemeral:true});}
    if(action==='wl')return i.update({embeds:[embed(i.guildId,wlPanel(i.guild,i.values[0]))],components:[row(btn('configuration','Retour'))],ephemeral:true});
    if(action==='channel'){const k=extra,id=i.values[0];setCfg(i.guildId,c=>{c.configuration.destinations[k]=id;if(k==='welcome')c.configuration.welcome.channelId=id;});return i.reply({content:`✅ Salon ${k} enregistré : <#${id}>`,ephemeral:true});}
    if(action==='category'){const k=extra,id=i.values[0];setCfg(i.guildId,c=>{c.configuration.destinations[k+'Category']=id;if(k==='ticket')c.ticket.categoryId=id;});return i.reply({content:`✅ Catégorie ${k} enregistrée : <#${id}>`,ephemeral:true});}
    if(action==='log'){const k=i.values[0];setCfg(i.guildId,c=>c.configuration.logs[k]=!c.configuration.logs[k]);return i.reply({content:`✅ Log **${k}** ${cfg(i.guildId).configuration.logs[k]?'activé':'désactivé'}.`,ephemeral:true});}
  }

  if(scope==='customcleanup'&&action==='keep'){
    if(!globalOwner(i.user.id)&&rank(i.guildId,i.user.id)<100)throw new Error('Accès insuffisant.');
    const target=extra;const pending=db.prepare('SELECT * FROM custom_emoji_cleanup WHERE guild_id=? AND user_id=?').get(i.guildId,target);if(!pending)throw new Error('Cette demande n’est plus disponible.');
    db.prepare('UPDATE custom_emoji_cleanup SET keep_ids=?,actor_id=?,created_at=? WHERE guild_id=? AND user_id=?').run(json(i.values),i.user.id,now(),i.guildId,target);
    return i.update({embeds:[embed(i.guildId,{title:'😀 Choix enregistré',description:`**${i.values.length}** emoji${i.values.length>1?'s':''} seront conservés.`})],components:[row(btn(`customcleanup:confirm:${target}`,'Confirmer',ButtonStyle.Primary),btn(`customcleanup:deleteall:${target}`,'Tout supprimer',ButtonStyle.Danger))]});
  }

  if(scope==='config'&&action==='command'){ const cmd=i.values[0]; const x=commandCfg(i.guildId,cmd); return i.reply({embeds:[embed(i.guildId,{title:`⚙️ Configuration • /${cmd}`,description:`**Statut :** ${x.active?'🟢 Active':'🔴 Inactive'}
**Visibilité :** ${x.visible?'👁️ Visible':'🙈 Masquée'}
**Salon :** ${x.channel_id?`<#${x.channel_id}>`:'aucun salon imposé'}

Tu peux basculer chaque option ci-dessous.`})],components:[row(btn(`config:cmdactive:${cmd}`,x.active?'Désactiver':'Activer'),btn(`config:cmdvisible:${cmd}`,x.visible?'Masquer':'Afficher')),row(channelSel(`config:cmdchannel:${cmd}`)),row(btn('config:commands','Retour'))],ephemeral:true}); }
  if(scope==='config'&&action==='cmdactive'){const cmd=extra;setCommandCfg(i.guildId,cmd,{active:!commandCfg(i.guildId,cmd).active});return i.reply({content:`✅ /${cmd} ${commandCfg(i.guildId,cmd).active?'activée':'désactivée'}.`,ephemeral:true});}
  if(scope==='config'&&action==='cmdvisible'){const cmd=extra;setCommandCfg(i.guildId,cmd,{visible:!commandCfg(i.guildId,cmd).visible});return i.reply({content:`✅ /${cmd} ${commandCfg(i.guildId,cmd).visible?'visible':'masquée'}.`,ephemeral:true});}
  if(scope==='config'&&action==='cmdchannel'){const cmd=extra;setCommandCfg(i.guildId,cmd,{channelId:i.values[0]});return i.reply({content:`✅ /${cmd} sera dirigée vers <#${i.values[0]}>.`,ephemeral:true});}
  if(scope==='config'&&action==='global'&&extra==='channel'){setCfg(i.guildId,c=>c.configuration.destinations.global=i.values[0]);return i.reply({content:`✅ Salon global : <#${i.values[0]}>`,ephemeral:true});}
  if(scope==='config'&&action==='moderator'&&extra==='channel'){setCfg(i.guildId,c=>c.configuration.destinations.moderator=i.values[0]);return i.reply({content:`✅ Salon modérateur : <#${i.values[0]}>`,ephemeral:true});}
  if(scope==='config'&&action==='ticket'&&extra==='channel'){setCfg(i.guildId,c=>c.configuration.destinations.ticket=i.values[0]);return i.reply({content:`✅ Salon ticket : <#${i.values[0]}>`,ephemeral:true});}
  if(scope==='config'&&action==='giveaways'&&extra==='channel'){setCfg(i.guildId,c=>c.configuration.destinations.giveaways=i.values[0]);return i.reply({content:`✅ Salon giveaways : <#${i.values[0]}>`,ephemeral:true});}
  if(scope==='config'&&action==='log'){const key=i.values[0];setCfg(i.guildId,c=>{c.configuration.logs[key]=!c.configuration.logs[key]; const map={global:'système',ticket:'tickets',moderator:'modération',access:'accès',roles:'rôles',music:'musique',payment:'paiements',system:'système'}; const cat=map[key]; if(cat){const set=new Set(c.logs.categories); if(c.configuration.logs[key])set.add(cat); else set.delete(cat); c.logs.categories=[...set];}});return configLogsPanel(i);}

  if(scope==='custom'&&action==='voice'&&extra==='access'&&i.isUserSelectMenu()){
    const vc=i.guild.channels.cache.get(customVoiceId(i.guildId,i.user.id)); if(!vc)throw new Error('Vocale personnelle introuvable.'); const uid=i.values[0];
    if(uid===i.user.id)throw new Error('Tu es déjà propriétaire de ta vocale.');
    const ex=db.prepare('SELECT 1 FROM pv_access WHERE guild_id=? AND channel_id=? AND user_id=?').get(i.guildId,vc.id,uid);
    if(ex){db.prepare('DELETE FROM pv_access WHERE guild_id=? AND channel_id=? AND user_id=?').run(i.guildId,vc.id,uid);await vc.permissionOverwrites.edit(uid,{Connect:false},'CUSTOM+ access removed').catch(()=>{});}else{db.prepare('INSERT OR IGNORE INTO pv_access(guild_id,channel_id,user_id,created_at) VALUES(?,?,?,?)').run(i.guildId,vc.id,uid,now());await vc.permissionOverwrites.edit(uid,{ViewChannel:true,Connect:true},'CUSTOM+ access added').catch(()=>{});}
    return i.reply({content:ex?'✅ Accès vocal retiré.':'✅ Accès vocal ajouté.',ephemeral:true});
  }
  if(scope==='custom'&&action==='voice'&&extra==='mute'&&i.isUserSelectMenu()){
    const vc=i.guild.channels.cache.get(customVoiceId(i.guildId,i.user.id)); const member=vc?.members.get(i.values[0]); if(!vc||!member)throw new Error('Ce membre n’est pas dans ta vocale.'); await member.voice.setMute(true,'CUSTOM+ mute').catch(()=>{throw new Error('Impossible de mute ce membre.');}); return i.reply({content:`🔇 <@${member.id}> a été mute dans ta vocale.`,ephemeral:true});
  }
  if(scope==='custom'&&action==='voice'&&extra==='kick'&&i.isUserSelectMenu()){
    const vc=i.guild.channels.cache.get(customVoiceId(i.guildId,i.user.id)); const member=vc?.members.get(i.values[0]); if(!vc||!member)throw new Error('Ce membre n’est pas dans ta vocale.'); await member.voice.disconnect('CUSTOM+ disconnect').catch(()=>{throw new Error('Impossible de déconnecter ce membre.');}); return i.reply({content:`↩️ <@${member.id}> a été déconnecté de ta vocale.`,ephemeral:true});
  }
  if(scope==='customplus'&&action==='user'){
    if(!globalOwner(i.user.id)&&rank(i.guildId,i.user.id)<100)throw new Error('Seuls les Owner/SYS+ peuvent gérer CUSTOM+.');
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
      if(emojis.length){db.prepare('INSERT INTO custom_emoji_cleanup(guild_id,user_id,actor_id,keep_ids,created_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET actor_id=excluded.actor_id,keep_ids=excluded.keep_ids,created_at=excluded.created_at').run(i.guildId,uid,i.user.id,json([]),now());return i.reply({embeds:[embed(i.guildId,{title:'✨ CUSTOM+ retirée',description:`<@${uid}> n’a plus CUSTOM+.\n\n**${emojis.length} emoji${emojis.length>1?'s':''}** restent associés à son espace. Choisis ceux à **garder**.`})],components:[row(new StringSelectMenuBuilder().setCustomId(`customcleanup:keep:${uid}`).setPlaceholder('Choisir les emojis à garder').setMinValues(0).setMaxValues(Math.min(10,emojis.length)).addOptions(emojis.map(x=>({label:x.emoji_name,value:x.emoji_id})))),row(btn(`customcleanup:deleteall:${uid}`,'Tout supprimer',ButtonStyle.Danger),btn(`customcleanup:keepall:${uid}`,'Tout garder',ButtonStyle.Success))],ephemeral:true});}
      return i.reply({embeds:[embed(i.guildId,{title:'✨ CUSTOM+ retirée',description:`La WL CUSTOM+ de <@${uid}> a été retirée. Aucun emoji personnel à traiter.`})],ephemeral:true});
    }
    setWL(i.guildId,uid,'WLCUSTOMPLUS',95); await provisionCustomPlus(i.guild,uid);
    return i.reply({embeds:[embed(i.guildId,{title:'✨ CUSTOM+ activée',description:`<@${uid}> possède maintenant **CUSTOM+**.\n\n• rôle personnel\n• salon personnel\n• vocale personnelle\n• PV niveau CUSTOM+\n• configuration personnelle\n• jusqu’à 10 emojis personnels`})],ephemeral:true});
  }
  if(scope==='custom'&&action==='emoji'&&extra==='remove'){if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');const id=i.values[0];const rec=db.prepare('SELECT * FROM custom_emojis WHERE guild_id=? AND user_id=? AND emoji_id=?').get(i.guildId,i.user.id,id);if(!rec)throw new Error('Emoji introuvable.');const e=i.guild.emojis.cache.get(id);if(e)await e.delete('CUSTOM+ emoji removed').catch(()=>{});db.prepare('DELETE FROM custom_emojis WHERE guild_id=? AND user_id=? AND emoji_id=?').run(i.guildId,i.user.id,id);return customEmojiPanel(i);}
  if(scope==='role'&&action==='preset'){
    const presets={aurora:['#6EE7F2','#8B5CF6'],sunset:['#FF7A59','#FFB347'],ocean:['#00C6FF','#0072FF'],lavender:['#C084FC','#F0ABFC']};
    return i.reply({embeds:[embed(i.guildId,{title:'🎨 Preset choisi',description:`**${i.values[0]}**\nCouleurs : ${presets[i.values[0]].join(' → ')}`})],ephemeral:true});
  }
  if(scope==='role'&&action==='protect'&&extra==='select'){
    requireAccess(i.guildId,i.user.id,'role-protect',90);
    const role=i.guild.roles.cache.get(i.values[0]);
    if(!role || role.managed || role.id===i.guild.id) throw new Error('Rôle invalide.');
    const ex=db.prepare('SELECT 1 FROM protected_roles WHERE guild_id=? AND role_id=?').get(i.guildId,role.id);
    if(ex) db.prepare('DELETE FROM protected_roles WHERE guild_id=? AND role_id=?').run(i.guildId,role.id);
    else db.prepare('INSERT INTO protected_roles(guild_id,role_id,created_at) VALUES(?,?,?)').run(i.guildId,role.id,now());
    return i.reply({content:ex?`🔓 ${role} n’est plus protégé.`:`🔒 ${role} est maintenant protégé. La WL rôle ne pourra pas le distribuer.`,ephemeral:true});
  }
  if(scope==='role'&&action==='access'&&extra==='role'){
    return i.showModal(modal(`role:access:modal:${i.values[0]}`,'Accès du rôle',[{id:'user',label:'ID, mention ou nom',required:false,placeholder:'Laisser vide pour afficher la liste'}]));
  }
  if(scope==='slash'&&action==='addrole'&&extra==='role'){if(!globalOwner(i.user.id)&&!wlRole(i.guildId,i.user.id))throw new Error('Accès WL rôle requis.');const role=i.guild.roles.cache.get(i.values[0]);if(!role||!wlRoleCanManage(i.guildId,i.user.id,role))throw new Error('Rôle non autorisé par ta WL rôle.');await i.member.roles.add(role,'DREAM addrole');return i.reply({content:'✅ Rôle ajouté.',ephemeral:true});}
  if(scope==='slash'&&action==='delrole'&&extra==='role'){if(!globalOwner(i.user.id)&&!wlRole(i.guildId,i.user.id))throw new Error('Accès WL rôle requis.');const role=i.guild.roles.cache.get(i.values[0]);if(!role||!wlRoleCanManage(i.guildId,i.user.id,role))throw new Error('Rôle non autorisé par ta WL rôle.');await i.member.roles.remove(role,'DREAM delrole');return i.reply({content:'✅ Rôle retiré.',ephemeral:true});}
  if(scope==='slash'&&action==='dog-add'&&extra==='user'){requireLevels(i.guildId,i.user.id,'/dog-add',[100,90,80]);db.prepare('INSERT OR IGNORE INTO dog(guild_id,user_id,created_at) VALUES(?,?,?)').run(i.guildId,i.values[0],now());return i.reply({content:'🐕 Ajouté à DOG.',ephemeral:true});}
  if(scope==='slash'&&action==='dog-del'&&extra==='user'){requireLevels(i.guildId,i.user.id,'/dog-del',[100,90,80]);db.prepare('DELETE FROM dog WHERE guild_id=? AND user_id=?').run(i.guildId,i.values[0]);return i.reply({content:'🐕 Retiré de DOG.',ephemeral:true});}
  if(scope==='wlrole'&&action==='user'){
    requireAccess(i.guildId,i.user.id,'wl-role',90);
    return i.reply({content:`Membre sélectionné : <@${i.values[0]}>. Choisis maintenant son grade.`,components:[row(sel(`wlrole:grade:${i.values[0]}`,'Grade WL rôle',[{label:'OWNER',value:'OWNER'},{label:'SYS',value:'SYS'},{label:'SYS+',value:'SYS+'}]))],ephemeral:true});
  }
  if(scope==='wlrole'&&action==='grade'){
    requireAccess(i.guildId,i.user.id,'wl-role',90);
    const uid=extra, grade=i.values[0];
    if(!canGrantWLRole(i.guildId,i.user.id,grade)) throw new Error('Tu ne peux pas attribuer ce grade WL rôle.');
    if(!globalOwner(i.user.id) && rank(i.guildId,uid)>=rank(i.guildId,i.user.id)) throw new Error('Tu ne peux pas configurer une personne de niveau égal ou supérieur.');
    if(grade==='SYS+') { setWLRole(i.guildId,uid,'SYS+',null); return i.reply({content:`✅ <@${uid}> possède maintenant la WL rôle **SYS+**.\nPortée : tous les rôles gérables sous le plus haut rôle du bot, sauf les rôles protégés.`,ephemeral:true}); }
    return i.reply({content:`Grade **${grade}** sélectionné pour <@${uid}>. Choisis le rôle de référence.`,components:[row(roleSel(`wlrole:anchor:${uid}:${grade}`))],ephemeral:true});
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
Portée : ${grade==='SYS+'?'tous les rôles gérables sous le plus haut rôle du bot, sauf les rôles protégés.':`ce rôle et tous ceux qui sont en dessous, sauf les rôles protégés.`}`,ephemeral:true});
  }

  if(scope==='wl'&&action==='user'){
    requireAccess(i.guildId,i.user.id,'wl',80);
    const uid=i.values[0];
    return i.reply({content:`Membre choisi : <@${uid}>. Choisis maintenant son niveau.`,components:[row(sel(`wl:level:${uid}`,'Niveau WL',[...HIERARCHY.map(([n,v])=>({label:n,value:String(v)}))]))],ephemeral:true});
  }
  if(scope==='wl'&&action==='level'){
    requireAccess(i.guildId,i.user.id,'wl',80);
    const uid=extra; const level=Number(i.values[0]);
    if(!uid||!Number.isFinite(level))throw new Error('Sélection WL invalide.');
    if(!globalOwner(i.user.id)&&rank(i.guildId,i.user.id)<=level)throw new Error('Tu ne peux pas attribuer ton niveau ou un niveau supérieur.');
    setWL(i.guildId,uid,'WLSYS',level);
    return i.reply({content:`✅ <@${uid}> est maintenant **${LEVEL_NAME(level)}**.`,ephemeral:true});
  }
}

async function handleModal(i){
  const [scope,action,sub]=i.customId.split(':');
  if(scope==='custom'&&action==='emoji'&&sub==='add'){
    if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');
    const count=customEmojiRows(i.guildId,i.user.id).length;if(count>=10)throw new Error('Limite atteinte : 10 emojis personnels maximum.');
    const raw=i.fields.getTextInputValue('url').trim();if(!/^https?:\/\/[^\s]+$/i.test(raw))throw new Error('Le lien doit être une URL HTTP ou HTTPS valide.');
    const url=new URL(raw);if(['localhost','127.0.0.1','0.0.0.0','::1'].includes(url.hostname)||/^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(url.hostname))throw new Error('Cette adresse n’est pas autorisée.');
    const res=await fetch(url,{redirect:'follow'});if(!res.ok)throw new Error(`Le fichier n’est pas accessible (${res.status}).`);const type=(res.headers.get('content-type')||'').split(';')[0].toLowerCase();if(!['image/png','image/jpeg','image/gif'].includes(type))throw new Error('Format accepté : PNG, JPG/JPEG ou GIF.');const len=Number(res.headers.get('content-length')||0);if(len&&len>262144)throw new Error('L’image dépasse 256 Ko.');const buf=Buffer.from(await res.arrayBuffer());if(buf.length>262144)throw new Error('L’image dépasse 256 Ko.');
    if(!i.guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions))throw new Error('Protect doit avoir la permission **Gérer les expressions** pour ajouter des emojis.');const name=customEmojiName(i.guild,i.user,new Set(customEmojiRows(i.guildId,i.user.id).map(x=>x.emoji_name)));const created=await i.guild.emojis.create({attachment:buf,name,reason:`CUSTOM+ de ${i.user.tag}`});db.prepare('INSERT INTO custom_emojis(guild_id,user_id,emoji_id,emoji_name,source_url,created_at) VALUES(?,?,?,?,?,?)').run(i.guildId,i.user.id,created.id,name,raw,now());return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'😀 Emoji ajouté',description:`${created} **${name}** a été ajouté au serveur.\n\n**Emplacements restants :** ${10-customEmojiRows(i.guildId,i.user.id).length}/10`})],ephemeral:true});
  }
  if(scope==='custom'&&action==='alias'&&sub==='modal'){ if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.'); const alias=setPersonalAlias(i.guildId,i.user.id,i.fields.getTextInputValue('alias'),i.fields.getTextInputValue('target')); return i.reply({content:`✅ **${customPrefix(i.guildId,i.user.id)||'préfixe'}${alias}** est maintenant ton raccourci personnel.`,ephemeral:true}); }
  if(scope==='custom'&&action==='prefix'&&sub==='modal'){ if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.'); setCustomPrefix(i.guildId,i.user.id,i.fields.getTextInputValue('prefix').trim()); return i.reply({content:`✅ Ton préfixe personnel est maintenant **${customPrefix(i.guildId,i.user.id)}**. Il ne fonctionne que pour toi et disparaîtra si CUSTOM+ est retirée.`,ephemeral:true}); }
  if(scope==='custom'&&action==='command'&&sub==='add'){if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');let name=i.fields.getTextInputValue('name').trim().toLowerCase().replace(/^\//,'').replace(/[^a-z0-9_-]/g,'-').replace(/-+/g,'-').slice(0,32);if(name.length<2)throw new Error('Nom de commande invalide.');const kind=i.fields.getTextInputValue('kind').trim().toLowerCase().slice(0,32);const content=i.fields.getTextInputValue('content').slice(0,4000);const allowed=new Set(['tarifs','prix','réseaux','reseaux','contact','infos','information']);if(!allowed.has(kind))throw new Error('Fonction non autorisée. Utilise tarifs, réseaux, contact ou infos.');const other=db.prepare('SELECT user_id FROM custom_commands WHERE guild_id=? AND command_name=? AND user_id<>?').get(i.guildId,name,i.user.id);if(other)throw new Error('Ce raccourci est déjà utilisé par une autre personne. Choisis un autre nom.');db.prepare('INSERT INTO custom_commands(guild_id,user_id,command_name,kind,payload,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,user_id,command_name) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,active=1,updated_at=excluded.updated_at').run(i.guildId,i.user.id,name,kind,json({content}),1,now(),now());await syncCustomCommands(i.guild);return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'📋 Raccourci enregistré',description:`**${customPrefix(i.guildId,i.user.id)||'préfixe'}${name}** → **${kind}**\n\nLe raccourci est personnel et n’est pas enregistré comme commande slash.`})],ephemeral:true});}
  if(scope==='custom'&&action==='appearance'&&sub==='name'){const v=i.fields.getTextInputValue('name').trim().slice(0,80);ensureCustomConfig(i.guildId,i.user.id);db.prepare('UPDATE custom_config SET webhook_name=? WHERE guild_id=? AND user_id=?').run(v||null,i.guildId,i.user.id);return customAppearancePanel(i);}
  if(scope==='custom'&&action==='appearance'&&sub==='color'){const v=color(i.fields.getTextInputValue('color'),cfg(i.guildId).ui.color);ensureCustomConfig(i.guildId,i.user.id);db.prepare('UPDATE custom_config SET color=? WHERE guild_id=? AND user_id=?').run(v,i.guildId,i.user.id);return customAppearancePanel(i);}
  if(scope==='custom'&&action==='appearance'&&sub==='footer'){const v=i.fields.getTextInputValue('footer').trim().slice(0,100);ensureCustomConfig(i.guildId,i.user.id);db.prepare('UPDATE custom_config SET footer=? WHERE guild_id=? AND user_id=?').run(v||null,i.guildId,i.user.id);return customAppearancePanel(i);}

  if(scope==='config'&&action==='color'){ const vals={main:i.fields.getTextInputValue('main'),error:i.fields.getTextInputValue('error'),ok:i.fields.getTextInputValue('ok'),warn:i.fields.getTextInputValue('warn')}; if(!Object.values(vals).every(v=>/^#[0-9A-Fa-f]{6}$/.test(v)))throw new Error('Chaque couleur doit être au format #RRGGBB.'); setCfg(i.guildId,c=>{c.ui.color=vals.main;c.ui.error=vals.error;c.ui.ok=vals.ok;c.ui.warn=vals.warn;}); return i.reply({embeds:[embed(i.guildId,{title:'🎨 Configuration enregistrée',description:'Les couleurs globales ont été mises à jour. Les prochains embeds utiliseront automatiquement cette palette.'})],ephemeral:true}); }
  if(scope==='config'&&action==='footer'){const v=i.fields.getTextInputValue('footer').slice(0,100);setCfg(i.guildId,c=>c.ui.footer=v||'DREAM');return i.reply({embeds:[embed(i.guildId,{title:'✏️ Footer enregistré',description:`Le footer global est maintenant **${v||'DREAM'}**.`})],ephemeral:true});}
  if(scope==='config'&&action==='welcomeText'){const v=i.fields.getTextInputValue('text').slice(0,1000);setCfg(i.guildId,c=>c.configuration.welcome.template=v);return i.reply({embeds:[embed(i.guildId,{title:'👋 Bienvenue • Message enregistré',description:'Le nouveau texte sera utilisé par Commu pour les prochaines arrivées.'})],ephemeral:true});}

  if(scope==='role'&&action==='create'){
    if(!globalOwner(i.user.id) && !wlRole(i.guildId,i.user.id)) throw new Error('WL rôle requise.');
    const r=await i.guild.roles.create({name:i.fields.getTextInputValue('name'),reason:'DREAM role create'});db.prepare('INSERT OR REPLACE INTO role_meta(guild_id,role_id,type,owner_id,wl_level,interaction,data) VALUES(?,?,?,?,?,?,?)').run(i.guildId,r.id,'MANAGED',null,rank(i.guildId,i.user.id),0,json({}));await log(i.guild,'rôles','Rôle créé',`${r} par <@${i.user.id}>`,i.user.id);return i.reply({content:`✅ ${r} créé.`,ephemeral:true});
  }
  if(scope==='role'&&action==='personal'){
    if(!globalOwner(i.user.id) && !wlRole(i.guildId,i.user.id)) throw new Error('WL rôle requise.');const r=await i.guild.roles.create({name:i.fields.getTextInputValue('name'),reason:'DREAM personal role'});db.prepare('INSERT OR REPLACE INTO role_meta(guild_id,role_id,type,owner_id,wl_level,interaction,data) VALUES(?,?,?,?,?,?,?)').run(i.guildId,r.id,'PERSONAL',i.user.id,rank(i.guildId,i.user.id),0,json({}));await i.member.roles.add(r,'DREAM personal role');return i.reply({content:`🎨 ${r} est ton rôle personnel.`,ephemeral:true});
  }
  if(scope==='custom'&&action==='role'&&sub==='access'&&i.customId.split(':')[3]==='modal'){
    if(!hasCustomPlus(i.guildId,i.user.id))throw new Error('WL CUSTOM+ requise.');
    const roleId=i.customId.split(':')[4]; const role=i.guild.roles.cache.get(roleId); if(!role||roleId!==customRoleId(i.guildId,i.user.id))throw new Error('Rôle personnel introuvable.');
    const raw=cleanTarget(i.fields.getTextInputValue('user'));
    if(!raw){const rows=db.prepare('SELECT user_id FROM role_access WHERE guild_id=? AND role_id=? ORDER BY created_at').all(i.guildId,roleId);return i.reply({embeds:[embedFor(i.guildId,i.user.id,{title:'👥 Accès • Rôle personnel',description:rows.map(x=>`<@${x.user_id}>`).join('\n')||'Aucun accès supplémentaire.',footer:`${rows.length} accès`})],allowedMentions:{parse:[]},ephemeral:true});}
    if(raw===i.user.id)throw new Error('Tu es déjà propriétaire de ce rôle.');
    const ex=db.prepare('SELECT 1 FROM role_access WHERE guild_id=? AND role_id=? AND user_id=?').get(i.guildId,roleId,raw);
    if(ex)db.prepare('DELETE FROM role_access WHERE guild_id=? AND role_id=? AND user_id=?').run(i.guildId,roleId,raw);else db.prepare('INSERT OR IGNORE INTO role_access(guild_id,role_id,user_id,created_at) VALUES(?,?,?,?)').run(i.guildId,roleId,raw,now());
    return i.reply({content:ex?'✅ Accès au rôle retiré.':'✅ Accès au rôle ajouté.',ephemeral:true});
  }
  if(scope==='role'&&action==='access'&&sub==='modal'){
    if(!globalOwner(i.user.id) && !wlRole(i.guildId,i.user.id)) throw new Error('WL rôle requise.');
    const roleId=i.customId.split(':')[3]; const role=i.guild.roles.cache.get(roleId); if(!role)throw new Error('Rôle introuvable.');
    if(!canTouchRole(i.guildId,i.user.id,role))throw new Error('Rôle non autorisé.');
    const raw=cleanTarget(i.fields.getTextInputValue('user'));
    if(!raw){const rows=db.prepare('SELECT user_id FROM role_access WHERE guild_id=? AND role_id=? ORDER BY created_at').all(i.guildId,roleId);return i.reply({embeds:[embed(i.guildId,{title:'🔐 Accès du rôle',description:rows.slice(0,10).map(x=>`<@${x.user_id}>`).join('\n')||'Personne.',footer:`Page 1 • ${rows.length} accès`})],ephemeral:true});}
    if(!higher(i.guildId,i.user.id,raw))throw new Error('Hiérarchie insuffisante.');
    const ex=db.prepare('SELECT 1 FROM role_access WHERE guild_id=? AND role_id=? AND user_id=?').get(i.guildId,roleId,raw);
    if(ex)db.prepare('DELETE FROM role_access WHERE guild_id=? AND role_id=? AND user_id=?').run(i.guildId,roleId,raw);else db.prepare('INSERT INTO role_access(guild_id,role_id,user_id,created_at) VALUES(?,?,?,?)').run(i.guildId,roleId,raw,now());
    return i.reply({content:ex?'✅ Accès retiré.':'✅ Accès ajouté.',ephemeral:true});
  }
  if(scope==='pv'&&action==='access'){
    if(!hasPVAccess(i.guildId,i.user.id))throw new Error('WL PV ou CUSTOM+ requise.');const x=db.prepare('SELECT * FROM pv WHERE guild_id=? AND channel_id=?').get(i.guildId,i.member.voice.channelId||'');if(!x)throw new Error('Aucune PV ici.');if(hasCustomPlus(i.guildId,i.user.id)&&!hasKind(i.guildId,i.user.id,'WLPV')&&x.channel_id!==customVoiceId(i.guildId,i.user.id))throw new Error('CUSTOM+ gère uniquement sa vocale personnelle.');const raw=i.fields.getTextInputValue('user').replace(/[<@!>]/g,'');if(!higher(i.guildId,i.user.id,raw))throw new Error('Tu ne peux pas donner accès à une hiérarchie égale ou supérieure.');const ex=db.prepare('SELECT 1 FROM pv_access WHERE guild_id=? AND channel_id=? AND user_id=?').get(i.guildId,x.channel_id,raw);if(ex){db.prepare('DELETE FROM pv_access WHERE guild_id=? AND channel_id=? AND user_id=?').run(i.guildId,x.channel_id,raw);await i.guild.channels.cache.get(x.channel_id)?.permissionOverwrites.edit(raw,{Connect:false},'DREAM PV access removed').catch(()=>{});}else{db.prepare('INSERT INTO pv_access(guild_id,channel_id,user_id,created_at) VALUES(?,?,?,?)').run(i.guildId,x.channel_id,raw,now());await i.guild.channels.cache.get(x.channel_id)?.permissionOverwrites.edit(raw,{Connect:true},'DREAM PV access added').catch(()=>{});}return i.reply({content:ex?'✅ Accès PV retiré.':'✅ Accès PV ajouté.',ephemeral:true});
  }
  if(scope==='music'&&action==='add'){
    requireAccess(i.guildId,i.user.id,'music',0); await i.deferReply({ephemeral:true}); const result=await addMusic(i.guild,i.member,i.fields.getTextInputValue('url')); return i.editReply({embeds:[embed(i.guildId,{title:'🎵 Ajouté à la file',description:`**${result.count}** titre${result.count>1?'s':''} ajouté${result.count>1?'s':''}.\nPremier : **${String(result.first).slice(0,120)}**\n\nLa file n’a **aucune limite de taille**.`})]});
  }
  if(scope==='pay'&&action==='add'){
    requireAccess(i.guildId,i.user.id,'payment',50,'WLPAIEMENT');const uid=i.fields.getTextInputValue('user').replace(/[<@!>]/g,'');const amount=Number(i.fields.getTextInputValue('amount').replace(',','.'));if(!Number.isFinite(amount))throw new Error('Montant invalide.');db.prepare('INSERT INTO payments(guild_id,user_id,label,amount,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(i.guildId,uid,i.fields.getTextInputValue('label'),amount,i.fields.getTextInputValue('status').toUpperCase(),now(),now());await log(i.guild,'paiements','Paiement ajouté',`<@${uid}> • ${amount} ${cfg(i.guildId).payment.currency}`,i.user.id);return i.reply({content:'💳 Paiement enregistré.',ephemeral:true});
  }
  if(scope==='msg'&&action==='create'){
    requireAccess(i.guildId,i.user.id,'message',50);const ch=await i.guild.channels.fetch(i.fields.getTextInputValue('channel'));if(!ch?.isTextBased())throw new Error('Salon invalide.');const payload={title:i.fields.getTextInputValue('title'),description:i.fields.getTextInputValue('description'),color:color(i.fields.getTextInputValue('color'),cfg(i.guildId).ui.color)};const msg=await ch.send({embeds:[embedFor(i.guildId,i.user.id,payload)]});db.prepare('INSERT OR REPLACE INTO messages(guild_id,message_id,channel_id,owner_id,version,payload,updated_at) VALUES(?,?,?,?,?,?,?)').run(i.guildId,msg.id,ch.id,i.user.id,2,json(payload),now());return i.reply({content:`📝 Message créé : ${msg}`,ephemeral:true});
  }
  if(scope==='msg'&&action==='edit'){
    requireAccess(i.guildId,i.user.id,'message',50);const id=i.fields.getTextInputValue('message');const rec=db.prepare('SELECT * FROM messages WHERE guild_id=? AND message_id=?').get(i.guildId,id);if(!rec)throw new Error('Message non enregistré par DREAM.');if(rec.owner_id!==i.user.id&&!globalOwner(i.user.id)&&rank(i.guildId,i.user.id)<50)throw new Error('Accès propriétaire requis.');const ch=await i.guild.channels.fetch(rec.channel_id);const msg=await ch.messages.fetch(id);const old=parse(rec.payload),payload={...old,title:i.fields.getTextInputValue('title')||old.title,description:i.fields.getTextInputValue('description')||old.description,color:color(i.fields.getTextInputValue('color'),old.color||cfg(i.guildId).ui.color)};await msg.edit({embeds:[embedFor(i.guildId,i.user.id,payload)]});db.prepare('UPDATE messages SET payload=?,version=?,updated_at=? WHERE guild_id=? AND message_id=?').run(json(payload),2,now(),i.guildId,id);return i.reply({content:'✅ Message modifié.',ephemeral:true});
  }
  if(scope==='msg'&&action==='v2'){
    requireAccess(i.guildId,i.user.id,'message',50);const id=i.fields.getTextInputValue('message');const rec=db.prepare('SELECT * FROM messages WHERE guild_id=? AND message_id=?').get(i.guildId,id);if(!rec)throw new Error('Message introuvable dans le registre DREAM.');const payload=parse(rec.payload);const ch=await i.guild.channels.fetch(rec.channel_id);const msg=await ch.messages.fetch(id);await msg.edit({embeds:[embedFor(i.guildId,i.user.id,{...payload,title:payload.title||'DREAM',description:payload.description||' ',color:payload.color||cfg(i.guildId).ui.color})]});db.prepare('UPDATE messages SET version=2,updated_at=? WHERE guild_id=? AND message_id=?').run(now(),i.guildId,id);return i.reply({content:'✨ Conversion V1 → V2 terminée en conservant les données.',ephemeral:true});
  }
  if(scope==='set'&&action==='usercolor'&&sub==='modal'){const v=color(i.fields.getTextInputValue('color'),cfg(i.guildId).ui.color);db.prepare('INSERT INTO user_ui(guild_id,user_id,color,footer,image,banner) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET color=excluded.color').run(i.guildId,i.user.id,v,null,null,null);return i.reply({content:`🎨 Couleur personnelle enregistrée : **${v}**`,ephemeral:true});}
  if(scope==='set'&&action==='userfooter'&&sub==='modal'){const v=i.fields.getTextInputValue('footer').slice(0,100);db.prepare('INSERT INTO user_ui(guild_id,user_id,color,footer,image,banner) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET footer=excluded.footer').run(i.guildId,i.user.id,null,v,null,null);return i.reply({content:'✅ Footer personnel enregistré.',ephemeral:true});}
  if(scope==='set'&&action==='ui'){
    requireAccess(i.guildId,i.user.id,'ui',50);return i.reply({content:'Utilise les réglages dédiés du panneau pour appliquer une valeur précise.',ephemeral:true});
  }
}

async function syncCustomCommands(guild){ return guild; }

async function handleInteraction(i){
  try{
    if(i.isButton() && (i.customId.startsWith('integration:accept:')||i.customId.startsWith('integration:reject:'))){if(!globalOwner(i.user.id))throw new Error('Seul un owner DREAM peut valider cette intégration.');const [,action,gid,botId]=i.customId.split(':');const x=botAccess(gid,botId);if(!x)throw new Error('Demande introuvable.');if(action==='accept'){db.prepare("UPDATE bot_access SET status='accepted',decided_at=?,decided_by=? WHERE guild_id=? AND bot_id=?").run(now(),i.user.id,gid,botId);const c=[clients.one,clients.two].find(v=>v.user?.id===botId);const g=c?.guilds.cache.get(gid);if(g&&c===clients.two)await refreshGuild(g).catch(()=>{});return i.update({embeds:[embed(gid,{title:'✅ DREAM • Intégration acceptée',description:`**${x.bot_name}** est maintenant actif sur ce serveur.`})],components:[]});}db.prepare("UPDATE bot_access SET status='rejected',decided_at=?,decided_by=? WHERE guild_id=? AND bot_id=?").run(now(),i.user.id,gid,botId);const c=[clients.one,clients.two].find(v=>v.user?.id===botId);const g=c?.guilds.cache.get(gid);if(g)await g.leave().catch(()=>{});return i.update({embeds:[embed(gid,{title:'⛔ DREAM • Intégration refusée',description:`**${x.bot_name}** quitte le serveur.`})],components:[]});}
    if(!i.guildId)return;
    assertBotAccepted(i.guildId,i.client);
    if(i.isButton())return await handleButton(i);
    if(i.isStringSelectMenu()||i.isUserSelectMenu()||i.isRoleSelectMenu()||i.isChannelSelectMenu())return await handleSelect(i);
    if(i.isModalSubmit())return await handleModal(i);
    if(i.isChatInputCommand()){
      const n=i.commandName;
      if(i.client===clients.one && ['configuration'].includes(n)) return;
      if(i.client===clients.two && !['configuration'].includes(n)) return;
      const cc=commandCfg(i.guildId,n);
      if(cc && !cc.active) throw new Error('Cette commande est désactivée sur ce serveur.');
      if(cc && !cc.visible) throw new Error('Cette commande est masquée sur ce serveur.');
      const dest=cc?.channel_id ? i.guild.channels.cache.get(cc.channel_id) : null;
      if(dest && i.channelId!==dest.id){ return i.reply({embeds:[embed(i.guildId,{title:'📍 Mauvais salon',description:`Cette commande est configurée pour ${dest}.

Tu peux soit l’envoyer dans le salon configuré, soit confirmer pour l’envoyer ici.`})],components:[row(btn(`route:send:${n}:${dest.id}`,'Envoyer dans le bon salon',ButtonStyle.Primary),btn(`route:here:${n}`,'Envoyer ici',ButtonStyle.Secondary))],ephemeral:true}); }
      if(n==='dream')return openDream(i);
      if(n==='wl')return openDream(i,'wl');
      if(n==='wl-role')return handleButton({ ...i, customId:'wlrole:panel' });
      if(n==='music')return openDream(i,'music');
      if(n==='logs'){requireAccess(i.guildId,i.user.id,'logs',50);await ensureLogs(i.guild);return i.reply({content:'✅ Logs créés/vérifiés.',ephemeral:true});}
      if(n==='role')return openDream(i,'roles');
      if(n==='ticket')return openDream(i,'tickets');
      if(n==='payment')return openDream(i,'payments');
      if(n==='message')return openDream(i,'messages');
      if(n==='ui')return openDream(i,'settings');
      if(n==='role-acces')return openDream(i,'roles');
      if(n==='addrole'||n==='delrole')return i.reply({content:'Choisis le rôle à gérer.',components:[row(roleSel(`slash:${n}:role`))],ephemeral:true});
      if(n==='dog-add'||n==='dog-del')return i.reply({content:'Choisis le membre.',components:[row(userSel(`slash:${n}:user`))],ephemeral:true});
      if(n==='wet-info'){requireAccess(i.guildId,i.user.id,'/wet-info',50);const a=db.prepare('SELECT * FROM wet WHERE guild_id=? ORDER BY level DESC').all(i.guildId);return i.reply({embeds:[embed(i.guildId,{title:'WET • Informations',description:a.map(x=>`<@${x.user_id}> — ${LEVEL_NAME(x.level)}`).join('\n')||'Aucun.'})],ephemeral:true});}
      if(n==='prix')return openDream(i,'payments');
      if(n==='stats'){await updateStats(i.guild);return i.reply({embeds:[embed(i.guildId,{title:'📊 Statistiques',description:Object.entries(statsText(i.guild)).map(([k,v])=>`**${k}** : ${v}`).join('\n')})],ephemeral:true});}
      if(n==='lock'||n==='unlock'){requireAccess(i.guildId,i.user.id,n,50);const lock=n==='lock';if(lock){db.prepare('INSERT OR IGNORE INTO locks(guild_id,channel_id,created_at) VALUES(?,?,?)').run(i.guildId,i.channelId,now());await i.channel.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:false},'DREAM lock');}else{db.prepare('DELETE FROM locks WHERE guild_id=? AND channel_id=?').run(i.guildId,i.channelId);await i.channel.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:null},'DREAM unlock');}return i.reply({content:lock?'🔒 Verrouillé.':'🔓 Déverrouillé.',ephemeral:true});}
      if(n==='wet'){requireAccess(i.guildId,i.user.id,'/wet',50);db.prepare('INSERT INTO wet(guild_id,user_id,level,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET level=excluded.level,updated_at=excluded.updated_at').run(i.guildId,i.user.id,35,now(),now());return i.reply({content:'✅ WET activé.',ephemeral:true});}
    }
  }catch(e){const msg=String(e?.message||e).slice(0,1900);if(i.deferred||i.replied)return i.followUp({content:`⛔ ${msg}`,ephemeral:true}).catch(()=>{});return i.reply({content:`⛔ ${msg}`,ephemeral:true}).catch(()=>{});}
}

function cleanTarget(x){return String(x||'').replace(/[<@!>]/g,'').trim();}
async function handlePrefix(m){
  if(m.author.bot||!m.guild)return;
  if(!botAccepted(m.guild.id,m.client.user.id))return;
  const t=m.content.trim(), low=t.toLowerCase(), gid=m.guild.id;
  const myPrefix=hasCustomPlus(gid,m.author.id)?customPrefix(gid,m.author.id):null;
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
    const protectOnly=/^(?:\.owner|=pv|=acces|&blinfo|&(?:un)?bl|&derank|\+ban|\-baninfo|\+(?:lock|unlock)|\/wet-info|\/wet(?:=pa)?|\/dog-(?:add|del))/i.test(t);
    if(protectOnly && m.client!==clients.two) return;
    if(/^\.owner(?:\s|$)/i.test(t)){
      if(!globalOwner(m.author.id))return;
      const target=cleanTarget(t.split(/\s+/)[1]);if(!target)return ownerPanel(m);
      if(target===m.author.id)throw new Error('Tu ne peux pas retirer ton propre accès owner.');
      const ex=!!db.prepare('SELECT 1 FROM owners WHERE user_id=?').get(target);if(ex)db.prepare('DELETE FROM owners WHERE user_id=?').run(target);else db.prepare('INSERT INTO owners(user_id,created_at) VALUES(?,?)').run(target,now());return m.reply(ex?`✅ <@${target}> retiré des owners.`:`✅ <@${target}> ajouté aux owners.`);
    }
    if(/^=pv$/i.test(t)){if(!hasPVAccess(gid,m.author.id))throw new Error('WL PV ou CUSTOM+ requise.');const ch=m.member.voice.channel;if(!ch)throw new Error('Rejoins un vocal.');if(hasCustomPlus(gid,m.author.id)&&!hasKind(gid,m.author.id,'WLPV')&&customVoiceId(gid,m.author.id)!==ch.id)throw new Error('CUSTOM+ gère uniquement sa vocale personnelle.');const old=db.prepare('SELECT * FROM pv WHERE channel_id=?').get(ch.id);if(old&&!higher(gid,m.author.id,old.owner_id))throw new Error('PV appartenant à une hiérarchie supérieure.');const level=pvRank(gid,m.author.id);if(level<0)throw new Error('WL PV requise.');db.prepare('INSERT INTO pv(guild_id,channel_id,owner_id,level,access_mode,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET owner_id=excluded.owner_id,level=excluded.level,access_mode=excluded.access_mode').run(gid,ch.id,m.author.id,level,'DENY',now());await ch.permissionOverwrites.edit(m.guild.roles.everyone,{Connect:false},'DREAM PV').catch(()=>{});await ch.permissionOverwrites.edit(m.user,{Connect:true},'DREAM PV owner').catch(()=>{});return m.reply(`🔊 PV activée ici. Niveau : **${PV_LEVEL_NAME(level)}**.`);}
    if(/^=acces(?:\s|$)/i.test(t)){if(!hasPVAccess(gid,m.author.id))throw new Error('WL PV ou CUSTOM+ requise.');const x=db.prepare('SELECT * FROM pv WHERE guild_id=? AND channel_id=?').get(gid,m.member.voice.channelId||'');if(!x)throw new Error('Aucune PV ici.');if(hasCustomPlus(gid,m.author.id)&&!hasKind(gid,m.author.id,'WLPV')&&x.channel_id!==customVoiceId(gid,m.author.id))throw new Error('CUSTOM+ gère uniquement sa vocale personnelle.');const target=cleanTarget(t.split(/\s+/)[1]);if(!target){const a=db.prepare('SELECT user_id FROM pv_access WHERE guild_id=? AND channel_id=?').all(gid,x.channel_id);return m.reply(`**Accès PV**\n${a.map(z=>`<@${z.user_id}>`).join('\n')||'Personne.'}`);}if(!higher(gid,m.author.id,target))throw new Error('Hiérarchie insuffisante.');const ex=!!db.prepare('SELECT 1 FROM pv_access WHERE guild_id=? AND channel_id=? AND user_id=?').get(gid,x.channel_id,target);if(ex){db.prepare('DELETE FROM pv_access WHERE guild_id=? AND channel_id=? AND user_id=?').run(gid,x.channel_id,target);await m.guild.channels.cache.get(x.channel_id)?.permissionOverwrites.edit(target,{Connect:false},'DREAM PV access removed').catch(()=>{});}else{db.prepare('INSERT INTO pv_access(guild_id,channel_id,user_id,created_at) VALUES(?,?,?,?)').run(gid,x.channel_id,target,now());await m.guild.channels.cache.get(x.channel_id)?.permissionOverwrites.edit(target,{Connect:true},'DREAM PV access added').catch(()=>{});}return m.reply(ex?'✅ Accès retiré.':'✅ Accès ajouté.');}
    if(/^&blinfo$/i.test(t)){requireAccess(gid,m.author.id,'&blinfo',80);const a=db.prepare('SELECT user_id FROM bl WHERE guild_id=? AND kind=?').all(gid,'BL');return m.reply(`**BL**\n${a.map(x=>`<@${x.user_id}>`).join('\n')||'Personne.'}`);}
    if(/^&(?:un)?bl(?:\s|$)/i.test(t)){const add=/^&bl\b/i.test(t);requireAccess(gid,m.author.id,add?'&bl':'&unbl',80);const target=cleanTarget(t.split(/\s+/)[1]);if(!target)throw new Error('Membre requis.');if(!higher(gid,m.author.id,target))throw new Error('Hiérarchie insuffisante.');if(add)db.prepare('INSERT OR IGNORE INTO bl(guild_id,user_id,kind,created_at) VALUES(?,?,?,?)').run(gid,target,'BL',now());else db.prepare('DELETE FROM bl WHERE guild_id=? AND user_id=? AND kind=?').run(gid,target,'BL');await log(m.guild,'accès',add?'BL ajoutée':'BL retirée',`<@${target}>`,m.author.id);return m.reply(add?'⛔ BL ajoutée.':'✅ BL retirée.');}
    if(/^&derank(?:\s|$)/i.test(t)){requireLevels(gid,m.author.id,'&derank',[65,60,55,50,45,40,35,30,25]);const target=cleanTarget(t.split(/\s+/)[1]);if(!target||!higher(gid,m.author.id,target))throw new Error('Hiérarchie insuffisante.');delWL(gid,target);return m.reply('✅ Accès WL retirés.');}
    if(/^\+(?:kick|expulse)(?:\s|$)/i.test(t)){requireAccess(gid,m.author.id,'+kick',70);const target=cleanTarget(t.split(/\s+/)[1]);const mem=await m.guild.members.fetch(target);return requestSanction({guild:m.guild,member:m.member,author:m.author,channel:m.channel,user:m.author,reply:o=>m.reply(o)},mem,t.split(/\s+/).slice(2).join(' ')||'—','KICK',false);}
    if(/^\+timeout(?:\s|$)/i.test(t)){requireAccess(gid,m.author.id,'+timeout',70);const target=cleanTarget(t.split(/\s+/)[1]);const mem=await m.guild.members.fetch(target);return requestSanction({guild:m.guild,member:m.member,author:m.author,channel:m.channel,user:m.author,reply:o=>m.reply(o)},mem,t.split(/\s+/).slice(2).join(' ')||'—','TIMEOUT',false);}
    if(/^\+warn(?:\s|$)/i.test(t)){requireAccess(gid,m.author.id,'+warn',70);const target=cleanTarget(t.split(/\s+/)[1]);const mem=await m.guild.members.fetch(target);return requestSanction({guild:m.guild,member:m.member,author:m.author,channel:m.channel,user:m.author,reply:o=>m.reply(o)},mem,t.split(/\s+/).slice(2).join(' ')||'—','WARN',false);}
    if(/^\+ban(?:\s|$)/i.test(t)){requireAccess(gid,m.author.id,'+ban',70);const target=cleanTarget(t.split(/\s+/)[1]);const mem=await m.guild.members.fetch(target);return requestSanction({guild:m.guild,member:m.member,author:m.author,channel:m.channel,user:m.author,reply:o=>m.reply(o)},mem,t.split(/\s+/).slice(2).join(' ')||'—','BAN',false);}
    if(/^-baninfo(?:\s|$)/i.test(t)){requireAccess(gid,m.author.id,'-baninfo',70);const target=cleanTarget(t.split(/\s+/)[1]);const a=db.prepare('SELECT * FROM sanctions WHERE guild_id=? AND target_id=? ORDER BY created_at DESC LIMIT 20').all(gid,target);return m.reply(`**Sanctions**\n${a.map(x=>`${x.type} • ${new Date(x.created_at).toLocaleString('fr-FR')} • ${x.reason||'—'}`).join('\n')||'Aucune.'}`);}
    if(/^\+(?:lock|unlock)$/i.test(t)){const lock=/^\+lock$/i.test(t);requireLevels(gid,m.author.id,lock?'+lock':'+unlock',[50,45,40,35,30,25]);if(lock){db.prepare('INSERT OR IGNORE INTO locks(guild_id,channel_id,created_at) VALUES(?,?,?)').run(gid,m.channel.id,now());await m.channel.permissionOverwrites.edit(m.guild.roles.everyone,{SendMessages:false},'DREAM lock');}else{db.prepare('DELETE FROM locks WHERE guild_id=? AND channel_id=?').run(gid,m.channel.id);await m.channel.permissionOverwrites.edit(m.guild.roles.everyone,{SendMessages:null},'DREAM unlock');}return m.reply(lock?'🔒 Verrouillé.':'🔓 Déverrouillé.');}
    if(/^\/wet-info$/i.test(t)){requireAccess(gid,m.author.id,'/wet-info',50);const a=db.prepare('SELECT * FROM wet WHERE guild_id=? ORDER BY level DESC').all(gid);return m.reply(`**WET**\n${a.map(x=>`<@${x.user_id}> — ${LEVEL_NAME(x.level)}`).join('\n')||'Aucun.'}`);}
    if(/^\/wet$/i.test(t)||/^\/wet=pa$/i.test(t)){requireAccess(gid,m.author.id,'/wet',50);db.prepare('INSERT INTO wet(guild_id,user_id,level,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET level=excluded.level,updated_at=excluded.updated_at').run(gid,m.author.id,35,now(),now());return m.reply('✅ WET activé.');}
    if(/^=faq$/i.test(t)){return m.reply({embeds:[embed(gid,{title:'☑️ La FAQ DREAM',description:'Choisis un sujet : Général • Tickets • WL • Bots'})],components:[row(btn('faq:general','Général'),btn('faq:tickets','Tickets'),btn('faq:wl','WL'),btn('faq:bot','Bots'))]});}
    if(/^=(?:hierarchy|perms)$/i.test(t)){requireAccess(gid,m.author.id,'=ui',25);const isH=/^=hierarchy$/i.test(t);return m.reply({embeds:[embed(gid,{title:isH?'📚 Hiérarchie':'🔐 Permissions',description:isH?HIERARCHY.map(([n,v],idx)=>`${idx+1}. **${n}** — ${v}`).join('\n'):'Les commandes suivent la WL et la hiérarchie ; les exceptions utilisateur sont stockées dans la matrice WL.'})]});}
    if(/^=wlrole$/i.test(t)){if(!globalOwner(m.author.id)&&rank(gid,m.author.id)<90)throw new Error('Accès WL rôle requis.');const x=wlRole(gid,m.author.id);return m.reply({embeds:[embed(gid,{title:'🛡️ WL rôle',description:`Grade : **${x?.grade||'Aucun'}**\n${wlRoleScopeDescription(gid,m.author.id)}\n\nOWNER / SYS : rôle sélectionné + tous les rôles sous celui-ci.\nSYS+ : tous les rôles gérables sous le plus haut rôle du bot.\n🔒 Les rôles protégés restent interdits.`})]});}
    if(/^=ui$/i.test(t)){requireLevels(gid,m.author.id,'=ui',[75,70,65,60,55,50,45,40,30,25]);return m.reply({embeds:[embed(gid,{title:'⚙️ DREAM • UI',description:`Couleur : **${cfg(gid).ui.color}**\nFooter : **${cfg(gid).ui.footer}**\nImage : ${cfg(gid).ui.image||'aucune'}`})]});}
    if(/^=logs$/i.test(t)){requireAccess(gid,m.author.id,'=logs',50);await ensureLogs(m.guild);return m.reply('✅ Logs créés et réparés.');}
    if(/^=edit(?:\s|$)/i.test(t)||/^=v2(?:\s|$)/i.test(t)){
      requireAccess(gid,m.author.id,'message',50); const isV2=/^=v2/i.test(t); const reply=m.reference?.messageId; const id=cleanTarget(t.split(/\s+/)[1])||reply; if(!id)throw new Error('Réponds au message ou donne son ID.'); const rec=db.prepare('SELECT * FROM messages WHERE guild_id=? AND message_id=?').get(gid,id); if(!rec)throw new Error('Message non enregistré par DREAM.'); if(rec.owner_id!==m.author.id&&!globalOwner(m.author.id)&&rank(gid,m.author.id)<50)throw new Error('Accès propriétaire requis.'); const ch=await m.guild.channels.fetch(rec.channel_id); const msg=await ch.messages.fetch(id); const old=parse(rec.payload); const payload={...old, title:old.title||'DREAM', description:old.description||' ', color:old.color||cfg(gid).ui.color}; await msg.edit({embeds:[embed(gid,payload)]}); db.prepare('UPDATE messages SET version=?,payload=?,updated_at=? WHERE guild_id=? AND message_id=?').run(2,json(payload),now(),gid,id); return m.reply(isV2?'✨ V1 → V2 terminée.':'✅ Message modifié.');
    }
    if(/^\+(?:pic|banner)(?:\s|$)/i.test(t)){
      const cmd=t.toLowerCase().startsWith('+pic')?'+pic':'+banner'; requireAccess(gid,m.author.id,cmd,50); let url=t.split(/\s+/)[1]; if(!url&&m.reference?.messageId){const ref=await m.channel.messages.fetch(m.reference.messageId).catch(()=>null); url=ref?.attachments.first()?.url||ref?.embeds?.[0]?.data?.image?.url||ref?.embeds?.[0]?.data?.thumbnail?.url;} if(!url)url=m.attachments.first()?.url; if(!url)throw new Error('Ajoute une URL ou réponds à un message avec une image.'); setCfg(gid,c=>c.ui[cmd==='+pic'?'image':'banner']=url); return m.reply('✅ Média enregistré.');
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
    if(/^\/dog-(?:add|del)\b/i.test(t)){requireLevels(gid,m.author.id,t.toLowerCase().startsWith('/dog-add')?'/dog-add':'/dog-del',[100,90,80]);const target=cleanTarget(t.split(/\s+/)[1]);const add=t.toLowerCase().startsWith('/dog-add');if(add)db.prepare('INSERT OR IGNORE INTO dog(guild_id,user_id,created_at) VALUES(?,?,?)').run(gid,target,now());else db.prepare('DELETE FROM dog WHERE guild_id=? AND user_id=?').run(gid,target);return m.reply(add?'🐕 Ajouté à DOG.':'🐕 Retiré de DOG.');}
  }catch(e){return m.reply(`⛔ ${String(e.message||e).slice(0,1900)}`).catch(()=>{});}
}

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

].map(x=>({...x,type:1}));

function ensureLegacyBotAccess(c,g){if(!botAccess(g.id,c.user.id))db.prepare('INSERT INTO bot_access(guild_id,bot_id,bot_name,status,requested_at,server_owner_id,invite_url) VALUES(?,?,?,?,?,?,?)').run(g.id,c.user.id,c.user.username,'accepted',now(),g.ownerId,oauthInvite(c.user.id,c===clients.one?'Commu Dream':'Dream Protect'));}
async function createIntegrationRequest(c,g){guilds.set(g.id,g);cfg(g.id);ensureCommandConfig(g.id);let inviter=null;try{if(g.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)){const logs=await g.fetchAuditLogs({type:AuditLogEvent.BotAdd,limit:20});const e=logs.entries.find(x=>x.target?.id===c.user.id&&now()-x.createdTimestamp<15*60*1000);inviter=e?.executor||null;}}catch{}const ownerId=g.ownerId||null,botName=c===clients.one?'Commu Dream':'Dream Protect',invite=oauthInvite(c.user.id,botName);db.prepare("INSERT INTO bot_access(guild_id,bot_id,bot_name,status,inviter_id,server_owner_id,requested_at,invite_url) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,bot_id) DO UPDATE SET status='pending',inviter_id=excluded.inviter_id,server_owner_id=excluded.server_owner_id,requested_at=excluded.requested_at,invite_url=excluded.invite_url,decided_at=NULL,decided_by=NULL").run(g.id,c.user.id,botName,'pending',inviter?.id||null,ownerId,now(),invite);const desc=`Le bot vient d’être ajouté à **${g.name}**.\n\n**Owner** : ${ownerId?`<@${ownerId}>`:'Inconnu'}\n**Ajouté par** : ${inviter?`<@${inviter.id}>`:'Inconnu / journal inaccessible'}\n\nTant que tu n’acceptes pas, **aucune commande, configuration ou action ne peut être exécutée**.`;for(const x of db.prepare('SELECT user_id FROM owners').all()){const u=await c.users.fetch(x.user_id).catch(()=>null);if(u)await u.send({embeds:[embed(g.id,{title:'⚠️ DREAM • Nouvelle intégration',description:desc,fields:[{name:'Lien d’invitation',value:`[Inviter ${botName}](${invite})`} ]})],components:[row(btn(`integration:accept:${g.id}:${c.user.id}`,'Accepter',ButtonStyle.Success),btn(`integration:reject:${g.id}:${c.user.id}`,'Refuser',ButtonStyle.Danger))]}).catch(()=>{});}}
for(const c of [clients.one,clients.two]){c.on('guildCreate',g=>createIntegrationRequest(c,g));c.on('guildDelete',g=>guilds.delete(g.id));}
clients.one.on('ready',async()=>{for(const g of clients.one.guilds.cache.values()){guilds.set(g.id,g);cfg(g.id);ensureCommandConfig(g.id);ensureLegacyBotAccess(clients.one,g);if(botAccepted(g.id,clients.one.user.id))await syncCustomCommands(g).catch(()=>{});}console.log(`Commu Dream connecté : ${clients.one.user.tag}`);});
clients.two.on('ready',async()=>{for(const g of clients.two.guilds.cache.values()){guilds.set(g.id,g);cfg(g.id);ensureCommandConfig(g.id);ensureLegacyBotAccess(clients.two,g);if(botAccepted(g.id,clients.two.user.id))await refreshGuild(g);}console.log(`Dream Protect connecté : ${clients.two.user.tag}`);});
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
    return i.reply({embeds:[embed(i.guildId,{title:'🛡️ DREAM • Sanction',description})],components:[...sanctionConfirmRows(id)],ephemeral:true});
  }
  if(!i.isChatInputCommand()) return;
  if(i.commandName==='configuration') return await openConfiguration(i);
  if(i.commandName==='lock'||i.commandName==='unlock'){requireAccess(i.guildId,i.user.id,i.commandName,50);const lock=i.commandName==='lock';if(lock){db.prepare('INSERT OR IGNORE INTO locks(guild_id,channel_id,created_at) VALUES(?,?,?)').run(i.guildId,i.channelId,now());await i.channel.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:false},'Dream Protect lock');}else{db.prepare('DELETE FROM locks WHERE guild_id=? AND channel_id=?').run(i.guildId,i.channelId);await i.channel.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:null},'Dream Protect unlock');}return i.reply({content:lock?'🔒 Verrouillé.':'🔓 Déverrouillé.',ephemeral:true});}
  if(i.commandName==='wet-info'){requireAccess(i.guildId,i.user.id,'/wet-info',50);const a=db.prepare('SELECT * FROM wet WHERE guild_id=? ORDER BY level DESC').all(i.guildId);return i.reply({embeds:[embed(i.guildId,{title:'WET • Informations',description:a.map(x=>`<@${x.user_id}> — ${LEVEL_NAME(x.level)}`).join('\n')||'Aucun.'})],ephemeral:true});}
  if(i.commandName==='wet'){requireAccess(i.guildId,i.user.id,'/wet',50);db.prepare('INSERT INTO wet(guild_id,user_id,level,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET level=excluded.level,updated_at=excluded.updated_at').run(i.guildId,i.user.id,35,now(),now());return i.reply({content:'✅ WET activé.',ephemeral:true});}
 } catch(e){ if(i.replied||i.deferred)return i.followUp({content:`⛔ ${String(e.message||e).slice(0,1900)}`,ephemeral:true}).catch(()=>{}); return i.reply({content:`⛔ ${String(e.message||e).slice(0,1900)}`,ephemeral:true}).catch(()=>{}); } });

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
      const keep=left.level>=100||!!cc?.private_voice_persist;
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

setInterval(async()=>{
  for(const g of clients.two.guilds.cache.values())try{await refreshGuild(g);}catch{}
},30*60*1000);
setInterval(backup,Math.max(15,Number(process.env.BACKUP_MINUTES||30))*60*1000);

const rest1=new REST({version:'10'}).setToken(process.env.BOT1_TOKEN||'');
const rest2=new REST({version:'10'}).setToken(process.env.BOT2_TOKEN||'');
(async()=>{
  if(!process.env.BOT1_TOKEN||!process.env.BOT2_TOKEN)throw new Error('BOT1_TOKEN et BOT2_TOKEN sont requis.');
  await clients.one.login(process.env.BOT1_TOKEN); await clients.two.login(process.env.BOT2_TOKEN);
  const ids=(process.env.REGISTER_GUILD_ID||'').split(',').map(x=>x.trim()).filter(Boolean);
  const protectedNames=new Set(['configuration']);
  const publicSlash=slash.filter(x=>x.name!=='configuration'&&!protectedNames.has(x.name));
  const protectSlash=slash.filter(x=>protectedNames.has(x.name));
  if(ids.length){for(const id of ids){await rest1.put(Routes.applicationGuildCommands(clients.one.user.id,id),{body:publicSlash});await rest2.put(Routes.applicationGuildCommands(clients.two.user.id,id),{body:protectSlash});}}
  else {await rest1.put(Routes.applicationCommands(clients.one.user.id),{body:publicSlash});await rest2.put(Routes.applicationCommands(clients.two.user.id),{body:protectSlash});}
})();

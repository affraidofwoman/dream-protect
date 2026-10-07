import { PermissionFlagsBits } from 'discord.js';
import { db, now, parse, json } from './base.js';
import { guildOf } from './bots.js';
import { SAY, hooks } from './ui.js';

// Rangs internes
export const RANKS = [
  ['SYS+', 100],
  ['SYS', 90],
  ['OWNER', 80],
];
export const LEVEL = { 'SYS+': 100, SYS: 90, OWNER: 80 };
export const CREATOR = 999;
export const STAFF_TOP = 79;

// Owners globaux
const envOwners = new Set((process.env.OWNER_IDS || '').split(/[\s,;]+/).filter((x) => /^\d{17,20}$/.test(x)));
let dbOwners = null;
const loadOwners = () =>
  (dbOwners = new Set(
    db
      .prepare('SELECT user_id FROM owners')
      .all()
      .map((x) => x.user_id),
  ));
export const isCreator = (uid) => envOwners.has(uid) || (dbOwners ?? loadOwners()).has(uid);
export const isEnvOwner = (uid) => envOwners.has(uid);
export const creators = () => [...new Set([...envOwners, ...(dbOwners ?? loadOwners())])];
export function toggleCreator(uid) {
  if (envOwners.has(uid)) throw new Error('Cet owner vient du fichier .env.');
  const had = (dbOwners ?? loadOwners()).has(uid);
  if (had) db.prepare('DELETE FROM owners WHERE user_id=?').run(uid);
  else db.prepare('INSERT OR IGNORE INTO owners(user_id,created_at) VALUES(?,?)').run(uid, now());
  loadOwners();
  clearRanks();
  return !had;
}

// Liens rôle système
export function ensureRanks(gid) {
  const ins = db.prepare('INSERT OR IGNORE INTO hierarchy(guild_id,name,level,role_id) VALUES(?,?,?,NULL)');
  for (const [name, level] of RANKS) ins.run(gid, name, level);
}
export function rankRows(gid) {
  ensureRanks(gid);
  return db
    .prepare("SELECT name,level,role_id FROM hierarchy WHERE guild_id=? AND name IN ('SYS+','SYS','OWNER') ORDER BY level DESC")
    .all(gid);
}
export function linkRank(gid, name, roleId) {
  if (!LEVEL[name]) throw new Error('Rang inconnu.');
  ensureRanks(gid);
  db.prepare('UPDATE hierarchy SET role_id=? WHERE guild_id=? AND name=?').run(roleId || null, gid, name);
  clearRanks(gid);
}

// Rangs donnés
export function setRank(gid, uid, name) {
  db.prepare("DELETE FROM wl WHERE guild_id=? AND user_id=? AND kind<>'WLCUSTOMPLUS'").run(gid, uid);
  if (name) {
    db.prepare('INSERT INTO wl(guild_id,user_id,kind,level,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(
      gid,
      uid,
      'RANG',
      LEVEL[name],
      now(),
      now(),
    );
  }
  clearRanks(gid, uid);
}
export function givenRank(gid, uid) {
  const row = db.prepare("SELECT MAX(level) AS level FROM wl WHERE guild_id=? AND user_id=? AND kind<>'WLCUSTOMPLUS'").get(gid, uid);
  return row?.level ?? -1;
}
export function rankHolders(gid) {
  return db
    .prepare("SELECT user_id,MAX(level) AS level FROM wl WHERE guild_id=? AND kind<>'WLCUSTOMPLUS' GROUP BY user_id ORDER BY level DESC")
    .all(gid);
}

// Échelle du staff
export function staffRows(gid) {
  return db.prepare('SELECT role_id,name,level FROM linked_roles WHERE guild_id=? AND level<=? ORDER BY level DESC').all(gid, STAFF_TOP);
}
export const staffOf = (gid, roleId) =>
  db.prepare('SELECT role_id,name,level FROM linked_roles WHERE guild_id=? AND role_id=? AND level<=?').get(gid, roleId, STAFF_TOP) ?? null;
export function syncStaff(gid) {
  const g = guildOf(gid);
  if (!g) return;
  const rows = staffRows(gid).map((x) => ({ ...x, role: g.roles.cache.get(x.role_id) }));
  const gone = rows.filter((x) => !x.role);
  for (const x of gone) db.prepare('DELETE FROM linked_roles WHERE guild_id=? AND role_id=?').run(gid, x.role_id);
  const live = rows.filter((x) => x.role).sort((a, b) => b.role.position - a.role.position);
  live.forEach((x, n) => {
    const level = Math.max(1, STAFF_TOP - n);
    if (level !== x.level || x.role.name !== x.name) {
      db.prepare('UPDATE linked_roles SET level=?,name=? WHERE guild_id=? AND role_id=?').run(
        level,
        x.role.name.slice(0, 80),
        gid,
        x.role_id,
      );
    }
  });
  clearRanks(gid);
  return gone.length;
}
export function addStaff(gid, role) {
  if (!role?.id || role.managed || role.id === gid) throw new Error('Ce rôle ne peut pas faire partie du staff.');
  db.prepare('INSERT OR IGNORE INTO linked_roles(guild_id,role_id,name,level,created_at) VALUES(?,?,?,?,?)').run(
    gid,
    role.id,
    role.name.slice(0, 80),
    1,
    now(),
  );
  syncStaff(gid);
}
export function removeStaff(gid, roleId) {
  db.prepare('DELETE FROM linked_roles WHERE guild_id=? AND role_id=? AND level<=?').run(gid, roleId, STAFF_TOP);
  syncStaff(gid);
}

// Rang calculé
const ranks = new Map();
export function clearRanks(gid = null, uid = null) {
  if (!gid) return ranks.clear();
  for (const k of ranks.keys()) if (k.startsWith(`${gid}:`) && (!uid || k === `${gid}:${uid}`)) ranks.delete(k);
}
export function rank(gid, uid, member = null) {
  if (!uid) return -1;
  if (isCreator(uid)) return CREATOR;
  const key = `${gid}:${uid}`;
  const hit = ranks.get(key);
  if (hit && hit.at > now() - 5000 && !member) return hit.value;
  let value = givenRank(gid, uid);
  if (guildOf(gid)?.ownerId === uid) value = Math.max(value, LEVEL['SYS+']);
  const m = member ?? guildOf(gid)?.members.cache.get(uid);
  if (m?.roles?.cache) {
    for (const r of rankRows(gid)) if (r.role_id && m.roles.cache.has(r.role_id)) value = Math.max(value, r.level);
    for (const s of staffRows(gid)) if (m.roles.cache.has(s.role_id)) value = Math.max(value, s.level);
  }
  ranks.set(key, { value, at: now() });
  return value;
}
export function rankName(gid, level) {
  if (level >= CREATOR) return 'Créateur';
  const sys = RANKS.find(([, v]) => v === level);
  if (sys) return sys[0];
  if (level >= 1) return db.prepare('SELECT name FROM linked_roles WHERE guild_id=? AND level=?').get(gid, level)?.name ?? 'Staff';
  return 'Membre';
}
export const rankOf = (gid, uid, member = null) => rankName(gid, rank(gid, uid, member));
hooks.rankName = rankOf;

// Groupes de droits
export const GROUPS = {
  ui: { label: 'Fiche membre', emoji: '👤', base: 'staff', commands: ['=ui'] },
  ban: { label: 'Bannir', emoji: '🔨', base: 'OWNER', commands: ['+ban', '+unban', '-baninfo', '+unbanall'] },
  derank: { label: 'Derank', emoji: '📉', base: 'OWNER', commands: ['&derank'] },
  salons: { label: 'Salons et WET', emoji: '🔒', base: 'OWNER', commands: ['&lock', '&unlock', '/wet', '/wet-info'] },
  owner: { label: 'Owner', emoji: '👑', base: 'OWNER', commands: ['=pv', '=acces', '&bl', '&unbl', '&blinfo', '/dog-add', '/dog-del'] },
  roles: { label: 'Rôles', emoji: '🎭', base: 'OWNER', commands: ['/addrole', '/delrole'] },
  masse: { label: 'Rôle en masse', emoji: '👥', base: 'SYS', commands: ['+massiveroleadd'] },
  contenu: {
    label: 'Contenu',
    emoji: '🧹',
    base: 'OWNER',
    commands: ['&clear', '+badword', '/protect', '=ticket', '=reglement', '=panneau', '/giveaway'],
  },
  argent: { label: 'Argent', emoji: '💶', base: 'OWNER', commands: ['/add', '/del', '/logs', '/payment', '=default', '=prix'] },
  config: {
    label: 'Configuration',
    emoji: '⚙️',
    base: 'SYS',
    commands: ['/wl', '=hierarchie', '=droits', '=logs', '=tableaux', '=stats', '=couleur', '=bienvenue', '=vocal', '&l0all', '=urgence'],
  },
};
const GROUP_OF = new Map(Object.entries(GROUPS).flatMap(([key, g]) => g.commands.map((c) => [c, key])));
export const groupOf = (command) => GROUP_OF.get(command) ?? null;

// Seuil d'un groupe
export function threshold(gid, key) {
  const row = db.prepare('SELECT min_level,roles FROM command_permissions WHERE guild_id=? AND command=?').get(gid, `group:${key}`);
  const roleId = row ? parse(row.roles, [])[0] : null;
  if (roleId) {
    const s = staffOf(gid, roleId);
    if (s) return { level: s.level, label: `<@&${roleId}>`, roleId, custom: true };
  }
  if (row && row.min_level >= 80) return { level: row.min_level, label: rankName(gid, row.min_level), custom: true };
  if (row && row.min_level === 1) return { level: 1, label: 'tout le staff', custom: true };
  const base = GROUPS[key]?.base ?? 'OWNER';
  if (base === 'staff') return { level: 1, label: 'tout le staff', custom: false };
  return { level: LEVEL[base], label: base, custom: false };
}
export function setThreshold(gid, key, value) {
  if (!GROUPS[key]) throw new Error('Groupe inconnu.');
  if (value === null) {
    db.prepare('DELETE FROM command_permissions WHERE guild_id=? AND command=?').run(gid, `group:${key}`);
    return;
  }
  const isRole = /^\d{17,20}$/.test(value);
  const level = isRole ? 0 : value === 'staff' ? 1 : LEVEL[value];
  if (!isRole && !level) throw new Error('Seuil inconnu.');
  if (isRole && !staffOf(gid, value)) throw new Error('Ce rôle ne fait pas partie du staff.');
  db.prepare(
    `INSERT INTO command_permissions(guild_id,command,min_level,levels,roles,updated_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(guild_id,command) DO UPDATE SET min_level=excluded.min_level,roles=excluded.roles,updated_at=excluded.updated_at`,
  ).run(gid, `group:${key}`, level, '[]', json(isRole ? [value] : []), now());
}

// Urgence active
export const emergencyOn = (gid) => db.prepare('SELECT 1 FROM emergency WHERE guild_id=? AND active=1').get(gid) !== undefined;

// Peut lancer
export function allowed(gid, uid, command, member = null) {
  if (isCreator(uid)) return true;
  const r = rank(gid, uid, member);
  if (emergencyOn(gid) && r < LEVEL.SYS) return false;
  const key = groupOf(command);
  if (!key) return true;
  return r >= threshold(gid, key).level;
}

// Position Discord
const top = (m) => m?.roles?.highest?.position ?? -1;

// Viser quelqu'un
export function checkTarget(ctx, targetId, target = null, { bot = true } = {}) {
  const { gid, user, guild } = ctx;
  if (targetId === user.id) throw new Error(SAY.self);
  if (isCreator(targetId) && !isCreator(user.id)) throw new Error('Ce compte est protégé.');
  if (guild?.ownerId === targetId && !isCreator(user.id)) throw new Error('Le propriétaire du serveur est protégé.');
  if (!isCreator(user.id) && rank(gid, user.id, ctx.member) <= rank(gid, targetId, target)) throw new Error(SAY.above);
  if (target && !isCreator(user.id) && guild?.ownerId !== user.id && top(ctx.member) <= top(target)) throw new Error(SAY.above);
  if (target && bot && top(guild?.members.me) <= top(target)) throw new Error(SAY.botLow);
}

// Toucher un rôle
export const isProtectedRole = (gid, roleId) =>
  db.prepare('SELECT 1 FROM protected_roles WHERE guild_id=? AND role_id=?').get(gid, roleId) !== undefined;
export function roleLevel(gid, roleId) {
  const sys = rankRows(gid).find((r) => r.role_id === roleId);
  if (sys) return sys.level;
  return staffOf(gid, roleId)?.level ?? 0;
}
export function checkRole(ctx, role) {
  const { gid, user, guild } = ctx;
  if (!role || role.managed || role.id === gid) throw new Error('Ce rôle ne peut pas être donné.');
  if (top(guild.members.me) <= role.position) throw new Error(SAY.botLow);
  if (isCreator(user.id)) return;
  const mine = rank(gid, user.id, ctx.member);
  if (roleLevel(gid, role.id) >= mine) throw new Error('Ce rôle est à ton rang ou au-dessus.');
  if (isProtectedRole(gid, role.id) && mine < LEVEL.SYS) throw new Error('Ce rôle est protégé.');
  if (guild.ownerId !== user.id && top(ctx.member) <= role.position) throw new Error('Ce rôle est plus haut que ton rôle le plus haut.');
  const danger = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.BanMembers,
  ];
  if (danger.some((p) => role.permissions.has(p)) && mine < LEVEL.SYS) throw new Error('Ce rôle donne des permissions sensibles.');
}

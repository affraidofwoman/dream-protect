import { ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { burst, cfg, db, json, now, parse, sleep } from './base.js';
import { bots } from './bots.js';
import { journal, notice } from './ui.js';

// Structure des logs
export const LOG_TREE = [
  ['Logs · Sanctions', [
    ['wet', 'wet-log', 'Bans globaux /wet, posés et levés'],
    ['bl', 'bl-log', 'Blacklist &bl et &unbl'],
    ['ban', 'ban-log', 'Bannissements +ban, +unban, +unbanall'],
    ['badword', 'badword-log', 'Messages coupés par le filtre'],
    ['clear', 'clear-log', 'Messages effacés avec &clear'],
  ]],
  ['Logs · Rôles & Accès', [
    ['role', 'role-log', 'Rôles donnés ou retirés'],
    ['wl', 'wl-log', 'Rangs donnés ou retirés (/wl, &derank)'],
    ['perm', 'perm-log', 'Hiérarchie et droits des commandes'],
    ['abo', 'abo-log', 'Abonnements'],
    ['autorole', 'autorole-log', 'Rôles donnés à l’arrivée'],
  ]],
  ['Logs · Économie', [
    ['contrib', 'contrib-log', 'Contributions créditées'],
    ['vente', 'vente-log', 'Ventes et prix'],
    ['paiement', 'paiement-log', 'Paiements et statuts'],
  ]],
  ['Logs · Tickets', [
    ['ticket', 'ticket-logs', 'Ouverture, fermeture et transcript'],
  ]],
  ['Logs · Serveur', [
    ['membre', 'membre-log', 'Arrivées et départs'],
    ['salon', 'salon-log', 'Salons créés, modifiés, supprimés'],
    ['commande', 'commande-log', 'Commandes utilisées'],
    ['backup', 'backup-log', 'Sauvegardes de la base'],
    ['bataillon', 'bataillon-log', 'Rangs du staff synchronisés'],
    ['sante', 'sante-log', 'État des bots et alertes'],
  ]],
  ['Logs · Fun & Vocal', [
    ['dog', 'dog-log', 'Laisses /dog-add et /dog-del'],
    ['giveaway', 'giveaway-log', 'Giveaways lancés et tirés'],
  ]],
];
export const LOG_KEYS = new Map(LOG_TREE.flatMap(([, list]) => list.map(([key, name]) => [key, name])));
export const MIRROR_DEFAULT = ['ticket', 'ban', 'bl', 'wet'];

// Serveur des logs
export function logHome(guild) {
  const id = guild ? cfg(guild.id).logGuild : null;
  return id ? bots.guard.guilds.cache.get(id) || bots.main.guilds.cache.get(id) || null : null;
}
export function logChannel(guild, key) {
  const home = logHome(guild);
  if (!home) return null;
  const row = db.prepare('SELECT channel_id FROM log_channels WHERE guild_id=? AND key=?').get(home.id, key);
  return row?.channel_id ? home.channels.cache.get(row.channel_id) || null : null;
}
export function logCount(guild) {
  return [...LOG_KEYS.keys()].filter((k) => logChannel(guild, k)).length;
}

// Créer l'arborescence
export async function ensureTree(home) {
  const me = home.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error('Il me faut « Gérer les salons » sur ce serveur.');
  const hidden = [
    { id: home.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory] },
  ];
  let created = 0;
  let kept = 0;
  for (const [catName, list] of LOG_TREE) {
    let cat = home.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === catName);
    if (!cat) {
      cat = await home.channels.create({ name: catName, type: ChannelType.GuildCategory, permissionOverwrites: hidden, reason: 'Logs Dream' });
      created++;
    }
    for (const [key, name, topic] of list) {
      const row = db.prepare('SELECT channel_id FROM log_channels WHERE guild_id=? AND key=?').get(home.id, key);
      let ch = row?.channel_id ? home.channels.cache.get(row.channel_id) : null;
      ch ??= home.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === name);
      if (ch) {
        kept++;
        if (ch.parentId !== cat.id) await ch.setParent(cat.id, { lockPermissions: true, reason: 'Logs Dream' }).catch(() => {});
      } else {
        ch = await home.channels.create({ name, type: ChannelType.GuildText, parent: cat.id, topic, reason: 'Logs Dream' });
        created++;
        await sleep(300);
      }
      db.prepare(
        `INSERT INTO log_channels(guild_id,key,channel_id,category_id,mirror_id,created_at) VALUES(?,?,?,?,NULL,?)
         ON CONFLICT(guild_id,key) DO UPDATE SET channel_id=excluded.channel_id,category_id=excluded.category_id`,
      ).run(home.id, key, ch.id, cat.id, now());
    }
  }
  return { created, kept };
}

// Envoyer un log
export async function log(guild, key, o = {}) {
  if (!guild) return null;
  const lines = [...(o.lines || [])];
  const ch = logChannel(guild, key);
  if (ch && ch.guild.id !== guild.id) lines.push(`**Serveur** : ${guild.name}`);
  const embed = journal({ ...o, lines });
  const payload = { embeds: [embed], files: o.files || [], allowedMentions: { parse: [] } };
  let sent = null;
  if (ch) {
    sent = await ch.send(payload).catch(() => null);
    if (sent) {
      db.prepare('INSERT OR REPLACE INTO log_messages(guild_id,message_id,channel_id,category,title,description,actor_id,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(
        ch.guild.id, sent.id, ch.id, key, o.title || 'Log', json(embed.toJSON()), o.by?.id ?? null, 'OK', now(),
      );
    }
  }
  const m = cfg(guild.id).logMirror;
  if (m?.channelId && (m.keys ?? MIRROR_DEFAULT).includes(key) && m.channelId !== ch?.id) {
    const mirror = guild.channels.cache.get(m.channelId);
    if (mirror?.isTextBased()) await mirror.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
  }
  return sent;
}

// Logs protégés
export async function guardLog(message, actorId = null) {
  if (!message?.id) return false;
  const rec = db.prepare('SELECT * FROM log_messages WHERE message_id=?').get(message.id);
  if (!rec || burst(`restore:${rec.guild_id}`, 20, 60_000)) return false;
  const home = bots.guard.guilds.cache.get(rec.guild_id);
  const ch = home?.channels.cache.get(rec.channel_id);
  if (!ch?.isTextBased()) return false;
  const data = parse(rec.description, null);
  const embeds = [];
  if (data?.description || data?.author) embeds.push(EmbedBuilder.from(data));
  embeds.push(journal({ title: 'Log supprimé puis remis', tone: 'alerte', lines: [actorId ? `**Par** : <@${actorId}>` : '**Par** : inconnu', 'Les logs ne se suppriment pas.'] }));
  const back = await ch.send({ embeds, allowedMentions: { parse: [] } }).catch(() => null);
  db.prepare('DELETE FROM log_messages WHERE message_id=?').run(message.id);
  if (back) {
    db.prepare('INSERT OR REPLACE INTO log_messages(guild_id,message_id,channel_id,category,title,description,actor_id,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(
      rec.guild_id, back.id, rec.channel_id, rec.category, rec.title, rec.description, rec.actor_id, 'RESTORED', now(),
    );
  }
  return !!back;
}

// Avis en MP
const NOTICES = {
  ban: { on: (w) => `Tu as été **banni** de ${w}.`, off: (w) => `Ton bannissement de ${w} a été **levé**. Tu peux revenir quand tu veux.` },
  bl: { on: (w) => `Tu as été **blacklist** de ${w} définitivement.`, off: (w) => `Tu as été **retiré de la blacklist** de ${w}. Tu peux revenir.` },
  wet: { on: () => 'Tu as été **banni de tous les serveurs** Dream.', off: () => 'Ton **wet** a été levé, les serveurs te sont rouverts.' },
  derank: { on: (w) => `Tes **rôles staff** sur ${w} t’ont été retirés.` },
  rank: {
    on: (w, o) => `Tu as reçu le rang **${o.label}** sur ${w}. Bienvenue dans l’équipe !`,
    off: (w, o) => `Ton rang **${o.label}** sur ${w} t’a été retiré.`,
  },
};
export async function warn(guild, userId, type, action = 'on', o = {}) {
  const text = NOTICES[type]?.[action];
  if (!text || cfg(guild.id).dm === false) return false;
  const where = `**${guild.name}**`;
  const lines = [text(where, o)];
  if (action === 'on' && o.reason) lines.push('', `Raison : ${o.reason}`);
  if (action === 'on' && type !== 'rank') lines.push('', 'Si tu penses qu’il s’agit d’une erreur, contacte un gérant.');
  const good = action === 'off' || type === 'rank';
  for (const client of [bots.guard, bots.main]) {
    if (!client.isReady()) continue;
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) continue;
    const sent = await user.send({ embeds: [notice({ good, text: lines.join('\n'), guildName: guild.name })] }).catch(() => null);
    if (sent) return true;
  }
  return false;
}

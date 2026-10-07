import fs from 'node:fs';
import path from 'node:path';
import { AttachmentBuilder, AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { DATA, audit, backup, burst, cfg, db, every, now, prune, resetBurst, settingGet, settingSet } from './base.js';
import { NAMES, accepted, acting, bots, roleOf, setAccess } from './bots.js';
import * as communaute from './communaute.js';
import { GROUPS, LEVEL, clearRanks, creators, isCreator, rank, rankRows, roleLevel, setThreshold, staffRows, syncStaff, threshold } from './droits.js';
import { LOG_KEYS, ensureTree, guardLog, log, logHome, warn } from './logs.js';
import { emergency } from './moderation.js';
import { refreshTables, scheduleTables } from './reglages.js';
import { E, button, journal, pair, row } from './ui.js';

const DANGER = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
];
const ours = (id) => id === bots.main.user?.id || id === bots.guard.user?.id;

// Auteur via audit
async function executor(guild, type, targetId) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
  const logs = await guild.fetchAuditLogs({ type, limit: 6 }).catch(() => null);
  const entry = logs?.entries.find(
    (e) => (!targetId || e.target?.id === targetId || e.extra?.channel?.id === targetId) && now() - e.createdTimestamp < 20_000,
  );
  return entry?.executor ?? null;
}
const trusted = (guild, id) => !id || ours(id) || isCreator(id) || guild.ownerId === id;

// Validation serveur
async function onJoin(guild) {
  const client = guild.client;
  const other = roleOf(client) === 'main' ? bots.guard : bots.main;
  const adder = await executor(guild, AuditLogEvent.BotAdd, client.user.id);
  if (accepted(guild.id, other.user?.id) || (adder && isCreator(adder.id))) {
    setAccess(guild.id, client, 'accepted', adder?.id ?? 'auto');
    return;
  }
  setAccess(guild.id, client, 'pending', null, { inviter: adder?.id, owner: guild.ownerId });
  const embed = journal({
    title: 'Nouveau serveur à valider',
    tone: 'or',
    lines: [
      pair('Serveur', `**${guild.name}** \`${guild.id}\``),
      pair('Bot', NAMES[roleOf(client)]),
      pair('Propriétaire', `<@${guild.ownerId}>`),
      pair('Ajouté par', adder ? `<@${adder.id}>` : 'inconnu'),
      pair('Membres', guild.memberCount),
      '',
      'Tant que tu n’acceptes pas, le bot ne fait rien sur ce serveur.',
    ],
  });
  for (const id of creators()) {
    const u = await client.users.fetch(id).catch(() => null);
    await u
      ?.send({
        embeds: [embed],
        components: [
          row(
            button(`acc:yes:${guild.id}:${client.user.id}`, 'Accepter', 'vert', E.ok),
            button(`acc:no:${guild.id}:${client.user.id}`, 'Refuser', 'rouge', E.no),
          ),
        ],
      })
      .catch(() => {});
  }
}
export async function onApproval(i, [answer, guildId, botId]) {
  if (!isCreator(i.user.id)) throw new Error('Seuls les owners du bot valident un serveur.');
  const client = [bots.main, bots.guard].find((c) => c.user?.id === botId);
  const guild = client?.guilds.cache.get(guildId);
  if (!guild) throw new Error('Le bot n’est plus sur ce serveur.');
  if (answer === 'yes') {
    setAccess(guildId, client, 'accepted', i.user.id);
    await log(guild, 'sante', { title: 'Serveur validé', tone: 'ok', by: i.user, lines: [pair('Bot', NAMES[roleOf(client)])] });
  } else {
    setAccess(guildId, client, 'rejected', i.user.id);
    await guild.leave().catch(() => {});
  }
  return i.update({
    embeds: [
      journal({
        title: answer === 'yes' ? 'Serveur accepté' : 'Serveur refusé, le bot est parti',
        tone: answer === 'yes' ? 'ok' : 'alerte',
        lines: [pair('Serveur', guild.name)],
        by: i.user,
      }),
    ],
    components: [],
  });
}
function adoptExisting(client) {
  for (const g of client.guilds.cache.values()) {
    if (!db.prepare('SELECT 1 FROM bot_access WHERE guild_id=? AND bot_id=?').get(g.id, client.user.id))
      setAccess(g.id, client, 'accepted', 'existant');
  }
}

// Sanctions persistantes
async function enforceBans(guild, userId) {
  const wet = db.prepare('SELECT reason FROM wet_global WHERE user_id=?').get(userId);
  const bl = db.prepare("SELECT reason FROM bl WHERE guild_id=? AND user_id=? AND kind='BL'").get(guild.id, userId);
  if (!wet && !bl) return false;
  const why = wet ? 'WET' : 'BL';
  const done = await guild.members
    .ban(userId, { reason: `${why} toujours actif` })
    .then(() => true)
    .catch(() => false);
  if (done)
    await log(guild, wet ? 'wet' : 'bl', {
      title: 'Re-banni à son retour',
      tone: 'alerte',
      lines: [pair('Cible', `<@${userId}> \`${userId}\``), pair('Type', why)],
    });
  return done;
}

// Anti ajout rôle
async function watchRoles(before, after) {
  const guild = after.guild;
  const added = [...after.roles.cache.values()].filter((r) => !before.roles.cache.has(r.id));
  const removed = [...before.roles.cache.values()].filter((r) => !after.roles.cache.has(r.id));
  const staffIds = new Set([
    ...staffRows(guild.id).map((x) => x.role_id),
    ...rankRows(guild.id)
      .map((x) => x.role_id)
      .filter(Boolean),
  ]);
  const staffMoves = [...added.filter((r) => staffIds.has(r.id)), ...removed.filter((r) => staffIds.has(r.id))];
  if (staffMoves.length) {
    clearRanks(guild.id, after.id);
    const by = await executor(guild, AuditLogEvent.MemberRoleUpdate, after.id);
    await log(guild, 'bataillon', {
      title: 'Rang staff modifié',
      tone: 'info',
      by: by ?? undefined,
      lines: [
        pair('Membre', `<@${after.id}>`),
        added.some((r) => staffIds.has(r.id)) ? pair('Reçu', added.filter((r) => staffIds.has(r.id)).map((r) => r.name).join(', ')) : null,
        removed.some((r) => staffIds.has(r.id)) ? pair('Perdu', removed.filter((r) => staffIds.has(r.id)).map((r) => r.name).join(', ')) : null,
      ],
    });
  }
  const sensitive = added.filter(
    (r) =>
      staffIds.has(r.id) ||
      DANGER.some((p) => r.permissions.has(p)) ||
      db.prepare('SELECT 1 FROM protected_roles WHERE guild_id=? AND role_id=?').get(guild.id, r.id),
  );
  if (!sensitive.length || !cfg(guild.id).protect.roles) return;
  const who = await executor(guild, AuditLogEvent.MemberRoleUpdate, after.id);
  if (trusted(guild, who?.id)) return;
  const giver = await guild.members.fetch(who.id).catch(() => null);
  const mine = rank(guild.id, who.id, giver);
  const bad = sensitive.filter(
    (r) =>
      (roleLevel(guild.id, r.id) >= mine || (DANGER.some((p) => r.permissions.has(p)) && mine < LEVEL.SYS) || who.id === after.id) &&
      r.editable,
  );
  if (!bad.length) return;
  await after.roles.remove(bad, 'Ajout non autorisé').catch(() => {});
  await log(guild, 'role', {
    title: 'Ajout de rôle bloqué',
    tone: 'alerte',
    by: who,
    lines: [
      pair('Membre', `<@${after.id}>`),
      pair('Rôles retirés', bad.map((r) => r.name).join(', ')),
      pair('Pourquoi', who.id === after.id ? 'auto-attribution' : 'rang trop bas pour ce rôle'),
    ],
  });
  audit(guild.id, who.id, 'escalation.role', after.id, { roles: bad.map((r) => r.id) });
  if (burst(`roleabuse:${guild.id}:${who.id}`, 3, 60_000)) await panic(guild, who.id, 'Ajouts de rôles sensibles en série');
}
async function watchRolePerms(before, after) {
  const guild = after.guild;
  const gained = DANGER.filter((p) => after.permissions.has(p) && !before.permissions.has(p));
  if (before.position !== after.position || before.name !== after.name) syncStaff(guild.id);
  if (before.permissions.bitfield === after.permissions.bitfield) return;
  const who = await executor(guild, AuditLogEvent.RoleUpdate, after.id);
  const plus = after.permissions.toArray().filter((p) => !before.permissions.has(p));
  const minus = before.permissions.toArray().filter((p) => !after.permissions.has(p));
  await log(guild, 'perm', {
    title: 'Permissions de rôle modifiées',
    tone: gained.length ? 'alerte' : 'info',
    by: who ?? undefined,
    lines: [pair('Rôle', `${after}`), plus.length ? pair('Ajouté', plus.join(', ')) : null, minus.length ? pair('Retiré', minus.join(', ')) : null],
  });
  if (!gained.length) return;
  const giver = who ? await guild.members.fetch(who.id).catch(() => null) : null;
  if (trusted(guild, who?.id) || rank(guild.id, who.id, giver) >= LEVEL['SYS+']) return;
  if (after.editable) await after.setPermissions(before.permissions, 'Permission sensible non autorisée').catch(() => {});
  await log(guild, 'perm', {
    title: 'Permission bloquée',
    tone: 'alerte',
    by: who,
    lines: [
      pair('Rôle', `${after}`),
      pair('Ce qui a été annulé', 'permissions sensibles'),
      'Seuls SYS+ et les owners peuvent donner ces permissions.',
    ],
  });
  audit(guild.id, who.id, 'escalation.perm', after.id);
}

// Abus en série
async function panic(guild, actorId, label) {
  resetBurst(`panic:${guild.id}`);
  if (db.prepare('SELECT 1 FROM emergency WHERE guild_id=? AND active=1').get(guild.id)) return;
  await emergency(guild, actorId || 'système', true, label);
  const m = actorId ? await guild.members.fetch(actorId).catch(() => null) : null;
  if (m && !trusted(guild, actorId) && m.manageable) {
    const strip = [...m.roles.cache.values()].filter((r) => r.editable && r.id !== guild.id && DANGER.some((p) => r.permissions.has(p)));
    if (strip.length) await m.roles.remove(strip, 'Urgence : rôles sensibles retirés').catch(() => {});
  }
}
async function watchDelete(guild, type, target, kind) {
  const who = await executor(guild, type, target.id);
  if (kind === 'role') {
    if (staffRows(guild.id).some((s) => s.role_id === target.id)) syncStaff(guild.id);
    await log(guild, 'role', { title: 'Rôle supprimé', tone: 'alerte', by: who ?? undefined, lines: [pair('Rôle', target.name)] });
  } else {
    await log(guild, 'salon', { title: 'Salon supprimé', tone: 'alerte', by: who ?? undefined, lines: [pair('Salon', `#${target.name}`)] });
  }
  if (who && !trusted(guild, who.id) && burst(`del:${guild.id}:${who.id}`, kind === 'role' ? 3 : 4, 60_000))
    await panic(guild, who.id, `Suppressions de ${kind === 'role' ? 'rôles' : 'salons'} en série`);
}

// Réparations
async function repairLogs(guild) {
  const isHome = db.prepare('SELECT 1 FROM log_channels WHERE guild_id=? LIMIT 1').get(guild.id);
  if (!isHome) return;
  const missing = db
    .prepare('SELECT key FROM log_channels WHERE guild_id=?')
    .all(guild.id)
    .filter((r) => {
      const id = db.prepare('SELECT channel_id FROM log_channels WHERE guild_id=? AND key=?').get(guild.id, r.key)?.channel_id;
      return !id || !guild.channels.cache.has(id);
    });
  if (!missing.length) return;
  await ensureTree(guild).catch(() => {});
  await log(guild, 'sante', {
    title: 'Salons de logs réparés',
    tone: 'info',
    lines: [pair('Recréés', missing.map((m) => LOG_KEYS.get(m.key)).join(', '))],
  });
}
async function reapplyLocks(guild) {
  for (const r of db.prepare('SELECT channel_id FROM locks WHERE guild_id=?').all(guild.id)) {
    const ch = guild.channels.cache.get(r.channel_id);
    if (!ch) db.prepare('DELETE FROM locks WHERE guild_id=? AND channel_id=?').run(guild.id, r.channel_id);
    else if (!ch.permissionOverwrites.cache.get(guild.id)?.deny.has(PermissionFlagsBits.SendMessages))
      await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, 'Verrou rétabli').catch(() => {});
  }
}
async function rebanMissing(guild) {
  const bans = await guild.bans.fetch().catch(() => null);
  if (!bans) return;
  const ids = [
    ...db.prepare("SELECT user_id FROM bl WHERE guild_id=? AND kind='BL'").all(guild.id),
    ...db.prepare('SELECT user_id FROM wet_global').all(),
  ].map((x) => x.user_id);
  for (const id of new Set(ids)) if (!bans.has(id)) await enforceBans(guild, id);
}
async function relockLeashes(guild) {
  for (const l of db.prepare('SELECT * FROM leashes WHERE guild_id=?').all(guild.id)) {
    const m = guild.members.cache.get(l.user_id);
    if (m && m.nickname !== l.nickname && m.manageable) await m.setNickname(l.nickname, 'Laisse').catch(() => {});
  }
}

// Abonnements expirés
async function expireSubs(guild) {
  for (const sub of db.prepare('SELECT * FROM subs WHERE guild_id=? AND until IS NOT NULL AND until<?').all(guild.id, now())) {
    db.prepare('DELETE FROM subs WHERE guild_id=? AND user_id=? AND label=?').run(guild.id, sub.user_id, sub.label);
    await log(guild, 'abo', { title: 'Abonnement expiré', tone: 'alerte', lines: [pair('Membre', `<@${sub.user_id}>`), pair('Abonnement', sub.label)] });
    await warn(guild, sub.user_id, 'abo', 'off', { label: sub.label });
  }
}

// Contrôle complet
export async function checkGuild(guild, { quiet = false } = {}) {
  if (!accepted(guild.id, bots.guard.user.id)) return [];
  const issues = [];
  const me = guild.members.me;
  for (const [perm, label] of [
    ['ManageRoles', 'Gérer les rôles'],
    ['ManageChannels', 'Gérer les salons'],
    ['BanMembers', 'Bannir'],
    ['ViewAuditLog', 'Voir les logs du serveur'],
    ['ManageNicknames', 'Gérer les pseudos'],
  ]) {
    if (!me.permissions.has(PermissionFlagsBits[perm])) issues.push(`Il me manque **${label}**`);
  }
  const gone = syncStaff(guild.id);
  if (gone) issues.push(`${gone} rôle(s) staff supprimé(s) retiré(s) de la hiérarchie`);
  for (const r of rankRows(guild.id))
    if (r.role_id && !guild.roles.cache.has(r.role_id)) issues.push(`Le rôle lié à ${r.name} n’existe plus`);
  if (!logHome(guild)) issues.push('Les logs ne sont pas branchés : `=logs`');
  for (const [key, g] of Object.entries(GROUPS)) {
    const row_ = db.prepare('SELECT roles FROM command_permissions WHERE guild_id=? AND command=?').get(guild.id, `group:${key}`);
    if (row_?.roles && row_.roles !== '[]' && !threshold(guild.id, key).roleId) {
      setThreshold(guild.id, key, null);
      issues.push(`Les droits « ${g.label} » visaient un rôle disparu : remis par défaut`);
    }
  }
  await expireSubs(guild).catch(() => {});
  await repairLogs(guild).catch(() => {});
  await reapplyLocks(guild).catch(() => {});
  await rebanMissing(guild).catch(() => {});
  await relockLeashes(guild).catch(() => {});
  await communaute.updateStats(guild).catch(() => {});
  await refreshTables(guild).catch(() => {});
  const key = `health:${issues.join('|')}`;
  if (!quiet && issues.length && settingGet(guild.id, 'GLOBAL', '*', 'lastHealth') !== key) {
    settingSet(guild.id, 'GLOBAL', '*', 'lastHealth', key);
    await log(guild, 'sante', { title: 'Contrôle automatique', tone: 'or', lines: issues.map((x) => `• ${x}`) });
  }
  return issues;
}

// Sauvegarde
async function doBackup() {
  const { file, count } = backup();
  const day = new Date().toISOString().slice(0, 10);
  if (settingGet('global', 'GLOBAL', '*', 'backupDay') === day) return;
  settingSet('global', 'GLOBAL', '*', 'backupDay', day);
  const full = path.join(DATA, 'backups', file);
  const small_ = fs.statSync(full).size < 8 * 1024 * 1024;
  for (const g of bots.guard.guilds.cache.values()) {
    if (!accepted(g.id, bots.guard.user.id) || !logHome(g) || logHome(g).id !== g.id) continue;
    await log(g, 'backup', {
      title: 'Sauvegarde du jour',
      tone: 'ok',
      lines: [pair('Fichier', file), pair('Gardées', count)],
      files: small_ ? [new AttachmentBuilder(full, { name: file })] : [],
    });
  }
}

// Branchement
export function start() {
  for (const client of [bots.main, bots.guard]) {
    client.on('guildCreate', (g) => onJoin(g).catch(() => {}));
    client.once('clientReady', () => adoptExisting(client));
  }
  const g2 = bots.guard;
  const ok = (guild) => guild && accepted(guild.id, g2.user.id);
  g2.on('guildMemberAdd', async (m) => {
    if (!ok(m.guild)) return;
    if (await enforceBans(m.guild, m.id)) return;
    await log(m.guild, 'membre', {
      title: 'Arrivée',
      tone: 'ok',
      by: m.user,
      lines: [
        pair('Membre', `<@${m.id}>`),
        pair('Compte créé', `<t:${Math.floor(m.user.createdTimestamp / 1000)}:R>`),
        pair('Membres', m.guild.memberCount),
      ],
    });
    await communaute.welcome(m);
    communaute.updateStats(m.guild).catch(() => {});
  });
  g2.on('guildMemberRemove', async (m) => {
    if (!ok(m.guild)) return;
    await log(m.guild, 'membre', {
      title: 'Départ',
      tone: 'alerte',
      by: m.user,
      lines: [pair('Membre', `<@${m.id}> \`${m.id}\``), pair('Membres', m.guild.memberCount)],
    });
    communaute.updateStats(m.guild).catch(() => {});
  });
  g2.on('guildBanAdd', async (ban) => {
    if (!ok(ban.guild) || !isCreator(ban.user.id)) return;
    await ban.guild.members.unban(ban.user.id, 'Owner du bot protégé').catch(() => {});
    await log(ban.guild, 'ban', { title: 'Owner débanni automatiquement', tone: 'alerte', lines: [pair('Cible', `<@${ban.user.id}>`)] });
  });
  g2.on('guildMemberUpdate', async (before, after) => {
    if (!ok(after.guild) || before.partial) return;
    const leash = db.prepare('SELECT nickname FROM leashes WHERE guild_id=? AND user_id=?').get(after.guild.id, after.id);
    if (leash && after.nickname !== leash.nickname && after.manageable) await after.setNickname(leash.nickname, 'Laisse').catch(() => {});
    await watchRoles(before, after).catch((e) => console.error('[rôles]', e.message));
  });
  g2.on('roleUpdate', (b, a) => ok(a.guild) && watchRolePerms(b, a).catch(() => {}));
  g2.on('roleDelete', (r) => ok(r.guild) && watchDelete(r.guild, AuditLogEvent.RoleDelete, r, 'role').catch(() => {}));
  g2.on('channelDelete', async (ch) => {
    if (!ch.guild || !ok(ch.guild)) return;
    await watchDelete(ch.guild, AuditLogEvent.ChannelDelete, ch, 'salon').catch(() => {});
    if (db.prepare('SELECT 1 FROM log_channels WHERE guild_id=? AND channel_id=?').get(ch.guild.id, ch.id))
      setTimeout(() => repairLogs(ch.guild).catch(() => {}), 3000);
    db.prepare('DELETE FROM voices WHERE channel_id=?').run(ch.id);
    db.prepare("UPDATE tickets SET status='CLOSED',closed_at=? WHERE channel_id=? AND status='OPEN'").run(now(), ch.id);
  });
  g2.on('channelUpdate', async (before, after) => {
    if (!after.guild || !ok(after.guild)) return;
    const renamed = before.name !== after.name;
    const perms = !before.permissionOverwrites.cache.equals(after.permissionOverwrites.cache);
    if (renamed || perms) {
      const who = await executor(after.guild, AuditLogEvent.ChannelUpdate, after.id);
      if (!ours(who?.id)) {
        await log(after.guild, 'salon', {
          title: 'Salon modifié',
          tone: 'info',
          by: who ?? undefined,
          lines: [pair('Salon', `<#${after.id}>`), renamed ? pair('Nom', `${before.name} → ${after.name}`) : null, perms ? pair('Permissions', 'modifiées') : null],
        });
      }
    }
    const isLog = db.prepare('SELECT 1 FROM log_channels WHERE guild_id=? AND channel_id=?').get(after.guild.id, after.id);
    if (isLog && after.permissionsFor(after.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
      await after.permissionOverwrites.edit(after.guild.roles.everyone, { ViewChannel: false }, 'Les logs restent privés').catch(() => {});
      await log(after.guild, 'salon', { title: 'Salon de logs refermé', tone: 'alerte', lines: [pair('Salon', `<#${after.id}>`)] });
    }
  });
  g2.on('messageDelete', async (m) => {
    if (!m.guild || !ok(m.guild)) return;
    if (db.prepare('SELECT 1 FROM log_messages WHERE message_id=?').get(m.id)) {
      const who = await executor(m.guild, AuditLogEvent.MessageDelete, m.channelId);
      if (!ours(who?.id)) await guardLog(m, who?.id);
    }
    if (db.prepare("SELECT 1 FROM panels WHERE guild_id=? AND message_id=? AND key LIKE 'table:%'").get(m.guild.id, m.id)) {
      await log(m.guild, 'sante', { title: 'Tableau supprimé', tone: 'alerte', lines: ['Il est remis en place automatiquement.'] });
      scheduleTables(m.guild.id);
    }
  });
  g2.on('messageDeleteBulk', async (list, channel) => {
    if (!channel.guild || !ok(channel.guild)) return;
    for (const m of list.values()) if (db.prepare('SELECT 1 FROM log_messages WHERE message_id=?').get(m.id)) await guardLog(m);
  });
  bots.main.on('voiceStateUpdate', async (before, after) => {
    if (!accepted(after.guild.id, bots.main.user.id)) return;
    await communaute.onVoice(before, after).catch(() => {});
    if (after.channelId && after.channelId !== before.channelId) {
      for (const l of db.prepare('SELECT user_id FROM leashes WHERE guild_id=? AND holder_id=?').all(after.guild.id, after.id)) {
        const dog = await acting(after.guild, PermissionFlagsBits.MoveMembers).members.fetch(l.user_id).catch(() => null);
        if (dog?.voice.channelId && dog.voice.channelId !== after.channelId)
          await dog.voice.setChannel(after.channelId, 'Suit son maître').catch(() => {});
      }
    }
  });

  // Tâches régulières
  every(30_000, () => communaute.tickGiveaways());
  every(5 * 60_000, async () => {
    for (const g of g2.guilds.cache.values()) if (ok(g)) await communaute.updateStats(g).catch(() => {});
    await communaute.cleanVoices();
  });
  every(12 * 60_000, async () => {
    for (const g of g2.guilds.cache.values()) await checkGuild(g).catch((e) => console.error('[contrôle]', e.message));
    prune();
  });
  every(Math.max(15, Number(process.env.BACKUP_MINUTES) || 30) * 60_000, doBackup);
}

// Démarrage serveur
export async function boot(guild) {
  await guild.members.fetch().catch(() => {});
  const issues = await checkGuild(guild, { quiet: true });
  settingSet(guild.id, 'GLOBAL', '*', 'lastHealth', `health:${issues.join('|')}`);
  await log(guild, 'sante', {
    title: 'Dream Protect en ligne',
    tone: 'ok',
    lines: [
      issues.length ? `${issues.length} point(s) à regarder, détail ci-dessous.` : 'Tout est en ordre.',
      ...issues.map((x) => `• ${x}`),
    ],
  });
  return issues;
}

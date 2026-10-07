import { AttachmentBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { audit, burst, cfg, cooldown, db, idOf, json, now, parse, plural, setCfg, sleep } from './base.js';
import { accepted, acting, bots } from './bots.js';
import {
  LEVEL,
  checkRole,
  checkTarget,
  creators,
  isCreator,
  rank,
  rankName,
  rankRows,
  setRank,
  staffOf,
  staffRows,
  toggleCreator,
} from './droits.js';
import { log, transcriptHtml, warn } from './logs.js';
import { E, SAY, button, dot, fail, info, msg, ok, pair, row, small, view } from './ui.js';

// Cibles lues
export function targetsOf(ctx, max = 10) {
  const tokens = [...ctx.args];
  const ids = [];
  while (tokens.length && idOf(tokens[0])) ids.push(idOf(tokens.shift()));
  if (!ids.length && ctx.repliedTo) ids.push(ctx.repliedTo);
  const unique = [...new Set(ids)];
  if (unique.length > max) throw new Error(`${max} personnes au maximum.`);
  return { ids: unique, reason: tokens.join(' ').trim() };
}
const member = (guild, id) => guild.members.fetch(id).catch(() => null);
const audit_ = (action, ctx, reason) => (reason ? `${action} par ${ctx.user.tag} : ${reason}` : `${action} par ${ctx.user.tag}`);
const record = (gid, target, actor, type, reason) =>
  db
    .prepare('INSERT INTO sanctions(guild_id,target_id,actor_id,type,reason,created_at) VALUES(?,?,?,?,?,?)')
    .run(gid, target, actor, type, reason || null, now());

// Bilan lisible
function summary(ctx, title, { done = [], undone = [], failed = [], reason }, words = ['Banni', 'Débanni']) {
  const list = (ids) => ids.map((id) => `<@${id}>`).join(', ');
  const lines = [];
  if (done.length) lines.push(pair(words[0], list(done)));
  if (undone.length) lines.push(pair(words[1], list(undone)));
  if (failed.length) lines.push(pair('Refusé', failed.map(([id, why]) => `<@${id}> — ${why}`).join('\n')));
  if (reason) lines.push(pair('Raison', reason));
  const good = done.length || undone.length;
  return (good ? ok : fail)(ctx, lines.join('\n') || 'Rien n’a été fait.', { title, emoji: E.shield });
}

// Fiche de sanction
async function sheet(ctx, id, { title, reason, by, at, scope }) {
  const user = await ctx.client.users.fetch(id).catch(() => null);
  return info(ctx, null, {
    title,
    emoji: E.shield,
    lines: [
      pair('Compte', user ? `${user.tag} (\`${id}\`)` : `\`${id}\``),
      pair('Raison', reason || '_aucune raison enregistrée_'),
      by ? pair('Par', `<@${by}>`) : null,
      at ? pair('Le', `<t:${Math.floor(at / 1000)}:f>`) : null,
      scope ? small(scope) : null,
    ],
  });
}

// Bans
async function banList(ctx, title, filter = () => true) {
  const g = acting(ctx.guild, PermissionFlagsBits.BanMembers);
  const bans = await g.bans.fetch().catch(() => null);
  if (!bans) throw new Error('Je ne peux pas lire la liste des bannis.');
  const rows = [...bans.values()].filter(filter);
  if (!rows.length) return ctx.send(msg(info(ctx, 'Personne pour l’instant.', { title, emoji: E.shield })));
  const text = rows
    .map((b) => `\`${b.user.id}\` ${b.user.tag}${b.reason ? ` — ${b.reason}` : ''}`)
    .join('\n')
    .slice(0, 3900);
  return ctx.send(msg(info(ctx, text, { title: `${title} — ${rows.length}`, emoji: E.shield })));
}
async function toggleBan(ctx, mode) {
  const g = acting(ctx.guild, PermissionFlagsBits.BanMembers);
  const as = { ...ctx, guild: g };
  const { ids, reason } = targetsOf(ctx, 5);
  if (!ids.length) return banList(ctx, 'Bannis');
  const out = { done: [], undone: [], failed: [], reason };
  for (const id of ids) {
    try {
      const banned = await ctx.guild.bans
        .fetch(id)
        .then(() => true)
        .catch(() => false);
      if (banned && mode !== 'on') {
        checkTarget(as, id, null, { bot: false });
        await g.members.unban(id, audit_('Débanni', ctx, reason));
        await warn(ctx.guild, id, 'ban', 'off');
        await log(ctx.guild, 'ban', {
          title: 'Sanction levée',
          tone: 'ok',
          by: ctx.user,
          lines: [pair('Cible', `<@${id}> \`${id}\``), pair('Type', 'BAN')],
        });
        out.undone.push(id);
      } else if (!banned && mode !== 'off') {
        const target = await member(g, id);
        checkTarget(as, id, target);
        await warn(ctx.guild, id, 'ban', 'on', { reason });
        await g.members.ban(id, { reason: audit_('Banni', ctx, reason) });
        record(ctx.gid, id, ctx.user.id, 'BAN', reason);
        await log(ctx.guild, 'ban', {
          title: 'Sanction posée',
          tone: 'alerte',
          by: ctx.user,
          lines: [pair('Cible', `<@${id}> \`${id}\``), pair('Type', 'BAN'), reason ? pair('Raison', reason) : null],
        });
        out.done.push(id);
      } else out.failed.push([id, banned ? 'déjà banni' : 'pas banni']);
    } catch (e) {
      out.failed.push([id, e.message]);
    }
  }
  audit(ctx.gid, ctx.user.id, `ban.${mode}`, ids.join(','), { reason });
  return ctx.send(msg(summary(ctx, 'Bannissement', out)));
}

// Blacklist
const isBl = (gid, id) => db.prepare("SELECT * FROM bl WHERE guild_id=? AND user_id=? AND kind='BL'").get(gid, id) ?? null;
async function toggleBl(ctx, mode) {
  const g = acting(ctx.guild, PermissionFlagsBits.BanMembers);
  const as = { ...ctx, guild: g };
  const { ids, reason } = targetsOf(ctx, 10);
  if (!ids.length) {
    const rows = db.prepare("SELECT user_id,reason FROM bl WHERE guild_id=? AND kind='BL' ORDER BY created_at DESC").all(ctx.gid);
    const text = rows
      .map((r) => `<@${r.user_id}> \`${r.user_id}\`${r.reason ? ` — ${r.reason}` : ''}`)
      .join('\n')
      .slice(0, 3900);
    return ctx.send(msg(info(ctx, text || 'Personne n’est blacklist ici.', { title: `Blacklist — ${rows.length}`, emoji: E.bl })));
  }
  const out = { done: [], undone: [], failed: [], reason };
  for (const id of ids) {
    try {
      const listed = isBl(ctx.gid, id);
      if (listed && mode !== 'on') {
        checkTarget(as, id, null, { bot: false });
        db.prepare("DELETE FROM bl WHERE guild_id=? AND user_id=? AND kind='BL'").run(ctx.gid, id);
        await g.members.unban(id, audit_('Déblacklist', ctx, reason)).catch(() => {});
        await warn(ctx.guild, id, 'bl', 'off');
        await log(ctx.guild, 'bl', {
          title: 'Sanction levée',
          tone: 'ok',
          by: ctx.user,
          lines: [pair('Cible', `<@${id}> \`${id}\``), pair('Type', 'BL')],
        });
        out.undone.push(id);
      } else if (!listed && mode !== 'off') {
        const target = await member(g, id);
        checkTarget(as, id, target);
        await warn(ctx.guild, id, 'bl', 'on', { reason });
        await g.members.ban(id, { reason: audit_('Blacklist', ctx, reason) });
        db.prepare('INSERT OR REPLACE INTO bl(guild_id,user_id,kind,created_at,reason,actor_id) VALUES(?,?,?,?,?,?)').run(
          ctx.gid,
          id,
          'BL',
          now(),
          reason || null,
          ctx.user.id,
        );
        record(ctx.gid, id, ctx.user.id, 'BL', reason);
        await log(ctx.guild, 'bl', {
          title: 'Sanction posée',
          tone: 'alerte',
          by: ctx.user,
          lines: [pair('Cible', `<@${id}> \`${id}\``), pair('Type', 'BL'), reason ? pair('Raison', reason) : null],
        });
        out.done.push(id);
      } else out.failed.push([id, listed ? 'déjà blacklist' : 'pas blacklist']);
    } catch (e) {
      out.failed.push([id, e.message]);
    }
  }
  audit(ctx.gid, ctx.user.id, `bl.${mode}`, ids.join(','), { reason });
  return ctx.send(msg(summary(ctx, 'Blacklist', out, ['Blacklist', 'Retiré'])));
}

// Tout débannir
async function unbanAll(ctx) {
  const g = acting(ctx.guild, PermissionFlagsBits.BanMembers);
  if (rank(ctx.gid, ctx.user.id, ctx.member) < LEVEL.SYS) throw new Error('Réservé au rang SYS et au-dessus.');
  cooldown(`unbanall:${ctx.gid}`, 24 * 3600e3);
  const bans = await g.bans.fetch();
  const keep = new Set([
    ...db
      .prepare("SELECT user_id FROM bl WHERE guild_id=? AND kind='BL'")
      .all(ctx.gid)
      .map((x) => x.user_id),
    ...db
      .prepare('SELECT user_id FROM wet_global')
      .all()
      .map((x) => x.user_id),
  ]);
  let done = 0;
  for (const b of bans.values()) {
    if (keep.has(b.user.id)) continue;
    if (
      await ctx.guild.members
        .unban(b.user.id, audit_('Débannissement général', ctx))
        .then(() => true)
        .catch(() => false)
    )
      done++;
    await sleep(250);
  }
  await log(ctx.guild, 'ban', {
    title: 'Débannissement général',
    tone: 'ok',
    by: ctx.user,
    lines: [pair('Débannis', `${done}/${bans.size}`), pair('Gardés', `${keep.size} (blacklist et wet)`)],
  });
  audit(ctx.gid, ctx.user.id, 'ban.all', null, { done });
  return ctx.send(
    msg(
      ok(ctx, `${plural(done, 'membre')} débanni${done > 1 ? 's' : ''}. Blacklist et wet restent bannis.`, {
        title: 'Débannissement général',
        emoji: E.shield,
      }),
    ),
  );
}

// Retirer le staff
async function derank(ctx) {
  const g = acting(ctx.guild, PermissionFlagsBits.ManageRoles);
  const as = { ...ctx, guild: g };
  const { ids, reason } = targetsOf(ctx, 1);
  if (!ids.length) throw new Error(SAY.idNeeded);
  const id = ids[0];
  const target = await member(g, id);
  checkTarget(as, id, target);
  const removable = new Set([
    ...staffRows(ctx.gid).map((x) => x.role_id),
    ...rankRows(ctx.gid)
      .map((x) => x.role_id)
      .filter(Boolean),
  ]);
  const roles = target ? [...target.roles.cache.values()].filter((r) => removable.has(r.id) && r.editable) : [];
  if (roles.length) await target.roles.remove(roles, audit_('Derank', ctx, reason));
  const had = rank(ctx.gid, id) >= LEVEL.OWNER;
  setRank(ctx.gid, id, null);
  if (!roles.length && !had) throw new Error('Cette personne n’a aucun rôle staff à retirer.');
  record(ctx.gid, id, ctx.user.id, 'DERANK', reason);
  await warn(ctx.guild, id, 'derank', 'on', { reason });
  await log(ctx.guild, 'wl', {
    title: 'Derank',
    tone: 'alerte',
    by: ctx.user,
    lines: [
      pair('Cible', `<@${id}> \`${id}\``),
      pair('Retiré', roles.map((r) => r.name).join(', ') || 'rang interne'),
      reason ? pair('Raison', reason) : null,
    ],
  });
  audit(ctx.gid, ctx.user.id, 'derank', id, { roles: roles.map((r) => r.id), reason });
  return ctx.send(
    msg(ok(ctx, `<@${id}> n’a plus de rôle staff.${reason ? `\n${pair('Raison', reason)}` : ''}`, { title: 'Derank', emoji: '📉' })),
  );
}

// Ban global
async function wet(ctx) {
  const raw = ctx.opt('identifiant') || '';
  const reason = (ctx.opt('raison') || '').trim();
  const ids = [...new Set(raw.split(/\s+/).map(idOf).filter(Boolean))];
  if (!ids.length) {
    const rows = db.prepare('SELECT user_id,level FROM wet_global ORDER BY created_at DESC').all();
    const visible = rows.filter((r) => r.level <= rank(ctx.gid, ctx.user.id, ctx.member));
    return ctx.send(
      msg(
        info(
          ctx,
          visible
            .map((r) => `<@${r.user_id}> \`${r.user_id}\``)
            .join('\n')
            .slice(0, 3900) || 'Personne n’est wet.',
          { title: `Wet global — ${visible.length}`, emoji: E.wet },
        ),
        { private: true },
      ),
    );
  }
  if (ids.length > 2) throw new Error('2 personnes au maximum.');
  cooldown(`wet:${ctx.user.id}`, 15_000);
  await ctx.defer();
  const guilds = [...new Map([...bots.main.guilds.cache, ...bots.guard.guilds.cache]).values()]
    .filter((x) => accepted(x.id, x.client.user.id))
    .map((x) => acting(x, PermissionFlagsBits.BanMembers));
  const out = { done: [], undone: [], failed: [], reason };
  for (const id of ids) {
    try {
      const row = db.prepare('SELECT * FROM wet_global WHERE user_id=?').get(id);
      const target = await member(ctx.guild, id);
      checkTarget(ctx, id, target, { bot: false });
      if (!row) await warn(ctx.guild, id, 'wet', 'on', { reason });
      let n = 0;
      for (const g of guilds) {
        const how = row ? g.members.unban(id, audit_('Wet levé', ctx, reason)) : g.members.ban(id, { reason: audit_('Wet', ctx, reason) });
        if (await how.then(() => true).catch(() => false)) n++;
      }
      if (row) {
        db.prepare('DELETE FROM wet_global WHERE user_id=?').run(id);
        await warn(ctx.guild, id, 'wet', 'off');
        out.undone.push(id);
      } else {
        db.prepare('INSERT INTO wet_global(user_id,reason,actor_id,origin_guild,level,created_at) VALUES(?,?,?,?,?,?)').run(
          id,
          reason || null,
          ctx.user.id,
          ctx.gid,
          Math.max(0, rank(ctx.gid, id, target)),
          now(),
        );
        record(ctx.gid, id, ctx.user.id, 'WET', reason);
        out.done.push(id);
      }
      await log(ctx.guild, 'wet', {
        title: row ? 'Sanction levée' : 'Sanction posée',
        tone: row ? 'ok' : 'alerte',
        by: ctx.user,
        lines: [
          pair('Cible', `<@${id}> \`${id}\``),
          pair('Type', 'WET'),
          pair('Serveurs', `${n}/${guilds.length}`),
          reason ? pair('Raison', reason) : null,
        ],
      });
    } catch (e) {
      out.failed.push([id, e.message]);
    }
  }
  audit(ctx.gid, ctx.user.id, 'wet', ids.join(','), { reason });
  const embed = summary(ctx, 'Wet global', out, ['Wet', 'Retiré']);
  embed.setDescription(`${embed.data.description}\n${small(`Sur ${plural(guilds.length, 'serveur')}.`)}`);
  return ctx.send(msg(embed));
}
async function wetInfo(ctx) {
  const id = idOf(ctx.opt('identifiant'));
  if (!id) throw new Error(SAY.idNeeded);
  const row = db.prepare('SELECT * FROM wet_global WHERE user_id=?').get(id);
  if (!row) return ctx.send(msg(info(ctx, 'Rien pour ce compte.', { title: 'Wet global', emoji: E.wet }), { private: true }));
  if (!isCreator(ctx.user.id) && row.level > rank(ctx.gid, ctx.user.id, ctx.member))
    throw new Error('Ce wet concerne un rang au-dessus du tien.');
  const embed = await sheet(ctx, id, {
    title: 'Wet global',
    reason: row.reason,
    by: row.actor_id,
    at: row.created_at,
    scope: 'Banni sur tous les serveurs Dream. Re-banni automatiquement s’il revient.',
  });
  return ctx.send(msg(embed, { private: true }));
}

// Infos sanctions
function shielded(ctx, id) {
  if (!isCreator(ctx.user.id) && rank(ctx.gid, id) > rank(ctx.gid, ctx.user.id, ctx.member))
    throw new Error('Ces informations concernent un rang au-dessus du tien.');
}
async function blInfo(ctx) {
  const id = idOf(ctx.args[0]) || ctx.repliedTo;
  if (!id) throw new Error(SAY.idNeeded);
  shielded(ctx, id);
  const row = isBl(ctx.gid, id);
  const ban = await ctx.guild.bans.fetch(id).catch(() => null);
  if (!row && !ban) return ctx.send(msg(info(ctx, 'Rien pour ce compte.', { title: 'Blacklist', emoji: E.bl })));
  return ctx.send(
    msg(
      await sheet(ctx, id, {
        title: 'Blacklist',
        reason: row?.reason || ban?.reason,
        by: row?.actor_id,
        at: row?.created_at,
        scope: row
          ? `Sur ce serveur. Re-banni automatiquement s’il revient.${ban ? '' : ' Il n’est pas banni en ce moment.'}`
          : 'Banni, mais pas dans la blacklist du bot.',
      }),
    ),
  );
}
async function banInfo(ctx) {
  const id = idOf(ctx.args[0]) || ctx.repliedTo;
  if (!id) throw new Error(SAY.idNeeded);
  shielded(ctx, id);
  const ban = await ctx.guild.bans.fetch(id).catch(() => null);
  if (!ban) return ctx.send(msg(info(ctx, 'Rien pour ce compte.', { title: 'Bannissement', emoji: E.ban })));
  const last = db
    .prepare("SELECT * FROM sanctions WHERE guild_id=? AND target_id=? AND type IN ('BAN','BL','WET') ORDER BY created_at DESC")
    .get(ctx.gid, id);
  return ctx.send(
    msg(
      await sheet(ctx, id, {
        title: 'Bannissement',
        reason: last?.reason || ban.reason,
        by: last?.actor_id,
        at: last?.created_at,
        scope: `Sur **${ctx.guild.name}** uniquement.`,
      }),
    ),
  );
}

// Verrouiller salon
function botCanLock(channel) {
  if (!channel.permissionsFor(channel.guild.members.me)?.has(PermissionFlagsBits.ManageRoles))
    throw new Error('Je n’ai pas le droit de modifier les permissions de ce salon.');
}
async function lock(ctx, locked) {
  const channel = acting(ctx.guild, PermissionFlagsBits.ManageRoles).channels.cache.get(ctx.channel.id) ?? ctx.channel;
  botCanLock(channel);
  await channel.permissionOverwrites.edit(
    ctx.guild.roles.everyone,
    { SendMessages: locked ? false : null },
    `${locked ? 'Lock' : 'Unlock'} par ${ctx.user.tag}`,
  );
  if (locked)
    db.prepare("INSERT OR REPLACE INTO locks(guild_id,channel_id,created_at,source) VALUES(?,?,?,'lock')").run(
      ctx.gid,
      ctx.channel.id,
      now(),
    );
  else db.prepare('DELETE FROM locks WHERE guild_id=? AND channel_id=?').run(ctx.gid, ctx.channel.id);
  await log(ctx.guild, 'salon', {
    title: locked ? 'Salon verrouillé' : 'Salon déverrouillé',
    tone: locked ? 'alerte' : 'ok',
    by: ctx.user,
    lines: [pair('Salon', `<#${ctx.channel.id}>`)],
  });
  return ctx.channel.send(msg(view(ctx, { text: locked ? `${E.lock} Salon verrouillé.` : `${E.unlock} Salon déverrouillé.`, by: false })));
}
const WRITABLE = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];
export async function lockAll(guild, actor, locked, source = 'all') {
  const everyone = guild.roles.everyone;
  let done = 0;
  let failed = 0;
  if (!locked) {
    for (const r of db.prepare('SELECT channel_id FROM locks WHERE guild_id=? AND source=?').all(guild.id, source)) {
      const ch = guild.channels.cache.get(r.channel_id);
      if (
        ch &&
        (await ch.permissionOverwrites
          .edit(everyone, { SendMessages: null })
          .then(() => true)
          .catch(() => false))
      )
        done++;
      else if (ch) failed++;
      await sleep(120);
    }
    db.prepare('DELETE FROM locks WHERE guild_id=? AND source=?').run(guild.id, source);
    return { done, failed };
  }
  for (const ch of guild.channels.cache.values()) {
    if (!WRITABLE.includes(ch.type)) continue;
    if (ch.permissionOverwrites.cache.get(everyone.id)?.deny.has(PermissionFlagsBits.SendMessages)) continue;
    if (
      await ch.permissionOverwrites
        .edit(everyone, { SendMessages: false }, `${source} par ${actor}`)
        .then(() => true)
        .catch(() => false)
    ) {
      db.prepare('INSERT OR REPLACE INTO locks(guild_id,channel_id,created_at,source) VALUES(?,?,?,?)').run(guild.id, ch.id, now(), source);
      done++;
    } else failed++;
    await sleep(120);
  }
  return { done, failed };
}
async function lockAllCmd(ctx) {
  const unlocking = db.prepare("SELECT 1 FROM locks WHERE guild_id=? AND source='all'").get(ctx.gid) !== undefined;
  const status = await ctx.send(
    msg(info(ctx, unlocking ? 'Déverrouillage en cours…' : 'Verrouillage en cours…', { emoji: E.wait, by: false })),
  );
  const { done, failed } = await lockAll(acting(ctx.guild, PermissionFlagsBits.ManageRoles), ctx.user.tag, !unlocking);
  await log(ctx.guild, 'salon', {
    title: unlocking ? 'Serveur déverrouillé' : 'Serveur verrouillé',
    tone: unlocking ? 'ok' : 'alerte',
    by: ctx.user,
    lines: [pair('Salons', done), failed ? pair('Échecs', failed) : null],
  });
  audit(ctx.gid, ctx.user.id, unlocking ? 'unlockall' : 'lockall', null, { done, failed });
  const text = unlocking
    ? `${E.unlock} **${done}** salon(s) déverrouillé(s).`
    : `${E.lock} **${done}** salon(s) verrouillé(s). Relance \`&l0all\` pour tout rouvrir.`;
  const embed = info(
    ctx,
    `${text}${failed ? `\n${E.warn} ${failed} échec(s).` : ''}${!done && !failed ? '\n_Aucun salon concerné._' : ''}`,
    { emoji: '' },
  );
  return status?.edit ? status.edit(msg(embed)) : ctx.send(msg(embed));
}

// Effacer messages
const CLEAR_WINDOW = 67 * 60_000;
async function clear(ctx) {
  const raw = ctx.args[0];
  const count = raw ? Number(raw) : null;
  if (raw && (!Number.isInteger(count) || count < 1)) throw new Error('Usage : `&clear` (67 dernières minutes) ou `&clear <nombre>`.');
  const channel = acting(ctx.guild, PermissionFlagsBits.ManageMessages).channels.cache.get(ctx.channel.id) ?? ctx.channel;
  if (!channel.permissionsFor(channel.guild.members.me)?.has(PermissionFlagsBits.ManageMessages))
    throw new Error('Il me manque « Gérer les messages » ici.');
  const wanted = Math.min(count ?? 1000, 1000);
  const since = count ? 0 : now() - CLEAR_WINDOW;
  const mode = count ? `${wanted} message(s) demandé(s)` : '67 dernières minutes';
  await ctx.message?.delete().catch(() => {});
  const captured = [];
  let total = 0;
  while (total < wanted) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, wanted - total) }).catch(() => null);
    if (!batch?.size) break;
    const pick = batch.filter((m) => m.createdTimestamp >= since && !m.pinned);
    if (!pick.size) break;
    const gone = await channel.bulkDelete(pick, true).catch(() => null);
    if (!gone?.size) break;
    captured.push(...pick.filter((m) => gone.has(m.id)).values());
    total += gone.size;
    if (pick.size < batch.size) break;
  }
  if (total) {
    const sorted = captured.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const html = transcriptHtml(ctx.channel, sorted, {
      title: `Messages supprimés — ${ctx.channel.name}`,
      subtitle: `Supprimés par ${ctx.user.tag} · ${mode}`,
    });
    await log(ctx.guild, 'clear', {
      title: 'Messages supprimés',
      tone: 'info',
      by: ctx.user,
      lines: [pair('Salon', `<#${ctx.channel.id}>`), pair('Nombre', total), pair('Mode', mode)],
      files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `clear-${ctx.channel.name}.html` })],
    });
    audit(ctx.gid, ctx.user.id, 'clear', ctx.channel.id, { total });
  }
  const done = await ctx.channel.send(
    msg(view(ctx, { text: `${E.clean} ${plural(total, 'message')} supprimé${total > 1 ? 's' : ''}.`, by: false })),
  );
  setTimeout(() => done.delete().catch(() => {}), 5000);
}

// Mots interdits
export const badwords = (gid) =>
  db
    .prepare('SELECT word FROM badwords WHERE guild_id=?')
    .all(gid)
    .map((x) => x.word);
const normalize = (t) =>
  String(t || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
export function findBadword(gid, content) {
  if (cfg(gid).badwordsOff) return null;
  const text = normalize(content);
  return (
    badwords(gid).find((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i').test(text)) ?? null
  );
}
async function badword(ctx) {
  const arg = ctx.rest.trim();
  if (arg.toLowerCase() === 'list') {
    const words = badwords(ctx.gid);
    return ctx.send(
      msg(
        info(ctx, words.length ? words.map((w) => `\`${w}\``).join(' · ') : 'Aucun mot.', {
          title: `Mots interdits — ${words.length} · filtre ${cfg(ctx.gid).badwordsOff ? 'coupé' : 'actif'}`,
          emoji: E.word,
        }),
      ),
    );
  }
  if (!arg) {
    const off = !cfg(ctx.gid).badwordsOff;
    setCfg(ctx.gid, (c) => (c.badwordsOff = off));
    return ctx.send(msg(ok(ctx, off ? 'Filtre coupé.' : 'Filtre activé.', { title: 'Modération', emoji: E.word })));
  }
  if (/\s/.test(arg)) throw new Error('Un seul mot à la fois.');
  const word = normalize(arg).replace(/[^a-z0-9'-]/g, '');
  if (!word) throw new Error('Ce mot n’a aucune lettre.');
  const had = db.prepare('SELECT 1 FROM badwords WHERE guild_id=? AND word=?').get(ctx.gid, word);
  if (had) db.prepare('DELETE FROM badwords WHERE guild_id=? AND word=?').run(ctx.gid, word);
  else db.prepare('INSERT INTO badwords(guild_id,word,created_at) VALUES(?,?,?)').run(ctx.gid, word, now());
  return ctx.send(msg(ok(ctx, `\`${word}\` ${had ? 'retiré' : 'ajouté'}.`, { title: 'Modération', emoji: E.word })));
}
export async function enforceBadword(message, exempt) {
  if (!message.guild || !message.content || exempt) return false;
  const hit = findBadword(message.guild.id, message.content);
  if (!hit) return false;
  if (
    !(await message
      .delete()
      .then(() => true)
      .catch(() => false))
  )
    return false;
  await log(message.guild, 'badword', {
    title: 'Mot interdit',
    tone: 'alerte',
    by: message.author,
    lines: [pair('Salon', `<#${message.channelId}>`), pair('Mot', `\`${hit}\``)],
  });
  const warnMsg = await message.channel
    .send(
      msg(view({ gid: message.guild.id }, { text: `${E.word} <@${message.author.id}>, ce mot est interdit ici.`, by: false }), {
        mentions: { users: [message.author.id] },
      }),
    )
    .catch(() => null);
  if (warnMsg) setTimeout(() => warnMsg.delete().catch(() => {}), 5000);
  return true;
}

// Salons réservés
export function reservedFor(gid, channelId) {
  const row = db.prepare('SELECT min_level,role_id FROM protected_channels WHERE guild_id=? AND channel_id=?').get(gid, channelId);
  if (!row) return null;
  if (row.role_id) {
    const s = staffOf(gid, row.role_id);
    return s ? { level: s.level, label: `<@&${row.role_id}>` } : { level: 1, label: 'le staff' };
  }
  return { level: row.min_level, label: rankName(gid, row.min_level) };
}
async function protect(ctx) {
  const channel = ctx.opt('salon');
  if (!channel) {
    const rows = db.prepare('SELECT channel_id FROM protected_channels WHERE guild_id=?').all(ctx.gid);
    const lines = rows.map((r) => dot(`<#${r.channel_id}>`, reservedFor(ctx.gid, r.channel_id)?.label));
    return ctx.send(
      msg(info(ctx, lines.join('\n') || 'Aucun salon réservé.', { title: 'Salons réservés', emoji: E.lock }), { private: true }),
    );
  }
  const role = ctx.opt('role');
  const rang = ctx.opt('rang');
  if (!role && !rang) {
    db.prepare('DELETE FROM protected_channels WHERE guild_id=? AND channel_id=?').run(ctx.gid, channel.id);
    await log(ctx.guild, 'salon', { title: 'Salon libéré', tone: 'ok', by: ctx.user, lines: [pair('Salon', `<#${channel.id}>`)] });
    return ctx.send(
      msg(ok(ctx, `<#${channel.id}> est de nouveau ouvert à tous.`, { title: 'Salons réservés', emoji: E.unlock }), { private: true }),
    );
  }
  const level = role ? staffOf(ctx.gid, role.id)?.level : LEVEL[rang];
  if (!level) throw new Error('Choisis un rôle du staff ou un rang.');
  if (!isCreator(ctx.user.id) && level > rank(ctx.gid, ctx.user.id, ctx.member))
    throw new Error('Tu ne peux pas réserver au-dessus de ton rang.');
  db.prepare(
    `INSERT INTO protected_channels(guild_id,channel_id,min_level,role_id,created_at) VALUES(?,?,?,?,?)
     ON CONFLICT(guild_id,channel_id) DO UPDATE SET min_level=excluded.min_level,role_id=excluded.role_id`,
  ).run(ctx.gid, channel.id, role ? 0 : level, role?.id ?? null, now());
  const label = reservedFor(ctx.gid, channel.id).label;
  await log(ctx.guild, 'salon', {
    title: 'Salon réservé',
    tone: 'info',
    by: ctx.user,
    lines: [pair('Salon', `<#${channel.id}>`), pair('À partir de', label)],
  });
  return ctx.send(
    msg(ok(ctx, `<#${channel.id}> est réservé à ${label} et au-dessus.`, { title: 'Salons réservés', emoji: E.lock }), { private: true }),
  );
}
export async function enforceReserved(message) {
  const r = message.guild ? reservedFor(message.guild.id, message.channelId) : null;
  if (!r || rank(message.guild.id, message.author.id, message.member) >= r.level) return false;
  await message.delete().catch(() => {});
  if (burst(`reserved:${message.author.id}`, 1, 10_000)) return true;
  const text = `${E.lock} <@${message.author.id}>, ce salon est réservé à ${r.label} et au-dessus.`;
  const note = await message.channel
    .send(msg(view({ gid: message.guild.id }, { text, by: false }), { mentions: { users: [message.author.id] } }))
    .catch(() => null);
  if (note) setTimeout(() => note.delete().catch(() => {}), 5000);
  return true;
}

// Rôle en masse
const MASS_MAX = 250;
async function massRole(ctx) {
  const g = acting(ctx.guild, PermissionFlagsBits.ManageRoles);
  const as = { ...ctx, guild: g };
  cooldown(`mass:${ctx.user.id}`, 60_000);
  const role = g.roles.cache.get(idOf(ctx.args[0]));
  if (!role) throw new Error('Usage : `+massiveroleadd @rôle [@filtre]`.');
  checkRole(as, role);
  const filter = ctx.args[1] ? g.roles.cache.get(idOf(ctx.args[1])) : null;
  if (ctx.args[1] && !filter) throw new Error('Rôle filtre introuvable.');
  const all = await g.members.fetch().catch(() => g.members.cache);
  const pool = [...all.values()].filter((m) => !m.user.bot && !m.roles.cache.has(role.id) && (!filter || m.roles.cache.has(filter.id)));
  if (!pool.length) throw new Error('Personne à qui ajouter ce rôle.');
  if (pool.length > MASS_MAX) throw new Error(`${pool.length} membres concernés : la limite est de ${MASS_MAX}. Ajoute un filtre.`);
  const id = `${ctx.gid}-${now()}`;
  db.prepare('INSERT INTO mass_ops(id,guild_id,actor_id,role_id,filter_id,targets,done,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(
    id,
    ctx.gid,
    ctx.user.id,
    role.id,
    filter?.id ?? null,
    json(pool.map((m) => m.id)),
    '[]',
    'pending',
    now(),
  );
  const embed = view(ctx, {
    title: 'Rôle en masse',
    emoji: E.users,
    lines: [
      pair('Rôle', `${role}`),
      pair('Membres', pool.length),
      filter ? pair('Filtre', `${filter}`) : null,
      '',
      'Confirme pour lancer. Tu pourras annuler ensuite.',
    ],
  });
  return ctx.send(
    msg(embed, { components: [row(button(`mod:mass:run:${id}`, 'Confirmer', 'rouge'), button(`mod:mass:drop:${id}`, 'Annuler'))] }),
  );
}
async function massButton(i, ctx, [action, id]) {
  const g = acting(ctx.guild, PermissionFlagsBits.ManageRoles);
  const op = db.prepare('SELECT * FROM mass_ops WHERE id=? AND guild_id=?').get(id, ctx.gid);
  if (!op) throw new Error(SAY.expired);
  if (op.actor_id !== ctx.user.id && !isCreator(ctx.user.id)) throw new Error(SAY.notMine);
  const role = g.roles.cache.get(op.role_id);
  if (!role) throw new Error('Ce rôle n’existe plus.');
  if (action === 'drop' && op.status === 'pending') {
    db.prepare("UPDATE mass_ops SET status='cancelled' WHERE id=?").run(id);
    return i.update(msg(info(ctx, 'Annulé, rien n’a changé.', { title: 'Rôle en masse', emoji: E.users }), { components: [] }));
  }
  if (action === 'run' && op.status === 'pending') {
    db.prepare("UPDATE mass_ops SET status='running' WHERE id=?").run(id);
    await i.update(
      msg(info(ctx, 'C’est parti, ça peut prendre un moment…', { title: 'Rôle en masse', emoji: E.wait }), { components: [] }),
    );
    const done = [];
    for (const uid of parse(op.targets, [])) {
      const m = await member(g, uid);
      if (
        m &&
        (await m.roles
          .add(role, `Rôle en masse par ${ctx.user.tag}`)
          .then(() => true)
          .catch(() => false))
      )
        done.push(uid);
      await sleep(250);
    }
    db.prepare("UPDATE mass_ops SET status='done',done=? WHERE id=?").run(json(done), id);
    await log(ctx.guild, 'role', {
      title: 'Rôle en masse',
      tone: 'info',
      by: ctx.user,
      lines: [pair('Rôle', `${role}`), pair('Ajouté à', `${done.length}/${parse(op.targets, []).length}`)],
    });
    audit(ctx.gid, ctx.user.id, 'mass.run', role.id, { count: done.length });
    return i.editReply(
      msg(ok(ctx, `${role} ajouté à **${done.length}** membre(s).`, { title: 'Rôle en masse', emoji: E.users }), {
        components: [row(button(`mod:mass:undo:${id}`, 'Annuler l’ajout', 'gris', E.back))],
      }),
    );
  }
  if (action === 'undo' && op.status === 'done') {
    db.prepare("UPDATE mass_ops SET status='undoing' WHERE id=?").run(id);
    await i.update(msg(info(ctx, 'Retrait en cours…', { title: 'Rôle en masse', emoji: E.wait }), { components: [] }));
    const done = parse(op.done, []);
    for (const uid of done) {
      const m = await member(g, uid);
      if (m) await m.roles.remove(role, `Rôle en masse annulé par ${ctx.user.tag}`).catch(() => {});
      await sleep(250);
    }
    db.prepare("UPDATE mass_ops SET status='undone' WHERE id=?").run(id);
    await log(ctx.guild, 'role', {
      title: 'Rôle en masse annulé',
      tone: 'ok',
      by: ctx.user,
      lines: [pair('Rôle', `${role}`), pair('Retiré à', done.length)],
    });
    return i.editReply(
      msg(ok(ctx, `${role} retiré à **${done.length}** membre(s).`, { title: 'Rôle en masse', emoji: E.users }), { components: [] }),
    );
  }
  throw new Error('Cette opération est déjà traitée.');
}

// Laisse
async function leash(ctx, on) {
  const g = acting(ctx.guild, PermissionFlagsBits.ManageNicknames);
  const as = { ...ctx, guild: g };
  const user = ctx.opt('membre');
  const target = user ? await member(g, user.id) : null;
  if (!target) throw new Error('Membre introuvable sur ce serveur.');
  const row_ = db.prepare('SELECT * FROM leashes WHERE guild_id=? AND user_id=?').get(ctx.gid, target.id);
  if (!on) {
    if (!row_) throw new Error(`${target} n’est pas en laisse.`);
    if (row_.holder_id !== ctx.user.id) checkTarget(as, row_.holder_id, null, { bot: false });
    db.prepare('DELETE FROM leashes WHERE guild_id=? AND user_id=?').run(ctx.gid, target.id);
    await target.setNickname(row_.original ?? null, `Laisse retirée par ${ctx.user.tag}`).catch(() => {});
    await log(ctx.guild, 'dog', { title: 'Laisse retirée', tone: 'ok', by: ctx.user, lines: [pair('Cible', `<@${target.id}>`)] });
    return ctx.send(msg(ok(ctx, `${target} n’est plus en laisse, pseudo restauré.`, { title: 'Laisse', emoji: E.dog }), { private: true }));
  }
  if (row_) throw new Error(`${target} est déjà en laisse.`);
  checkTarget(as, target.id, target);
  if (db.prepare('SELECT 1 FROM leashes WHERE guild_id=? AND holder_id=?').get(ctx.gid, ctx.user.id))
    throw new Error('Tu as déjà quelqu’un en laisse. Libère-le d’abord avec `/dog-del`.');
  const owner = [...(ctx.member?.displayName || ctx.user.username)].slice(0, 12).join('');
  const room = 32 - ' (🐶 de )'.length - owner.length;
  const nickname = `${[...target.displayName].slice(0, room).join('')} (🐶 de ${owner})`;
  await target.setNickname(nickname, `Laisse posée par ${ctx.user.tag}`);
  db.prepare('INSERT INTO leashes(guild_id,user_id,holder_id,nickname,original,created_at) VALUES(?,?,?,?,?,?)').run(
    ctx.gid,
    target.id,
    ctx.user.id,
    nickname,
    target.nickname ?? null,
    now(),
  );
  await log(ctx.guild, 'dog', {
    title: 'Laisse posée',
    tone: 'info',
    by: ctx.user,
    lines: [pair('Cible', `<@${target.id}>`), pair('Pseudo', `\`${nickname}\``)],
  });
  return ctx.send(
    msg(ok(ctx, `${target} est maintenant le chien de ${ctx.user}. Il te suivra en vocal.`, { title: 'Laisse', emoji: E.dog }), {
      private: true,
    }),
  );
}

// Donner un rôle
async function giveRole(ctx, add) {
  const g = acting(ctx.guild, PermissionFlagsBits.ManageRoles);
  const as = { ...ctx, guild: g };
  const user = ctx.opt('membre');
  const role = ctx.opt('role');
  const target = user ? await member(g, user.id) : null;
  if (!target || !role) throw new Error('Choisis un membre et un rôle.');
  checkRole(as, role);
  if (target.id !== ctx.user.id) checkTarget(as, target.id, target);
  if (add === target.roles.cache.has(role.id)) throw new Error(add ? `${target} a déjà ce rôle.` : `${target} n’a pas ce rôle.`);
  if (add) await target.roles.add(role, `/addrole par ${ctx.user.tag}`);
  else await target.roles.remove(role, `/delrole par ${ctx.user.tag}`);
  await log(ctx.guild, 'role', {
    title: add ? 'Rôle donné' : 'Rôle retiré',
    tone: add ? 'info' : 'alerte',
    by: ctx.user,
    lines: [pair('Membre', `<@${target.id}>`), pair('Rôle', `${role}`)],
  });
  audit(ctx.gid, ctx.user.id, add ? 'role.add' : 'role.del', target.id, { role: role.id });
  return ctx.send(msg(ok(ctx, `${role} ${add ? 'donné à' : 'retiré à'} ${target}.`, { title: 'Rôles', emoji: E.role })));
}

// Verrouillage d'urgence
export async function emergency(guild, actorId, on, reason) {
  const result = await lockAll(acting(guild, PermissionFlagsBits.ManageRoles), actorId, on, 'urgence');
  db.prepare(
    `INSERT INTO emergency(guild_id,active,actor_id,reason,created_at) VALUES(?,?,?,?,?)
     ON CONFLICT(guild_id) DO UPDATE SET active=excluded.active,actor_id=excluded.actor_id,reason=excluded.reason,created_at=excluded.created_at`,
  ).run(guild.id, on ? 1 : 0, String(actorId), reason || null, now());
  audit(guild.id, actorId, on ? 'urgence.on' : 'urgence.off', null, { reason });
  await log(guild, 'sante', {
    title: on ? 'Verrouillage d’urgence' : 'Urgence levée',
    tone: on ? 'alerte' : 'ok',
    lines: [
      pair('Salons', result.done),
      reason ? pair('Raison', reason) : null,
      on ? 'Seuls SYS et SYS+ peuvent encore utiliser les commandes.' : null,
      /^\d+$/.test(actorId) ? pair('Par', `<@${actorId}>`) : null,
    ],
  });
  return result;
}
async function urgence(ctx) {
  const off = /^off$/i.test(ctx.args[0] || '');
  if (rank(ctx.gid, ctx.user.id, ctx.member) < LEVEL.SYS) throw new Error('Réservé au rang SYS et au-dessus.');
  const { done } = await emergency(ctx.guild, ctx.user.id, !off, off ? null : ctx.rest || 'Déclenché à la main');
  return ctx.send(
    msg(
      off
        ? ok(ctx, `Urgence levée, **${done}** salon(s) rouverts.`, { title: 'Urgence', emoji: E.unlock })
        : view(ctx, {
            title: 'Urgence',
            emoji: E.alarm,
            text: `**${done}** salon(s) verrouillé(s). Seuls SYS et SYS+ peuvent encore agir.\n\`=urgence off\` pour lever.`,
          }),
    ),
  );
}

// Owners du bot
async function ownerCmd(ctx) {
  const id = idOf(ctx.args[0]);
  if (!id) {
    return ctx.send(
      msg(
        info(
          ctx,
          creators()
            .map((x) => `<@${x}>`)
            .join('\n') || 'Aucun.',
          { title: 'Owners du bot', emoji: E.crown },
        ),
      ),
    );
  }
  const added = toggleCreator(id);
  audit(ctx.gid, ctx.user.id, added ? 'owner.add' : 'owner.del', id);
  return ctx.send(
    msg(
      ok(ctx, `<@${id}> ${added ? 'est maintenant owner du bot' : 'n’est plus owner du bot'}.`, { title: 'Owners du bot', emoji: E.crown }),
    ),
  );
}

// Table des commandes
const user = (name, description) => ({ type: 'user', name, description, required: true });
const role = (name, description) => ({ type: 'role', name, description, required: true });
export const commands = [
  { name: '+ban', bot: 'main', section: 'sanctions', help: 'Bannit / débannit', run: (c) => toggleBan(c, 'toggle') },
  { name: '+unban', bot: 'main', section: 'sanctions', help: 'Débannit', run: (c) => toggleBan(c, 'off') },
  { name: '+unbanall', bot: 'main', section: 'sanctions', help: 'Débannit tout', run: unbanAll },
  { name: '&bl', bot: 'main', section: 'sanctions', help: 'Blacklist (seul : liste)', run: (c) => toggleBl(c, 'toggle') },
  { name: '&unbl', bot: 'main', section: 'sanctions', help: 'Retire de la blacklist', run: (c) => toggleBl(c, 'off') },
  { name: '&blinfo', bot: 'main', section: 'sanctions', help: 'Détail blacklist', run: blInfo },
  { name: '-baninfo', bot: 'main', section: 'sanctions', help: 'Détail ban', run: banInfo },
  { name: '&derank', bot: 'main', section: 'sanctions', help: 'Retire les rôles staff', run: derank },
  {
    name: '/wet',
    bot: 'main',
    section: 'sanctions',
    help: 'Ban global',
    slash: {
      description: 'Bannir partout (ou lever)',
      options: [
        { type: 'string', name: 'identifiant', description: 'Un ou deux identifiants' },
        { type: 'string', name: 'raison', description: 'Pourquoi' },
      ],
    },
    run: wet,
  },
  {
    name: '/wet-info',
    bot: 'main',
    section: 'sanctions',
    help: 'Détail wet',
    slash: { description: 'Pourquoi il est wet', options: [{ type: 'string', name: 'identifiant', description: 'Qui', required: true }] },
    run: wetInfo,
  },
  { name: '&lock', aliases: ['+lock'], bot: 'main', section: 'salons', help: 'Verrouille ce salon', run: (c) => lock(c, true) },
  { name: '&unlock', aliases: ['+unlock'], bot: 'main', section: 'salons', help: 'Déverrouille ce salon', run: (c) => lock(c, false) },
  { name: '&l0all', aliases: ['&lockall', '&unlockall'], bot: 'main', section: 'salons', help: 'Tout le serveur', run: lockAllCmd },
  { name: '&clear', bot: 'main', section: 'salons', help: 'Efface `[n]`', discord: 'ManageMessages', run: clear },
  { name: '+badword', bot: 'main', section: 'salons', help: 'Mots interdits', run: badword },
  {
    name: '/protect',
    bot: 'main',
    section: 'salons',
    help: 'Salons réservés',
    slash: {
      description: 'Réserver un salon à un rang',
      options: [
        { type: 'channel', name: 'salon', description: 'Le salon (vide : la liste)' },
        { type: 'role', name: 'role', description: 'À partir de ce rôle staff' },
        { type: 'string', name: 'rang', description: 'Ou à partir de ce rang', choices: ['OWNER', 'SYS', 'SYS+'] },
      ],
    },
    run: protect,
  },
  { name: '+massiveroleadd', bot: 'guard', section: 'acces', help: 'Rôle en masse', run: massRole },
  {
    name: '/addrole',
    bot: 'main',
    section: 'acces',
    help: 'Donne un rôle',
    slash: { description: 'Donner un rôle', options: [user('membre', 'Qui'), role('role', 'Quel rôle')] },
    run: (c) => giveRole(c, true),
  },
  {
    name: '/delrole',
    bot: 'main',
    section: 'acces',
    help: 'Retire un rôle',
    slash: { description: 'Retirer un rôle', options: [user('membre', 'Qui'), role('role', 'Quel rôle')] },
    run: (c) => giveRole(c, false),
  },
  {
    name: '/dog-add',
    bot: 'main',
    section: 'fun',
    help: 'Mettre en laisse',
    slash: { description: 'Mettre en laisse', options: [user('membre', 'Qui')] },
    run: (c) => leash(c, true),
  },
  {
    name: '/dog-del',
    bot: 'main',
    section: 'fun',
    help: 'Retirer la laisse',
    slash: { description: 'Retirer la laisse', options: [user('membre', 'Qui')] },
    run: (c) => leash(c, false),
  },
  { name: '=urgence', bot: 'guard', section: 'serveur', help: 'Verrouillage d’urgence', run: urgence },
  { name: '.owner', bot: 'guard', section: null, help: null, creatorOnly: 'env', run: ownerCmd },
];
export const components = { mod: (i, ctx, [kind, ...rest]) => (kind === 'mass' ? massButton(i, ctx, rest) : null) };

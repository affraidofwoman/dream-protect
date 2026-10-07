import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { audit, cfg, cooldown, db, idOf, now, plural, setCfg } from './base.js';
import { acting, bots } from './bots.js';
import { allowed, checkTarget, isCreator, rank } from './droits.js';
import { E, SAY, button, dot, info, msg, ok, pair, pickChannel, row, view } from './ui.js';

const member = (guild, id) => guild.members.fetch(id).catch(() => null);
const canConnect = { Connect: true, ViewChannel: true };

// Mon vocal
const voiceHome = (ctx) => {
  const id = ctx.member?.voice?.channelId;
  return id ? acting(ctx.guild, PermissionFlagsBits.ManageChannels).channels.cache.get(id) : null;
};
const mover = (guild) => acting(guild, PermissionFlagsBits.MoveMembers);
export const voiceOf = (channelId) => db.prepare('SELECT * FROM voices WHERE channel_id=?').get(channelId) ?? null;
const isPrivate = (channel) => channel.permissionOverwrites.cache.get(channel.guild.id)?.deny.has(PermissionFlagsBits.Connect) ?? false;

// Viser sans bloquer
function outranks(ctx, targetId, target = null) {
  try {
    checkTarget(ctx, targetId, target, { bot: false });
    return true;
  } catch {
    return false;
  }
}
const consented = (gid, targetId, actorId) =>
  db.prepare('SELECT 1 FROM move_consent WHERE guild_id=? AND owner_id=? AND allowed_id=?').get(gid, targetId, actorId) !== undefined;
const targetOf = (ctx) => idOf(ctx.args[0]) || ctx.repliedTo;

// Vocal privé
async function pvCmd(ctx) {
  const vc = voiceHome(ctx);
  if (!vc) throw new Error(SAY.noVoice);
  const rec = voiceOf(vc.id);
  if (rec && rec.owner_id !== ctx.user.id && !outranks(ctx, rec.owner_id)) throw new Error('Ce vocal appartient à quelqu’un de ton rang ou au-dessus.');
  const wasPrivate = isPrivate(vc);
  await vc.permissionOverwrites.edit(ctx.gid, { Connect: wasPrivate ? null : false }, `=pv par ${ctx.user.tag}`);
  if (!wasPrivate) {
    await vc.permissionOverwrites.edit(ctx.user.id, canConnect);
    for (const m of vc.members.values()) await vc.permissionOverwrites.edit(m.id, canConnect).catch(() => {});
  }
  db.prepare(
    `INSERT INTO voices(guild_id,channel_id,owner_id,private,temporary,created_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(channel_id) DO UPDATE SET owner_id=excluded.owner_id,private=excluded.private`,
  ).run(ctx.gid, vc.id, rec?.owner_id ?? ctx.user.id, wasPrivate ? 0 : 1, rec?.temporary ?? 0, now());
  const hint = wasPrivate ? '' : '\nLes présents gardent l’accès. `=acces @membre` pour en ajouter.';
  return ctx.send(msg(ok(ctx, `**${vc.name}** est maintenant **${wasPrivate ? 'public' : 'privé'}**.${hint}`, { title: 'Vocal', emoji: E.voice })));
}

// Mon accès
async function accesCmd(ctx) {
  const vc = voiceHome(ctx);
  if (!vc) throw new Error(SAY.noVoice);
  const id = targetOf(ctx);
  if (!id) throw new Error('Usage : `=acces @membre`.');
  const has = vc.permissionOverwrites.cache.get(id)?.allow.has(PermissionFlagsBits.Connect);
  if (has) {
    if (!outranks(ctx, id)) throw new Error(SAY.above);
    await vc.permissionOverwrites.delete(id, `=acces par ${ctx.user.tag}`);
    const m = vc.members.get(id);
    if (m && voiceOf(vc.id)?.private) await m.voice.disconnect('Accès retiré').catch(() => {});
  } else await vc.permissionOverwrites.edit(id, canConnect, `=acces par ${ctx.user.tag}`);
  const text = has ? `<@${id}> n’a plus accès à **${vc.name}**.` : `<@${id}> a maintenant accès à **${vc.name}**.`;
  return ctx.send(msg(ok(ctx, text, { title: 'Accès', emoji: E.key })));
}
async function allCmd(ctx) {
  const vc = voiceHome(ctx);
  if (!vc) throw new Error(SAY.noVoice);
  let n = 0;
  for (const m of vc.members.values()) {
    if (m.user.bot) continue;
    await vc.permissionOverwrites.edit(m.id, canConnect, `=all par ${ctx.user.tag}`).catch(() => {});
    n++;
  }
  return ctx.send(msg(ok(ctx, `Accès donné à **${n}** membre(s) déjà présent(s) dans **${vc.name}**.`, { title: 'Accès', emoji: E.key })));
}
async function pvListCmd(ctx) {
  const g = acting(ctx.guild, PermissionFlagsBits.ManageChannels);
  const list = g.channels.cache.filter((c) => c.type === ChannelType.GuildVoice && isPrivate(c));
  if (!list.size) return ctx.send(msg(info(ctx, 'Aucun vocal privé pour le moment.', { title: 'Vocaux privés', emoji: E.voice })));
  const lines = [...list.values()].map((c) => dot(`${c.name}`, plural(c.members.size, 'membre')));
  return ctx.send(msg(info(ctx, lines.join('\n'), { title: `Vocaux privés — ${list.size}`, emoji: E.voice })));
}

// Déplacer
async function mvCmd(ctx) {
  const vc = voiceHome(ctx);
  if (!vc) throw new Error(SAY.noVoice);
  const id = targetOf(ctx);
  if (!id) throw new Error('Usage : `=mv @membre`.');
  const g = mover(ctx.guild);
  const target = await member(g, id);
  if (!target) throw new Error('Membre introuvable.');
  if (!outranks(ctx, id, target) && !consented(ctx.gid, id, ctx.user.id) && !isCreator(ctx.user.id)) {
    throw new Error('Cette personne est à ton rang ou au-dessus : elle doit t’y autoriser avec `=wlmv`.');
  }
  await vc.permissionOverwrites.edit(id, canConnect, `=mv par ${ctx.user.tag}`);
  const moved = target.voice.channelId ? await target.voice.setChannel(vc.id, `=mv par ${ctx.user.tag}`).then(() => true).catch(() => false) : false;
  return ctx.send(msg(ok(ctx, `<@${id}> a accès à **${vc.name}**${moved ? ' et y a été déplacé' : ''}.`, { title: 'Vocal', emoji: E.voice })));
}
async function joinCmd(ctx) {
  if (!ctx.member?.voice?.channelId) throw new Error(SAY.noVoice);
  const g = mover(ctx.guild);
  const wanted = idOf(ctx.args[0]);
  if (!wanted) throw new Error('Usage : `=join #salon` ou `=join @membre`.');
  let channel = g.channels.cache.get(wanted);
  if (channel && channel.type === ChannelType.GuildVoice) {
    const rec = voiceOf(channel.id);
    if (rec && isPrivate(channel) && !outranks(ctx, rec.owner_id)) throw new Error('Ce vocal est privé et son propriétaire est à ton rang ou au-dessus.');
  } else {
    const target = await member(g, wanted);
    if (!target?.voice.channel) throw new Error('Cette personne n’est pas en vocal.');
    if (!outranks(ctx, wanted, target)) throw new Error('Cette personne est à ton rang ou au-dessus, tu ne peux pas la rejoindre.');
    channel = target.voice.channel;
  }
  await channel.permissionOverwrites.edit(ctx.user.id, canConnect, `=join par ${ctx.user.tag}`);
  const me = await member(g, ctx.user.id);
  await me.voice.setChannel(channel.id, `=join par ${ctx.user.tag}`);
  return ctx.send(msg(ok(ctx, `Déplacé dans **${channel.name}**.`, { title: 'Vocal', emoji: E.voice })));
}
async function vmAllCmd(ctx) {
  const from = ctx.member?.voice?.channel;
  if (!from) throw new Error(SAY.noVoice);
  const g = mover(ctx.guild);
  const dest = g.channels.cache.get(idOf(ctx.args[0]) ?? '');
  if (!dest || dest.type !== ChannelType.GuildVoice) throw new Error('Usage : `=vmall #salon-vocal`.');
  let moved = 0;
  let skipped = 0;
  for (const m of from.members.values()) {
    if (m.id !== ctx.user.id && !outranks(ctx, m.id, m)) {
      skipped++;
      continue;
    }
    const done = await (await member(g, m.id))?.voice.setChannel(dest.id, `=vmall par ${ctx.user.tag}`).then(() => true).catch(() => false);
    if (done) moved++;
  }
  const extra = skipped ? ` ${skipped} ignoré(s) : même rang que toi ou au-dessus.` : '';
  return ctx.send(msg(ok(ctx, `**${moved}** membre(s) déplacé(s) vers **${dest.name}**.${extra}`, { title: 'Vocal', emoji: E.voice })));
}
async function wlmvCmd(ctx) {
  const id = targetOf(ctx);
  if (!id) throw new Error('Usage : `=wlmv @membre`.');
  const had = consented(ctx.gid, ctx.user.id, id);
  if (had) db.prepare('DELETE FROM move_consent WHERE guild_id=? AND owner_id=? AND allowed_id=?').run(ctx.gid, ctx.user.id, id);
  else db.prepare('INSERT OR IGNORE INTO move_consent(guild_id,owner_id,allowed_id) VALUES(?,?,?)').run(ctx.gid, ctx.user.id, id);
  return ctx.send(msg(ok(ctx, had ? `<@${id}> ne peut plus te déplacer avec \`=mv\`.` : `<@${id}> peut maintenant te déplacer avec \`=mv\`.`, { title: 'Autorisation', emoji: E.key })));
}

// Suivre
async function followCmd(ctx) {
  const id = targetOf(ctx);
  if (!id) throw new Error('Usage : `=follow @membre`.');
  const row_ = db.prepare('SELECT target_id FROM follows WHERE guild_id=? AND follower_id=?').get(ctx.gid, ctx.user.id);
  if (row_) {
    db.prepare('DELETE FROM follows WHERE guild_id=? AND follower_id=?').run(ctx.gid, ctx.user.id);
    if (row_.target_id === id) return ctx.send(msg(ok(ctx, `Tu ne suis plus <@${id}>.`, { title: 'Suivi', emoji: E.search })));
  }
  const target = await member(ctx.guild, id);
  if (!outranks(ctx, id, target)) throw new Error('Cette personne est à ton rang ou au-dessus, tu ne peux pas la suivre.');
  db.prepare('INSERT INTO follows(guild_id,follower_id,target_id) VALUES(?,?,?)').run(ctx.gid, ctx.user.id, id);
  audit(ctx.gid, ctx.user.id, 'follow', id);
  return ctx.send(msg(ok(ctx, `Tu suis maintenant <@${id}> dans ses déplacements vocaux.`, { title: 'Suivi', emoji: E.search })));
}

// Menotter
async function cuffCmd(ctx) {
  const id = targetOf(ctx);
  if (!id) throw new Error('Usage : `=menotte @membre`.');
  const mine = db.prepare('SELECT target_id FROM handcuffs WHERE guild_id=? AND holder_id=?').get(ctx.gid, ctx.user.id);
  if (mine) {
    db.prepare('DELETE FROM handcuffs WHERE guild_id=? AND target_id=?').run(ctx.gid, mine.target_id);
    if (mine.target_id === id) return ctx.send(msg(ok(ctx, `<@${id}> n’est plus menotté(e).`, { title: 'Menottes', emoji: E.lock })));
  }
  const g = mover(ctx.guild);
  const target = await member(g, id);
  if (!target?.voice.channelId) throw new Error('Cette personne doit être en vocal pour être menottée.');
  checkTarget({ ...ctx, guild: g }, id, target, { bot: false });
  db.prepare('INSERT OR REPLACE INTO handcuffs(guild_id,target_id,holder_id,channel_id) VALUES(?,?,?,?)').run(ctx.gid, id, ctx.user.id, target.voice.channelId);
  audit(ctx.gid, ctx.user.id, 'handcuff', id);
  return ctx.send(msg(ok(ctx, `<@${id}> est menotté(e) dans **${target.voice.channel.name}**.`, { title: 'Menottes', emoji: E.lock })));
}

// Message privé
async function mpCmd(ctx) {
  const id = targetOf(ctx);
  const text = ctx.args.slice(idOf(ctx.args[0]) ? 1 : 0).join(' ').trim();
  if (!id || !text) throw new Error('Usage : `=mp @membre ton message`.');
  if (text.length > 1500) throw new Error('1500 caractères au maximum.');
  cooldown(`mp:${ctx.user.id}`, 15_000);
  const user = await ctx.client.users.fetch(id).catch(() => null);
  if (!user || user.bot) throw new Error('Utilisateur introuvable.');
  const embed = view({ gid: ctx.gid }, { title: 'Message', emoji: E.wave, text, footer: `De la part de ${ctx.user.tag} · ${ctx.guild.name}`, timestamp: true });
  const sent = await user.send({ embeds: [embed] }).then(() => true).catch(() => false);
  if (!sent) throw new Error('Ses MP sont fermés.');
  audit(ctx.gid, ctx.user.id, 'mp', id, { size: text.length });
  return ctx.send(msg(ok(ctx, `Message transmis à <@${id}>.`, { title: 'Message', emoji: E.wave })));
}

// Vocaux temporaires
function voiceView(ctx) {
  const id = cfg(ctx.gid).voice.creatorId;
  const lines = [pair('Salon créateur', id ? `<#${id}>` : '_aucun_'), '', 'Quand quelqu’un rejoint ce salon, son propre vocal est créé.', 'Il disparaît quand il est vide.'];
  return msg(view(ctx, { title: 'Vocaux temporaires', emoji: E.voice, lines }), {
    components: [row(pickChannel('vc:creator', 'Salon créateur', [ChannelType.GuildVoice])), row(button('vc:off', 'Couper', 'rouge'))],
  });
}
async function voiceComponent(i, ctx, [action]) {
  if (!allowed(ctx.gid, ctx.user.id, '=vocal', ctx.member)) throw new Error(SAY.denied);
  setCfg(ctx.gid, (c) => (c.voice.creatorId = action === 'off' ? null : i.values[0]));
  audit(ctx.gid, ctx.user.id, `voice.${action}`);
  return i.update(voiceView(ctx));
}

// Événements vocaux
async function createOwn(g, after) {
  const base = after.channel;
  const ch = await g.channels
    .create({
      name: `🔊・${after.member.displayName}`.slice(0, 100),
      type: ChannelType.GuildVoice,
      parent: base.parentId ?? undefined,
      permissionOverwrites: [...base.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, allow: o.allow, deny: o.deny, type: o.type })),
      reason: `Vocal de ${after.member.user.tag}`,
    })
    .catch(() => null);
  if (!ch) return;
  await ch.permissionOverwrites.edit(after.member.id, { ...canConnect, MoveMembers: true }).catch(() => {});
  db.prepare('INSERT OR REPLACE INTO voices(guild_id,channel_id,owner_id,private,temporary,created_at) VALUES(?,?,?,0,1,?)').run(g.id, ch.id, after.member.id, now());
  const me = await member(mover(after.guild), after.member.id);
  await me?.voice.setChannel(ch, 'Vocal temporaire').catch(() => ch.delete().catch(() => {}));
}
async function pullFollowers(after) {
  const g = mover(after.guild);
  const followers = db.prepare('SELECT follower_id FROM follows WHERE guild_id=? AND target_id=?').all(g.id, after.id);
  const leashed = db.prepare('SELECT user_id FROM leashes WHERE guild_id=? AND holder_id=?').all(g.id, after.id).map((x) => x.user_id);
  const ids = [...new Set([...followers.map((f) => f.follower_id), ...leashed])];
  for (const uid of ids) {
    const m = await member(g, uid);
    if (!m?.voice.channelId || m.voice.channelId === after.channelId) continue;
    if (isPrivate(after.channel)) await after.channel.permissionOverwrites.edit(uid, canConnect).catch(() => {});
    await m.voice.setChannel(after.channelId, 'Suit son déplacement').catch(() => {});
  }
}
export async function onVoice(before, after) {
  const g = acting(after.guild, PermissionFlagsBits.ManageChannels);
  const user = after.member;
  if (!user || user.user.bot) return;
  if (after.channelId && after.channelId === cfg(g.id).voice.creatorId && g.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) await createOwn(g, after);
  if (before.channelId && before.channelId !== after.channelId) {
    const left = g.channels.cache.get(before.channelId);
    if (voiceOf(before.channelId)?.temporary && left && !left.members.some((m) => !m.user.bot)) {
      db.prepare('DELETE FROM voices WHERE channel_id=?').run(before.channelId);
      await left.delete('Vocal vide').catch(() => {});
    }
  }
  const cuff = db.prepare('SELECT channel_id FROM handcuffs WHERE guild_id=? AND target_id=?').get(g.id, user.id);
  if (cuff && after.channelId && after.channelId !== cuff.channel_id) {
    if (!g.channels.cache.has(cuff.channel_id)) db.prepare('DELETE FROM handcuffs WHERE guild_id=? AND target_id=?').run(g.id, user.id);
    else await (await member(mover(after.guild), user.id))?.voice.setChannel(cuff.channel_id, 'Menotté(e)').catch(() => {});
    return;
  }
  if (after.channelId && after.channelId !== before.channelId) await pullFollowers(after);
  const rec = after.channelId ? voiceOf(after.channelId) : null;
  if (rec?.private && user.id !== rec.owner_id) {
    const invited = after.channel.permissionOverwrites.cache.get(user.id)?.allow.has(PermissionFlagsBits.Connect);
    const owner = await member(g, rec.owner_id);
    if (!invited && rank(g.id, user.id, user) <= rank(g.id, rec.owner_id, owner)) await (await member(mover(after.guild), user.id))?.voice.disconnect('Vocal privé').catch(() => {});
  }
}
export async function cleanVoices() {
  for (const rec of db.prepare('SELECT * FROM voices').all()) {
    const ch = bots.main.channels.cache.get(rec.channel_id) || bots.guard.channels.cache.get(rec.channel_id);
    if (!ch) db.prepare('DELETE FROM voices WHERE channel_id=?').run(rec.channel_id);
    else if (rec.temporary && !ch.members.some((m) => !m.user.bot)) {
      db.prepare('DELETE FROM voices WHERE channel_id=?').run(rec.channel_id);
      await ch.delete('Vocal vide').catch(() => {});
    }
  }
  for (const c of db.prepare('SELECT * FROM handcuffs').all()) {
    const g = bots.main.guilds.cache.get(c.guild_id) || bots.guard.guilds.cache.get(c.guild_id);
    if (g && !g.channels.cache.has(c.channel_id)) db.prepare('DELETE FROM handcuffs WHERE guild_id=? AND target_id=?').run(c.guild_id, c.target_id);
  }
}

// Commandes
export const commands = [
  { name: '=pv', bot: 'main', section: 'vocal', help: 'Vocal privé ou public', run: pvCmd },
  { name: '=acces', bot: 'main', section: 'vocal', help: 'Ouvre ton vocal à quelqu’un', run: accesCmd },
  { name: '=all', bot: 'main', section: 'vocal', help: 'Accès à tous les présents', run: allCmd },
  { name: '=pvlist', bot: 'main', section: 'vocal', help: 'Les vocaux privés', run: pvListCmd },
  { name: '=mv', bot: 'main', section: 'vocal', help: 'Accès et déplace quelqu’un', run: mvCmd },
  { name: '=join', bot: 'main', section: 'vocal', help: 'Te déplace vers un salon ou un membre', run: joinCmd },
  { name: '=vmall', bot: 'main', section: 'vocal', help: 'Déplace tout ton salon', run: vmAllCmd },
  { name: '=wlmv', bot: 'main', section: 'vocal', help: 'Autorise quelqu’un à te déplacer', run: wlmvCmd },
  { name: '=follow', bot: 'main', section: 'vocal', help: 'Suit les déplacements de quelqu’un', run: followCmd },
  { name: '=menotte', bot: 'main', section: 'vocal', help: 'Enferme quelqu’un dans son salon', run: cuffCmd },
  { name: '=mp', bot: 'main', section: 'vocal', help: 'Envoie un MP de ta part', run: mpCmd },
  { name: '=vocal', bot: 'guard', section: 'serveur', help: 'Vocaux temporaires', run: (c) => c.send(voiceView(c)) },
];
export const components = { vc: voiceComponent };

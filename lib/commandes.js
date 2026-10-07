import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { cooldown } from './base.js';
import { accepted, answers, roleOf } from './bots.js';
import * as communaute from './communaute.js';
import { allowed, isCreator, isEnvOwner, rankOf } from './droits.js';
import * as economie from './economie.js';
import { log } from './logs.js';
import * as moderation from './moderation.js';
import * as reglages from './reglages.js';
import * as vocal from './vocal.js';
import * as surveillance from './surveillance.js';
import { E, SAY, closeRow, deny, fail, msg, pageOf, pagerUser, pair, view } from './ui.js';

// Sections de l'aide
export const SECTIONS = [
  ['tous', '📌', 'Pour tout le monde'],
  ['contribuer', '📈', 'Contribuer'],
  ['tarifs', '💶', 'Les tarifs'],
  ['sanctions', '⚠️', 'Sanctions'],
  ['salons', '🔑', 'Tenir les salons'],
  ['acces', '🎭', 'Donner des accès'],
  ['vocal', '🔊', 'Les vocaux'],
  ['argent', '🧾', 'Créditer et suivre'],
  ['fun', '🎉', 'Animer'],
  ['serveur', '⚙️', 'Le serveur'],
];

// Aide adaptée
function canRun(gid, user, member, def) {
  if (def.creatorOnly) return def.creatorOnly === 'env' ? isEnvOwner(user.id) : isCreator(user.id);
  if (allowed(gid, user.id, def.name, member)) return true;
  return !!(def.discord && member?.permissions?.has(PermissionFlagsBits[def.discord]));
}
export function helpEmbed(ctx) {
  const fields = [];
  let total = 0;
  for (const [key, emoji, title] of SECTIONS) {
    const lines = COMMANDS.filter((d) => d.section === key && d.help && canRun(ctx.gid, ctx.user, ctx.member, d)).map(
      (d) => `**${d.name}** — ${d.help}`,
    );
    if (!lines.length) continue;
    total += lines.length;
    fields.push({ name: `${emoji} ${title}`, value: lines.join('\n'), inline: false });
  }
  return view(ctx, {
    title: 'Tes commandes',
    emoji: E.help,
    text: 'Uniquement celles que tu peux lancer, la liste change avec tes accès.',
    fields,
    footer: `Dream · ${rankOf(ctx.gid, ctx.user.id, ctx.member)} · ${total} commande${total > 1 ? 's' : ''}`,
  });
}
const help = (ctx) => ctx.send(msg(helpEmbed(ctx), { components: [closeRow()] }));

// Registre unique
export const COMMANDS = [
  { name: '/help', bot: 'main', section: 'tous', help: 'Ce message', slash: { description: 'Tes commandes', options: [] }, run: help },
  { name: '=help', bot: 'main', section: null, help: null, run: help },
  ...communaute.commands,
  ...vocal.commands,
  ...economie.commands,
  ...moderation.commands,
  ...reglages.commands,
  ...surveillance.commands,
];
reglages.setRegistry(COMMANDS);
const BY_NAME = new Map(COMMANDS.flatMap((d) => [d.name, ...(d.aliases || [])].map((n) => [n, d])));
const COMPONENTS = {
  ...communaute.components,
  ...economie.components,
  ...moderation.components,
  ...reglages.components,
  ...vocal.components,
  ...surveillance.components,
};
// Anciens boutons
Object.assign(COMPONENTS, { ticket: COMPONENTS.tk, rules: COMPONENTS.rule, smash: COMPONENTS.sp });
export const prefixCommand = (word) => {
  const d = BY_NAME.get(word);
  return d && !d.name.startsWith('/') ? d : null;
};

// Erreurs lisibles
function humanError(e) {
  const code = e?.code ?? e?.rawError?.code;
  const known = {
    50013: 'Il me manque une permission Discord pour faire ça.',
    50001: 'Je n’ai pas accès à ce salon.',
    10007: 'Ce membre n’est plus sur le serveur.',
    10013: 'Utilisateur introuvable.',
    10011: 'Ce rôle n’existe plus.',
    10003: 'Ce salon n’existe plus.',
    10026: 'Cette personne n’est pas bannie.',
    50007: 'Ses MP sont fermés.',
    50035: 'Une valeur n’est pas acceptée par Discord.',
    10062: SAY.expired,
  };
  if (known[code]) return known[code];
  if (e instanceof Error && !e.code && e.message && e.message.length < 300) return e.message;
  console.error('[erreur]', e?.stack || e);
  return SAY.oops;
}
const stripFlags = ({ flags, ...rest }) => rest;

// Contextes
async function messageCtx(message, client, def, args) {
  const repliedTo = message.reference?.messageId ? ((await message.fetchReference().catch(() => null))?.author?.id ?? null) : null;
  return {
    kind: 'prefix',
    client,
    role: roleOf(client),
    guild: message.guild,
    gid: message.guild.id,
    user: message.author,
    member: message.member,
    channel: message.channel,
    message,
    args,
    rest: args.join(' '),
    command: def.name,
    repliedTo,
    opt: () => null,
    defer: () => message.channel.sendTyping().catch(() => {}),
    send: (payload) =>
      message
        .reply({ ...stripFlags(payload), allowedMentions: { parse: [], repliedUser: false, ...(payload.allowedMentions || {}) } })
        .catch(() => message.channel.send(stripFlags(payload))),
  };
}
function interactionCtx(i, client, def = null) {
  return {
    kind: def ? 'slash' : 'component',
    client,
    role: roleOf(client),
    guild: i.guild,
    gid: i.guildId,
    user: i.user,
    member: i.member,
    channel: i.channel,
    interaction: i,
    args: [],
    rest: '',
    command: def?.name ?? null,
    repliedTo: null,
    opt(name) {
      const o = i.options?.get?.(name);
      return o ? (o.user ?? o.role ?? o.channel ?? o.value ?? null) : null;
    },
    defer: () => (i.deferred || i.replied ? null : i.deferReply()),
    send: (payload) => (i.deferred || i.replied ? i.editReply(stripFlags(payload)) : i.reply(payload)),
  };
}
async function report(ctx, text) {
  const payload = msg(fail(ctx, text, { by: false }), { private: true });
  try {
    if (ctx.kind === 'prefix') {
      const sent = await ctx.send(payload);
      setTimeout(() => sent?.delete?.().catch(() => {}), 10_000);
    } else if (ctx.interaction.deferred || ctx.interaction.replied) await ctx.interaction.followUp(payload);
    else await ctx.interaction.reply(payload);
  } catch {}
}

// Lancer une commande
async function execute(ctx, def) {
  if (!canRun(ctx.gid, ctx.user, ctx.member, def)) {
    // Refus silencieux
    if (def.creatorOnly || ctx.kind === 'prefix') return console.warn(`[${def.name}] refusé : ${ctx.user.tag} (${ctx.user.id})`);
    return ctx.send(msg(deny(ctx, SAY.denied, { by: false }), { private: true })).catch(() => {});
  }
  try {
    cooldown(`cmd:${ctx.gid}:${ctx.user.id}:${def.name}`, def.cooldown ?? 1500);
    await def.run(ctx);
    log(ctx.guild, 'commande', {
      title: 'Commande',
      tone: 'neutre',
      by: ctx.user,
      lines: [pair('Commande', `\`${def.name}${ctx.rest ? ` ${ctx.rest.slice(0, 200)}` : ''}\``), pair('Salon', `<#${ctx.channel?.id}>`)],
    }).catch(() => {});
  } catch (e) {
    await report(ctx, humanError(e));
  }
}

// Messages préfixés
export async function onMessage(message) {
  if (message.author.bot || !message.guild || !message.content) return;
  const client = message.client;
  if (!accepted(message.guild.id, client.user.id)) return;
  if (answers(client, message.guild.id, 'main')) {
    const exempt = allowed(message.guild.id, message.author.id, '+badword', message.member);
    if (await moderation.enforceBadword(message, exempt).catch(() => false)) return;
    if (await moderation.enforceReserved(message).catch(() => false)) return;
  }
  const [word, ...args] = message.content.trim().split(/\s+/);
  const def = prefixCommand(word.toLowerCase());
  if (!def || !answers(client, message.guild.id, def.bot)) return;
  await execute(await messageCtx(message, client, def, args), def);
}

// Interactions
export async function onInteraction(i) {
  const client = i.client;
  if (i.isChatInputCommand()) {
    const def = BY_NAME.get(`/${i.commandName}`);
    if (!def || !i.guild)
      return i.reply({ content: 'Cette commande s’utilise sur un serveur.', flags: MessageFlags.Ephemeral }).catch(() => {});
    if (!accepted(i.guildId, client.user.id))
      return i.reply({ content: 'Ce serveur attend la validation des owners.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return execute(interactionCtx(i, client, def), def);
  }
  if (!i.isMessageComponent() && !i.isModalSubmit()) return;
  const [scope, ...parts] = i.customId.split(':');
  const ctx = interactionCtx(i, client);
  try {
    if (scope === 'ui' && parts[0] === 'close') {
      const owner = i.message.interactionMetadata?.user?.id ?? (await i.message.fetchReference().catch(() => null))?.author?.id;
      if (owner && owner !== i.user.id && !allowed(i.guildId, i.user.id, '&clear', i.member)) throw new Error(SAY.notMine);
      return await i.message.delete();
    }
    if (scope === 'acc') return await surveillance.onApproval(i, parts);
    if (scope === 'pg') {
      const [token, n] = parts;
      const page = pageOf(token, Number(n));
      if (!page) throw new Error(SAY.expired);
      if (pagerUser(token) && pagerUser(token) !== i.user.id) throw new Error(SAY.notMine);
      return await i.update(page);
    }
    if (!i.guild || !accepted(i.guildId, client.user.id)) return;
    const handler = COMPONENTS[scope];
    if (!handler) return;
    await handler(i, ctx, parts);
  } catch (e) {
    await report(ctx, humanError(e));
  }
}

// Commandes slash
const TYPES = { string: 3, integer: 4, user: 6, channel: 7, role: 8 };
export function slashFor(role) {
  return COMMANDS.filter((d) => d.slash && d.bot === role).map((d) => ({
    name: d.name.slice(1),
    description: d.slash.description,
    type: 1,
    contexts: [0],
    options: (d.slash.options || []).map((o) => ({
      type: TYPES[o.type],
      name: o.name,
      description: o.description,
      required: !!o.required,
      ...(o.choices ? { choices: o.choices.map((c) => ({ name: c, value: c })) } : {}),
    })),
  }));
}

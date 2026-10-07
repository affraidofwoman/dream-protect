import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import { cfg, clip, db, settingGet } from './base.js';

// Emojis communs
export const E = {
  ok: '✅',
  no: '❌',
  deny: '⛔',
  info: 'ℹ️',
  warn: '⚠️',
  wait: '⏳',
  lock: '🔒',
  unlock: '🔓',
  shield: '🛡️',
  ban: '🔨',
  bl: '⛔',
  wet: '🌐',
  key: '🔑',
  crown: '👑',
  role: '🎭',
  ladder: '📚',
  logs: '🗂️',
  stats: '📊',
  ticket: '🎫',
  voice: '🔊',
  gift: '🎁',
  fire: '🔥',
  money: '💶',
  card: '💳',
  user: '👤',
  users: '👥',
  clean: '🧹',
  word: '🚫',
  pin: '📌',
  rules: '📜',
  panel: '🪧',
  wave: '👋',
  dog: '🐶',
  paint: '🎨',
  alarm: '🚨',
  help: '☑️',
  image: '🖼️',
  search: '🔎',
  back: '↩️',
  trash: '🗑️',
};

// Couleurs prêtes
export const PRESETS = {
  Océan: '#1F6FEB',
  Violet: '#8B5CF6',
  Rouge: '#EF4444',
  Émeraude: '#10B981',
  Or: '#F59E0B',
  Sombre: '#2B2D31',
  Rose: '#EC4899',
};
export const TONES = { neutre: 0x7b5cff, ok: 0x3fe08f, alerte: 0xe0455a, info: 0x46c8ff, or: 0xf0b232 };
const hex = (v) => (/^#?[0-9a-f]{6}$/i.test(String(v ?? '')) ? parseInt(String(v).replace('#', ''), 16) : null);
const asColor = (v) => hex(PRESETS[v] ?? v);

// Rang branché
export const hooks = { rankName: null };

// Couleur résolue
export function colorFor(gid, ctx = {}) {
  if (!gid) return TONES.neutre;
  const c = cfg(gid);
  let out = asColor(c.theme.preset) ?? hex(c.theme.color) ?? hex(c.ui?.color) ?? 0x5865f2;
  const pick = (scope, id) => {
    const v = settingGet(gid, scope, id, 'color');
    if (v !== undefined && asColor(v) !== null) out = asColor(v);
  };
  pick('GLOBAL', '*');
  if (ctx.member?.roles?.cache) {
    for (const r of [...ctx.member.roles.cache.values()].sort((a, b) => a.position - b.position)) pick('ROLE', r.id);
  }
  if (ctx.user?.id && hooks.rankName) pick('WL', hooks.rankName(gid, ctx.user.id, ctx.member));
  if (ctx.user?.id) pick('USER', ctx.user.id);
  if (ctx.command) pick('COMMAND', ctx.command);
  return out;
}

// Signature en pied
export function sign(embed, who) {
  const u = who?.user || who;
  if (!u?.username) return embed;
  embed.setFooter({ text: u.tag || u.username, iconURL: u.displayAvatarURL?.() ?? undefined });
  embed.setTimestamp(new Date());
  return embed;
}

// Carte standard
export function view(ctx = {}, o = {}) {
  const e = new EmbedBuilder().setColor(o.color ?? colorFor(ctx.gid ?? ctx.guild?.id, ctx));
  const emoji = o.emoji ?? '';
  const body = [o.text, ...(o.lines || [])].filter((x) => x !== undefined && x !== null && x !== '').join('\n');
  if (o.title) {
    e.setTitle(clip(`${emoji} ${o.title}`.trim(), 256));
    if (body) e.setDescription(clip(body, 4096));
  } else if (body) {
    e.setDescription(clip(emoji ? `${emoji} ${body}` : body, 4096));
  }
  if (o.author) e.setAuthor(typeof o.author === 'string' ? { name: clip(o.author, 256) } : o.author);
  for (const f of (o.fields || [])
    .filter((f) => f?.name && f.value !== undefined && f.value !== null && String(f.value).length)
    .slice(0, 25)) {
    e.addFields({ name: clip(f.name, 256), value: clip(f.value, 1024), inline: f.inline !== false });
  }
  if (o.image) e.setImage(o.image);
  if (o.thumbnail) e.setThumbnail(o.thumbnail);
  if (o.url) e.setURL(o.url);
  if (o.footer) e.setFooter(typeof o.footer === 'string' ? { text: clip(o.footer, 2048) } : o.footer);
  else if (o.by !== false && (o.by || ctx.user)) sign(e, o.by || ctx.user);
  if (o.timestamp) e.setTimestamp(o.timestamp === true ? new Date() : o.timestamp);
  return e;
}
export const ok = (ctx, text, o = {}) => view(ctx, { emoji: E.ok, text, ...o });
export const fail = (ctx, text, o = {}) => view(ctx, { emoji: E.warn, text, ...o });
export const deny = (ctx, text, o = {}) => view(ctx, { emoji: E.deny, text, ...o });
export const info = (ctx, text, o = {}) => view(ctx, { emoji: E.info, text, ...o });

// Lignes lisibles
export const dot = (label, value) => `• ${label}${value === undefined || value === null || value === '' ? '' : ` — **${value}**`}`;
export const pair = (label, value) => `**${label}** : ${value}`;
export const head = (emoji, name) => `${emoji ? `${emoji} ` : ''}**${name}**`;
export const small = (text) => `-# ${text}`;

// Panneau à sections
export function panel(ctx, { emoji, title, intro, sections = [], outro, fields, image, thumbnail, by } = {}) {
  const lines = [];
  if (intro) lines.push(intro);
  for (const s of sections) {
    if (!s) continue;
    const rows = (s.lines || []).filter(Boolean);
    if (!rows.length && !s.text) continue;
    if (lines.length) lines.push('');
    lines.push(head(s.emoji, s.name));
    if (s.text) lines.push(s.text);
    lines.push(...rows);
  }
  if (outro) lines.push('', outro);
  return view(ctx, { emoji, title, text: lines.join('\n'), fields, image, thumbnail, by });
}

// Message prêt
export const msg = (embed, o = {}) => ({
  embeds: [embed],
  ...(o.components ? { components: o.components } : {}),
  ...(o.private ? { flags: MessageFlags.Ephemeral } : {}),
  allowedMentions: o.mentions ?? { parse: [] },
});

// Composants
export const row = (...items) => new ActionRowBuilder().addComponents(...items.flat());
export function button(id, label, style = 'gris', emoji = null, disabled = false) {
  const styles = { bleu: ButtonStyle.Primary, vert: ButtonStyle.Success, rouge: ButtonStyle.Danger, gris: ButtonStyle.Secondary };
  const b = new ButtonBuilder()
    .setCustomId(id)
    .setStyle(styles[style] ?? style)
    .setDisabled(disabled);
  if (label) b.setLabel(clip(label, 80));
  if (emoji) b.setEmoji(emoji);
  return b;
}
export function select(id, placeholder, options, { min = 1, max = 1 } = {}) {
  const list = (options || []).slice(0, 25).map((o) => ({
    label: clip(o.label, 100),
    value: String(o.value).slice(0, 100),
    ...(o.description ? { description: clip(o.description, 100) } : {}),
    ...(o.emoji ? { emoji: o.emoji } : {}),
    ...(o.default ? { default: true } : {}),
  }));
  const m = new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(clip(placeholder, 150));
  if (!list.length) return m.addOptions([{ label: 'Rien à choisir', value: '_' }]).setDisabled(true);
  return m.addOptions(list).setMinValues(Math.min(min, list.length)).setMaxValues(Math.min(max, list.length));
}
export const pickRole = (id, placeholder = 'Choisis un rôle', max = 1) =>
  new RoleSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setMinValues(0).setMaxValues(max);
export const pickUser = (id, placeholder = 'Choisis un membre', max = 1) =>
  new UserSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setMinValues(1).setMaxValues(max);
export const pickChannel = (id, placeholder = 'Choisis un salon', types = null) => {
  const m = new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder);
  if (types) m.setChannelTypes(types);
  return m;
};
export function form(id, title, fields) {
  const m = new ModalBuilder().setCustomId(id).setTitle(clip(title, 45));
  for (const f of fields.slice(0, 5)) {
    const t = new TextInputBuilder()
      .setCustomId(f.id)
      .setLabel(clip(f.label, 45))
      .setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(f.required ?? true);
    if (f.placeholder) t.setPlaceholder(clip(f.placeholder, 100));
    if (f.value) t.setValue(clip(f.value, 4000));
    if (f.max) t.setMaxLength(f.max);
    m.addComponents(new ActionRowBuilder().addComponents(t));
  }
  return m;
}
export const closeRow = () => row(button('ui:close', null, 'gris', E.trash));

// Embed de log
export function journal({ title, tone = 'neutre', lines = [], text, fields, by }) {
  const e = new EmbedBuilder().setColor(TONES[tone] ?? TONES.neutre).setTimestamp();
  if (title) e.setAuthor({ name: clip(title, 256) });
  const body = text || lines.filter(Boolean).join('\n');
  if (body) e.setDescription(clip(body, 4096));
  for (const f of fields || [])
    if (f?.name) e.addFields({ name: clip(f.name, 256), value: clip(f.value ?? '—', 1024), inline: f.inline !== false });
  const u = by?.user || by;
  if (u?.username) e.setFooter({ text: clip(`par ${u.tag || u.username}`, 2048), iconURL: u.displayAvatarURL?.() ?? undefined });
  else if (typeof by === 'string') e.setFooter({ text: clip(`par ${by}`, 2048) });
  return e;
}

// Avis en MP
export function notice({ good, text, guildName }) {
  return new EmbedBuilder()
    .setColor(good ? TONES.ok : TONES.alerte)
    .setTitle(good ? '✅ Bonne nouvelle' : '🛡️ Sanction')
    .setDescription(clip(text, 4096))
    .setFooter({ text: clip(guildName || 'Dream', 2048) })
    .setTimestamp();
}

// Phrases communes
export const SAY = {
  denied: 'Tu n’as pas accès à cette commande.',
  above: 'Cette personne est au même rang que toi ou au-dessus.',
  self: 'Tu ne peux pas te viser toi-même.',
  idNeeded: 'Donne un identifiant ou une mention.',
  notMine: 'Seul l’auteur de la commande peut faire ce choix.',
  noVoice: 'Tu dois être en vocal pour faire ça.',
  botLow: 'Mon rôle est trop bas pour toucher à cette personne ou ce rôle.',
  oops: 'Ça n’a pas marché. Réessaie dans un instant.',
  expired: 'Ce menu a expiré, relance la commande.',
};

// Barre simple
export const bar = (value, max, width = 10) => {
  const n = Math.max(0, Math.min(width, Math.round(((Number(value) || 0) / Math.max(1, Number(max) || 1)) * width)));
  return `${'▰'.repeat(n)}${'▱'.repeat(width - n)}`;
};

// Panneau mémorisé
export async function postPanel(guild, key, channel, payload) {
  const rec = db.prepare('SELECT * FROM panels WHERE guild_id=? AND key=?').get(guild.id, key);
  const ch = channel || (rec?.channel_id ? guild.channels.cache.get(rec.channel_id) : null);
  if (!ch?.isTextBased?.()) throw new Error('Choisis un salon écrit pour ce panneau.');
  let message = rec?.message_id && rec.channel_id === ch.id ? await ch.messages.fetch(rec.message_id).catch(() => null) : null;
  if (message) message = await message.edit(payload).catch(() => null);
  if (!message) message = await ch.send(payload);
  db.prepare(
    'INSERT INTO panels(guild_id,key,channel_id,message_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,key) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id,updated_at=excluded.updated_at',
  ).run(guild.id, key, ch.id, message.id, Date.now());
  return message;
}

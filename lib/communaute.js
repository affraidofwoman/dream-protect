import {
  AttachmentBuilder,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import { audit, cfg, cooldown, db, duration, idOf, json, money, now, parse, plural, setCfg } from './base.js';
import { acting, bots } from './bots.js';
import { LEVEL, allowed, checkRole, rank, rankOf, staffRows } from './droits.js';
import { fetchAll, log, transcriptHtml } from './logs.js';
import {
  E,
  SAY,
  button,
  dot,
  form,
  info,
  msg,
  ok,
  pair,
  panel,
  pickChannel,
  pickRole,
  postPanel,
  row,
  select,
  small,
  view,
  colorValue,
  pager,
  colorFor,
} from './ui.js';

const member = (guild, id) => guild.members.fetch(id).catch(() => null);
const manager = (ctx) => member(acting(ctx.guild, PermissionFlagsBits.ManageRoles), ctx.user.id);
const field = (i, id) => i.fields.getTextInputValue(id)?.trim() ?? '';

// Tickets
export const TICKET_TYPES = [
  {
    value: 'sanction',
    prefix: 'sanction',
    label: 'Sanction',
    emoji: '⚖️',
    style: 'rouge',
    text: 'Sanctionné et tu penses que c’est injuste ? Explique-toi ici.',
  },
  {
    value: 'contribution',
    prefix: 'contribution',
    label: 'Contribution',
    emoji: '💎',
    style: 'vert',
    text: 'Contribuer, monter en perms ou déclarer un paiement.',
  },
  {
    value: 'bataillon',
    prefix: 'confirme',
    label: 'Bataillon Confirmé',
    emoji: '🛡️',
    style: 'bleu',
    text: 'Rejoindre les membres reconnus du serveur. C’est gratuit.',
  },
  { value: 'autre', prefix: 'help', label: 'Autre', emoji: '💬', style: 'gris', text: 'Tout le reste. Si tu hésites, prends celui-là.' },
];
const ticketType = (v) => TICKET_TYPES.find((t) => t.value === v) ?? TICKET_TYPES.at(-1);
export { ticketPanelV2 };
export function ticketPanel(gid) {
  const embed = view(
    { gid },
    {
      title: 'Support',
      emoji: E.ticket,
      text: [
        'Une question, un souci, une demande ? Choisis le motif, on prend le relais.',
        '',
        ...TICKET_TYPES.map((t) => `${t.emoji} **${t.label}** — ${t.text}`),
      ].join('\n'),
      footer: 'Support · un ticket par demande',
    },
  );
  return { embeds: [embed], components: [row(TICKET_TYPES.map((t) => button(`tk:open:${t.value}`, t.label, t.style, t.emoji)))] };
}
// Panneau nouvelle génération
function ticketPanelV2(gid) {
  const line = (big) => new SeparatorBuilder().setDivider(big).setSpacing(big ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
  const box = new ContainerBuilder().setAccentColor(colorFor(gid));
  box.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${E.ticket} Support`),
    new TextDisplayBuilder().setContent('Une question, un souci, une demande ? Choisis le motif, on prend le relais.'),
  );
  box.addSeparatorComponents(line(true));
  TICKET_TYPES.forEach((t, n) => {
    if (n) box.addSeparatorComponents(line(false));
    box.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${t.emoji} **${t.label}**\n-# ${t.text}`))
        .setButtonAccessory(button(`tk:open:${t.value}`, 'Ouvrir', t.style)),
    );
  });
  box.addSeparatorComponents(line(true));
  box.addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Support · un ticket par demande'));
  return { components: [box], flags: MessageFlags.IsComponentsV2 };
}
function ticketRoles(guild, type) {
  const set = (cfg(guild.id).ticket.roles?.[type] || []).filter((id) => guild.roles.cache.has(id));
  if (set.length) return { ids: set, ping: true };
  return {
    ids: staffRows(guild.id)
      .map((x) => x.role_id)
      .filter((id) => guild.roles.cache.has(id)),
    ping: false,
  };
}
async function ticketCategory(guild) {
  const id = cfg(guild.id).ticket.categoryId;
  let cat = id ? guild.channels.cache.get(id) : null;
  cat ??= guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && /ticket/i.test(c.name)) ?? null;
  cat ??= await guild.channels
    .create({
      name: 'tickets',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
      reason: 'Tickets Dream',
    })
    .catch(() => null);
  if (cat && cat.id !== id) setCfg(guild.id, (c) => (c.ticket.categoryId = cat.id));
  return cat;
}
export const slug = (raw) =>
  String(raw || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'membre';
async function openTicket(i, ctx, value) {
  const g = acting(ctx.guild, PermissionFlagsBits.ManageChannels);
  const t = ticketType(value);
  const mine = db
    .prepare("SELECT channel_id FROM tickets WHERE guild_id=? AND creator_id=? AND status='OPEN'")
    .all(g.id, ctx.user.id)
    .find((x) => g.channels.cache.has(x.channel_id));
  if (mine)
    return i.reply(
      msg(info(ctx, `Tu as déjà un ticket ouvert : <#${mine.channel_id}>`, { title: 'Ticket', emoji: E.ticket }), { private: true }),
    );
  if (!g.members.me.permissions.has(PermissionFlagsBits.ManageChannels))
    throw new Error('Il me manque « Gérer les salons » pour ouvrir un ticket.');
  cooldown(`ticket:${g.id}:${ctx.user.id}`, 20_000);
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const cat = await ticketCategory(g);
  const base = `${t.prefix}-${slug(ctx.user.username)}`;
  const name = g.channels.cache.some((c) => c.name === base) ? `${base}-${Math.random().toString(36).slice(2, 5)}` : base;
  const { ids, ping } = ticketRoles(g, t.value);
  const rw = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
  ];
  const ch = await g.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: cat?.id,
    topic: `Ticket ouvert par ${ctx.user.id} | catégorie : ${t.value}`,
    permissionOverwrites: [
      { id: g.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: ctx.user.id, allow: rw },
      { id: g.members.me.id, allow: [...rw, PermissionFlagsBits.ManageChannels] },
      ...ids.map((id) => ({ id, allow: rw })),
    ],
    reason: `Ticket de ${ctx.user.tag}`,
  });
  db.prepare('INSERT INTO tickets(guild_id,channel_id,creator_id,status,created_at,type) VALUES(?,?,?,?,?,?)').run(
    g.id,
    ch.id,
    ctx.user.id,
    'OPEN',
    now(),
    t.value,
  );
  await ch.send({
    content: [`${ctx.user}`, ...(ping ? ids.map((id) => `<@&${id}>`) : [])].join(' '),
    embeds: [
      view(ctx, {
        title: 'Ticket ouvert',
        emoji: E.ticket,
        text: `Bienvenue ${ctx.user}.\n\nExplique ta demande ici, le plus clairement possible.\nLe staff te répond dès qu’il passe.`,
        fields: [{ name: `${t.emoji} Motif`, value: t.label }],
        footer: 'Ferme le ticket une fois réglé, tu recevras la conversation en MP.',
        timestamp: true,
      }),
    ],
    components: [row(button('tk:close', 'Fermer le ticket', 'rouge', E.lock))],
    allowedMentions: { users: [ctx.user.id], roles: ping ? ids : [] },
  });
  await log(g, 'ticket', {
    title: 'Ticket ouvert',
    tone: 'ok',
    by: ctx.user,
    lines: [pair('Ticket', `<#${ch.id}> \`#${ch.name}\``), pair('Catégorie', t.label), pair('Ouvert par', `<@${ctx.user.id}>`)],
  });
  return i.editReply(msg(ok(ctx, `Ticket créé : ${ch}`, { title: 'Ticket', emoji: E.ticket })));
}
async function closeTicket(i, ctx, reason) {
  const t = db.prepare("SELECT * FROM tickets WHERE guild_id=? AND channel_id=? AND status='OPEN'").get(ctx.gid, ctx.channel.id);
  if (!t) throw new Error('Ce salon n’est pas un ticket ouvert.');
  if (
    t.creator_id !== ctx.user.id &&
    !allowed(ctx.gid, ctx.user.id, '=ticket', ctx.member) &&
    !ticketRoles(ctx.guild, t.type).ids.some((id) => ctx.member.roles.cache.has(id))
  ) {
    throw new Error('Seuls le créateur et le staff du ticket peuvent le fermer.');
  }
  await i.deferReply();
  const ch = ctx.channel;
  const type = ticketType(t.type);
  const messages = await fetchAll(ch);
  const html = transcriptHtml(ch, messages);
  const text = messages
    .map(
      (m) =>
        `[${new Date(m.createdTimestamp).toLocaleString('fr-FR')}] ${m.author?.tag}: ${m.content || (m.embeds.length ? '[embed]' : '')}`,
    )
    .join('\n');
  db.prepare("UPDATE tickets SET status='CLOSED',closed_at=?,staff_id=?,reason=?,transcript=? WHERE id=?").run(
    now(),
    ctx.user.id,
    reason || null,
    text.slice(0, 200000),
    t.id,
  );
  const file = () => new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `transcript-${ch.name}.html` });
  await log(ctx.guild, 'ticket', {
    title: 'Ticket fermé',
    tone: 'info',
    by: ctx.user,
    lines: [
      pair('Ticket', `\`#${ch.name}\` (n°${t.id})`),
      pair('Catégorie', `${type.emoji} ${type.label}`),
      pair('Ouvert par', `<@${t.creator_id}>`),
      pair('Fermé par', `<@${ctx.user.id}>`),
      pair('Motif', reason || '—'),
      pair('Durée', `ouvert <t:${Math.floor(t.created_at / 1000)}:R>`),
      pair('Transcript', `${plural(messages.length, 'message')} en pièce jointe`),
    ],
    files: [file()],
  });
  const creator = await ctx.client.users.fetch(t.creator_id).catch(() => null);
  await creator
    ?.send({
      embeds: [
        view(
          { gid: ctx.gid },
          {
            title: 'Ton ticket est fermé',
            emoji: E.ticket,
            text: 'Toute la conversation est dans le fichier joint, garde-le si tu en as besoin.',
            fields: [
              { name: 'Motif', value: type.label },
              { name: 'Salon', value: `\`${ch.name}\`` },
              reason ? { name: 'Raison', value: reason, inline: false } : null,
            ],
            footer: `${ctx.guild.name} · transcript du ticket`,
            timestamp: true,
          },
        ),
      ],
      files: [file()],
    })
    .catch(() => {});
  audit(ctx.gid, ctx.user.id, 'ticket.close', String(t.id), { reason });
  await i.editReply(msg(ok(ctx, 'Ticket fermé. Le salon disparaît dans quelques secondes.', { title: 'Ticket', emoji: E.lock })));
  setTimeout(() => ch.delete(`Ticket fermé par ${ctx.user.tag}`).catch(() => {}), 5000);
}
async function ticketCmd(ctx) {
  const style = (ctx.args[0] || '').toLowerCase();
  if (style === 'v2' || style === 'v1') setCfg(ctx.gid, (c) => (c.ticket.v2 = style === 'v2'));
  await ctx.message?.delete().catch(() => {});
  const panelPayload = cfg(ctx.gid).ticket.v2 ? ticketPanelV2(ctx.gid) : ticketPanel(ctx.gid);
  const sent = await postPanel(ctx.guild, 'ticket', ctx.channel, panelPayload);
  const note = await ctx.channel.send(
    msg(
      ok(ctx, 'Panneau posé. Tu peux choisir qui voit chaque motif.', {
        title: 'Ticket',
        emoji: E.ticket,
        lines: [small('`=ticket v2` pour le nouveau style, `=ticket v1` pour le classique.')],
      }),
      {
        components: [row(button('tk:roles', 'Qui voit quoi', 'gris', E.key))],
      },
    ),
  );
  setTimeout(() => note.delete().catch(() => {}), 120_000);
  return sent;
}
function ticketRolesView(ctx) {
  return msg(
    view(ctx, {
      title: 'Qui voit les tickets',
      emoji: E.key,
      lines: TICKET_TYPES.map((t) => {
        const { ids, ping } = ticketRoles(ctx.guild, t.value);
        return `${t.emoji} **${t.label}** — ${ids.length ? ids.map((r) => `<@&${r}>`).join(' ') : '_personne_'}${ping ? '' : ' · _staff par défaut_'}`;
      }),
      footer: 'Les rôles choisis voient le ticket et sont mentionnés à l’ouverture.',
    }),
    {
      private: true,
      components: [
        row(
          select(
            'tk:pick',
            'Motif à régler',
            TICKET_TYPES.map((t) => ({ label: t.label, value: t.value, emoji: t.emoji })),
          ),
        ),
      ],
    },
  );
}
async function ticketComponent(i, ctx, [action, arg]) {
  if (action === 'open') return openTicket(i, ctx, arg);
  if (action === 'close')
    return i.showModal(
      form('tk:closed', 'Fermer le ticket', [{ id: 'reason', label: 'Motif de fermeture', long: true, required: false, max: 500 }]),
    );
  if (action === 'closed') return closeTicket(i, ctx, field(i, 'reason'));
  if (!allowed(ctx.gid, ctx.user.id, '=ticket', ctx.member)) throw new Error(SAY.denied);
  if (action === 'roles') return i.reply(ticketRolesView(ctx));
  if (action === 'pick') {
    const t = ticketType(i.values[0]);
    return i.update(
      msg(
        info(ctx, 'Choisis les rôles qui voient ce motif.\nNe rien choisir remet le staff par défaut.', {
          title: `${t.label}`,
          emoji: t.emoji,
        }),
        { components: [row(pickRole(`tk:set:${t.value}`, 'Rôles du motif', 10))] },
      ),
    );
  }
  if (action === 'set') {
    const t = ticketType(arg);
    setCfg(ctx.gid, (c) => (c.ticket.roles = { ...c.ticket.roles, [t.value]: i.values }));
    audit(ctx.gid, ctx.user.id, 'ticket.roles', t.value, { roles: i.values });
    return i.update(ticketRolesView(ctx));
  }
}

// Bienvenue
function fill(text, m) {
  return String(text || '')
    .replace(/\{membre\}|\{member\}/gi, `${m}`)
    .replace(/\{serveur\}|\{server\}/gi, m.guild.name)
    .replace(/\{nombre\}/gi, String(m.guild.memberCount));
}
function welcomeView(ctx) {
  const w = cfg(ctx.gid).welcome;
  return msg(
    view(ctx, {
      title: 'Bienvenue',
      emoji: E.wave,
      lines: [
        pair('Salon', w.channelId ? `<#${w.channelId}>` : '_aucun, la bienvenue est coupée_'),
        pair('Rôle donné', w.roleId ? `<@&${w.roleId}>` : '—'),
        pair('Message', w.text),
        small('Variables : {membre} {serveur} {nombre}'),
      ],
    }),
    {
      components: [
        row(pickChannel('wel:channel', 'Salon de bienvenue', [ChannelType.GuildText])),
        row(pickRole('wel:role', 'Rôle donné à l’arrivée')),
        row(
          button('wel:text', 'Modifier le message', 'bleu', '✏️'),
          button('wel:off', 'Couper', 'rouge'),
          button('wel:test', 'Tester', 'gris', E.search),
        ),
      ],
    },
  );
}
export async function welcome(m) {
  const w = cfg(m.guild.id).welcome;
  if (w.roleId && !m.user.bot) {
    const role = m.guild.roles.cache.get(w.roleId);
    if (
      role?.editable &&
      (await m.roles
        .add(role, 'Rôle d’arrivée')
        .then(() => true)
        .catch(() => false))
    ) {
      await log(m.guild, 'autorole', {
        title: 'Rôle d’arrivée',
        tone: 'ok',
        by: m.user,
        lines: [pair('Membre', `<@${m.id}>`), pair('Rôle', `${role}`)],
      });
    }
  }
  const ch = w.channelId ? m.guild.channels.cache.get(w.channelId) : null;
  if (!ch?.isTextBased() || m.user.bot) return;
  const embed = view(
    { gid: m.guild.id },
    {
      title: 'Bienvenue',
      emoji: E.wave,
      text: fill(w.text, m),
      thumbnail: m.user.displayAvatarURL({ size: 256 }),
      footer: `${m.guild.name} · ${plural(m.guild.memberCount, 'membre')}`,
      timestamp: true,
    },
  );
  await ch.send({ content: `${m}`, embeds: [embed], allowedMentions: { users: [m.id] } }).catch(() => {});
}
async function welcomeComponent(i, ctx, [action]) {
  if (!allowed(ctx.gid, ctx.user.id, '=bienvenue', ctx.member)) throw new Error(SAY.denied);
  if (action === 'channel') setCfg(ctx.gid, (c) => (c.welcome.channelId = i.values[0] ?? null));
  if (action === 'role') {
    const role = i.values[0] ? ctx.guild.roles.cache.get(i.values[0]) : null;
    if (role) checkRole(ctx, role);
    setCfg(ctx.gid, (c) => (c.welcome.roleId = role?.id ?? null));
  }
  if (action === 'off') setCfg(ctx.gid, (c) => (c.welcome.channelId = null));
  if (action === 'text')
    return i.showModal(
      form('wel:save', 'Message de bienvenue', [{ id: 'text', label: 'Message', long: true, value: cfg(ctx.gid).welcome.text, max: 1500 }]),
    );
  if (action === 'save') setCfg(ctx.gid, (c) => (c.welcome.text = field(i, 'text') || c.welcome.text));
  if (action === 'test') {
    await welcome(ctx.member);
    return i.reply(msg(ok(ctx, 'Message de test envoyé.', { title: 'Bienvenue', emoji: E.wave }), { private: true }));
  }
  audit(ctx.gid, ctx.user.id, `welcome.${action}`);
  return i.isModalSubmit() ? i.reply(welcomeView(ctx)) : i.update(welcomeView(ctx));
}

// Règlement
const RULES =
  '1. Respecte tout le monde.\n2. Pas de pub, pas de spam.\n3. Contenus choquants interdits.\n4. Les décisions du staff s’appliquent.\n\nEn cliquant, tu acceptes le règlement.';
function rulesPanel(gid) {
  const r = cfg(gid).rules;
  const embed = view({ gid }, { title: 'Règlement', emoji: E.rules, text: r.text || RULES, footer: 'Lis-le, il est court.' });
  return { embeds: [embed], components: r.roleId ? [row(button('rule:accept', 'J’accepte', 'vert', E.ok))] : [] };
}
function rulesView(ctx) {
  const r = cfg(ctx.gid).rules;
  return msg(
    view(ctx, {
      title: 'Règlement',
      emoji: E.rules,
      lines: [pair('Rôle donné', r.roleId ? `<@&${r.roleId}>` : '_aucun, pas de bouton_'), '', r.text || RULES],
    }),
    {
      components: [
        row(pickRole('rule:role', 'Rôle donné en acceptant')),
        row(button('rule:text', 'Modifier le texte', 'bleu', '✏️'), button('rule:post', 'Publier ici', 'vert', E.pin)),
      ],
    },
  );
}
async function rulesComponent(i, ctx, [action]) {
  if (action === 'accept') {
    const me = await manager(ctx);
    const role = me?.guild.roles.cache.get(cfg(ctx.gid).rules.roleId ?? '');
    if (!role?.editable) throw new Error('Le rôle du règlement est introuvable, préviens le staff.');
    if (me.roles.cache.has(role.id))
      return i.reply(msg(info(ctx, 'Tu as déjà accepté le règlement.', { title: 'Règlement', emoji: E.rules }), { private: true }));
    await me.roles.add(role, 'Règlement accepté');
    return i.reply(msg(ok(ctx, 'Merci, bienvenue parmi nous !', { title: 'Règlement', emoji: E.rules }), { private: true }));
  }
  if (!allowed(ctx.gid, ctx.user.id, '=reglement', ctx.member)) throw new Error(SAY.denied);
  if (action === 'role') {
    const role = i.values[0] ? ctx.guild.roles.cache.get(i.values[0]) : null;
    if (role) checkRole(ctx, role);
    setCfg(ctx.gid, (c) => (c.rules.roleId = role?.id ?? null));
  }
  if (action === 'text')
    return i.showModal(
      form('rule:save', 'Texte du règlement', [
        { id: 'text', label: 'Règlement', long: true, value: cfg(ctx.gid).rules.text || RULES, max: 4000 },
      ]),
    );
  if (action === 'save') setCfg(ctx.gid, (c) => (c.rules.text = field(i, 'text') || null));
  if (action === 'post') {
    await postPanel(ctx.guild, 'reglement', ctx.channel, rulesPanel(ctx.gid));
    return i.reply(msg(ok(ctx, 'Règlement publié dans ce salon.', { title: 'Règlement', emoji: E.rules }), { private: true }));
  }
  audit(ctx.gid, ctx.user.id, `rules.${action}`);
  if (db.prepare("SELECT 1 FROM panels WHERE guild_id=? AND key='reglement'").get(ctx.gid))
    await postPanel(ctx.guild, 'reglement', null, rulesPanel(ctx.gid)).catch(() => {});
  return i.isModalSubmit() ? i.reply(rulesView(ctx)) : i.update(rulesView(ctx));
}

// Panneaux de rôles
const PANELS = {
  roles: { label: 'Rôles', emoji: '🎨', text: 'Choisis les rôles qui te ressemblent.' },
  profils: { label: 'Profil', emoji: '🪪', text: 'Dis-nous qui tu es.' },
  regions: { label: 'Régions', emoji: '🌍', text: 'D’où viens-tu ?' },
};
function rolePanel(guild, key) {
  const p = PANELS[key];
  const ids = (cfg(guild.id).panels?.[key] || []).filter((id) => guild.roles.cache.has(id));
  const embed = view(
    { gid: guild.id },
    {
      title: p.label,
      emoji: p.emoji,
      text: `${p.text}\nTu peux changer quand tu veux.`,
      lines: ['', ...ids.map((id) => `• <@&${id}>`)],
      footer: 'Choisis dans le menu ci-dessous',
    },
  );
  const menu = select(
    `rp:pick:${key}`,
    'Choisis tes rôles',
    ids.map((id) => ({ label: guild.roles.cache.get(id).name, value: id })),
    { min: 0, max: ids.length || 1 },
  );
  return { embeds: [embed], components: [row(menu)] };
}
function panelsView(ctx) {
  const p = cfg(ctx.gid).panels || {};
  return msg(
    view(ctx, {
      title: 'Panneaux de rôles',
      emoji: E.panel,
      lines: [
        ...Object.entries(PANELS).map(([k, x]) => dot(`${x.emoji} ${x.label}`, (p[k] || []).length ? plural(p[k].length, 'rôle') : 'vide')),
        '',
        'Choisis un panneau, puis ses rôles. Il est publié dans ce salon.',
      ],
    }),
    {
      components: [
        row(
          select(
            'rp:edit',
            'Panneau à régler',
            Object.entries(PANELS).map(([k, x]) => ({ label: x.label, value: k, emoji: x.emoji })),
          ),
        ),
      ],
    },
  );
}
async function panelComponent(i, ctx, [action, key]) {
  if (action === 'pick') {
    const me = await manager(ctx);
    if (!me) throw new Error(SAY.oops);
    const ids = (cfg(ctx.gid).panels?.[key] || []).filter((id) => me.guild.roles.cache.get(id)?.editable);
    const want = new Set(i.values);
    const add = ids.filter((id) => want.has(id) && !me.roles.cache.has(id));
    const del = ids.filter((id) => !want.has(id) && me.roles.cache.has(id));
    if (add.length) await me.roles.add(add, 'Panneau de rôles');
    if (del.length) await me.roles.remove(del, 'Panneau de rôles');
    return i.reply(
      msg(
        ok(
          ctx,
          add.length || del.length
            ? `Rôles mis à jour : ${[...add.map((x) => `+<@&${x}>`), ...del.map((x) => `−<@&${x}>`)].join(' ')}`
            : 'Rien n’a changé.',
          { title: PANELS[key].label, emoji: PANELS[key].emoji },
        ),
        { private: true },
      ),
    );
  }
  if (!allowed(ctx.gid, ctx.user.id, '=panneau', ctx.member)) throw new Error(SAY.denied);
  if (action === 'edit') {
    const k = i.values[0];
    return i.update(
      msg(
        info(ctx, 'Choisis jusqu’à 25 rôles. Les rôles staff et sensibles sont refusés.', {
          title: PANELS[k].label,
          emoji: PANELS[k].emoji,
        }),
        { components: [row(pickRole(`rp:set:${k}`, 'Rôles du panneau', 25))] },
      ),
    );
  }
  if (action === 'set') {
    const roles = i.values.map((id) => ctx.guild.roles.cache.get(id)).filter(Boolean);
    const staff = new Set(staffRows(ctx.gid).map((x) => x.role_id));
    for (const r of roles) {
      if (staff.has(r.id)) throw new Error(`${r.name} est un rôle staff, il ne peut pas être en libre service.`);
      checkRole(ctx, r);
    }
    setCfg(ctx.gid, (c) => (c.panels = { ...(c.panels || {}), [key]: roles.map((r) => r.id) }));
    if (roles.length) await postPanel(ctx.guild, `panel-${key}`, ctx.channel, rolePanel(ctx.guild, key));
    audit(ctx.gid, ctx.user.id, 'panel.set', key, { roles: roles.map((r) => r.id) });
    return i.update(panelsView(ctx));
  }
}

// Giveaways
function giveawayView(gid, gw, ended = false, winners = []) {
  const entries = parse(gw.entries, []);
  const end = Math.floor(gw.ends_at / 1000);
  const embed = view(
    { gid },
    {
      author: ended ? 'Giveaway terminé' : 'Giveaway en cours',
      title: ended ? `~~${gw.prize}~~` : gw.prize,
      emoji: E.gift,
      text: ended
        ? winners.length
          ? `Gagnant${winners.length > 1 ? 's' : ''} : ${winners.map((x) => `<@${x}>`).join(', ')}`
          : 'Personne n’a participé.'
        : 'Clique sur **Participer** pour tenter ta chance.',
      fields: [
        { name: ended ? 'Tiré' : 'Tirage', value: `<t:${end}:R>\n${small(`<t:${end}:f>`)}` },
        { name: 'Gagnants', value: String(gw.winners) },
        { name: 'Lancé par', value: `<@${gw.created_by}>` },
        gw.role_id ? { name: 'Réservé à', value: `<@&${gw.role_id}>` } : null,
      ],
      footer: `${plural(entries.length, 'participant')}`,
    },
  );
  const comps = ended
    ? [row(button(`gw:reroll:${gw.id}`, 'Retirer au sort', 'gris', '🔁'))]
    : [
        row(
          button(`gw:join:${gw.id}`, `Participer (${entries.length})`, 'vert', E.gift),
          button(`gw:end:${gw.id}`, 'Terminer', 'gris', '⏹️'),
        ),
      ];
  return { embeds: [embed], components: comps };
}
const draw = (entries, n) => {
  const pool = [...entries];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
};
async function endGiveaway(gw, reroll = false) {
  const g = bots.main.guilds.cache.get(gw.guild_id) || bots.guard.guilds.cache.get(gw.guild_id);
  if (!g) return;
  db.prepare("UPDATE giveaways SET status='done' WHERE id=?").run(gw.id);
  const winners = draw(parse(gw.entries, []), gw.winners);
  const ch = g.channels.cache.get(gw.channel_id);
  const message = ch && gw.message_id ? await ch.messages.fetch(gw.message_id).catch(() => null) : null;
  await message?.edit(giveawayView(g.id, gw, true, winners)).catch(() => {});
  if (ch?.isTextBased()) {
    const text = winners.length
      ? `Bravo ${winners.map((x) => `<@${x}>`).join(', ')}, tu remportes **${gw.prize}** !`
      : `Personne n’a participé : **${gw.prize}** n’a pas trouvé preneur.`;
    await ch
      .send({
        embeds: [view({ gid: g.id }, { title: reroll ? 'Nouveau tirage' : 'Giveaway', emoji: E.gift, text, by: false })],
        allowedMentions: { users: winners },
      })
      .catch(() => {});
  }
  await log(g, 'giveaway', {
    title: reroll ? 'Giveaway retiré au sort' : 'Giveaway terminé',
    tone: 'info',
    lines: [
      pair('Lot', gw.prize),
      pair('Gagnants', winners.map((x) => `<@${x}>`).join(', ') || 'personne'),
      pair('Participants', parse(gw.entries, []).length),
    ],
  });
}
export async function tickGiveaways() {
  for (const gw of db.prepare("SELECT * FROM giveaways WHERE status='open' AND ends_at<=?").all(now()))
    await endGiveaway(gw).catch(() => {});
}
async function giveawayCmd(ctx) {
  return ctx.interaction.showModal(
    form('gw:create', 'Nouveau giveaway', [
      { id: 'prize', label: 'Ce qu’on gagne', max: 200 },
      { id: 'winners', label: 'Combien de gagnants', value: '1', max: 2 },
      { id: 'duration', label: 'Durée (30m, 2h, 1j)', value: '1h', max: 10 },
      { id: 'role', label: 'Rôle requis (vide = tout le monde)', required: false, max: 100 },
    ]),
  );
}
async function giveawayComponent(i, ctx, [action, id]) {
  if (action === 'create') {
    if (!allowed(ctx.gid, ctx.user.id, '/giveaway', ctx.member)) throw new Error(SAY.denied);
    const prize = field(i, 'prize');
    const winners = Number(field(i, 'winners'));
    const ms = duration(field(i, 'duration'));
    const roleRaw = field(i, 'role');
    if (!Number.isInteger(winners) || winners < 1 || winners > 20) throw new Error('Le nombre de gagnants doit aller de 1 à 20.');
    if (!ms || ms < 60_000 || ms > 30 * 864e5) throw new Error('Durée incomprise. Écris `30m`, `2h` ou `3j` (1 minute à 30 jours).');
    const role = roleRaw
      ? ctx.guild.roles.cache.get(idOf(roleRaw)) || ctx.guild.roles.cache.find((r) => r.name.toLowerCase() === roleRaw.toLowerCase())
      : null;
    if (roleRaw && !role) throw new Error(`Rôle « ${roleRaw} » introuvable.`);
    const gw = {
      id: `${ctx.gid}-${now()}`,
      guild_id: ctx.gid,
      channel_id: ctx.channel.id,
      prize,
      winners,
      ends_at: now() + ms,
      created_by: ctx.user.id,
      entries: '[]',
      role_id: role?.id ?? null,
    };
    const sent = await ctx.channel.send(giveawayView(ctx.gid, gw));
    db.prepare(
      'INSERT INTO giveaways(id,guild_id,channel_id,message_id,prize,winners,ends_at,status,created_by,entries,role_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(gw.id, ctx.gid, ctx.channel.id, sent.id, prize, winners, gw.ends_at, 'open', ctx.user.id, '[]', gw.role_id);
    await log(ctx.guild, 'giveaway', {
      title: 'Giveaway lancé',
      tone: 'info',
      by: ctx.user,
      lines: [
        pair('Lot', prize),
        pair('Gagnants', winners),
        pair('Fin', `<t:${Math.floor(gw.ends_at / 1000)}:R>`),
        pair('Salon', `<#${ctx.channel.id}>`),
      ],
    });
    return i.reply(msg(ok(ctx, 'Giveaway lancé.', { title: 'Giveaway', emoji: E.gift }), { private: true }));
  }
  const gw = db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
  if (!gw) throw new Error('Ce giveaway n’existe plus.');
  if (action === 'join') {
    if (gw.status !== 'open') throw new Error('Ce giveaway est terminé.');
    if (gw.role_id && !ctx.member.roles.cache.has(gw.role_id)) throw new Error(`Il te faut le rôle <@&${gw.role_id}> pour participer.`);
    const entries = parse(gw.entries, []);
    const inside = entries.includes(ctx.user.id);
    const next = inside ? entries.filter((x) => x !== ctx.user.id) : [...entries, ctx.user.id];
    db.prepare('UPDATE giveaways SET entries=? WHERE id=?').run(json(next), gw.id);
    await i.update(giveawayView(ctx.gid, { ...gw, entries: json(next) }));
    return i.followUp(
      msg(info(ctx, inside ? 'Tu ne participes plus.' : 'Tu participes, bonne chance !', { title: 'Giveaway', emoji: E.gift }), {
        private: true,
      }),
    );
  }
  if (gw.created_by !== ctx.user.id && !allowed(ctx.gid, ctx.user.id, '/giveaway', ctx.member)) throw new Error(SAY.denied);
  if (action === 'end') {
    if (gw.status !== 'open') throw new Error('Ce giveaway est déjà terminé.');
    await i.deferUpdate();
    return endGiveaway(gw);
  }
  if (action === 'reroll') {
    if (!parse(gw.entries, []).length) throw new Error('Personne n’a participé, rien à retirer au sort.');
    await i.deferUpdate();
    return endGiveaway(gw, true);
  }
}

// Smash or pass
async function smashCmd(ctx) {
  const id = idOf(ctx.args[0]) || ctx.repliedTo;
  const target = id ? await member(ctx.guild, id) : null;
  if (!target) throw new Error('Usage : `=smash @membre`.');
  cooldown(`smash:${ctx.gid}:${ctx.user.id}`, 30_000);
  const sent = await ctx.channel.send(smashView(ctx.gid, target, { up: [], down: [] }));
  db.prepare('INSERT OR REPLACE INTO embeds(guild_id,key,payload,updated_at) VALUES(?,?,?,?)').run(
    ctx.gid,
    `smash:${sent.id}`,
    json({ target: target.id, up: [], down: [] }),
    now(),
  );
}
function smashView(gid, target, votes) {
  const embed = view(
    { gid },
    {
      title: 'Smash or pass',
      emoji: E.fire,
      text: `${target}`,
      thumbnail: target.displayAvatarURL({ size: 256 }),
      footer: `${plural(votes.up.length + votes.down.length, 'vote')}`,
    },
  );
  return {
    embeds: [embed],
    components: [
      row(button('sp:up', `Smash (${votes.up.length})`, 'vert', E.fire), button('sp:down', `Pass (${votes.down.length})`, 'rouge', '💨')),
    ],
    allowedMentions: { parse: [] },
  };
}
async function smashComponent(i, ctx, [action]) {
  const key = `smash:${i.message.id}`;
  const data = parse(db.prepare('SELECT payload FROM embeds WHERE guild_id=? AND key=?').get(ctx.gid, key)?.payload, null);
  if (!data) throw new Error(SAY.expired);
  if (data.target === ctx.user.id) throw new Error('Tu ne peux pas voter pour toi.');
  data.up = data.up.filter((x) => x !== ctx.user.id);
  data.down = data.down.filter((x) => x !== ctx.user.id);
  data[action === 'up' ? 'up' : 'down'].push(ctx.user.id);
  db.prepare('UPDATE embeds SET payload=?,updated_at=? WHERE guild_id=? AND key=?').run(json(data), now(), ctx.gid, key);
  const target = await member(ctx.guild, data.target);
  return target ? i.update(smashView(ctx.gid, target, data)) : i.deferUpdate();
}

// Stats vocales
const STATS = [
  ['membres', '👥', 'Membres'],
  ['enligne', '🌐', 'En ligne'],
  ['vocal', '🔊', 'Vocal'],
  ['lien', '🔗', null],
];
const renamed = new Map();
const counts = new Map();
async function statValues(g) {
  let hit = counts.get(g.id);
  if (!hit || now() - hit.at > 5 * 60_000) {
    const full = await g.client.guilds.fetch({ guild: g.id, withCounts: true, force: true }).catch(() => null);
    let link = g.vanityURLCode ? `.gg/${g.vanityURLCode}` : null;
    if (!link) {
      const invites = await g.invites.fetch().catch(() => null);
      const forever = invites?.find((x) => x.maxAge === 0 && x.maxUses === 0);
      if (forever) link = `.gg/${forever.code}`;
    }
    hit = { at: now(), online: full?.approximatePresenceCount ?? null, link };
    counts.set(g.id, hit);
  }
  const vocal = g.channels.cache.filter((c) => c.isVoiceBased()).reduce((n, c) => n + c.members.filter((m) => !m.user.bot).size, 0);
  return { membres: g.memberCount, enligne: hit.online, vocal, lien: hit.link };
}
export const statName = ([key, emoji, label], v) =>
  label ? `${emoji} · ${label} : ${v[key] == null ? '—' : Number(v[key]).toLocaleString('fr-FR')}` : `${emoji} · ${v[key] || 'Aucun lien'}`;
export async function updateStats(guild) {
  const g = bots.guard.guilds.cache.get(guild?.id) || bots.main.guilds.cache.get(guild?.id);
  if (!g || !cfg(g.id).stats.voice || !g.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) return;
  const view_ = [{ id: g.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] }];
  let c = cfg(g.id);
  let cat = c.stats.category ? g.channels.cache.get(c.stats.category) : null;
  if (!cat) {
    cat = await g.channels
      .create({ name: 'Statistiques', type: ChannelType.GuildCategory, position: 0, permissionOverwrites: view_, reason: 'Stats Dream' })
      .catch(() => null);
    if (!cat) return;
    c = setCfg(g.id, (x) => (x.stats.category = cat.id));
  }
  const v = await statValues(g);
  const ids = { ...(c.stats.channels || {}) };
  for (const s of STATS) {
    const name = statName(s, v);
    const ch = ids[s[0]] ? g.channels.cache.get(ids[s[0]]) : null;
    if (!ch) {
      const made = await g.channels
        .create({ name, type: ChannelType.GuildVoice, parent: cat.id, permissionOverwrites: view_, reason: 'Stats Dream' })
        .catch(() => null);
      if (made) {
        ids[s[0]] = made.id;
        renamed.set(made.id, now());
      }
      continue;
    }
    if (ch.name === name || now() - (renamed.get(ch.id) || 0) < 5 * 60_000) continue;
    renamed.set(ch.id, now());
    await ch.setName(name, 'Stats Dream').catch(() => {});
  }
  if (json(ids) !== json(c.stats.channels || {})) setCfg(g.id, (x) => (x.stats.channels = ids));
}
async function statsCmd(ctx) {
  const off = /^(off|non|stop)$/i.test(ctx.args[0] || '');
  if (off) {
    const c = cfg(ctx.gid);
    for (const id of [...Object.values(c.stats.channels || {}), c.stats.category].filter(Boolean))
      await ctx.guild.channels.cache
        .get(id)
        ?.delete('Stats coupées')
        .catch(() => {});
    setCfg(ctx.gid, (x) => (x.stats = { voice: false, category: null, channels: {} }));
    return ctx.send(msg(ok(ctx, 'Salons de stats retirés.', { title: 'Statistiques', emoji: E.stats })));
  }
  setCfg(ctx.gid, (x) => (x.stats.voice = true));
  await updateStats(ctx.guild);
  return ctx.send(
    msg(
      ok(ctx, 'Les salons de stats sont en haut du serveur et se mettent à jour tout seuls.\n`=stats off` pour les retirer.', {
        title: 'Statistiques',
        emoji: E.stats,
      }),
    ),
  );
}

// Fiches membres
async function userOf(ctx) {
  const id = idOf(ctx.args[0]) || ctx.repliedTo || ctx.user.id;
  return ctx.client.users.fetch(id, { force: true }).catch(() => null);
}
async function picture(ctx, kind) {
  const user = await userOf(ctx);
  if (!user) throw new Error('Utilisateur introuvable.');
  const url = kind === 'avatar' ? user.displayAvatarURL({ size: 1024 }) : user.bannerURL({ size: 1024 });
  if (!url) return ctx.send(msg(info(ctx, `<@${user.id}> n’a pas de bannière.`, { title: 'Image', emoji: E.image })));
  return ctx.send(msg(view(ctx, { author: { name: user.username, iconURL: user.displayAvatarURL() }, image: url, url })));
}
async function uiCmd(ctx) {
  const user = await userOf(ctx);
  if (!user) throw new Error('Aucun compte Discord ne correspond.');
  const m = await member(ctx.guild, user.id);
  const created = Math.floor(user.createdTimestamp / 1000);
  const joined = m?.joinedTimestamp ? Math.floor(m.joinedTimestamp / 1000) : null;
  const roles = m
    ? [...m.roles.cache.values()]
        .filter((r) => r.id !== ctx.gid)
        .sort((a, b) => b.position - a.position)
        .map((r) => `${r}`)
    : [];
  const banner = user.bannerURL({ size: 1024 });
  return ctx.send(
    msg(
      view(ctx, {
        author: { name: user.username, iconURL: user.displayAvatarURL() },
        text: m ? `**Compte :** <@${user.id}>` : `**Compte :** <@${user.id}>\n${small('N’est pas (ou plus) sur ce serveur.')}`,
        thumbnail: user.displayAvatarURL({ size: 256 }),
        image: banner ?? undefined,
        fields: [
          { name: 'Informations', value: `Pseudo : ${user.username}\nId :\n\`${user.id}\`` },
          { name: 'Rang', value: rankOf(ctx.gid, user.id, m) },
          { name: 'Vocal', value: m ? (m.voice.channel ? `En vocal dans ${m.voice.channel.name}` : 'Pas en vocal') : '—', inline: false },
          {
            name: 'Dates',
            value: [
              `Créé : <t:${created}:D> (<t:${created}:R>)`,
              joined ? `Rejoint : <t:${joined}:D> (<t:${joined}:R>)` : 'Rejoint : —',
            ].join('\n'),
            inline: false,
          },
          {
            name: `Rôles${roles.length ? ` (${roles.length})` : ''}`,
            value: (roles.join(' · ') || (m ? 'Aucun rôle' : '—')).slice(0, 1024),
            inline: false,
          },
        ],
      }),
    ),
  );
}
async function profilCmd(ctx) {
  const target = ctx.opt('membre') ?? ctx.user;
  if (target.id !== ctx.user.id && !allowed(ctx.gid, ctx.user.id, '=ui', ctx.member))
    throw new Error('Tu peux voir ton profil, pas celui des autres.');
  const m = await member(ctx.guild, target.id);
  const gid = ctx.gid;
  const cur = cfg(gid).payment.currency;
  const contrib = db.prepare('SELECT amount FROM contrib WHERE guild_id=? AND user_id=?').get(gid, target.id)?.amount ?? 0;
  const paid = db
    .prepare("SELECT COUNT(*) AS n,COALESCE(SUM(amount),0) AS total FROM payments WHERE guild_id=? AND user_id=? AND status='Payé'")
    .get(gid, target.id);
  const subs = db.prepare('SELECT label,until FROM subs WHERE guild_id=? AND user_id=?').all(gid, target.id);
  const sanctions = db.prepare('SELECT COUNT(*) AS n FROM sanctions WHERE guild_id=? AND target_id=?').get(gid, target.id).n;
  const staff = m
    ? staffRows(gid)
        .filter((s) => m.roles.cache.has(s.role_id))
        .map((s) => `<@&${s.role_id}>`)
    : [];
  return ctx.send(
    msg(
      panel(ctx, {
        title: `Profil de ${m?.displayName ?? target.username}`,
        emoji: E.user,
        thumbnail: target.displayAvatarURL({ size: 256 }),
        sections: [
          { emoji: E.crown, name: 'Rang', lines: [dot(rankOf(gid, target.id, m)), staff.length ? dot('Staff', staff.join(' ')) : null] },
          {
            emoji: E.money,
            name: 'Contribution',
            lines: [dot('Total crédité', money(contrib, cur)), dot('Paiements réglés', `${paid.n} · ${money(paid.total, cur)}`)],
          },
          {
            emoji: E.card,
            name: 'Abonnements',
            lines: subs.length
              ? subs.map((s) => dot(s.label, s.until ? `jusqu’au <t:${Math.floor(s.until / 1000)}:d>` : 'à vie'))
              : [dot('Aucun')],
          },
          sanctions ? { emoji: E.shield, name: 'Dossier', lines: [dot('Sanctions', sanctions)] } : null,
        ],
      }),
      { private: ctx.kind === 'slash' },
    ),
  );
}

// Lien du serveur
async function inviteCmd(ctx) {
  const g = acting(ctx.guild, PermissionFlagsBits.CreateInstantInvite);
  let link = g.vanityURLCode ? `https://discord.gg/${g.vanityURLCode}` : null;
  if (!link) {
    const invites = await g.invites.fetch().catch(() => null);
    const forever = invites?.find((x) => x.maxAge === 0 && x.maxUses === 0);
    if (forever) link = forever.url;
  }
  if (!link) {
    const ch =
      g.systemChannel ||
      g.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.permissionsFor(g.members.me)?.has(PermissionFlagsBits.CreateInstantInvite),
      );
    const made = ch
      ? await ch.createInvite({ maxAge: 0, maxUses: 0, unique: false, reason: `/invite par ${ctx.user.tag}` }).catch(() => null)
      : null;
    link = made?.url ?? null;
  }
  if (!link) throw new Error('Je ne peux pas créer de lien d’invitation ici.');
  return ctx.send(
    msg(view(ctx, { title: `Rejoindre ${ctx.guild.name}`, emoji: E.link, text: `${link}\n${small('Il ne périme pas, partage-le.')}` })),
  );
}

// Membres par rôle
function membersPage(ctx, role, mode) {
  const all = [...role.members.values()].filter((m) => mode !== 'seul' || m.roles.cache.filter((r) => r.id !== ctx.gid).size === 1);
  const lines = all.sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr')).map((m) => `${m} (\`${m.user.tag}\`)`);
  const extra = [
    row(
      button(`mb:mode:${role.id}:tous`, 'Tous ceux qui l’ont', mode === 'tous' ? 'bleu' : 'gris', null, mode === 'tous'),
      button(`mb:mode:${role.id}:seul`, 'Ce rôle seul', mode === 'seul' ? 'bleu' : 'gris', null, mode === 'seul'),
    ),
    row(pickRole('mb:pick', 'Un autre rôle')),
  ];
  return pager(ctx, {
    title: role.name,
    emoji: E.users,
    lines,
    per: 20,
    footer: mode === 'seul' ? 'Ce rôle seul' : 'Tous ceux qui l’ont',
    extra,
    empty: mode === 'seul' ? 'Personne n’a que ce rôle.' : 'Personne ne possède ce rôle.',
  });
}
async function membreCmd(ctx) {
  return ctx.send(
    msg(info(ctx, 'Qui veux-tu voir ?', { title: 'Membres', emoji: E.users }), {
      components: [row(pickRole('mb:pick', 'Choisis un rôle'))],
    }),
  );
}
async function membreComponent(i, ctx, [action, roleId, mode]) {
  if (!allowed(ctx.gid, ctx.user.id, '.membre', ctx.member)) throw new Error(SAY.denied);
  const id = action === 'pick' ? i.values[0] : roleId;
  if (!id) return i.deferUpdate();
  await ctx.guild.members.fetch().catch(() => {});
  const role = ctx.guild.roles.cache.get(id);
  if (!role) throw new Error('Ce rôle n’existe plus.');
  return i.update(membersPage(ctx, role, action === 'mode' ? mode : 'tous'));
}

// Faire parler
const SAY_MODES = { message: 'Message simple', embed: 'Embed', annonce: 'Annonce @everyone' };
async function sayCmd(ctx) {
  const mode = ctx.opt('mode') || 'message';
  const channel = ctx.opt('salon') || ctx.channel;
  if (!channel?.isTextBased?.()) throw new Error('Choisis un salon écrit.');
  if (mode === 'annonce' && rank(ctx.gid, ctx.user.id, ctx.member) < LEVEL.SYS)
    throw new Error('Les annonces @everyone sont réservées au rang SYS et au-dessus.');
  const fields = [{ id: 'text', label: 'Le message', long: true, max: 2000 }];
  if (mode === 'embed') {
    fields.unshift({ id: 'title', label: 'Titre', required: false, max: 200 });
    fields.push(
      { id: 'color', label: 'Couleur (Rose, Or… ou #hex)', required: false, max: 10 },
      { id: 'image', label: 'Image (lien)', required: false, max: 400 },
    );
  }
  return ctx.interaction.showModal(form(`say:send:${mode}:${channel.id}`, SAY_MODES[mode], fields));
}
async function sayComponent(i, ctx, [action, mode, channelId]) {
  if (action !== 'send' || !allowed(ctx.gid, ctx.user.id, '/say', ctx.member)) throw new Error(SAY.denied);
  const channel = acting(ctx.guild, PermissionFlagsBits.SendMessages).channels.cache.get(channelId);
  if (!channel?.isTextBased()) throw new Error('Ce salon n’existe plus.');
  const text = field(i, 'text');
  let payload;
  if (mode === 'message') payload = { content: text, allowedMentions: { parse: ['users'] } };
  else {
    const image = field(i, 'image');
    if (image && !/^https?:\/\/\S+$/i.test(image)) throw new Error('Le lien de l’image doit commencer par http.');
    const color = colorValue(field(i, 'color'));
    const embed = view(
      { gid: ctx.gid },
      {
        title: mode === 'annonce' ? 'Annonce' : field(i, 'title') || undefined,
        emoji: mode === 'annonce' ? '📣' : '',
        text,
        image: image || undefined,
        color: color ?? undefined,
        author: { name: ctx.guild.name, iconURL: ctx.guild.iconURL({ size: 64 }) ?? undefined },
        footer: { text: `Par ${ctx.member?.displayName || ctx.user.username}`, iconURL: ctx.user.displayAvatarURL({ size: 64 }) },
        timestamp: true,
      },
    );
    payload =
      mode === 'annonce'
        ? { content: '@everyone', embeds: [embed], allowedMentions: { parse: ['everyone'] } }
        : { embeds: [embed], allowedMentions: { parse: [] } };
  }
  await channel.send(payload);
  await log(ctx.guild, 'commande', {
    title: 'Message du bot',
    tone: 'info',
    by: ctx.user,
    lines: [pair('Type', SAY_MODES[mode]), pair('Salon', `<#${channel.id}>`)],
  });
  audit(ctx.gid, ctx.user.id, 'say', channel.id, { mode });
  return i.reply(msg(ok(ctx, `${SAY_MODES[mode]} publié dans <#${channel.id}>.`, { title: 'Message', emoji: E.pin }), { private: true }));
}

// Commandes
export const commands = [
  {
    name: '/profil',
    bot: 'main',
    section: 'tous',
    help: 'Ton profil',
    slash: { description: 'Ton profil', options: [{ type: 'user', name: 'membre', description: 'Voir quelqu’un d’autre' }] },
    run: profilCmd,
  },
  { name: '=ui', bot: 'main', section: 'tous', help: 'Fiche d’un membre', run: uiCmd },
  { name: '+pic', bot: 'main', section: 'tous', help: 'Photo de profil', run: (c) => picture(c, 'avatar') },
  { name: '+banner', bot: 'main', section: 'tous', help: 'Bannière', run: (c) => picture(c, 'banner') },
  {
    name: '/invite',
    bot: 'main',
    section: 'tous',
    help: 'Lien du serveur',
    slash: { description: 'Le lien du serveur', options: [] },
    run: inviteCmd,
  },
  { name: '.membre', bot: 'main', section: 'serveur', help: 'Membres par rôle', run: membreCmd },
  {
    name: '/say',
    bot: 'main',
    section: 'fun',
    help: 'Faire parler le bot',
    slash: {
      description: 'Faire parler le bot',
      options: [
        { type: 'string', name: 'mode', description: 'Message, embed ou annonce', choices: ['message', 'embed', 'annonce'] },
        { type: 'channel', name: 'salon', description: 'Où publier (vide : ici)' },
      ],
    },
    run: sayCmd,
  },
  {
    name: '/giveaway',
    bot: 'main',
    section: 'fun',
    help: 'Lancer un giveaway',
    slash: { description: 'Lancer un giveaway', options: [] },
    run: giveawayCmd,
  },
  { name: '=smash', bot: 'main', section: 'fun', help: 'Smash or pass', run: smashCmd },
  { name: '=ticket', bot: 'main', section: 'serveur', help: 'Panneau des tickets (`v2` : nouveau style)', run: ticketCmd },
  { name: '=reglement', bot: 'main', section: 'serveur', help: 'Règlement', run: (c) => c.send(rulesView(c)) },
  { name: '=panneau', bot: 'main', section: 'serveur', help: 'Panneaux de rôles', run: (c) => c.send(panelsView(c)) },
  { name: '=bienvenue', bot: 'guard', section: 'serveur', help: 'Message de bienvenue', run: (c) => c.send(welcomeView(c)) },
  { name: '=stats', bot: 'guard', section: 'serveur', help: 'Salons de stats (`off` pour couper)', run: statsCmd },
];
export const components = {
  tk: ticketComponent,
  wel: welcomeComponent,
  rule: rulesComponent,
  rp: panelComponent,
  gw: giveawayComponent,
  sp: smashComponent,
  mb: membreComponent,
  say: sayComponent,
};

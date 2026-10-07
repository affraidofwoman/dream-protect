import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { audit, cfg, changes, db, money, now, plural, setCfg, settingDel, settingSet } from './base.js';
import { bots, guildOf } from './bots.js';
import {
  GROUPS,
  LEVEL,
  RANKS,
  addStaff,
  allowed,
  emergencyOn,
  givenRank,
  isCreator,
  linkRank,
  rank,
  rankHolders,
  rankName,
  rankRows,
  removeStaff,
  setRank,
  setThreshold,
  staffRows,
  threshold,
} from './droits.js';
import { LOG_KEYS, MIRROR_DEFAULT, ensureTree, log, logCount, logHome, warn } from './logs.js';
import {
  E,
  PRESETS,
  SAY,
  bar,
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
  pickUser,
  postPanel,
  row,
  select,
  small,
  view,
} from './ui.js';

const field = (i, id) => i.fields.getTextInputValue(id)?.trim() ?? '';
const top = (m) => m?.roles?.highest?.position ?? -1;

// Hiérarchie
export function ladder(gid) {
  const ranks = rankRows(gid).map(
    (r) =>
      `🔒 **${r.name}**${r.role_id ? ` · <@&${r.role_id}>` : ''} · ${plural(rankHolders(gid).filter((h) => h.level === r.level).length, 'membre')}`,
  );
  const staff = staffRows(gid);
  const list = staff.length ? staff.map((x, n) => `\`${n + 1}.\` <@&${x.role_id}>`) : ['_Aucun rôle staff. Ajoute-les avec le menu._'];
  const guarded = db.prepare('SELECT role_id FROM protected_roles WHERE guild_id=?').all(gid).map((r) => `<@&${r.role_id}>`);
  return [...ranks, '', '**Staff** · du plus haut au plus bas', ...list, '', `**Rôles protégés** · ${guarded.join(' ') || 'aucun'}`].join('\n');
}
function ladderView(ctx) {
  const staff = staffRows(ctx.gid);
  return msg(
    view(ctx, {
      title: 'Hiérarchie',
      emoji: E.ladder,
      text: ladder(ctx.gid),
      footer: 'L’ordre du staff suit celui des rôles Discord. Personne n’agit sur un rang au-dessus du sien.',
    }),
    {
      components: [
        row(pickRole('hi:add', 'Ajouter des rôles au staff', 10)),
        row(
          select(
            'hi:del',
            'Retirer un rôle du staff',
            staff.map((x) => ({ label: x.name, value: x.role_id })),
          ),
        ),
        row(pickRole('hi:guard', 'Rôles protégés (seuls SYS et SYS+ les donnent)', 10)),
        row(
          select(
            'hi:rank',
            'Lier un rang à un rôle Discord',
            RANKS.map(([n]) => ({ label: n, value: n, description: 'Ce rôle donnera ce rang' })),
          ),
        ),
      ],
    },
  );
}
async function ladderComponent(i, ctx, [action, arg]) {
  if (!allowed(ctx.gid, ctx.user.id, '=hierarchie', ctx.member)) throw new Error(SAY.denied);
  const mine = rank(ctx.gid, ctx.user.id, ctx.member);
  if (action === 'add') {
    for (const id of i.values) {
      const role = ctx.guild.roles.cache.get(id);
      if (!isCreator(ctx.user.id) && ctx.guild.ownerId !== ctx.user.id && role.position >= top(ctx.member))
        throw new Error(`${role.name} est au-dessus de ton rôle le plus haut.`);
      addStaff(ctx.gid, role);
    }
    await log(ctx.guild, 'perm', {
      title: 'Staff mis à jour',
      tone: 'info',
      by: ctx.user,
      lines: [pair('Ajouté', i.values.map((x) => `<@&${x}>`).join(' '))],
    });
  }
  if (action === 'del') {
    const role = ctx.guild.roles.cache.get(i.values[0]);
    if (!isCreator(ctx.user.id) && role && ctx.guild.ownerId !== ctx.user.id && role.position >= top(ctx.member))
      throw new Error('Ce rôle est au-dessus du tien.');
    removeStaff(ctx.gid, i.values[0]);
    await log(ctx.guild, 'perm', {
      title: 'Staff mis à jour',
      tone: 'alerte',
      by: ctx.user,
      lines: [pair('Retiré', `<@&${i.values[0]}>`)],
    });
  }
  if (action === 'guard') {
    if (mine < LEVEL.SYS) throw new Error('Réservé au rang SYS et au-dessus.');
    db.prepare('DELETE FROM protected_roles WHERE guild_id=?').run(ctx.gid);
    for (const id of i.values) db.prepare('INSERT INTO protected_roles(guild_id,role_id,created_at) VALUES(?,?,?)').run(ctx.gid, id, now());
    await log(ctx.guild, 'perm', {
      title: 'Rôles protégés',
      tone: 'info',
      by: ctx.user,
      lines: [pair('Protégés', i.values.map((x) => `<@&${x}>`).join(' ') || 'aucun')],
    });
  }
  if (action === 'rank') {
    if (!isCreator(ctx.user.id) && LEVEL[i.values[0]] >= mine) throw new Error('Ce rang est au-dessus du tien.');
    return i.update(
      msg(
        info(ctx, `Quel rôle Discord donne le rang **${i.values[0]}** ? Ne rien choisir retire le lien.`, {
          title: 'Hiérarchie',
          emoji: E.ladder,
        }),
        { components: [row(pickRole(`hi:link:${i.values[0]}`, 'Rôle lié'))] },
      ),
    );
  }
  if (action === 'link') {
    if (!isCreator(ctx.user.id) && LEVEL[arg] >= mine) throw new Error('Ce rang est au-dessus du tien.');
    linkRank(ctx.gid, arg, i.values[0] ?? null);
    await log(ctx.guild, 'perm', {
      title: 'Rang lié',
      tone: 'info',
      by: ctx.user,
      lines: [pair('Rang', arg), pair('Rôle', i.values[0] ? `<@&${i.values[0]}>` : 'aucun')],
    });
  }
  audit(ctx.gid, ctx.user.id, `ladder.${action}`, i.values?.join(','));
  return i.update(ladderView(ctx));
}

// Droits
function rightsView(ctx) {
  return msg(
    panel(ctx, {
      title: 'Droits des commandes',
      emoji: E.key,
      intro: 'Chaque groupe s’ouvre **à partir** d’un rôle staff ou d’un rang. Tout ce qui est au-dessus y a accès.',
      sections: Object.entries(GROUPS).map(([key, g]) => {
        const t = threshold(ctx.gid, key);
        return {
          emoji: g.emoji,
          name: `${g.label} — à partir de ${t.label}${t.custom ? '' : ' (défaut)'}`,
          lines: [small(g.commands.join(' · '))],
        };
      }),
    }),
    {
      components: [
        row(
          select(
            'dr:group',
            'Groupe à régler',
            Object.entries(GROUPS).map(([k, g]) => ({
              label: g.label,
              value: k,
              emoji: g.emoji,
              description: `À partir de ${threshold(ctx.gid, k).label.replace(/<@&\d+>/, 'un rôle')}`,
            })),
          ),
        ),
      ],
    },
  );
}
async function rightsComponent(i, ctx, [action, key]) {
  if (!allowed(ctx.gid, ctx.user.id, '=droits', ctx.member)) throw new Error(SAY.denied);
  const mine = rank(ctx.gid, ctx.user.id, ctx.member);
  if (action === 'group') {
    const k = i.values[0];
    if (!isCreator(ctx.user.id) && threshold(ctx.gid, k).level > mine) throw new Error('Ce groupe est réglé au-dessus de ton rang.');
    if (k === 'config' && mine < LEVEL['SYS+']) throw new Error('Seul SYS+ règle la configuration.');
    const options = [
      { label: 'Par défaut', value: 'reset', emoji: '↩️' },
      { label: 'Tout le staff', value: 'staff', emoji: E.users },
      ...staffRows(ctx.gid)
        .filter((s) => s.level < mine || isCreator(ctx.user.id))
        .slice(0, 19)
        .map((s) => ({ label: `À partir de ${s.name}`, value: s.role_id, emoji: E.role })),
      ...RANKS.filter(([, v]) => v <= mine).map(([n]) => ({ label: `À partir de ${n}`, value: n, emoji: E.crown })),
    ];
    return i.update(
      msg(
        info(ctx, `À partir de qui **${GROUPS[k].label}** est ouvert ?\n${small(GROUPS[k].commands.join(' · '))}`, {
          title: 'Droits',
          emoji: GROUPS[k].emoji,
        }),
        { components: [row(select(`dr:set:${k}`, 'À partir de…', options))] },
      ),
    );
  }
  if (action === 'set') {
    const v = i.values[0];
    setThreshold(ctx.gid, key, v === 'reset' ? null : v);
    if (key === 'config' && threshold(ctx.gid, 'config').level < LEVEL.OWNER) {
      setThreshold(ctx.gid, key, null);
      throw new Error('La configuration reste réservée aux rangs OWNER et au-dessus.');
    }
    await log(ctx.guild, 'perm', {
      title: 'Droits modifiés',
      tone: 'info',
      by: ctx.user,
      lines: [pair('Groupe', GROUPS[key].label), pair('À partir de', threshold(ctx.gid, key).label)],
    });
    audit(ctx.gid, ctx.user.id, 'rights.set', key, { value: v });
    return i.update(rightsView(ctx));
  }
}

// Rangs
function wlView(ctx, targetId = null) {
  const mine = rank(ctx.gid, ctx.user.id, ctx.member);
  const holders = rankHolders(ctx.gid);
  const sections = RANKS.map(([name, level]) => ({
    emoji: E.crown,
    name,
    lines: holders.filter((h) => h.level === level).map((h) => `• <@${h.user_id}>`),
  }));
  if (!targetId) {
    return msg(
      panel(ctx, {
        title: 'Rangs',
        emoji: E.key,
        intro: 'Choisis quelqu’un pour lui donner ou retirer un rang.',
        sections,
        outro: holders.length ? null : '_Personne n’a de rang pour l’instant._',
      }),
      { private: true, components: [row(pickUser('wl:who'))] },
    );
  }
  const current = givenRank(ctx.gid, targetId);
  const options = [
    ...RANKS.filter(([, v]) => v < mine || isCreator(ctx.user.id)).map(([n]) => ({
      label: n,
      value: n,
      emoji: E.crown,
      default: LEVEL[n] === current,
    })),
    { label: 'Aucun rang', value: 'none', emoji: '🚫' },
  ];
  return msg(
    info(ctx, `<@${targetId}> · rang actuel : **${current > 0 ? rankName(ctx.gid, current) : 'aucun'}**`, { title: 'Rangs', emoji: E.key }),
    {
      private: true,
      components: [row(select(`wl:set:${targetId}`, 'Rang à donner', options)), row(pickUser('wl:who', 'Quelqu’un d’autre'))],
    },
  );
}
async function wlComponent(i, ctx, [action, targetId]) {
  if (!allowed(ctx.gid, ctx.user.id, '/wl', ctx.member)) throw new Error(SAY.denied);
  if (action === 'who') return i.update(wlView(ctx, i.values[0]));
  const value = i.values[0];
  const mine = rank(ctx.gid, ctx.user.id, ctx.member);
  const before = givenRank(ctx.gid, targetId);
  const target = await ctx.guild.members.fetch(targetId).catch(() => null);
  if (targetId === ctx.user.id) throw new Error(SAY.self);
  if (!isCreator(ctx.user.id)) {
    if (before >= mine || rank(ctx.gid, targetId, target) >= mine) throw new Error(SAY.above);
    if (value !== 'none' && LEVEL[value] >= mine) throw new Error('Tu ne peux pas donner un rang égal ou supérieur au tien.');
  }
  if (isCreator(targetId)) throw new Error('Ce compte est protégé.');
  setRank(ctx.gid, targetId, value === 'none' ? null : value);
  const label = value === 'none' ? rankName(ctx.gid, before) : value;
  if (value === 'none' && before > 0) await warn(ctx.guild, targetId, 'rank', 'off', { label });
  if (value !== 'none') await warn(ctx.guild, targetId, 'rank', 'on', { label });
  await log(ctx.guild, 'wl', {
    title: value === 'none' ? 'Rang retiré' : 'Rang donné',
    tone: value === 'none' ? 'alerte' : 'ok',
    by: ctx.user,
    lines: [
      pair('Membre', `<@${targetId}>`),
      pair('Avant', before > 0 ? rankName(ctx.gid, before) : 'aucun'),
      pair('Après', value === 'none' ? 'aucun' : value),
    ],
  });
  audit(ctx.gid, ctx.user.id, 'rank.set', targetId, { value });
  return i.update(wlView(ctx, targetId));
}

// Logs
async function logsView(ctx) {
  const list = [];
  for (const g of new Map([...bots.main.guilds.cache, ...bots.guard.guilds.cache]).values()) {
    if (!g.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) continue;
    if (isCreator(ctx.user.id) || g.ownerId === ctx.user.id) list.push(g);
    else if ((await g.members.fetch(ctx.user.id).catch(() => null))?.permissions.has(PermissionFlagsBits.ManageGuild)) list.push(g);
  }
  const home = logHome(ctx.guild);
  const m = cfg(ctx.gid).logMirror;
  return msg(
    view(ctx, {
      title: 'Logs',
      emoji: E.logs,
      lines: [
        pair(
          'Serveur des logs',
          home
            ? `**${home.name}** · ${bar(logCount(ctx.guild), LOG_KEYS.size)} ${logCount(ctx.guild)}/${LOG_KEYS.size}`
            : '_aucun, rien n’est journalisé_',
        ),
        pair('Double log ici', m?.channelId ? `<#${m.channelId}> (${(m.keys ?? MIRROR_DEFAULT).join(', ')})` : '_non_'),
        '',
        small('Les salons sont créés sur le serveur choisi, jamais ici sans ton accord.'),
      ],
    }),
    {
      components: [
        row(
          select(
            'lg:home',
            'Serveur des logs',
            list.map((g) => ({
              label: g.name,
              value: g.id,
              description: g.id === ctx.gid ? 'Ce serveur' : `${g.memberCount} membres`,
              default: g.id === home?.id,
            })),
          ),
        ),
        row(pickChannel('lg:mirror', 'Double log : salon de ce serveur', [ChannelType.GuildText])),
        row(
          button('lg:repair', 'Réparer les salons', 'bleu', '🛠️', !home),
          button('lg:nomirror', 'Couper le double log', 'gris', null, !m?.channelId),
        ),
      ],
    },
  );
}
async function logsComponent(i, ctx, [action]) {
  if (!allowed(ctx.gid, ctx.user.id, '=logs', ctx.member)) throw new Error(SAY.denied);
  if (action === 'home' || action === 'repair') {
    const home =
      action === 'home' ? bots.guard.guilds.cache.get(i.values[0]) || bots.main.guilds.cache.get(i.values[0]) : logHome(ctx.guild);
    if (!home) throw new Error('Serveur introuvable. Les deux bots doivent y être.');
    const member = await home.members.fetch(ctx.user.id).catch(() => null);
    if (!isCreator(ctx.user.id) && home.ownerId !== ctx.user.id && !member?.permissions.has(PermissionFlagsBits.ManageGuild))
      throw new Error('Il te faut « Gérer le serveur » là-bas.');
    await i.deferUpdate();
    const r = await ensureTree(home);
    setCfg(ctx.gid, (c) => (c.logGuild = home.id));
    if (!cfg(home.id).logGuild) setCfg(home.id, (c) => (c.logGuild = home.id));
    await log(ctx.guild, 'sante', {
      title: 'Logs branchés',
      tone: 'ok',
      by: ctx.user,
      lines: [pair('Serveur suivi', ctx.guild.name), pair('Salons créés', r.created), pair('Déjà là', r.kept)],
    });
    audit(ctx.gid, ctx.user.id, 'logs.home', home.id, r);
    return i.editReply(await logsView(ctx));
  }
  if (action === 'mirror') setCfg(ctx.gid, (c) => (c.logMirror = { channelId: i.values[0], keys: MIRROR_DEFAULT }));
  if (action === 'nomirror') setCfg(ctx.gid, (c) => (c.logMirror = null));
  audit(ctx.gid, ctx.user.id, `logs.${action}`);
  return i.update(await logsView(ctx));
}

// Couleurs
const presetOptions = (id) =>
  select(id, 'Choisis une couleur', [
    ...Object.entries(PRESETS).map(([n, hex]) => ({ label: n, value: n, description: hex })),
    { label: 'Retirer', value: 'none', emoji: '↩️' },
  ]);
function colorsView(ctx) {
  const c = cfg(ctx.gid).theme;
  const overrides = db.prepare("SELECT scope,scope_id,value FROM settings WHERE guild_id=? AND key='color'").all(ctx.gid);
  const label = (o) =>
    o.scope === 'ROLE'
      ? `<@&${o.scope_id}>`
      : o.scope === 'USER'
        ? `<@${o.scope_id}>`
        : o.scope === 'WL'
          ? `rang ${o.scope_id}`
          : o.scope === 'COMMAND'
            ? `\`${o.scope_id}\``
            : 'serveur';
  return msg(
    panel(ctx, {
      title: 'Couleurs',
      emoji: E.paint,
      intro: 'L’ordre de priorité : serveur, puis rôle, rang, membre et enfin commande.',
      sections: [
        { emoji: '🌐', name: 'Serveur', lines: [dot(c.preset || c.color)] },
        {
          emoji: '🎯',
          name: 'Couleurs ciblées',
          lines: overrides.length ? overrides.map((o) => dot(label(o), JSON.parse(o.value).v)) : [dot('Aucune')],
        },
      ],
      outro: small(Object.keys(PRESETS).join(' · ')),
    }),
    {
      components: [
        row(presetOptions('cl:server')),
        row(pickRole('cl:role', 'Couleur pour un rôle')),
        row(pickUser('cl:user', 'Couleur pour un membre')),
        row(
          select(
            'cl:rank',
            'Couleur pour un rang',
            RANKS.map(([n]) => ({ label: n, value: n })),
          ),
        ),
        row(button('cl:hex', 'Code couleur', 'gris', '#️⃣'), button('cl:cmd', 'Couleur d’une commande', 'gris', '⌨️')),
      ],
    },
  );
}
async function colorsComponent(i, ctx, [action, scope, id]) {
  if (!allowed(ctx.gid, ctx.user.id, '=couleur', ctx.member)) throw new Error(SAY.denied);
  if (action === 'server') setCfg(ctx.gid, (c) => (c.theme.preset = i.values[0] === 'none' ? null : i.values[0]));
  if (action === 'role' || action === 'user' || action === 'rank') {
    const target = i.values[0];
    if (!target) return i.update(colorsView(ctx));
    const sc = { role: 'ROLE', user: 'USER', rank: 'WL' }[action];
    return i.update(
      msg(
        info(ctx, `Couleur pour ${action === 'role' ? `<@&${target}>` : action === 'user' ? `<@${target}>` : `le rang **${target}**`} ?`, {
          title: 'Couleurs',
          emoji: E.paint,
        }),
        { components: [row(presetOptions(`cl:set:${sc}:${target}`))] },
      ),
    );
  }
  if (action === 'set') {
    if (i.values[0] === 'none') settingDel(ctx.gid, scope, id, 'color');
    else settingSet(ctx.gid, scope, id, 'color', i.values[0]);
  }
  if (action === 'hex')
    return i.showModal(
      form('cl:hexsave', 'Couleur du serveur', [
        { id: 'hex', label: 'Code hexadécimal (#5865F2)', value: cfg(ctx.gid).theme.color, max: 7 },
      ]),
    );
  if (action === 'hexsave') {
    const hex = field(i, 'hex');
    if (!/^#?[0-9a-f]{6}$/i.test(hex)) throw new Error('Code invalide, exemple : `#5865F2`.');
    setCfg(ctx.gid, (c) => {
      c.theme.color = hex.startsWith('#') ? hex : `#${hex}`;
      c.theme.preset = null;
    });
  }
  if (action === 'cmd')
    return i.showModal(
      form('cl:cmdsave', 'Couleur d’une commande', [
        { id: 'cmd', label: 'Commande (ex : =ui ou /profil)', max: 30 },
        { id: 'color', label: `Couleur (${Object.keys(PRESETS).slice(0, 3).join(', ')}… ou #hex)`, max: 10 },
      ]),
    );
  if (action === 'cmdsave') {
    const value = field(i, 'color');
    if (!PRESETS[value] && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Couleur inconnue.');
    settingSet(ctx.gid, 'COMMAND', field(i, 'cmd').toLowerCase(), 'color', value);
  }
  audit(ctx.gid, ctx.user.id, `color.${action}`);
  return i.isModalSubmit() ? i.reply(colorsView(ctx)) : i.update(colorsView(ctx));
}

// Tableaux
let registry = [];
export const setRegistry = (list) => (registry = list);
export const TABLES = [
  ['acces', '🔐 Tableau des accès'],
  ['commandes', '📋 Tableau des commandes'],
  ['wl', '🛡️ Tableau WL'],
  ['hierarchie', '📚 Tableau hiérarchie'],
  ['protect', '🛰️ Tableau Protect'],
  ['paiements', '💳 Tableau paiements'],
  ['prix', '💰 Tableau prix'],
  ['roles', '🎨 Tableau rôles'],
  ['config', '⚙️ Tableau configuration'],
];
const head = (name, value) => `**${name}** : ${value}`;
const cut = (lines, max = 20) => (lines.length > max ? [...lines.slice(0, max), small(`… et ${lines.length - max} de plus`)] : lines);
export function tableBody(guild, key) {
  const gid = guild.id;
  const c = cfg(gid);
  const cur = c.payment.currency;
  if (key === 'acces')
    return Object.entries(GROUPS)
      .map(([k, g]) => `${g.emoji} **${g.label}** — à partir de ${threshold(gid, k).label}\n${small(g.commands.join(' · '))}`)
      .join('\n');
  if (key === 'commandes') {
    const by = (bot) =>
      registry
        .filter((x) => x.bot === bot && x.help)
        .map((x) => `\`${x.name}\``)
        .join(' ');
    return [`🌙 **Commu Dream**\n${by('main')}`, '', `🛡️ **Dream Protect**\n${by('guard')}`].join('\n');
  }
  if (key === 'wl')
    return RANKS.map(
      ([n, v]) =>
        `👑 **${n}**\n${
          cut(
            rankHolders(gid)
              .filter((h) => h.level === v)
              .map((h) => `• <@${h.user_id}>`),
          ).join('\n') || small('personne')
        }`,
    ).join('\n\n');
  if (key === 'hierarchie') return ladder(gid);
  if (key === 'protect') {
    const reserved = db.prepare('SELECT channel_id FROM protected_channels WHERE guild_id=?').all(gid);
    const roles = db.prepare('SELECT role_id FROM protected_roles WHERE guild_id=?').all(gid);
    const locks = db.prepare('SELECT COUNT(*) AS n FROM locks WHERE guild_id=?').get(gid).n;
    const words = db.prepare('SELECT COUNT(*) AS n FROM badwords WHERE guild_id=?').get(gid).n;
    return [
      pair('Urgence', emergencyOn(gid) ? '🚨 **ACTIVE**' : '🟢 calme'),
      pair('Protection des rôles', c.protect.roles ? '🟢 active' : '🔴 coupée'),
      pair('Filtre de mots', `${c.badwordsOff ? '🔴 coupé' : '🟢 actif'} · ${plural(words, 'mot')}`),
      pair('Salons verrouillés', locks),
      '',
      head('Rôles protégés', roles.map((r) => `<@&${r.role_id}>`).join(' ') || 'aucun'),
      head('Salons réservés', reserved.map((r) => `<#${r.channel_id}>`).join(' ') || 'aucun'),
    ].join('\n');
  }
  if (key === 'paiements') {
    const rows = db
      .prepare('SELECT status,COUNT(*) AS n,COALESCE(SUM(amount),0) AS total FROM payments WHERE guild_id=? GROUP BY status')
      .all(gid);
    const last = db.prepare('SELECT * FROM payments WHERE guild_id=? ORDER BY created_at DESC LIMIT 8').all(gid);
    const max = Math.max(1, ...rows.map((x) => x.n));
    return [
      ...rows.map((x) => `${bar(x.n, max, 8)} **${x.status}** · ${x.n} · ${money(x.total, cur)}`),
      '',
      '**Derniers mouvements**',
      ...(last.length
        ? last.map((p) => `\`#${p.id}\` <@${p.user_id}> · ${p.label} · ${money(p.amount, cur)} · ${p.status}`)
        : [small('aucun')]),
    ].join('\n');
  }
  if (key === 'prix') {
    const rows = db.prepare('SELECT * FROM prices WHERE guild_id=? AND active=1 ORDER BY amount DESC').all(gid);
    const kinds = { perm: '🎭 Rôles', acces: '🔑 Whitelists', abo: '💳 Abonnements' };
    return Object.entries(kinds)
      .map(
        ([k, n]) =>
          `**${n}**\n${
            rows
              .filter((p) => p.key.startsWith(`${k}:`))
              .map((p) => `• ${p.label} — **${money(p.amount, cur)}**`)
              .join('\n') || small('rien')
          }`,
      )
      .join('\n\n');
  }
  if (key === 'roles') {
    const panels = Object.entries(c.panels || {}).map(([k, ids]) => `${k} : ${ids.map((id) => `<@&${id}>`).join(' ') || '—'}`);
    return [
      head(
        'Staff',
        staffRows(gid)
          .map((s) => `<@&${s.role_id}>`)
          .join(' ') || 'aucun',
      ),
      head(
        'Rangs liés',
        rankRows(gid)
          .map((r) => `${r.name} ${r.role_id ? `<@&${r.role_id}>` : '—'}`)
          .join(' · '),
      ),
      head('Arrivée', c.welcome.roleId ? `<@&${c.welcome.roleId}>` : 'aucun'),
      head('Règlement', c.rules.roleId ? `<@&${c.rules.roleId}>` : 'aucun'),
      head('Panneaux', panels.join('\n') || 'aucun'),
    ].join('\n');
  }
  if (key === 'config') {
    const home = logHome(guild);
    return [
      pair('Logs', home ? `${home.name} · ${logCount(guild)}/${LOG_KEYS.size}` : 'non branchés'),
      pair('Double log', c.logMirror?.channelId ? `<#${c.logMirror.channelId}>` : 'non'),
      pair('Bienvenue', c.welcome.channelId ? `<#${c.welcome.channelId}>` : 'coupée'),
      pair('Vocaux temporaires', c.voice.creatorId ? `<#${c.voice.creatorId}>` : 'non'),
      pair('Stats vocales', c.stats.voice ? 'oui' : 'non'),
      pair('Tickets', c.ticket.categoryId ? `<#${c.ticket.categoryId}>` : 'catégorie auto'),
      pair('Couleur', c.theme.preset || c.theme.color),
      pair('Moyens de paiement', c.payment.methods.join(', ')),
    ].join('\n');
  }
  return '—';
}
export async function refreshTables(guild) {
  const g = guildOf(guild.id);
  const home = db.prepare("SELECT channel_id FROM panels WHERE guild_id=? AND key='tables'").get(g.id);
  const ch = home?.channel_id ? g.channels.cache.get(home.channel_id) : null;
  if (!ch?.isTextBased()) return 0;
  let n = 0;
  for (const [key, title] of TABLES) {
    let body;
    try {
      body = tableBody(g, key);
    } catch {
      body = 'Tableau indisponible pour le moment.';
    }
    const embed = view({ gid: g.id }, { title, text: String(body).slice(0, 4000) || '—', footer: 'Mis à jour', timestamp: true });
    if (
      await postPanel(g, `table:${key}`, ch, { embeds: [embed] })
        .then(() => true)
        .catch(() => false)
    )
      n++;
  }
  return n;
}
const pending = new Map();
export function scheduleTables(guildId) {
  if (pending.has(guildId)) return;
  pending.set(
    guildId,
    setTimeout(() => {
      pending.delete(guildId);
      const g = guildOf(guildId);
      if (g) refreshTables(g).catch(() => {});
    }, 5000),
  );
}
changes.on('guild', scheduleTables);
async function tablesCmd(ctx) {
  const before = db.prepare("SELECT channel_id FROM panels WHERE guild_id=? AND key='tables'").get(ctx.gid)?.channel_id;
  if (before && before !== ctx.channel.id) {
    const old = guildOf(ctx.gid)?.channels.cache.get(before);
    for (const r of db.prepare("SELECT message_id FROM panels WHERE guild_id=? AND key LIKE 'table:%'").all(ctx.gid)) {
      await old?.messages.delete(r.message_id).catch(() => {});
    }
    db.prepare("DELETE FROM panels WHERE guild_id=? AND key LIKE 'table:%'").run(ctx.gid);
  }
  db.prepare(
    "INSERT INTO panels(guild_id,key,channel_id,message_id,updated_at) VALUES(?,'tables',?,NULL,?) ON CONFLICT(guild_id,key) DO UPDATE SET channel_id=excluded.channel_id,updated_at=excluded.updated_at",
  ).run(ctx.gid, ctx.channel.id, now());
  await ctx.message?.delete().catch(() => {});
  const n = await refreshTables(ctx.guild);
  await log(ctx.guild, 'sante', {
    title: 'Tableaux posés',
    tone: 'ok',
    by: ctx.user,
    lines: [pair('Salon', `<#${ctx.channel.id}>`), pair('Tableaux', `${n}/${TABLES.length}`)],
  });
}

// Commandes
export const commands = [
  { name: '=hierarchie', bot: 'guard', section: 'serveur', help: 'Hiérarchie du staff', run: (c) => c.send(ladderView(c)) },
  { name: '=droits', bot: 'guard', section: 'serveur', help: 'Qui peut quoi', run: (c) => c.send(rightsView(c)) },
  {
    name: '/wl',
    bot: 'guard',
    section: 'acces',
    help: 'Donner un rang',
    slash: { description: 'Donner ou retirer un rang', options: [{ type: 'user', name: 'personne', description: 'Qui' }] },
    run: (c) => c.send(wlView(c, c.opt('personne')?.id ?? null)),
  },
  { name: '=logs', bot: 'guard', section: 'serveur', help: 'Salons de logs', run: async (c) => c.send(await logsView(c)) },
  { name: '=couleur', bot: 'guard', section: 'serveur', help: 'Couleurs', run: (c) => c.send(colorsView(c)) },
  { name: '=tableaux', bot: 'guard', section: 'serveur', help: 'Tableaux permanents ici', run: tablesCmd },
];
export const components = { hi: ladderComponent, dr: rightsComponent, wl: wlComponent, lg: logsComponent, cl: colorsComponent };

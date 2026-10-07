import { ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { burst, cfg, changes, db, json, now, parse, sleep } from './base.js';
import { bots } from './bots.js';
import { journal, notice } from './ui.js';

// Structure des logs
export const LOG_TREE = [
  [
    'Logs · Sanctions',
    [
      ['wet', 'wet-log', 'Bans globaux /wet, posés et levés'],
      ['bl', 'bl-log', 'Blacklist &bl et &unbl'],
      ['ban', 'ban-log', 'Bannissements +ban, +unban, +unbanall'],
      ['badword', 'badword-log', 'Messages coupés par le filtre'],
      ['clear', 'clear-log', 'Messages effacés avec &clear'],
    ],
  ],
  [
    'Logs · Rôles & Accès',
    [
      ['role', 'role-log', 'Rôles donnés ou retirés'],
      ['wl', 'wl-log', 'Rangs donnés ou retirés (/wl, &derank)'],
      ['perm', 'perm-log', 'Hiérarchie et droits des commandes'],
      ['abo', 'abo-log', 'Abonnements'],
      ['autorole', 'autorole-log', 'Rôles donnés à l’arrivée'],
    ],
  ],
  [
    'Logs · Économie',
    [
      ['contrib', 'contrib-log', 'Contributions créditées'],
      ['vente', 'vente-log', 'Ventes et prix'],
      ['paiement', 'paiement-log', 'Paiements et statuts'],
    ],
  ],
  ['Logs · Tickets', [['ticket', 'ticket-logs', 'Ouverture, fermeture et transcript']]],
  [
    'Logs · Serveur',
    [
      ['membre', 'membre-log', 'Arrivées et départs'],
      ['salon', 'salon-log', 'Salons créés, modifiés, supprimés'],
      ['commande', 'commande-log', 'Commandes utilisées'],
      ['backup', 'backup-log', 'Sauvegardes de la base'],
      ['bataillon', 'bataillon-log', 'Rangs du staff synchronisés'],
      ['sante', 'sante-log', 'État des bots et alertes'],
    ],
  ],
  [
    'Logs · Fun & Vocal',
    [
      ['dog', 'dog-log', 'Laisses /dog-add et /dog-del'],
      ['giveaway', 'giveaway-log', 'Giveaways lancés et tirés'],
    ],
  ],
];
export const LOG_KEYS = new Map(LOG_TREE.flatMap(([, list]) => list.map(([key, name]) => [key, name])));
export const MIRROR_DEFAULT = ['ticket', 'ban', 'bl', 'wet'];
const QUIET = new Set(['commande', 'badword', 'clear', 'membre', 'salon', 'sante']);

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
    {
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];
  let created = 0;
  let kept = 0;
  for (const [catName, list] of LOG_TREE) {
    let cat = home.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === catName);
    if (!cat) {
      cat = await home.channels.create({
        name: catName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: hidden,
        reason: 'Logs Dream',
      });
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
  if (!QUIET.has(key)) changes.emit('guild', guild.id);
  const lines = [...(o.lines || [])];
  const ch = logChannel(guild, key);
  if (ch && ch.guild.id !== guild.id) lines.push(`**Serveur** : ${guild.name}`);
  const embed = journal({ ...o, lines });
  const payload = { embeds: [embed], files: o.files || [], allowedMentions: { parse: [] } };
  let sent = null;
  if (ch) {
    sent = await ch.send(payload).catch(() => null);
    if (sent) {
      db.prepare(
        'INSERT OR REPLACE INTO log_messages(guild_id,message_id,channel_id,category,title,description,actor_id,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(ch.guild.id, sent.id, ch.id, key, o.title || 'Log', json(embed.toJSON()), o.by?.id ?? null, 'OK', now());
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
  embeds.push(
    journal({
      title: 'Log supprimé puis remis',
      tone: 'alerte',
      lines: [actorId ? `**Par** : <@${actorId}>` : '**Par** : inconnu', 'Les logs ne se suppriment pas.'],
    }),
  );
  const back = await ch.send({ embeds, allowedMentions: { parse: [] } }).catch(() => null);
  db.prepare('DELETE FROM log_messages WHERE message_id=?').run(message.id);
  if (back) {
    db.prepare(
      'INSERT OR REPLACE INTO log_messages(guild_id,message_id,channel_id,category,title,description,actor_id,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(rec.guild_id, back.id, rec.channel_id, rec.category, rec.title, rec.description, rec.actor_id, 'RESTORED', now());
  }
  return !!back;
}

// Avis en MP
const NOTICES = {
  ban: { on: (w) => `Tu as été **banni** de ${w}.`, off: (w) => `Ton bannissement de ${w} a été **levé**. Tu peux revenir quand tu veux.` },
  bl: {
    on: (w) => `Tu as été **blacklist** de ${w} définitivement.`,
    off: (w) => `Tu as été **retiré de la blacklist** de ${w}. Tu peux revenir.`,
  },
  wet: { on: () => 'Tu as été **banni de tous les serveurs** Dream.', off: () => 'Ton **wet** a été levé, les serveurs te sont rouverts.' },
  derank: { on: (w) => `Tes **rôles staff** sur ${w} t’ont été retirés.` },
  abo: { off: (w, o) => `Ton abonnement **${o.label}** sur ${w} est arrivé à son terme. Ouvre un ticket pour le renouveler.` },
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
  const good = (action === 'off' && type !== 'abo') || type === 'rank';
  for (const client of [bots.guard, bots.main]) {
    if (!client.isReady()) continue;
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) continue;
    const sent = await user.send({ embeds: [notice({ good, text: lines.join('\n'), guildName: guild.name })] }).catch(() => null);
    if (sent) return true;
  }
  return false;
}

// Transcript HTML
const esc = (t) =>
  String(t ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
function readable(text, guild) {
  return String(text || '')
    .replace(
      /<@!?(\d+)>/g,
      (_, id) => `@${guild.members.cache.get(id)?.displayName || guild.client.users.cache.get(id)?.username || 'membre'}`,
    )
    .replace(/<@&(\d+)>/g, (_, id) => `@${guild.roles.cache.get(id)?.name || 'rôle'}`)
    .replace(/<#(\d+)>/g, (_, id) => `#${guild.channels.cache.get(id)?.name || 'salon'}`)
    .replace(/<a?:(\w+):\d+>/g, ':$1:');
}
const CSS = [
  ':root{--neon:#7b5cff;--clair:#a68cff;--cyan:#46c8ff;--fond:#07080d;--panneau:#0e1018;--bord:#241b4d;--texte:#e7e6f5;--doux:#9a97c0}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#14122b 0%,var(--fond) 60%) fixed;color:var(--texte);font-family:"gg sans","Segoe UI",system-ui,Arial,sans-serif}',
  '.wrap{max-width:860px;margin:0 auto;padding:24px 18px 64px}',
  '.entete{border:1px solid var(--bord);border-radius:16px;padding:20px 24px;background:linear-gradient(180deg,rgba(123,92,255,.10),rgba(123,92,255,0));box-shadow:0 0 40px rgba(123,92,255,.15);margin-bottom:20px}',
  '.titre{font-size:19px;font-weight:800;letter-spacing:.16em}',
  '.titre b{color:var(--clair)}',
  '.salon{margin-top:12px;font-size:15px;color:var(--clair);font-weight:700}',
  '.meta{margin-top:3px;font-size:12.5px;color:var(--doux)}',
  '.msg{display:flex;gap:12px;padding:11px 10px;border-radius:12px}',
  '.msg:hover{background:rgba(123,92,255,.05)}',
  '.avatar{width:40px;height:40px;border-radius:50%;flex:0 0 auto;border:1px solid var(--bord);object-fit:cover}',
  '.corps{min-width:0;flex:1}',
  '.tete{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
  '.auteur{font-weight:700;color:#fff}',
  '.bot{font-size:10px;font-weight:800;background:var(--neon);color:#fff;padding:1px 5px;border-radius:4px}',
  '.heure{font-size:11.5px;color:var(--doux)}',
  '.texte{margin-top:3px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45}',
  '.texte a{color:var(--cyan);text-decoration:none}',
  '.embed{margin-top:6px;border-left:3px solid var(--neon);background:var(--panneau);border-radius:6px;padding:8px 12px;white-space:pre-wrap}',
  '.pjs{margin-top:6px;display:flex;flex-wrap:wrap;gap:8px}',
  '.pjs img{max-width:260px;max-height:220px;border-radius:10px;border:1px solid var(--bord)}',
  '.pjs a.f{padding:8px 12px;border:1px solid var(--bord);border-left:3px solid var(--neon);border-radius:8px;color:var(--clair);text-decoration:none;font-size:13px;background:var(--panneau)}',
  '.vide{text-align:center;color:var(--doux);padding:48px 0}',
].join('');
export function transcriptHtml(channel, messages, { title, subtitle } = {}) {
  const g = channel.guild;
  const body = messages.length
    ? messages
        .map((m) => {
          const text = m.content
            ? `<div class="texte">${esc(readable(m.content, g)).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')}</div>`
            : '';
          const embeds = m.embeds
            .map(
              (e) => `<div class="embed">${e.title ? `<b>${esc(readable(e.title, g))}</b>\n` : ''}${esc(readable(e.description, g))}</div>`,
            )
            .join('');
          const files = [...m.attachments.values()]
            .map((a) =>
              /\.(png|jpe?g|gif|webp)$/i.test(a.name || '')
                ? `<a href="${esc(a.url)}" target="_blank"><img src="${esc(a.url)}" alt=""/></a>`
                : `<a class="f" href="${esc(a.url)}" target="_blank">${esc(a.name || 'fichier')}</a>`,
            )
            .join('');
          const name = esc(m.member?.displayName || m.author?.username || 'Inconnu');
          const avatar = esc(m.author?.displayAvatarURL?.({ size: 64 }) || '');
          const when = new Date(m.createdTimestamp).toLocaleString('fr-FR');
          return `<div class="msg"><img class="avatar" src="${avatar}" alt=""/><div class="corps"><div class="tete"><span class="auteur">${name}</span>${m.author?.bot ? '<span class="bot">BOT</span>' : ''}<span class="heure">${when}</span></div>${text}${embeds}${files ? `<div class="pjs">${files}</div>` : ''}</div></div>`;
        })
        .join('\n')
    : '<div class="vide">Aucun message.</div>';
  const n = messages.length;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${esc(title || `Transcript — ${channel.name}`)}</title><style>${CSS}</style></head><body><div class="wrap"><div class="entete"><div class="titre">🌙 <b>DREAM</b></div><div class="salon"># ${esc(channel.name)}</div><div class="meta">${n} message${n > 1 ? 's' : ''} · généré le ${new Date().toLocaleString('fr-FR')}</div>${subtitle ? `<div class="meta">${esc(subtitle)}</div>` : ''}</div>${body}</div></body></html>`;
}
export async function fetchAll(channel, max = 2000) {
  const all = [];
  let before;
  while (all.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch?.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.reverse();
}

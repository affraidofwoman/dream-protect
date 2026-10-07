import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionFlagsBits } from 'discord.js';

// Base jetable
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-test-'));
process.env.DATABASE_PATH = path.join(tmp, 'test.sqlite');
process.env.OWNER_IDS = '100000000000000001';
process.env.TEST_MODE = '1';

const base = await import('./lib/base.js');
const { bots } = await import('./lib/bots.js');
const D = await import('./lib/droits.js');
const L = await import('./lib/logs.js');
const M = await import('./lib/moderation.js');
const C = await import('./lib/communaute.js');
const R = await import('./lib/reglages.js');
const K = await import('./lib/commandes.js');

let pass = 0;
const fails = [];
const ok = (name, cond) => (cond ? pass++ : fails.push(name));
const throws = (name, fn) => {
  try {
    fn();
    fails.push(`${name} (aurait dû refuser)`);
  } catch {
    pass++;
  }
};
const allows = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    fails.push(`${name} (${e.message})`);
  }
};

// Faux serveur
const G = '200000000000000001';
const id = (n) => `3000000000000000${String(n).padStart(2, '0')}`;
const CREATOR = '100000000000000001';
const perms = (list = []) => ({ has: (p) => list.some((n) => PermissionFlagsBits[n] === p) });
const roles = new Map();
const role = (rid, position, name, p = []) => {
  const r = { id: rid, name, position, managed: false, editable: true, permissions: perms(p), guild: { id: G } };
  roles.set(rid, r);
  return r;
};
const member = (uid, roleIds) => {
  const cache = new Map(roleIds.map((x) => [x, roles.get(x)]));
  const highest = [...cache.values()].sort((a, b) => b.position - a.position)[0] ?? { position: 0 };
  return { id: uid, user: { id: uid, bot: false }, roles: { cache, highest }, permissions: perms() };
};
const rModo = role(id(1), 10, 'Modérateur');
const rAdmin = role(id(2), 20, 'Administrateur');
const rHead = role(id(3), 30, 'Head Staff');
role(id(4), 5, 'Membre');
role(id(5), 15, 'Danger', ['Administrator']);
const guild = {
  id: G,
  name: 'Serveur Test',
  ownerId: id(99),
  memberCount: 10,
  roles: { cache: roles, everyone: { id: G } },
  members: { cache: new Map(), me: { id: id(98), roles: { highest: { position: 50 } }, permissions: perms() } },
  channels: { cache: new Map() },
};
bots.guard.guilds.cache.set(G, guild);

// Rangs internes
D.ensureRanks(G);
ok('trois rangs internes', D.rankRows(G).length === 3);
ok('owner global au sommet', D.rank(G, CREATOR) === D.CREATOR);
ok('membre sans rang', D.rank(G, id(50)) === -1);
ok('propriétaire du serveur SYS+', D.rank(G, id(99)) === 100);
D.setRank(G, id(51), 'SYS');
ok('rang SYS donné', D.rank(G, id(51)) === 90 && D.rankName(G, 90) === 'SYS');
D.setRank(G, id(51), null);
ok('rang retiré', D.rank(G, id(51)) === -1);

// Échelle du staff
allows('ajout staff', () => [rModo, rAdmin, rHead].forEach((r) => D.addStaff(G, r)));
const order = D.staffRows(G).map((x) => x.name);
ok('ordre Discord respecté', order.join() === 'Head Staff,Administrateur,Modérateur');
ok(
  'niveaux sous OWNER',
  D.staffRows(G).every((x) => x.level < 80 && x.level > 0),
);
rModo.position = 40;
D.syncStaff(G);
ok('déplacement suivi', D.staffRows(G)[0].name === 'Modérateur');
rModo.position = 10;
D.syncStaff(G);
throws('rôle de bot refusé', () => D.addStaff(G, { id: id(9), name: 'bot', managed: true }));
const modo = member(id(10), [id(1)]);
const admin = member(id(11), [id(2)]);
const head = member(id(12), [id(3)]);
ok('rang par rôle staff', D.rank(G, id(11), admin) > D.rank(G, id(10), modo));
ok('texte hiérarchie sans chiffre de niveau', !/niveau/i.test(R.ladder(G)));

// Droits par groupe
ok('fiche membre ouverte au staff', D.allowed(G, id(10), '=ui', modo));
ok('ban fermé au staff par défaut', !D.allowed(G, id(12), '+ban', head));
ok('commande publique ouverte', D.allowed(G, id(50), '/help', null));
allows('seuil par rôle', () => D.setThreshold(G, 'ban', id(2)));
ok(
  'ban ouvert à partir de Administrateur',
  D.allowed(G, id(11), '+ban', admin) && D.allowed(G, id(12), '+ban', head) && !D.allowed(G, id(10), '+ban', modo),
);
allows('seuil tout le staff', () => D.setThreshold(G, 'derank', 'staff'));
ok('derank ouvert au staff', D.allowed(G, id(10), '&derank', modo));
allows('seuil par défaut', () => D.setThreshold(G, 'derank', null));
ok('retour au défaut', !D.allowed(G, id(10), '&derank', modo));
throws('rôle hors staff refusé', () => D.setThreshold(G, 'ban', id(4)));
D.setRank(G, id(20), 'OWNER');
ok('OWNER bloqué sur la configuration', !D.allowed(G, id(20), '=hierarchie'));
D.setRank(G, id(21), 'SYS');
ok('SYS ouvre la configuration', D.allowed(G, id(21), '=hierarchie'));
base.db
  .prepare('INSERT OR REPLACE INTO emergency(guild_id,active,actor_id,reason,created_at) VALUES(?,1,?,?,?)')
  .run(G, 'x', 'test', Date.now());
ok('urgence bloque les rangs bas', !D.allowed(G, id(20), '&bl') && D.allowed(G, id(21), '&bl'));
base.db.prepare('UPDATE emergency SET active=0 WHERE guild_id=?').run(G);

// Viser quelqu'un
const ctx = (uid, m) => ({ gid: G, guild, user: { id: uid, tag: uid }, member: m });
throws('se viser soi-même', () => D.checkTarget(ctx(id(11), admin), id(11), admin));
throws('viser un supérieur', () => D.checkTarget(ctx(id(10), modo), id(12), head));
throws('viser un égal', () => D.checkTarget(ctx(id(11), admin), id(13), member(id(13), [id(2)])));
allows('viser un inférieur', () => D.checkTarget(ctx(id(12), head), id(10), modo));
throws('viser le propriétaire', () => D.checkTarget(ctx(id(12), head), id(99), null));
throws('viser un owner du bot', () => D.checkTarget(ctx(id(21), member(id(21), [])), CREATOR, null));
allows('owner du bot vise tout le monde', () => D.checkTarget(ctx(CREATOR, null), id(12), null));
throws('bot trop bas', () => {
  const big = { id: id(14), roles: { cache: new Map(), highest: { position: 60 } } };
  D.checkTarget(ctx(CREATOR, null), id(14), big);
});

// Toucher un rôle
throws('donner un rôle staff égal', () => D.checkRole(ctx(id(11), admin), rAdmin));
allows('donner un rôle inférieur', () => D.checkRole(ctx(id(12), head), roles.get(id(4))));
throws('rôle sensible sans SYS', () => D.checkRole(ctx(id(12), head), roles.get(id(5))));
throws('rôle au-dessus du bot', () => D.checkRole(ctx(CREATOR, null), { ...rHead, id: id(7), position: 80 }));

// Logs
ok(
  'structure exacte des logs',
  [
    'wet-log',
    'bl-log',
    'ban-log',
    'badword-log',
    'clear-log',
    'role-log',
    'wl-log',
    'perm-log',
    'abo-log',
    'autorole-log',
    'contrib-log',
    'vente-log',
    'paiement-log',
    'ticket-logs',
    'membre-log',
    'salon-log',
    'commande-log',
    'backup-log',
    'bataillon-log',
    'sante-log',
    'dog-log',
    'giveaway-log',
  ].every((n) => [...L.LOG_KEYS.values()].includes(n)),
);
ok('six catégories de logs', L.LOG_TREE.length === 6);
ok('pas de log sans serveur choisi', L.logChannel(guild, 'ban') === null);

// Modération
ok(
  'cibles lues',
  (() => {
    const t = M.targetsOf({ args: [`<@${id(10)}>`, id(11), 'trop', 'drôle'], repliedTo: null });
    return t.ids.length === 2 && t.reason === 'trop drôle';
  })(),
);
throws('trop de cibles', () => M.targetsOf({ args: Array.from({ length: 11 }, (_, n) => id(n + 30)), repliedTo: null }, 10));
ok('cible par réponse', M.targetsOf({ args: [], repliedTo: id(10) }).ids[0] === id(10));
base.db.prepare('INSERT INTO badwords(guild_id,word,created_at) VALUES(?,?,?)').run(G, 'pute', Date.now());
ok('mot interdit trouvé avec accents', M.findBadword(G, 'Espèce de PUTÉ') === 'pute');
ok('mot interdit pas dans un autre mot', M.findBadword(G, 'computer') === null);

// Communauté
ok('motifs de ticket', C.TICKET_TYPES.map((t) => t.label).join() === 'Sanction,Contribution,Bataillon Confirmé,Autre');
ok('un bouton par motif', C.ticketPanel(G).components[0].components.length === 4);
ok('nom de ticket propre', C.slug('Élodie ✨ 42') === 'elodie-42');
ok('nom de stat', C.statName(['membres', '👥', 'Membres'], { membres: 1234 }).startsWith('👥 · Membres : 1'));
ok('stat sans lien', C.statName(['lien', '🔗', null], {}) === '🔗 · Aucun lien');

// Registre des commandes
const names = K.COMMANDS.map((d) => d.name);
const SPEC = [
  '=pv',
  '=acces',
  '&bl',
  '&blinfo',
  '&unbl',
  '/dog-add',
  '/dog-del',
  '&derank',
  '&lock',
  '&unlock',
  '+ban',
  '-baninfo',
  '/wet',
  '/wet-info',
  '=ui',
  '/addrole',
  '/delrole',
  '+pic',
  '+banner',
  '+massiveroleadd',
  '=logs',
  '/help',
  '/profil',
  '/explain',
  '/contrib',
  '/perm',
  '/acces',
  '/abo',
  '+unban',
  '&clear',
  '&l0all',
  '+badword',
  '/protect',
  '/wl',
  '/add',
  '/del',
  '/logs',
  '=default',
  '/payment',
];
ok('toutes les commandes demandées', SPEC.every((n) => names.includes(n)) || console.log(SPEC.filter((n) => !names.includes(n))));
ok('aucun doublon', new Set(names).size === names.length);
ok('alias airline', K.prefixCommand('+lock')?.name === '&lock' && K.prefixCommand('&lockall')?.name === '&l0all');
ok('slash pas en préfixe', K.prefixCommand('/wet') === null);
ok(
  'chaque commande a une action',
  K.COMMANDS.every((d) => typeof d.run === 'function' && (d.bot === 'main' || d.bot === 'guard')),
);
const publicOk = new Set([
  '/help',
  '=help',
  '/profil',
  '+pic',
  '+banner',
  '/explain',
  '/contrib',
  '/perm',
  '/acces',
  '/abo',
  '=smash',
  '.owner',
]);
ok(
  'chaque commande sensible a un groupe',
  K.COMMANDS.filter((d) => !D.groupOf(d.name) && !publicOk.has(d.name)).length === 0 ||
    console.log(K.COMMANDS.filter((d) => !D.groupOf(d.name) && !publicOk.has(d.name)).map((d) => d.name)),
);
ok(
  'chaque commande d’un groupe existe',
  Object.values(D.GROUPS)
    .flatMap((g) => g.commands)
    .every((c) => names.includes(c)) ||
    console.log(
      Object.values(D.GROUPS)
        .flatMap((g) => g.commands)
        .filter((c) => !names.includes(c)),
    ),
);
ok(
  'slash valides',
  [...K.slashFor('main'), ...K.slashFor('guard')].every(
    (s) => /^[a-z-]{1,32}$/.test(s.name) && s.description.length <= 100 && s.options.every((o) => o.type && o.description.length <= 100),
  ),
);
ok(
  'options requises en premier',
  [...K.slashFor('main'), ...K.slashFor('guard')].every(
    (s) =>
      s.options.findIndex((o) => !o.required) === -1 || s.options.slice(s.options.findIndex((o) => !o.required)).every((o) => !o.required),
  ),
);
ok('slash répartis', K.slashFor('main').length > 10 && K.slashFor('guard').length >= 3);
const helpOf = (uid, m) => K.helpEmbed({ gid: G, guild, user: { id: uid, username: 'x' }, member: m }).toJSON();
const lines = (e) => (e.fields || []).map((f) => f.value).join('\n');
ok('aide membre sans sanctions', !lines(helpOf(id(50), member(id(50), []))).includes('**+ban**'));
ok('aide membre avec le public', lines(helpOf(id(50), member(id(50), []))).includes('/help'));
ok('aide admin avec +ban', lines(helpOf(id(11), admin)).includes('**+ban**'));
ok('aide owner complète', lines(helpOf(CREATOR, null)).includes('=hierarchie'));

// Routeur simulé
bots.main.user = { id: id(80), tag: 'commu' };
bots.guard.user = { id: id(81), tag: 'protect' };
for (const b of [id(80), id(81)])
  base.db
    .prepare("INSERT OR REPLACE INTO bot_access(guild_id,bot_id,bot_name,status,requested_at) VALUES(?,?,?,'accepted',?)")
    .run(G, b, 'test', Date.now());
bots.main.guilds.cache.set(G, guild);
const fakeMessage = (client, uid, content, m = member(uid, [])) => {
  const out = { replies: [], sent: [], deleted: false };
  const author = { id: uid, bot: false, tag: uid, username: uid, displayAvatarURL: () => undefined };
  out.message = {
    author,
    content,
    client,
    guild,
    member: m,
    reference: null,
    channelId: id(70),
    channel: { id: id(70), name: 'général', send: async (p) => (out.sent.push(p), { delete: async () => {} }), sendTyping: async () => {} },
    reply: async (p) => (out.replies.push(p), { delete: async () => {} }),
    delete: async () => ((out.deleted = true), true),
  };
  return out;
};
const text = (p) => JSON.stringify(p?.embeds?.map((e) => e.toJSON?.() ?? e) ?? []);
{
  const t = fakeMessage(bots.main, id(50), '=help');
  await K.onMessage(t.message);
  ok('=help répond', t.replies.length === 1 && text(t.replies[0]).includes('Tes commandes'));
}
{
  const t = fakeMessage(bots.main, id(50), `+ban ${id(10)}`);
  await K.onMessage(t.message);
  ok('+ban ignoré sans bruit pour un membre', t.replies.length === 0);
}
{
  const t = fakeMessage(bots.main, id(21), '=hierarchie', member(id(21), []));
  await K.onMessage(t.message);
  ok('commande sécurité ignorée par Commu', t.replies.length === 0);
  const u = fakeMessage(bots.guard, id(21), '=hierarchie', member(id(21), []));
  await K.onMessage(u.message);
  ok('commande sécurité traitée par Protect', u.replies.length === 1 && text(u.replies[0]).includes('Hiérarchie'));
}
{
  const t = fakeMessage(bots.guard, id(50), '=help');
  await K.onMessage(t.message);
  ok('pas de double réponse à =help', t.replies.length === 0);
}
{
  const t = fakeMessage(bots.main, id(50), 'espèce de pute');
  await K.onMessage(t.message);
  ok('mot interdit supprimé', t.deleted && t.sent.length === 1);
}
{
  base.db
    .prepare('INSERT OR REPLACE INTO protected_channels(guild_id,channel_id,min_level,role_id,created_at) VALUES(?,?,?,?,?)')
    .run(G, id(70), 80, null, Date.now());
  const t = fakeMessage(bots.main, id(50), 'coucou');
  await K.onMessage(t.message);
  ok('salon réservé appliqué', t.deleted);
  const u = fakeMessage(bots.main, id(20), 'coucou');
  await K.onMessage(u.message);
  ok('salon réservé laisse passer OWNER', !u.deleted);
  base.db.prepare('DELETE FROM protected_channels WHERE guild_id=?').run(G);
}
{
  const t = fakeMessage(bots.main, id(50), 'bonjour tout le monde');
  await K.onMessage(t.message);
  ok('message normal ignoré', t.replies.length === 0 && !t.deleted);
}

// Bannissement simulé
{
  const banned = new Set();
  const people = new Map([
    [id(10), modo],
    [id(11), admin],
    [id(12), head],
  ]);
  guild.bans = {
    fetch: async (uid) => {
      if (uid === undefined) return new Map([...banned].map((x) => [x, { user: { id: x, tag: x }, reason: null }]));
      if (banned.has(uid)) return { user: { id: uid } };
      throw new Error('Unknown Ban');
    },
  };
  guild.members.fetch = async (uid) => {
    if (people.has(uid)) return people.get(uid);
    throw new Error('Unknown Member');
  };
  guild.members.ban = async (uid) => banned.add(uid);
  guild.members.unban = async (uid) => banned.delete(uid);
  guild.client = bots.main;
  guild.members.me.permissions = { has: () => true };
  const t = fakeMessage(bots.main, id(11), `+ban ${id(10)} spam`, admin);
  await K.onMessage(t.message);
  ok('ban d’un inférieur', banned.has(id(10)) && text(t.replies[0]).includes('Banni'));
  await new Promise((r) => setTimeout(r, 1600));
  const u = fakeMessage(bots.main, id(11), `+ban ${id(12)}`, admin);
  await K.onMessage(u.message);
  ok('ban d’un supérieur refusé', !banned.has(id(12)) && text(u.replies[0]).includes('Refusé'));
  await new Promise((r) => setTimeout(r, 1600));
  const v = fakeMessage(bots.main, id(11), `+ban ${id(10)}`, admin);
  await K.onMessage(v.message);
  ok('second +ban débannit', !banned.has(id(10)) && text(v.replies[0]).includes('Débanni'));
  ok('sanction enregistrée', base.db.prepare("SELECT COUNT(*) AS n FROM sanctions WHERE type='BAN' AND target_id=?").get(id(10)).n === 1);
}

// Tableaux
R.setRegistry(K.COMMANDS);
ok('neuf tableaux', R.TABLES.length === 9);
allows('tous les tableaux se construisent', () =>
  R.TABLES.forEach(([k]) => {
    if (!String(R.tableBody(guild, k)).length) throw new Error(k);
  }),
);

// Outils
ok('durée lue', base.duration('2h') === 7_200_000 && base.duration('30m') === 1_800_000 && base.duration('x') === null);
ok('identifiant nettoyé', base.idOf(`<@!${id(1)}>`) === id(1) && base.idOf('abc') === null);
ok('argent lisible', base.money(1250) === '12,50 €' && base.money(1000) === '10 €');
ok('montant lu', base.toCents('12,50') === 1250 && base.toCents('-3') === 300 && base.toCents('0') === null);
allows('sauvegarde', () => base.backup(2));
ok(
  'config persistante',
  (() => {
    base.setCfg(G, (c) => (c.theme.preset = 'Rose'));
    return base.cfg(G).theme.preset === 'Rose';
  })(),
);

base.stopTimers();
try {
  base.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
console.log(`Tests : ${pass + fails.length}`);
console.log(`Échecs : ${fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(`- ${f}`);
  process.exit(1);
}
console.log('Toutes les protections testées sont bonnes.');
process.exit(0);

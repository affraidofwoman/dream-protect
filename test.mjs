import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Base jetable
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-test-'));
process.env.DATABASE_PATH = path.join(tmp, 'test.sqlite');
process.env.BOT1_TOKEN = 'test';
process.env.BOT2_TOKEN = 'test';
process.env.TEST_MODE = '1';
process.env.OWNER_IDS = 'owner1';

const { internals: I } = await import('./index.js');
process.removeAllListeners('uncaughtException');
process.removeAllListeners('unhandledRejection');
process.on('uncaughtException', e => { console.error('Exception:', e?.message || e); process.exit(1); });
process.on('unhandledRejection', e => { console.error('Rejet:', e?.message || e); process.exit(1); });
const G = 'guild-test';

let pass = 0;
const fails = [];
function ok(name, cond) { if (cond) pass++; else fails.push(name); }
function throws(name, fn) { try { fn(); fails.push(name + ' (aurait du refuser)'); } catch { pass++; } }
function allows(name, fn) { try { fn(); pass++; } catch (e) { fails.push(`${name} (${e.message})`); } }
function flat(e) { const d = e.data || {}; return [d.description || '', ...(d.fields || []).map(f => `${f.name}\n${f.value}`)].join('\n'); }

// Faux serveur
function role(id, position, name = id) { return { id, name, position, managed: false, guild: { id: G }, permissions: { has: () => false } }; }
function member(id, roleIds = []) {
  const cache = new Map(roleIds.map((r, idx) => [r, role(r, idx + 1)]));
  return { id, user: { id, bot: false, tag: id }, roles: { cache } };
}
const roles = new Map();
const members = new Map();
const guild = {
  id: G, name: 'Serveur Test',
  roles: { cache: roles, everyone: { id: G } },
  members: { cache: members, me: { id: 'bot', permissions: { has: () => true }, roles: { highest: role('top', 99) } } },
  channels: { cache: new Map() },
  memberCount: 0
};
I.guilds.set(G, guild);
for (const [id, pos] of [['rStaff', 2], ['rProtect', 5], ['rVoid', 6], ['rAutre', 7]]) roles.set(id, role(id, pos));

// Niveaux systeme seulement
I.ensureHierarchy(G);
ok('trois niveaux systeme', I.systemRows(G).length === 3);
ok('aucun role par defaut', I.hierarchyRows(G).every(x => !x.role_id));
ok('aucune echelle par defaut', I.tierRows(G).length === 0);
ok('SYS+ au sommet', I.levelByName(G, 'SYS+') === 100 && I.levelByName(G, 'SYS') === 90 && I.levelByName(G, 'OWNER') === 80);
ok('bornes des roles', I.TIER_MIN === 1 && I.TIER_MAX === 79);
ok('owner level lu', I.ownerLevel(G) === 80);

// Echelle de roles choisie
throws('niveau 0 refuse', () => I.setTier(G, roles.get('rStaff'), 0));
throws('niveau 80 refuse', () => I.setTier(G, roles.get('rStaff'), 80));
throws('niveau decimal refuse', () => I.setTier(G, roles.get('rStaff'), 12.5));
throws('role de bot refuse', () => I.setTier(G, { id: 'rBot', name: 'bot', managed: true }, 20));
allows('role place', () => I.setTier(G, roles.get('rStaff'), 20));
allows('role place haut', () => I.setTier(G, roles.get('rProtect'), 50));
allows('role place plus haut', () => I.setTier(G, roles.get('rVoid'), 60));
ok('echelle a trois rangs', I.tierRows(G).length === 3);
ok('echelle triee', I.tierRows(G)[0].level === 60);
ok('echelle dans la hierarchie', I.hierarchyRows(G).length === 6 && I.hierarchyRows(G)[0].name === 'SYS+');
ok('libelle lu du role', I.levelLabel(G, 50) === 'rProtect');
ok('libelle systeme garde', I.levelLabel(G, 80) === 'OWNER');
ok('libelle inconnu lisible', I.levelLabel(G, 7) === 'Niveau 7');
ok('texte d echelle', I.ladderText(G, guild).includes('rProtect') && I.ladderText(G, guild).includes('SYS+'));

// Rangs
members.set('uStaff', member('uStaff', ['rStaff']));
members.set('uProtect', member('uProtect', ['rProtect']));
members.set('uVoid', member('uVoid', ['rVoid']));
members.set('uAutre', member('uAutre', ['rAutre']));
I.clearRankCache();
ok('rang par role', I.rank(G, 'uProtect') === 50);
ok('role sans niveau = rien', I.rank(G, 'uAutre') === -1);
ok('owner global = 999', I.rank(G, 'owner1') === 999);
ok('nom de niveau', I.levelNameFor(G, 'uVoid') === 'rVoid');
I.setWL(G, 'uOwner', 'WLSYS', 80);
I.setWL(G, 'uSys', 'WLSYS', 90);
I.clearRankCache();
ok('rang par WL', I.rank(G, 'uOwner') === 80);
I.setWL(G, 'uProtect', 'WLPROTECT', 10);
I.clearRankCache();
ok('rang = le plus haut des deux', I.rank(G, 'uProtect') === 50);

// Hierarchie stricte
ok('superieur strict', I.higher(G, 'uVoid', 'uProtect') === true);
ok('egal refuse', I.higher(G, 'uProtect', 'uProtect') === false);
ok('inferieur refuse', I.higher(G, 'uStaff', 'uVoid') === false);
throws('cible soi-meme', () => I.guardTarget(G, 'uVoid', 'uVoid'));
throws('cible egale', () => I.guardTarget(G, 'uProtect', 'uProtect'));
throws('cible superieure', () => I.guardTarget(G, 'uStaff', 'uVoid'));
throws('cible owner global', () => I.guardTarget(G, 'uOwner', 'owner1'));
allows('cible inferieure', () => I.guardTarget(G, 'uVoid', 'uStaff'));

// Pas d escalade par l echelle
throws('placer au-dessus de soi refuse', () => I.setTier(G, roles.get('rAutre'), 60, 'uProtect'));
throws('placer a son niveau refuse', () => I.setTier(G, roles.get('rAutre'), 50, 'uProtect'));
allows('placer en dessous autorise', () => I.setTier(G, roles.get('rAutre'), 30, 'uProtect'));
throws('deplacer un role superieur refuse', () => I.setTier(G, roles.get('rVoid'), 10, 'uProtect'));
throws('retirer un role superieur refuse', () => I.delTier(G, 'rVoid', 'uProtect'));
allows('retirer un role inferieur autorise', () => I.delTier(G, 'rAutre', 'uProtect'));
allows('owner global place librement', () => { I.setTier(G, roles.get('rAutre'), 70, 'owner1'); I.delTier(G, 'rAutre', 'owner1'); });

// Droits par defaut
I.clearRankCache();
ok('+lock par defaut a 50', I.cmdRule(G, '+lock').minLevel === 50);
ok('&bl par defaut a 80', I.cmdRule(G, '&bl').minLevel === 80);
ok('commande inconnue ouverte', I.cmdRule(G, 'inconnue').minLevel === 0);
ok('+lock refuse au staff bas', I.allowCmd(G, 'uStaff', '+lock') === false);
ok('+lock ouvert a 50', I.allowCmd(G, 'uProtect', '+lock') === true);
ok('+lock ouvert plus haut', I.allowCmd(G, 'uVoid', '+lock') === true);
ok('&bl refuse sous owner', I.allowCmd(G, 'uVoid', '&bl') === false);
ok('&bl ouvert a owner', I.allowCmd(G, 'uOwner', '&bl') === true);
ok('owner global passe partout', I.allowCmd(G, 'owner1', '=urgence') === true);
throws('requireCmd refuse', () => I.requireCmd(G, 'uStaff', '&lockall'));
allows('requireCmd accepte', () => I.requireCmd(G, 'uSys', '&lockall'));

// Droits par roles choisis
I.setCommandPerm(G, '+lock', 50, ['rStaff']);
ok('role choisi ouvre', I.allowCmd(G, 'uStaff', '+lock') === true);
ok('role non choisi ferme', I.allowCmd(G, 'uProtect', '+lock') === false);
ok('owner reste au-dessus', I.allowCmd(G, 'uOwner', '+lock') === true);
ok('texte de regle lisible', I.cmdRuleText(G, '+lock').includes('<@&rStaff>'));
I.clearCommandPerm(G, '+lock');
ok('retour au defaut', I.allowCmd(G, 'uProtect', '+lock') === true && I.allowCmd(G, 'uStaff', '+lock') === false);
I.setCommandPerm(G, '&clear', 15, []);
ok('niveau surcharge', I.allowCmd(G, 'uStaff', '&clear') === true);
I.clearCommandPerm(G, '&clear');
ok('surcharge retiree', I.allowCmd(G, 'uStaff', '&clear') === false);
throws('niveau de surcharge invalide', () => I.setCommandPerm(G, '&clear', -5, []));

// Refus explicite par personne
I.db.prepare('INSERT OR REPLACE INTO wl_cmd(guild_id,user_id,command,allow) VALUES(?,?,?,0)').run(G, 'uVoid', '+lock');
ok('refus explicite gagne', I.allowCmd(G, 'uVoid', '+lock') === false);
I.db.prepare('INSERT OR REPLACE INTO wl_cmd(guild_id,user_id,command,allow) VALUES(?,?,?,1)').run(G, 'uStaff', '+lock');
ok('accord explicite gagne', I.allowCmd(G, 'uStaff', '+lock') === true);
I.db.prepare('DELETE FROM wl_cmd WHERE guild_id=?').run(G);

// Acces internes lies a un role
I.linkHierarchyRole(G, 'OWNER', 'rAutre');
I.clearRankCache();
ok('acces interne lie', I.rank(G, 'uAutre') === 80);
ok('acces interne ouvre &bl', I.allowCmd(G, 'uAutre', '&bl') === true);
I.linkHierarchyRole(G, 'OWNER', null);
I.clearRankCache();
ok('acces interne delie', I.rank(G, 'uAutre') === -1);
throws('niveau systeme sous la borne refuse', () => I.setHierarchyLevel(G, 'OWNER', 50));
throws('niveau systeme inconnu refuse', () => I.setHierarchyLevel(G, 'Protect', 85));
allows('niveau systeme deplacable', () => I.setHierarchyLevel(G, 'OWNER', 85));
ok('owner level suit', I.ownerLevel(G) === 85);
I.setHierarchyLevel(G, 'OWNER', 80);

// Reglages en cascade
I.settingSet(G, 'GLOBAL', '*', 'preset', 'Océan');
ok('global applique', I.resolveSetting(G, 'preset', {}) === 'Océan');
I.settingSet(G, 'ROLE', 'rProtect', 'preset', 'Violet');
ok('role ecrase global', I.resolveSetting(G, 'preset', { uid: 'uProtect' }) === 'Violet');
I.settingSet(G, 'WL', '50', 'preset', 'Or');
ok('wl ecrase role', I.resolveSetting(G, 'preset', { uid: 'uProtect' }) === 'Or');
I.settingSet(G, 'USER', 'uProtect', 'preset', 'Rose');
ok('utilisateur ecrase wl', I.resolveSetting(G, 'preset', { uid: 'uProtect' }) === 'Rose');
I.settingSet(G, 'COMMAND', 'help', 'preset', 'Sombre');
ok('commande ecrase tout', I.resolveSetting(G, 'preset', { uid: 'uProtect', command: 'help' }) === 'Sombre');
ok('theme suit le preset', I.themeFor(G, { uid: 'uProtect' }).color === I.COLOR_PRESETS['Rose'].color);
throws('portee inconnue refusee', () => I.settingSet(G, 'AUTRE', '*', 'preset', 'Rose'));
ok('sept presets', Object.keys(I.COLOR_PRESETS).length === 7);

// Aide adaptative
const helpStaff = flat(I.helpEmbed(G, 'uStaff'));
const helpProtect = flat(I.helpEmbed(G, 'uProtect'));
const helpOwner = flat(I.helpEmbed(G, 'uOwner'));
ok('aide montre /help a tous', helpStaff.includes('/help'));
ok('aide cache +lock au staff bas', !helpStaff.includes('+lock'));
ok('aide montre +lock a 50', helpProtect.includes('+lock'));
ok('aide cache &bl sous owner', !helpProtect.includes('&bl'));
ok('aide montre &bl a owner', helpOwner.includes('&bl'));
ok('aide suit les droits par role', (() => {
  I.setCommandPerm(G, '&clear', 50, ['rStaff']);
  const a = flat(I.helpEmbed(G, 'uStaff'));
  const b = flat(I.helpEmbed(G, 'uProtect'));
  I.clearCommandPerm(G, '&clear');
  return a.includes('&clear') && !b.includes('&clear');
})());
ok('aide masque les commandes coupees', (() => {
  I.ensureCommandConfig(G);
  I.db.prepare('UPDATE command_config SET active=0 WHERE guild_id=? AND command=?').run(G, 'logs');
  const after = flat(I.helpEmbed(G, 'uOwner'));
  I.db.prepare('UPDATE command_config SET active=1 WHERE guild_id=? AND command=?').run(G, 'logs');
  return !after.includes('`/logs`');
})());

// Logs
ok('23 salons de logs', I.LOG_NAMES.size === 23);
ok('six categories', I.LOG_TREE.length === 6);
ok('mapping historique', I.logKey('modération') === 'ban' && I.logKey('accès') === 'wl' && I.logKey('rôles') === 'role');
ok('cle inconnue vers sante', I.logKey('nimporte') === 'sante');
ok('noms de salons attendus', ['wet-log', 'bl-log', 'ban-log', 'badword-log', 'clear-log', 'ticket-logs', 'sante-log'].every(n => [...I.LOG_NAMES.values()].includes(n)));

// Tableaux
ok('neuf tableaux', I.TABLE_DEFS.length === 9);
allows('tableaux sans erreur', () => { for (const [k] of I.TABLE_DEFS) { const b = I.tableBody(guild, k); if (typeof b !== 'string' || !b.length) throw new Error('tableau vide: ' + k); } });
ok('tableau hierarchie montre l echelle', I.tableBody(guild, 'hierarchie').includes('rProtect'));
ok('tableau commandes montre les droits', I.tableBody(guild, 'commandes').includes('+lock'));
ok('tableau protect lit l urgence', I.tableBody(guild, 'protect').includes('inactif'));

// Paiements et durees
ok('cinq statuts', I.PAY_STATUS.length === 5 && I.PAY_STATUS.includes('Remboursé') && I.PAY_STATUS.includes('À vérifier'));
ok('duree minutes', I.parseDuration('30m') === 30 * 60000);
ok('duree heures', I.parseDuration('2h') === 2 * 3600000);
ok('duree jours', I.parseDuration('1j') === 86400000);
ok('duree invalide', I.parseDuration('plop') === null);

// Mots interdits
I.db.prepare('INSERT OR IGNORE INTO badwords(guild_id,word,created_at) VALUES(?,?,?)').run(G, 'interdit', Date.now());
ok('mot detecte', I.hitBadword(G, 'un mot INTERDIT ici') === 'interdit');
ok('mot absent', I.hitBadword(G, 'rien a signaler') === null);

// Garde-fous
throws('cooldown bloque', () => { I.cooldown('t:test', 5000); I.cooldown('t:test', 5000); });
throws('rate limit bloque', () => { for (let i = 0; i < 7; i++) I.rateLimit('t:rl', 5, 60000); });
allows('audit ecrit', () => I.audit(G, 'uOwner', 'test.action', 'cible', { a: 1 }));
ok('audit lu', I.db.prepare('SELECT COUNT(*) AS n FROM audit WHERE guild_id=?').get(G).n >= 1);
ok('urgence inactive par defaut', I.emergencyOn(G) === false);

// Roles proteges
I.db.prepare('INSERT OR IGNORE INTO protected_roles(guild_id,role_id,created_at) VALUES(?,?,?)').run(G, 'rProtect', Date.now());
ok('role protege reconnu', I.isProtectedRole(G, roles.get('rProtect')) === true);
ok('role normal non protege', I.isProtectedRole(G, roles.get('rAutre')) === false);
ok('everyone toujours protege', I.isProtectedRole(G, { id: G, guild: { id: G }, managed: false }) === true);
ok('role manage protege', I.isProtectedRole(G, { id: 'x', guild: { id: G }, managed: true }) === true);
throws('masse refuse un role protege', () => I.massPrepare(guild, 'uOwner', roles.get('rProtect'), null));
I.db.prepare('DELETE FROM protected_roles WHERE guild_id=?').run(G);
ok('limite de masse definie', I.MASS_ROLE_MAX === 250);

// WL role
ok('owner ne donne pas SYS+', I.canGrantWLRole(G, 'uOwner', 'SYS+') === false);
ok('owner global donne tout', I.canGrantWLRole(G, 'owner1', 'SYS+') === true);

// Fiche membre
allows('fiche membre', () => { const c = I.memberCard(guild, 'uProtect'); if (!c.fields?.length) throw new Error('fiche vide'); });

// Repartition des bots
ok('configuration cote Protect', I.PROTECT_CMDS.has('configuration'));
ok('wl cote Protect', I.PROTECT_CMDS.has('wl'));
ok('help cote Commu', !I.PROTECT_CMDS.has('help'));
ok('aucune commande en double', new Set(I.slash.map(x => x.name)).size === I.slash.length);
ok('slash help presente', I.slash.some(x => x.name === 'help'));
ok('slash profil presente', I.slash.some(x => x.name === 'profil'));
ok('slash payment presente', I.slash.some(x => x.name === 'payment'));

// Presentation
ok('aide groupee en champs', (I.helpEmbed(G, 'uOwner').data.fields || []).length >= 3);
ok('aide compte les commandes', /commande/.test(I.helpEmbed(G, 'uOwner').data.footer?.text || ''));
ok('fiche membre horodatee', !!I.memberCard(guild, 'uProtect').timestamp);
ok('setup expose', typeof I.runSetup === 'function' && typeof I.setupEmbed === 'function');
ok('setup cote Protect', I.PROTECT_CMDS.has('setup') && I.slash.some(x => x.name === 'setup'));
ok('setup dans l aide', I.CMD_ACCESS.some(e => e[0] === '=setup'));
ok('barre de progression', I.bar(5, 10, 10) === '▰▰▰▰▰▱▱▱▱▱' && I.bar(0, 0, 4) === '▱▱▱▱');
ok('paires lisibles', I.kv([['a', 1], ['b', null], ['c', '']]) === '**a** · 1');
ok('montant formate', I.money(1250, '€') === '12.5€');
ok('texte borne', I.clip('abcdef', 4).length === 4 && I.clip('ab', 9) === 'ab');
ok('menu vide desactive', I.sel('x', 'y', []).data.disabled === true);
ok('menu plein actif', !I.sel('x', 'y', [{ label: 'a', value: 'a' }]).data.disabled);
ok('embed sans champ vide', (I.embed(G, { fields: [{ name: 'a', value: '' }, { name: 'b', value: 'ok' }] }).data.fields || []).length === 1);
ok('embed titre borne', I.embed(G, { title: 'x'.repeat(400) }).data.title.length === 256);
ok('config en cache', I.cfg(G) === I.cfg(G));
ok('config rechargee apres ecriture', (() => { const before = I.cfg(G).ui.footer; I.setCfg(G, c => c.ui.footer = 'TEST'); const after = I.cfg(G).ui.footer; I.setCfg(G, c => c.ui.footer = before); return after === 'TEST' && I.cfg(G).ui.footer === before; })());
ok('fusion profonde gardee', (() => { I.db.prepare('UPDATE guilds SET data=? WHERE id=?').run(JSON.stringify({ configuration: { welcome: { channelId: '42' } } }), G); I.cfgCache.delete(G); const c = I.cfg(G); return c.configuration.welcome.channelId === '42' && typeof c.configuration.welcome.template === 'string'; })());
ok('transaction imbriquee', (() => { let done = false; I.transaction(() => { I.transaction(() => { done = true; }); }); return done; })());
ok('transaction annulee', (() => { try { I.transaction(() => { I.db.prepare('INSERT INTO badwords(guild_id,word,created_at) VALUES(?,?,?)').run(G, 'rollback-test', Date.now()); throw new Error('stop'); }); } catch {} return !I.db.prepare('SELECT 1 FROM badwords WHERE guild_id=? AND word=?').get(G, 'rollback-test'); })());
ok('purge en place', typeof I.pruneHistory === 'function');
allows('purge sans erreur', () => I.pruneHistory(G));
ok('protection complete bornee', typeof I.protectRoles === 'function');

// Audit : URLs, identifiants, catalogue
ok('url http acceptee', I.safeUrl('https://exemple.test/a.png') === 'https://exemple.test/a.png');
ok('url javascript refusee', I.safeUrl('javascript:alert(1)') === null);
ok('url vide refusee', I.safeUrl('') === null && I.safeUrl('pas une url') === null);
ok('image avec extension acceptee', !!I.imageUrl('https://exemple.test/a.gif'));
ok('image sans extension refusee', I.imageUrl('https://exemple.test/page') === null);
ok('image discord acceptee', !!I.imageUrl('https://cdn.discordapp.com/attachments/1/2/x'));
ok('embed ignore une image cassee', I.embed(G, { image: 'pas-une-url' }).data.image === undefined);
ok('embed garde une image valide', I.embed(G, { image: 'https://exemple.test/a.png' }).data.image?.url === 'https://exemple.test/a.png');
ok('identifiant nettoye', I.cleanId('<@!123>') === '123' && I.cleanId('<@&456>') === '456' && I.cleanId('<#789>') === '789');
ok('niveaux proposes depuis l echelle', (() => { const v = I.levelOptions(G).map(o => o.value); return v.includes('100') && v.includes('50'); })());
ok('niveaux proposes sans doublon', (() => { const v = I.levelOptions(G).map(o => o.value); return new Set(v).size === v.length; })());
ok('catalogue couvre les nouveautes', ['help', 'profil', 'setup', 'protect', 'giveaway'].every(c => I.COMMAND_LABEL.has(c)));
ok('config de commande creee', !!I.commandCfg(G, 'help'));
ok('aide et droits alignes', I.CMD_ACCESS.every(e => I.allowCmd(G, 'owner1', e[0])));

// Ordre Discord
allows('ajout sans chiffre', () => { I.addTier(G, roles.get('rAutre')); I.addTier(G, roles.get('rStaff')); });
I.syncTierOrder(G);
ok('ordre suit les roles Discord', (() => { const o = I.staffRows(G).map(x => roles.get(x.role_id)?.position ?? -1); return o.every((v, n) => n === 0 || o[n - 1] >= v); })());
roles.get('rStaff').position = 50; I.syncTierOrder(G);
ok('deplacement Discord suivi', I.staffRows(G)[0].role_id === 'rStaff');
roles.get('rStaff').position = 2; I.syncTierOrder(G);
ok('echelle sans niveau', !/niveau/i.test(I.ladderText(G)));
throws('role de bot refuse dans la hierarchie', () => I.addTier(G, { id: 'rBot2', name: 'bot', managed: true }));

// Rien d automatique
ok('stats coupees par defaut', I.cfg('autre-guild').stats.voice === false);
ok('aucun serveur de logs par defaut', I.cfg('autre-guild').logGuild === null);
ok('pas de log sans serveur choisi', I.logChannel({ id: 'autre-guild' }, 'ban') === null);
ok('nom de stat', I.statName(['membres', '👥', 'Membres'], { membres: 12 }) === '👥 · Membres : 12');
ok('stat lien', I.statName(['lien', '🔗', null], { lien: '.gg/dream' }) === '🔗 · .gg/dream');

// Tickets
ok('motifs de ticket', I.TICKET_TYPES.map(t => t.label).join() === 'Sanction,Contribution,Bataillon Confirmé,Autre');
ok('nom de ticket propre', I.slugName('Élodie ✨ 42') === 'elodie-42');
ok('un bouton par motif', I.ticketPanel(G).components[0].components.length === I.TICKET_TYPES.length);

I.stopTimers();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`Tests: ${pass + fails.length}`);
console.log(`Échecs: ${fails.length}`);
if (fails.length) { for (const f of fails) console.log(`- ${f}`); process.exit(1); }
console.log('Toutes les protections testées sont bonnes.');
process.exit(0);

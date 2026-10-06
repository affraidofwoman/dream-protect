import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const src = fs.readFileSync(path.join(root,'index.js'),'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const required = ['package.json','README.md','.env.example','.gitignore','AUDIT.md','cookies/README.md','data/.gitkeep','index.js','test.mjs'];
const checks = [
  ['Deux tokens', /BOT1_TOKEN/.test(src) && /BOT2_TOKEN/.test(src)],
  ['Deux clients dans un processus', /one:new Client/.test(src) && /two:new Client/.test(src)],
  ['SQLite guild-scoped', /guild_id TEXT/.test(src) && /guilds\(id TEXT PRIMARY KEY/.test(src)],
  ['CUSTOM+ PV réel', /const pvLabel = /.test(src) && /WLCUSTOMPLUS/.test(src) && /Math\.max\(95,pvLevelForOwner/.test(src)],
  ['PV access dédiée', /CREATE TABLE IF NOT EXISTS pv_access/.test(src)],
  ['Role protection', /async function protectRoles/.test(src)],
  ['Configuration Protect', /async function openConfiguration/.test(src) && /commandName==='configuration'/.test(src)],
  ['Réparation 30 minutes', /30\*60\*1000/.test(src)],
  ['Refresh événementiel', /scheduleInstantRefresh/.test(src)],
  ['Backups', /async function backup/.test(src)],
  ['File musique persistante', /CREATE TABLE IF NOT EXISTS music_queue/.test(src) && /saveMusicQueue/.test(src)],
  ['File musique sans plafond', /const MUSIC_PAGE_SIZE=25/.test(src) && /q\.items\.push/.test(src) && !/q\.items\.slice\(0,100\)/.test(src)],
  ['Expansion playlists', /resolveMusicInput/.test(src) && /play\.playlist/.test(src) && /spotifyToken/.test(src) && /api\.deezer\.com/.test(src)],
  ['Cookies musique', /youtube\.cookie/.test(src) && /spotify\.cookie/.test(src) && /deezer\.cookie/.test(src) && /MUSIC_COOKIE_DIR/.test(src)],
  ['10 emojis', /count>=10/.test(src) && /Math\.min\(10/.test(src)],
  ['256 Ko', /262144/.test(src)],
  ['Nettoyage CUSTOM+ assisté', /custom_emoji_cleanup/.test(src) && /customcleanup:keep/.test(src) && /customcleanup:confirm/.test(src)],
  ['Commu ne sanctionne pas', /clients\.one\.on\('interactionCreate',handleInteraction\)/.test(src) && /if\(i\.client===clients\.one && PROTECT_CMDS\.has\(n\)\) return/.test(src)],
  ['Protect porte la protection des rôles', /clients\.two\.on\('guildMemberUpdate'/.test(src) && /clients\.two\.on\('roleCreate'/.test(src)],
  ['Custom prefixes', /CREATE TABLE IF NOT EXISTS custom_prefixes/.test(src) && /setCustomPrefix/.test(src) && /personalText/.test(src)],
  ['Custom aliases', /CREATE TABLE IF NOT EXISTS custom_aliases/.test(src) && /setPersonalAlias/.test(src)],
  ['Prefix cleanup on CUSTOM+ removal', /clearCustomScope\(i\.guildId,uid\)/.test(src)],
  ['Personal shortcuts are not slash-registered', /async function syncCustomCommands\(guild\)\{ return guild; \}/.test(src)],
  ['Slash reparties entre les deux bots', /const PROTECT_CMDS=new Set\(/.test(src) && /const publicSlash=slash\.filter\(x=>!protectedNames\.has\(x\.name\)\)/.test(src)],
  ['Protect slash restricted', /const protectSlash=slash\.filter\(x=>protectedNames\.has\(x\.name\)\)/.test(src)],
  ['Long music reply deferred', /await i\.deferReply\(\{flags:MessageFlags\.Ephemeral\}\); const result=await addMusic/.test(src)],
  ['Music display pagination only', /MUSIC_PAGE_SIZE=25/.test(src) && !/items\.slice\(0,100\)/.test(src)],
  ['Custom prefix rejects reserved/default', /!DEFAULT_PREFIXES\.includes\(p\)/.test(src)],
  ['Custom scope clears aliases', /DELETE FROM custom_aliases/.test(src)],
  ['Custom aliases are personal', /WHERE guild_id=\? AND user_id=\? AND alias=\?/.test(src)],
  ['Éphémère moderne', !/ephemeral:\s*true/.test(src) && /MessageFlags\.Ephemeral/.test(src)],
  ['Requêtes et config en cache', /const stmtCache = new Map\(\)/.test(src) && /const cfgCache = new Map\(\)/.test(src)],
  ['Transactions imbriquables', /SAVEPOINT \$\{point\}/.test(src) && /ROLLBACK TO \$\{point\}/.test(src)],
  ['Fusion profonde de configuration', /const mergeDeep =/.test(src)],
  ['Purge automatique', /function pruneHistory/.test(src) && /function pruneAudit/.test(src) && /pruneHistory\(g\.id\)/.test(src)],
  ['Rôle protégé verrouillé aux owners', /rank\(gid,uid\)>=Math\.max\(ownerLevel\(gid\)/.test(src)],
  ['Composants bornés', /const clip = /.test(src) && /Rien à afficher/.test(src)],
  ['Anti-boucle sur les logs', /burstHit\(message\.guild\.id,'logRestore'/.test(src)],
  ['Aucun seuil brut de hiérarchie', !/rank\([^)]*\)\s*[<>]=?\s*(?:25|70|80|90|100)\b/.test(src)],
  ['Protection complète disponible', /async function protectRoles\(g\)\{\n  if\(!cfg\(g\.id\)\.roles\.protect\)return 0;/.test(src)],
  ['Modal giveaway routé', src.includes("if(scope==='gw'&&(action==='join'||action==='list'))") && src.includes("i.customId==='gw:create'")],
  ['URLs validées', src.includes('function safeUrl') && src.includes('function imageUrl') && src.includes('pic=safeUrl(o.image)')],
  ['Identifiants normalisés', src.includes('const cleanId = ') && !src.includes('replace(/[&]/g')],
  ['Niveaux proposés depuis l’échelle', src.includes('function levelOptions') && !src.includes('HIERARCHY.map')],
  ['Lecture audio protégée', src.includes('if(!q.connection){q.loading=false;return;}') && src.includes("once('error'")],
  ['Catalogue mémoïsé', src.includes('const cmdConfigReady = new Set()')],
  ['Mise en place automatique', src.includes('async function runSetup') && src.includes('async function welcomePanel') && src.includes('setup:run')],
  ['Bannières de section', (src.match(/^\/\/ ─+ /gm) || []).length >= 10],
  ['Aucun code mort connu', !/requireLevels|requireMinAndOwnScope|allowedPrefixes|KIND_LEVEL|restoreLogHistory|WL_ROLE_GRADE_LEVEL/.test(src)],
  ['No AI refs', !/(chatgpt|openai|artificial intelligence)/i.test(src)],
  ['Discord.js présent', !!pkg.dependencies?.['discord.js']],
  ['Voice présent', !!pkg.dependencies?.['@discordjs/voice']],
  ['Cookies exclus du git', /cookies\/\*\.cookie/.test(fs.readFileSync(path.join(root,'.gitignore'),'utf8'))],
  ['Aucune commande slash /sanction', !/\{name:'sanction'/.test(src) && !/commandName==='sanction'/.test(src)],
  ['Accès bot par serveur', /CREATE TABLE IF NOT EXISTS bot_access/.test(src) && /botAccepted\(gid,botId\)/.test(src) && /configAccessPanel/.test(src)],
  ['Validation intégration owner', /integration:accept:/.test(src) && /integration:reject:/.test(src) && /globalOwner\(i.user.id\)/.test(src)],
  ['Intégration identifie owner et ajoutant', /fetchAuditLogs\(\{type:AuditLogEvent.BotAdd/.test(src) && /server_owner_id/.test(src) && /inviter_id/.test(src)],
  ['Blocage avant acceptation', /assertBotAccepted/.test(src) && /botAccepted\(m.guild.id,m.client.user.id\)/.test(src)],
  ['Permissions complètes paginées', /PERMISSION_KEYS=Object\.keys\(PermissionFlagsBits\)/.test(src) && /config:permissionPage/.test(src)],
  ['WL serveur', /function wlPanel\(guild/.test(src) && /configWLPanel/.test(src)],
  ['Catégories ticket et bienvenue', /config:category:ticket/.test(src) && /config:category:welcome/.test(src) && /ticketCategory/.test(src) && /welcomeCategory/.test(src)],
  ['Ticket à motifs', /ticket:open:\$\{v\.value\}/.test(src) && /Sanction/.test(src) && /Contribution/.test(src) && /Bataillon Confirmé/.test(src)],
  ['FAQ compacte', /async function openFAQ/.test(src) && /faq:general/.test(src) && /faq:tickets/.test(src)],
  ['Hiérarchie en base', /CREATE TABLE IF NOT EXISTS hierarchy/.test(src) && /function ensureHierarchy/.test(src) && /function setHierarchyLevel/.test(src)],
  ['Rôles liés à la hiérarchie', /CREATE TABLE IF NOT EXISTS linked_roles/.test(src) && /function roleRank/.test(src) && /Math\.max\(wl,roleRank/.test(src)],
  ['Hiérarchie non figée dans les commandes', !/requireLevels\([^)]*\[\s*\d+\s*,\s*\d+/.test(src) && /function requireCmd/.test(src) && /const CMD_DEFAULT_LEVEL=/.test(src)],
  ['Aucun rôle de serveur codé en dur', /const HIERARCHY = \[\['SYS\+',100\],\['SYS',90\],\['OWNER',80\]\];/.test(src) && !/Protect',50|ND Modérateur|AMBASSADRICE/.test(src)],
  ['Échelle de rôles choisie', /function setTier/.test(src) && /function delTier/.test(src) && /const TIER_MIN=1,TIER_MAX=79/.test(src) && /roleSel\('tier:add'\)/.test(src)],
  ['Échelle sans escalade', /Tu ne peux pas placer un niveau au-dessus ou égal au tien/.test(src) && /Ce rôle est au-dessus de ton niveau/.test(src)],
  ['Droits réglables par rôle', /function cmdRule/.test(src) && /function allowCmd/.test(src) && /=droits/.test(src) && /droits:set:/.test(src)],
  ['Libellés lus de l échelle', /function levelLabel/.test(src) && /FROM linked_roles WHERE guild_id=\? AND level=\?/.test(src)],
  ['Cache de permissions', /const rankCache=new Map\(\)/.test(src) && /function clearRankCache/.test(src)],
  ['Aucun reste de l ancien modèle', !/requireSet|ACCESS_SETS|PV_LEVEL_NAME/.test(src)],
  ['Réglages en cascade', /CREATE TABLE IF NOT EXISTS settings/.test(src) && /const SETTING_SCOPES=\['GLOBAL','ROLE','WL','USER','COMMAND'\]/.test(src) && /function resolveSetting/.test(src)],
  ['Presets couleurs', /const COLOR_PRESETS=/.test(src) && ['Océan','Violet','Rouge','Émeraude','Or','Sombre','Rose'].every(n=>src.includes(`'${n}'`))],
  ['Arborescence de logs complète', /const LOG_TREE=\[/.test(src) && ['wet-log','bl-log','ban-log','badword-log','clear-log','role-log','wl-log','perm-log','abo-log','autorole-log','contrib-log','vente-log','paiement-log','ticket-logs','membre-log','salon-log','commande-log','backup-log','bataillon-log','sante-log','dog-log','giveaway-log'].every(n=>src.includes(`'${n}'`))],
  ['Logs sans doublon', /function ensureLogTree/.test(src) && /c\.name===name&&c\.parentId===cat\.id/.test(src)],
  ['Double log', /function mirrorChannel/.test(src) && /function setMirror/.test(src) && /if\(o\.mirror!==false\)/.test(src)],
  ['Tableaux permanents édités', /CREATE TABLE IF NOT EXISTS panels/.test(src) && /async function refreshTables/.test(src) && /msg\.edit\(\{embeds:\[e\]\}\)/.test(src)],
  ['Neuf tableaux', /const TABLE_DEFS=\[/.test(src) && (src.match(/\['(?:acces|commandes|wl|hierarchie|protect|paiements|prix|roles|config)',/g)||[]).length>=9],
  ['DM de sanction', /const DM_BODY=/.test(src) && /async function notify/.test(src) && /contacte un gérant/.test(src)],
  ['DM sur chaque sanction', ['BL','UNBL','BAN','UNBAN','DERANK','ACCESS_ADD','ACCESS_DEL'].every(k=>new RegExp(`\\b${k}:`).test(src))],
  ['Cooldown et rate limit', /function cooldown\(key,ms\)/.test(src) && /function rateLimit\(key,limit,windowMs\)/.test(src)],
  ['Journal d audit', /CREATE TABLE IF NOT EXISTS audit/.test(src) && /function audit\(gid,actorId/.test(src) && /function pruneAudit/.test(src)],
  ['Verrouillage d urgence', /CREATE TABLE IF NOT EXISTS emergency/.test(src) && /async function emergencySet/.test(src) && /function emergencyOn/.test(src)],
  ['Anti escalade', /async function antiEscalation/.test(src) && /escalation\.blocked/.test(src)],
  ['Anti suppression en masse', /async function guardBurst/.test(src) && /roleDelete/.test(src) && /channelDelete/.test(src)],
  ['Rôle en masse protégé', /const MASS_ROLE_MAX=250/.test(src) && /function massPrepare/.test(src) && /async function massUndo/.test(src) && /mass:run:/.test(src)],
  ['Contrôle de démarrage', /async function startupCheck/.test(src)],
  ['Aide adaptative', /function helpEmbed/.test(src) && /function canUse/.test(src) && /const CMD_GROUPS=/.test(src)],
  ['Démarrage silencieux', (() => { const a = src.indexOf('async function refreshGuild'); const b = src.indexOf('\n}', a); const body = src.slice(a, b); return a > 0 && !/autoSetup|ensureLogTree|welcomePanel|publishConfiguredPanels/.test(body); })()],
  ['Logs sur serveur choisi', /function logHome/.test(src) && /logs:home/.test(src) && !/if\(!ch\)\{await ensureLogTree/.test(src)],
  ['Stats en salons vocaux', /ChannelType\.GuildVoice,parent:cat\.id/.test(src) && /=stats/.test(src)],
  ['Hiérarchie sans chiffres', /function syncTierOrder/.test(src) && !/Niveau entre/.test(src)],
  ['Transcript HTML', /function transcriptHtml/.test(src) && /text\/html|\.html`/.test(src)],
  ['Transcript de ticket', /async function ticketTranscript/.test(src) && /async function closeTicket/.test(src) && /AttachmentBuilder\(Buffer\.from/.test(src)],
  ['Paiements à cinq statuts', ['En attente','Payé','Refusé','Remboursé','À vérifier'].every(s=>src.includes(`'${s}'`)) && /CREATE TABLE IF NOT EXISTS command_permissions/.test(src)],
  ['Mots interdits', /CREATE TABLE IF NOT EXISTS badwords/.test(src) && /async function enforceBadwords/.test(src)],
  ['Salons réservés', /CREATE TABLE IF NOT EXISTS protected_channels/.test(src) && /async function enforceProtectedChannel/.test(src)],
  ['Règlement et panneaux de rôles', /async function publishRules/.test(src) && /async function publishRolePanel/.test(src) && /rolepanel:/.test(src)],
  ['Giveaways persistants', /CREATE TABLE IF NOT EXISTS giveaways/.test(src) && /async function tickGiveaways/.test(src)],
  ['Arrêt propre', /async function shutdown/.test(src) && /process\.on\('SIGTERM'/.test(src) && /rawDb\.close\(\)/.test(src)],
  ['Aucun jeton en dur', !/[MN][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}/.test(src)],
  ['Commentaires courts', !src.split('\n').some(l=>{const m=l.trim().match(/^\/\/\s*(.+)$/);return m && m[1].split(/\s+/).length>4;})],
];
const sqliteTest = `import { DatabaseSync } from 'node:sqlite';
const raw = new DatabaseSync(':memory:');
const db = {
  prepare(sql, options) { const stmt = raw.prepare(sql, options); return {
    run(...args) { return stmt.run(...args); },
    get(...args) { return stmt.get(...args); },
    all(...args) { return stmt.all(...args); }
  }; }
};
db.prepare('CREATE TABLE t(id TEXT PRIMARY KEY, value INTEGER)').run();
db.prepare('INSERT INTO t(id,value) VALUES(?,?)').run('a', 1);
if (db.prepare('SELECT value FROM t WHERE id=?').get('a').value !== 1) process.exit(1);
`;
const sqlitePath=path.join(root,'.sqlite-selftest.mjs');
fs.writeFileSync(sqlitePath,sqliteTest);
const failed=[];
for(const f of required)if(!fs.existsSync(path.join(root,f)))failed.push(`Fichier manquant: ${f}`);
try{execFileSync(process.execPath,['--check','index.js'],{cwd:root,stdio:'pipe'});}catch{failed.push('node --check a échoué');}
for(const [name,ok] of checks)if(!ok)failed.push(`Check échoué: ${name}`);
try{execFileSync(process.execPath,[sqlitePath],{cwd:root,stdio:'pipe'});}catch{failed.push('node:sqlite positionnel échoué');}
try{fs.unlinkSync(sqlitePath);}catch{}
console.log(`Checks: ${checks.length + required.length + 1}`);
console.log(`Échecs: ${failed.length}`);
if(failed.length){for(const x of failed)console.log(`- ${x}`);process.exit(1);}
console.log('Tous les contrôles statiques ont passé.');

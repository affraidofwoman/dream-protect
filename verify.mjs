import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const src = fs.readFileSync(path.join(root,'index.js'),'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const required = ['package.json','README.md','.env.example','.gitignore','AUDIT.md','cookies/README.md','data/.gitkeep','index.js'];
const checks = [
  ['Deux tokens', /BOT1_TOKEN/.test(src) && /BOT2_TOKEN/.test(src)],
  ['Deux clients dans un processus', /one:new Client/.test(src) && /two:new Client/.test(src)],
  ['SQLite guild-scoped', /guild_id TEXT/.test(src) && /guilds\(id TEXT PRIMARY KEY/.test(src)],
  ['CUSTOM+ PV réel', /PV_LEVEL_NAME/.test(src) && /WLCUSTOMPLUS/.test(src) && /Math\.max\(95,pvLevelForOwner/.test(src)],
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
  ['Commu ne sanctionne pas', /clients\.one\.on\('interactionCreate',handleInteraction\)/.test(src) && /if\(i\.client===clients\.one && \['configuration'\]\.includes\(n\)\) return/.test(src)],
  ['Protect porte la protection des rôles', /clients\.two\.on\('guildMemberUpdate'/.test(src) && /clients\.two\.on\('roleCreate'/.test(src)],
  ['Custom prefixes', /CREATE TABLE IF NOT EXISTS custom_prefixes/.test(src) && /setCustomPrefix/.test(src) && /personalText/.test(src)],
  ['Custom aliases', /CREATE TABLE IF NOT EXISTS custom_aliases/.test(src) && /setPersonalAlias/.test(src)],
  ['Prefix cleanup on CUSTOM+ removal', /clearCustomScope\(i\.guildId,uid\)/.test(src)],
  ['Personal shortcuts are not slash-registered', /async function syncCustomCommands\(guild\)\{ return guild; \}/.test(src)],
  ['Slash list reduced', /const slash=\[/.test(src) && (src.match(/\{name:'[^']+',description:/g)||[]).length <= 12],
  ['Protect slash restricted', /const protectSlash=slash\.filter\(x=>protectedNames\.has\(x\.name\)\)/.test(src)],
  ['Long music reply deferred', /await i\.deferReply\(\{ephemeral:true\}\); const result=await addMusic/.test(src)],
  ['Music display pagination only', /MUSIC_PAGE_SIZE=25/.test(src) && !/items\.slice\(0,100\)/.test(src)],
  ['Custom prefix rejects reserved/default', /!DEFAULT_PREFIXES\.includes\(p\)/.test(src)],
  ['Custom scope clears aliases', /DELETE FROM custom_aliases/.test(src)],
  ['Custom aliases are personal', /WHERE guild_id=\? AND user_id=\? AND alias=\?/.test(src)],
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
  ['Ticket à motifs', /ticket:open:\$\{v\}/.test(src) && /Sanction/.test(src) && /Contribution/.test(src) && /Bataillon Confirmé/.test(src)],
  ['FAQ compacte', /async function openFAQ/.test(src) && /faq:general/.test(src) && /faq:tickets/.test(src)],
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

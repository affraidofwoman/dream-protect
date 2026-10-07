import 'dotenv/config';
import { ActivityType, REST, Routes } from 'discord.js';
import { db, stopTimers } from './lib/base.js';
import { NAMES, bots } from './lib/bots.js';
import { COMMANDS, onInteraction, onMessage, slashFor } from './lib/commandes.js';
import { boot, start } from './lib/surveillance.js';

const TOKENS = { main: process.env.BOT1_TOKEN?.trim(), guard: process.env.BOT2_TOKEN?.trim() };

// Événements
for (const [role, client] of Object.entries(bots)) {
  client.on('messageCreate', (m) => onMessage(m).catch((e) => console.error(`[${NAMES[role]}] message :`, e?.message || e)));
  client.on('interactionCreate', (i) => onInteraction(i).catch((e) => console.error(`[${NAMES[role]}] interaction :`, e?.message || e)));
  client.on('error', (e) => console.error(`[${NAMES[role]}] erreur :`, e?.message || e));
  client.on('shardDisconnect', () => console.warn(`[${NAMES[role]}] déconnecté, reconnexion…`));
}
start();

// Commandes slash
async function register(role) {
  const client = bots[role];
  const rest = new REST({ version: '10' }).setToken(TOKENS[role]);
  const body = slashFor(role);
  const guilds = (process.env.REGISTER_GUILD_ID || '').split(/[\s,;]+/).filter(Boolean);
  if (guilds.length) {
    for (const id of guilds) {
      if (client.guilds.cache.has(id)) await rest.put(Routes.applicationGuildCommands(client.user.id, id), { body });
    }
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
  } else await rest.put(Routes.applicationCommands(client.user.id), { body });
  return body.length;
}

// Bots prêts
bots.main.once('clientReady', async (c) => {
  console.log(`${NAMES.main} connecté : ${c.user.tag}`);
  c.user.setPresence({ activities: [{ name: '/help', type: ActivityType.Listening }], status: 'online' });
  const n = await register('main').catch((e) => console.error('[slash]', e?.message || e));
  if (n !== undefined) console.log(`${NAMES.main} : ${n} commandes slash`);
});
bots.guard.once('clientReady', async (c) => {
  console.log(`${NAMES.guard} connecté : ${c.user.tag}`);
  c.user.setPresence({ activities: [{ name: 'le serveur', type: ActivityType.Watching }], status: 'online' });
  const n = await register('guard').catch((e) => console.error('[slash]', e?.message || e));
  if (n !== undefined) console.log(`${NAMES.guard} : ${n} commandes slash`);
  for (const g of c.guilds.cache.values()) await boot(g).catch((e) => console.error(`[démarrage] ${g.name} :`, e?.message || e));
  console.log(`${NAMES.guard} prêt sur ${c.guilds.cache.size} serveur(s)`);
});

// Arrêt propre
let stopping = false;
export async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  stopTimers();
  await Promise.allSettled([bots.main.destroy(), bots.guard.destroy()]);
  try {
    db.close();
  } catch {}
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('unhandledRejection', (e) => console.error('Rejet non géré :', e?.message || e));
process.on('uncaughtException', (e) => console.error('Exception :', e?.message || e));

// Lancement
if (process.env.TEST_MODE !== '1') {
  if (!TOKENS.main || !TOKENS.guard) {
    console.error('BOT1_TOKEN et BOT2_TOKEN sont requis dans le fichier .env.');
    await shutdown(1);
  }
  if (process.env.DRY_RUN === '1') {
    console.log(`Vérification à sec : ${COMMANDS.length} commandes, ${slashFor('main').length} + ${slashFor('guard').length} slash.`);
    await shutdown(0);
  }
  await bots.main.login(TOKENS.main);
  await bots.guard.login(TOKENS.guard);
}

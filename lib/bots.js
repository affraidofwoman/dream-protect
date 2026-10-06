import { Client, GatewayIntentBits, Options, Partials } from 'discord.js';
import { db, now } from './base.js';

// Deux clients
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildModeration,
];
const makeCache = Options.cacheWithLimits({
  ...Options.DefaultMakeCacheSettings,
  MessageManager: 50,
  PresenceManager: 0,
  ReactionManager: 0,
});
const make = () => new Client({ intents, makeCache, partials: [Partials.Channel, Partials.Message, Partials.GuildMember] });

// main = quotidien, guard = sécurité
export const bots = { main: make(), guard: make() };
export const NAMES = { main: 'Commu Dream', guard: 'Dream Protect' };
export const roleOf = (client) => (client === bots.guard ? 'guard' : 'main');
export const other = (role) => (role === 'guard' ? 'main' : 'guard');

// Serveur partagé
export function guildOf(id) {
  return bots.guard.guilds.cache.get(id) || bots.main.guilds.cache.get(id) || null;
}

// Bot qui répond
export function answers(client, guildId, role) {
  if (roleOf(client) === role) return true;
  return !bots[role].guilds.cache.has(guildId);
}

// Serveurs validés
export function accepted(guildId, botId) {
  return db.prepare("SELECT 1 FROM bot_access WHERE guild_id=? AND bot_id=? AND status='accepted'").get(guildId, botId) !== undefined;
}
export function setAccess(guildId, client, status, actorId = null, extra = {}) {
  db.prepare(
    `INSERT INTO bot_access(guild_id,bot_id,bot_name,status,inviter_id,server_owner_id,requested_at,decided_at,decided_by)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(guild_id,bot_id) DO UPDATE SET status=excluded.status,decided_at=excluded.decided_at,decided_by=excluded.decided_by`,
  ).run(
    guildId,
    client.user.id,
    NAMES[roleOf(client)],
    status,
    extra.inviter ?? null,
    extra.owner ?? null,
    now(),
    status === 'pending' ? null : now(),
    actorId,
  );
}

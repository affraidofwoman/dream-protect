# DREAM DUAL BOT — V10 performance audit

## Cause found in V9
The main CPU hotspot was `protectRoles(g)`: it iterated over **every cached member of every guild** whenever a member changed, and again on role create/update/delete and refresh cycles. In an active guild this could repeatedly scan thousands of members and issue role removals/logs.

V9 also kept large Discord.js caches on **two clients** while caching messages/presences/reactions that the bot did not need persistently.

## V10 changes
- Role protection is now **event-driven per member** (`guildMemberAdd` / `guildMemberUpdate`). No guild-wide member scan on each event.
- Role create/update/delete no longer triggers a full protection scan.
- Instant refreshes are reduced to a lightweight stats refresh.
- Persistent Discord.js caches are bounded:
  - `GuildMemberManager`: 500 cached members per client, bots kept.
  - `MessageManager`: disabled.
  - `PresenceManager`: disabled.
  - `ReactionManager`: disabled.
- The 30-minute full maintenance remains the safety net for configuration, logs, locks, statistics and managed content.
- Existing command behaviour and server isolation are preserved.

## Verification
- `node --check index.js`: PASS
- static verification: **53/53 — 0 failures**
- no guild-wide `protectRoles` scan remains in runtime paths

## Expected effect
The previous pattern could create sustained CPU spikes in active/large guilds. V10 removes that O(number of cached members) work from high-frequency events and sharply limits cache growth. Exact RAM/CPU values still depend on guild count, member counts, message traffic and Discord gateway load, so they must be measured on the actual host.

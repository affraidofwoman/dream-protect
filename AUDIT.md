# Audit complet

```
node --check index.js      OK
verify.mjs                109 contrôles statiques · 0 échec
test.mjs                  158 tests · 0 échec
démarrage à sec           32 slash · 23 salons de logs · 9 tableaux · 50 tables · 3 index
```

## Bugs trouvés et corrigés

| # | Problème | Effet | Correction |
| --- | --- | --- | --- |
| 1 | `setCfg(g, …)` recevait l'objet serveur au lieu de son identifiant | le premier auto-setup faisait échouer la liaison SQLite | identifiant passé |
| 2 | `+pic` acceptait n'importe quelle chaîne comme image | une URL invalide faisait **échouer tous les embeds du serveur** | `imageUrl()` à l'écriture et `safeUrl()` dans `embed()` |
| 3 | Rôle protégé autorisé dès le niveau 25 écrit en dur | n'importe quel petit grade pouvait porter un rôle protégé | verrouillé au niveau owner |
| 4 | Menus de niveau WL construits sur la liste statique | impossible d'attribuer un niveau lié à un rôle | `levelOptions()` lit l'échelle du serveur |
| 5 | `UPDATE linked_roles SET name=name` | un rôle renommé gardait son ancien nom partout | nom réellement mis à jour + log |
| 6 | `/wet` se posait sur l'auteur, niveau figé à 35 | la commande ne sanctionnait personne | cible, retrait des WL, ban, DM, niveau réel |
| 7 | `/wet-info` montrait tous les niveaux | fuite d'informations vers le bas de la hiérarchie | filtré au niveau du demandeur |
| 8 | Commandes du bot Protect routées par `handleInteraction` seul | BOT 2 ne voyait pas ses propres commandes | son gestionnaire est câblé |
| 9 | `command_permissions.roles` ajoutée avant la création de la table | colonne absente sur toute base neuve | colonne dans le `CREATE TABLE` |
| 10 | `playNext` appelait `connection.subscribe` sans vérifier la connexion | une déconnexion vidait toute la file morceau par morceau | sortie propre, compteur d'échecs, `error` géré |
| 11 | Aucun `AudioPlayerStatus.Error` écouté | la file restait bloquée en `loading` | handler `error` qui passe au suivant |
| 12 | Bloc ND inversé (`Modérateur` au-dessus de `Manager`) | hiérarchie fausse | remplacé par l'échelle de rôles |
| 13 | `=ui` oubliait un niveau dans sa liste en dur | un grade n'avait pas accès | jeux de niveaux supprimés |
| 14 | `can()` sortait avant de lire l'autorisation explicite | un accord nominatif ne servait à rien | `allowCmd()` lit l'explicite en premier |
| 15 | `requireAccess(i.guildId,…,'wl',80)` et `'wl',50` sur la même clé | le seuil 80 était écrasé par le 50 | clé `wl-grant` distincte |
| 16 | `.env.example` manquant | `npm run check` échouait d'office | créé et prérempli |
| 17 | `src/index.js` doublon périmé | deux sources de vérité | supprimé |
| 18 | Rejet non traité sans jeton | le processus restait suspendu | message clair puis sortie |
| 19 | Aucune purge | `log_messages`, `audit`, `giveaways`, `mass_ops` grossissaient sans fin | `pruneHistory()` à chaque cycle |
| 20 | `ALTER TABLE` avant `CREATE TABLE` (locks, permissions) | migrations silencieusement perdues | ordre corrigé |
| 21 | `ephemeral: true` (135 fois) | déprécié depuis discord.js 14.17, avertissements au démarrage | `flags: MessageFlags.Ephemeral` |
| 22 | `addOptions([])` possible sur un menu vide | exception à l'affichage | menu désactivé avec « Rien à afficher » |
| 23 | `setValue('')` sur un champ de modal | refus de l'API Discord | valeur posée seulement si présente |
| 24 | Embeds sans bornes de longueur | refus de l'API sur un texte trop long | tout est tronqué proprement |
| 25 | Fusion de configuration sur un seul niveau | un réglage imbriqué effaçait ses voisins par défaut | `mergeDeep()` |
| 26 | `transaction()` non imbriquable | `BEGIN` dans `BEGIN` → erreur SQLite | `SAVEPOINT` / `ROLLBACK TO` |
| 27 | Sauvegarde journalisée toutes les 30 min | 48 messages par jour et par serveur | une ligne par jour |
| 28 | Restauration de log sans limite | suppressions répétées = spam infini | 25 restaurations par minute maximum |
| 29 | Identifiants nettoyés de façons différentes | une mention de rôle passait, l'autre non | `cleanId()` unique |
| 30 | Nouvelles commandes absentes du catalogue | impossible de les couper ou de les router | catalogue complété |

## Failles fermées

| Faille | Fermeture |
| --- | --- |
| S'attribuer un rôle supérieur | `antiEscalation` retire le rôle et journalise l'auteur |
| Se placer haut dans l'échelle | niveaux bornés à 79, jamais à son niveau ni au-dessus |
| Déplacer ou retirer un rôle supérieur | refusé |
| Ouvrir une commande au-dessus de soi | refusé sur le niveau comme sur les rôles |
| Porter un rôle protégé | réservé au niveau owner |
| Contourner la hiérarchie | `guardTarget` refuse soi-même, égal, supérieur, owner global |
| Bannir, derank ou WET un supérieur | rang comparé avant action, rôles inclus |
| Contourner une WL | refus nominatif prioritaire sur tout |
| Ajout massif de rôles | confirmation, plafond 250, cooldown 60 s, annulation |
| Supprimer les logs | message recréé, salon recréé, auteur identifié, débit limité |
| Rouvrir un salon de logs | permissions remises et événement journalisé |
| Supprimer des rôles ou salons en série | alerte et verrouillage d'urgence automatique |
| Casser l'affichage avec une URL | toute image est validée avant usage |
| Boucle de synchronisation | rafraîchissements regroupés et différés |
| Tableaux republiés en boucle | identifiants conservés, messages modifiés |

## Optimisations

- **Requêtes préparées en cache** : `db.prepare` recompilait le SQL à chaque appel. `rank()`, `cfg()`, `allowCmd()` tournent des dizaines de fois par message — le SQL est maintenant compilé une seule fois.
- **Configuration en cache** par serveur, invalidée à l'écriture. `embed()` appelle `cfg()` : c'était une lecture SQLite et un `structuredClone` par embed.
- **Owners en mémoire** : plus de lecture ni de découpage d'environnement à chaque test de permission.
- **Catalogue de commandes mémoïsé** : `ensureCommandConfig` lançait une transaction et 22 insertions à chaque commande.
- **Cache de rang** 5 s, vidé à chaque changement de WL, de rôle lié ou de membre.
- **Pragmas SQLite** : `synchronous=NORMAL`, `busy_timeout`, `temp_store=MEMORY`, `cache_size=16 Mo`.
- **Index** sur `audit`, `sanctions`, `payments`.
- **Purge automatique** de l'historique, des sanctions en attente, des opérations de masse, des giveaways finis et des abonnements expirés.
- **Code mort retiré** : `KIND_LEVEL`, `LEVEL_NAME`, `allowedPrefixes`, `requireLevels`, `requireMinAndOwnScope`, `WL_ROLE_GRADE_NAME`, `WL_ROLE_GRADE_LEVEL`, `wlRoleGrade`, `restoreLogHistory`, `DEFAULT.hierarchy`.

## Automatisation

- `=setup` et `/setup` : logs, salons, tableaux, verrous, statistiques, protection des rôles, purge et contrôle de santé en une fois, avec un rapport de ce qui a été fait et de ce qui reste.
- Panneau d'accueil permanent, mis à jour tout seul, avec trois boutons : tout mettre en place, régler la hiérarchie, voir les commandes.
- Au démarrage et toutes les 30 minutes : configuration rechargée, hiérarchie resynchronisée, logs et tableaux réparés, rôles liés orphelins nettoyés, historique purgé.
- Rôle renommé, rôle supprimé, salon de logs supprimé ou rouvert : détecté, réparé, journalisé.
- Giveaways tirés automatiquement, sanctions en attente expirées, sauvegardes tournantes.

## Présentation

- Aide groupée en champs avec une icône par famille et le total en pied d'embed.
- Fiche membre avec avatar, date d'arrivée, état, et les montants formatés.
- Barres de progression sur les logs, les tableaux et les paiements.
- Tous les embeds horodatés côté logs, titres et valeurs bornés, champs vides jamais envoyés.
- `=logs` affiche l'arborescence salon par salon en vert ou rouge.
- `=hierarchie` montre 🔒 pour un accès interne et 🎭 pour un rôle du serveur.
- Onze bannières de section dans `index.js` pour s'y repérer d'un coup d'œil.

## Couverture des tests

Échelle de rôles (bornes, tri, libellés, anti-escalade), accès internes liés à un rôle,
rangs WL et rôles, hiérarchie stricte, droits par défaut, par niveau et par rôle,
refus et accord nominatifs, cascade des réglages, thèmes, aide adaptative,
arborescence de logs, corps des neuf tableaux, statuts de paiement, durées,
mots interdits, cooldown, rate limit, audit, rôles protégés, WL rôle, rôle en masse,
répartition entre les deux bots, validation d'URL, nettoyage d'identifiants,
fusion profonde de configuration, transactions imbriquées et annulées, purge.

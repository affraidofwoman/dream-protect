# Audit

## Structure

| Fichier | Contenu |
|---|---|
| `index.js` | Démarrage, connexion des deux bots, commandes slash, arrêt propre |
| `lib/base.js` | Base SQLite, configuration, réglages ciblés, anti-spam, sauvegardes |
| `lib/bots.js` | Les deux clients, quel bot répond, quel bot agit, validation des serveurs |
| `lib/ui.js` | Présentation : cartes, logs, MP, boutons, menus, couleurs |
| `lib/droits.js` | Rangs, hiérarchie du staff, groupes de droits, vérifications avant chaque action |
| `lib/logs.js` | Salons de logs, serveur choisi, double log, logs protégés, MP de sanction, transcripts |
| `lib/moderation.js` | Bans, blacklist, wet, derank, verrous, clear, mots interdits, salons réservés, rôle en masse, laisse, urgence |
| `lib/communaute.js` | Tickets, bienvenue, règlement, panneaux de rôles, vocaux, giveaways, smash or pass, stats, fiches |
| `lib/economie.js` | Prix, paiements, contributions, abonnements, chercheur |
| `lib/reglages.js` | Hiérarchie, droits, rangs, logs, couleurs, tableaux permanents |
| `lib/commandes.js` | Registre unique des commandes, routeur, aide, erreurs lisibles |
| `lib/surveillance.js` | Événements, anti-escalade, réparations, contrôle régulier, sauvegardes |

## Failles corrigées par rapport à l’ancienne version

- Un OWNER passait toutes les commandes, même celles réservées à SYS.
- `/wet` ne bannissait que sur un serveur : il bannit maintenant sur tous les serveurs des deux bots.
- `&bl` n’enregistrait que la blacklist sans bannir.
- `&derank` laissait les rôles staff Discord.
- Les owners du `.env` restaient owners en base même retirés du fichier.
- Le propriétaire du serveur n’avait aucun rang.
- Les fiches de sanction d’un supérieur étaient visibles par tout le staff.
- Les messages partaient en double (les deux bots répondaient, panneaux postés à chaque démarrage).
- Le démarrage créait des salons sans rien demander.

## Protections vérifiées par les tests

Rangs, ordre du staff, seuils de droits, urgence, cible égale ou supérieure, propriétaire protégé, owners protégés,
bot trop bas, rôle sensible, rôle protégé, mots interdits, salons réservés, routeur à un seul bot,
bannissement simulé de bout en bout, tableaux, structure exacte des logs, commandes slash valides.

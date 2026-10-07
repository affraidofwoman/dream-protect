# Dream

Deux bots Discord, un seul projet, un seul lancement.

| Bot | Rôle |
|---|---|
| 🌙 **Commu Dream** (BOT 1) | Le quotidien : sanctions, salons, tickets, profils, giveaways, vocaux… |
| 🛡️ **Dream Protect** (BOT 2) | La sécurité et la configuration : rangs, hiérarchie, droits, logs, paiements, tableaux, surveillance, MP de sanction. |

Les deux partagent la même base et le même moteur de droits. Une commande n’a qu’un seul bot qui répond : jamais de double message.

## Installation

```
npm install
cp .env.example .env
npm start
```

Dans `.env` : les deux jetons (`BOT1_TOKEN`, `BOT2_TOKEN`) et ton identifiant dans `OWNER_IDS`.
Node 22.13 ou plus (la base SQLite est intégrée, rien à compiler).

## Premiers pas sur le serveur

Rien n’est créé tout seul. Tu choisis tout :

1. `=hierarchie` : ajoute tes rôles staff. Leur ordre suit celui des rôles Discord.
2. `=droits` : choisis à partir de quel rôle chaque groupe de commandes est ouvert.
3. `=logs` : choisis le serveur qui reçoit les salons de logs (souvent un serveur à part).
4. `=tableaux` dans un salon : les 9 tableaux permanents s’y installent et se mettent à jour seuls.
5. Selon tes besoins : `=ticket`, `=reglement`, `=bienvenue`, `=panneau`, `=vocal`, `=stats`, `=prix`, `=couleur`.

## Les rangs

- **Créateur** : les identifiants de `OWNER_IDS`. Accès total.
- **SYS+**, **SYS**, **OWNER** : donnés avec `/wl` (ou liés à un rôle Discord dans `=hierarchie`).
- **Staff** : tes rôles Discord choisis dans `=hierarchie`, du plus haut au plus bas.
- Le propriétaire du serveur est SYS+ d’office.

Règle d’or : personne n’agit sur quelqu’un de son rang ou au-dessus, ni sur un rôle plus haut que le sien.

## Les commandes

`/help` montre à chacun uniquement ce qu’il peut lancer.

| Groupe | Commandes | Ouvert par défaut à |
|---|---|---|
| Pour tout le monde | `/help` `/profil` `+pic` `+banner` `/explain` `/contrib` `/perm` `/acces` `/abo` `=smash` | tous |
| Fiche membre | `=ui` `/invite` `.membre` | tout le staff |
| Bannir | `+ban` `+unban` `-baninfo` `+unbanall` | OWNER |
| Derank | `&derank` | OWNER |
| Salons et WET | `&lock` `&unlock` `/wet` `/wet-info` | OWNER |
| Owner | `&bl` `&unbl` `&blinfo` `/dog-add` `/dog-del` | OWNER |
| Vocaux | `=pv` `=acces` `=all` `=pvlist` `=mv` `=join` `=vmall` `=wlmv` `=follow` `=menotte` `=mp` | OWNER |
| Rôles | `/addrole` `/delrole` | OWNER |
| Rôle en masse | `+massiveroleadd` | SYS |
| Contenu | `&clear` `+badword` `/protect` `=ticket` `=reglement` `=panneau` `/giveaway` `/say` | OWNER |
| Argent | `/add` `/del` `/logs` `/payment` `=default` `=prix` | OWNER |
| Configuration | `/wl` `=hierarchie` `=droits` `=logs` `=tableaux` `=stats` `=couleur` `=bienvenue` `=vocal` `=raid` `/refresh` `&l0all` `=urgence` | SYS |

Les anciens préfixes restent acceptés : `+lock`, `+unlock`, `&lockall`.
Une commande préfixée lancée sans les droits est ignorée en silence, comme sur airline.

## Ce qui tourne tout seul

- Contrôle toutes les 12 minutes : rôles staff, verrous, bannis qui reviennent, laisses, logs, tableaux, stats.
- Anti-escalade : un rôle sensible donné par quelqu’un qui n’en a pas le droit est retiré.
- Suppressions de rôles ou de salons en série : verrouillage d’urgence automatique.
- Anti-raid : alerte sur les arrivées en masse, vérification « Élevé » le temps de la salve (`=raid`).
- Un log supprimé est remis aussitôt.
- Sauvegarde de la base toutes les 30 minutes (les 10 dernières sont gardées dans `data/backups`), une copie par jour dans `backup-log`.

## Vérifier

```
npm run check
```

Contrôles statiques et tests (droits, hiérarchie, routeur, sanctions, logs, tableaux).

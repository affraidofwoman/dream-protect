# DREAM — deux bots, un seul projet

Un dossier, un lancement, un processus, deux clients Discord.

- **Dream Protect** (BOT 1) — l'usage quotidien sur tout le serveur.
- **Security / Manager** (BOT 2) — permissions, hiérarchie, WL, prix, paiements, tableaux, configuration et sécurité.

BOT 2 est la source de vérité. BOT 1 applique.

## Démarrage

```
npm install
cp .env.example .env     # puis coller les deux jetons
npm start
```

Sur le serveur, une seule commande suffit pour tout mettre en place :

```
=setup
```

Elle crée les salons de logs, les tableaux, les destinations, vérifie les rôles
et t'affiche ce qui reste à faire. Un panneau permanent reprend les trois boutons
utiles : tout mettre en place, régler la hiérarchie, voir les commandes.

Vérifications :

```
npm run check            # syntaxe + 109 contrôles statiques + 158 tests
npm test                 # tests seuls
```

Node 24 minimum (base `node:sqlite` intégrée, aucune compilation native).

## Configuration

Tout vit dans `.env` — aucun secret dans le code.

| Variable | Rôle |
| --- | --- |
| `BOT1_TOKEN` | jeton Dream Protect |
| `BOT2_TOKEN` | jeton Security / Manager |
| `OWNER_IDS` | owners globaux, séparés par des virgules (déjà prérempli) |
| `REGISTER_GUILD_ID` | serveurs d'enregistrement des commandes (vide = global) |
| `DATABASE_PATH` | fichier SQLite (défaut `./data/dream.sqlite`) |
| `BACKUP_MINUTES` | fréquence des sauvegardes |

## Hiérarchie

Rien n'est codé en dur. Il reste trois accès internes, qui viennent des WL :

```
SYS+ 100 · SYS 90 · OWNER 80
```

Tout le reste, c'est **tes rôles Discord**, que tu places sur une échelle de 1 à 79.

```
=hierarchie                              ouvrir le panneau
=hierarchie ajouter @Protect 50          placer un rôle
=hierarchie retirer @Protect             le sortir de l'échelle
=hierarchie interne OWNER @Direction     lier un accès interne à un rôle
```

Le panneau propose un menu de rôles : tu choisis le rôle, il demande le niveau.
Un rôle placé donne son niveau à qui le porte. Le rang retenu est le plus haut
entre les WL et les rôles.

Garde-fous : un niveau de rôle reste entre 1 et 79, donc jamais au-dessus d'un
owner. Personne ne peut placer, déplacer ou retirer un rôle à son niveau ou
au-dessus. Personne ne peut agir sur un rang égal ou supérieur au sien —
derank, ban, bl, lock, rôles, permissions, WL, WET.

## Droits des commandes

Chaque commande a un niveau minimum par défaut. Tu peux le remplacer par un
niveau à toi, ou directement par une liste de rôles.

```
=droits                                  tout voir
=droits +lock                            voir et régler au menu
=droits +lock @Protect @Univers          réservée à ces rôles
=droits +lock niveau 40                  réservée au niveau 40 et au-dessus
=droits +lock defaut                     revenir au défaut
```

Un owner passe toujours. Un refus posé sur une personne précise l'emporte sur
tout le reste.

## Commandes

`/help` n'affiche que ce que la personne peut réellement lancer.

| Groupe | Commandes |
| --- | --- |
| Tout le monde | `/help` `/profil` `/explain` `/contrib` `/smash` |
| Tarifs | `/perm` `/acces` `/abo` |
| Outils | `=ui` `=default` `+pic` `+banner` `=pv` `=acces` |
| Sanctions | `+ban` `+unban` `-baninfo` `&bl` `&unbl` `&blinfo` `&derank` `/wet` `/wet-info` |
| Salons | `&clear` `+badword` `+lock` `+unlock` `&lockall` `/protect` |
| Accès | `/wl` `/addrole` `/delrole` `+massiveroleadd` |
| Suivi | `/add` `/del` `/logs` `/payment` |
| Fun | `/dog-add` `/dog-del` `/giveaway` |
| Administration | `=setup` `=logs` `=tableaux` `=reglement` `=panneau` `=couleur` `=mirror` `=hierarchie` `=droits` `=urgence` `/configuration` |

Aucune sanction ne part sans confirmation. La personne reçoit un message privé
court et lisible pour un ban, un débannissement, une blacklist, un derank, un
WET ou un changement d'accès.

## Logs

`=logs` crée et répare l'arborescence, sans jamais dupliquer un salon existant.

```
Logs · Sanctions        wet-log bl-log ban-log badword-log clear-log
Logs · Rôles & Accès    role-log wl-log perm-log abo-log autorole-log
Logs · Économie         contrib-log vente-log paiement-log
Logs · Tickets          ticket-logs
Logs · Serveur          membre-log salon-log commande-log backup-log bataillon-log sante-log
Logs · Fun & Vocal      dog-log giveaway-log musique-log
```

`=mirror <clé> #salon` envoie en plus l'événement dans les logs publics du
serveur. À la fermeture d'un ticket, le transcript part dans `ticket-logs` et
dans la destination configurée, avec ticket, catégorie, membre, staff et motif.

## Tableaux

Neuf tableaux permanents dans `Tableaux · DREAM` : accès, commandes, WL,
hiérarchie, Protect, paiements, prix, rôles, configuration. Les identifiants de
message sont conservés et les messages sont modifiés, jamais republiés.
`=tableaux` reconstruit ce qui manque.

## Couleurs et réglages

Sept thèmes : Océan, Violet, Rouge, Émeraude, Or, Sombre, Rose.

```
=couleur Océan        pour le serveur
=couleur moi Rose     pour soi
```

Les réglages se superposent dans cet ordre : `GLOBAL → ROLE → WL → USER → COMMAND`.

## Sécurité

- Anti-escalade de rôle et de permission, avec retrait automatique.
- Rôles protégés et salons réservés à un niveau.
- Rate limit, cooldown et journal d'audit sur 30 jours.
- `+massiveroleadd` demande une confirmation, plafonne à 250 membres et reste annulable.
- Suppression de rôles ou de salons en série : alerte et verrouillage d'urgence.
- `=urgence` verrouille tout le serveur, `=urgence off` le libère.
- Les salons de logs supprimés ou rouverts sont recréés et reprotégés.
- Toute image est validée avant d'entrer dans un embed.
- Sauvegardes SQLite tournantes, dix archives conservées, arrêt propre sur SIGTERM.
- Purge automatique de l'historique, des sanctions expirées et des giveaways finis.

## Fichiers

```
index.js        tout le code
test.mjs        158 tests de hiérarchie, accès, réglages, logs et tableaux
verify.mjs      109 contrôles statiques
AUDIT.md        les 30 bugs trouvés, les failles fermées, les optimisations
data/           base SQLite et sauvegardes
cookies/        jetons musique facultatifs
```

# DREAM DUAL BOT — V7

## Correction importante
Les commandes punitives ne s'exécutent plus directement.

`/sanction @membre` → aperçu → choix de la sanction → confirmation → exécution.

Sanctions disponibles :
- Avertissement
- Timeout
- Expulsion
- Bannissement

Le timeout demande sa durée avant confirmation.

Les raccourcis `+ban`, `+kick`, `+expulse`, `+timeout` et `+warn` utilisent le même principe.

Aucune action punitive n'est appliquée avant la confirmation.

### V8 — changements majeurs
Le système d'intégration est désormais validé par les owners DREAM avant activation par serveur. La configuration serveur est centralisée dans `/configuration` avec navigation en cascade, gestion des destinations/catégories, permissions, WL et accès Commu/Protect. `/sanction` n'est plus une commande slash.

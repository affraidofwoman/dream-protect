# Cookies musique

Place ici uniquement les fichiers locaux que tu possèdes déjà et que tu veux charger pour les services musique.

Fichiers reconnus :
- `youtube.cookie` — cookie brut utilisé par le moteur YouTube ; chargé au démarrage.
- `spotify.cookie` — indicateur de session locale ; la résolution de playlist Spotify utilise de préférence les identifiants API `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`.
- `soundcloud.cookie` — réservé à la configuration fournisseur.
- `deezer.cookie` — réservé à la configuration fournisseur.
- `freezer.cookie` — réservé à la configuration fournisseur.

La file musicale n'a **aucune limite de taille**. Discord n'affiche que 25 titres par page dans le panneau, mais la file complète reste stockée.

Les fichiers sont ignorés par Git. Ne mets jamais de cookie réel dans le dépôt ou dans `.env.example`.

Le bot affiche seulement l'état présent / absent dans le panneau musique ; il n'affiche jamais la valeur d'un cookie.

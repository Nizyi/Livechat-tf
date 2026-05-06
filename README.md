# LiveChat Overlay

Système d'overlay transparent qui affiche en direct les images, vidéos, GIFs et messages texte
postés dans un salon Discord — **sans OBS, sans streaming**, juste une fenêtre toujours au-dessus
de l'écran.

Inspiré du LiveChat de la **Cacabox** (groupe de streameurs Twitch FR).

---

## Architecture

```
Salon Discord
     ↓
Bot Node.js  ─── valide & filtre ───→ WebSocket auth (Sec-WebSocket-Protocol token)
                                              ↓
                                    Electron Overlay (transparent, click-through)
```

Deux projets indépendants qui tournent en parallèle :

| Projet              | Stack                         | Rôle                                                       |
|---------------------|-------------------------------|------------------------------------------------------------|
| `livechat-bot/`     | Node.js, discord.js, ws       | Écoute Discord, valide les médias, broadcaste via WS auth  |
| `electron-overlay/` | Electron, vanilla JS/HTML/CSS | Fenêtre overlay transparente, file d'attente, deux modes   |

---

## Fonctionnalités

- ✅ **Images** (PNG, JPEG, GIF, WEBP) — affichées 9 secondes
- ✅ **Vidéos** (MP4, WEBM, OGG, MOV) — durée réelle, max 15 s, son réglable
- ✅ **GIFs Tenor / Giphy** via le picker Discord ou liens directs
- ✅ **Liens d'images** (CDN Discord, Imgur, etc.) auto-détectés
- ✅ **Texte** seul, max 500 caractères
- ✅ **Deux modes d'affichage** : petit (coin d'écran) ou grand (centré, style TikTok)
- ✅ **File d'attente FIFO** avec badge "+N en attente"
- ✅ **Auto-update** via electron-updater (toast de notification + redémarrage)
- ✅ **Anti-spam** : cooldown 5s par utilisateur, message supprimé + avertissement éphémère
- ✅ **Authentification WS** par token (Sec-WebSocket-Protocol, comparaison `timingSafeEqual`)
- ✅ **Multi-écran** + position configurable (4 coins)
- ✅ **Démarrage automatique** Windows
- ✅ **Logs persistés** dans `%APPDATA%\livechat-overlay\error.log`

---

## Quick start

### 1. Bot Discord

```bash
cd livechat-bot
npm install
cp .env.example .env
# édite .env :
#   TOKEN     = token du bot Discord
#   CHANNEL_ID= ID du salon à surveiller
#   PORT      = 8080 (ou autre)
#   WS_TOKEN  = secret partagé (≥16 chars, génère via crypto.randomBytes)
#   COOLDOWN_MS = 5000 (anti-spam, optionnel)
npm start
```

**Permissions Discord** requises pour le bot dans le salon :
- View Channel
- Read Message History
- Send Messages (pour l'avertissement de cooldown)
- **Manage Messages** (pour supprimer les messages anti-spam)

### 2. Overlay

```bash
cd electron-overlay
npm install
cp .env.example .env
# édite .env :
#   WS_HOST  = host:port du bot (ex: monserveur.com:8080)
#   WS_TOKEN = même valeur que dans livechat-bot/.env
npm start
```

Au lancement, une fenêtre de configuration permet de choisir :
- Écran d'affichage
- Mode (petit / grand)
- Coin (si mode petit)
- Touche skip
- Volume vidéos
- Démarrage automatique avec Windows

### 3. Build distribuable (Windows)

```bash
cd electron-overlay
# Renseigne .env.build avec un GH_TOKEN (fine-grained, scope Contents:write sur ce repo)
$env:GH_TOKEN = (Get-Content .env.build | Where-Object { $_ -match '^GH_TOKEN=(.+)$' } | ForEach-Object { $Matches[1] })
npm version patch -m "release v%s"
npm run release
git push --follow-tags
```

> Nécessite le **Mode Développeur Windows** activé (Paramètres → Système → Pour les développeurs)
> pour permettre la création de symlinks par electron-builder.

L'installer NSIS est uploadé en **release publique** sur GitHub. Les utilisateurs déjà installés
reçoivent automatiquement la mise à jour via electron-updater au prochain lancement.

---

## Releases

Voir [Releases](https://github.com/Nizyi/Livechat-tf/releases) pour télécharger l'installer Windows.

---

## Sécurité

- **Token WS** : secret 16+ chars, comparaison constant-time côté serveur, transmis en
  sous-protocole WebSocket (jamais dans l'URL ni les logs nginx)
- **Whitelist MIME** stricte côté bot ET overlay (double validation)
- **Whitelist CDN** côté overlay : `cdn.discordapp.com`, `media.discordapp.net`,
  `images-ext-{1,2}.discordapp.net`, `media.tenor.com`
- **Limite de taille** : 50 Mo par fichier
- **Cooldown** : 5s par utilisateur, configurable
- **Texte injecté via `.textContent`** (jamais `.innerHTML`) — pas de XSS possible

---

## Variables d'environnement

### `livechat-bot/.env`

| Var           | Requis | Défaut | Rôle                                                    |
|---------------|--------|--------|---------------------------------------------------------|
| `TOKEN`       | oui    | —      | Token bot Discord (developer portal)                    |
| `CHANNEL_ID`  | oui    | —      | ID du salon à surveiller (clic droit → Copier l'ID)     |
| `WS_TOKEN`    | oui    | —      | Secret WS, ≥16 chars                                    |
| `PORT`        | non    | `8080` | Port d'écoute du serveur WebSocket                      |
| `COOLDOWN_MS` | non    | `5000` | Délai minimum entre 2 messages broadcastés par un user  |

### `electron-overlay/.env`

| Var        | Requis | Rôle                                                      |
|------------|--------|-----------------------------------------------------------|
| `WS_HOST`  | oui    | Host:port du bot, ou juste host si reverse proxy sur :80  |
| `WS_TOKEN` | oui    | Même valeur que côté bot                                  |

### `electron-overlay/.env.build` (jamais bundlé dans l'installer)

| Var        | Rôle                                                          |
|------------|---------------------------------------------------------------|
| `GH_TOKEN` | PAT GitHub fine-grained (Contents:write) pour `npm run release` |

---

## Logs et persistance

Les fichiers utilisateur de l'overlay vivent dans :

```
Windows:  %APPDATA%\livechat-overlay\
          ├─ settings.json       # Config sauvée (écran, mode, coin, skip, volume)
          └─ error.log           # Logs INFO + UPDATE + RENDERER + CRASH
```

Accessible via le menu tray → **"Ouvrir le dossier de logs et config"**.

---

## License

MIT

# LiveChat Overlay — Contexte projet

## Vue d'ensemble

Système inspiré du **LiveChat de la Cacabox** (groupe de streameurs Twitch FR).
Permet d'envoyer depuis un salon Discord des images, vidéos et textes qui s'affichent
en overlay transparent sur l'écran, **sans OBS ni streaming**.

## Architecture

```
Salon Discord → Bot Node.js → WebSocket local (port 8080) → Overlay Electron
```

Deux projets indépendants qui tournent en parallèle :

```
livechat-bot/          → Bot Discord (Node.js)
electron-overlay/      → App overlay transparente (Electron)
```

---

## livechat-bot/

### Stack
- **Node.js** + **discord.js v14** + **ws** + **dotenv**

### Fichiers
| Fichier | Rôle |
|---|---|
| `index.js` | Point d'entrée : charge `.env`, vérifie les variables, lance WS puis bot |
| `bot.js` | Écoute le salon Discord, valide les fichiers, broadcaste via WS |
| `wsServer.js` | Crée le serveur WebSocket local, expose `broadcast()` |
| `.env` | `TOKEN`, `CHANNEL_ID`, `PORT=8080` (ne pas commit) |
| `.env.example` | Template à copier |

### Format du payload envoyé via WebSocket
```json
{
  "author":      "NomUtilisateur",
  "avatarUrl":   "https://cdn.discordapp.com/avatars/...",
  "text":        "Texte du message ou null",
  "url":         "https://cdn.discordapp.com/attachments/... ou null",
  "type":        "text | image | video",
  "contentType": "image/png | video/mp4 | ...",
  "timestamp":   1234567890
}
```

### Sécurité (bot.js)
- Liste blanche MIME : `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `video/mp4`, `video/webm`, `video/ogg`, `video/quicktime`
- Rejet fichiers > 50 Mo
- Fallback extension URL si contentType absent
- Texte : suppression caractères de contrôle, max 500 caractères

### Lancer
```bash
cd livechat-bot
npm install
cp .env.example .env   # puis remplir TOKEN et CHANNEL_ID
npm start
```

---

## electron-overlay/

### Stack
- **Electron** (fenêtre transparente, always-on-top, click-through)
- Vanilla JS/HTML/CSS (pas de framework)
- WebSocket natif du navigateur (pas de lib externe)

### Fichiers
| Fichier | Rôle |
|---|---|
| `main.js` | Process principal Electron : fenêtre setup → fenêtre overlay |
| `setup.html` | UI de configuration au lancement (écran + mode) |
| `index.html` | Overlay complet : queue, rendu, deux modes, gestion vidéo |
| `package.json` | Dépendance : electron ^30 |

### Fonctionnement de la fenêtre overlay (main.js)
```javascript
// Fenêtre transparente, click-through, always-on-top
transparent: true, frame: false, focusable: false
win.setIgnoreMouseEvents(true, { forward: true })   // clics passent au travers
win.setAlwaysOnTop(true, 'screen-saver')            // niveau max
```

### Sélection écran + mode (setup.html → main.js)
- `setup.html` liste les écrans via `screen.getAllDisplays()`
- Envoie via `ipcRenderer.send('launch-overlay', { displayIndex, mode })`
- `main.js` écoute avec `ipcMain.on('launch-overlay', ...)` et positionne la fenêtre sur `display.bounds`
- Le mode est passé à `index.html` via query param : `?mode=small` ou `?mode=large`

### Deux modes d'affichage (index.html)
| Mode | Comportement |
|---|---|
| `small` | Carte 400px, coin bas-droit, slide-up |
| `large` | Carte centrée, style TikTok, max 88vh, glassmorphism amplifié |

Sélectionné via `body.classList.add('mode-small')` ou `mode-large`.

### File d'attente (index.html)
- Tableau `queue[]` FIFO
- `enqueue(data)` → ajoute et appelle `processNext()` si rien en cours
- `onDone()` → stoppe le média, masque la carte, attend 400ms, appelle `processNext()`
- Badge "+N en attente" affiché sur la carte

### Gestion des vidéos (index.html)
- `video.loop = false` — pas de boucle
- Durée d'affichage = `video.duration * 1000` ms (via `loadedmetadata`)
- Événement `ended` → appelle `onDone()` immédiatement
- À la fin : `video.pause()` + `removeAttribute('src')` + `video.load()` → coupe le son

### Images
- Durée fixe : `IMG_DISPLAY_MS = 9000` ms
- `object-fit: contain` + `max-height: 55vh` → responsive peu importe le ratio

### Sécurité (index.html)
- URL validée : protocole `https:` + domaine dans `ALLOWED_CDN` (cdn.discordapp.com, media.discordapp.net…)
- MIME validé côté overlay aussi (double vérification)
- Tout le texte utilisateur injecté via `.textContent` (jamais `.innerHTML`)

### Raccourci clavier
- `Ctrl+Shift+Q` (ou `Cmd+Shift+Q`) → ferme l'overlay

### Lancer
```bash
cd electron-overlay
npm install
npm start
# → fenêtre de config s'ouvre, choisir écran + mode, cliquer Lancer
```

---

## Ce qui reste à faire / idées d'amélioration

- [ ] Bouton pour skip manuellement l'élément en cours
- [ ] Réglage de la durée d'affichage des images depuis la config
- [ ] Position configurable de la carte (pas seulement bas-droite)
- [ ] Son optionnel pour les vidéos (toggle mute)
- [ ] Effets d'entrée alternatifs (slide depuis la gauche, etc.)
- [ ] Historique des envois dans un log

---

## Variables d'environnement (.env dans livechat-bot/)

```
TOKEN=token_du_bot_discord
CHANNEL_ID=id_du_salon_a_surveiller
PORT=8080
WS_TOKEN=secret_partage_avec_overlay_min_16_chars
```

`WS_TOKEN` est requis. Le serveur WS rejette toute connexion sans le bon token
(transmis par l'overlay via le sous-protocole `token.<WS_TOKEN>`).
Génère via : `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

L'overlay demande l'adresse du serveur **et** le token au lancement (setup.html).
Aucune valeur n'est pré-remplie : à chaque nouvelle install ou réinit settings,
le user doit saisir host + token avant que `connectWS()` ne tente de se connecter.

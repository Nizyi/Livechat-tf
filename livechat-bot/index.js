// ─── index.js ─────────────────────────────────────────────────────────────────
// Point d'entrée : charge la config, démarre le WS puis le bot Discord.
// Lancer avec : node index.js
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config()

const { startWsServer } = require('./wsServer')
const { startBot }      = require('./bot')

// Vérifications de base
const requiredEnv = ['TOKEN', 'CHANNEL_ID']
const missing = requiredEnv.filter((k) => !process.env[k])
if (missing.length > 0) {
  console.error(`[Config] Variables manquantes dans .env : ${missing.join(', ')}`)
  console.error('[Config] Copie .env.example en .env et remplis les valeurs.')
  process.exit(1)
}

const PORT = parseInt(process.env.PORT || '8080', 10)

// 1. Démarrer le serveur WebSocket
const wss = startWsServer(PORT)

// 2. Démarrer le bot Discord (qui utilisera le wss pour broadcaster)
startBot(wss)

// Gestion propre des arrêts
process.on('SIGINT', () => {
  console.log('\n[System] Arrêt du bot...')
  process.exit(0)
})

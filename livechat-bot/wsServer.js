// ─── wsServer.js ─────────────────────────────────────────────────────────────
// Serveur WebSocket local.
// Reçoit les données du bot et les diffuse à tous les overlays connectés.
// ─────────────────────────────────────────────────────────────────────────────

const WebSocket = require('ws')

/**
 * Démarre le serveur WebSocket sur le port donné.
 * Retourne l'instance du serveur (wss) pour que bot.js puisse broadcaster.
 */
function startWsServer(port) {
  const wss = new WebSocket.Server({ port })

  console.log(`[WS] Serveur démarré sur ws://localhost:${port}`)

  wss.on('connection', (ws, req) => {
    console.log('[WS] Overlay connecté')

    ws.on('close', () => {
      console.log('[WS] Overlay déconnecté')
    })

    ws.on('error', (err) => {
      console.error('[WS] Erreur client :', err.message)
    })
  })

  wss.on('error', (err) => {
    console.error('[WS] Erreur serveur :', err.message)
  })

  return wss
}

/**
 * Envoie un objet JSON à tous les overlays actuellement connectés.
 * @param {WebSocket.Server} wss  - Instance du serveur WS
 * @param {object}           data - Données à envoyer
 */
function broadcast(wss, data) {
  const payload = JSON.stringify(data)
  let count = 0

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload)
      count++
    }
  })

  console.log(`[WS] Broadcast envoyé à ${count} client(s)`)
}

module.exports = { startWsServer, broadcast }

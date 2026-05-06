// ─── wsServer.js ─────────────────────────────────────────────────────────────
// Serveur WebSocket local.
// Reçoit les données du bot et les diffuse à tous les overlays connectés.
// ─────────────────────────────────────────────────────────────────────────────

const WebSocket = require('ws')
const crypto    = require('crypto')

const SUBPROTOCOL_PREFIX = 'token.'

function safeEqual(a, b) {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Démarre le serveur WebSocket sur le port donné.
 * Authentifie chaque connexion via le sous-protocole `token.<WS_TOKEN>`.
 * Retourne l'instance du serveur (wss) pour que bot.js puisse broadcaster.
 */
function startWsServer(port, expectedToken) {
  if (!expectedToken) {
    throw new Error('startWsServer: expectedToken requis')
  }

  const wss = new WebSocket.Server({
    port,
    handleProtocols: (protocols) => {
      const list = Array.isArray(protocols) ? protocols : Array.from(protocols || [])
      for (const proto of list) {
        if (typeof proto !== 'string' || !proto.startsWith(SUBPROTOCOL_PREFIX)) continue
        const candidate = proto.slice(SUBPROTOCOL_PREFIX.length)
        if (safeEqual(candidate, expectedToken)) return proto
      }
      return false
    }
  })

  console.log(`[WS] Serveur démarré sur ws://localhost:${port}`)

  wss.on('headers', (headers, req) => {
    if (!req.headers['sec-websocket-protocol']) {
      console.warn('[WS] Connexion refusée (aucun token fourni)')
    }
  })

  wss.on('connection', (ws, req) => {
    if (!ws.protocol) {
      console.warn('[WS] Connexion refusée (token invalide)')
      try { ws.close(1008, 'unauthorized') } catch {}
      return
    }

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

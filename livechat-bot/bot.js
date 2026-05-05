// ─── bot.js ───────────────────────────────────────────────────────────────────
// Logique principale du bot Discord.
// Surveille un salon, valide les fichiers, et broadcaste via WebSocket.
// ─────────────────────────────────────────────────────────────────────────────

const { Client, GatewayIntentBits } = require('discord.js')
const { broadcast } = require('./wsServer')

// ── Listes blanches ──────────────────────────────────────────────────────────
const ALLOWED_IMAGE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp'
])

const ALLOWED_VIDEO_MIME = new Set([
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/mov'
])

// Extensions de secours si le contentType est absent
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)(\?|$)/i
const VIDEO_EXT = /\.(mp4|webm|ogg|mov)(\?|$)/i

// Taille max des fichiers (50 Mo)
const MAX_FILE_SIZE = 50 * 1024 * 1024

// Longueur max du texte affiché
const MAX_TEXT_LENGTH = 500

// ── Fonctions utilitaires ─────────────────────────────────────────────────────

/**
 * Détermine le type de média d'une pièce jointe.
 * Retourne 'image', 'video' ou null si non autorisé.
 */
function getMediaType(attachment) {
  const ct  = (attachment.contentType || '').toLowerCase().split(';')[0].trim()
  const url = attachment.url.toLowerCase()

  if (ALLOWED_IMAGE_MIME.has(ct))     return 'image'
  if (ALLOWED_VIDEO_MIME.has(ct))     return 'video'
  if (!ct && IMAGE_EXT.test(url))     return 'image'  // fallback extension
  if (!ct && VIDEO_EXT.test(url))     return 'video'

  return null  // type non autorisé (PDF, exe, zip, etc.)
}

/**
 * Vérifie qu'une pièce jointe est dans les limites acceptables.
 * Retourne une chaîne de raison si refusé, null si OK.
 */
function rejectReason(attachment) {
  if (attachment.size > MAX_FILE_SIZE) {
    return `fichier trop lourd (${(attachment.size / 1024 / 1024).toFixed(1)} Mo > 50 Mo)`
  }
  if (!getMediaType(attachment)) {
    return `type MIME non autorisé : "${attachment.contentType || 'inconnu'}"`
  }
  return null
}

/**
 * Nettoie le texte : supprime les caractères de contrôle, tronque.
 */
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return null
  const clean = text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')  // caractères de contrôle
    .trim()
    .substring(0, MAX_TEXT_LENGTH)
  return clean || null
}

// ── Bot ───────────────────────────────────────────────────────────────────────

function startBot(wss) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  })

  client.on('ready', () => {
    console.log(`[Bot] Connecté : ${client.user.tag}`)
    console.log(`[Bot] Surveillance salon : ${process.env.CHANNEL_ID}`)
  })

  client.on('messageCreate', async (message) => {
    // Ignorer les bots
    if (message.author.bot) return

    // Ignorer les autres salons
    if (message.channelId !== process.env.CHANNEL_ID) return

    const rawText    = message.content
    const attachment = message.attachments.first()

    // Ignorer si rien de valide
    if (!rawText && !attachment) return

    // ── Texte ─────────────────────────────────────────────────────────────────
    const text = sanitizeText(rawText)

    // ── Pièce jointe ──────────────────────────────────────────────────────────
    let mediaUrl  = null
    let mediaType = 'text'

    if (attachment) {
      const reason = rejectReason(attachment)

      if (reason) {
        console.warn(`[Sécurité] Fichier rejeté — ${reason} (envoyé par ${message.author.username})`)
        // On continue quand même s'il y a du texte
      } else {
        mediaType = getMediaType(attachment)
        mediaUrl  = attachment.url
      }
    }

    // Si rien à envoyer (fichier rejeté ET pas de texte)
    if (!text && !mediaUrl) return

    // ── Payload ───────────────────────────────────────────────────────────────
    const data = {
      author:      message.author.displayName || message.author.username,
      avatarUrl:   message.author.displayAvatarURL({ size: 128, extension: 'png', forceStatic: false }),
      text,
      url:         mediaUrl,
      type:        mediaUrl ? mediaType : 'text',
      contentType: attachment?.contentType || null,
      timestamp:   Date.now()
    }

    console.log('[Bot] Envoi :', {
      author: data.author,
      type:   data.type,
      text:   data.text ? data.text.substring(0, 60) : null,
      url:    data.url  ? '…' + data.url.slice(-30) : null
    })

    broadcast(wss, data)
  })

  client.on('error', (err) => {
    console.error('[Bot] Erreur :', err.message)
  })

  client.login(process.env.TOKEN).catch((err) => {
    console.error('[Bot] Connexion impossible — vérifie TOKEN dans .env :', err.message)
    process.exit(1)
  })
}

module.exports = { startBot }

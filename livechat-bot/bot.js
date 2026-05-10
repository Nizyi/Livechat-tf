// ─── bot.js ───────────────────────────────────────────────────────────────────
// Logique principale du bot Discord.
// Surveille un salon, valide les fichiers, et broadcaste via WebSocket.
// ─────────────────────────────────────────────────────────────────────────────

const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js')
const path = require('path')
const fs   = require('fs')
const { broadcast } = require('./wsServer')

// ── Listes blanches ──────────────────────────────────────────────────────────
const ALLOWED_IMAGE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp'
])

const ALLOWED_VIDEO_MIME = new Set([
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/mov'
])

const ALLOWED_AUDIO_MIME = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/wave',
  'audio/x-wav', 'audio/webm', 'audio/aac', 'audio/x-m4a', 'audio/mp4'
])

// Extensions de secours si le contentType est absent
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)(\?|$)/i
const VIDEO_EXT = /\.(mp4|webm|mov)(\?|$)/i
const AUDIO_EXT = /\.(mp3|ogg|oga|wav|m4a|aac)(\?|$)/i

// Taille max des fichiers (50 Mo)
const MAX_FILE_SIZE = 50 * 1024 * 1024

// Longueur max du texte affiché
const MAX_TEXT_LENGTH = 500

// ── Anti-spam ────────────────────────────────────────────────────────────────
// Délai minimum entre deux messages broadcastés par un même user (ms)
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || '5000', 10)

// Durée avant suppression automatique du message d'avertissement (ms)
const WARN_TTL_MS = 5000

// Durée avant suppression automatique d'un message Discord broadcasté (ms)
// Mettre 0 pour désactiver. Nécessite la permission "Manage Messages".
const DELETE_AFTER_MS = parseInt(process.env.DELETE_AFTER_MS || '10000', 10)

// Délai d'attente avant traitement quand le message contient une URL — laisse
// à Discord le temps de générer l'embed (Tenor, image directe, etc.)
const EMBED_WAIT_MS = 1500
const URL_REGEX     = /https?:\/\/\S+/i

// Devine le contentType à partir de l'extension de l'URL (fallback)
function guessMimeFromUrl(url) {
  const u = url.toLowerCase().split('?')[0]
  if (u.endsWith('.png'))  return 'image/png'
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg'
  if (u.endsWith('.gif'))  return 'image/gif'
  if (u.endsWith('.webp')) return 'image/webp'
  if (u.endsWith('.mp4'))  return 'video/mp4'
  if (u.endsWith('.webm')) return 'video/webm'
  if (u.endsWith('.mov'))  return 'video/quicktime'
  if (u.endsWith('.mp3'))  return 'audio/mpeg'
  if (u.endsWith('.ogg') || u.endsWith('.oga')) return 'audio/ogg'
  if (u.endsWith('.wav'))  return 'audio/wav'
  if (u.endsWith('.m4a'))  return 'audio/x-m4a'
  if (u.endsWith('.aac'))  return 'audio/aac'
  return null
}

// ── Persistence de la limite de durée (réglée par /limite) ───────────────────
const STATE_PATH      = path.join(__dirname, 'state.json')
const DEFAULT_VIDEO_MAX_SEC = 15
const MIN_VIDEO_MAX_SEC = 1
const MAX_VIDEO_MAX_SEC = 300
let videoMaxMs = DEFAULT_VIDEO_MAX_SEC * 1000

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    if (typeof data.videoMaxMs === 'number' && data.videoMaxMs >= MIN_VIDEO_MAX_SEC * 1000 && data.videoMaxMs <= MAX_VIDEO_MAX_SEC * 1000) {
      videoMaxMs = data.videoMaxMs
    }
  } catch {}
}

function saveState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ videoMaxMs }, null, 2))
  } catch (e) {
    console.error('[State] Sauvegarde impossible :', e.message)
  }
}

loadState()

// userId → timestamp du dernier message accepté
const lastSent = new Map()

// Nettoyage périodique des entrées expirées (évite croissance illimitée)
setInterval(() => {
  const now = Date.now()
  for (const [id, ts] of lastSent) {
    if (now - ts > COOLDOWN_MS * 4) lastSent.delete(id)
  }
}, 60_000).unref()

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
  if (ALLOWED_AUDIO_MIME.has(ct))     return 'audio'
  if (!ct && IMAGE_EXT.test(url))     return 'image'  // fallback extension
  if (!ct && VIDEO_EXT.test(url))     return 'video'
  if (!ct && AUDIO_EXT.test(url))     return 'audio'

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

  const limiteCommand = new SlashCommandBuilder()
    .setName('limite')
    .setDescription("Règle la durée max d'affichage des vidéos (en secondes)")
    .addIntegerOption(opt => opt
      .setName('secondes')
      .setDescription(`Durée en secondes (${MIN_VIDEO_MAX_SEC}–${MAX_VIDEO_MAX_SEC})`)
      .setMinValue(MIN_VIDEO_MAX_SEC)
      .setMaxValue(MAX_VIDEO_MAX_SEC)
      .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
    .toJSON()

  client.on('ready', async () => {
    console.log(`[Bot] Connecté : ${client.user.tag}`)
    console.log(`[Bot] Surveillance salon : ${process.env.CHANNEL_ID}`)
    console.log(`[Bot] Limite vidéo actuelle : ${Math.round(videoMaxMs / 1000)}s`)

    // Enregistrement de la commande /limite sur chaque serveur (propagation immédiate)
    for (const [, guild] of client.guilds.cache) {
      try {
        await guild.commands.create(limiteCommand)
        console.log(`[Bot] /limite enregistrée sur ${guild.name}`)
      } catch (err) {
        console.warn(`[Bot] Échec enregistrement /limite sur ${guild.name} :`, err.message)
      }
    }
  })

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return
    if (interaction.commandName !== 'limite') return

    const seconds = interaction.options.getInteger('secondes', true)
    videoMaxMs = seconds * 1000
    saveState()

    console.log(`[Bot] Limite vidéo réglée à ${seconds}s par ${interaction.user.username}`)
    try {
      await interaction.reply({
        content: `⏱️ Durée max des vidéos réglée sur **${seconds}s**.`,
        flags: MessageFlags.Ephemeral
      })
    } catch (e) {
      console.warn('[Bot] Réponse /limite impossible :', e.message)
    }
  })

  client.on('messageCreate', async (rawMessage) => {
    // Ignorer les bots
    if (rawMessage.author.bot) return

    // Ignorer les autres salons
    if (rawMessage.channelId !== process.env.CHANNEL_ID) return

    // Si le message n'a pas de pièce jointe mais contient une URL, on attend
    // que Discord génère l'embed (Tenor MP4, image directe, etc.) avant de traiter
    let message = rawMessage
    if (rawMessage.attachments.size === 0 && URL_REGEX.test(rawMessage.content || '')) {
      await new Promise(r => setTimeout(r, EMBED_WAIT_MS))
      try {
        message = await rawMessage.channel.messages.fetch(rawMessage.id)
      } catch {
        return  // message supprimé pendant l'attente
      }
    }

    const rawText    = message.content
    const attachment = message.attachments.first()

    // Ignorer si rien de valide
    if (!rawText && !attachment && message.embeds.length === 0) return

    // ── Texte ─────────────────────────────────────────────────────────────────
    let text = sanitizeText(rawText)

    // ── Pièce jointe ──────────────────────────────────────────────────────────
    let mediaUrl     = null
    let mediaType    = 'text'
    let contentType  = null

    if (attachment) {
      const reason = rejectReason(attachment)

      if (reason) {
        console.warn(`[Sécurité] Fichier rejeté — ${reason} (envoyé par ${message.author.username})`)
        // On continue quand même s'il y a du texte
      } else {
        mediaType   = getMediaType(attachment)
        mediaUrl    = attachment.url
        contentType = attachment.contentType || null
      }
    }

    // ── Embed (Discord GIF picker, Tenor/Giphy, image/vidéo via URL) ──────────
    // Discord génère un embed quand le message contient une URL.
    // On lit video > image > thumbnail dans cet ordre de priorité.
    if (!mediaUrl) {
      for (const embed of message.embeds) {
        if (!embed.video && !embed.image && !embed.thumbnail) continue

        if (embed.video?.url) {
          mediaUrl    = embed.video.url
          mediaType   = 'video'
          contentType = guessMimeFromUrl(mediaUrl) || 'video/mp4'
        } else if (embed.image?.url) {
          mediaUrl    = embed.image.url
          mediaType   = 'image'
          contentType = guessMimeFromUrl(mediaUrl) || 'image/png'
        } else if (embed.thumbnail?.url) {
          mediaUrl    = embed.thumbnail.url
          mediaType   = 'image'
          contentType = guessMimeFromUrl(mediaUrl) || 'image/gif'
        }

        if (mediaUrl) {
          // Si le texte est uniquement l'URL d'origine de l'embed, l'effacer
          if (text && embed.url && text.trim() === embed.url.trim()) text = null
          break
        }
      }
    }

    // ── Fallback : URL d'image/vidéo directe dans le texte (sans embed) ──────
    // Couvre les cas où Discord ne génère pas d'embed (CDN Discord par exemple).
    if (!mediaUrl && text) {
      const urlMatch = text.match(URL_REGEX)
      if (urlMatch) {
        const candidate = urlMatch[0]
        const mime = guessMimeFromUrl(candidate)
        if (mime) {
          mediaUrl    = candidate
          mediaType   = mime.startsWith('video/') ? 'video' : 'image'
          contentType = mime
          // Si le texte EST cette URL seule, on l'efface
          if (text.trim() === candidate) text = null
        }
      }
    }

    // Si rien à envoyer (fichier rejeté ET pas de texte ET pas d'embed GIF)
    if (!text && !mediaUrl) return

    // ── Cooldown anti-spam ────────────────────────────────────────────────────
    const now      = Date.now()
    const last     = lastSent.get(message.author.id) || 0
    const elapsed  = now - last
    if (elapsed < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000)
      console.log(`[Cooldown] ${message.author.username} bloqué (${remaining}s restantes)`)
      try {
        await message.delete()
      } catch (e) {
        console.warn('[Cooldown] Suppression impossible (permission Manage Messages requise) :', e.message)
      }
      try {
        const warn = await message.channel.send({
          content: `<@${message.author.id}> ⏱️ patiente **${remaining}s** avant de renvoyer un message.`,
          allowedMentions: { users: [message.author.id] }
        })
        setTimeout(() => warn.delete().catch(() => {}), WARN_TTL_MS)
      } catch (e) {
        console.warn('[Cooldown] Avertissement impossible :', e.message)
      }
      return
    }
    lastSent.set(message.author.id, now)

    // ── Payload ───────────────────────────────────────────────────────────────
    const data = {
      author:      message.author.displayName || message.author.username,
      avatarUrl:   message.author.displayAvatarURL({ size: 128, extension: 'png', forceStatic: false }),
      text,
      url:         mediaUrl,
      type:        mediaUrl ? mediaType : 'text',
      contentType,
      isGif:       mediaType === 'video' && message.embeds.some(e => e.video),
      videoMaxMs,  // limite courante (réglée par /limite)
      timestamp:   Date.now()
    }

    console.log('[Bot] Envoi :', {
      author: data.author,
      type:   data.type,
      text:   data.text ? data.text.substring(0, 60) : null,
      url:    data.url  ? '…' + data.url.slice(-30) : null
    })

    broadcast(wss, data)

    // ── Suppression auto du message Discord ───────────────────────────────────
    if (DELETE_AFTER_MS > 0) {
      setTimeout(() => {
        message.delete().catch((e) => {
          console.warn('[AutoDelete] Suppression impossible (permission Manage Messages requise) :', e.message)
        })
      }, DELETE_AFTER_MS)
    }
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

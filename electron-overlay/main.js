// ─── main.js ──────────────────────────────────────────────────────────────────
// Ouvre d'abord une fenêtre de configuration (écran + mode),
// puis lance l'overlay transparent sur l'écran choisi.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, screen, shell, globalShortcut, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs   = require('fs')
const { autoUpdater } = require('electron-updater')

// Configuration WS bakée au build via .env (gitignored mais inclus dans le bundle).
// Voir .env.example pour le template.
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') })
} catch (e) {
  console.error('[BUILD] dotenv non chargé :', e.message)
}
const BUILD_CONFIG = {
  wsHost:  process.env.WS_HOST  || '',
  wsToken: process.env.WS_TOKEN || ''
}

// Single instance lock — un second lancement focus la fenêtre existante au lieu d'ouvrir un doublon
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Quelqu'un a relancé l'app → ramener au premier plan ce qui existe déjà
    if (setupWin) {
      if (setupWin.isMinimized()) setupWin.restore()
      setupWin.show()
      setupWin.focus()
    } else {
      createSetupWindow()
    }
  })
}

let setupWin        = null
let overlayWin      = null
let updateWin       = null
let tray            = null
let registeredSkipKey = null
let pendingUpdate   = null   // { version } quand un update est téléchargé et prêt
let dndUntil        = 0      // timestamp ms ; 0 = inactif
let dndTimer        = null

// ── Persistence des paramètres ────────────────────────────────────────────────
// Initialisé dans app.whenReady() — app.getPath() indisponible avant
let SETTINGS_PATH = null
const DEFAULT_SETTINGS = {
  displayIndex: 0,
  mode:         'small',
  corner:       'bottom-right',
  skipKey:      'PageDown',
  volume:       50,
  // true = filtre actif (bloque Porn/Hentai), false = tout passe (défaut)
  // true déclenche le chargement lazy de nsfwjs côté overlay
  nsfwFilter:   false
}

let LOG_PATH = null

function writeLog(level, msg) {
  if (!LOG_PATH) return
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`
  try { fs.appendFileSync(LOG_PATH, line) } catch {}
}

function logUpdate(msg) {
  console.log('[updater]', msg)
  writeLog('UPDATE', msg)
}

function setupAutoUpdater() {
  autoUpdater.autoDownload          = true
  autoUpdater.autoInstallOnAppQuit  = true
  autoUpdater.logger = {
    info:  m => logUpdate(typeof m === 'string' ? m : JSON.stringify(m)),
    warn:  m => logUpdate('WARN ' + (typeof m === 'string' ? m : JSON.stringify(m))),
    error: m => logUpdate('ERROR ' + (m && m.stack ? m.stack : String(m))),
    debug: () => {}
  }

  autoUpdater.on('checking-for-update', () => {
    logUpdate(`Vérification mises à jour (version actuelle ${app.getVersion()})…`)
  })
  autoUpdater.on('update-available', info => {
    logUpdate(`Update DISPONIBLE → ${info.version} (release ${info.releaseDate || '?'}) — téléchargement…`)
  })
  autoUpdater.on('update-not-available', info => {
    logUpdate(`Aucune update — déjà sur ${info.version || app.getVersion()}`)
  })
  autoUpdater.on('download-progress', p => {
    const pct  = p.percent ? p.percent.toFixed(1) : '?'
    const mbps = p.bytesPerSecond ? (p.bytesPerSecond / 1024 / 1024).toFixed(2) : '?'
    logUpdate(`DL ${pct}% (${mbps} MB/s) — ${p.transferred}/${p.total}`)
  })
  autoUpdater.on('update-downloaded', info => {
    logUpdate(`Update TÉLÉCHARGÉE → ${info.version} — sera installée à la fermeture`)
    pendingUpdate = { version: info.version }
    showUpdateNotification()
    refreshTrayMenu()
  })
  autoUpdater.on('error', err => {
    logUpdate('ERREUR ' + (err && err.stack ? err.stack : String(err)))
  })
}

let settings = { ...DEFAULT_SETTINGS }

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    // Migration v1.3.0 → v1.3.1 : allowAdult (true=passe) → nsfwFilter (true=bloque)
    if (data.allowAdult !== undefined && data.nsfwFilter === undefined) {
      data.nsfwFilter = !data.allowAdult
      delete data.allowAdult
    }
    settings = { ...DEFAULT_SETTINGS, ...data }
    writeLog('INFO', `Settings chargés : ${JSON.stringify(settings)}`)
  } catch (e) {
    settings = { ...DEFAULT_SETTINGS }
    writeLog('INFO', `Settings : aucun fichier existant (${e.code || e.message}), utilisation des valeurs par défaut`)
  }
}

function saveSettings(patch) {
  Object.assign(settings, patch)
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2))
    writeLog('INFO', `Settings sauvés → ${SETTINGS_PATH}`)
  } catch (e) {
    console.error('Erreur sauvegarde settings:', e)
  }
}

// ── Raccourci skip (local uniquement) ─────────────────────────────────────────
function registerSkipShortcut(key) {
  if (registeredSkipKey) {
    try { globalShortcut.unregister(registeredSkipKey) } catch {}
    registeredSkipKey = null
  }
  if (!key) return
  try {
    const ok = globalShortcut.register(key, () => {
      // N'agit que si l'overlay tourne et que le setup est fermé
      if (overlayWin && !setupWin) overlayWin.webContents.send('skip')
    })
    if (ok) registeredSkipKey = key
    else console.warn('Raccourci skip déjà utilisé:', key)
  } catch (e) {
    console.error('Raccourci skip invalide:', key, e)
  }
}

// ── Fenêtre de configuration ──────────────────────────────────────────────────
function createSetupWindow() {
  if (setupWin) { setupWin.focus(); return }

  setupWin = new BrowserWindow({
    width:     460,
    height:    700,   // taille fixe avec onglets — contenu ne dépasse jamais
    resizable: false,
    frame:     true,
    center:    true,
    title:     'LiveChat Overlay — Configuration',
    webPreferences: {
      nodeIntegration:  true,
      contextIsolation: false
    }
  })

  setupWin.setMenuBarVisibility(false)
  setupWin.loadFile(path.join(__dirname, 'setup.html'))

  setupWin.webContents.on('did-finish-load', () => {
    const displays      = screen.getAllDisplays()
    const primaryId     = screen.getPrimaryDisplay().id
    const autostartOn   = app.getLoginItemSettings().openAtLogin
    setupWin.webContents.send('init', {
      displays, primaryId, settings,
      autostart: autostartOn,
      version:   app.getVersion()
    })
  })

  setupWin.on('closed', () => { setupWin = null })
}

// ── Fenêtre overlay ───────────────────────────────────────────────────────────
function createOverlay(displayIndex, mode, corner = 'bottom-right', volume = 100) {
  const wsHost     = BUILD_CONFIG.wsHost
  const wsToken    = BUILD_CONFIG.wsToken
  const nsfwFilter = settings.nsfwFilter ? '1' : '0'
  const displays = screen.getAllDisplays()
  const display  = displays[displayIndex] || displays[0]
  const { x, y, width, height } = display.bounds

  overlayWin = new BrowserWindow({
    x, y, width, height,
    transparent:     true,
    frame:           false,
    backgroundColor: '#00000000',
    alwaysOnTop:     true,
    skipTaskbar:     true,
    focusable:       false,
    resizable:       false,
    movable:         false,
    webPreferences: {
      nodeIntegration:  true,
      contextIsolation: false
    }
  })

  overlayWin.setIgnoreMouseEvents(true, { forward: true })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')

  overlayWin.loadFile(path.join(__dirname, 'index.html'), { query: { mode, corner, volume, wsHost, wsToken, nsfwFilter } })
  overlayWin.on('closed', () => { overlayWin = null })
  overlayWin.webContents.on('did-finish-load', () => broadcastDnd())
  attachRendererLogger(overlayWin)
}

// ── IPC : la fenêtre setup envoie les choix ──────────────────────────────────
ipcMain.on('launch-overlay', (event, { displayIndex, mode, corner, skipKey, volume, nsfwFilter }) => {
  saveSettings({ displayIndex, mode, corner, skipKey, volume, nsfwFilter })
  registerSkipShortcut(skipKey)

  // destroy() synchrone — évite que le callback 'closed' écrase la nouvelle ref
  if (overlayWin) {
    overlayWin.removeAllListeners('closed')
    overlayWin.destroy()
    overlayWin = null
  }
  createOverlay(displayIndex, mode, corner, volume)
  if (setupWin) setupWin.close()
})

// ── IPC : lancement avec Windows ─────────────────────────────────────────────
ipcMain.on('set-autostart', (event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled })
})

// ── Capture des erreurs renderer ──────────────────────────────────────────────
function attachRendererLogger(win) {
  win.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) writeLog('RENDERER', message)
  })
  win.webContents.on('render-process-gone', (event, details) => {
    writeLog('CRASH', `Renderer gone: ${details.reason}`)
    // Relance l'overlay si c'était lui
    if (win === overlayWin) {
      overlayWin = null
      setTimeout(() => {
        const s = settings
        createOverlay(s.displayIndex, s.mode, s.corner, s.volume)
        // Renvoyer l'état DND au cas où il était actif avant le crash
        broadcastDnd()
      }, 2000)
    }
  })
}

// ── Ne pas déranger ───────────────────────────────────────────────────────────
function setDnd(durationMs) {
  dndUntil = Date.now() + durationMs
  if (dndTimer) clearTimeout(dndTimer)
  dndTimer = setTimeout(() => clearDnd(), durationMs)
  broadcastDnd()
  refreshTrayMenu()
  if (tray) {
    const end = new Date(dndUntil).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    tray.setToolTip(`LiveChat Overlay — Silencieux jusqu'à ${end}`)
  }
  writeLog('INFO', `DND activé pour ${Math.round(durationMs/60000)}min (jusqu'à ${new Date(dndUntil).toISOString()})`)
}

function clearDnd() {
  dndUntil = 0
  if (dndTimer) { clearTimeout(dndTimer); dndTimer = null }
  broadcastDnd()
  refreshTrayMenu()
  if (tray) tray.setToolTip('LiveChat Overlay')
  writeLog('INFO', 'DND désactivé')
}

function broadcastDnd() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('dnd-update', { until: dndUntil })
  }
}

// ── Icône zone de notification (system tray) ──────────────────────────────────
function dndActive() { return dndUntil > Date.now() }

function dndRemainingLabel() {
  const ms  = dndUntil - Date.now()
  const min = Math.ceil(ms / 60000)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

function buildTrayMenu() {
  const items = []
  if (pendingUpdate) {
    items.push({
      label: `Redémarrer pour installer la v${pendingUpdate.version}`,
      click: () => installPendingUpdate()
    })
    items.push({ type: 'separator' })
  }

  if (dndActive()) {
    items.push({
      label: `🌙 Silencieux — ${dndRemainingLabel()} restantes`,
      enabled: false
    })
  }
  items.push({
    label: 'Ne pas déranger',
    submenu: [
      { label: '5 minutes',  click: () => setDnd(5  * 60 * 1000) },
      { label: '30 minutes', click: () => setDnd(30 * 60 * 1000) },
      { label: '1 heure',    click: () => setDnd(1  * 60 * 60 * 1000) },
      { label: '3 heures',   click: () => setDnd(3  * 60 * 60 * 1000) },
      { label: '8 heures',   click: () => setDnd(8  * 60 * 60 * 1000) },
      { type: 'separator' },
      { label: 'Désactiver', enabled: dndActive(), click: () => clearDnd() }
    ]
  })
  items.push({ type: 'separator' })
  items.push({ label: 'Paramètres', click: () => createSetupWindow() })
  items.push({
    label: 'Ouvrir le dossier de logs et config',
    click: () => shell.openPath(app.getPath('userData'))
  })
  items.push({ type: 'separator' })
  items.push({ label: 'Redémarrer', click: () => relaunchApp() })
  items.push({ label: 'Quitter',    click: () => app.quit() })
  return Menu.buildFromTemplate(items)
}

function relaunchApp() {
  writeLog('INFO', 'Redémarrage demandé via menu tray')
  // Ferme proprement les fenêtres pour libérer le single-instance lock
  if (overlayWin) { try { overlayWin.removeAllListeners('closed'); overlayWin.destroy() } catch {} }
  if (setupWin)   { try { setupWin.destroy()   } catch {} }
  if (updateWin)  { try { updateWin.destroy()  } catch {} }
  app.relaunch()
  app.quit()
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu())
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'logo.jpg'))
  tray = new Tray(icon)
  tray.setToolTip('LiveChat Overlay')
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', () => createSetupWindow())
}

// ── Notification de mise à jour (toast type Discord) ──────────────────────────
function showUpdateNotification() {
  if (updateWin) { updateWin.focus(); return }

  const TOAST_W = 360
  const TOAST_H = 170

  // Position dans le coin bas-droit de l'écran de l'overlay (ou primaire)
  const displays = screen.getAllDisplays()
  const display  = displays[settings.displayIndex] || screen.getPrimaryDisplay()
  const { x, y, width, height } = display.workArea
  const winX = x + width  - TOAST_W - 16
  const winY = y + height - TOAST_H - 16

  updateWin = new BrowserWindow({
    x: winX, y: winY,
    width:  TOAST_W,
    height: TOAST_H,
    transparent:     true,
    frame:           false,
    backgroundColor: '#00000000',
    alwaysOnTop:     true,
    skipTaskbar:     true,
    resizable:       false,
    movable:         false,
    focusable:       true,
    webPreferences: {
      nodeIntegration:  true,
      contextIsolation: false
    }
  })

  updateWin.setAlwaysOnTop(true, 'screen-saver')
  updateWin.loadFile(path.join(__dirname, 'update.html'))

  updateWin.webContents.on('did-finish-load', () => {
    updateWin.webContents.send('update-info', pendingUpdate)
  })

  updateWin.on('closed', () => { updateWin = null })
}

function installPendingUpdate() {
  if (!pendingUpdate) return
  logUpdate('Redémarrage demandé par l\'utilisateur — quitAndInstall()')
  // Force la fermeture propre des autres fenêtres avant install
  if (overlayWin) { try { overlayWin.removeAllListeners('closed'); overlayWin.destroy() } catch {} }
  if (setupWin)   { try { setupWin.destroy()   } catch {} }
  if (updateWin)  { try { updateWin.destroy()  } catch {} }
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}

ipcMain.on('update-restart', () => installPendingUpdate())
ipcMain.on('update-dismiss', () => {
  if (updateWin) { try { updateWin.close() } catch {} }
})

// ── Cycle de vie ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json')
  LOG_PATH      = path.join(app.getPath('userData'), 'error.log')
  process.on('uncaughtException',    err    => writeLog('CRASH',   err.stack || String(err)))
  process.on('unhandledRejection',   reason => writeLog('CRASH',   'UnhandledRejection: ' + reason))

  writeLog('BOOT', `LiveChat Overlay v${app.getVersion()} démarrage — userData=${app.getPath('userData')}`)
  writeLog('BOOT', `WS_HOST=${BUILD_CONFIG.wsHost || '(VIDE — vérifier .env au build)'} | WS_TOKEN=${BUILD_CONFIG.wsToken ? '(défini, ' + BUILD_CONFIG.wsToken.length + ' chars)' : '(VIDE — vérifier .env au build)'}`)

  setupAutoUpdater()
  autoUpdater.checkForUpdatesAndNotify().catch(err => logUpdate('checkForUpdates rejected: ' + err))
  loadSettings()
  createSetupWindow()
  createTray()

  // Mode test : déclenche un faux update-downloaded pour vérifier le toast (npm start -- --test-update)
  if (process.argv.includes('--test-update')) {
    setTimeout(() => {
      pendingUpdate = { version: '9.9.9-test' }
      showUpdateNotification()
      refreshTrayMenu()
      logUpdate('[TEST] Toast factice déclenché')
    }, 1500)
  }

  globalShortcut.register('CommandOrControl+Shift+Q', () => { app.quit() })
  globalShortcut.register('CommandOrControl+Shift+P', () => { createSetupWindow() })
})

// Tray maintient l'app vivante — on ne quitte que via menu tray ou raccourci
app.on('window-all-closed', () => {})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (tray) tray.destroy()
})

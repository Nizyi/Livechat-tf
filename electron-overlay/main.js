// ─── main.js ──────────────────────────────────────────────────────────────────
// Ouvre d'abord une fenêtre de configuration (écran + mode),
// puis lance l'overlay transparent sur l'écran choisi.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, screen, globalShortcut, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs   = require('fs')
const { autoUpdater } = require('electron-updater')

let setupWin        = null
let overlayWin      = null
let tray            = null
let registeredSkipKey = null

// ── Persistence des paramètres ────────────────────────────────────────────────
// Initialisé dans app.whenReady() — app.getPath() indisponible avant
let SETTINGS_PATH = null
const DEFAULT_SETTINGS = {
  displayIndex: 0,
  mode:         'small',
  corner:       'bottom-right',
  skipKey:      'PageDown',
  volume:       50,
  wsHost:       '',
  wsToken:      ''
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
  })
  autoUpdater.on('error', err => {
    logUpdate('ERREUR ' + (err && err.stack ? err.stack : String(err)))
  })
}

let settings = { ...DEFAULT_SETTINGS }

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    settings = { ...DEFAULT_SETTINGS, ...data }
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(patch) {
  Object.assign(settings, patch)
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2))
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
    height:    860,   // mode petit par défaut (coin + skip + volume + serveur + autostart)
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
    setupWin.webContents.send('init', { displays, primaryId, settings, autostart: autostartOn })
  })

  setupWin.on('closed', () => { setupWin = null })
}

// ── Fenêtre overlay ───────────────────────────────────────────────────────────
function createOverlay(displayIndex, mode, corner = 'bottom-right', volume = 100, wsHost = '', wsToken = '') {
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

  overlayWin.loadFile(path.join(__dirname, 'index.html'), { query: { mode, corner, volume, wsHost, wsToken } })
  overlayWin.on('closed', () => { overlayWin = null })
  attachRendererLogger(overlayWin)
}

// ── IPC : la fenêtre setup envoie les choix ──────────────────────────────────
ipcMain.on('launch-overlay', (event, { displayIndex, mode, corner, skipKey, volume, wsHost, wsToken }) => {
  saveSettings({ displayIndex, mode, corner, skipKey, volume, wsHost, wsToken })
  registerSkipShortcut(skipKey)

  // destroy() synchrone — évite que le callback 'closed' écrase la nouvelle ref
  if (overlayWin) {
    overlayWin.removeAllListeners('closed')
    overlayWin.destroy()
    overlayWin = null
  }
  createOverlay(displayIndex, mode, corner, volume, wsHost, wsToken)
  if (setupWin) setupWin.close()
})

// ── IPC : redimensionne la fenêtre setup selon le mode choisi ─────────────────
ipcMain.on('resize-setup', (event, height) => {
  if (setupWin) setupWin.setSize(460, height)
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
        createOverlay(s.displayIndex, s.mode, s.corner, s.volume, s.wsHost, s.wsToken)
      }, 2000)
    }
  })
}

// ── Icône zone de notification (system tray) ──────────────────────────────────
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'logo.jpg'))
  tray = new Tray(icon)
  tray.setToolTip('LiveChat Overlay')

  const menu = Menu.buildFromTemplate([
    { label: 'Paramètres', click: () => createSetupWindow() },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() }
  ])

  tray.setContextMenu(menu)
  tray.on('double-click', () => createSetupWindow())
}

// ── Cycle de vie ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json')
  LOG_PATH      = path.join(app.getPath('userData'), 'error.log')
  process.on('uncaughtException',    err    => writeLog('CRASH',   err.stack || String(err)))
  process.on('unhandledRejection',   reason => writeLog('CRASH',   'UnhandledRejection: ' + reason))

  setupAutoUpdater()
  autoUpdater.checkForUpdatesAndNotify().catch(err => logUpdate('checkForUpdates rejected: ' + err))
  loadSettings()
  createSetupWindow()
  createTray()

  globalShortcut.register('CommandOrControl+Shift+Q', () => { app.quit() })
  globalShortcut.register('CommandOrControl+Shift+P', () => { createSetupWindow() })
})

// Tray maintient l'app vivante — on ne quitte que via menu tray ou raccourci
app.on('window-all-closed', () => {})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (tray) tray.destroy()
})

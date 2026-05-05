// ─── main.js ──────────────────────────────────────────────────────────────────
// Ouvre d'abord une fenêtre de configuration (écran + mode),
// puis lance l'overlay transparent sur l'écran choisi.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, screen, globalShortcut, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs   = require('fs')

let setupWin        = null
let overlayWin      = null
let tray            = null
let registeredSkipKey = null

// ── Persistence des paramètres ────────────────────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, 'settings.json')
const DEFAULT_SETTINGS = {
  displayIndex: 0,
  mode:         'small',
  corner:       'bottom-right',
  skipKey:      'PageDown',
  volume:       100
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
    height:    700,   // mode petit par défaut (coin + skip + volume)
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
    const displays  = screen.getAllDisplays()
    const primaryId = screen.getPrimaryDisplay().id
    // Envoi unique avec displays + paramètres sauvegardés
    setupWin.webContents.send('init', { displays, primaryId, settings })
  })

  setupWin.on('closed', () => { setupWin = null })
}

// ── Fenêtre overlay ───────────────────────────────────────────────────────────
function createOverlay(displayIndex, mode, corner = 'bottom-right', volume = 100) {
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

  overlayWin.loadFile(path.join(__dirname, 'index.html'), { query: { mode, corner, volume } })
  overlayWin.on('closed', () => { overlayWin = null })
}

// ── IPC : la fenêtre setup envoie les choix ──────────────────────────────────
ipcMain.on('launch-overlay', (event, { displayIndex, mode, corner, skipKey, volume }) => {
  saveSettings({ displayIndex, mode, corner, skipKey, volume })
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

// ── IPC : redimensionne la fenêtre setup selon le mode choisi ─────────────────
ipcMain.on('resize-setup', (event, height) => {
  if (setupWin) setupWin.setSize(460, height)
})

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

const {
  app, BrowserWindow, Tray, Menu, Notification, globalShortcut, nativeImage, nativeTheme, ipcMain, shell, screen,
  desktopCapturer, dialog, systemPreferences,
} = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const qrcode = require('qrcode-generator');
const clip = require('./clip');

const ROOT = __dirname;
const DEMO = process.argv.includes('--demo'); // records docs/demo.gif, see demo.js
const SELFTEST = DEMO || process.argv.includes('--selftest');
if (DEMO) app.disableHardwareAcceleration(); // capturePage gave UnknownVizError on the GPU path; software records reliably
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const APP_ID = 'io.github.artsocity23ux.artnote';
// An installed build keeps settings and the log in the per-user app data folder, a source checkout beside the code.
const DATA = app.isPackaged ? app.getPath('userData') : ROOT;
const LOG = path.join(DATA, 'artnote.log');
const CONFIG = path.join(DATA, 'config.json');
const GRAB = app.isPackaged ? path.join(process.resourcesPath, 'grab.exe') : path.join(ROOT, 'grab.exe');
const LINUX_AUTOSTART = path.join(os.homedir(), '.config', 'autostart', 'artnote.desktop');

const config = {
  hotkey: 'Super+Alt+A',
  fallbackHotkey: IS_MAC ? '' : 'Shift+PrintScreen',
  notesDir: path.join(app.getPath('documents'), 'ART_NOTES'),
  ...readJSON(CONFIG),
};
let notesDir = config.notesDir;

// Donation options live in donate.json; entries left empty are not shown. The self-test may pass its own file.
const donateArg = SELFTEST ? process.argv.indexOf('--donate') : -1;
const donate = readJSON(donateArg > 0 ? process.argv[donateArg + 1] : path.join(ROOT, 'donate.json'));
const donateCrypto = (donate.crypto || []).filter(c => c.address);
const donateLinks = (donate.links || []).filter(l => /^https:\/\//.test(l.url || ''));

let tray = null;
let hotkeyLabel = '';
let picking = false; // region picker is up (or about to be)
let pickStart = 0;
const overlays = new Map(); // display.id -> full-screen window used to pick a region, kept warm
const shots = new Map(); // display.id -> frozen capture of that display while picking
const images = new Map(); // webContents.id -> nativeImage of the picked region

function log(...parts) {
  if (SELFTEST) return;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 256 * 1024) fs.renameSync(LOG, `${LOG}.old`);
    fs.appendFileSync(LOG, `${new Date().toLocaleString('sv')} ${parts.join(' ')}\n`);
  } catch {
    // logging is best effort
  }
}

process.on('uncaughtException', err => log('ERROR', err.stack || err));
process.on('unhandledRejection', err => log('ERROR', err?.stack || err));

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ ...readJSON(CONFIG), ...patch }, null, 2));
}

// ---------- screen grab ----------

// grab.exe stays running and answers every newline on stdin with one raw BGRA capture of the virtual screen.
const grabber = { proc: null, chunks: [], got: 0, head: null, waiter: null };

function startGrabber() {
  const proc = spawn(GRAB, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  Object.assign(grabber, { proc, chunks: [], got: 0, head: null });
  const fail = err => {
    if (grabber.proc === proc) grabber.proc = null;
    grabber.waiter?.reject(err);
    grabber.waiter = null;
  };
  proc.on('error', fail);
  proc.on('exit', code => fail(new Error(`grab.exe exited (${code})`)));
  proc.stdin.on('error', () => {}); // EPIPE when it died; 'exit' reports it
  proc.stdout.on('data', chunk => {
    grabber.chunks.push(chunk);
    grabber.got += chunk.length;
    if (!grabber.head && grabber.got >= 16) {
      const head = Buffer.concat(grabber.chunks).subarray(0, 16);
      grabber.head = [0, 4, 8, 12].map(o => head.readInt32LE(o));
    }
    if (!grabber.head) return;
    const [x, y, width, height] = grabber.head;
    const end = 16 + width * height * 4;
    if (grabber.got < end) return;
    const all = Buffer.concat(grabber.chunks, grabber.got);
    Object.assign(grabber, { chunks: [], got: 0, head: null });
    const image = nativeImage.createFromBitmap(all.subarray(16, end), { width, height });
    grabber.waiter?.resolve({ x, y, image });
    grabber.waiter = null;
  });
}

function grabVirtualScreen() {
  return new Promise((resolve, reject) => {
    if (!grabber.proc) startGrabber();
    grabber.waiter = { resolve, reject };
    grabber.proc.stdin.write('\n');
    setTimeout(() => {
      if (grabber.waiter?.resolve !== resolve) return;
      grabber.waiter = null;
      reject(new Error('grab.exe did not answer in 3s'));
    }, 3000);
  });
}

// Returns display.id -> nativeImage in physical pixels. grab.exe on Windows, desktopCapturer elsewhere.
async function captureDisplays(displays) {
  const out = new Map();
  if (IS_WIN && fs.existsSync(GRAB)) {
    try {
      const { x, y, image } = await grabVirtualScreen();
      for (const d of displays) {
        const r = screen.dipToScreenRect(null, d.bounds);
        out.set(d.id, image.crop({ x: r.x - x, y: r.y - y, width: r.width, height: r.height }));
      }
      return out;
    } catch (err) {
      log('grab.exe failed, using desktopCapturer:', err.message);
    }
  }
  const physical = d => ({ width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) });
  const thumbnailSize = displays.map(physical).reduce((a, b) => ({
    width: Math.max(a.width, b.width),
    height: Math.max(a.height, b.height),
  }));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  for (const d of displays) {
    const src = sources.find(s => s.display_id === String(d.id)) || (displays.length === 1 ? sources[0] : null);
    if (src && !src.thumbnail.isEmpty()) out.set(d.id, src.thumbnail.resize(physical(d)));
  }
  return out;
}

// ---------- region picker ----------

async function overlayFor(display) {
  let win = overlays.get(display.id);
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      backgroundColor: '#000000',
      webPreferences: { preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlays.set(display.id, win);
    await win.loadFile(path.join(ROOT, 'overlay.html'));
  } else if (win.webContents.isLoading()) {
    await new Promise(r => win.webContents.once('did-finish-load', r));
  }
  win.setBounds(display.bounds);
  return win;
}

function prepareOverlays() {
  const displays = screen.getAllDisplays();
  for (const [id, win] of overlays) {
    if (displays.some(d => d.id === id)) continue;
    win.destroy();
    overlays.delete(id);
  }
  for (const d of displays) overlayFor(d);
}

// Freezes every screen, then shows the picker on top; the editor opens with the region the user drags.
async function startCapture() {
  if (picking) return endPicking(); // the hotkey again cancels
  // macOS asks for Screen Recording on the first capture; once refused, captures only show the wallpaper.
  if (IS_MAC && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
    notify('Дозволь ArtNote запис екрана в System Settings → Privacy & Security, потім перезапусти ArtNote');
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return;
  }
  picking = true;
  pickStart = Date.now();
  const displays = screen.getAllDisplays();
  let captured = new Map();
  try {
    captured = await captureDisplays(displays);
  } catch (err) {
    log('capture failed:', err.stack || err);
  }
  if (!picking) return;
  if (!captured.size) {
    picking = false;
    notify('Не вдалося захопити екран');
    return;
  }
  log(`capture: ${captured.size} screen(s) grabbed in ${Date.now() - pickStart}ms`);
  for (const d of displays) {
    if (!captured.has(d.id)) continue;
    shots.set(d.id, captured.get(d.id));
    const win = await overlayFor(d);
    if (picking) win.webContents.send('artnote:shot', captured.get(d.id).toJPEG(90));
  }
}

function endPicking() {
  picking = false;
  shots.clear();
  for (const win of overlays.values()) if (!win.isDestroyed()) win.hide();
}

const displayOf = sender => [...overlays].find(([, win]) => !win.isDestroyed() && win.webContents === sender)?.[0];

ipcMain.on('artnote:shot-ready', e => {
  const id = displayOf(e.sender);
  if (!picking || !shots.has(id)) return;
  const win = overlays.get(id);
  if (IS_MAC) app.focus({ steal: true }); // a tray-only app is never frontmost on its own
  win.show();
  if (id === screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id) win.focus();
  log(`capture: picker shown after ${Date.now() - pickStart}ms`);
});

ipcMain.on('artnote:select', (e, rect) => {
  const id = displayOf(e.sender);
  const shot = shots.get(id);
  const display = screen.getAllDisplays().find(d => d.id === id);
  endPicking();
  if (!shot || !display) return;
  const { width: W, height: H } = shot.getSize();
  const k = W / display.bounds.width;
  const x = Math.min(W - 1, Math.max(0, Math.round(rect.x * k)));
  const y = Math.min(H - 1, Math.max(0, Math.round(rect.y * k)));
  const crop = shot.crop({
    x,
    y,
    width: Math.min(W - x, Math.max(1, Math.round(rect.width * k))),
    height: Math.min(H - y, Math.max(1, Math.round(rect.height * k))),
  });
  log(`capture: picked ${crop.getSize().width}x${crop.getSize().height}`);
  openEditor(crop);
  // The bare region goes to the clipboard right away; the editor replaces it with the markup as you draw.
  setImmediate(() => clip.writeImage(crop.toPNG()).catch(err => log('clipboard write failed:', err.message)));
});

ipcMain.on('artnote:cancel', () => {
  log('capture: cancelled');
  endPicking();
});

async function openFromClipboard() {
  const img = await clip.readImage();
  if (!img) {
    notify('У буфері обміну немає картинки');
    return null;
  }
  return openEditor(img);
}

// ---------- editor window ----------

function openEditor(img) {
  const size = img.getSize();
  const { workArea, scaleFactor } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const ui = { w: 320, h: 120 }; // side panel + toolbar + status bar + margins, in DIP
  const imgW = size.width / scaleFactor;
  const imgH = size.height / scaleFactor;
  const fit = Math.min(1, (workArea.width * 0.92 - ui.w) / imgW, (workArea.height * 0.92 - ui.h) / imgH);
  const width = Math.min(workArea.width, Math.max(980, Math.round(imgW * fit + ui.w)));
  const height = Math.min(workArea.height, Math.max(620, Math.round(imgH * fit + ui.h)));

  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    show: false,
    title: 'ArtNote',
    icon: path.join(ROOT, 'icon.png'),
    backgroundColor: '#15171c',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(ROOT, 'preload.js') },
  });
  const id = win.webContents.id;
  images.set(id, img);
  win.on('closed', () => images.delete(id));
  win.loadFile(path.join(ROOT, 'editor.html'));
  win.once('ready-to-show', () => {
    // Stay on top briefly in case Windows refuses to hand over focus, so the editor is never hidden.
    win.setAlwaysOnTop(true);
    if (IS_MAC) app.focus({ steal: true });
    win.show();
    win.focus();
    setTimeout(() => !win.isDestroyed() && win.setAlwaysOnTop(false), 1500);
  });
  return win;
}

ipcMain.handle('artnote:image', e => {
  const img = images.get(e.sender.id);
  if (!img) return null;
  return { dataURL: img.toDataURL(), ...img.getSize() };
});

ipcMain.handle('artnote:copy', (e, png) => clip.writeImage(Buffer.from(png)));

ipcMain.handle('artnote:save', async (e, note) => {
  const src = images.get(e.sender.id);
  const png = Buffer.from(note.png);
  fs.mkdirSync(notesDir, { recursive: true });
  const name = uniqueName(notesDir, stamp());
  fs.writeFileSync(path.join(notesDir, `${name}.png`), png);
  if (src) fs.writeFileSync(path.join(notesDir, `${name}_src.png`), src.toPNG());
  fs.writeFileSync(path.join(notesDir, `${name}.md`), markdown(name, note), 'utf8');
  await clip.writeImage(png);
  log(`saved ${name} (${note.pins.length} pins)`);
  return { name, dir: notesDir };
});

ipcMain.on('artnote:close', e => BrowserWindow.fromWebContents(e.sender)?.close());

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function uniqueName(dir, base) {
  let name = base;
  for (let i = 2; fs.existsSync(path.join(dir, `${name}.png`)); i++) name = `${base}_${i}`;
  return name;
}

function markdown(name, { width, height, pins, texts }) {
  const lines = [
    `# ArtNote ${name.replace('_', ' ')}`,
    '',
    `![правка](${name}.png)`,
    '',
    `Оригінал без розмітки: \`${name}_src.png\` · ${width}×${height}px`,
    '',
  ];
  if (pins.length) {
    lines.push('## Коментарі', '');
    for (const p of pins) lines.push(`${p.n}. ${p.text || '—'} _(x ${p.x}, y ${p.y})_`);
    lines.push('');
  }
  if (texts.length) {
    lines.push('## Написи на картинці', '');
    for (const t of texts) lines.push(`- ${t.replace(/\s*\n\s*/g, ' / ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------- donate window ----------

let donateWin = null;

function openDonate() {
  if (donateWin && !donateWin.isDestroyed()) return donateWin.focus();
  donateWin = new BrowserWindow({
    width: 480,
    height: 520,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    title: 'Підтримати ArtNote',
    icon: path.join(ROOT, 'icon.png'),
    backgroundColor: '#15171c',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(ROOT, 'preload.js') },
  });
  donateWin.loadFile(path.join(ROOT, 'donate.html'));
  return donateWin;
}

// Quiet zone of 4 modules, as wallet scanners expect.
function qrDataURL(text) {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  const svg = code.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

ipcMain.handle('artnote:donate', () => ({
  crypto: donateCrypto.map(c => ({ name: c.name, network: c.network, address: c.address, qr: qrDataURL(c.address) })),
  links: donateLinks.map(l => l.name),
}));

ipcMain.handle('artnote:donate-copy', (e, i) => clip.writeText(donateCrypto[i]?.address || ''));

ipcMain.on('artnote:donate-open', (e, i) => donateLinks[i] && shell.openExternal(donateLinks[i].url));

// The page reports its height once laid out, so the window fits however many options are filled in.
ipcMain.on('artnote:donate-ready', (e, height) => {
  if (!donateWin || donateWin.isDestroyed() || e.sender !== donateWin.webContents) return;
  const { workArea } = screen.getDisplayMatching(donateWin.getBounds());
  donateWin.setContentSize(480, Math.min(Math.ceil(height), workArea.height - 40));
  donateWin.center();
  if (IS_MAC) app.focus({ steal: true });
  donateWin.show();
});

// ---------- tray ----------

const KEY_NAMES = { Super: IS_WIN ? 'Win' : IS_MAC ? 'Cmd' : 'Super', Alt: IS_MAC ? 'Option' : 'Alt', Control: 'Ctrl' };

function registerHotkey() {
  for (const key of [config.hotkey, config.fallbackHotkey].filter(Boolean)) {
    try {
      if (globalShortcut.register(key, () => { log(`hotkey ${key}`); startCapture(); })) {
        hotkeyLabel = key.replace(/Super|Alt|Control/g, k => KEY_NAMES[k]);
        return;
      }
      log(`hotkey ${key} is taken by another program`);
    } catch (err) {
      log(`hotkey ${key} is invalid:`, err.message);
    }
  }
}

// Windows and macOS keep login items themselves; Linux desktops start whatever is in ~/.config/autostart.
function loginOptions() {
  return IS_WIN && !app.isPackaged ? { path: process.execPath, args: [ROOT] } : {};
}

function autostart() {
  if (IS_WIN || IS_MAC) return app.getLoginItemSettings(loginOptions()).openAtLogin;
  return fs.existsSync(LINUX_AUTOSTART);
}

function setAutostart(on) {
  try {
    if (IS_WIN || IS_MAC) return app.setLoginItemSettings({ ...loginOptions(), openAtLogin: on });
    if (!on) return fs.rmSync(LINUX_AUTOSTART, { force: true });
    const exec = [process.env.APPIMAGE || process.execPath, ...(app.isPackaged ? [] : [ROOT])].map(a => `"${a}"`).join(' ');
    fs.mkdirSync(path.dirname(LINUX_AUTOSTART), { recursive: true });
    fs.writeFileSync(LINUX_AUTOSTART, `[Desktop Entry]\nType=Application\nName=ArtNote\nExec=${exec}\nX-GNOME-Autostart-enabled=true\n`);
  } catch (err) {
    log('autostart:', err.message);
  }
}

async function chooseNotesDir() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Куди зберігати правки',
    defaultPath: notesDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return;
  notesDir = filePaths[0];
  saveConfig({ notesDir });
  log(`notes dir: ${notesDir}`);
}

function openSettings() {
  if (!fs.existsSync(CONFIG)) saveConfig({ hotkey: config.hotkey, fallbackHotkey: config.fallbackHotkey, notesDir });
  shell.openPath(CONFIG);
}

function buildMenu() {
  const canDonate = donateCrypto.length || donateLinks.length;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: hotkeyLabel ? `Нова правка${IS_MAC ? '   ' : '\t'}${hotkeyLabel}` : 'Нова правка', click: startCapture },
    { label: 'Правка з буфера обміну', click: openFromClipboard },
    { type: 'separator' },
    { label: 'Відкрити папку з правками', click: () => { fs.mkdirSync(notesDir, { recursive: true }); shell.openPath(notesDir); } },
    { label: 'Змінити папку для правок…', click: chooseNotesDir },
    { label: 'Файл налаштувань (хоткей)', click: openSettings },
    {
      label: IS_WIN ? 'Запускати разом з Windows' : 'Запускати при вході в систему',
      type: 'checkbox',
      checked: autostart(),
      click: item => setAutostart(item.checked),
    },
    { type: 'separator' },
    ...(canDonate ? [{ label: 'Підтримати автора ♥', click: openDonate }, { type: 'separator' }] : []),
    { label: 'Вийти', click: () => app.quit() },
  ]));
}

function notify(content) {
  log('notify:', content);
  if (IS_WIN) tray?.displayBalloon({ title: 'ArtNote', content, iconType: 'info' });
  else if (Notification.isSupported()) new Notification({ title: 'ArtNote', body: content }).show();
}

function init() {
  nativeTheme.themeSource = 'dark';
  if (IS_WIN) app.setAppUserModelId(app.isPackaged ? APP_ID : 'ArtNote');
  app.dock?.hide(); // macOS: live in the menu bar only
  registerHotkey();
  tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'tray.png')));
  tray.setToolTip(hotkeyLabel ? `ArtNote · ${hotkeyLabel}` : 'ArtNote · хоткей зайнятий, клікни по іконці');
  tray.on('click', () => { log('tray click'); startCapture(); });
  buildMenu();
  if (IS_WIN) grabVirtualScreen().catch(() => {}); // the first GDI capture is ~3x slower, pay for it at startup
  prepareOverlays();
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, () => !picking && prepareOverlays());
  }
  log(`start · hotkey ${hotkeyLabel || 'NONE'} · notes ${notesDir}`);
}

// ---------- lifecycle ----------

if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Launching ArtNote again (shortcut, taskbar pin) starts a new capture in the running instance.
  app.on('second-instance', startCapture);
  app.on('window-all-closed', () => {}); // keep living in the tray
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    grabber.proc?.kill();
  });
  app.whenReady().then(() => {
    if (!SELFTEST) return init();
    nativeTheme.themeSource = 'dark';
    const api = { openFromClipboard, startCapture, prepareOverlays, openDonate, setNotesDir: dir => { notesDir = dir; } };
    require(DEMO ? './demo' : './selftest')(api).catch(err => {
      console.error(err);
      app.exit(1);
    });
  });
}

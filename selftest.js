// End-to-end check without a human: `electron . --selftest <outdir>`.
// Opens the editor on a generated image, draws with real mouse/keyboard input, screenshots the
// window, presses Enter and records what was saved and what landed in the clipboard.
const { app, BrowserWindow, nativeImage, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const clip = require('./clip');

const wait = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, ms = 6000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) {
    const v = fn();
    if (v) return v;
  }
  return null;
}

async function dragOn(wc, ...pts) {
  const [x, y] = pts[0];
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  for (const [mx, my] of pts.slice(1)) {
    wc.sendInputEvent({ type: 'mouseMove', x: mx, y: my, button: 'left', modifiers: ['leftButtonDown'] });
    await wait(16);
  }
  const [ex, ey] = pts[pts.length - 1];
  wc.sendInputEvent({ type: 'mouseUp', x: ex, y: ey, button: 'left', clickCount: 1 });
  await wait(120);
}

const lerp = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n].map(Math.round));

function testImage(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let rgb = [40 + 60 * (x / w), 50 + 40 * (y / h), 90 + 80 * (1 - x / w)];
      if (x > w * 0.08 && x < w * 0.55 && y > h * 0.15 && y < h * 0.85) rgb = [236, 230, 220];
      if (Math.hypot(x - w * 0.76, y - h * 0.45) < h * 0.2) rgb = [255, 140, 60];
      buf.set([rgb[2], rgb[1], rgb[0], 255], (y * w + x) * 4); // BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}

module.exports = async function selftest({ openFromClipboard, startCapture, prepareOverlays, setNotesDir }) {
  const argIndex = process.argv.indexOf('--selftest');
  const out = path.resolve(process.argv[argIndex + 1] || 'selftest-out');
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) fs.rmSync(path.join(out, f), { recursive: true });

  const saved = await clip.snapshot();
  const report = { console: [] };
  setNotesDir(path.join(out, 'notes'));
  await clip.writeImage(testImage(1200, 700).toPNG());

  const win = await openFromClipboard();
  const wc = win.webContents;
  wc.on('console-message', e => report.console.push(e.message));
  await new Promise(r => wc.once('did-finish-load', r));
  await wait(900);
  win.focus();
  wc.focus();

  const r = await wc.executeJavaScript(
    "(() => { const b = document.getElementById('cv').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()",
  );
  report.canvas = r;
  const at = (fx, fy) => [Math.round(r.x + r.w * fx), Math.round(r.y + r.h * fy)];
  const key = async code => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: code });
    wc.sendInputEvent({ type: 'keyUp', keyCode: code });
    await wait(80);
  };
  const type = async text => {
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch });
      await wait(8);
    }
  };
  const drag = (...pts) => dragOn(wc, ...pts);

  await key('C');
  await drag(at(0.3, 0.32));
  await wait(150);
  await type('Фон темніший, менше контрасту з картками');
  await key('Enter');

  await key('A');
  await drag(...lerp(at(0.64, 0.82), at(0.42, 0.45), 12));

  await key('B');
  const ring = Array.from({ length: 40 }, (_, i) => {
    const t = (i / 39) * Math.PI * 2.1;
    return at(0.76 + Math.cos(t) * 0.15, 0.45 + Math.sin(t) * 0.26);
  });
  await drag(...ring);

  await key('2');
  await key('T');
  await drag(at(0.6, 0.1));
  await wait(150);
  await type('лого сюди');
  await key('Enter');

  await key('1');
  await key('R');
  await drag(...lerp(at(0.1, 0.18), at(0.53, 0.82), 10));

  await key('3');
  await key('C');
  await drag(at(0.88, 0.75));
  await wait(150);
  await type("М'якша тінь під колом, без чорного");
  await key('Enter');

  await wait(400);
  fs.writeFileSync(path.join(out, 'editor.png'), (await wc.capturePage()).toPNG());
  report.sidePanel = await wc.executeJavaScript("[...document.querySelectorAll('#pins textarea')].map(t => t.value)");
  report.undoEnabled = await wc.executeJavaScript("!document.getElementById('undo').disabled");
  // No Copy press: the markup (taller than the 700px source because of the legend) should already be on the clipboard.
  report.liveClipboard = (await clip.readImage())?.getSize() || null;

  await key('Enter');
  await wait(1600);
  report.windowClosed = win.isDestroyed();
  const pasted = await clip.readImage();
  report.clipboard = pasted && pasted.getSize();
  if (pasted) fs.writeFileSync(path.join(out, 'clipboard.png'), pasted.toPNG());
  const notes = path.join(out, 'notes');
  report.files = fs.existsSync(notes) ? fs.readdirSync(notes) : [];
  const md = report.files.find(f => f.endsWith('.md'));
  report.markdown = md ? fs.readFileSync(path.join(notes, md), 'utf8') : null;

  // Region picker: freeze the screen, drag 400x300 on the overlay, expect an editor with exactly that crop.
  // Only size and brightness stats of the crop are recorded, never the screen content itself.
  prepareOverlays();
  await wait(1500);
  const known = new Set(BrowserWindow.getAllWindows());
  const t0 = Date.now();
  startCapture();
  const overlay = await until(() => BrowserWindow.getAllWindows().find(w => w.isVisible() && w.webContents.getURL().endsWith('overlay.html')));
  report.picker = { shownAfterMs: overlay ? Date.now() - t0 : null };
  if (overlay) {
    await dragOn(overlay.webContents, ...lerp([100, 120], [500, 420], 8));
    const editor = await until(() => BrowserWindow.getAllWindows().find(w => !known.has(w) && w.webContents.getURL().endsWith('editor.html')));
    report.picker.overlayHidden = !overlay.isVisible();
    await wait(400);
    report.picker.clipboard = (await clip.readImage())?.getSize() || null;
    if (editor) {
      await wait(1200);
      const k = screen.getPrimaryDisplay().scaleFactor;
      report.picker.expected = { width: 400 * k, height: 300 * k };
      report.picker.crop = await editor.webContents.executeJavaScript(`(() => {
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let sum = 0, sq = 0, n = 0;
        for (let i = 0; i < d.length; i += 4 * 37) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += v; sq += v * v; n++; }
        const mean = sum / n;
        return { width: cv.width, height: cv.height, mean: Math.round(mean), std: Math.round(Math.sqrt(sq / n - mean * mean)) };
      })()`);
      editor.destroy();
    }
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));

  await clip.restore(saved);
  app.exit(0);
};

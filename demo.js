// Records the README animation: `npm run demo` (electron . --demo docs) writes docs/demo.gif.
// Drives the real editor with real mouse and keyboard input on a made-up poster (demo.html#poster),
// then pastes the result into a plain chat page (demo.html#chat). A drawn cursor and short captions
// are laid over the pages so a viewer can follow; nothing from the real screen is captured.
const { BrowserWindow, app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const clip = require('./clip');

const W = 980; // window content size, DIP (the editor's minimum)
const H = 620;
const GIF_W = 840;
const GIF_H = Math.round((GIF_W * H) / W);
const FPS = 14;
const SPEED = 1.15; // capturing slows the page's timers a little; play back a bit faster than recorded
const wait = ms => new Promise(r => setTimeout(r, ms));
const page = hash => [path.join(__dirname, 'demo.html'), { hash }];

// Cursor, click ripple and caption chip, injected into a page; none of them take mouse events.
const OVERLAY = `(() => {
  const cur = document.createElement('div');
  cur.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;pointer-events:none';
  cur.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M3 2l15 11.5-6.6.9 3.9 7.4-2.8 1.4-3.8-7.5L3 20z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const cap = document.createElement('div');
  cap.style.cssText = 'position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:99998;pointer-events:none;padding:8px 16px;border-radius:10px;background:rgba(12,14,18,.9);border:1px solid rgba(255,255,255,.14);color:#fff;font:600 16px "Segoe UI",sans-serif;white-space:nowrap;opacity:0;transition:opacity .2s';
  document.body.append(cap, cur);
  window.__demo = {
    move(x, y) { cur.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 2) + 'px)'; },
    click(x, y) {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:' + (x - 18) + 'px;top:' + (y - 18) + 'px;width:36px;height:36px;border-radius:50%;border:3px solid #ff5a4e;z-index:99997;pointer-events:none';
      document.body.append(r);
      r.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.2)', opacity: 0 }], 450).onfinish = () => r.remove();
    },
    caption(html) { cap.style.opacity = html ? 1 : 0; if (html) cap.innerHTML = html; },
  };
})()`;

const k = key => `<span style="display:inline-block;min-width:24px;padding:0 7px;margin:0 2px;border-radius:5px;background:#ff5a4e;text-align:center">${key}</span>`;

// Moves a drawn cursor along with the real input events, eased so the eye can follow it.
function driver(wc, start) {
  let pos = start;
  const js = code => wc.executeJavaScript(code);
  const show = ([x, y]) => js(`__demo.move(${x}, ${y})`);
  const button = (type, [x, y]) => wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
  const d = {
    async setup() {
      await js(OVERLAY);
      await show(pos);
    },
    caption: html => js(`__demo.caption(${JSON.stringify(html)})`),
    rect: sel => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })()`),
    async center(sel) {
      const [x, y, w, h] = await d.rect(sel);
      return [Math.round(x + w / 2), Math.round(y + h / 2)];
    },
    async moveTo(to, ms = 380, down = false) {
      const from = pos;
      const n = Math.max(2, Math.round(ms / 16));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        const p = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e].map(Math.round);
        wc.sendInputEvent({ type: 'mouseMove', x: p[0], y: p[1], ...(down && { button: 'left', modifiers: ['leftButtonDown'] }) });
        show(p);
        await wait(16);
      }
      pos = to;
    },
    async click(at, ms) {
      await d.moveTo(at, ms);
      await wait(80);
      button('mouseDown', at);
      button('mouseUp', at);
      js(`__demo.click(${at[0]}, ${at[1]})`);
      await wait(180);
    },
    async drag(from, to, ms = 550) {
      await d.moveTo(from);
      await wait(100);
      button('mouseDown', from);
      await d.moveTo(to, ms, true);
      button('mouseUp', to);
      await wait(200);
    },
    async type(text) {
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch });
        await wait(30);
      }
    },
    async key(keyCode) {
      wc.sendInputEvent({ type: 'keyDown', keyCode });
      wc.sendInputEvent({ type: 'keyUp', keyCode });
      await wait(120);
    },
  };
  return d;
}

// Grabs the target window ~FPS times a second; repeated frames are dropped and stretch the previous one.
function recorder() {
  const frames = [];
  let target = null;
  let on = true;
  const loop = (async () => {
    while (on) {
      const t = Date.now();
      if (target && !target.isDestroyed()) {
        const img = await target.capturePage();
        if (!img.isEmpty()) {
          const bmp = img.resize({ width: GIF_W, height: GIF_H, quality: 'best' }).toBitmap();
          if (!frames.length || !frames[frames.length - 1].bmp.equals(bmp)) frames.push({ t, bmp });
        }
      }
      await wait(Math.max(0, 1000 / FPS - (Date.now() - t)));
    }
  })();
  return {
    frames,
    use(wc) { target = wc; },
    async stop() { on = false; await loop; },
  };
}

// One shared 255-colour palette; after the first frame, unchanged pixels become transparent, which keeps a
// mostly still UI recording small.
function writeGif(frames, file, holdLast) {
  const rgba = bgra => {
    const a = new Uint8Array(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) {
      a[i] = bgra[i + 2];
      a[i + 1] = bgra[i + 1];
      a[i + 2] = bgra[i];
      a[i + 3] = 255;
    }
    return a;
  };
  const step = Math.max(1, Math.floor(frames.length / 24));
  const picks = frames.filter((_, i) => i % step === 0).map(f => rgba(f.bmp));
  const sample = new Uint8Array(picks.reduce((n, p) => n + p.length, 0));
  picks.reduce((o, p) => (sample.set(p, o), o + p.length), 0);
  const colors = quantize(sample, 255);
  const palette = [...colors];
  while (palette.length < 256) palette.push([0, 0, 0]);
  const TRANSPARENT = 255;

  const gif = GIFEncoder();
  let prev = null;
  frames.forEach((f, i) => {
    const idx = applyPalette(rgba(f.bmp), colors);
    const delay = i + 1 < frames.length ? (frames[i + 1].t - f.t) / SPEED : holdLast;
    if (!prev) {
      gif.writeFrame(idx, GIF_W, GIF_H, { palette, delay });
    } else {
      const diff = idx.slice();
      for (let p = 0; p < diff.length; p++) if (diff[p] === prev[p]) diff[p] = TRANSPARENT;
      gif.writeFrame(diff, GIF_W, GIF_H, { delay, transparent: true, transparentIndex: TRANSPARENT, dispose: 1 });
    }
    prev = idx;
  });
  gif.finish();
  fs.writeFileSync(file, gif.bytes());
}

module.exports = async function demo({ openFromClipboard, setNotesDir }) {
  const out = path.resolve(process.argv[process.argv.indexOf('--demo') + 1] || 'docs');
  const saved = await clip.snapshot();
  const notes = fs.mkdtempSync(path.join(os.tmpdir(), 'artnote-demo-'));
  setNotesDir(notes);
  const rec = recorder();
  try {
    // A hidden window can't be captured, so the poster is shown fully transparent for a moment.
    const prop = new BrowserWindow({ show: false, opacity: 0, frame: false, skipTaskbar: true, width: 1200, height: 700, useContentSize: true });
    await prop.loadFile(...page('poster'));
    prop.showInactive();
    await wait(500);
    const poster = (await prop.webContents.capturePage()).resize({ width: 1200, height: 700, quality: 'best' });
    prop.destroy();
    await clip.writeImage(poster.toPNG());

    const chat = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, title: 'Чат', backgroundColor: '#17191f', autoHideMenuBar: true });
    await chat.loadFile(...page('chat'));

    const win = await openFromClipboard();
    win.setContentSize(W, H);
    win.center();
    const wc = win.webContents;
    await new Promise(r => wc.once('did-finish-load', r));
    await wait(1700); // the editor drops always-on-top 1.5 s after showing; keep it on top while recording
    win.setAlwaysOnTop(true);
    await wc.executeJavaScript(`document.querySelector('[data-size="1"]').click(); document.querySelector('[data-color="#ff3b30"]').click();`);

    const ed = driver(wc, [W / 2, H / 2]);
    await ed.setup();
    const [cx, cy, cw, ch] = await ed.rect('#cv');
    const at = (fx, fy) => [Math.round(cx + cw * fx), Math.round(cy + ch * fy)];
    const pin = async (where, text) => {
      await ed.click(await ed.center('[data-tool="pin"]'));
      await ed.click(at(...where));
      await wait(150);
      await ed.type(text);
      await wait(200);
      await ed.key('Enter');
    };

    rec.use(wc);
    await ed.caption(`${k('Win')}+${k('Alt')}+${k('A')} виділи ділянку екрана — і одразу редактор`);
    await wait(1500);

    await ed.caption(`${k('C')} пін: номер на картинці, коментар піде в легенду`);
    await pin([0.47, 0.3], 'Сяйво яскравіше, більше зеленого');
    await wait(300);

    await ed.caption(`${k('A')} стрілка, ще один пін`);
    await ed.click(await ed.center('[data-tool="arrow"]'));
    await ed.drag(at(0.585, 0.56), at(0.49, 0.72));
    await pin([0.6, 0.5], 'Заголовок крупніше');
    await wait(300);

    await ed.caption(`${k('2')} жовтий, ${k('E')} овал`);
    await ed.click(await ed.center('[data-color="#ffd60a"]'));
    await ed.click(await ed.center('[data-tool="ellipse"]'));
    await ed.drag(at(0.66, 0.6), at(0.77, 0.8));
    await pin([0.8, 0.6], 'Тепліше світло у вікні');
    await wait(300);

    await ed.caption('Буфер обміну оновлюється сам після кожної зміни');
    const [sx, sy, sw, sh] = await ed.rect('#synced');
    await ed.moveTo([Math.round(sx + sw + 6), Math.round(sy + sh / 2)], 500); // beside the badge, not over it
    await wait(1300);

    await ed.caption(`${k('Enter')} готово: правка збережена в папку`);
    const bounds = win.getBounds();
    await ed.moveTo(await ed.center('#done'), 500);
    await wait(400);
    const lastPos = await ed.center('#done');
    await ed.click(lastPos, 100);
    const closed = Date.now();
    while (!win.isDestroyed() && Date.now() - closed < 4000) await wait(50);

    chat.setBounds(bounds);
    chat.setAlwaysOnTop(true);
    chat.show();
    const ct = driver(chat.webContents, lastPos);
    await ct.setup();
    await ct.caption(`${k('Ctrl')}+${k('V')} у будь-який чат — коментарі легендою під картинкою`);
    rec.use(chat.webContents);
    await wait(500);
    await ct.click(await ct.center('#input'), 500);
    await wait(300);
    chat.webContents.paste();
    await wait(2600);
    await rec.stop();
    chat.destroy();

    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, 'demo.gif');
    writeGif(rec.frames, file, 3000);
    const span = rec.frames.at(-1).t - rec.frames[0].t + 3000;
    console.log(`demo.gif: ${rec.frames.length} frames, ${(span / 1000).toFixed(1)} s, ${(fs.statSync(file).size / 1e6).toFixed(2)} MB, ${GIF_W}x${GIF_H}`);
  } finally {
    await rec.stop();
    await clip.restore(saved);
    fs.rmSync(notes, { recursive: true, force: true });
  }
  app.exit(0);
};

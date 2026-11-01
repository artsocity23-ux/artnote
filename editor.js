'use strict';

const COLORS = ['#ff3b30', '#ffd60a', '#2ee6d6', '#ffffff'];
const COLOR_NAMES = ['Червоний', 'Жовтий', 'Бірюзовий', 'Білий'];
const STROKE = [3, 5, 9]; // line width per size, CSS px
const FONT = [18, 26, 38]; // text size per size, CSS px
const PIN = [12, 16, 21]; // pin radius per size, CSS px
const TOOL_KEYS = { KeyV: 'move', KeyB: 'pen', KeyA: 'arrow', KeyR: 'rect', KeyE: 'ellipse', KeyT: 'text', KeyC: 'pin' };
const FAMILY = '"Segoe UI", system-ui, sans-serif';
const BASELINE = 1.04; // Segoe UI baseline inside a 1.25 line box, in em — keeps canvas text where the textarea showed it

const api = window.artnote;
const $ = s => document.querySelector(s);
const cv = $('#cv');
const ctx = cv.getContext('2d');
const layer = $('#layer');

let img; // the snip
let view = 1; // image pixels per CSS pixel
let objects = []; // annotations, in image pixels
let history = [];
let future = [];
let tool;
let color;
let size;
let drawing = null; // shape being drawn
let dragging = null;
let selected = null;
let hover = null;
let input = null; // open floating textarea
let escArmed = false;
let busy = false;
let raf = 0;
let synced = '[]'; // objects as last put on the clipboard; the bare image is already there when the editor opens
let syncTimer = 0;

const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem('artnote') || '{}');
  } catch {
    return {};
  }
})();

function savePrefs() {
  try {
    localStorage.setItem('artnote', JSON.stringify({ tool, color, size }));
  } catch {
    // prefs are a convenience only
  }
}

// ---------- toolbar ----------

$('#colors').append(...COLORS.map((c, i) => {
  const b = document.createElement('button');
  b.dataset.color = c;
  b.title = `${COLOR_NAMES[i]} (${i + 1})`;
  b.style.setProperty('--c', c);
  b.append(document.createElement('i'));
  return b;
}));

document.querySelectorAll('#bar button').forEach(b => b.addEventListener('mousedown', e => e.preventDefault()));
document.querySelectorAll('[data-tool]').forEach(b => { b.onclick = () => setTool(b.dataset.tool); });
document.querySelectorAll('[data-color]').forEach(b => { b.onclick = () => setColor(b.dataset.color); });
document.querySelectorAll('[data-size]').forEach(b => { b.onclick = () => setSize(+b.dataset.size); });
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#copy').onclick = copyOnly;
$('#done').onclick = done;

function setTool(t) {
  commitInput();
  tool = t;
  selected = null;
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  cv.style.cursor = t === 'move' ? 'default' : t === 'text' ? 'text' : 'crosshair';
  savePrefs();
  draw();
}

function setColor(c) {
  color = c;
  document.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('on', b.dataset.color === c));
  if (input?.kind === 'text') {
    input.c = c;
    input.ta.style.color = c;
  } else if (input?.kind === 'pin') {
    input.obj.c = c;
    changed();
  } else if (selected) {
    snapshot();
    selected.c = c;
    changed();
  }
  savePrefs();
}

function setSize(s) {
  size = Math.max(0, Math.min(2, s));
  document.querySelectorAll('[data-size]').forEach(b => b.classList.toggle('on', +b.dataset.size === size));
  if (input?.kind === 'text') {
    input.s = FONT[size] * view;
    styleTextInput(input.ta, input);
  }
  savePrefs();
}

// ---------- layout ----------

function fit() {
  if (!img) return;
  const stage = $('#stage');
  const dpr = devicePixelRatio || 1;
  const scale = Math.min(1, (stage.clientWidth - 48) / (img.width / dpr), (stage.clientHeight - 48) / (img.height / dpr));
  const w = (img.width / dpr) * scale;
  cv.style.width = `${w}px`;
  cv.style.height = `${(img.height / dpr) * scale}px`;
  view = img.width / w;
  draw();
}

new ResizeObserver(() => {
  commitInput();
  fit();
}).observe($('#stage'));

function toImg(e) {
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left) * (cv.width / r.width), (e.clientY - r.top) * (cv.height / r.height)];
}

// ---------- pointer ----------

cv.addEventListener('mousedown', e => e.preventDefault()); // keep focus in floating inputs

cv.addEventListener('pointerdown', e => {
  if (e.button !== 0 || busy) return;
  escArmed = false;
  if (input) {
    commitInput();
    return;
  }
  const p = toImg(e);
  switch (tool) {
    case 'pen':
      drawing = { t: 'pen', c: color, w: STROKE[size] * view, pts: [p] };
      break;
    case 'arrow':
    case 'rect':
    case 'ellipse':
      drawing = { t: tool, c: color, w: STROKE[size] * view, a: p, b: p };
      break;
    case 'text': {
      const o = hit(p);
      if (o?.t === 'text') openInput({ kind: 'text', obj: o });
      else openInput({ kind: 'text', x: p[0], y: p[1] - FONT[size] * view * 0.62 });
      return;
    }
    case 'pin':
      placePin(p);
      return;
    case 'move':
      selected = hit(p);
      if (selected) dragging = { last: p, before: JSON.stringify(objects), moved: false };
      draw();
      break;
  }
  cv.setPointerCapture(e.pointerId);
});

cv.addEventListener('pointermove', e => {
  if (drawing?.t === 'pen') {
    for (const ev of e.getCoalescedEvents?.() || [e]) {
      const p = toImg(ev);
      const last = drawing.pts[drawing.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > view * 1.5) drawing.pts.push(p);
    }
    draw();
  } else if (drawing) {
    const p = toImg(e);
    drawing.b = e.shiftKey ? constrain(drawing, p) : p;
    draw();
  } else if (dragging) {
    const p = toImg(e);
    shift(selected, p[0] - dragging.last[0], p[1] - dragging.last[1]);
    dragging.last = p;
    dragging.moved = true;
    draw();
  } else if (tool === 'move') {
    cv.style.cursor = hit(toImg(e)) ? 'move' : 'default';
  }
});

cv.addEventListener('pointerup', finishPointer);
cv.addEventListener('pointercancel', finishPointer);

function finishPointer() {
  if (drawing) {
    const d = drawing;
    drawing = null;
    if (d.t === 'pen' || Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) > view * 4) {
      snapshot();
      objects.push(d);
    }
    changed();
  }
  if (dragging) {
    if (dragging.moved) {
      history.push(dragging.before);
      future = [];
      scheduleSync();
    }
    dragging = null;
    updateButtons();
  }
}

cv.addEventListener('dblclick', e => {
  if (tool !== 'move') return;
  const o = hit(toImg(e));
  if (o?.t === 'text') openInput({ kind: 'text', obj: o });
  else if (o?.t === 'pin') openInput({ kind: 'pin', obj: o });
});

function constrain(d, p) {
  const dx = p[0] - d.a[0];
  const dy = p[1] - d.a[1];
  if (d.t === 'arrow') {
    const step = Math.PI / 4;
    const ang = Math.round(Math.atan2(dy, dx) / step) * step;
    const len = Math.hypot(dx, dy);
    return [d.a[0] + Math.cos(ang) * len, d.a[1] + Math.sin(ang) * len];
  }
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return [d.a[0] + Math.sign(dx || 1) * m, d.a[1] + Math.sign(dy || 1) * m];
}

// ---------- geometry ----------

function bounds(o) {
  switch (o.t) {
    case 'pin':
      return { x: o.x - o.r, y: o.y - o.r, w: o.r * 2, h: o.r * 2 };
    case 'text': {
      ctx.save();
      ctx.font = font(o.s);
      const lines = o.text.split('\n');
      const w = Math.max(...lines.map(l => ctx.measureText(l).width));
      ctx.restore();
      return { x: o.x, y: o.y, w, h: lines.length * o.s * 1.25 };
    }
    case 'pen': {
      const xs = o.pts.map(p => p[0]);
      const ys = o.pts.map(p => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    default: {
      const x = Math.min(o.a[0], o.b[0]);
      const y = Math.min(o.a[1], o.b[1]);
      return { x, y, w: Math.abs(o.b[0] - o.a[0]), h: Math.abs(o.b[1] - o.a[1]) };
    }
  }
}

function segDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function hits(o, p, tol) {
  const [x, y] = p;
  const t = tol + (o.w || 0) / 2;
  switch (o.t) {
    case 'pin':
      return Math.hypot(x - o.x, y - o.y) <= o.r + tol;
    case 'text': {
      const b = bounds(o);
      return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
    }
    case 'pen':
      return o.pts.some((q, i) => segDist(p, o.pts[Math.max(0, i - 1)], q) <= t);
    case 'arrow':
      return segDist(p, o.a, o.b) <= t;
    case 'rect': {
      const b = bounds(o);
      const outside = x < b.x - t || x > b.x + b.w + t || y < b.y - t || y > b.y + b.h + t;
      const inside = x > b.x + t && x < b.x + b.w - t && y > b.y + t && y < b.y + b.h - t;
      return !outside && !inside;
    }
    case 'ellipse': {
      const b = bounds(o);
      const rx = Math.max(b.w / 2, 1);
      const ry = Math.max(b.h / 2, 1);
      const r = Math.hypot((x - b.x - rx) / rx, (y - b.y - ry) / ry);
      return Math.abs(r - 1) * Math.min(rx, ry) <= t;
    }
  }
  return false;
}

function hit(p) {
  for (let i = objects.length - 1; i >= 0; i--) if (hits(objects[i], p, 6 * view)) return objects[i];
  return null;
}

function shift(o, dx, dy) {
  if (o.pts) for (const q of o.pts) { q[0] += dx; q[1] += dy; }
  if (o.a) {
    o.a = [o.a[0] + dx, o.a[1] + dy];
    o.b = [o.b[0] + dx, o.b[1] + dy];
  }
  if ('x' in o) {
    o.x += dx;
    o.y += dy;
  }
}

// ---------- pins & text input ----------

const pinNo = pin => objects.filter(o => o.t === 'pin').indexOf(pin) + 1;

function placePin([x, y]) {
  snapshot();
  const pin = { t: 'pin', c: color, r: PIN[size] * view, x, y, text: '' };
  objects.push(pin);
  changed();
  openInput({ kind: 'pin', obj: pin, isNew: true });
}

function font(px, weight = 600) {
  return `${weight} ${px}px ${FAMILY}`;
}

function styleTextInput(ta, it) {
  ta.style.font = font(it.s / view);
  ta.style.lineHeight = '1.25';
  ta.style.color = it.c;
  ta.style.left = `${it.x / view - 3}px`;
  ta.style.top = `${it.y / view - 1}px`;
}

function openInput(it) {
  commitInput();
  const ta = document.createElement('textarea');
  ta.className = `float ${it.kind}`;
  ta.rows = 1;
  ta.spellcheck = false;
  if (it.kind === 'text') {
    const t = it.obj;
    it.c = t ? t.c : color;
    it.s = t ? t.s : FONT[size] * view;
    if (t) [it.x, it.y] = [t.x, t.y];
    ta.value = t ? t.text : '';
    ta.placeholder = 'Текст';
    styleTextInput(ta, it);
  } else {
    const pin = it.obj;
    const px = pin.x / view;
    ta.value = pin.text;
    ta.placeholder = `Правка ${pinNo(pin)}…   Enter — готово`;
    ta.style.top = `${pin.y / view - 17}px`;
    if (px + 250 > cv.clientWidth) ta.style.right = `${cv.clientWidth - px + pin.r / view + 8}px`;
    else ta.style.left = `${px + pin.r / view + 8}px`;
  }
  layer.append(ta);
  input = { ...it, ta };
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitInput();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelInput();
    }
  });
  ta.addEventListener('blur', () => commitInput());
  draw();
  setTimeout(() => {
    ta.focus();
    ta.select();
  }, 0);
}

function commitInput() {
  if (!input) return;
  const it = input;
  input = null;
  it.ta.remove();
  const value = it.ta.value.replace(/\s+$/, '');
  if (it.kind === 'pin') {
    const text = value.trim();
    if (text !== it.obj.text) {
      if (!it.isNew) snapshot();
      it.obj.text = text;
    }
  } else if (it.obj) {
    if (!value.trim()) {
      snapshot();
      objects.splice(objects.indexOf(it.obj), 1);
    } else if (value !== it.obj.text || it.c !== it.obj.c || it.s !== it.obj.s) {
      snapshot();
      Object.assign(it.obj, { text: value, c: it.c, s: it.s });
    }
  } else if (value.trim()) {
    snapshot();
    objects.push({ t: 'text', c: it.c, s: it.s, x: it.x, y: it.y, text: value });
  }
  changed();
}

function cancelInput() {
  if (!input) return;
  const it = input;
  input = null;
  it.ta.remove();
  if (it.kind === 'pin' && it.isNew) {
    objects.splice(objects.indexOf(it.obj), 1);
    history.pop();
  }
  changed();
}

function renderPins() {
  const pins = objects.filter(o => o.t === 'pin');
  $('#pins').replaceChildren(...pins.map((pin, i) => {
    const li = document.createElement('li');
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = i + 1;
    badge.style.background = pin.c;
    badge.style.color = ink(pin.c);

    const ta = document.createElement('textarea');
    ta.rows = 1;
    ta.value = pin.text;
    ta.placeholder = 'без коментаря';
    ta.spellcheck = false;
    let before;
    ta.onfocus = () => { before = JSON.stringify(objects); };
    ta.oninput = () => {
      pin.text = ta.value;
      scheduleSync();
    };
    ta.onchange = () => {
      history.push(before);
      future = [];
      updateButtons();
    };
    ta.onkeydown = e => {
      e.stopPropagation();
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') {
        e.preventDefault();
        ta.blur();
      }
    };

    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Видалити пін';
    del.textContent = '×';
    del.onclick = () => {
      snapshot();
      objects.splice(objects.indexOf(pin), 1);
      selected = null;
      changed();
    };

    li.onmouseenter = () => { hover = pin; draw(); };
    li.onmouseleave = () => { hover = null; draw(); };
    li.append(badge, ta, del);
    return li;
  }));
  $('#empty').hidden = pins.length > 0;
}

// ---------- history ----------

function snapshot() {
  history.push(JSON.stringify(objects));
  if (history.length > 200) history.shift();
  future = [];
}

function undo() {
  commitInput();
  if (!history.length) return;
  future.push(JSON.stringify(objects));
  objects = JSON.parse(history.pop());
  selected = hover = null;
  changed();
}

function redo() {
  commitInput();
  if (!future.length) return;
  history.push(JSON.stringify(objects));
  objects = JSON.parse(future.pop());
  selected = hover = null;
  changed();
}

function updateButtons() {
  $('#undo').disabled = !history.length;
  $('#redo').disabled = !future.length;
}

function changed() {
  renderPins();
  updateButtons();
  draw();
  scheduleSync();
}

// ---------- drawing ----------

function ink(c) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#111' : '#fff';
}

function draw() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    if (!img) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    paint(ctx, true);
  });
}

function paint(x, ui) {
  x.drawImage(img, 0, 0);
  let n = 0;
  for (const o of objects) {
    const num = o.t === 'pin' ? ++n : 0;
    if (ui && o === input?.obj && o.t === 'text') continue;
    drawObj(x, o, num);
  }
  if (!ui) return;
  if (drawing) drawObj(x, drawing, 0);
  for (const o of new Set([selected, hover])) if (o && objects.includes(o)) outline(x, o);
}

function outline(x, o) {
  const b = bounds(o);
  const pad = (o.w || 0) / 2 + 5 * view;
  x.save();
  x.setLineDash([5 * view, 4 * view]);
  for (const [style, width] of [['rgba(0, 0, 0, .6)', 3 * view], ['rgba(255, 255, 255, .95)', 1.5 * view]]) {
    x.strokeStyle = style;
    x.lineWidth = width;
    x.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  }
  x.restore();
}

// Strokes the parts with a soft dark edge underneath so marks read on any background.
// Two plain strokes instead of shadowBlur, which made big strokes ~10x slower to redraw.
function haloed(x, o, parts) {
  for (const [alpha, grow] of [[0.16, 0.9], [0.26, 0.45]]) {
    x.strokeStyle = `rgba(0, 0, 0, ${alpha})`;
    for (const { path, width } of parts) {
      x.lineWidth = width + o.w * grow;
      x.stroke(path);
    }
  }
  x.strokeStyle = o.c;
  x.fillStyle = o.c;
  for (const { path, width, fill } of parts) {
    if (width) {
      x.lineWidth = width;
      x.stroke(path);
    }
    if (fill) x.fill(path);
  }
}

function drawObj(x, o, num) {
  x.save();
  x.lineCap = 'round';
  x.lineJoin = 'round';
  switch (o.t) {
    case 'pen': {
      const p = o.pts;
      const path = new Path2D();
      if (p.length === 1) {
        path.arc(p[0][0], p[0][1], o.w / 2, 0, Math.PI * 2);
        haloed(x, o, [{ path, width: 0, fill: true }]);
        break;
      }
      path.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length - 1; i++) {
        path.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
      }
      path.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
      haloed(x, o, [{ path, width: o.w }]);
      break;
    }
    case 'arrow': {
      const [ax, ay] = o.a;
      const [bx, by] = o.b;
      const ang = Math.atan2(by - ay, bx - ax);
      const head = Math.min(Math.hypot(bx - ax, by - ay) * 0.6, o.w * 4.2);
      const spread = 0.42;
      const shaft = new Path2D();
      shaft.moveTo(ax, ay);
      shaft.lineTo(bx - Math.cos(ang) * head * 0.7, by - Math.sin(ang) * head * 0.7);
      const tip = new Path2D();
      tip.moveTo(bx, by);
      tip.lineTo(bx - Math.cos(ang - spread) * head, by - Math.sin(ang - spread) * head);
      tip.lineTo(bx - Math.cos(ang + spread) * head, by - Math.sin(ang + spread) * head);
      tip.closePath();
      haloed(x, o, [{ path: shaft, width: o.w }, { path: tip, width: o.w * 0.5, fill: true }]);
      break;
    }
    case 'rect': {
      const b = bounds(o);
      const path = new Path2D();
      path.roundRect(b.x, b.y, b.w, b.h, Math.min(o.w, b.w / 2, b.h / 2));
      haloed(x, o, [{ path, width: o.w }]);
      break;
    }
    case 'ellipse': {
      const b = bounds(o);
      const path = new Path2D();
      path.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      haloed(x, o, [{ path, width: o.w }]);
      break;
    }
    case 'text': {
      x.font = font(o.s);
      x.fillStyle = o.c;
      x.textBaseline = 'alphabetic';
      x.lineWidth = o.s * 0.16;
      x.strokeStyle = 'rgba(0, 0, 0, .8)';
      o.text.split('\n').forEach((line, i) => {
        const ly = o.y + o.s * (BASELINE + i * 1.25);
        x.strokeText(line, o.x, ly);
        x.fillText(line, o.x, ly);
      });
      break;
    }
    case 'pin': {
      x.fillStyle = 'rgba(0, 0, 0, .3)';
      x.beginPath();
      x.arc(o.x, o.y + o.r * 0.08, o.r * 1.16, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = o.c;
      x.beginPath();
      x.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      x.fill();
      x.lineWidth = o.r * 0.16;
      x.strokeStyle = o.c === '#ffffff' ? '#111' : '#fff';
      x.stroke();
      x.fillStyle = ink(o.c);
      x.font = font(o.r * 1.15, 700);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText(String(num), o.x, o.y + o.r * 0.06);
      break;
    }
  }
  x.restore();
}

// ---------- export ----------

// Pin comments go under the image as a legend, so one paste carries both the picture and the words.
function layoutLegend(notes, width) {
  const fs = Math.round(Math.min(40, Math.max(16, width / 55)));
  const pad = Math.round(fs * 1.1);
  const lh = fs * 1.4;
  const badge = fs * 0.8;
  const gap = fs * 0.7;
  const tx = pad + badge * 2 + gap;
  const m = document.createElement('canvas').getContext('2d');
  m.font = font(fs, 400);
  let y = pad;
  const items = notes.map(n => {
    const lines = wrap(m, n.text, width - tx - pad);
    const item = { ...n, lines, y };
    y += Math.max(lines.length * lh, badge * 2) + gap;
    return item;
  });
  return { fs, pad, lh, badge, tx, items, h: Math.round(y - gap + pad) };
}

function wrap(m, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (line && m.measureText(test).width > maxW) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

function drawLegend(x, L, top) {
  const width = x.canvas.width;
  x.save();
  x.fillStyle = '#1c1f26';
  x.fillRect(0, top, width, L.h);
  x.fillStyle = 'rgba(255, 255, 255, .1)';
  x.fillRect(0, top, width, Math.max(1, Math.round(L.fs / 16)));
  for (const it of L.items) {
    const cy = top + it.y + L.badge;
    const bx = L.pad + L.badge;
    x.beginPath();
    x.arc(bx, cy, L.badge, 0, Math.PI * 2);
    x.fillStyle = it.c;
    x.fill();
    x.fillStyle = ink(it.c);
    x.font = font(L.badge * 1.1, 700);
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(String(it.n), bx, cy + L.badge * 0.05);
    x.fillStyle = '#e9ebf0';
    x.font = font(L.fs, 400);
    x.textAlign = 'left';
    it.lines.forEach((line, i) => x.fillText(line, L.tx, cy + i * L.lh));
  }
  x.restore();
}

async function exportPNG() {
  const notes = objects
    .filter(o => o.t === 'pin')
    .map((p, i) => ({ n: i + 1, c: p.c, text: p.text.trim() }))
    .filter(p => p.text);
  const width = notes.length ? Math.max(img.width, 560) : img.width;
  const legend = notes.length ? layoutLegend(notes, width) : null;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = img.height + (legend ? legend.h : 0);
  const x = c.getContext('2d');
  x.fillStyle = '#15171c';
  x.fillRect(0, 0, c.width, c.height);
  x.save();
  x.translate(Math.round((width - img.width) / 2), 0);
  paint(x, false);
  x.restore();
  if (legend) drawLegend(x, legend, img.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

function download(png) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  a.download = 'artnote.png';
  a.click();
}

// The clipboard always holds the current markup, so Ctrl+V in chat works without pressing Copy.
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncClipboard, 300);
}

async function syncClipboard() {
  const state = JSON.stringify(objects);
  if (!api || !img || busy || state === synced) return;
  if (drawing || dragging) return scheduleSync();
  const png = await exportPNG();
  if (busy || state !== JSON.stringify(objects)) return; // edited meanwhile; that edit scheduled its own sync
  await api.copy(png);
  synced = state;
  const badge = $('#synced');
  badge.classList.add('flash');
  setTimeout(() => badge.classList.remove('flash'), 700);
}

// Switching to the chat commits an open input (its blur) and should not wait for the debounce.
addEventListener('blur', () => {
  clearTimeout(syncTimer);
  syncClipboard();
});

async function copyOnly() {
  if (busy) return;
  commitInput();
  const state = JSON.stringify(objects);
  const png = await exportPNG();
  if (api) await api.copy(png);
  else download(png);
  synced = state;
  toast('✓ Скопійовано, Ctrl+V у чат');
}

async function done() {
  if (busy) return;
  commitInput();
  clearTimeout(syncTimer);
  busy = true;
  try {
    const png = await exportPNG();
    const pins = objects.filter(o => o.t === 'pin');
    const note = {
      png,
      width: img.width,
      height: img.height,
      pins: pins.map((p, i) => ({ n: i + 1, text: p.text.trim(), x: Math.round(p.x), y: Math.round(p.y) })),
      texts: objects.filter(o => o.t === 'text').map(o => o.text),
    };
    if (!api) {
      download(png);
      busy = false;
      return;
    }
    const { name } = await api.save(note);
    toast(`✓ Скопійовано, Ctrl+V у чат · ${name}`);
    setTimeout(() => api.close(), 700);
  } catch (err) {
    busy = false;
    toast(`Помилка: ${err.message}`, 5000);
  }
}

let toastTimer = 0;
function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function escape() {
  if (selected) {
    selected = null;
    draw();
  } else if (objects.length && !escArmed) {
    escArmed = true;
    toast('Ще раз Esc — закрити без збереження', 2500);
    setTimeout(() => { escArmed = false; }, 2500);
  } else if (api) {
    api.close();
  } else {
    window.close();
  }
}

// ---------- keyboard ----------

addEventListener('keydown', e => {
  if (busy || e.target.closest?.('textarea')) return;
  const k = e.code;
  if (e.ctrlKey || e.metaKey) {
    const act = { KeyZ: e.shiftKey ? redo : undo, KeyY: redo, KeyC: copyOnly, KeyS: done }[k];
    if (act) {
      e.preventDefault();
      act();
    }
    return;
  }
  if (e.altKey) return;
  if (k !== 'Escape') escArmed = false;
  if (TOOL_KEYS[k]) return setTool(TOOL_KEYS[k]);
  if (/^Digit[1-4]$/.test(k)) return setColor(COLORS[k.slice(5) - 1]);
  if (k === 'BracketLeft') return setSize(size - 1);
  if (k === 'BracketRight') return setSize(size + 1);
  if (k === 'Enter' || k === 'NumpadEnter') {
    e.preventDefault();
    return done();
  }
  if (k === 'Escape') return escape();
  if ((k === 'Delete' || k === 'Backspace') && selected) {
    snapshot();
    objects.splice(objects.indexOf(selected), 1);
    selected = null;
    changed();
  }
});

// ---------- start ----------

// Lets the editor open in a plain browser for UI work, with a generated placeholder image.
function demoImage() {
  const c = document.createElement('canvas');
  c.width = 1100;
  c.height = 640;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, c.width, c.height);
  g.addColorStop(0, '#2b3a55');
  g.addColorStop(1, '#6b4a6e');
  x.fillStyle = g;
  x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = '#ece6dc';
  x.fillRect(90, 100, 520, 440);
  x.fillStyle = '#ff8a3c';
  x.beginPath();
  x.arc(820, 290, 130, 0, Math.PI * 2);
  x.fill();
  return { dataURL: c.toDataURL(), width: c.width, height: c.height };
}

async function init() {
  const data = api ? await api.image() : demoImage();
  if (!data) {
    api?.close();
    return;
  }
  img = new Image();
  img.src = data.dataURL;
  await img.decode();
  cv.width = img.width;
  cv.height = img.height;
  $('#synced').hidden = !api;
  fit();
  setTool(Object.values(TOOL_KEYS).includes(prefs.tool) ? prefs.tool : 'pin');
  setColor(COLORS.includes(prefs.color) ? prefs.color : COLORS[0]);
  setSize(prefs.size in STROKE ? prefs.size : 1);
  changed();
}

init();

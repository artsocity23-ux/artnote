'use strict';

// Full-screen region picker over a frozen screenshot of this display.
const api = window.artnote;
const shot = document.getElementById('shot');
const sel = document.getElementById('sel');
const size = document.getElementById('size');

let start = null;
let rect = null;

api.onShot(async jpeg => {
  reset();
  const old = shot.src;
  shot.src = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
  if (old) URL.revokeObjectURL(old);
  await shot.decode();
  api.shotReady();
});

function reset() {
  start = null;
  rect = null;
  sel.style.display = 'none';
  document.body.classList.remove('dragging');
}

function update(e) {
  const x = Math.min(start[0], e.clientX);
  const y = Math.min(start[1], e.clientY);
  const width = Math.abs(e.clientX - start[0]);
  const height = Math.abs(e.clientY - start[1]);
  rect = { x, y, width, height };
  Object.assign(sel.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
  size.textContent = `${Math.round(width * devicePixelRatio)} × ${Math.round(height * devicePixelRatio)}`;
  size.style.top = y < 32 ? '6px' : '-27px';
  size.style.left = y < 32 ? '6px' : '0';
}

addEventListener('pointerdown', e => {
  if (e.button === 2) {
    reset();
    api.cancel();
    return;
  }
  if (e.button !== 0) return;
  e.preventDefault(); // no text selection, no drag-and-drop: the press is a selection
  start = [e.clientX, e.clientY];
  document.documentElement.setPointerCapture(e.pointerId);
  document.body.classList.add('dragging');
  update(e);
});

addEventListener('pointermove', e => {
  if (start) update(e);
});

addEventListener('pointerup', e => {
  if (!start) return;
  update(e);
  const r = rect;
  reset();
  if (r.width >= 4 && r.height >= 4) api.select(r);
});

// If the system takes the pointer away mid-drag, start over instead of waiting for a pointerup that won't come.
addEventListener('pointercancel', reset);
addEventListener('dragstart', e => e.preventDefault());

addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    reset();
    api.cancel();
  } else if (e.key === 'Enter') {
    reset();
    api.select({ x: 0, y: 0, width: innerWidth, height: innerHeight });
  }
});

addEventListener('contextmenu', e => e.preventDefault());

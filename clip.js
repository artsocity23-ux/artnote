// Clipboard helpers on top of Electron's async ClipboardItem API (Electron 45+).
const { clipboard, nativeImage, ClipboardItem } = require('electron');

const KEEP = ['text/plain', 'text/html', 'image/png'];

async function readImage() {
  for (const item of await clipboard.read()) {
    const type = item.types.find(t => t.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    const img = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
    if (!img.isEmpty()) return img;
  }
  return null;
}

function writeImage(png) {
  return clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
}

function writeText(text) {
  return clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
}

// Items returned by read() are live views of the clipboard, so copy the payloads out before it changes.
async function snapshot() {
  const items = [];
  for (const item of await clipboard.read().catch(() => [])) {
    const data = {};
    for (const type of item.types.filter(t => KEEP.includes(t))) {
      const blob = await item.getType(type).catch(() => null);
      if (blob) data[type] = blob;
    }
    if (Object.keys(data).length) items.push(new ClipboardItem(data));
  }
  return items;
}

async function restore(items) {
  if (items.length) await clipboard.write(items);
}

module.exports = { readImage, writeImage, writeText, snapshot, restore };

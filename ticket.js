// Builds the digital ticket image a buyer receives: your artwork for their
// tier, with a stub underneath carrying their QR code, name and reference.
// Pure JavaScript (jimp), so it needs no build tools on any host.

const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');
const QRCode = require('qrcode');

const ART_DIR = path.join(__dirname, 'public', 'img');
const GOLD = 0xd4a534ff;
const GOLD_LIFT = 0xf0d67fff;
const BAND = 408;          // height of the stub under the artwork
const INK = 0x0d0710ff;

// Bitmap fonts ship with jimp, so nothing to install and nothing to license.
const fonts = {};
const font = async key => (fonts[key] ||= await Jimp.loadFont(Jimp[key]));

// White bitmap text tinted to a colour, alpha preserved.
async function tinted(text, fontKey, colour, maxWidth) {
  const f = await font(fontKey);
  const w = Math.min(Math.ceil(Jimp.measureText(f, text)) + 4, maxWidth || 4000);
  const h = Jimp.measureTextHeight(f, text, w) + 4;
  const layer = new Jimp(Math.max(w, 1), Math.max(h, 1), 0x00000000);
  layer.print(f, 0, 0, text, w);
  if (colour) layer.color([{ apply: 'mix', params: [Jimp.intToRGBA(colour), 100] }]);
  return layer;
}

async function line(img, text, x, y, fontKey, colour, maxWidth) {
  if (!text) return;
  const layer = await tinted(String(text), fontKey, colour, maxWidth);
  img.composite(layer, x, y);
}

/**
 * @returns {Promise<Buffer>} JPEG of the finished ticket. JPEG, not PNG,
 * because the artwork is photographic and a 2 MB attachment is a poor
 * gift to someone on mobile data. Quality 90 leaves the QR crisp.
 */
async function buildTicket(order, tier, event) {
  const artPath = path.join(ART_DIR, tier.art);

  // No artwork on disk? Still send a ticket rather than nothing.
  const art = fs.existsSync(artPath) ? await Jimp.read(artPath) : null;
  const W = art ? art.bitmap.width : 1600;
  const artH = art ? art.bitmap.height : 0;

  const canvas = new Jimp(W, artH + BAND, INK);
  if (art) canvas.composite(art, 0, 0);

  // gold hairline between the artwork and the stub
  const rule = new Jimp(W - 80, 1, GOLD);
  canvas.composite(rule, 40, artH + 28);

  // QR — quiet margin matters, scanners need the white border
  const qrPng = await QRCode.toBuffer(order.reference, { width: 280, margin: 2 });
  const qr = await Jimp.read(qrPng);
  const qrY = artH + 62;
  const pad = new Jimp(qr.bitmap.width + 20, qr.bitmap.height + 20, 0xffffffff);
  pad.composite(qr, 10, 10);
  canvas.composite(pad, 56, qrY);

  const colX = 56 + pad.bitmap.width + 46;
  let y = qrY - 6;

  await line(canvas, tier.name.toUpperCase(), colX, y, 'FONT_SANS_32_WHITE', GOLD_LIFT, 620);
  y += 46;
  await line(canvas, order.name, colX, y, 'FONT_SANS_32_WHITE', 0xffffffff, 620);
  y += 52;
  await line(canvas, 'REFERENCE', colX, y, 'FONT_SANS_16_WHITE', GOLD, 620);
  y += 24;
  await line(canvas, order.reference, colX, y, 'FONT_SANS_64_WHITE', GOLD_LIFT, 620);

  const rightX = Math.round(W * 0.66);
  let ry = qrY - 6;
  const admits = order.quantity > 1 ? `ADMITS ${order.quantity}` : 'ADMITS 1';
  await line(canvas, admits, rightX, ry, 'FONT_SANS_32_WHITE', GOLD_LIFT, 520);
  ry += 54;
  await line(canvas, event.date.toUpperCase(), rightX, ry, 'FONT_SANS_16_WHITE', 0xffffffff, 520);
  ry += 26;
  await line(canvas, event.time, rightX, ry, 'FONT_SANS_16_WHITE', 0xffffffff, 520);
  ry += 26;
  await line(canvas, event.venue.toUpperCase(), rightX, ry, 'FONT_SANS_16_WHITE', 0xffffffff, 520);
  ry += 44;
  await line(canvas, 'SHOW THIS AT THE DOOR', rightX, ry, 'FONT_SANS_16_WHITE', GOLD, 520);

  return canvas.quality(90).getBufferAsync(Jimp.MIME_JPEG);
}

module.exports = { buildTicket };

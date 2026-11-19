/**
 * Regenerates build/icon.png, build/icon.ico and build/icon.icns from build/icon.svg.
 * Run with Electron (it rasterises the SVG with Chromium, no extra dependency):
 *   npm run icons
 * The generated files are committed; electron-builder only reads them.
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const buildDir = path.resolve(__dirname, '..', 'build');
const svg = fs.readFileSync(path.join(buildDir, 'icon.svg'), 'utf8');

async function rasterise(size) {
  const win = new BrowserWindow({ width: 400, height: 400, show: false, webPreferences: { sandbox: true } });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace(
    '<svg ',
    `<svg style="display:block;width:${size}px;height:${size}px" `
  )}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // Emulate a size x size viewport at DPR 1 with a transparent background, independent of the screen size.
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  await dbg.sendCommand('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const shot = await dbg.sendCommand('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
    captureBeyondViewport: true
  });
  dbg.detach();
  win.destroy();
  const img = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
  const got = img.getSize();
  if (got.width !== size || got.height !== size) throw new Error(`expected ${size}px render, got ${got.width}x${got.height}`);
  return img;
}

function buildIco(images) {
  // PNG-compressed ICO (supported since Windows Vista)
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = [];
  let offset = 6 + images.length * 16;
  const payloads = [];
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    dir.push(e);
    payloads.push(png);
  }
  return Buffer.concat([header, ...dir, ...payloads]);
}

function buildIcns(entries) {
  const chunks = entries.map(({ type, png }) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 4, 'ascii');
    h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const master = await rasterise(1024);
    const at = (size) => master.resize({ width: size, height: size, quality: 'best' }).toPNG();

    fs.writeFileSync(path.join(buildDir, 'icon.png'), master.toPNG());
    fs.writeFileSync(
      path.join(buildDir, 'icon.ico'),
      buildIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: at(size) })))
    );
    fs.writeFileSync(
      path.join(buildDir, 'icon.icns'),
      buildIcns([
        { type: 'ic07', png: at(128) },
        { type: 'ic08', png: at(256) },
        { type: 'ic09', png: at(512) },
        { type: 'ic10', png: master.toPNG() }
      ])
    );
    console.log('Wrote build/icon.png, build/icon.ico, build/icon.icns');
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});

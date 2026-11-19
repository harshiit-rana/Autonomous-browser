/**
 * Set-of-Marks drawn on a captured BGRA bitmap (issue #225). The marks never touch the page DOM: the agent's
 * screenshot tool captures the page, then draws a box and the ref number of each element onto the pixels.
 * Electron-free so it can be tested on a plain buffer.
 */

export interface Mark {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// 3x5 digit font, rows top to bottom, 3 bits per row (MSB = left column).
const DIGITS: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [7, 1, 7, 4, 7], '3': [7, 1, 7, 1, 7], '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7], '6': [7, 4, 7, 5, 7], '7': [7, 1, 1, 1, 1], '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 7],
  'e': [0, 7, 7, 4, 7]
};

const PALETTE: Array<[number, number, number]> = [
  [225, 29, 72], [37, 99, 235], [5, 150, 105], [217, 119, 6], [124, 58, 237], [8, 145, 178]
];

function setPx(buf: Buffer, w: number, h: number, x: number, y: number, rgb: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4; // BGRA
  buf[i] = rgb[2];
  buf[i + 1] = rgb[1];
  buf[i + 2] = rgb[0];
  buf[i + 3] = 255;
}

function fillRect(buf: Buffer, w: number, h: number, x: number, y: number, rw: number, rh: number, rgb: [number, number, number]): void {
  for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) setPx(buf, w, h, xx, yy, rgb);
}

/**
 * Draws each mark (2px outline + a filled label tag with the digits of its label) into `buf` in place.
 * `scale` converts page CSS pixels to bitmap pixels (devicePixelRatio of the capture). Returns the marks drawn.
 */
export function drawMarks(buf: Buffer, width: number, height: number, marks: Mark[], scale = 1): Mark[] {
  const drawn: Mark[] = [];
  marks.forEach((m, idx) => {
    const rgb = PALETTE[idx % PALETTE.length];
    const x = Math.round(m.x * scale), y = Math.round(m.y * scale);
    const w = Math.max(1, Math.round(m.width * scale)), h = Math.max(1, Math.round(m.height * scale));
    if (x >= width || y >= height || x + w <= 0 || y + h <= 0) return;
    const t = Math.max(2, Math.round(scale * 2));
    fillRect(buf, width, height, x, y, w, t, rgb);
    fillRect(buf, width, height, x, y + h - t, w, t, rgb);
    fillRect(buf, width, height, x, y, t, h, rgb);
    fillRect(buf, width, height, x + w - t, y, t, h, rgb);
    const chars = m.label.split('').filter(c => DIGITS[c]);
    const px = Math.max(2, Math.round(scale * 2));
    const tagW = chars.length * 4 * px + px, tagH = 7 * px;
    const tx = x, ty = Math.max(0, y - tagH);
    fillRect(buf, width, height, tx, ty, tagW, tagH, rgb);
    chars.forEach((c, ci) => {
      DIGITS[c].forEach((row, ry) => {
        for (let cx = 0; cx < 3; cx++) {
          if (row & (4 >> cx)) fillRect(buf, width, height, tx + px + ci * 4 * px + cx * px, ty + px + ry * px, px, px, [255, 255, 255]);
        }
      });
    });
    drawn.push(m);
  });
  return drawn;
}

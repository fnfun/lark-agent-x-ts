import QRCode from 'qrcode';

/**
 * Terminal QR code (Python qrcode's print_ascii(invert=True)): two rows of modules per character,
 * inverted, so light modules are drawn as solid blocks, suited to dark-background terminals; a
 * 1-module border.
 */
export function qrAscii(text: string): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const border = 1;
  const dark = (r: number, c: number) => {
    // With an odd row count, the padding half-row at the end counts as dark (blank once
    // inverted), as in the Python version
    if (Math.max(r, c) >= size + border) return true;
    return r >= 0 && c >= 0 && r < size && c < size && Boolean(qr.modules.get(r, c));
  };
  // Index = top dark + bottom dark × 2; once inverted, light is solid
  const codes = ['█', '▄', '▀', ' '];
  const lines: string[] = [];
  for (let r = -border; r < size + border; r += 2) {
    let line = '';
    for (let c = -border; c < size + border; c++) {
      line += codes[(dark(r, c) ? 1 : 0) + (dark(r + 1, c) ? 2 : 0)];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Saves the QR code as a PNG (an image for when the terminal QR code cannot be scanned). */
export function saveQrPng(text: string, path: string): Promise<void> {
  return QRCode.toFile(path, text, { errorCorrectionLevel: 'M', margin: 1, scale: 10 });
}

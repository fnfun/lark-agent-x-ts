import QRCode from 'qrcode';

/**
 * 终端二维码（对应 Python qrcode 的 print_ascii(invert=True)）：两行模块合成一个字符，
 * 反色显示——浅色模块画成实心块，适合深色背景的终端；外边距 1 个模块。
 */
export function qrAscii(text: string): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const border = 1;
  const dark = (r: number, c: number) => {
    // 行数为奇数时最后补的半行按深色处理（反色后为空白），与 Python 版一致
    if (Math.max(r, c) >= size + border) return true;
    return r >= 0 && c >= 0 && r < size && c < size && Boolean(qr.modules.get(r, c));
  };
  // 下标 = 上方深色 + 下方深色 × 2；反色后浅色为实心
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

/** 保存 PNG 版二维码（扫不了终端二维码时用图片）。 */
export function saveQrPng(text: string, path: string): Promise<void> {
  return QRCode.toFile(path, text, { errorCorrectionLevel: 'M', margin: 1, scale: 10 });
}

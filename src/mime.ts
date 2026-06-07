/** Sniff common receipt/document formats from the first bytes of a decoded buffer. */
export function sniffContentType(buf: Buffer): string | undefined {
  if (buf.length < 4) return undefined;
  // PDF: "%PDF"
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // GIF: "GIF8"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  // WebP: "RIFF"...."WEBP"
  if (buf.length >= 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') {
    return 'image/webp';
  }
  // HEIC/HEIF: "ftyp" at offset 4, brand at 8
  if (buf.length >= 12 && buf.subarray(4, 8).toString() === 'ftyp') {
    const brand = buf.subarray(8, 12).toString();
    if (['heic', 'heix', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return undefined;
}

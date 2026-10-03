// Photos sent by website visitors (D-96): private metadata is removed before a file is stored — camera position (EXIF GPS),
// device, comments, XMP / IPTC, and anything appended after the image. Pure byte work on the container, nothing is decoded:
// JPEG segments, PNG chunks, WebP RIFF chunks. A file that cannot be walked safely is refused (null), never stored as it came.

/** JPEG: keep the image (tables, frames, scans), JFIF, the colour profile and Adobe's colour marker; drop every other APPn and comments */
function stripJpeg(b: Buffer): Buffer | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i + 1] === 0xff) i++; // fill bytes before a marker
    const m = b[i + 1];
    if (m === undefined) return null;
    if (m === 0xd9) { out.push(Buffer.from([0xff, 0xd9])); return Buffer.concat(out); } // end of image: whatever follows is dropped
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { out.push(Buffer.from([0xff, m])); i += 2; continue; }
    if (i + 4 > b.length) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const segment = b.subarray(i, i + 2 + len);
    i += 2 + len;
    if (m === 0xda) { // start of scan: the compressed data runs to the next real marker (FF00 = data, FFD0–D7 = restart)
      let j = i;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0x00 && !(b[j + 1]! >= 0xd0 && b[j + 1]! <= 0xd7))) j++;
      if (j + 1 >= b.length) return null;
      out.push(segment, b.subarray(i, j));
      i = j;
      continue;
    }
    const icc = m === 0xe2 && segment.subarray(4, 16).toString("latin1") === "ICC_PROFILE\0";
    const keep = m === 0xe0 || m === 0xee || icc || !((m >= 0xe1 && m <= 0xef) || m === 0xfe);
    if (keep) out.push(segment);
  }
  return null;
}

/** PNG: drop text, EXIF and time chunks; stop at IEND */
function stripPng(b: Buffer): Buffer | null {
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i), type = b.subarray(i + 4, i + 8).toString("latin1");
    if (i + 12 + len > b.length) return null;
    if (!["tEXt", "zTXt", "iTXt", "eXIf", "tIME"].includes(type)) out.push(b.subarray(i, i + 12 + len));
    i += 12 + len;
    if (type === "IEND") return Buffer.concat(out);
  }
  return null;
}

/** WebP: drop the EXIF and XMP chunks, clear their flags in VP8X, rewrite the RIFF size */
function stripWebp(b: Buffer): Buffer | null {
  if (b.length < 20) return null;
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = b.subarray(i, i + 4).toString("latin1"), len = b.readUInt32LE(i + 4);
    if (i + 8 + len > b.length) return null;
    const total = 8 + len + (len & 1);
    if (type !== "EXIF" && type !== "XMP ") {
      const c = Buffer.from(b.subarray(i, Math.min(i + total, b.length)));
      if (type === "VP8X" && len >= 1) c[8] = c[8]! & ~0x0c;
      chunks.push(c);
    }
    i += total;
  }
  if (!chunks.length) return null;
  const body = Buffer.concat(chunks), head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1"); head.writeUInt32LE(4 + body.length, 4); head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}

export function stripImageMeta(buf: Buffer, mime: "image/jpeg" | "image/png" | "image/webp"): Buffer | null {
  return mime === "image/jpeg" ? stripJpeg(buf) : mime === "image/png" ? stripPng(buf) : stripWebp(buf);
}

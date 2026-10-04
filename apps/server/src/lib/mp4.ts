// The length of an MP4 from its movie header (moov → mvhd: timescale + duration). The tutorial videos are written with
// "faststart" (the header comes first), so the first megabyte holds it. null when it cannot be read.
import { open } from "node:fs/promises";

export async function mp4Seconds(path: string): Promise<number | null> {
  const fh = await open(path, "r").catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const b = buf.subarray(0, bytesRead), i = b.indexOf("mvhd");
    if (i < 4 || i + 32 > b.length) return null;
    const v1 = b[i + 4] === 1; // version: 0 = 32-bit times, 1 = 64-bit
    const scale = b.readUInt32BE(v1 ? i + 24 : i + 16);
    const units = v1 ? Number(b.readBigUInt64BE(i + 28)) : b.readUInt32BE(i + 20);
    return scale ? Math.round((units / scale) * 10) / 10 : null;
  } finally {
    await fh.close();
  }
}

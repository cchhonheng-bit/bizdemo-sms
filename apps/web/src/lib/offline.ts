// Offline queue for checkpoints (Requirements §6: pressed without internet → kept and sent later with the REAL time pressed).
// Stored in localStorage (small, survives reloads); flushed when the phone is back online and on app start.
import { ApiError, post } from "./http";

export type QueuedCheckpoint = { bookingId: string; step: string; at: string; lat: number | null; lng: number | null; accuracy: number | null; no_gps: boolean };
const KEY = "ots.cp-queue";

function read(): QueuedCheckpoint[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]") as QueuedCheckpoint[]; } catch { return []; }
}
function write(q: QueuedCheckpoint[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* storage full / blocked: nothing else to do */ }
}
export const queued = (bookingId?: string) => read().filter((q) => !bookingId || q.bookingId === bookingId);

/** send now; on a network failure keep it in the queue (returns "queued") */
export async function sendCheckpoint(c: QueuedCheckpoint): Promise<"sent" | "queued"> {
  try {
    await post(`/api/bookings/${c.bookingId}/checkpoint`, { step: c.step, at: c.at, lat: c.lat, lng: c.lng, accuracy: c.accuracy, no_gps: c.no_gps, offline: false });
    return "sent";
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) { write([...read().filter((q) => !(q.bookingId === c.bookingId && q.step === c.step)), c]); return "queued"; }
    throw e;
  }
}

let flushing = false;
/** retry everything in order (per booking the steps are already in order); server errors other than network drop the item */
export async function flushCheckpoints(): Promise<number> {
  if (flushing || !navigator.onLine) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const c of read()) {
      try {
        await post(`/api/bookings/${c.bookingId}/checkpoint`, { step: c.step, at: c.at, lat: c.lat, lng: c.lng, accuracy: c.accuracy, no_gps: c.no_gps, offline: true });
        sent++;
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) break; // still offline — try again later
      }
      write(read().filter((q) => !(q.bookingId === c.bookingId && q.step === c.step)));
    }
  } finally { flushing = false; }
  return sent;
}

export function startOfflineSync(onSent: () => void): void {
  const go = () => { void flushCheckpoints().then((n) => { if (n) onSent(); }); };
  window.addEventListener("online", go);
  go();
}

/** one GPS reading (FR-601/604): position + accuracy, or null when GPS is off / refused / too slow */
export function readGps(timeoutMs = 12_000): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((res) => navigator.geolocation.getCurrentPosition(
    (p) => res({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)), accuracy: Math.round(p.coords.accuracy) }),
    () => res(null), { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 }));
}

/** FR-702: shrink a photo before upload (≤ 1600 px, JPEG ~0.7) → base64 without the data: prefix */
export async function compressPhoto(file: File, maxSide = 1600, quality = 0.7): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL("image/jpeg", quality).split(",")[1]!;
}

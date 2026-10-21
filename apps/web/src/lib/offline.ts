// Offline work on the technician's phone (Requirements §6 · D-75 checkpoints · D-155 photos, added lines, the report):
// anything pressed without internet is kept on the phone and sent later, in the order it was done, with the real time.
// Small things (checkpoints, lines, the report's notes + signature) live in localStorage; photo data goes to IndexedDB (too big
// for localStorage) with a localStorage fallback. Every queued upload carries a client key so a retry never doubles it.
// The UI subscribes with `useOffline(bookingId)` and shows what still waits; a server refusal (not a network error) drops the
// item and keeps a note the technician can read.
import { useSyncExternalStore } from "react";
import { ApiError, post } from "./http";

export type ActionKind = "checkpoint" | "photo" | "extra" | "report";
export type Action = { id: string; bookingId: string; kind: ActionKind; at: string; label: string; body: Record<string, unknown>; hasBlob?: boolean };
export type Failure = { id: string; bookingId: string; kind: ActionKind; label: string; error: string; at: string };
/** kept for the checkpoint callers (D-75) */
export type QueuedCheckpoint = { bookingId: string; step: string; at: string; lat: number | null; lng: number | null; accuracy: number | null; no_gps: boolean };

const KEY = "ots.queue", FAILED = "ots.sync-failed", OLD_KEY = "ots.cp-queue";
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function read(): Action[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Action[]; } catch { return []; }
}
function write(q: Action[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* storage full / blocked */ }
  notify();
}
export function failures(bookingId?: string): Failure[] {
  try { return (JSON.parse(localStorage.getItem(FAILED) ?? "[]") as Failure[]).filter((f) => !bookingId || f.bookingId === bookingId); } catch { return []; }
}
function fail(a: Action, error: string): void {
  try { localStorage.setItem(FAILED, JSON.stringify([...failures(), { id: a.id, bookingId: a.bookingId, kind: a.kind, label: a.label, error, at: new Date().toISOString() }].slice(-30))); } catch { /* ignore */ }
}
export function clearFailures(bookingId?: string): void {
  try { localStorage.setItem(FAILED, JSON.stringify(failures().filter((f) => bookingId && f.bookingId !== bookingId))); } catch { /* ignore */ }
  notify();
}

// ---------- photo data (IndexedDB, localStorage as a fallback) ----------
const DB = "ots-offline", STORE = "blobs";
function idb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
}
async function putBlob(id: string, data: string): Promise<boolean> {
  const db = await idb();
  if (!db) { try { localStorage.setItem(`ots.blob.${id}`, data); return true; } catch { return false; } }
  return new Promise((res) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put(data, id); tx.oncomplete = () => res(true); tx.onerror = () => res(false); });
}
async function getBlob(id: string): Promise<string | null> {
  const db = await idb();
  if (!db) return localStorage.getItem(`ots.blob.${id}`);
  return new Promise((res) => { const r = db.transaction(STORE).objectStore(STORE).get(id); r.onsuccess = () => res((r.result as string | undefined) ?? null); r.onerror = () => res(null); });
}
async function delBlob(id: string): Promise<void> {
  const db = await idb();
  if (!db) { localStorage.removeItem(`ots.blob.${id}`); return; }
  await new Promise<void>((res) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).delete(id); tx.oncomplete = () => res(); tx.onerror = () => res(); });
}

// ---------- the queue ----------
export const pending = (bookingId?: string): Action[] => read().filter((a) => !bookingId || a.bookingId === bookingId);
export const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
const networkError = (e: unknown) => e instanceof ApiError && e.status === 0;

/** keep an action on the phone (a photo's data apart) */
export async function enqueue(a: Omit<Action, "id"> & { id?: string }, blob?: string): Promise<Action> {
  const action: Action = { ...a, id: a.id ?? newKey() };
  if (blob) { const ok = await putBlob(action.id, blob); if (!ok) action.body = { ...action.body, data: blob }; else action.hasBlob = true; }
  write([...read(), action]);
  return action;
}
async function remove(id: string): Promise<void> {
  write(read().filter((a) => a.id !== id));
  await delBlob(id);
}

/** try now; without internet (or when the network fails) keep it for later. Returns what happened. */
export async function sendOrQueue<T>(a: Omit<Action, "id">, send: () => Promise<T>, blob?: string): Promise<{ status: "sent"; result: T } | { status: "queued"; action: Action }> {
  if (!isOffline() && !pending(a.bookingId).length) { // earlier items of the same job must go first — keep the order
    try { return { status: "sent", result: await send() }; }
    catch (e) { if (!networkError(e)) throw e; }
  }
  return { status: "queued", action: await enqueue(a, blob) };
}

async function sendAction(a: Action): Promise<void> {
  const body = a.hasBlob ? { ...a.body, data: await getBlob(a.id) } : a.body;
  if (a.hasBlob && !(body as { data?: string | null }).data) throw new ApiError("BLOB_LOST", 400); // the phone dropped the photo data (storage cleared)
  switch (a.kind) {
    case "checkpoint": await post(`/api/bookings/${a.bookingId}/checkpoint`, { ...body, offline: true }); return;
    case "photo": await post(`/api/bookings/${a.bookingId}/photos`, body); return;
    case "extra": { const { data, photo: _p, ...rest } = body as { data?: string | null; photo?: unknown } & Record<string, unknown>; void _p; /* the photo data travels apart */ await post(`/api/bookings/${a.bookingId}/extras`, { ...rest, ...(data ? { photo: data } : {}) }); return; }
    case "report": await post(`/api/bookings/${a.bookingId}/report`, body); return;
  }
}

let flushing = false;
/** send everything in order; a network failure stops (next time); a server refusal drops the item and notes why */
export async function flushAll(): Promise<number> {
  if (flushing || isOffline()) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const a of read()) {
      try { await sendAction(a); sent++; }
      catch (e) {
        if (networkError(e)) break;
        fail(a, e instanceof ApiError ? e.code : "ERROR");
      }
      await remove(a.id);
    }
  } finally { flushing = false; }
  return sent;
}

export function startOfflineSync(onSent: () => void): void {
  // D-75 → D-155: a queue from the older app version moves over once
  try {
    const old = JSON.parse(localStorage.getItem(OLD_KEY) ?? "[]") as QueuedCheckpoint[];
    if (old.length) { write([...read(), ...old.map((c) => ({ id: newKey(), bookingId: c.bookingId, kind: "checkpoint" as const, at: c.at, label: c.step, body: { step: c.step, at: c.at, lat: c.lat, lng: c.lng, accuracy: c.accuracy, no_gps: c.no_gps } }))]); localStorage.removeItem(OLD_KEY); }
  } catch { /* ignore */ }
  const go = () => { void flushAll().then((n) => { if (n) { notify(); onSent(); } }); };
  window.addEventListener("online", go);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") go(); });
  setInterval(go, 60_000);
  go();
}

/** the queued and failed items of a job, re-rendered whenever the queue changes */
export function useOffline(bookingId?: string): { pending: Action[]; failed: Failure[] } {
  const snap = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => localStorage.getItem(KEY) + "|" + localStorage.getItem(FAILED), () => "");
  void snap;
  return { pending: pending(bookingId), failed: failures(bookingId) };
}

// ---------- checkpoints (D-75 API kept) ----------
export const queued = (bookingId?: string) => pending(bookingId).filter((a) => a.kind === "checkpoint").map((a) => ({ bookingId: a.bookingId, step: String(a.body.step), at: a.at } as QueuedCheckpoint));
/** send now; on a network failure keep it in the queue (returns "queued") */
export async function sendCheckpoint(c: QueuedCheckpoint): Promise<"sent" | "queued"> {
  const r = await sendOrQueue({ bookingId: c.bookingId, kind: "checkpoint", at: c.at, label: c.step, body: { step: c.step, at: c.at, lat: c.lat, lng: c.lng, accuracy: c.accuracy, no_gps: c.no_gps } },
    () => post(`/api/bookings/${c.bookingId}/checkpoint`, { step: c.step, at: c.at, lat: c.lat, lng: c.lng, accuracy: c.accuracy, no_gps: c.no_gps, offline: false }));
  return r.status;
}
export const flushCheckpoints = flushAll;

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

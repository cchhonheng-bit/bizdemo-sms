// D-149 (owner 20-10): the staff app reloads itself when a new build is deployed — nobody has to clear the cache or reopen the app.
// Two signals, both checked every 5 minutes and whenever the app comes back to the front:
//  1. the service worker (vite-plugin-pwa, autoUpdate): `registration.update()` fetches the new worker; when it takes control
//     (`controllerchange`) the page reloads once;
//  2. the build id: `/healthz` answers `{ build }` (baked into the image at docker build); when it differs from the build this
//     bundle was made with, the worker is asked to update and the page reloads a moment later.
// A reload never interrupts typing: while a field has the focus the reload waits for the next check.
import { registerSW } from "virtual:pwa-register";

const MINUTE = 60_000;
const BUILD = (import.meta.env.VITE_BUILD as string | undefined) ?? "dev";
let reloading = false;

function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}
function reload(): void {
  if (reloading) return;
  if (typing()) { setTimeout(reload, 30_000); return; }
  reloading = true;
  window.location.reload();
}

export function startAutoUpdate(): void {
  if (!("serviceWorker" in navigator)) return;
  let reg: ServiceWorkerRegistration | undefined;
  const update = registerSW({
    immediate: true,
    onRegisteredSW(_url, r) { reg = r; },
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (navigator.serviceWorker.controller) reload(); });
  let newer = false;
  const check = async () => {
    try { await reg?.update(); } catch { /* offline */ }
    if (BUILD === "dev") return;
    try {
      const r = await fetch(`/healthz?b=${Date.now()}`, { cache: "no-store" });
      const j = (await r.json()) as { build?: string };
      if (j.build && j.build !== BUILD) {
        if (newer) return reload(); // the second time round: the worker had its chance — reload anyway
        newer = true;
        await update(true).catch(() => undefined); // activate the waiting worker → controllerchange → reload
        setTimeout(() => { if (!reloading) reload(); }, 3_000);
      }
    } catch { /* offline: next time */ }
  };
  setInterval(() => void check(), 5 * MINUTE);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void check(); });
  window.addEventListener("online", () => void check());
  setTimeout(() => void check(), 20_000); // soon after the start (the first paint stays fast)
}

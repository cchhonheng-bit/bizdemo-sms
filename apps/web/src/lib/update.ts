// D-149 (owner 20-10): the staff app reloads itself when a new build is deployed — nobody has to clear the cache or reopen the app.
// Two signals, both checked every 5 minutes and whenever the app comes back to the front:
//  1. the service worker (vite-plugin-pwa, autoUpdate — the new worker takes over at once): `registration.update()` fetches it;
//     when it takes control (`controllerchange`) the page reloads once;
//  2. the build id: `/healthz` answers `{ build }` (baked into the image at docker build); when it differs from the build this
//     bundle was made with, the worker is asked to update and the page reloads a moment later even if the worker stays quiet.
// A reload never interrupts typing: while a field has the focus the reload waits. No extra dependency (no workbox-window): the
// plugin's own inline script registers the worker; this module only talks to the registration.
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
  const sw = navigator.serviceWorker;
  sw.addEventListener("controllerchange", () => { if (sw.controller) reload(); });
  let newer = false;
  const check = async () => {
    const reg = await sw.getRegistration().catch(() => undefined);
    try { await reg?.update(); } catch { /* offline */ }
    if (BUILD === "dev") return;
    try {
      const r = await fetch(`/healthz?b=${Date.now()}`, { cache: "no-store" });
      const j = (await r.json()) as { build?: string };
      if (j.build && j.build !== BUILD) {
        if (newer) return reload(); // the second time round: the worker had its chance — reload anyway
        newer = true;
        reg?.waiting?.postMessage({ type: "SKIP_WAITING" }); // a worker still waiting → take over now → controllerchange → reload
        setTimeout(() => { if (!reloading) reload(); }, 3_000);
      }
    } catch { /* offline: next time */ }
  };
  setInterval(() => void check(), 5 * MINUTE);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void check(); });
  window.addEventListener("online", () => void check());
  setTimeout(() => void check(), 20_000); // soon after the start (the first paint stays fast)
}

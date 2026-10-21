// D-149 · D-150 (owner 20/21-10): the staff app reloads itself when a new build is deployed — nobody has to clear the cache or
// reopen the app. Three moments:
//  1. at the start and after every sign-in (`freshen`): /healthz answers `{ build }` (baked into the image at docker build); when
//     it differs from the build this bundle was made with, every service-worker cache is dropped, the worker unregistered and the
//     page reloaded — once per build (a marker in sessionStorage stops any loop);
//  2. every 5 minutes, when the app comes back to the front and when the network returns: the worker is asked to update
//     (vite-plugin-pwa autoUpdate — a new worker takes over at once → `controllerchange` → one reload) and the build id is
//     compared again;
//  3. a reload never interrupts typing: while a field has the focus it waits.
// No extra dependency (no workbox-window): the plugin's own inline script registers the worker; this module only talks to it.
const MINUTE = 60_000;
const BUILD = (import.meta.env.VITE_BUILD as string | undefined) ?? "dev";
const MARK = "hangkh.fresh-for";
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
async function serverBuild(): Promise<string | null> {
  try {
    const r = await fetch(`/healthz?b=${Date.now()}`, { cache: "no-store" });
    return ((await r.json()) as { build?: string }).build ?? null;
  } catch { return null; } // offline: nothing to do
}

/** the server runs a newer build than this page → drop every cache, unregister the worker, reload (once per build). Returns true when a reload was started. */
export async function freshen(force = false): Promise<boolean> {
  if (BUILD === "dev") return false;
  const build = await serverBuild();
  if (!build || build === BUILD) return false;
  let marked = "";
  try { marked = sessionStorage.getItem(MARK) ?? ""; } catch { /* private mode */ }
  if (marked === build && !force) return false; // already reloaded for this build and still old → the server will catch up; no loop
  try { sessionStorage.setItem(MARK, build); } catch { /* ignore */ }
  try { if ("caches" in window) for (const k of await caches.keys()) await caches.delete(k); } catch { /* ignore */ }
  try { if ("serviceWorker" in navigator) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch { /* ignore */ }
  reloading = true; // after a sign-in nothing is being typed — go now
  window.location.reload();
  return true;
}

export function startAutoUpdate(): void {
  if (!("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  sw.addEventListener("controllerchange", () => { if (sw.controller) reload(); });
  const check = async () => {
    const reg = await sw.getRegistration().catch(() => undefined);
    try { await reg?.update(); } catch { /* offline */ }
    if (BUILD === "dev") return;
    const build = await serverBuild();
    if (build && build !== BUILD) {
      reg?.waiting?.postMessage({ type: "SKIP_WAITING" }); // a worker still waiting → take over now → controllerchange → reload
      setTimeout(() => { if (!reloading) void freshen(); }, 3_000); // the worker stayed quiet → the hard way
    }
  };
  void freshen(); // at the start: a stale shell is replaced before anyone works on it
  setInterval(() => void check(), 5 * MINUTE);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void check(); });
  window.addEventListener("online", () => void check());
}

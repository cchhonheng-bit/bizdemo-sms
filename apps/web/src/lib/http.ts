// Minimal JSON client for our own API (same origin, session cookie). Errors carry the API code (e.g. "FORBIDDEN").
export class ApiError extends Error {
  constructor(public code: string, public status: number, public details?: unknown) {
    super(code);
  }
}

export async function http<T = unknown>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("NETWORK", 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const e = (json ?? {}) as { error?: string; details?: unknown };
    // D-136: the test password ended while this session was open → auth.ts reloads «me» and the guard opens the new-password screen
    if (e.error === "PASSWORD_CHANGE_REQUIRED" && typeof window !== "undefined") window.dispatchEvent(new Event("sms:password-change"));
    throw new ApiError(e.error ?? (res.status === 401 ? "UNAUTHENTICATED" : "ERROR"), res.status, e.details);
  }
  return json as T;
}

export const get = <T,>(url: string) => http<T>("GET", url);
export const post = <T,>(url: string, body?: unknown) => http<T>("POST", url, body ?? {});
export const patch = <T,>(url: string, body?: unknown) => http<T>("PATCH", url, body ?? {});
export const put = <T,>(url: string, body?: unknown) => http<T>("PUT", url, body ?? {});
export const del = <T,>(url: string) => http<T>("DELETE", url);

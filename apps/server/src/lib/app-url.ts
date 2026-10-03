// The staff app lives under /app (D-96): "/" is the public website of the shop. Every link a bot message carries into the
// app goes through here; in-app notification links stay router paths ("/requests") — the web router has the same base.
import { config } from "../config.js";

export const APP_BASE = "/app";
export const appUrl = (path: string): string => `${config.publicUrl}${APP_BASE}${path}`;

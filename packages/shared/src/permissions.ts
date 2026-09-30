// Mirror of app.permission_keys() / app.default_permissions() in 0001_foundation.sql.
// Keep in sync: the SQL seed is the source of truth at runtime; this file drives UI guards.
export const ROLES = ["ceo", "cfo", "gm", "admin", "tech"] as const;
/** Tenant roles (what a CEO can assign) */
export type Role = (typeof ROLES)[number];
/** Any profile role incl. the platform operator, which has no tenant permissions (S-15) */
export type AnyRole = Role | "platform_admin";

export const PERMISSION_KEYS = [
  "booking.create", "booking.assign", "quote.manage", "job.checkpoint", "job.review",
  "invoice.issue", "payment.record", "discount.give", "discount.approve",
  "void.request", "void.approve", "cancel.request", "cancel.approve",
  "leave.approve.tech", "leave.approve.admin", "leave.approve.gm",
  "report.ops", "report.finance", "report.verify", "audit.read", "cost.read",
  "catalog.manage", "customer.manage", "user.manage", "settings.manage", "fx.set",
  // STEP 4 modules (feature flags inventory / accounting): stock, books, payroll
  "inventory.view", "inventory.manage", "accounting.view", "accounting.post", "accounting.close", "payroll.manage", "payroll.approve",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/** Default matrix — Requirements v1.2 §2.2 */
export const DEFAULT_PERMISSIONS: Record<Role, readonly PermissionKey[]> = {
  ceo: PERMISSION_KEYS.filter((k) => k !== "job.checkpoint"),
  cfo: ["report.ops", "report.finance", "report.verify", "audit.read", "cost.read", "fx.set", // A3: CEO + CFO set the rate
    "inventory.view", "accounting.view", "accounting.post", "accounting.close", "payroll.manage"],
  gm: [
    "booking.create", "booking.assign", "quote.manage", "job.checkpoint", "job.review",
    "discount.give", "void.request", "void.approve", "cancel.request", "cancel.approve",
    "leave.approve.tech", "report.ops", "catalog.manage", "customer.manage", "inventory.view",
  ],
  admin: [
    "booking.create", "booking.assign", "quote.manage", "invoice.issue", "payment.record",
    "void.request", "cancel.request", "report.ops", "cost.read", "catalog.manage", "customer.manage",
    "inventory.view", "inventory.manage", "accounting.view", "accounting.post", "payroll.manage", // «Admin + accounting»
  ],
  tech: ["job.checkpoint"],
};

/** Fixed rules (S-14) — cannot be changed in Settings. */
export const FIXED_DENY_TECH: readonly PermissionKey[] = ["cost.read", "report.finance", "audit.read", "user.manage", "settings.manage",
  "inventory.manage", "accounting.view", "accounting.post", "accounting.close", "payroll.manage", "payroll.approve"];
export const MUST_HAVE_ONE_ROLE: readonly PermissionKey[] = ["void.approve", "discount.approve", "cancel.approve", "accounting.close", "payroll.approve"];

export function can(perms: readonly string[] | undefined, key: PermissionKey): boolean {
  return !!perms && perms.includes(key);
}

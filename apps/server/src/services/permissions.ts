// Permission matrix per company (seeded from packages/shared, editable by the CEO; fixed rules S-14).
import { DEFAULT_PERMISSIONS, FIXED_DENY_TECH, MUST_HAVE_ONE_ROLE, PERMISSION_KEYS, ROLES, type PermissionKey, type Role } from "@sms/shared";
import type { Db } from "../db.js";
import { AppError, forbidden, notFound } from "../lib/errors.js";
import { audit } from "./audit.js";

export async function seedPermissions(db: Db, companyId: string): Promise<void> {
  const rows: { company_id: string; role: Role; permission_key: PermissionKey; allowed: boolean }[] = [];
  for (const role of ROLES) for (const key of PERMISSION_KEYS) rows.push({ company_id: companyId, role, permission_key: key, allowed: DEFAULT_PERMISSIONS[role].includes(key) });
  await db`insert into role_permissions ${db(rows)} on conflict do nothing`;
}

export async function permissionsFor(db: Db, companyId: string, role: string): Promise<PermissionKey[]> {
  const rows = await db<{ permission_key: PermissionKey }[]>`
    select permission_key from role_permissions where company_id = ${companyId} and role = ${role}::user_role and allowed order by permission_key`;
  return rows.map((r) => r.permission_key);
}

export async function matrix(db: Db, companyId: string) {
  return db<{ role: Role; permission_key: PermissionKey; allowed: boolean }[]>`
    select role, permission_key, allowed from role_permissions where company_id = ${companyId} order by role, permission_key`;
}

export async function setPermission(db: Db, companyId: string, byUser: string, role: Role, key: PermissionKey, allowed: boolean): Promise<void> {
  if (!(ROLES as readonly string[]).includes(role) || !(PERMISSION_KEYS as readonly string[]).includes(key)) throw notFound();
  await db`select 1 from role_permissions where company_id = ${companyId} and permission_key = ${key} for update`; // serialize concurrent edits
  // fixed rules (S-14)
  if (role === "ceo" && (key === "settings.manage" || key === "user.manage") && !allowed) throw new AppError("FIXED_RULE", 400, { key }); // CEO can never lock themselves out
  if (role === "tech" && FIXED_DENY_TECH.includes(key) && allowed) throw new AppError("FIXED_RULE", 400, { key });
  if (MUST_HAVE_ONE_ROLE.includes(key) && !allowed) {
    const others = await db`select 1 from role_permissions where company_id = ${companyId} and permission_key = ${key} and allowed and role <> ${role}::user_role`;
    if (others.length === 0) throw new AppError("FIXED_RULE", 400, { key });
  }
  const r = await db`update role_permissions set allowed = ${allowed} where company_id = ${companyId} and role = ${role}::user_role and permission_key = ${key}`;
  if (r.count === 0) throw notFound();
  await audit(db, { companyId, userId: byUser, action: "permission.set", table: "role_permissions", rowId: `${role}:${key}`, old: { allowed: !allowed }, new: { allowed } });
}

export function assertPerm(perms: readonly string[], key: PermissionKey): void {
  if (!perms.includes(key)) throw forbidden();
}

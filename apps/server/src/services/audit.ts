// Append-only audit log (rule 6.6, S-22). Every state change goes through here.
import type { Db } from "../db.js";

export type AuditEntry = {
  companyId: string | null; userId: string | null; action: string; table?: string; rowId?: string | null;
  old?: unknown; new?: unknown; source?: "app" | "telegram" | "system"; ip?: string | null;
};

export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db`insert into audit_log (company_id, user_id, action, source, table_name, row_id, old_data, new_data, ip)
           values (${e.companyId}, ${e.userId}, ${e.action}, ${e.source ?? "app"}, ${e.table ?? null}, ${e.rowId ?? null},
                   ${e.old === undefined ? null : db.json(e.old as never)}, ${e.new === undefined ? null : db.json(e.new as never)}, ${e.ip ?? null})`;
}

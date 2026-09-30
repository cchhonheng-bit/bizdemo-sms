// Invoice constants shared by routes, nav and pages.
import type { PermissionKey } from "@sms/shared";

/** any of these opens the invoice pages (matches assertCanView on the server) */
export const INVOICE_VIEW: readonly PermissionKey[] = ["invoice.issue", "payment.record", "discount.give", "discount.approve", "void.request", "void.approve", "report.finance"];

export const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// D-196 (client 30-10): a booking / invoice number typed by the office (their own paper serial) — unique in the company; an issued
// invoice asks why (the books keep their history). The server checks the same rule (DOC_NUMBER_RE) and answers NUMBER_TAKEN.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DOC_NUMBER_RE } from "@sms/shared";
import { errCode } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Button, Dialog, Field, Input } from "@/components/ui";

export function NumberDialog({ title, current, needReason = false, onSave, onClose }: {
  title: string; current: string; needReason?: boolean; onSave: (number: string, reason: string) => Promise<unknown>; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [n, setN] = useState(current);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = DOC_NUMBER_RE.test(n.trim());
  const ok = valid && n.trim() !== current && (!needReason || reason.trim().length >= 3);
  const save = async () => {
    setBusy(true);
    try { await onSave(n.trim(), reason.trim()); toast.success(t("numbers.saved")); onClose(); }
    catch (e) { toast.error(t(`numbers.err.${errCode(e)}`, { defaultValue: t("app.error") })); }
    setBusy(false);
  };
  return (
    <Dialog open onClose={onClose} title={title} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!ok} loading={busy} onClick={() => void save()} data-testid="number-save">{t("app.save")}</Button>
    </>}>
      <Field label={t("numbers.label")} hint={t("numbers.hint")} error={n.trim() && !valid ? t("numbers.err.BAD_NUMBER") : undefined}>
        <Input value={n} onChange={(e) => setN(e.target.value)} maxLength={30} autoFocus className="font-mono" data-testid="number-input" />
      </Field>
      {needReason && <Field label={t("numbers.reason")} required><textarea className="input h-20 py-2" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="number-reason" /></Field>}
    </Dialog>
  );
}

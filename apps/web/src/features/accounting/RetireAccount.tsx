// D-182 (owner 28-10): the CEO stops using — or deletes — an account still in use: first what it touches (balance, entries, items, map
// keys), then KEEP the amounts (balance, items and map keys move to another account of the same type) or REMOVE them (a record made by
// mistake: its stock movements and its own entries are reversed — the history stays). Everyone else gets the refusal that lists the places.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsd } from "@sms/shared";
import { api, type Account } from "@/lib/api";
import { Button, Dialog, Field, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { signedUsd, useAccName, useAcctErr } from "./acct";

export default function RetireAccount({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const accName = useAccName();
  const usage = useQuery({ queryKey: ["acct-usage", account.id], queryFn: () => api.accounting.accountUsage(account.id) });
  const accs = useQuery({ queryKey: ["acct-accounts"], queryFn: api.accounting.accounts });
  const [mode, setMode] = useState<"keep" | "remove">("keep");
  const [target, setTarget] = useState("");
  const targets = (accs.data ?? []).filter((a) => a.id !== account.id && a.is_active && !a.is_group && a.type === account.type);
  const save = useMutation({
    mutationFn: () => api.accounting.retireAccount(account.id, { mode, target_id: mode === "keep" ? target : null }),
    onSuccess: (r) => {
      toast.success(t(r.result === "deleted" ? "acct.retire.done_deleted" : "acct.retire.done_off"));
      for (const k of ["acct-accounts", "acct-mapping", "acct-journal", "stock-items", "stock-accounts", "catalog", "payables", "books"]) void qc.invalidateQueries({ queryKey: [k] });
      onDone();
    },
    onError: onErr,
  });
  const p = usage.data, blockers = p?.remove_blockers ?? [];
  const blockText = blockers.map((b) => (b.startsWith("map:") ? t(`acct.map.key.${b.slice(4)}`) : t(`acct.source.${b.slice(7)}`))).join(" · ");
  const valid = mode === "keep" ? !!target : !blockers.length;
  return (
    <Dialog open onClose={onClose} title={`${t("acct.retire.title")} · ${account.code}`} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="danger" className="flex-1 sm:flex-none" disabled={!p || !valid} loading={save.isPending} onClick={() => save.mutate()} data-testid="retire-confirm">{t("acct.retire.confirm")}</Button>
    </>}>
      {!p ? <Skeleton /> : (<>
        <p className="text-sm mb-2">{t("acct.retire.lead")}</p>
        <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-grey-bg p-3 mb-3" data-testid="retire-usage">
          <dt className="text-muted">{t("acct.retire.balance")}</dt><dd className="tabular font-semibold">{signedUsd(p.balance)}</dd>
          <dt className="text-muted">{t("acct.retire.entries")}</dt><dd className="break-words">{Object.entries(p.entries).map(([s, n]) => `${t(`acct.source.${s}`)} ${n}`).join(" · ") || "—"}</dd>
          <dt className="text-muted">{t("acct.retire.items")}</dt><dd className="break-words">{p.items.map((i) => `${i.code ?? ""} ${i.name_km} (${i.qty} · ${formatUsd(i.value)})`).join(" · ") || "—"}</dd>
          <dt className="text-muted">{t("acct.retire.mapped")}</dt><dd className="break-words">{p.mappings.map((k) => t(`acct.map.key.${k}`)).join(" · ") || "—"}</dd>
        </dl>
        <label className="flex items-start gap-2 min-h-[44px] text-sm">
          <input type="radio" className="mt-1" checked={mode === "keep"} onChange={() => setMode("keep")} data-testid="retire-keep" />
          <span><b>{t("acct.retire.keep")}</b><span className="block text-xs text-muted">{t("acct.retire.keep_hint")}</span></span>
        </label>
        {mode === "keep" && (
          <Field label={t("acct.retire.target")} required>
            <Select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="retire-target">
              <option value="">{t("acct.pick_account")}</option>
              {targets.map((a) => <option key={a.id} value={a.id}>{accName(a)}</option>)}
            </Select>
          </Field>
        )}
        <label className="flex items-start gap-2 min-h-[44px] text-sm mt-2">
          <input type="radio" className="mt-1" checked={mode === "remove"} onChange={() => setMode("remove")} disabled={!!blockers.length} data-testid="retire-remove" />
          <span><b>{t("acct.retire.remove")}</b><span className="block text-xs text-muted">{blockers.length ? t("acct.retire.remove_blocked", { what: blockText }) : t("acct.retire.remove_hint")}</span></span>
        </label>
      </>)}
    </Dialog>
  );
}

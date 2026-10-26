// D-178 (owner 26-10): the account mapping — which account each automatic posting uses (cash / banks per payment method, customers and
// staff, income inside / outside a borey, costs, supplier payables by type, the stock headers, equity). Chosen by account (id) and changed
// here by the CEO / CFO; a recode or rename in the chart shows here at once. Every other role with accounting.view reads it.
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MAP_SECTIONS } from "@sms/shared";
import { api, type AccountMapRow } from "@/lib/api";
import { Card, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { useAccName, useAcctErr } from "./acct";

export default function AccountMapping() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const accName = useAccName();
  const map = useQuery({ queryKey: ["acct-mapping"], queryFn: api.accounting.mapping });
  const accounts = useQuery({ queryKey: ["acct-accounts"], queryFn: api.accounting.accounts });
  const save = useMutation({
    mutationFn: (v: { key: string; account_id: string }) => api.accounting.setMapping(v.key, v.account_id),
    onSuccess: () => { toast.success(t("app.saved")); for (const k of ["acct-mapping", "acct-accounts", "stock-accounts"]) void qc.invalidateQueries({ queryKey: [k] }); },
    onError: onErr,
  });
  const choices = (r: AccountMapRow) => (accounts.data ?? []).filter((a) => a.is_active && !!a.is_group === !!r.group && r.types.includes(a.type));
  if (map.isLoading || accounts.isLoading) return <Card title={t("acct.map.title")}><Skeleton /></Card>;
  const rows = map.data?.keys ?? [], edit = !!map.data?.can_edit;
  return (
    <Card title={t("acct.map.title")}>
      <p className="text-xs text-muted mb-2">{t(edit ? "acct.map.hint" : "acct.map.read_only")}</p>
      <div data-testid="account-mapping">
        {MAP_SECTIONS.map((s) => (
          <div key={s} className="mb-3" data-testid={`map-section-${s}`}>
            <p className="text-sm font-bold border-b border-grey-line pb-1 mb-1">{t(`acct.map.section.${s}`)}</p>
            {rows.filter((r) => r.section === s).map((r) => (
              <div key={r.key} className="grid grid-cols-1 sm:grid-cols-[15rem_1fr] gap-1 sm:gap-3 items-center py-1">
                <label htmlFor={`map-${r.key}`} className="text-sm">{t(`acct.map.key.${r.key}`)}</label>
                {edit ? (
                  <Select id={`map-${r.key}`} value={r.account?.account_id ?? ""} disabled={save.isPending} data-testid={`map-key-${r.key}`}
                    onChange={(e) => { if (e.target.value && e.target.value !== r.account?.account_id) save.mutate({ key: r.key, account_id: e.target.value }); }}>
                    {!r.account && <option value="">—</option>}
                    {choices(r).map((a) => <option key={a.id} value={a.id}>{accName(a)}</option>)}
                  </Select>
                ) : <span className="text-sm break-words" data-testid={`map-key-${r.key}`}>{r.account ? accName(r.account) : "—"}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

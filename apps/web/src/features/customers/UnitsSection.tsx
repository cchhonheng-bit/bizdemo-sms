// A2 (flag "reminders"): the customer's units (e.g. AC units — label, brand, model, where) for reminders per unit, and the
// customer's own Telegram link (t.me/<shop bot>?start=s_<code>, 7 days) so service reminders can reach them after their consent.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Copy, Plus, Power, Send } from "lucide-react";
import { api, errCode } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Field, Input, RowAction } from "@/components/ui";
import { toast } from "@/lib/toast";

export default function UnitsSection({ customerId, telegram }: { customerId: string; telegram: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["units", customerId], queryFn: () => api.units.list(customerId) });
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ label: "", brand: "", model: "", location_note: "" });
  const [link, setLink] = useState<{ url: string; qr: string } | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["units", customerId] }); void qc.invalidateQueries({ queryKey: ["customer-history", customerId] }); };
  const onErr = (e: unknown) => toast.error(t(`reminders.err.${errCode(e)}`, { defaultValue: t("app.error") }));
  const save = useMutation({ mutationFn: (v: Parameters<typeof api.units.save>[1]) => api.units.save(customerId, v), onSuccess: () => { toast.success(t("app.saved")); setAdding(false); setF({ label: "", brand: "", model: "", location_note: "" }); refresh(); }, onError: onErr });
  const tg = useMutation({ mutationFn: () => api.customerTgLink(customerId), onSuccess: async (r) => setLink({ url: r.link, qr: await QRCode.toDataURL(r.link, { width: 360, margin: 1 }) }), onError: onErr });
  const manage = can("customer.manage");
  return (
    <section data-testid="units">
      <h3 className="text-sm font-semibold mb-1">{t("units.title")}</h3>
      {(q.data ?? []).length === 0 && !adding && <p className="text-sm text-muted">{t("units.none")}</p>}
      <ul className="divide-y divide-grey-line">
        {(q.data ?? []).map((u) => (
          <li key={u.id} className={`py-2 flex items-center gap-2 text-sm ${u.is_active ? "" : "opacity-50"}`}>
            <span className="flex-1 min-w-0 break-words"><b>{u.label}</b>{[u.brand, u.model, u.location_note].filter(Boolean).length ? <span className="text-muted"> · {[u.brand, u.model, u.location_note].filter(Boolean).join(" · ")}</span> : null}</span>
            {manage && <RowAction icon={<Power size={16} />} label={t(u.is_active ? "app.deactivate" : "app.activate")} onClick={() => save.mutate({ ...u, label: u.label, is_active: !u.is_active })} />}
          </li>
        ))}
      </ul>
      {manage && (adding ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="col-span-2"><Field label={t("units.label")} required><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder={t("units.label_ph")} autoFocus data-testid="unit-label" /></Field></div>
          <Field label={t("units.brand")}><Input value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} /></Field>
          <Field label={t("units.model")}><Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
          <div className="col-span-2"><Field label={t("units.where")}><Input value={f.location_note} onChange={(e) => setF({ ...f, location_note: e.target.value })} /></Field></div>
          <Button onClick={() => setAdding(false)}>{t("app.cancel")}</Button>
          <Button variant="primary" disabled={!f.label.trim()} loading={save.isPending} onClick={() => save.mutate({ label: f.label, brand: f.brand || null, model: f.model || null, location_note: f.location_note || null })} data-testid="unit-save">{t("app.save")}</Button>
        </div>
      ) : <Button className="mt-2" onClick={() => setAdding(true)} data-testid="unit-add"><Plus size={16} /> {t("units.add")}</Button>)}
      {manage && (
        <div className="mt-3 border-t border-grey-line pt-3">
          <div className="flex items-center gap-2 text-sm">{telegram ? <Badge tone="blue">Telegram ✓</Badge> : <span className="text-muted">{t("units.tg_none")}</span>}</div>
          <Button className="mt-2" loading={tg.isPending} onClick={() => tg.mutate()} data-testid="tg-link"><Send size={16} /> {t("units.tg_link")}</Button>
          {link && (
            <div className="mt-2 text-center">
              <img src={link.qr} alt="QR" className="w-40 h-40 mx-auto" />
              <p className="text-xs break-all">{link.url}</p>
              <Button className="mt-1" onClick={() => { void navigator.clipboard?.writeText(link.url); toast.success(t("settings.copied")); }}><Copy size={16} /> {t("units.copy")}</Button>
              <p className="text-xs text-muted mt-1">{t("units.tg_hint")}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

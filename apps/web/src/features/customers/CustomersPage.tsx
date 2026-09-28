import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { customerSchema, ZONES, type CustomerInput } from "@sms/shared";
import { MapPin, Pencil, Plus, Power } from "lucide-react";
import { api, errCode, type Customer } from "@/lib/api";
import { Badge, Button, Card, ConfirmDialog, Dialog, Empty, ErrorState, Field, Input, Select, Skeleton } from "@/components/ui";
import { LocationPicker, type LatLngValue } from "@/features/bookings/parts";
import { toast } from "@/lib/toast";

export default function CustomersPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const [toggle, setToggle] = useState<Customer | null>(null);
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const customers = useQuery({ queryKey: ["customers"], queryFn: () => api.customers() });
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (customers.data ?? []).filter((c) => (showInactive || c.is_active) && (!s || c.name.toLowerCase().includes(s) || c.phones.some((p) => p.includes(s)) || (c.address ?? "").toLowerCase().includes(s)));
  }, [customers.data, q, showInactive]);

  const act = useMutation({
    mutationFn: (c: Customer) => api.setCustomerActive(c.id, !c.is_active),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["customers"] }); toast.success(t("app.saved")); setToggle(null); },
    onError: (e) => toast.error(t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3">
        <h1>{t("customers.title")}</h1>
        <Button variant="primary" onClick={() => setEditing("new")}><Plus size={16} /> {t("customers.new")}</Button>
      </div>
      <Card>
        <div className="flex flex-wrap gap-3 items-center mb-3">
          <Input placeholder={t("app.search")} value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
          <label className="flex items-center gap-2 text-sm !mb-0 !text-ink"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> {t("customers.show_inactive")}</label>
        </div>
        {customers.isLoading ? <Skeleton /> : customers.isError ? <ErrorState text={t("app.error")} onRetry={() => void customers.refetch()} /> : filtered.length === 0 ? <Empty text={t("app.empty")} /> : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="table">
              <thead><tr><th>{t("customers.name")}</th><th>{t("customers.phones")}</th><th>{t("customers.address")}</th><th>{t("customers.zone")}</th><th>{t("customers.location")}</th><th className="text-right">{t("app.actions")}</th></tr></thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className={c.is_active ? "" : "opacity-60"}>
                    <td className="font-semibold">{c.name}{!c.is_active && <Badge tone="danger">{t("app.inactive")}</Badge>}</td>
                    <td className="tabular whitespace-nowrap">{c.phones.join(", ") || "—"}</td>
                    <td className="max-w-[320px] truncate" title={c.address ?? ""}>{c.address ?? "—"}</td>
                    <td><Badge tone={c.zone === "inside" ? "green" : "grey"}>{t(`zone.${c.zone}`)}</Badge></td>
                    <td>{c.lat != null ? <Badge tone="blue"><MapPin size={12} /> {t("customers.has_location")}</Badge> : <span className="text-muted">—</span>}</td>
                    <td className="text-right whitespace-nowrap">
                      <button className="p-1.5 rounded hover:bg-grey-bg" title={t("app.edit")} onClick={() => setEditing(c)}><Pencil size={16} /></button>
                      <button className="p-1.5 rounded hover:bg-grey-bg" title={c.is_active ? t("customers.deactivate") : t("customers.activate")} onClick={() => setToggle(c)}><Power size={16} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <CustomerDialog customer={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!toggle} onClose={() => setToggle(null)} loading={act.isPending} danger={toggle?.is_active}
        title={toggle?.is_active ? t("customers.deactivate") : t("customers.activate")} text={toggle?.name ?? ""} onConfirm={() => toggle && act.mutate(toggle)} />
    </div>
  );
}

export function CustomerDialog({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved?: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [loc, setLoc] = useState<LatLngValue>({ lat: customer?.lat ?? null, lng: customer?.lng ?? null });
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<CustomerInput>({
    resolver: zodResolver(customerSchema),
    defaultValues: customer
      ? { name: customer.name, phones: customer.phones, address: customer.address ?? "", zone: customer.zone, notes: customer.notes ?? "" }
      : { name: "", phones: [], address: "", zone: "inside", notes: "" },
  });
  const [phones, setPhones] = useState<string>(customer?.phones.join(", ") ?? "");
  const submit = handleSubmit(async (v) => {
    const list = phones.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
    if (list.some((p) => !/^0[0-9]{8,9}$/.test(p))) return toast.error(t("users.err.INVALID_PHONE"));
    try {
      const id = await api.upsertCustomer({ id: customer?.id, name: v.name, phones: list, address: v.address || null, zone: v.zone, lat: loc.lat, lng: loc.lng, notes: v.notes || null });
      void qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success(t("app.saved"));
      onSaved?.(id);
      onClose();
    } catch (e) {
      toast.error(t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") }));
    }
  });
  return (
    <Dialog open onClose={onClose} title={customer ? t("app.edit") : t("customers.new")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" onClick={() => void submit()} loading={isSubmitting}>{t("app.save")}</Button>
    </>}>
      <form onSubmit={submit} noValidate>
        <Field label={t("customers.name")} required error={errors.name && t("app.required")}><Input invalid={!!errors.name} {...register("name")} autoFocus /></Field>
        <Field label={t("customers.phones")} hint={t("customers.phones_hint")}><Input inputMode="tel" name="phones" value={phones} onChange={(e) => setPhones(e.target.value)} /></Field>
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Field label={t("customers.address")}><Input {...register("address")} /></Field>
          <Field label={t("customers.zone")}><Select {...register("zone")}>{ZONES.map((z) => <option key={z} value={z}>{t(`zone.${z}`)}</option>)}</Select></Field>
        </div>
        <Field label={t("customers.location")}><LocationPicker value={loc} onChange={setLoc} /></Field>
        <Field label={t("booking.notes")}><Input {...register("notes")} /></Field>
      </form>
    </Dialog>
  );
}

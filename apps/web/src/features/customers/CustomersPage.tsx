import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { addressComplete, customerSchema, formatKhPhone, GEO_DEFAULT, matchesSearch, normalizeKhPhone, type CustomerInput } from "@sms/shared";
import { History, Download, Home, Upload, MapPin, Pencil, Plus, Power, X } from "lucide-react";
import { api, errCode, type Customer } from "@/lib/api";
import { Badge, Button, Card, ConfirmDialog, Dialog, Empty, ErrorState, Field, Input, PhoneInput, RowAction, Skeleton } from "@/components/ui";
import { LocationPicker, type LatLngValue } from "@/features/bookings/parts";
import { toast } from "@/lib/toast";
import CustomerHistoryDialog from "./CustomerHistoryDialog";
import { AddressFields } from "./AddressFields";
import { PreviewDialog, toB64 } from "@/features/catalog/CatalogPage";
import type { CatalogPreview } from "@/lib/api";
import { EMPTY_ADDRESS, type AddressValue } from "./geo";

/** D-137: a website / Telegram customer may come without province, khan or sangkat — the staff complete it */
export function AddressBadge({ c }: { c: Pick<Customer, "address_complete"> }) {
  const { t } = useTranslation();
  return c.address_complete === false ? <Badge tone="warning" data-testid="address-incomplete">{t("customers.address_incomplete")}</Badge> : null;
}

/** D-156: the changed fields of the Excel preview in words */
const CUSTOMER_FIELD: Record<string, string> = { name: "customers.name", phones: "customers.phones", house_no: "customers.house_no", street: "customers.street", borey_name: "customers.borey", borey_zone: "customers.borey_zone",
  province_code: "customers.province", district_code: "customers.district", commune_code: "customers.commune", village_code: "customers.village", zone: "customers.zone", notes: "booking.notes", is_active: "app.active" };

export default function CustomersPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const [toggle, setToggle] = useState<Customer | null>(null);
  const [history, setHistory] = useState<Customer | null>(null);
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  // D-156: the list by Excel — «ទាញ Excel» (the same sheet is the template) → «នាំចូល Excel» → preview → apply
  const { i18n } = useTranslation();
  const lang = i18n.language === "en" ? "en" : "km";
  const [preview, setPreview] = useState<{ data: string; result: CatalogPreview } | null>(null);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    try { const data = await toB64(f); setPreview({ data, result: await api.customersPreview(data) }); }
    catch (e) { toast.error(t(`catalog.import_err.${errCode(e)}`, { defaultValue: t("app.error") })); }
  };
  const apply = useMutation({
    mutationFn: () => api.customersApply(preview!.data),
    onSuccess: (r) => { toast.success(t("catalog.applied", { new: r.counts.new, changed: r.counts.changed })); setPreview(null); void qc.invalidateQueries({ queryKey: ["customers"] }); },
    onError: (e) => toast.error(t(`catalog.import_err.${errCode(e)}`, { defaultValue: t("catalog.fix_first") })),
  });

  const customers = useQuery({ queryKey: ["customers"], queryFn: () => api.customers() });
  // D-137: Khmer or Latin keyboard — names, addresses, borey; phones in any form (Khmer digits, spaces, +855)
  const filtered = useMemo(() => (customers.data ?? []).filter((c) => (showInactive || c.is_active) && matchesSearch(q, [c.name, c.address, c.borey_name], c.phones)), [customers.data, q, showInactive]);

  const act = useMutation({
    mutationFn: (c: Customer) => api.setCustomerActive(c.id, !c.is_active),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["customers"] }); toast.success(t("app.saved")); setToggle(null); },
    onError: (e) => toast.error(t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between mb-4 gap-3">
        <h1>{t("customers.title")}</h1>
        <div className="flex flex-wrap gap-2">
          <a className="btn-secondary" href={`/api/customers/export.xlsx?lang=${lang}`} data-testid="customers-export"><Download size={16} /> {t("customers.excel_export")}</a>
          <label className="btn-secondary cursor-pointer" data-testid="customers-import"><Upload size={16} /> {t("customers.excel_import")}<input type="file" accept=".xlsx,.csv" className="sr-only" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} /></label>
          <Button onClick={() => nav("/customers/boreys")} data-testid="boreys-link"><Home size={16} /> {t("customers.boreys")}</Button>
          <Button variant="primary" onClick={() => setEditing("new")}><Plus size={16} /> {t("customers.new")}</Button>
        </div>
      </div>
      <Card>
        <div className="flex flex-wrap gap-3 items-center mb-3">
          <Input type="search" autoComplete="off" placeholder={t("app.search")} value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" name="customer_filter" />
          <label className="flex items-center gap-2 text-sm !mb-0 !text-ink min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> {t("customers.show_inactive")}</label>
        </div>
        {customers.isLoading ? <Skeleton /> : customers.isError ? <ErrorState text={t("app.error")} onRetry={() => void customers.refetch()} /> : filtered.length === 0 ? <Empty text={t("app.empty")} /> : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="table table-stack" data-testid="customer-table">
              <thead><tr><th>{t("customers.name")}</th><th>{t("customers.phones")}</th><th>{t("customers.address")}</th><th>{t("customers.zone")}</th><th>{t("customers.location")}</th><th className="text-right">{t("app.actions")}</th></tr></thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className={c.is_active ? "" : "opacity-60"} data-testid="customer-row">
                    <td className="font-semibold">{c.name}{!c.is_active && <Badge tone="danger">{t("app.inactive")}</Badge>}</td>
                    <td className="tabular whitespace-nowrap">{c.phones.map(formatKhPhone).join(", ") || "—"}</td>
                    <td className="md:max-w-[320px]"><span className="md:block md:truncate" title={c.address ?? ""}>{c.address ?? "—"}</span><AddressBadge c={c} /></td>
                    <td><Badge tone={c.zone === "inside" ? "green" : "grey"}>{t(`zone.${c.zone}`)}</Badge></td>
                    <td>{c.lat != null ? <Badge tone="blue"><MapPin size={12} /> {t("customers.has_location")}</Badge> : <span className="text-muted">—</span>}</td>
                    <td className="text-right whitespace-nowrap cell-actions">
                      <RowAction icon={<History size={16} />} label={t("customers.history")} onClick={() => setHistory(c)} data-testid="customer-history" />
                      <RowAction icon={<Pencil size={16} />} label={t("app.edit")} onClick={() => setEditing(c)} data-testid="customer-edit" />
                      <RowAction icon={<Power size={16} />} label={c.is_active ? t("app.deactivate") : t("app.activate")} onClick={() => setToggle(c)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <CustomerDialog customer={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {history && <CustomerHistoryDialog customer={history} onClose={() => setHistory(null)} />}
      {preview && <PreviewDialog preview={preview.result} loading={apply.isPending} onClose={() => setPreview(null)} onApply={() => apply.mutate()} labels={CUSTOMER_FIELD} />}
      <ConfirmDialog open={!!toggle} onClose={() => setToggle(null)} loading={act.isPending} danger={toggle?.is_active}
        title={toggle?.is_active ? t("customers.deactivate") : t("customers.activate")} text={toggle?.name ?? ""} onConfirm={() => toggle && act.mutate(toggle)} />
    </div>
  );
}


const addressOf = (c: Customer | null): AddressValue => c
  ? { in_borey: c.zone === "inside", borey_id: c.borey_id ?? "", borey_zone: c.borey_zone ?? "", house_no: c.house_no ?? "", street: c.street ?? "", province_code: c.province_code ?? "",
      district_code: c.district_code ?? "", commune_code: c.commune_code ?? "", village_code: c.village_code ?? "" }
  : { ...EMPTY_ADDRESS, province_code: GEO_DEFAULT.province, district_code: GEO_DEFAULT.district }; // D-137: Phnom Penh → Chbar Ampov

/** D-140 customer form: name · phone(s) · Google Map (GPS or a Maps link) on one side; «ក្នុងបុរី» (borey + zone), house, street,
 *  province → khan → sangkat → village and the read-only full address on the other — one column on a phone, two on a desktop */
export function CustomerDialog({ customer, onClose, onSaved, initialPhone }: { customer: Customer | null; onClose: () => void; onSaved?: (id: string) => void; initialPhone?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [loc, setLoc] = useState<LatLngValue>({ lat: customer?.lat ?? null, lng: customer?.lng ?? null });
  const [addr, setAddr] = useState<AddressValue>(() => addressOf(customer));
  const [tried, setTried] = useState(false);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<CustomerInput>({
    resolver: zodResolver(customerSchema.omit({ phones: true, zone: true })) as never,
    defaultValues: customer ? { name: customer.name, notes: customer.notes ?? "" } : { name: "", notes: "" },
  });
  const [phones, setPhones] = useState<string[]>(() => {
    const list = (customer?.phones ?? []).map(formatKhPhone);
    return list.length ? list : [initialPhone ? formatKhPhone(normalizeKhPhone(initialPhone) ?? "") : ""];
  });
  // the staff's own customers need province + khan + sangkat; a website / Telegram customer may be saved as it is (badge)
  const required = !customer || (customer.origin ?? "staff") === "staff";
  const all = useQuery({ queryKey: ["customers"], queryFn: () => api.customers() });
  const dupes = useMemo(() => {
    const list = phones.map((p) => normalizeKhPhone(p)).filter((p): p is string => !!p);
    return (all.data ?? []).filter((c) => c.id !== customer?.id && c.phones.some((p) => list.includes(normalizeKhPhone(p) ?? p)));
  }, [all.data, phones, customer?.id]);
  const submit = handleSubmit(async (v) => {
    setTried(true);
    const typed = phones.map((p) => p.trim()).filter(Boolean);
    const list = typed.map((p) => normalizeKhPhone(p));
    if (list.some((p) => !p)) return toast.error(t("booking.err.INVALID_PHONE"));
    if (required && !addressComplete(addr)) return toast.error(t("booking.err.ADDRESS_INCOMPLETE"));
    try {
      const id = await api.upsertCustomer({ id: customer?.id, name: v.name, phones: list as string[], zone: addr.in_borey ? "inside" : "outside", lat: loc.lat, lng: loc.lng, notes: v.notes || null,
        house_no: addr.house_no || null, street: addr.street || null, borey_id: addr.in_borey ? addr.borey_id || null : null, borey_zone: addr.in_borey ? addr.borey_zone || null : null,
        province_code: addr.province_code || null, district_code: addr.district_code || null, commune_code: addr.commune_code || null, village_code: addr.village_code || null });
      void qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success(t("app.saved"));
      onSaved?.(id);
      onClose();
    } catch (e) {
      toast.error(t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") }));
    }
  }, () => setTried(true));
  const old = customer && !customer.address_complete && customer.address ? customer.address : null;
  return (
    <Dialog open wide onClose={onClose} title={customer ? t("app.edit") : t("customers.new")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" onClick={() => void submit()} loading={isSubmitting} data-testid="customer-save">{t("app.save")}</Button>
    </>}>
      <form onSubmit={submit} noValidate className="grid md:grid-cols-2 md:gap-x-6">
        <div>
          <Field label={t("customers.name")} required error={errors.name && t("app.required")}><Input invalid={!!errors.name} {...register("name")} autoFocus /></Field>
          <Field label={t("customers.phones")}>
            <div className="space-y-2">
              {phones.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <PhoneInput name={i === 0 ? "phones" : `phone_${i}`} value={p} onChange={(e) => setPhones((x) => x.map((y, j) => (j === i ? e.target.value : y)))} />
                  {phones.length > 1 && <Button type="button" aria-label={t("customers.phone_remove")} onClick={() => setPhones((x) => x.filter((_, j) => j !== i))}><X size={16} /></Button>}
                </div>
              ))}
              {phones.length < 3 && <button type="button" className="text-sm text-blue underline min-h-[44px]" onClick={() => setPhones((x) => [...x, ""])}>+ {t("customers.phone_add")}</button>}
            </div>
          </Field>
          {dupes.length > 0 && <p className="text-sm text-warning -mt-2 mb-3" data-testid="phone-dupe">⚠ {t("customers.phone_used", { names: dupes.map((c) => c.name).join(", ") })}</p>}
          <Field label={t("customers.map")} hint={t("customers.map_hint")}><LocationPicker value={loc} onChange={setLoc} /></Field>
          <Field label={t("booking.notes")}><Input {...register("notes")} /></Field>
        </div>
        <div>
          {old && <p className="text-sm rounded-md bg-warning-50 text-warning p-3 mb-3" data-testid="address-written">{t("customers.address_old")}: {old}</p>}
          <AddressFields value={addr} onChange={setAddr} required={required} showErrors={tried} />
        </div>
      </form>
    </Dialog>
  );
}

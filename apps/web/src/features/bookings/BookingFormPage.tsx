import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { bookingSchema, EDITABLE_STATUSES, SERVICE_CATEGORIES, ZONES, type BookingInput } from "@sms/shared";
import { Plus, Search } from "lucide-react";
import { api, errCode, fromLocalInput, toLocalInput, type Customer } from "@/lib/api";
import { Button, Card, Field, Input, Select, Skeleton } from "@/components/ui";
import { LocationPicker, type LatLngValue } from "./parts";
import { CustomerDialog } from "@/features/customers/CustomersPage";
import { toast } from "@/lib/toast";

/** W1 — Booking form (create + edit while status is editable) */
export default function BookingFormPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = Boolean(id);
  const existing = useQuery({ queryKey: ["booking", id], queryFn: () => api.booking(id!), enabled: editing });
  const customers = useQuery({ queryKey: ["customers"], queryFn: () => api.customers() });
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: api.vehicles });
  const [loc, setLoc] = useState<LatLngValue>({ lat: null, lng: null });
  const [custQ, setCustQ] = useState("");
  const [newCust, setNewCust] = useState(false);

  const { register, handleSubmit, watch, setValue, reset, formState: { errors, isSubmitting } } = useForm<BookingInput>({
    resolver: zodResolver(bookingSchema),
    defaultValues: { customer_id: "", type: "A", category: "mep", service_text: "", scheduled_at: "", address: "", zone: "inside", vehicle_id: "", notes: "" },
  });
  const customerId = watch("customer_id");

  // load existing booking into the form
  useEffect(() => {
    const b = existing.data;
    if (!b) return;
    reset({ customer_id: b.customer_id, type: b.type, category: b.category, service_text: b.service_text, scheduled_at: toLocalInput(b.scheduled_at), address: b.address ?? "", zone: b.zone, vehicle_id: b.vehicle_id ?? "", notes: b.notes ?? "" });
    setLoc({ lat: b.lat, lng: b.lng });
  }, [existing.data, reset]);

  const selected = useMemo(() => customers.data?.find((c) => c.id === customerId) ?? null, [customers.data, customerId]);
  const matches = useMemo(() => {
    const s = custQ.trim().toLowerCase();
    if (!s) return [];
    return (customers.data ?? []).filter((c) => c.is_active && (c.name.toLowerCase().includes(s) || c.phones.some((p) => p.includes(s)))).slice(0, 8);
  }, [customers.data, custQ]);

  const pick = (c: Customer) => {
    setValue("customer_id", c.id, { shouldValidate: true });
    setCustQ("");
    if (!editing) {
      setValue("address", c.address ?? "");
      setValue("zone", c.zone);
      setLoc({ lat: c.lat, lng: c.lng });
    }
  };

  const locked = editing && existing.data && !EDITABLE_STATUSES.includes(existing.data.status);

  const submit = handleSubmit(async (v) => {
    const payload = { customer_id: v.customer_id, type: v.type, category: v.category, service_text: v.service_text, scheduled_at: fromLocalInput(v.scheduled_at), address: v.address || null, lat: loc.lat, lng: loc.lng, zone: v.zone, vehicle_id: v.vehicle_id || null, notes: v.notes || null };
    try {
      if (editing) {
        await api.updateBooking(id!, { service_text: payload.service_text, category: payload.category, scheduled_at: payload.scheduled_at, address: payload.address ?? "", lat: payload.lat, lng: payload.lng, zone: payload.zone, vehicle_id: payload.vehicle_id ?? "", notes: payload.notes ?? "" });
        void qc.invalidateQueries({ queryKey: ["booking", id] }); void qc.invalidateQueries({ queryKey: ["bookings"] });
        toast.success(t("app.saved"));
        nav(`/bookings/${id}`);
      } else {
        const r = await api.createBooking(payload);
        void qc.invalidateQueries({ queryKey: ["bookings"] }); void qc.invalidateQueries({ queryKey: ["customers"] });
        toast.success(t("booking.created", { number: r.number }));
        nav(`/bookings/${r.id}`, { replace: true });
      }
    } catch (e) {
      toast.error(t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") }));
    }
  });

  if (editing && existing.isLoading) return <Skeleton />;

  return (
    <div className="max-w-3xl">
      <h1 className="mb-4">{editing ? `${t("app.edit")} ${existing.data?.number ?? ""}` : t("booking.new")}</h1>
      {locked && <p className="mb-3 text-sm text-danger">{t("booking.err.BOOKING_LOCKED")}</p>}
      <form onSubmit={submit} noValidate>
        <Card title={t("booking.customer")} className="mb-4">
          {selected ? (
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold">{selected.name}</div>
                <div className="text-sm text-muted tabular">{selected.phones.join(", ") || "—"} · {selected.address ?? "—"}</div>
              </div>
              {!editing && <Button type="button" onClick={() => setValue("customer_id", "", { shouldValidate: false })}>{t("booking.change_customer")}</Button>}
            </div>
          ) : (
            <div className="relative">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search size={16} className="absolute left-3 top-3 text-muted" />
                  <Input className="pl-9" placeholder={t("booking.customer_search")} name="customer_search" value={custQ} onChange={(e) => setCustQ(e.target.value)} autoFocus={!editing} />
                </div>
                <Button type="button" onClick={() => setNewCust(true)}><Plus size={16} /> {t("customers.new")}</Button>
              </div>
              {matches.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full card divide-y divide-grey-line max-h-64 overflow-auto" role="listbox">
                  {matches.map((c) => (
                    <li key={c.id}><button type="button" className="w-full text-left px-3 py-2 hover:bg-grey-bg" onClick={() => pick(c)}>
                      <span className="font-semibold">{c.name}</span> <span className="text-sm text-muted tabular">{c.phones[0] ?? ""}</span>
                      <div className="text-xs text-muted truncate">{c.address ?? ""}</div>
                    </button></li>
                  ))}
                </ul>
              )}
              {custQ && matches.length === 0 && !customers.isLoading && <p className="text-sm text-muted mt-2">{t("booking.customer_none")}</p>}
              {errors.customer_id && <p className="field-error">{t("booking.customer_required")}</p>}
            </div>
          )}
        </Card>

        <Card title={t("booking.job")} className="mb-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label={t("booking.type")} required hint={t("booking.type_hint")}>
              <Select {...register("type")} disabled={editing}><option value="A">{t("booking.type_A")}</option><option value="B">{t("booking.type_B")}</option></Select>
            </Field>
            <Field label={t("booking.category")} required>
              <Select {...register("category")}>{SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}</Select>
            </Field>
          </div>
          <Field label={t("booking.service_text")} required error={errors.service_text && t("app.required")}>
            <textarea className="input h-24 py-2" {...register("service_text")} />
          </Field>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label={t("booking.scheduled_at")} hint={t("booking.scheduled_hint")}><Input type="datetime-local" {...register("scheduled_at")} /></Field>
            <Field label={t("booking.vehicle")}>
              <Select {...register("vehicle_id")}><option value="">—</option>{(vehicles.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.code}{v.plate ? ` · ${v.plate}` : ""}</option>)}</Select>
            </Field>
          </div>
        </Card>

        <Card title={t("booking.location")} className="mb-4">
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <Field label={t("customers.address")}><Input {...register("address")} /></Field>
            <Field label={t("customers.zone")}><Select {...register("zone")}>{ZONES.map((z) => <option key={z} value={z}>{t(`zone.${z}`)}</option>)}</Select></Field>
          </div>
          <LocationPicker value={loc} onChange={setLoc} />
        </Card>

        <Card className="mb-4">
          <Field label={t("booking.notes")}><Input {...register("notes")} /></Field>
        </Card>

        <div className="flex gap-2 justify-end">
          <Button type="button" onClick={() => nav(-1)}>{t("app.cancel")}</Button>
          <Button type="submit" variant="primary" loading={isSubmitting} disabled={!!locked}>{editing ? t("app.save") : t("booking.create")}</Button>
        </div>
      </form>
      {newCust && <CustomerDialog customer={null} onClose={() => setNewCust(false)} onSaved={(cid) => { void customers.refetch().then((r) => { const c = r.data?.find((x) => x.id === cid); if (c) pick(c); }); }} />}
    </div>
  );
}

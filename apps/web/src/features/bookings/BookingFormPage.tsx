import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { bookingSchema, DEFAULT_DURATION_MIN, EDITABLE_STATUSES, SERVICE_CATEGORIES, ZONES, type BookingInput } from "@sms/shared";
import { Plus, Search } from "lucide-react";
import { api, errCode, type Customer } from "@/lib/api";
import { ActionBar, Button, Card, Field, Input, Select, Skeleton } from "@/components/ui";
import { LocationPicker, type LatLngValue } from "./parts";
import { CustomerDialog } from "@/features/customers/CustomersPage";
import { toast } from "@/lib/toast";
import { addMinutesLocal, isPastLocal, joinLocal, splitLocal, todayLocal } from "./time";

type FormValues = BookingInput & { date: string; start: string; end: string };

/** W1 — Booking form (create + edit while status is editable). Booking Rules v1.3: date + start + end, no past start,
 *  end defaults to start + the service's duration; the server re-checks everything (R2/R3). */
export default function BookingFormPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = Boolean(id);
  const existing = useQuery({ queryKey: ["booking", id], queryFn: () => api.booking(id!), enabled: editing });
  const customers = useQuery({ queryKey: ["customers"], queryFn: () => api.customers() });
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: api.vehicles });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const [loc, setLoc] = useState<LatLngValue>({ lat: null, lng: null });
  const [custQ, setCustQ] = useState("");
  const [newCust, setNewCust] = useState(false);
  const [endTouched, setEndTouched] = useState(false);

  const { register, handleSubmit, watch, setValue, reset, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(bookingSchema.passthrough()) as never,
    defaultValues: { customer_id: "", type: "A", category: "mep", service_text: "", service_item_id: "", scheduled_at: "", ends_at: "", address: "", zone: "inside", vehicle_id: "", notes: "", date: "", start: "", end: "" },
  });
  const customerId = watch("customer_id"), category = watch("category"), itemId = watch("service_item_id");
  const date = watch("date"), start = watch("start"), end = watch("end");

  useEffect(() => {
    const b = existing.data;
    if (!b) return;
    const s = splitLocal(b.scheduled_at), e = splitLocal(b.ends_at);
    reset({ customer_id: b.customer_id, type: b.type, category: b.category, service_text: b.service_text, service_item_id: b.service_item_id ?? "", scheduled_at: "", ends_at: "",
      address: b.address ?? "", zone: b.zone, vehicle_id: b.vehicle_id ?? "", notes: b.notes ?? "", date: s.date, start: s.time, end: e.time });
    setEndTouched(!!b.ends_at);
    setLoc({ lat: b.lat, lng: b.lng });
  }, [existing.data, reset]);

  const services = useMemo(() => (catalog.data ?? []).filter((i) => i.kind === "service" && i.is_active && i.category === category), [catalog.data, category]);
  const item = services.find((i) => i.id === itemId) ?? null;
  const duration = item?.duration_min ?? DEFAULT_DURATION_MIN;
  // end follows start + duration until the user changes it
  useEffect(() => {
    if (!endTouched && date && start) setValue("end", addMinutesLocal(date, start, duration));
  }, [date, start, duration, endTouched, setValue]);

  const selected = useMemo(() => customers.data?.find((c) => c.id === customerId) ?? null, [customers.data, customerId]);
  const matches = useMemo(() => {
    const s = custQ.trim().toLowerCase();
    if (!s) return [];
    return (customers.data ?? []).filter((c) => c.is_active && (c.name.toLowerCase().includes(s) || c.phones.some((p) => p.includes(s)))).slice(0, 8);
  }, [customers.data, custQ]);

  const pick = (c: Customer) => {
    setValue("customer_id", c.id, { shouldValidate: true });
    setCustQ("");
    if (!editing) { setValue("address", c.address ?? ""); setValue("zone", c.zone); setLoc({ lat: c.lat, lng: c.lng }); }
  };

  const locked = editing && existing.data && !EDITABLE_STATUSES.includes(existing.data.status);
  const startIso = date && start ? joinLocal(date, start) : null;
  const endIso = date && end ? joinLocal(date, end) : null;
  // D2: every booking has the agreed appointment; on edit the time is read-only (Reschedule on the booking page)
  const timeError = editing ? null : !date ? t("booking.err.DATE_REQUIRED")
    : date && !start ? t("booking.err.START_REQUIRED")
      : startIso && isPastLocal(startIso) && (!editing || startIso !== existing.data?.scheduled_at) ? t("booking.err.START_IN_PAST")
        : startIso && endIso && endIso <= startIso ? t("booking.err.END_BEFORE_START") : null;

  const submit = handleSubmit(async (v) => {
    if (timeError) return toast.error(timeError);
    const base = { category: v.category, service_text: v.service_text, service_item_id: v.service_item_id || null, scheduled_at: startIso, ends_at: startIso ? endIso : null,
      address: v.address || null, lat: loc.lat, lng: loc.lng, zone: v.zone, vehicle_id: v.vehicle_id || null, notes: v.notes || null };
    try {
      if (editing) {
        await api.updateBooking(id!, { service_text: base.service_text, category: base.category, service_item_id: base.service_item_id ?? "", address: base.address ?? "", lat: base.lat, lng: base.lng,
          zone: base.zone, vehicle_id: base.vehicle_id ?? "", notes: base.notes ?? "" });
        void qc.invalidateQueries({ queryKey: ["booking", id] }); void qc.invalidateQueries({ queryKey: ["bookings"] });
        toast.success(t("app.saved"));
        nav(`/bookings/${id}`);
      } else {
        const r = await api.createBooking({ customer_id: v.customer_id, type: v.type, ...base });
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
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold break-words">{selected.name}</div>
                <div className="text-sm text-muted tabular break-words">{selected.phones.join(", ") || "—"} · {selected.address ?? "—"}</div>
              </div>
              {!editing && <Button type="button" onClick={() => setValue("customer_id", "", { shouldValidate: false })}>{t("booking.change_customer")}</Button>}
            </div>
          ) : (
            <div className="relative">
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <Input className="pl-10" type="search" inputMode="search" placeholder={t("booking.customer_search")} name="customer_search" value={custQ} onChange={(e) => setCustQ(e.target.value)} autoFocus={!editing} />
                </div>
                <Button type="button" onClick={() => setNewCust(true)}><Plus size={16} /> {t("customers.new")}</Button>
              </div>
              {matches.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full card divide-y divide-grey-line max-h-72 overflow-auto overscroll-contain" role="listbox">
                  {matches.map((c) => (
                    <li key={c.id}><button type="button" className="w-full text-left px-3 py-3 min-h-[44px] hover:bg-grey-bg" onClick={() => pick(c)}>
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
          <div className="grid sm:grid-cols-2 gap-x-3">
            <Field label={t("booking.type")} required hint={t("booking.type_hint")}>
              <Select {...register("type")} disabled={editing}><option value="A">{t("booking.type_A")}</option><option value="B">{t("booking.type_B")}</option></Select>
            </Field>
            <Field label={t("booking.category")} required>
              <Select {...register("category")} onChange={(e) => { setValue("category", e.target.value as never); setValue("service_item_id", ""); }}>
                {SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}
              </Select>
            </Field>
          </div>
          <Field label={t("booking.service_item")} hint={t("booking.service_item_hint", { minutes: duration })}>
            <Select {...register("service_item_id")} onChange={(e) => {
              setValue("service_item_id", e.target.value); setEndTouched(false);
              const it = services.find((i) => i.id === e.target.value);
              if (it && !watch("service_text")) setValue("service_text", it.name_km);
            }}>
              <option value="">{t("booking.service_item_none")}</option>
              {services.map((i) => <option key={i.id} value={i.id}>{i.name_km} · {Math.round(i.duration_min / 6) / 10} h</option>)}
            </Select>
          </Field>
          <Field label={t("booking.service_text")} required error={errors.service_text && t("app.required")}>
            <textarea className="input h-24 py-2" {...register("service_text")} />
          </Field>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3">
            <div className="col-span-2 sm:col-span-1">
              <Field label={t("booking.date")} required={!editing} hint={editing ? t("booking.time_readonly_hint") : t("booking.scheduled_hint")}><Input type="date" min={editing ? undefined : todayLocal()} {...register("date")} disabled={editing} /></Field>
            </div>
            <Field label={t("booking.start")} required={!editing}><Input type="time" step={300} {...register("start")} disabled={editing || !date} /></Field>
            <Field label={t("booking.end")}><Input type="time" step={300} {...register("end")} disabled={editing || !date || !start} onInput={() => setEndTouched(true)} /></Field>
          </div>
          {timeError && <p className="field-error -mt-1 mb-3" role="alert">{timeError}</p>}
          <Field label={t("booking.vehicle")} hint={t("booking.vehicle_hint")}>
            <Select {...register("vehicle_id")}><option value="">—</option>{(vehicles.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.code}{v.plate ? ` · ${v.plate}` : ""}</option>)}</Select>
          </Field>
        </Card>

        <Card title={t("booking.location")} className="mb-4">
          <div className="grid sm:grid-cols-[1fr_160px] gap-x-3">
            <Field label={t("customers.address")}><Input {...register("address")} autoComplete="street-address" /></Field>
            <Field label={t("customers.zone")}><Select {...register("zone")}>{ZONES.map((z) => <option key={z} value={z}>{t(`zone.${z}`)}</option>)}</Select></Field>
          </div>
          <LocationPicker value={loc} onChange={setLoc} />
        </Card>

        <Card className="mb-4">
          <Field label={t("booking.notes")}><Input {...register("notes")} /></Field>
        </Card>

        <ActionBar>
          <Button type="button" onClick={() => nav(-1)}>{t("app.cancel")}</Button>
          <Button type="submit" variant="primary" className="flex-1 sm:flex-none" loading={isSubmitting} disabled={!!locked}>{editing ? t("app.save") : t("booking.create")}</Button>
        </ActionBar>
      </form>
      {newCust && <CustomerDialog customer={null} onClose={() => setNewCust(false)} onSaved={(cid) => { void customers.refetch().then((r) => { const c = r.data?.find((x) => x.id === cid); if (c) pick(c); }); }} />}
    </div>
  );
}

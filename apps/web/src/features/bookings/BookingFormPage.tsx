import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ASSIGNABLE_STATUSES, bookingSchema, DEFAULT_DURATION_MIN, EDITABLE_STATUSES, formatKhPhone, matchesSearch, normalizeKhPhone, SERVICE_CATEGORIES, ZONES, type BookingInput, type BookingStatus } from "@sms/shared";
import { Plus, Search, X } from "lucide-react";
import { api, errCode, type Booking, type CatalogItem, type Conflict, type Customer } from "@/lib/api";
import { ApiError } from "@/lib/http";
import { useAuth } from "@/lib/auth";
import { ActionBar, Button, Card, Field, Input, Select, Skeleton } from "@/components/ui";
import { LocationPicker, type LatLngValue } from "./parts";
import { AddressBadge, CustomerDialog } from "@/features/customers/CustomersPage";
import { toast } from "@/lib/toast";
import { useFeature } from "@/lib/config";
import { addMinutesLocal, isPastLocal, joinLocal, splitLocal, todayLocal } from "./time";
import { CrewList } from "./CrewPicker";
import { conflictText, crewOf, overridesFor, setOverride, useCrewAvailability } from "./crew";

type FormValues = BookingInput & { date: string; start: string; end: string };
type Line = { item_id: string; qty: number };
const IN_PROGRESS: BookingStatus[] = ["en_route", "on_site", "working"];
const FINISHED: BookingStatus[] = ["work_done", "pending_review", "revision", "reviewed", "invoiced", "partially_paid", "closed"];
/** D-140: who asked for a new time on the «កែ» screen — the customer or the shop (the full list stays on «ប្ដូរម៉ោង») */
const EDIT_REQUESTERS = ["customer", "creator"] as const;
const linesOf = (b: Pick<Booking, "web_lines" | "service_item_id">): Line[] =>
  b.web_lines?.length ? b.web_lines.map((l) => ({ item_id: l.id, qty: l.qty })) : b.service_item_id ? [{ item_id: b.service_item_id, qty: 1 }] : [{ item_id: "", qty: 1 }];
const sameTime = (a: string | null | undefined, b: string | null | undefined) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

/** W1 — Booking form (create) and, since D-140, the ONE «កែ» screen of a job: customer, service lines + quantity, date + start + end,
 *  place, crew + lead, vehicle, units, note. A new time asks who asked + why (reschedule rules, same save); busy technicians are
 *  greyed with their busy time. Locks: a job in progress needs a tick for a time / crew / vehicle change; a finished job takes the note
 *  only (prices: the invoice). The server re-checks everything (R2/R3) and audits each changed field. */
export default function BookingFormPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "en" ? "en" : "km";
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const editing = Boolean(id);
  const existing = useQuery({ queryKey: ["booking", id], queryFn: () => api.booking(id!), enabled: editing });
  // FR-1201: /bookings/new?warranty_of=<closed job> → free warranty job for the same customer
  const [sp] = useSearchParams();
  const warrantyOf = editing ? null : sp.get("warranty_of");
  const original = useQuery({ queryKey: ["booking", warrantyOf], queryFn: () => api.booking(warrantyOf!), enabled: !!warrantyOf });
  // A2: units of the customer (reminders per unit) + prefill from a reminder's «book» (?customer=&service=&unit=)
  const remindersOn = useFeature("reminders");
  const [unitIds, setUnitIds] = useState<string[]>(() => (sp.get("unit") ? [sp.get("unit")!] : []));
  const customers = useQuery({ queryKey: ["customers"], queryFn: () => api.customers() });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const [loc, setLoc] = useState<LatLngValue>({ lat: null, lng: null });
  const [custQ, setCustQ] = useState(() => sp.get("q") ?? ""); // from a customer request: search prefilled with its phone
  const [newCust, setNewCust] = useState(false);
  const [lines, setLines] = useState<Line[]>([{ item_id: "", qty: 1 }]);
  const [textTouched, setTextTouched] = useState(() => !!sp.get("text"));
  // D-140 edit: who asked for the new time + why, the crew, the vehicle, the «job in progress» tick
  const [who, setWho] = useState(""), [reason, setReason] = useState("");
  const [team, setTeam] = useState<string[]>([]), [lead, setLead] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [crewTouched, setCrewTouched] = useState(false);
  const [vehicle, setVehicle] = useState(""), [vehicleTouched, setVehicleTouched] = useState(false);
  const [confirmRunning, setConfirmRunning] = useState(false);

  const { register, handleSubmit, watch, setValue, reset, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(bookingSchema.passthrough()) as never,
    defaultValues: { customer_id: "", type: "A", category: "mep", service_text: sp.get("text")?.slice(0, 200) ?? "", service_item_id: "", scheduled_at: "", ends_at: "", address: "", zone: "inside", vehicle_id: "", notes: "", date: "", start: "", end: "" },
  });
  const customerId = watch("customer_id");
  const date = watch("date"), start = watch("start"), end = watch("end");

  useEffect(() => {
    const b = existing.data;
    if (!b) return;
    const s = splitLocal(b.scheduled_at), e = splitLocal(b.ends_at);
    reset({ customer_id: b.customer_id, type: b.type, category: b.category, service_text: b.service_text, service_item_id: b.service_item_id ?? "", scheduled_at: "", ends_at: "",
      address: b.address ?? "", zone: b.zone, vehicle_id: b.vehicle_id ?? "", notes: b.notes ?? "", date: s.date, start: s.time, end: e.time });
    setLoc({ lat: b.lat, lng: b.lng });
    setLines(linesOf(b));
    setTextTouched(true); // the saved text stays unless the staff change the lines and clear it
    setTeam(b.technicians?.map((x) => x.user_id) ?? []);
    setLead(b.technicians?.find((x) => x.role === "lead")?.user_id ?? "");
    setVehicle(b.vehicle_id ?? "");
  }, [existing.data, reset]);

  useEffect(() => {
    const o = original.data;
    if (!o) return;
    reset({ customer_id: o.customer_id, type: "A", category: o.category, service_text: `${t("booking.warranty_prefix")} ${o.number}: ${o.service_text}`.slice(0, 1000), service_item_id: o.service_item_id ?? "",
      scheduled_at: "", ends_at: "", address: o.address ?? "", zone: o.zone, vehicle_id: "", notes: "", date: "", start: "", end: "" });
    setLoc({ lat: o.lat, lng: o.lng });
    setLines(linesOf(o));
    setTextTouched(true);
  }, [original.data, reset, t]);

  const units = useQuery({ queryKey: ["units", customerId], queryFn: () => api.units.list(customerId), enabled: remindersOn && !!customerId });
  useEffect(() => { if (existing.data?.units) setUnitIds(existing.data.units.map((u) => u.id)); }, [existing.data]);
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (editing || warrantyOf || prefilled || !customers.data || !catalog.data) return;
    const c = customers.data.find((x) => x.id === sp.get("customer"));
    const it = catalog.data.find((x) => x.id === sp.get("service"));
    if (c) { setValue("customer_id", c.id, { shouldValidate: true }); setValue("address", c.address ?? ""); setValue("zone", c.zone); setLoc({ lat: c.lat, lng: c.lng }); }
    if (it) { setValue("category", it.category); setLines([{ item_id: it.id, qty: 1 }]); setValue("service_text", it.name_km); }
    setPrefilled(true);
  }, [editing, warrantyOf, prefilled, customers.data, catalog.data, sp, setValue]);

  // ---- service lines: every active service; the job length = the sum of the lines (one length per line, like the website) ----
  const services = useMemo(() => (catalog.data ?? []).filter((i) => i.kind === "service" && (i.is_active || lines.some((l) => l.item_id === i.id))), [catalog.data, lines]);
  const itemOf = (iid: string) => services.find((i) => i.id === iid);
  const chosen = lines.map((l) => ({ ...l, item: itemOf(l.item_id) })).filter((l): l is Line & { item: CatalogItem } => !!l.item);
  const duration = chosen.length ? chosen.reduce((s, l) => s + l.item.duration_min, 0) : DEFAULT_DURATION_MIN;
  const nameOf = (i: CatalogItem) => (lang === "en" && i.name_en ? i.name_en : i.name_km);
  const linesText = (list: typeof chosen) => list.map((l) => (l.qty > 1 ? `${l.item.name_km} ×${l.qty}` : l.item.name_km)).join(" · ");
  const setLinesAnd = (next: Line[]) => {
    setLines(next);
    const ok = next.map((l) => ({ ...l, item: itemOf(l.item_id) })).filter((l): l is Line & { item: CatalogItem } => !!l.item);
    if (ok[0] && next[0]?.item_id !== lines[0]?.item_id) setValue("category", ok[0].item.category);
    if (!textTouched && ok.length) setValue("service_text", linesText(ok), { shouldValidate: true });
  };

  // D-137 (CEO): the end stays empty until the Admin / GM writes it (the overlap check needs it); the standard length is a hint
  const suggestedEnd = date && start ? addMinutesLocal(date, start, duration) : null;
  const lengthText = duration % 60 === 0 ? t("booking.len_h", { n: duration / 60 }) : t("booking.len_min", { n: duration });

  const selected = useMemo(() => customers.data?.find((c) => c.id === customerId) ?? null, [customers.data, customerId]);
  // D-137 / D-140: Khmer or Latin keyboard — names, addresses, borey; phones in any form, from 3 digits; «Dara 485»
  const matches = useMemo(() => (!custQ.trim() ? [] : (customers.data ?? []).filter((c) => c.is_active && matchesSearch(custQ, [c.name, c.address, c.borey_name], c.phones)).slice(0, 8)), [customers.data, custQ]);

  const bk = existing.data;
  const status = bk?.status;
  const cancelled = editing && status === "cancelled";
  const noteOnly = editing && !!status && FINISHED.includes(status);
  const running = editing && !!status && IN_PROGRESS.includes(status);
  const frozen = cancelled || noteOnly;
  const customerLocked = editing && !!status && !EDITABLE_STATUSES.includes(status);
  const crewOn = editing && !frozen && can("booking.assign") && !!status && (ASSIGNABLE_STATUSES.includes(status) || running) && !(bk?.type === "B" && me?.role === "admin");

  const pick = (c: Customer) => {
    setValue("customer_id", c.id, { shouldValidate: true });
    setCustQ("");
    // a new customer brings their place (the staff may still change it); the old customer's units never follow
    if (!editing || c.id !== bk?.customer_id) { setValue("address", c.address ?? ""); setValue("zone", c.zone); setLoc({ lat: c.lat, lng: c.lng }); }
    if (editing && c.id !== bk?.customer_id) setUnitIds([]);
  };

  const startIso = date && start ? joinLocal(date, start) : null;
  const endIso = date && end ? joinLocal(date, end) : null;
  const timeChanged = editing && !!bk && (!sameTime(startIso, bk.scheduled_at) || !sameTime(endIso, bk.ends_at));
  const startChanged = !editing || !sameTime(startIso, bk?.scheduled_at);
  // D2: every booking has the agreed appointment; on the «កែ» screen a new time follows the reschedule rules (who + why)
  const timeError = editing && !timeChanged ? null : !date ? t("booking.err.DATE_REQUIRED")
    : !start ? t("booking.err.START_REQUIRED")
      : startIso && startChanged && isPastLocal(startIso) ? t("booking.err.START_IN_PAST")
        : !end ? t("booking.err.END_REQUIRED")
          : startIso && endIso && endIso <= startIso ? t("booking.err.END_BEFORE_START") : null;

  // the crew for the (new) window — busy people greyed with their time; a job under way is checked for its real window
  const { ok: windowOk, q: avail, people, free, vehicles } = useCrewAvailability(crewOn ? startIso : null, crewOn ? endIso : null, id, running);
  const { crew, lead: leadOk } = crewOf(free, team, lead, overrides);
  const freeVehicles = vehicles.filter((v) => v.available); // the job itself is left out of the check, so its own vehicle stays free
  const crewChanged = crewOn && crewTouched;
  const needsTick = running && (timeChanged || crewChanged || (vehicleTouched && vehicle !== (bk?.vehicle_id ?? "")));

  const submit = handleSubmit(async (v) => {
    if (timeError) return toast.error(timeError);
    const picked = lines.filter((l) => !!itemOf(l.item_id)).map((l) => ({ item_id: l.item_id, qty: Math.min(99, Math.max(1, Math.round(l.qty) || 1)) }));
    try {
      if (editing) {
        if (timeChanged && !who) return toast.error(t("booking.err.REQUESTER_REQUIRED"));
        if (timeChanged && reason.trim().length < 3) return toast.error(t("booking.err.REASON_REQUIRED"));
        if (needsTick && !confirmRunning) return toast.error(t("booking.err.IN_PROGRESS_CONFIRM"));
        const body: Record<string, unknown> = noteOnly ? { notes: v.notes || null } : {
          ...(v.customer_id !== bk!.customer_id ? { customer_id: v.customer_id } : {}),
          category: v.category, service_text: v.service_text, ...(picked.length ? { lines: picked } : {}),
          ...(timeChanged ? { scheduled_at: startIso, ends_at: endIso, requested_by: who, reason: reason.trim() } : {}),
          address: v.address || null, lat: loc.lat, lng: loc.lng, zone: v.zone, notes: v.notes || null,
          ...(remindersOn ? { unit_ids: unitIds } : {}),
          ...(crewOn && (crewTouched || Object.keys(overrides).length) ? { team: { lead: leadOk || null, assistants: crew.filter((u) => u !== leadOk), overrides: overridesFor(crew, overrides) } } : {}),
          ...(crewOn && vehicleTouched ? { vehicle_id: vehicle || null } : {}),
          ...(needsTick ? { confirm_in_progress: true } : {}),
        };
        const r = await api.editBooking(id!, body);
        for (const k of [["booking", id], ["bookings"], ["booking-resched", id], ["booking-log", id]]) void qc.invalidateQueries({ queryKey: k });
        api.flushTelegram();
        toast.success(r.rescheduled ? t("booking.rescheduled_ok") : t("app.saved"));
        nav(`/bookings/${id}`);
      } else {
        // D-137: the vehicle is chosen with the crew (assign / confirm), not here
        const r = await api.createBooking({ customer_id: v.customer_id, type: v.type, category: v.category, service_text: v.service_text, service_item_id: picked[0]?.item_id ?? null,
          scheduled_at: startIso, ends_at: startIso ? endIso : null, address: v.address || null, lat: loc.lat, lng: loc.lng, zone: v.zone, notes: v.notes || null,
          warranty_of: warrantyOf, ...(picked.length ? { lines: picked } : {}), ...(remindersOn && unitIds.length ? { unit_ids: unitIds } : {}) });
        void qc.invalidateQueries({ queryKey: ["bookings"] }); void qc.invalidateQueries({ queryKey: ["customers"] });
        toast.success(t("booking.created", { number: r.number }));
        nav(`/bookings/${r.id}`, { replace: true });
      }
    } catch (e) {
      const d = e instanceof ApiError ? (e.details as { conflicts?: Conflict[] } | undefined) : undefined;
      toast.error(`${t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") })}${d?.conflicts?.length ? ` — ${conflictText(d.conflicts)}` : ""}`);
      if (crewOn) void avail.refetch();
    }
  });

  if (editing && existing.isLoading) return <Skeleton />;

  return (
    <div className="max-w-3xl">
      <h1 className="mb-4">{editing ? `${t("app.edit")} ${bk?.number ?? ""}` : warrantyOf ? t("booking.new_warranty") : t("booking.new")}</h1>
      {original.data && <p className="mb-3 text-sm rounded-md bg-success-50 text-success p-3" data-testid="warranty-banner">🛡 {t("booking.warranty_for", { number: original.data.number, days: original.data.warranty?.days_left ?? 0 })}</p>}
      {cancelled && <p className="mb-3 text-sm rounded-md bg-danger-50 text-danger p-3" data-testid="edit-lock">{t("booking.edit_cancelled")}</p>}
      {noteOnly && <p className="mb-3 text-sm rounded-md bg-warning-50 text-warning p-3" data-testid="edit-lock">{t("booking.edit_note_only")}</p>}
      {running && <p className="mb-3 text-sm rounded-md bg-blue-50 text-blue p-3" data-testid="edit-running">{t("booking.edit_running")}</p>}
      <form onSubmit={submit} noValidate>
        <fieldset disabled={frozen} className="contents">
          <Card title={t("booking.customer")} className="mb-4">
            {selected ? (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold break-words" data-testid="customer-picked">{selected.name}</div>
                  <div className="text-sm text-muted tabular break-words">{selected.phones.map(formatKhPhone).join(", ") || "—"} · {selected.address ?? "—"} <AddressBadge c={selected} /></div>
                </div>
                {!customerLocked && <Button type="button" onClick={() => setValue("customer_id", "", { shouldValidate: false })} data-testid="change-customer">{t("booking.change_customer")}</Button>}
              </div>
            ) : (
              <div className="relative">
                <div className="flex flex-col sm:flex-row gap-2">
                  <div className="relative flex-1">
                    <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                    <Input className="pl-10" type="search" inputMode="search" placeholder={t("booking.customer_search")} name="customer_search" autoComplete="off" value={custQ} onChange={(e) => setCustQ(e.target.value)} autoFocus />
                  </div>
                  <Button type="button" onClick={() => setNewCust(true)}><Plus size={16} /> {t("customers.new")}</Button>
                </div>
                {matches.length > 0 && (
                  <ul className="absolute z-10 mt-1 w-full card divide-y divide-grey-line max-h-72 overflow-auto overscroll-contain" role="listbox">
                    {matches.map((c) => (
                      <li key={c.id}><button type="button" className="w-full text-left px-3 py-3 min-h-[44px] hover:bg-grey-bg" onClick={() => pick(c)}>
                        <span className="font-semibold">{c.name}</span> <span className="text-sm text-muted tabular">{formatKhPhone(c.phones[0])}</span>
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
                <Select {...register("category")}>{SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}</Select>
              </Field>
            </div>
            <Field label={t("booking.lines")} hint={chosen.length ? t("booking.lines_hint", { len: lengthText }) : t("booking.lines_none_hint")}>
              <div className="space-y-2" data-testid="lines">
                {lines.map((l, i) => (
                  <div key={i} className="flex gap-2" data-testid="line">
                    <Select name={`line_item_${i}`} className="flex-1 min-w-0" value={l.item_id} onChange={(e) => setLinesAnd(lines.map((x, j) => (j === i ? { ...x, item_id: e.target.value } : x)))}>
                      <option value="">{t("booking.line_pick")}</option>
                      {services.map((s) => <option key={s.id} value={s.id}>{nameOf(s)} · {s.duration_min % 60 === 0 ? t("booking.len_h", { n: s.duration_min / 60 }) : t("booking.len_min", { n: s.duration_min })}</option>)}
                    </Select>
                    <Input type="number" inputMode="numeric" min={1} max={99} className="w-20 tabular" name={`line_qty_${i}`} aria-label={t("booking.line_qty")} value={l.qty}
                      onChange={(e) => setLinesAnd(lines.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) || 1 } : x)))} />
                    {lines.length > 1 && <Button type="button" aria-label={t("booking.line_remove")} onClick={() => setLinesAnd(lines.filter((_, j) => j !== i))}><X size={16} /></Button>}
                  </div>
                ))}
                {lines.length < 20 && <button type="button" className="text-sm text-blue underline min-h-[44px]" onClick={() => setLines([...lines, { item_id: "", qty: 1 }])} data-testid="line-add">+ {t("booking.line_add")}</button>}
              </div>
            </Field>
            {remindersOn && (units.data ?? []).some((u) => u.is_active) && (
              <Field label={t("units.for_job")}>
                <div className="flex flex-wrap gap-2" data-testid="unit-picks">
                  {(units.data ?? []).filter((u) => u.is_active).map((u) => {
                    const on = unitIds.includes(u.id);
                    return <button key={u.id} type="button" aria-pressed={on} onClick={() => setUnitIds((x) => (on ? x.filter((y) => y !== u.id) : [...x, u.id]))}
                      className={`px-3 min-h-[44px] rounded-md border text-sm ${on ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{on ? "✓ " : ""}{u.label}</button>;
                  })}
                </div>
              </Field>
            )}
            <Field label={t("booking.service_text")} required error={errors.service_text && t("app.required")}>
              <textarea className="input h-24 py-2" {...register("service_text", { onChange: () => setTextTouched(true) })} />
            </Field>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3">
              <div className="col-span-2 sm:col-span-1">
                <Field label={t("booking.date")} required hint={editing ? t("booking.time_edit_hint") : t("booking.scheduled_hint")}><Input type="date" min={editing ? undefined : todayLocal()} {...register("date")} /></Field>
              </div>
              <Field label={t("booking.start")} required><Input type="time" step={300} {...register("start")} disabled={!date} /></Field>
              <Field label={t("booking.end")} required><Input type="time" step={300} {...register("end")} disabled={!date || !start} /></Field>
            </div>
            {suggestedEnd && (!editing || timeChanged) && (
              <p className="text-sm text-muted -mt-1 mb-3 flex flex-wrap items-center gap-x-2" data-testid="end-hint">
                <span>{t("booking.end_hint", { len: lengthText, time: suggestedEnd })}</span>
                {end !== suggestedEnd && <button type="button" className="text-blue underline min-h-[44px]" onClick={() => setValue("end", suggestedEnd, { shouldValidate: true })} data-testid="end-use">{t("booking.end_use")}</button>}
              </p>
            )}
            {timeError && <p className="field-error -mt-1 mb-3" role="alert">{timeError}</p>}
            {timeChanged && (
              <div className="rounded-md border border-grey-line p-3 mb-3" data-testid="resched-box">
                <p className="text-sm mb-2">{t("booking.edit_time_changed")}</p>
                <Field label={t("booking.requested_by")} required>
                  <div className="grid grid-cols-2 gap-2" role="radiogroup">
                    {EDIT_REQUESTERS.map((r) => (
                      <button key={r} type="button" role="radio" aria-checked={who === r} onClick={() => setWho(r)} data-testid={`who-${r}`}
                        className={`min-h-[48px] rounded-md border px-3 text-sm text-left ${who === r ? "border-navy bg-[#E6EDFD] font-bold text-navy" : "border-grey-line bg-white"}`}>
                        {r === "creator" ? t("booking.requester_shop") : t(`booking.requester.${r}`)}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label={t("booking.reschedule_reason")} required hint={t("booking.edit_notify_hint")}>
                  <Input name="resched_reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              </div>
            )}
            {!editing && <p className="text-xs text-muted mb-1">{t("booking.vehicle_in_assign")}</p>}
          </Card>

          {crewOn && (
            <Card title={t("booking.crew_and_vehicle")} className="mb-4">
              <Field label={t("booking.crew")} hint={t("booking.crew_hint")}>
                {!windowOk ? <p className="text-sm text-muted">{timeError ?? t("booking.reschedule_first")}</p>
                  : <CrewList people={people} loading={avail.isLoading} team={crew} lead={leadOk} onTeam={(x) => { setTeam(x); setCrewTouched(true); }} onLead={(x) => { setLead(x); setCrewTouched(true); }}
                      overrides={overrides} onOverride={(uid, r) => { setOverrides((o) => setOverride(o, uid, r)); setCrewTouched(true); }} />}
              </Field>
              <Field label={t("booking.vehicle")} hint={windowOk && avail.data && freeVehicles.length < avail.data.vehicles.length ? t("booking.vehicles_busy_hidden") : undefined}>
                <Select name="vehicle" value={vehicle} onChange={(e) => { setVehicle(e.target.value); setVehicleTouched(true); }} disabled={!windowOk}>
                  <option value="">—</option>
                  {freeVehicles.map((x) => <option key={x.id} value={x.id}>{x.code}{x.plate ? ` · ${x.plate}` : ""}</option>)}
                </Select>
              </Field>
            </Card>
          )}

          <Card title={t("booking.location")} className="mb-4">
            <p className="text-xs text-muted mb-2">{t("booking.location_from_customer")}</p>
            <div className="grid sm:grid-cols-[1fr_160px] gap-x-3">
              <Field label={t("customers.address")}><Input {...register("address")} autoComplete="off" /></Field>
              <Field label={t("customers.zone")}><Select {...register("zone")}>{ZONES.map((z) => <option key={z} value={z}>{t(`zone.${z}`)}</option>)}</Select></Field>
            </div>
            <LocationPicker value={loc} onChange={setLoc} />
          </Card>
        </fieldset>

        <Card className="mb-4">
          <Field label={t("booking.notes")}><Input {...register("notes")} disabled={cancelled} /></Field>
        </Card>

        {needsTick && (
          <label className="flex items-start gap-3 mb-4 rounded-md bg-warning-50 p-3 text-sm !text-ink cursor-pointer">
            <input type="checkbox" className="h-6 w-6 shrink-0 accent-navy" name="confirm_running" checked={confirmRunning} onChange={(e) => setConfirmRunning(e.target.checked)} />
            <span>{t("booking.edit_running_confirm")}</span>
          </label>
        )}

        <ActionBar>
          <Button type="button" onClick={() => nav(-1)}>{t("app.cancel")}</Button>
          <Button type="submit" variant="primary" className="flex-1 sm:flex-none" loading={isSubmitting} disabled={cancelled || (needsTick && !confirmRunning)} data-testid="booking-save">{editing ? t("app.save") : t("booking.create")}</Button>
        </ActionBar>
      </form>
      {newCust && <CustomerDialog customer={null} initialPhone={normalizeKhPhone(custQ) ? custQ : undefined} onClose={() => setNewCust(false)} onSaved={(cid) => { void customers.refetch().then((r) => { const c = r.data?.find((x) => x.id === cid); if (c) pick(c); }); }} />}
    </div>
  );
}

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ListFilters, useListState } from "@/components/ListFilters";
import { ReportToolbar } from "@/components/ReportToolbar";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { type CreateUserInput, createUserSchema, filterList, formatKhPhone, formatUsd, LIST_SPECS, PAY_METHOD_KEYS, ROLES, toCents, type PayMethodKey, type SalaryInput } from "@sms/shared";
import { Copy, KeyRound, Pencil, Plus, UserX, UserCheck } from "lucide-react";
import { api, errCode } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, ConfirmDialog, Dialog, Empty, ErrorState, Field, Input, PasswordInput, PhoneInput, RowAction, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { useFeature } from "@/lib/config";

type Profile = { id: string; username: string; phone: string | null; email: string | null; full_name: string; role: string; is_active: boolean; telegram_linked: boolean; tracks_attendance: boolean; is_lead: boolean; is_platform: boolean; language: string };

export default function UsersPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { me } = useAuth();
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "deactivate" | "activate" | "reset"; u: Profile } | null>(null);
  const [temp, setTemp] = useState<{ username: string; password: string } | null>(null);
  const [q, setQ] = useState("");

  const users = useQuery({
    queryKey: ["profiles"],
    queryFn: async () => (await api.users()) as Profile[],
  });

  const ls = useListState();
  const filters = { ...ls.params, ...(q.trim() ? { q: q.trim() } : {}) };
  const filtered = useMemo(() => filterList(users.data ?? [], LIST_SPECS.users, filters), [users.data, q, ls.params]); // eslint-disable-line react-hooks/exhaustive-deps

  const errText = (code: string) => t(`users.err.${code}`, { defaultValue: t("app.error") });

  const act = useMutation({
    mutationFn: async (v: { action: string; id: string; is_active?: boolean }) => {
      if (v.action === "reset_password") return api.resetPassword(v.id);
      await api.updateUser(v.id, { is_active: v.is_active });
      return {} as { temp_password?: string };
    },
    onSuccess: (data, v) => {
      void qc.invalidateQueries({ queryKey: ["profiles"] });
      if (v.action === "reset_password" && data?.temp_password) setTemp({ username: confirm?.u.username ?? "", password: data.temp_password });
      else toast.success(t("app.saved"));
      setConfirm(null);
    },
    onError: (e: Error) => toast.error(errText(errCode(e))),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3">
        <h1>{t("users.title")}</h1>
        <Button variant="primary" onClick={() => setEditing("new")}><Plus size={16} /> {t("users.new")}</Button>
      </div>
      <ReportToolbar report="users" params={filters} active={ls.active}><ListFilters s={ls} search={false} roles={ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) }))} /></ReportToolbar>
      <Card>
        <Input type="search" autoComplete="off" placeholder={t("app.search")} value={q} onChange={(e) => setQ(e.target.value)} className="mb-3 w-full sm:max-w-xs" />
        {users.isLoading ? <Skeleton /> : users.isError ? <ErrorState text={t("app.error")} onRetry={() => void users.refetch()} /> : filtered.length === 0 ? <Empty text={t("app.empty")} /> : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="table table-stack">
              <thead><tr><th>{t("users.full_name")}</th><th>{t("users.username")}</th><th>{t("users.role")}</th><th>{t("users.phone")}</th><th>{t("users.telegram")}</th><th>{t("users.status")}</th><th className="text-right">{t("app.actions")}</th></tr></thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} className={u.is_platform ? "bg-grey-bg" : ""} title={u.is_platform ? t("users.platform_hint") : undefined} data-testid={u.is_platform ? "user-platform" : undefined}>
                    <td className="font-semibold">{u.full_name}{u.is_platform && <span className="block text-xs font-normal text-muted">{t("users.platform_hint")}</span>}</td>
                    <td className="font-mono text-xs">{u.username}</td>
                    <td><Badge tone={u.role === "tech" ? "green" : u.role === "gm" ? "purple" : "navy"}>{t(`roles.${u.role}`)}{u.is_lead ? " ★" : ""}</Badge></td>
                    <td className="tabular">{u.phone ? formatKhPhone(u.phone) : "—"}</td>
                    <td>{u.telegram_linked ? <Badge tone="green">{t("users.linked")}</Badge> : <Badge>{t("users.not_linked")}</Badge>}</td>
                    <td>{u.is_active ? <Badge tone="green">{t("app.active")}</Badge> : <Badge tone="danger">{t("app.inactive")}</Badge>}</td>
                    <td className="text-right whitespace-nowrap cell-actions">{u.is_platform ? <span className="text-xs text-muted">{t("users.platform_locked")}</span> : <>
                      <RowAction icon={<Pencil size={16} />} label={t("app.edit")} onClick={() => setEditing(u)} />
                      <RowAction icon={<KeyRound size={16} />} label={t("users.reset_password")} onClick={() => setConfirm({ kind: "reset", u })} />
                      {u.id !== me?.id && (u.is_active
                        ? <RowAction tone="danger" icon={<UserX size={16} />} label={t("app.deactivate")} onClick={() => setConfirm({ kind: "deactivate", u })} />
                        : <RowAction tone="success" icon={<UserCheck size={16} />} label={t("app.activate")} onClick={() => setConfirm({ kind: "activate", u })} />)}
                    </>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && <UserDialog user={editing === "new" ? null : editing} onClose={() => setEditing(null)} onCreated={(username, password) => { setEditing(null); if (password) setTemp({ username, password }); }} />}

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} loading={act.isPending}
        title={confirm?.kind === "reset" ? t("users.reset_password") : confirm?.kind === "deactivate" ? t("users.deactivate") : t("users.activate")}
        text={confirm?.kind === "reset" ? t("users.confirm_reset") : confirm?.kind === "deactivate" ? t("users.confirm_deactivate") : `${confirm?.u.full_name}`}
        danger={confirm?.kind === "deactivate"}
        onConfirm={() => confirm && act.mutate(confirm.kind === "reset" ? { action: "reset_password", id: confirm.u.id } : { action: "set_active", id: confirm.u.id, is_active: confirm.kind === "activate" })} />

      <Dialog open={!!temp} onClose={() => setTemp(null)} title={t("users.temp_password")} footer={<Button variant="primary" onClick={() => setTemp(null)}>{t("app.close")}</Button>}>
        <p className="text-sm text-muted mb-3">{t("users.temp_hint")}</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-grey-bg rounded px-3 py-2 font-mono text-lg tracking-wider">{temp?.password}</code>
          <Button onClick={() => { void navigator.clipboard?.writeText(temp?.password ?? ""); toast.success(t("users.copied")); }}><Copy size={16} /> {t("users.copy")}</Button>
        </div>
        <p className="text-xs text-muted mt-2">{t("users.username")}: <b>{temp?.username}</b></p>
      </Dialog>
    </div>
  );
}

function UserDialog({ user, onClose, onCreated }: { user: Profile | null; onClose: () => void; onCreated: (username: string, tempPassword?: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [tracks, setTracks] = useState(user?.tracks_attendance ?? true);
  const [lead, setLead] = useState(user?.is_lead ?? false); // lead technician (D-91)
  const { register, handleSubmit, watch, formState: { errors, isSubmitting }, setError } = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: user ? { username: user.username, full_name: user.full_name, role: user.role as CreateUserInput["role"], phone: user.phone ? formatKhPhone(user.phone) : "", email: user.email ?? "" } : { role: "tech", phone: "", email: "" },
  });
  const errText = (code?: string) => (code ? t(`users.err.${code}`, { defaultValue: code }) : undefined);
  const isTech = watch("role") === "tech";
  // D-187: «ប្រាក់ខែ» — only the CEO / CFO / GM / payroll see it; sent only when touched
  const { me, can } = useAuth();
  const salaryOn = useFeature("accounting") && !!me && me.role !== "tech" && (["ceo", "cfo", "gm"].includes(me.role) || can("payroll.manage") || can("payroll.approve"));
  const [salary, setSalary] = useState<SalaryInput | null | "bad">(null);

  const submit = handleSubmit(async (v) => {
    if (user) {
      try {
        if (salary === "bad") { toast.error(t("users.salary.bad")); return; }
        await api.updateUser(user.id, { full_name: v.full_name, username: v.username, phone: v.phone ?? "", email: v.email ?? "", role: v.role, tracks_attendance: tracks, is_lead: v.role === "tech" && lead,
          ...(salary ? { salary } : {}) });
        void qc.invalidateQueries({ queryKey: ["user-salary", user.id] }); void qc.invalidateQueries({ queryKey: ["payroll-salaries"] });
      } catch (e) { toast.error(errText(errCode(e)) ?? t("app.error")); return; }
      toast.success(t("app.saved"));
      void qc.invalidateQueries({ queryKey: ["profiles"] });
      onClose();
    } else {
      let r: { id: string; temp_password?: string };
      try {
        if (salary === "bad") { toast.error(t("users.salary.bad")); return; }
        r = await api.createUser({ ...v, password: v.password || undefined, ...(salary ? { salary } : {}) });
      } catch (e) {
        const code = errCode(e);
        const field = code === "USERNAME_TAKEN" || code === "INVALID_USERNAME" ? "username" : code === "PHONE_TAKEN" || code === "INVALID_PHONE" ? "phone" : code === "EMAIL_TAKEN" ? "email" : code.startsWith("PASSWORD") ? "password" : null;
        if (field) setError(field, { message: code }); else toast.error(errText(code) ?? t("app.error"));
        return;
      }
      if (!tracks || (v.role === "tech" && lead)) await api.updateUser(r.id, { tracks_attendance: tracks, is_lead: v.role === "tech" && lead });
      void qc.invalidateQueries({ queryKey: ["profiles"] });
      toast.success(t("app.saved"));
      onCreated(v.username, r.temp_password);
    }
  });

  return (
    <Dialog open onClose={onClose} title={user ? t("app.edit") : t("users.new")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" onClick={() => void submit()} loading={isSubmitting}>{t("app.save")}</Button>
    </>}>
      <form onSubmit={submit} noValidate>
        <Field label={t("users.full_name")} required error={errors.full_name && t("app.required")}><Input invalid={!!errors.full_name} {...register("full_name")} autoFocus /></Field>
        <Field label={t("users.username")} required error={errText(errors.username?.message)}><Input invalid={!!errors.username} autoCapitalize="none" {...register("username")} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("users.role")} required>
            <Select {...register("role")}>{ROLES.map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}</Select>
          </Field>
          <Field label={t("users.phone")} error={errText(errors.phone?.message)}><PhoneInput invalid={!!errors.phone} {...register("phone")} /></Field>
        </div>
        <Field label={t("users.email")} error={errText(errors.email?.message)}><Input type="email" invalid={!!errors.email} {...register("email")} /></Field>
        {!user && <Field label={t("users.password_optional")} error={errText(errors.password?.message)}><PasswordInput autoComplete="off" invalid={!!errors.password} {...register("password")} /></Field>}
        <label className="flex items-center gap-2 text-sm text-ink min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={tracks} onChange={(e) => setTracks(e.target.checked)} /> {t("users.tracks_attendance")}</label>
        {isTech && <label className="flex items-center gap-2 text-sm text-ink min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={lead} onChange={(e) => setLead(e.target.checked)} /> {t("users.is_lead")}</label>}
        {salaryOn && <SalarySection userId={user?.id ?? null} onChange={setSalary} />}
      </form>
    </Dialog>
  );
}

/** D-187 (owner 29-10): the salary on the user form — base and a fixed allowance per month, the pay method (→ the account map), the start
 *  day, the day a change takes effect (earlier payroll runs keep their amounts) and the history of changes. Reports a payload only when touched. */
function SalarySection({ userId, onChange }: { userId: string | null; onChange: (v: SalaryInput | null | "bad") => void }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["user-salary", userId], queryFn: () => api.userSalary(userId!), enabled: !!userId });
  const cur = q.data?.current ?? null;
  const first = new Date().toISOString().slice(0, 8) + "01";
  const [d, setD] = useState<{ base: string; allowance: string; method: PayMethodKey; start: string; from: string; note: string } | null>(null);
  const v = d ?? { base: cur ? (cur.base_salary / 100).toFixed(2) : "", allowance: cur?.allowance ? (cur.allowance / 100).toFixed(2) : "", method: (cur?.pay_method ?? q.data?.pay_method ?? "cash_usd"),
    start: q.data?.start_date ?? "", from: cur ? first : "", note: q.data?.note ?? "" };
  const money = (x: string) => { if (!x.trim()) return 0; try { return toCents(x); } catch { return NaN; } };
  const set = (p: Partial<typeof v>) => {
    const n = { ...v, ...p }; setD(n);
    const base = money(n.base), allowance = money(n.allowance);
    if (!n.base.trim() && !n.allowance.trim()) { onChange(null); return; }
    if (!(base >= 0) || !(allowance >= 0)) { onChange("bad"); return; }
    onChange({ base_salary: base, allowance, pay_method: n.method, start_date: n.start || null, effective_from: n.from || n.start || null, note: n.note.trim() || null });
  };
  if (userId && q.isLoading) return <Skeleton />;
  return (
    <fieldset className="border-t border-grey-line pt-3 mt-2" data-testid="salary-section">
      <legend className="font-semibold text-sm">{t("users.salary.title")}</legend>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("users.salary.base")}><Input inputMode="decimal" value={v.base} onChange={(e) => set({ base: e.target.value })} placeholder="$0.00" data-testid="salary-base" /></Field>
        <Field label={t("users.salary.allowance")}><Input inputMode="decimal" value={v.allowance} onChange={(e) => set({ allowance: e.target.value })} placeholder="$0.00" data-testid="salary-allowance" /></Field>
        <Field label={t("users.salary.method")}>
          <Select value={v.method} onChange={(e) => set({ method: e.target.value as PayMethodKey })} data-testid="salary-method">{PAY_METHOD_KEYS.map((m) => <option key={m} value={m}>{t(`inventory.pay.${m}`)}</option>)}</Select>
        </Field>
        <Field label={t("users.salary.start")}><Input type="date" value={v.start} onChange={(e) => set({ start: e.target.value })} data-testid="salary-start" /></Field>
        <Field label={t("users.salary.from")} hint={t("users.salary.from_hint")}><Input type="date" value={v.from} onChange={(e) => set({ from: e.target.value })} data-testid="salary-from" /></Field>
        <Field label={t("users.salary.note")}><Input value={v.note} onChange={(e) => set({ note: e.target.value })} maxLength={300} /></Field>
      </div>
      {!!q.data?.history.length && (
        <div className="text-xs mt-1" data-testid="salary-history">
          <div className="text-muted mb-1">{t("users.salary.history")}</div>
          <ul className="divide-y divide-grey-line">
            {q.data.history.map((h) => (
              <li key={h.id} className="py-1 flex justify-between gap-2"><span className="tabular">{h.effective_from}</span>
                <span className="tabular">{formatUsd(h.base_salary)}{h.allowance ? ` + ${formatUsd(h.allowance)}` : ""} · {t(`inventory.pay.${h.pay_method}`)}</span>
                <span className="text-muted break-words">{h.changed_by_name ?? ""}</span></li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}

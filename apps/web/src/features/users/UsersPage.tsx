import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createUserSchema, ROLES, type CreateUserInput } from "@sms/shared";
import { Copy, KeyRound, Pencil, Plus, UserX, UserCheck } from "lucide-react";
import { api, errCode } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, ConfirmDialog, Dialog, Empty, ErrorState, Field, Input, RowAction, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";

type Profile = { id: string; username: string; phone: string | null; email: string | null; full_name: string; role: string; is_active: boolean; telegram_linked: boolean; tracks_attendance: boolean; is_lead: boolean; language: string };

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

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (users.data ?? []).filter((u) => !s || u.full_name.toLowerCase().includes(s) || u.username.includes(s) || (u.phone ?? "").includes(s));
  }, [users.data, q]);

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
      <Card>
        <Input placeholder={t("app.search")} value={q} onChange={(e) => setQ(e.target.value)} className="mb-3 w-full sm:max-w-xs" />
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
                    <td className="tabular">{u.phone ?? "—"}</td>
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
    defaultValues: user ? { username: user.username, full_name: user.full_name, role: user.role as CreateUserInput["role"], phone: user.phone ?? "", email: user.email ?? "" } : { role: "tech", phone: "", email: "" },
  });
  const errText = (code?: string) => (code ? t(`users.err.${code}`, { defaultValue: code }) : undefined);
  const isTech = watch("role") === "tech";

  const submit = handleSubmit(async (v) => {
    if (user) {
      try {
        await api.updateUser(user.id, { full_name: v.full_name, username: v.username, phone: v.phone ?? "", email: v.email ?? "", role: v.role, tracks_attendance: tracks, is_lead: v.role === "tech" && lead });
      } catch (e) { toast.error(errText(errCode(e)) ?? t("app.error")); return; }
      toast.success(t("app.saved"));
      void qc.invalidateQueries({ queryKey: ["profiles"] });
      onClose();
    } else {
      let r: { id: string; temp_password?: string };
      try {
        r = await api.createUser({ ...v, password: v.password || undefined });
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
          <Field label={t("users.phone")} error={errText(errors.phone?.message)}><Input inputMode="tel" invalid={!!errors.phone} {...register("phone")} /></Field>
        </div>
        <Field label={t("users.email")} error={errText(errors.email?.message)}><Input type="email" invalid={!!errors.email} {...register("email")} /></Field>
        {!user && <Field label={t("users.password_optional")} error={errText(errors.password?.message)}><Input type="text" autoComplete="off" invalid={!!errors.password} {...register("password")} /></Field>}
        <label className="flex items-center gap-2 text-sm text-ink min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={tracks} onChange={(e) => setTracks(e.target.checked)} /> {t("users.tracks_attendance")}</label>
        {isTech && <label className="flex items-center gap-2 text-sm text-ink min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={lead} onChange={(e) => setLead(e.target.checked)} /> {t("users.is_lead")}</label>}
      </form>
    </Dialog>
  );
}

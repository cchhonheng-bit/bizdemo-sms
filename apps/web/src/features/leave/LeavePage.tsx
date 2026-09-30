// Leave + absence (owner D3, FR-903): request own leave · approve/reject (BR-24 chain, server-checked) · mark someone absent.
// Approved leave/absence removes the person from the technician picker; the server rejects them too.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarOff, Check, UserX, X } from "lucide-react";
import { api, errCode, fmtDate, type LeaveRow } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ActionBar, Badge, Button, Card, Dialog, Empty, Field, Input, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { todayLocal } from "@/features/bookings/time";

const ATTENDANCE_ROLES = ["tech", "admin", "gm"];
type Affected = { id: string; number: string; scheduled_at: string }[];

export default function LeavePage() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const approver = can("leave.approve.tech") || can("leave.approve.admin") || can("leave.approve.gm");
  const requester = !!me && ATTENDANCE_ROLES.includes(me.role);
  const [affected, setAffected] = useState<Affected | null>(null);
  return (
    <div className="max-w-3xl space-y-4">
      <h1>{t("leave.title")}</h1>
      {requester && <RequestCard />}
      {requester && <MyList />}
      {approver && <ApproveList onAffected={setAffected} />}
      {approver && <AbsentCard onAffected={setAffected} />}
      {affected && (
        <Dialog open onClose={() => setAffected(null)} title={t("leave.affected_title")} footer={<Button variant="primary" onClick={() => setAffected(null)}>{t("app.close")}</Button>}>
          {affected.length === 0 ? <p className="text-sm">{t("leave.affected_none")}</p> : (
            <>
              <p className="text-sm mb-2">{t("leave.affected_text")}</p>
              <ul className="divide-y divide-grey-line">{affected.map((b) => <li key={b.id}><Link to={`/bookings/${b.id}`} className="flex min-h-[48px] items-center font-mono text-blue">{b.number} · {fmtDate(b.scheduled_at)}</Link></li>)}</ul>
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}

function PartPicker({ value, onChange, disabledHalf }: { value: string; onChange: (v: string) => void; disabledHalf: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-3 gap-2" role="radiogroup">
      {(["full", "am", "pm"] as const).map((p) => (
        <button key={p} type="button" role="radio" aria-checked={value === p} disabled={p !== "full" && disabledHalf} onClick={() => onChange(p)}
          className={`min-h-[48px] rounded-md border text-sm disabled:opacity-40 ${value === p ? "border-navy bg-[#E6EDFD] font-bold text-navy" : "border-grey-line bg-white"}`}>
          {t(`leave.part.${p}`)}
        </button>
      ))}
    </div>
  );
}

function RequestCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [from, setFrom] = useState(""), [to, setTo] = useState(""), [part, setPart] = useState("full"), [reason, setReason] = useState("");
  const multi = !!from && !!to && to !== from;
  const m = useMutation({
    mutationFn: () => api.leave.request({ date_from: from, date_to: to || from, part: multi ? "full" : part, reason: reason.trim() }),
    onSuccess: () => { toast.success(t("leave.sent")); setFrom(""); setTo(""); setPart("full"); setReason(""); void qc.invalidateQueries({ queryKey: ["leave"] }); },
    onError: (e) => toast.error(t(`leave.err.${errCode(e)}`, { defaultValue: t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") }) })),
  });
  return (
    <Card title={t("leave.request")}>
      <div className="grid grid-cols-2 gap-x-3">
        <Field label={t("leave.from")} required><Input type="date" min={todayLocal()} name="leave_from" value={from} onChange={(e) => { setFrom(e.target.value); if (!to || to < e.target.value) setTo(e.target.value); }} /></Field>
        <Field label={t("leave.to")} required><Input type="date" min={from || todayLocal()} name="leave_to" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <Field label={t("leave.part_label")}><PartPicker value={multi ? "full" : part} onChange={setPart} disabledHalf={multi} /></Field>
      <Field label={t("leave.reason")} required><textarea className="input h-20 py-2" name="leave_reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      <ActionBar><Button variant="primary" className="flex-1 sm:flex-none" loading={m.isPending} disabled={!from || reason.trim().length < 2} onClick={() => m.mutate()} data-testid="leave-submit"><CalendarOff size={16} /> {t("leave.send")}</Button></ActionBar>
    </Card>
  );
}

const TONE = { pending: "warning", approved: "green", rejected: "danger", cancelled: "grey" } as const;
function when(r: LeaveRow, t: (k: string) => string) {
  return `${fmtDate(r.date_from)}${r.date_to !== r.date_from ? ` → ${fmtDate(r.date_to)}` : ""} · ${t(`leave.part.${r.part}`)}`;
}

function MyList() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["leave", "mine"], queryFn: () => api.leave.list("mine") });
  const cancel = useMutation({ mutationFn: (id: string) => api.leave.cancel(id), onSuccess: () => void qc.invalidateQueries({ queryKey: ["leave"] }), onError: (e) => toast.error(t(`leave.err.${errCode(e)}`, { defaultValue: t("app.error") })) });
  return (
    <Card title={t("leave.mine")}>
      {q.isLoading ? <Skeleton rows={3} /> : !q.data?.length ? <Empty text={t("leave.none")} /> : (
        <ul className="divide-y divide-grey-line -my-2">
          {q.data.map((r) => (
            <li key={r.id} className="py-3 flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-semibold tabular">{when(r, t)}</div>
                <div className="text-sm break-words">{r.kind === "absent" ? `⛔ ${t("leave.absent")} · ` : ""}{r.reason}</div>
                {r.decision_note && <div className="text-xs text-muted break-words">📝 {r.decision_note}</div>}
              </div>
              <Badge tone={TONE[r.status]}>{t(`leave.status.${r.status}`)}</Badge>
              {r.status === "pending" && r.kind === "leave" && <button className="tap-target text-danger" aria-label={t("app.cancel")} onClick={() => cancel.mutate(r.id)}><X size={18} /></button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ApproveList({ onAffected }: { onAffected: (a: Affected) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["leave", "approve"], queryFn: () => api.leave.list("approve") });
  const [rejecting, setRejecting] = useState<LeaveRow | null>(null);
  const [note, setNote] = useState("");
  const approve = useMutation({ mutationFn: (id: string) => api.leave.approve(id), onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ["leave"] }); toast.success(t("leave.approved_ok")); if (r.affected.length) onAffected(r.affected); },
    onError: (e) => toast.error(t(`leave.err.${errCode(e)}`, { defaultValue: t("app.error") })) });
  const reject = useMutation({ mutationFn: () => api.leave.reject(rejecting!.id, note.trim()), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["leave"] }); setRejecting(null); setNote(""); },
    onError: (e) => toast.error(t(`leave.err.${errCode(e)}`, { defaultValue: t("app.error") })) });
  return (
    <Card title={t("leave.approvals")}>
      {q.isLoading ? <Skeleton rows={3} /> : !q.data?.length ? <Empty text={t("leave.none")} /> : (
        <ul className="divide-y divide-grey-line -my-2">
          {q.data.map((r) => (
            <li key={r.id} className="py-3">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold break-words">{r.full_name} <span className="text-xs text-muted">({t(`roles.${r.role}`)})</span></div>
                  <div className="text-sm tabular">{when(r, t)}</div>
                  <div className="text-sm break-words">{r.kind === "absent" ? `⛔ ${t("leave.absent")} · ` : ""}{r.reason}</div>
                </div>
                <Badge tone={TONE[r.status]}>{t(`leave.status.${r.status}`)}</Badge>
              </div>
              {r.status === "pending" && (
                <div className="flex gap-2 mt-2">
                  <Button variant="danger" onClick={() => setRejecting(r)}><X size={16} /> {t("leave.reject")}</Button>
                  <Button variant="primary" className="flex-1 sm:flex-none" loading={approve.isPending && approve.variables === r.id} onClick={() => approve.mutate(r.id)} data-testid="leave-approve"><Check size={16} /> {t("leave.approve")}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {rejecting && (
        <Dialog open onClose={() => setRejecting(null)} title={`${t("leave.reject")} · ${rejecting.full_name}`} footer={<>
          <Button onClick={() => setRejecting(null)}>{t("app.back")}</Button>
          <Button variant="danger" className="flex-1 sm:flex-none" loading={reject.isPending} onClick={() => reject.mutate()}>{t("leave.reject")}</Button>
        </>}>
          <Field label={t("leave.note")}><textarea className="input h-20 py-2" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
        </Dialog>
      )}
    </Card>
  );
}

function AbsentCard({ onAffected }: { onAffected: (a: Affected) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { me } = useAuth();
  const users = useQuery({ queryKey: ["users-basic"], queryFn: api.usersBasic });
  const staff = (users.data ?? []).filter((u) => ATTENDANCE_ROLES.includes(u.role) && u.id !== me?.id);
  const [who, setWho] = useState(""), [from, setFrom] = useState(todayLocal()), [to, setTo] = useState(todayLocal()), [part, setPart] = useState("full"), [reason, setReason] = useState("");
  const multi = to !== from;
  const m = useMutation({
    mutationFn: () => api.leave.absent({ user_id: who, date_from: from, date_to: to, part: multi ? "full" : part, reason: reason.trim() }),
    onSuccess: (r) => { toast.success(t("leave.absent_ok")); setWho(""); setReason(""); void qc.invalidateQueries({ queryKey: ["leave"] }); onAffected(r.affected); },
    onError: (e) => toast.error(t(`leave.err.${errCode(e)}`, { defaultValue: t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") }) })),
  });
  return (
    <Card title={t("leave.mark_absent")}>
      <Field label={t("leave.person")} required>
        <Select name="absent_user" value={who} onChange={(e) => setWho(e.target.value)}><option value="">—</option>{staff.map((u) => <option key={u.id} value={u.id}>{u.full_name} ({t(`roles.${u.role}`)})</option>)}</Select>
      </Field>
      <div className="grid grid-cols-2 gap-x-3">
        <Field label={t("leave.from")} required><Input type="date" min={todayLocal()} value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} /></Field>
        <Field label={t("leave.to")} required><Input type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <Field label={t("leave.part_label")}><PartPicker value={multi ? "full" : part} onChange={setPart} disabledHalf={multi} /></Field>
      <Field label={t("leave.reason")} required><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      <div className="flex justify-end"><Button variant="danger" loading={m.isPending} disabled={!who || reason.trim().length < 2} onClick={() => m.mutate()}><UserX size={16} /> {t("leave.mark_absent")}</Button></div>
    </Card>
  );
}

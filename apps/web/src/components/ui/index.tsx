import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, forwardRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useToast } from "@/lib/toast";

// ---------- Button ----------
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger"; size?: "md" | "lg"; loading?: boolean };
export function Button({ variant = "secondary", size = "md", loading, className = "", children, disabled, ...rest }: BtnProps) {
  const v = variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "btn-secondary";
  return (
    <button className={`${v} ${size === "lg" ? "btn-lg" : ""} ${className}`} disabled={disabled || loading} {...rest}>
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

// ---------- Field / Input / Select ----------
export function Field({ label, error, hint, children, required }: { label: string; error?: string; hint?: string; children: ReactNode; required?: boolean }) {
  return (
    <div className="mb-3">
      <label>{label}{required && <span className="text-danger"> *</span>}</label>
      {children}
      {error ? <p className="field-error">{error}</p> : hint ? <p className="text-xs text-muted mt-1">{hint}</p> : null}
    </div>
  );
}
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ invalid, className = "", ...rest }, ref) {
    return <input ref={ref} className={`input ${invalid ? "input-error" : ""} ${className}`} {...rest} />;
  },
);
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ invalid, className = "", children, ...rest }, ref) {
    return <select ref={ref} className={`input ${invalid ? "input-error" : ""} ${className}`} {...rest}>{children}</select>;
  },
);

// ---------- Card / Badge ----------
export function Card({ children, className = "", title, actions }: { children: ReactNode; className?: string; title?: string; actions?: ReactNode }) {
  return (
    <section className={`card p-4 ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between mb-3">
          {title && <h2 className="text-base">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}
const BADGE: Record<string, string> = {
  grey: "bg-[#EEF0F4] text-[#4B5263]", blue: "bg-blue-50 text-blue", green: "bg-success-50 text-success",
  warning: "bg-warning-50 text-warning", danger: "bg-danger-50 text-danger", purple: "bg-purple-50 text-purple", navy: "bg-[#E6EDFD] text-navy",
};
export function Badge({ tone = "grey", children }: { tone?: keyof typeof BADGE; children: ReactNode }) {
  return <span className={`badge ${BADGE[tone]}`}>{children}</span>;
}

// ---------- ActionBar (sticky primary actions on phones) ----------
export function ActionBar({ children }: { children: ReactNode }) {
  return <div className="action-bar">{children}</div>;
}

// ---------- Dialog: bottom sheet on phones (fits the visible screen, body scrolls, header + footer stay) ----------
export function Dialog({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // no background scroll behind the sheet
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={onClose} role="presentation">
      <div className="card w-full sm:max-w-lg max-h-[92dvh] flex flex-col rounded-b-none sm:rounded-md" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-2 pl-4 pr-1 py-1 border-b border-grey-line shrink-0">
          <h2 className="text-base min-w-0 break-words py-2">{title}</h2>
          <button className="tap-target rounded hover:bg-grey-bg" onClick={onClose} aria-label="close"><X size={20} /></button>
        </header>
        <div className="p-4 overflow-y-auto overscroll-contain min-h-0">{children}</div>
        {footer && <footer className="px-4 py-3 border-t border-grey-line flex flex-wrap justify-end gap-2 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, text, danger, loading }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; text: string; danger?: boolean; loading?: boolean }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onClose={onClose} title={title} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>{t("app.confirm")}</Button>
    </>}>
      <p className="text-sm">{text}</p>
    </Dialog>
  );
}

// ---------- States ----------
export function Skeleton({ rows = 5 }: { rows?: number }) {
  return <div className="space-y-2 animate-pulse" aria-busy>{Array.from({ length: rows }).map((_, i) => <div key={i} className="h-9 rounded bg-grey-line/60" />)}</div>;
}
export function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return <div className="text-center py-10 text-muted"><p className="mb-3">{text}</p>{action}</div>;
}
export function ErrorState({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return <div className="text-center py-8"><p className="text-danger mb-3">{text}</p>{onRetry && <Button onClick={onRetry}>{t("app.retry")}</Button>}</div>;
}

// ---------- Toasts ----------
export function Toaster() {
  const { toasts, remove } = useToast();
  const tone = { success: "bg-success text-white", error: "bg-danger text-white", info: "bg-navy text-white" };
  return (
    <div className="fixed inset-x-4 sm:inset-x-auto top-[calc(3.5rem+env(safe-area-inset-top))] sm:top-auto sm:bottom-4 sm:right-4 z-[60] space-y-2 pointer-events-none [&>*]:pointer-events-auto" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`${tone[t.kind]} rounded-md px-4 py-2 shadow-drawer text-sm flex items-center gap-3`}>
          <span className="flex-1 break-words">{t.text}</span><button className="tap-target -my-2 -mr-2" onClick={() => remove(t.id)} aria-label="dismiss"><X size={16} /></button>
        </div>
      ))}
    </div>
  );
}

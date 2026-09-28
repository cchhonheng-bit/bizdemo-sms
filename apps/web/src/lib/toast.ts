import { create } from "zustand";
type Toast = { id: number; kind: "success" | "error" | "info"; text: string };
type S = { toasts: Toast[]; push: (kind: Toast["kind"], text: string) => void; remove: (id: number) => void };
let seq = 1;
export const useToast = create<S>((set) => ({
  toasts: [],
  push(kind, text) {
    const id = seq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000);
  },
  remove(id) { set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })); },
}));
export const toast = {
  success: (t: string) => useToast.getState().push("success", t),
  error: (t: string) => useToast.getState().push("error", t),
  info: (t: string) => useToast.getState().push("info", t),
};

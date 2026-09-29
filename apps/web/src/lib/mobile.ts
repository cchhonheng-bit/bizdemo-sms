// Phones: when the on-screen keyboard opens (visual viewport shrinks) keep the focused field visible,
// also inside dialogs/sheets that scroll on their own (UI Design v1.1 "keyboard never hides the active field").
export function keepFocusedFieldVisible(): void {
  const vv = window.visualViewport;
  if (!vv || !matchMedia("(pointer: coarse)").matches) return;
  const reveal = () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
    const r = el.getBoundingClientRect();
    if (r.bottom > vv.height - 16 || r.top < 56) el.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  vv.addEventListener("resize", reveal);
  document.addEventListener("focusin", () => setTimeout(reveal, 350));
}

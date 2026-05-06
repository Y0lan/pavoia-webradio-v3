import { useEffect } from "react";

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * Slide-in drawer from the left. Shown only at < md breakpoints
 * (the desktop sidebar takes over at md+). Backdrop dismisses on
 * click; ESC dismisses; auto-closes on route change is the parent's
 * responsibility (Layout watches the active stage).
 *
 * Body scroll lock via overflow-hidden prevents the underlying
 * page from scrolling while the drawer is open. Focus management
 * is intentionally minimal — the drawer's content (Sidebar) is
 * keyboard-friendly via the existing TanStack Router Links.
 */
export function MobileDrawer({ open, onClose, children }: MobileDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-40 md:hidden ${
        open ? "pointer-events-auto" : "pointer-events-none"
      }`}
      aria-hidden={!open}
    >
      {/* Backdrop. Tap-to-dismiss; opacity transitions for a soft fade. */}
      <button
        type="button"
        aria-label="Close stages menu"
        onClick={onClose}
        tabIndex={open ? 0 : -1}
        className={`absolute inset-0 bg-black/70 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      {/* Panel. Slide-in from left; 88vw cap leaves a peek of the
       * backdrop so it's obvious the drawer is dismissable. */}
      <aside
        className={`relative h-full w-[88vw] max-w-sm transform border-r border-slate-800 bg-[#0a0410] transition-transform duration-200 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Stages"
      >
        {children}
      </aside>
    </div>
  );
}

import { useEffect, useRef } from "react";

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
 * Accessibility:
 *   - When closed, the panel is `inert` so its descendants don't
 *     receive focus via Tab from the page underneath. (CR feedback
 *     on PR #29.)
 *   - When open, role="dialog" + aria-modal + aria-label so screen
 *     readers treat it as a modal layer; initial focus moves to the
 *     panel and is restored to the previously-focused element on
 *     close. There's no cross-platform cheap focus-trap primitive
 *     in React; we rely on the listener pattern + initial focus to
 *     keep the keyboard inside the drawer for the common case.
 *   - Body scroll lock via overflow-hidden prevents the underlying
 *     page from scrolling while the drawer is open.
 */
export function MobileDrawer({ open, onClose, children }: MobileDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    // Capture the element that triggered the open so we can restore
    // focus on close (typical accessible-modal pattern).
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Move focus into the panel on open so subsequent Tab keys land
    // on its first focusable descendant.
    panelRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // Restore focus to the trigger if it's still in the DOM.
      const el = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (el && document.body.contains(el)) {
        try {
          el.focus();
        } catch {
          // Element may have been disabled mid-cycle. No-op.
        }
      }
    };
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-40 md:hidden ${
        open ? "pointer-events-auto" : "pointer-events-none"
      }`}
    >
      {/* Backdrop. Tap-to-dismiss; opacity transitions for a soft fade.
       * Tabindex -1 when closed so it's not in the tab order. */}
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
       * backdrop so it's obvious the drawer is dismissable.
       *
       * The `inert` attribute on the panel when closed pulls the
       * entire subtree out of the focus order — ensures Sidebar's
       * tabs/Links never receive Tab focus from the page below
       * while the drawer is hidden. tabIndex=-1 lets us programmatically
       * focus the panel itself when the drawer opens. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={open}
        aria-label="Stages menu"
        tabIndex={-1}
        // React 19 forwards the `inert` attribute as a boolean.
        // `inert={true}` toggles the HTML attribute on/off.
        {...(open ? {} : { inert: true })}
        className={`relative h-full w-[88vw] max-w-sm transform border-r border-slate-800 bg-[#0a0410] transition-transform duration-200 outline-none ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

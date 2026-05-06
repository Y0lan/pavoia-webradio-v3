import { useEffect, useRef } from "react";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Visible label for screen readers; rendered as the dialog title
   *  unless the caller provides their own heading inside `children`. */
  ariaLabel: string;
  children: React.ReactNode;
}

/**
 * Thin wrapper around the native `<dialog>` element. Browsers handle
 * the modal stacking, focus trap, and ESC-to-dismiss for us; we just
 * sync the `open` prop to .showModal() / .close() and emit onClose
 * when the dialog closes for any reason (ESC, backdrop click, or our
 * caller setting open=false).
 */
export function Dialog({ open, onClose, ariaLabel, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);

  // Dedupe onClose. Without this, a click on the close button fires
  // a chain: button onClick → parent setState → useEffect calls
  // el.close() → element fires "close" event → onCloseEvent calls
  // onClose() AGAIN. The ref short-circuits any subsequent emissions
  // until the dialog reopens.
  const closingRef = useRef(false);

  // Reset the dedupe flag whenever the dialog opens — otherwise the
  // second open in a session would have onClose suppressed.
  useEffect(() => {
    if (open) closingRef.current = false;
  }, [open]);

  // Sync `open` → element state. showModal() rejects if already open;
  // close() is a no-op if closed, so guard with .open.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  const handleClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    onClose();
  };

  // Native close events fire on ESC and on dialog.close(). Route
  // through handleClose so the dedupe flag prevents a double emit.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCloseEvent = () => handleClose();
    el.addEventListener("close", onCloseEvent);
    return () => el.removeEventListener("close", onCloseEvent);
    // handleClose closes over onClose (stable for our usage), and
    // we WANT this effect re-attached if the consumer's onClose
    // changes — eslint-react-hooks would catch a stale closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  // Click-outside-to-dismiss: when the click target IS the dialog
  // element itself (not anything inside it), the user clicked the
  // backdrop. Native dialog doesn't expose this directly; the
  // pattern below works in all evergreen browsers.
  const onBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === ref.current) {
      handleClose();
    }
  };

  return (
    <dialog
      ref={ref}
      aria-label={ariaLabel}
      onClick={onBackdropClick}
      className="m-auto max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-0 text-slate-100 shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      {/* Inner padding wrapper so the click-on-backdrop check above
       * sees the dialog element directly when the user clicks
       * outside the content area. */}
      <div className="p-6 md:p-8">{children}</div>
    </dialog>
  );
}

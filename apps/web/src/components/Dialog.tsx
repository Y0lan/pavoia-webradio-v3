import { useEffect, useRef } from "react";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  children: React.ReactNode;
}

/**
 * Native <dialog> wrapper — browser-native modal, ESC dismissal,
 * focus trap, backdrop. Single onClose dedupe so user-initiated
 * close + framework-driven close don't double-fire.
 */
export function Dialog({ open, onClose, ariaLabel, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const closingRef = useRef(false);

  useEffect(() => {
    if (open) closingRef.current = false;
  }, [open]);

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

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCloseEvent = () => handleClose();
    el.addEventListener("close", onCloseEvent);
    return () => el.removeEventListener("close", onCloseEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

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
      className="m-auto max-h-[92dvh] max-w-md overflow-hidden rounded-sm border border-[var(--color-card-border-strong)] bg-[var(--color-card)] p-0 text-[var(--color-text)] shadow-2xl backdrop:bg-black/80 backdrop:backdrop-blur-md"
    >
      <div className="max-h-[92dvh] overflow-hidden p-5 md:p-6">{children}</div>
    </dialog>
  );
}

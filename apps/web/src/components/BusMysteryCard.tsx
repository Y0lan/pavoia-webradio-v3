import { Dialog } from "./Dialog.tsx";

interface BusMysteryCardProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Bus easter egg, GAENDE-aesthetic. The Bus stage has no audio;
 * tapping it pops this dialog instead of routing to a 404.
 */
export function BusMysteryCard({ open, onClose }: BusMysteryCardProps) {
  return (
    <Dialog open={open} onClose={onClose} ariaLabel="Bus stage">
      <div className="space-y-5 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">
          // stage 11 · 🚌
        </p>

        <h2 className="font-serif text-3xl italic text-[var(--color-text)]">
          the bus
        </h2>

        <p
          className="border-l-2 border-[var(--color-amber)] mx-auto inline-block pl-4 text-left font-serif text-base italic leading-relaxed text-[var(--color-text-soft)]"
        >
          "Some things must be experienced in person."
        </p>

        <button
          type="button"
          onClick={onClose}
          className="mx-auto block border border-[rgba(255,170,0,0.4)] px-5 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--color-amber)] transition-colors hover:bg-[rgba(255,170,0,0.1)]"
        >
          got it
        </button>
      </div>
    </Dialog>
  );
}

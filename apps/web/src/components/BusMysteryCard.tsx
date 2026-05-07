import { Dialog } from "./Dialog.tsx";

interface BusMysteryCardProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Bus easter egg, GAENDE-aesthetic. Direct port of v1's warmer
 * "find it, hop on" copy — the Bus stage isn't on the wire, it's
 * a real thing somewhere at the festival.
 */
export function BusMysteryCard({ open, onClose }: BusMysteryCardProps) {
  return (
    <Dialog open={open} onClose={onClose} ariaLabel="Bus stage">
      <div className="space-y-5 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">
          // stage 11 · 🚌
        </p>

        <div className="text-7xl leading-none">🚌</div>

        <h2 className="font-serif text-2xl italic leading-tight text-[var(--color-text)] md:text-3xl">
          some things must be
          <br />
          experienced in person
        </h2>

        <p className="mx-auto max-w-sm font-sans text-sm leading-relaxed text-[var(--color-text-soft)]">
          The bus is out there, somewhere at Pavoia. Find it, hop on,
          and let the music surprise you.
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

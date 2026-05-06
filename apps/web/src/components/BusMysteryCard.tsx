import { Dialog } from "./Dialog.tsx";

interface BusMysteryCardProps {
  open: boolean;
  onClose: () => void;
}

/**
 * v1's Bus easter egg, ported. The Bus stage has no audio (it's
 * disabled in the catalog) — when the listener clicks it from the
 * sidebar, this card surfaces a hint that some things are not for
 * the webradio. Click anywhere to dismiss.
 */
export function BusMysteryCard({ open, onClose }: BusMysteryCardProps) {
  return (
    <Dialog open={open} onClose={onClose} ariaLabel="Bus stage">
      <div className="space-y-5 text-center">
        <div className="text-6xl leading-none">🚌</div>
        <div>
          <h2 className="text-xl font-semibold text-slate-100">
            The bus
          </h2>
          <p className="mt-2 text-balance text-sm leading-relaxed text-slate-400">
            Some things must be experienced in person.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mx-auto block rounded-full border border-amber-700/60 bg-amber-950/40 px-5 py-2 text-sm text-amber-200 transition-colors hover:bg-amber-900/40"
        >
          Got it
        </button>
      </div>
    </Dialog>
  );
}

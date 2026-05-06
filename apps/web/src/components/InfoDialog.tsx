import { Dialog } from "./Dialog.tsx";

interface InfoDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * About / readme. Wordmark front-and-center per the GAENDE brief —
 * tracked-out monospace logotype with a red glow, blinking caret as
 * the brand mark. Body in serif italic for warmth, mono labels for
 * structure.
 */
export function InfoDialog({ open, onClose }: InfoDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} ariaLabel="About Pavoia">
      <div className="space-y-5">
        {/* Wordmark — same treatment as the sidebar header but bigger */}
        <div>
          <div className="flex items-baseline gap-3">
            <span
              className="animate-blink font-mono text-base text-[--color-accent]"
              aria-hidden="true"
            >
              ▸
            </span>
            <h2
              className="font-mono text-3xl font-bold tracking-[0.22em] text-[--color-accent]"
              style={{ textShadow: "0 0 28px rgba(232,80,32,0.3)" }}
            >
              PAVOIA
            </h2>
          </div>
          <p className="mt-2 pl-7 font-mono text-[10px] uppercase tracking-[0.18em] text-[--color-text-faint]">
            // gaende's webradio · v3
          </p>
        </div>

        <div className="border-l-2 border-[--color-accent] pl-4 font-serif text-base italic leading-relaxed text-[--color-text-soft]">
          "At the intersection of emotion and code."
        </div>

        <p className="font-sans text-sm leading-relaxed text-[--color-text-soft]">
          Eleven stages curated by gaende. Each one streams from its
          own Plex playlist; no queue, no skip, no algorithm — just
          the next track when this one ends. Full albums, full
          discographies, the deep digs.
        </p>

        <div className="rounded-sm border border-[--color-card-border] bg-[--color-bg-soft] px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[--color-text-faint]">
            // about the bus stage
          </p>
          <p className="mt-2 font-sans text-xs text-[--color-text-soft]">
            UI-only. Some things must be experienced in person.
          </p>
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="border border-[--color-card-border-strong] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-[--color-text-soft] transition-colors hover:border-[--color-accent] hover:text-[--color-text]"
          >
            close
          </button>
        </div>
      </div>
    </Dialog>
  );
}

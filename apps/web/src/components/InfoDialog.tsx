import { Dialog } from "./Dialog.tsx";

interface InfoDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * About / readme. The curator's first-person voice — adapted from
 * v1's InfoDialog, updated for v3's eleven stages and the
 * Anti-Algorithm digging method that powers the catalog.
 */
export function InfoDialog({ open, onClose }: InfoDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} ariaLabel="About Pavoia">
      <div className="space-y-4">
        {/* Logo hero — the v1 animated mark, big at the top */}
        <div className="text-center">
          <img
            src="/pavoia-logo.gif"
            alt="Pavoia"
            className="mx-auto h-20 w-auto md:h-24"
            style={{
              filter: "drop-shadow(0 0 22px rgba(232,80,32,0.25))",
            }}
          />
          <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-soft)]">
            <span className="text-[var(--color-accent-dim)]">//</span>{" "}
            pavoia webradio · v3
          </p>
        </div>

        {/* Curator's note — first person, warm. Direct port of v1's
            voice, updated for "eleven stages" and the digging story. */}
        <div className="space-y-3 font-sans text-sm leading-relaxed text-[var(--color-text-soft)]">
          <p>
            This collection started years ago, built from artists I
            heard at <strong className="text-[var(--color-text)]">Pavoia</strong>{" "}
            and countless hours of digging for new sounds. Every time I
            fall for a track, I picture which stage it belongs to. What
            began as a personal obsession slowly grew into something
            worth sharing.
          </p>
          <p>
            Today, these{" "}
            <strong className="text-[var(--color-text)]">eleven stages</strong>{" "}
            are open to anyone who finds them. The playlists keep
            growing — full albums, B-sides nobody flipped, and obscure
            new releases I dig out daily, the hard way. No charts, no
            algorithm. Just the next track when this one ends.
          </p>
        </div>

        {/* Listening tips — small print, useful */}
        <div className="rounded-sm border border-[var(--color-card-border)] bg-[var(--color-bg-soft)] px-4 py-3 font-sans text-xs leading-relaxed text-[var(--color-text-soft)]">
          <p>
            <strong className="text-[var(--color-text)]">High quality, unprocessed.</strong>{" "}
            All streams are AAC at the source bitrate — the way the
            artists meant the tracks to land.
          </p>
          <p className="mt-2">
            <strong className="text-[var(--color-text)]">On your phone?</strong>{" "}
            Most browsers keep playing in the background while the tab
            stays open. Add the page to your home screen for the best
            experience.
          </p>
        </div>

        {/* Bus stage hint */}
        <div className="rounded-sm border border-[rgba(255,170,0,0.18)] bg-[rgba(255,170,0,0.04)] px-4 py-3 font-sans text-xs italic leading-relaxed text-[var(--color-text-soft)]">
          🚌 The bus stage isn't on the wire — it's out there, somewhere
          at Pavoia. Find it, hop on, let the music surprise you.
        </div>

        {/* Social — v1 had Instagram + SoundCloud. Keeping it warm. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <a
            href="https://instagram.com/wearepavoia"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm border border-[var(--color-card-border)] bg-[var(--color-bg-soft)] px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-soft)] transition-colors hover:border-[var(--color-accent-dim)] hover:text-[var(--color-text)]"
          >
            <span className="text-[var(--color-accent-dim)]">→</span> instagram{" "}
            <span className="text-[var(--color-text-faint)]">@wearepavoia</span>
          </a>
          <a
            href="https://soundcloud.com/pavoia"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm border border-[var(--color-card-border)] bg-[var(--color-bg-soft)] px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-soft)] transition-colors hover:border-[var(--color-accent-dim)] hover:text-[var(--color-text)]"
          >
            <span className="text-[var(--color-accent-dim)]">→</span> soundcloud{" "}
            <span className="text-[var(--color-text-faint)]">@pavoia</span>
          </a>
        </div>

        {/* Signature */}
        <div className="border-t border-[var(--color-card-border)] pt-3 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
          made with{" "}
          <span className="text-[var(--color-accent)]">♥</span> by{" "}
          <a
            href="https://instagram.com/gaende_music"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-text-soft)] underline-offset-4 transition-colors hover:text-[var(--color-text)] hover:underline"
          >
            gaende
          </a>
        </div>

        {/* Close */}
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            className="border border-[var(--color-card-border-strong)] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
          >
            close
          </button>
        </div>
      </div>
    </Dialog>
  );
}

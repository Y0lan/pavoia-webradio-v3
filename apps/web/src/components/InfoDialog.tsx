import { Dialog } from "./Dialog.tsx";

interface InfoDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * About / credits modal. Triggered from the small info button in
 * the sidebar footer. Replaces v1's logo-driven InfoDialog with a
 * plain text approach since v3 doesn't ship with a brand GIF asset.
 */
export function InfoDialog({ open, onClose }: InfoDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} ariaLabel="About Pavoia">
      <div className="space-y-4">
        <div>
          <h2 className="bg-gradient-to-br from-fuchsia-300 via-amber-200 to-emerald-300 bg-clip-text text-2xl font-bold text-transparent">
            pavoia webradio
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            v3 — Plex-driven HLS radio
          </p>
        </div>

        <p className="text-sm leading-relaxed text-slate-300">
          Eleven stages curated by gaende. Each one streams from its
          own Plex playlist; track changes are picked up at the next
          poll cycle. No queue, no skip, no algorithm — just the next
          track when this one ends.
        </p>

        <p className="text-sm leading-relaxed text-slate-400">
          The bus stage is a UI-only easter egg. Some things must be
          experienced in person.
        </p>

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700"
          >
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}

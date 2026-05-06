import { useStages } from "../api/stages.ts";
import { StageItem } from "./StageItem.tsx";

interface SidebarProps {
  /** id of the currently-routed stage, or null if no stage selected */
  activeStageId: string | null;
  /** Open the about/credits dialog (footer "i" button). */
  onOpenInfo: () => void;
  /** Open the Bus stage easter egg (clicked from the disabled row). */
  onOpenBus: () => void;
}

/**
 * Renders the static catalog of stages from /api/stages — the
 * source of truth for icons/accents/gradients/order is the server
 * (which gets it from packages/shared/stages.ts).
 *
 * Layout uses this same component for both the desktop sidebar
 * (md:flex) and the mobile drawer's panel content; the drawer
 * provides its own animation + backdrop chrome around it.
 */
export function Sidebar({ activeStageId, onOpenInfo, onOpenBus }: SidebarProps) {
  const { data: stages, isLoading, isError, error } = useStages();

  return (
    <aside
      className="flex h-full w-full flex-col bg-[#0a0410] md:w-80 md:border-r md:border-slate-800"
      aria-label="Stages"
    >
      <header className="hidden items-center px-6 py-5 md:flex">
        <h1 className="bg-gradient-to-r from-fuchsia-400 to-amber-300 bg-clip-text text-xl font-bold tracking-tight text-transparent">
          Pavoia
        </h1>
      </header>

      <nav className="flex-1 overflow-y-auto px-3 pt-3 pb-6 md:pt-0">
        {isLoading ? (
          <div className="px-3 py-2 text-sm text-slate-500">
            Loading stages…
          </div>
        ) : isError ? (
          <div className="rounded-lg border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
            <div className="font-medium">Engine unreachable</div>
            <div className="mt-1 text-xs text-rose-400/80">
              Is the SSH tunnel open?
            </div>
            {error instanceof Error ? (
              <div className="mt-2 truncate text-xs text-rose-500/60">
                {error.message}
              </div>
            ) : null}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {(stages ?? []).map((stage) => (
              <li key={stage.id}>
                <StageItem
                  stage={stage}
                  isActive={stage.id === activeStageId}
                  onOpenBus={onOpenBus}
                />
              </li>
            ))}
          </ul>
        )}
      </nav>

      <footer className="border-t border-slate-800 px-3 py-3">
        <button
          type="button"
          onClick={onOpenInfo}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-slate-200"
          aria-label="About Pavoia"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 5a1.25 1.25 0 110 2.5A1.25 1.25 0 0112 7zm1.5 11h-3v-1h.75v-4.5h-.75v-1h2.25v5.5h.75v1z" />
          </svg>
          About
        </button>
      </footer>
    </aside>
  );
}

import { useStages } from "../api/stages.ts";
import { StageItem } from "./StageItem.tsx";

interface SidebarProps {
  /** id of the currently-routed stage, or null if no stage selected */
  activeStageId: string | null;
}

/**
 * Desktop sidebar (mobile drawer comes in Slice E). Renders the
 * static catalog of stages from /api/stages — the source of truth
 * for icons/accents/gradients/order is the server (which gets it
 * from packages/shared/stages.ts).
 */
export function Sidebar({ activeStageId }: SidebarProps) {
  const { data: stages, isLoading, isError, error } = useStages();

  return (
    <aside
      className="flex w-full flex-col border-r border-slate-800 bg-[#0a0410] md:w-80"
      aria-label="Stages"
    >
      <header className="flex items-center px-6 py-5">
        <h1 className="bg-gradient-to-r from-fuchsia-400 to-amber-300 bg-clip-text text-xl font-bold tracking-tight text-transparent">
          Pavoia
        </h1>
      </header>

      <nav className="flex-1 overflow-y-auto px-3 pb-6">
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
                />
              </li>
            ))}
          </ul>
        )}
      </nav>
    </aside>
  );
}

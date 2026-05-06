import { useStages } from "../api/stages.ts";
import { StageItem } from "./StageItem.tsx";

interface SidebarProps {
  activeStageId: string | null;
  onOpenInfo: () => void;
  onOpenBus: () => void;
}

/**
 * Stage list — terminal-style sidebar matching the GAENDE press-kit
 * brief. Wordmark + caret cursor, numbered stages, mono `//` and `$`
 * flourishes for hierarchy. Same component renders in the desktop
 * sidebar slot AND inside the mobile drawer.
 */
export function Sidebar({ activeStageId, onOpenInfo, onOpenBus }: SidebarProps) {
  const { data: stages, isLoading, isError, error } = useStages();

  return (
    <aside
      className="flex h-full w-full flex-col bg-[--color-bg] md:w-80 md:border-r md:border-[--color-card-border]"
      aria-label="Stages"
    >
      {/* Wordmark — JetBrains Mono GAENDE-style, with blinking caret */}
      <header className="px-5 pb-3 pt-6 md:pb-5 md:pt-8">
        <div className="flex items-baseline gap-3">
          <span
            className="animate-blink font-mono text-xs text-[--color-accent]"
            aria-hidden="true"
          >
            ▸
          </span>
          <h1
            className="font-mono text-2xl font-bold tracking-[0.2em] text-[--color-accent]"
            style={{ textShadow: "0 0 24px rgba(232,80,32,0.25)" }}
          >
            PAVOIA
          </h1>
        </div>
        <p className="mt-1.5 pl-7 font-mono text-[9px] uppercase tracking-[0.18em] text-[--color-text-faint]">
          // gaende's webradio · 11 stages
        </p>
      </header>

      <div className="px-5 pb-2 pt-3">
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.15em] text-[--color-text-faint]">
          <span className="h-px flex-1 bg-[--color-card-border-strong]" />
          <span>stages</span>
          <span className="h-px flex-1 bg-[--color-card-border-strong]" />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-1">
        {isLoading ? (
          <div className="px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-[--color-text-faint]">
            // loading stages…
          </div>
        ) : isError ? (
          <div className="mx-3 my-3 rounded-sm border border-[--color-amber] border-opacity-30 bg-[--color-bg-soft] px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-[--color-amber]">
              // engine unreachable
            </div>
            <div className="mt-2 font-sans text-xs text-[--color-text-soft]">
              Is the SSH tunnel open?
            </div>
            {error instanceof Error ? (
              <div className="mt-1 truncate font-mono text-[10px] text-[--color-text-faint]">
                {error.message}
              </div>
            ) : null}
          </div>
        ) : (
          <ul className="space-y-px">
            {(stages ?? []).map((stage, index) => (
              <li key={stage.id}>
                <StageItem
                  stage={stage}
                  index={index}
                  isActive={stage.id === activeStageId}
                  onOpenBus={onOpenBus}
                />
              </li>
            ))}
          </ul>
        )}
      </nav>

      {/* Footer — about button as a clear CTA, NOT buried */}
      <footer className="border-t border-[--color-card-border] px-3 py-3">
        <button
          type="button"
          onClick={onOpenInfo}
          className="flex w-full items-center gap-2 rounded-sm px-3 py-2 transition-colors hover:bg-[--color-bg-soft]"
          aria-label="About Pavoia"
        >
          <span
            className="font-mono text-[11px] text-[--color-accent-dim]"
            aria-hidden="true"
          >
            ?
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[--color-text-soft] transition-colors group-hover:text-[--color-text]">
            about · readme
          </span>
        </button>
      </footer>
    </aside>
  );
}

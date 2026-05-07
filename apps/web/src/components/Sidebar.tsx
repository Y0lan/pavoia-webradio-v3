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
      className="flex h-full w-full flex-col bg-[var(--color-bg)] md:w-80 md:border-r md:border-[var(--color-card-border)]"
      aria-label="Stages"
    >
      {/* Brand — v1's animated PAVOIA logo (the festival's actual
          mark, hosted in public/). */}
      <header className="px-5 pb-3 pt-4 md:pb-3 md:pt-5">
        <img
          src="/pavoia-logo.gif"
          alt="Pavoia"
          className="h-10 w-auto md:h-12"
          style={{
            filter: "drop-shadow(0 0 14px rgba(232,80,32,0.18))",
          }}
        />
        <p className="mt-2 font-mono text-[11px] tracking-[0.06em] text-[var(--color-text-soft)]">
          <span className="text-[var(--color-accent-dim)]">//</span>{" "}
          PAVOIA webradio · made by{" "}
          <button
            type="button"
            onClick={onOpenInfo}
            className="font-mono text-[var(--color-accent)] underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:underline"
            aria-label="About gaende"
          >
            gaende
          </button>
        </p>
      </header>

      <div className="px-5 pb-1 pt-2">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-soft)]">
          <span className="h-px flex-1 bg-[var(--color-card-border-strong)]" />
          <span>stages</span>
          <span className="h-px flex-1 bg-[var(--color-card-border-strong)]" />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-1">
        {isLoading ? (
          <div className="px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
            // loading stages…
          </div>
        ) : isError ? (
          <div className="mx-3 my-3 rounded-sm border border-[rgba(255,170,0,0.3)] bg-[var(--color-bg-soft)] px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--color-amber)]">
              // engine unreachable
            </div>
            <div className="mt-2 font-sans text-xs text-[var(--color-text-soft)]">
              Is the SSH tunnel open?
            </div>
            {error instanceof Error ? (
              <div className="mt-1 truncate font-mono text-[10px] text-[var(--color-text-faint)]">
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

      {/* Footer — About as a real CTA. Bordered button, accent prefix,
          accent-tinted border on hover. The footer sticks at the
          bottom of the column thanks to nav's flex-1 grow. */}
      <footer className="shrink-0 border-t border-[var(--color-card-border)] px-3 py-3">
        <button
          type="button"
          onClick={onOpenInfo}
          className="group flex w-full items-center gap-2.5 rounded-sm border border-[var(--color-card-border)] px-3 py-2.5 transition-colors hover:border-[var(--color-accent-dim)] hover:bg-[var(--color-bg-soft)] focus-visible:outline-none focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40"
          aria-label="About Pavoia"
        >
          <span
            className="font-mono text-[13px] font-bold text-[var(--color-accent)] transition-colors"
            aria-hidden="true"
          >
            ?
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-soft)] transition-colors group-hover:text-[var(--color-text)]">
            about · readme
          </span>
        </button>
      </footer>
    </aside>
  );
}

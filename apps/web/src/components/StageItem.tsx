import { Link } from "@tanstack/react-router";
import type { Stage } from "@pavoia/shared";

import { usePlayback } from "../audio/PlaybackProvider.tsx";
import { EqualizerBars } from "./EqualizerBars.tsx";

interface StageItemProps {
  stage: Stage;
  index: number;
  isActive: boolean;
  /** Triggered when the listener clicks the disabled Bus row. */
  onOpenBus: () => void;
}

/**
 * Sidebar row — terminal-style line item. Reads as:
 *
 *    01  $ opening                                     ▶  ●
 *    02  $ ambiance · safe space
 *    03  $ bermuda day                                 ●
 *
 * — leading two-digit ID (mono),
 * — `$ ` prompt, then stage name (sans),
 * — accent color used as a bullet on the right when this stage is
 *   the currently playing one,
 * — equalizer bars when actively producing audio (vs paused),
 * — left-edge accent stripe + glow when this is the route the user
 *   is currently viewing.
 */
export function StageItem({
  stage,
  index,
  isActive,
  onOpenBus,
}: StageItemProps) {
  const { playingStageId, state } = usePlayback();
  const isPlaying = playingStageId === stage.id && state === "playing";
  const isLoadedHere = playingStageId === stage.id;

  // 1-based for the listener: stage 01, 02, ... rather than 00.
  const number = String(index + 1).padStart(2, "0");
  const accent = stage.accent;

  // Disabled (Bus) — italic, dimmed, opens easter egg dialog.
  if (stage.disabled) {
    return (
      <button
        type="button"
        onClick={onOpenBus}
        className="group relative flex w-full items-center gap-3 px-5 py-2 text-left transition-colors hover:bg-[var(--color-bg-soft)]"
      >
        <span className="font-mono text-[10px] tabular-nums text-[var(--color-text-faint)]">
          {number}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-[11px] text-[var(--color-text-faint)]">
              //
            </span>
            <span
              className="truncate font-serif text-[15px] italic text-[var(--color-text-soft)]"
            >
              {stage.fallbackTitle.toLowerCase()}
            </span>
          </div>
          </div>
        <span
          className="text-lg opacity-50 transition-opacity group-hover:opacity-90"
          aria-hidden="true"
        >
          {stage.icon}
        </span>
      </button>
    );
  }

  return (
    <Link
      to="/stage/$stageId"
      params={{ stageId: stage.id }}
      aria-current={isActive ? "page" : undefined}
      className="group relative flex w-full items-center gap-3 px-5 py-2 transition-colors hover:bg-[var(--color-bg-soft)]"
    >
      {/* Active-route stripe — thin vertical bar, accent color */}
      {isActive && (
        <span
          className="absolute left-0 top-0 h-full w-[2px]"
          style={{
            backgroundColor: accent,
            boxShadow: `0 0 12px ${accent}66`,
          }}
        />
      )}

      <span
        className="font-mono text-[10px] tabular-nums transition-colors"
        style={{
          color: isActive
            ? accent
            : isLoadedHere
              ? "var(--color-text-soft)"
              : "var(--color-text-faint)",
        }}
      >
        {number}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span
            className="font-mono text-[11px] transition-colors"
            style={{
              color: isActive ? accent : "var(--color-text-faint)",
            }}
          >
            $
          </span>
          <span
            className="truncate font-sans text-[15px] font-medium leading-tight transition-colors"
            style={{
              color: isActive
                ? "var(--color-text)"
                : isLoadedHere
                  ? "var(--color-text)"
                  : "var(--color-text-soft)",
            }}
          >
            {stage.fallbackTitle.toLowerCase()}
          </span>
        </div>
      </div>

      {/* Right side: playing indicator (eq bars + dot) when this
          stage is the currently audible one. Visible on every page,
          not just when this row is the active route. */}
      {isPlaying ? (
        <EqualizerBars color={accent} size="sm" />
      ) : isLoadedHere ? (
        <span
          className="size-1.5 rounded-full"
          style={{ backgroundColor: accent }}
          aria-label="paused"
        />
      ) : null}

      <span
        className="text-lg transition-all duration-300"
        aria-hidden="true"
        style={{
          opacity: isActive || isLoadedHere ? 1 : 0.55,
        }}
      >
        {stage.icon}
      </span>
    </Link>
  );
}

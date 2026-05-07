import { Link } from "@tanstack/react-router";

import { useStageNow } from "../api/now.ts";
import { useStages } from "../api/stages.ts";
import { usePlayback } from "../audio/PlaybackProvider.tsx";
import { CoverImage } from "./CoverImage.tsx";
import { EqualizerBars } from "./EqualizerBars.tsx";

/**
 * Persistent strip at the bottom of the viewport showing what's
 * currently playing — regardless of which stage page the listener
 * is browsing.
 *
 * Hidden when nothing has been played yet. When something is playing
 * and the listener is on a different stage, this is the cue + the
 * one-tap return to the playing room.
 *
 * The "exploring" state from v1: the listener is on stage A but
 * hearing stage B. This bar is what tells them "B is what you're
 * hearing — tap to go back".
 */
export function PersistentPlayerBar() {
  const { playingStageId, state, pause, resume } = usePlayback();
  const { data: stages } = useStages();
  // Poll the playing stage's /now so the bar's title/artist update
  // even when the listener has navigated to a different stage page.
  const { data: now } = useStageNow(playingStageId ?? "");

  if (playingStageId === null || stages === undefined) return null;

  const stage = stages.find((s) => s.id === playingStageId);
  if (stage === undefined) return null;

  const isPlaying = state === "playing";
  const isLoading = state === "loading";
  const accent = stage.accent;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-card-border-strong)] bg-[var(--color-bg-soft)]/95 backdrop-blur-md">
      <div
        className="mx-auto flex max-w-6xl items-center gap-3 px-4 pt-3 md:gap-4 md:px-6"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
      >
        {/* On-air indicator */}
        <div
          className="flex shrink-0 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]"
          style={{ minWidth: 0 }}
        >
          <span
            className="size-1.5 rounded-full animate-blink"
            style={{ backgroundColor: accent }}
            aria-hidden="true"
          />
          <span className="hidden sm:inline">on air</span>
        </div>

        {/* Cover — Plex thumb when available, stage gradient otherwise.
            Tap to jump to the playing stage's detail page. */}
        <Link
          to="/stage/$stageId"
          params={{ stageId: stage.id }}
          aria-label={`Go to ${stage.fallbackTitle}`}
          className="shrink-0"
        >
          <CoverImage
            plexCoverUrl={now?.track?.coverUrl}
            className="size-12 rounded-sm shadow-md ring-1 ring-[var(--color-card-border)]"
            style={{
              backgroundImage: `linear-gradient(135deg, ${stage.gradient.from}, ${stage.gradient.via}, ${stage.gradient.to})`,
            }}
            fallback={null}
          />
        </Link>

        {/* Track meta */}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
            <span>// </span>
            <Link
              to="/stage/$stageId"
              params={{ stageId: stage.id }}
              className="truncate transition-colors hover:text-[var(--color-text-soft)]"
              style={{ color: `${accent}` }}
            >
              {stage.fallbackTitle.toLowerCase()}
            </Link>
          </div>
          <div className="truncate font-sans text-sm font-medium text-[var(--color-text)]">
            {now?.track?.title ?? (isLoading ? "Buffering…" : "—")}
          </div>
          <div className="truncate text-xs italic text-[var(--color-text-soft)]">
            {now?.track?.artist ?? (isLoading ? "" : "—")}
          </div>
        </div>

        {/* EQ bars when playing — visual signal for arm's-length glance */}
        {isPlaying ? (
          <div className="hidden shrink-0 sm:block">
            <EqualizerBars color={accent} />
          </div>
        ) : null}

        {/* Play/pause toggle */}
        <button
          type="button"
          onClick={isPlaying ? pause : () => void resume()}
          aria-label={isPlaying ? "Pause" : "Resume"}
          className="flex size-10 shrink-0 items-center justify-center rounded-full transition-all hover:scale-105"
          style={{
            border: `1.5px solid ${accent}`,
            backgroundColor: `${accent}1f`,
          }}
        >
          {isLoading ? (
            <svg width="18" height="18" viewBox="0 0 24 24" className="animate-spin" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="rgba(232,221,212,0.2)" strokeWidth="2.5" fill="none" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke={accent} strokeWidth="2.5" strokeLinecap="round" fill="none" />
            </svg>
          ) : isPlaying ? (
            <svg viewBox="0 0 24 24" width="14" height="14" fill={accent} aria-hidden="true">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg viewBox="2 2 20 20" width="14" height="14" fill={accent} aria-hidden="true">
              <path d="M8 5.14v13.72L19 12 8 5.14z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

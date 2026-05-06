import { useEffect, useState } from "react";
import type { NowPlaying as NowPlayingPayload, Stage } from "@pavoia/shared";

import { usePlayback } from "../audio/PlaybackProvider.tsx";
import { EqualizerBars } from "./EqualizerBars.tsx";

/* Local TrackProgress — small enough to inline. Updates every second
   from `startedAt`, clamps to [0, durationSec], renders a thin accent
   bar with mono timestamps below. */
function TrackProgress({
  startedAt,
  durationSec,
  accent,
}: {
  startedAt: number;
  durationSec: number;
  accent: string;
}) {
  const [elapsedSec, setElapsedSec] = useState(() =>
    computeElapsed(startedAt, durationSec),
  );
  useEffect(() => {
    setElapsedSec(computeElapsed(startedAt, durationSec));
    const id = setInterval(() => {
      setElapsedSec(computeElapsed(startedAt, durationSec));
    }, 1_000);
    return () => clearInterval(id);
  }, [startedAt, durationSec]);

  const pct =
    durationSec > 0
      ? Math.min(100, Math.max(0, (elapsedSec / durationSec) * 100))
      : 0;

  return (
    <div className="space-y-2">
      <div
        className="h-[2px] overflow-hidden rounded-full bg-[--color-bg-soft]"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Track progress"
      >
        <div
          className="h-full rounded-full transition-[width] duration-1000 ease-linear"
          style={{ width: `${pct}%`, backgroundColor: accent }}
        />
      </div>
      <div className="flex justify-between font-mono text-[10px] tabular-nums text-[--color-text-faint]">
        <span>{formatTime(elapsedSec)}</span>
        <span>{formatTime(durationSec)}</span>
      </div>
    </div>
  );
}

function computeElapsed(startedAt: number, durationSec: number): number {
  const sec = Math.max(0, (Date.now() - startedAt) / 1000);
  return Math.min(durationSec, sec);
}

function formatTime(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface NowPlayingHeroProps {
  stage: Stage;
  payload: NowPlayingPayload;
  streamUrl: string;
}

/**
 * Spotify-style "now playing" full-takeover view for a single stage.
 * The whole stage detail page is this — atmospheric per-stage gradient
 * behind, huge typography, big touch targets for the festival use case.
 *
 * Cover art is a gradient placeholder until Slice H lands the Plex
 * thumb proxy. The square + ratio + ring treatment will absorb a real
 * image cleanly when it shows up.
 */
export function NowPlayingHero({ stage, payload, streamUrl }: NowPlayingHeroProps) {
  const { playingStageId, state, play, pause, resume } = usePlayback();
  const { status, track, startedAt } = payload;

  const isThisStageActive = playingStageId === stage.id;
  const displayState = isThisStageActive ? state : "idle";
  const isPlaying = displayState === "playing";
  const isLoading = displayState === "loading";

  const onTogglePlay = () => {
    if (isThisStageActive) {
      if (isPlaying) {
        pause();
      } else {
        void resume();
      }
    } else {
      void play(stage.id, streamUrl);
    }
  };

  return (
    <div className="flex flex-col items-center px-6 pb-32 pt-6 md:px-8 md:pb-40 md:pt-10">
      {/* Stage label (mono, prefixed with //) */}
      <div className="mb-4 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.25em] text-[--color-text-faint]">
        <span
          className={`size-1.5 rounded-full ${
            isPlaying ? "animate-blink" : ""
          }`}
          style={{
            backgroundColor: isPlaying ? stage.accent : "rgba(143,122,106,0.4)",
          }}
          aria-hidden="true"
        />
        <span style={{ color: isPlaying ? stage.accent : undefined }}>
          {isPlaying ? "on air" : "off"} · stage {String(stage.order).padStart(2, "0")}
        </span>
      </div>

      {/* Stage title */}
      <h1
        className="font-serif text-3xl italic leading-tight text-[--color-text] md:text-4xl"
      >
        {stage.fallbackTitle.toLowerCase()}
      </h1>

      {/* Cover art / placeholder. Square, vinyl-ish, atmospheric. */}
      <div className="relative my-10 w-full max-w-sm md:my-14 md:max-w-md">
        <div
          className="aspect-square w-full overflow-hidden rounded-sm shadow-2xl ring-1 ring-[--color-card-border-strong]"
          style={{
            backgroundImage: `
              radial-gradient(circle at 30% 30%, ${stage.gradient.from}, transparent 60%),
              radial-gradient(circle at 70% 70%, ${stage.gradient.via}, transparent 65%),
              ${stage.gradient.to}
            `,
          }}
        >
          {/* Vinyl-record concentric circles — pure CSS placeholder until
              the Plex thumb proxy lands and we put <img> here. */}
          <div className="relative size-full">
            <div
              className="absolute inset-[14%] rounded-full opacity-30"
              style={{
                background: `repeating-radial-gradient(circle at center, transparent 0, transparent 4px, rgba(0,0,0,0.4) 4px, rgba(0,0,0,0.4) 5px)`,
              }}
            />
            <div
              className="absolute inset-[42%] rounded-full"
              style={{ backgroundColor: stage.accent, opacity: 0.85 }}
            />
            <div
              className="absolute inset-[48%] rounded-full bg-black"
            />
          </div>
        </div>

        {/* EQ bars overlaid on the bottom-right corner of the cover when
            playing — extra visual signal at arm's length. */}
        {isPlaying ? (
          <div className="absolute bottom-3 right-3 rounded-sm bg-black/60 px-2 py-1.5 backdrop-blur-sm">
            <EqualizerBars color={stage.accent} size="sm" />
          </div>
        ) : null}
      </div>

      {/* Track metadata — center-aligned, scaled for arm's length */}
      <div className="w-full max-w-md text-center">
        {track ? (
          <>
            <h2 className="line-clamp-2 font-sans text-2xl font-semibold leading-tight text-[--color-text] md:text-3xl">
              {track.title}
            </h2>
            <p className="mt-2 truncate font-serif text-lg italic text-[--color-text-soft] md:text-xl">
              {track.artist}
            </p>
            <p className="mt-1.5 truncate font-mono text-[11px] uppercase tracking-wider text-[--color-text-faint]">
              {track.album}
              {typeof track.albumYear === "number" ? ` · ${track.albumYear}` : ""}
            </p>
          </>
        ) : (
          <>
            <h2 className="font-sans text-2xl font-semibold text-[--color-text] md:text-3xl">
              {placeholderTitle(status)}
            </h2>
            <p className="mt-2 font-serif text-base italic text-[--color-text-soft]">
              {placeholderSubtitle(status, stage)}
            </p>
          </>
        )}
      </div>

      {/* Progress bar — only when we have a real track */}
      {track && startedAt !== null && status === "playing" ? (
        <div className="mt-10 w-full max-w-md">
          <TrackProgress
            startedAt={startedAt}
            durationSec={track.durationSec}
            accent={stage.accent}
          />
        </div>
      ) : null}

      {/* Play/pause — large, accent-ringed, the festival hero button */}
      <div className="mt-10">
        <button
          type="button"
          onClick={onTogglePlay}
          aria-label={isPlaying ? "Pause" : isThisStageActive ? "Resume" : "Play"}
          aria-pressed={isPlaying}
          className="group relative flex size-20 items-center justify-center rounded-full transition-all duration-200 hover:scale-105 active:scale-95 md:size-24"
          style={{
            border: `2px solid ${stage.accent}`,
            backgroundColor: isPlaying
              ? `${stage.accent}20`
              : `${stage.accent}0d`,
            boxShadow: isPlaying ? `0 0 40px ${stage.accent}33` : `0 0 20px ${stage.accent}1a`,
          }}
        >
          {isLoading ? (
            <svg width="34" height="34" viewBox="0 0 24 24" className="animate-spin" aria-hidden="true">
              <circle
                cx="12"
                cy="12"
                r="9"
                stroke="rgba(232,221,212,0.2)"
                strokeWidth="2"
                fill="none"
              />
              <path
                d="M21 12a9 9 0 0 0-9-9"
                stroke={stage.accent}
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          ) : isPlaying ? (
            <svg viewBox="0 0 24 24" width="32" height="32" fill={stage.accent} aria-hidden="true">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              width="36"
              height="36"
              fill={stage.accent}
              aria-hidden="true"
              className="ml-1.5"
            >
              <path d="M8 5.14v13.72L19 12 8 5.14z" />
            </svg>
          )}
        </button>

        {/* Status caption under the button */}
        <p
          className="mt-4 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-[--color-text-faint]"
          aria-live="polite"
        >
          {captionForState(displayState, isThisStageActive)}
        </p>
      </div>
    </div>
  );
}

function placeholderTitle(status: NowPlayingPayload["status"]): string {
  switch (status) {
    case "curating":
      return "between tracks";
    case "starting":
      return "warming up";
    case "stopping":
      return "winding down";
    case "stopped":
      return "off air";
    case "playing":
      return "loading next…";
    default:
      return "—";
  }
}

function placeholderSubtitle(
  status: NowPlayingPayload["status"],
  stage: Stage,
): string {
  switch (status) {
    case "curating":
      return "fallback loop is on the wire";
    case "starting":
      return `bringing ${stage.fallbackTitle.toLowerCase()} online`;
    case "stopping":
      return "supervisor is shutting down";
    case "stopped":
      return "the room is dark";
    case "playing":
      return "the next track will land in a moment";
    default:
      return "";
  }
}

function captionForState(
  state: import("../audio/PlaybackProvider.tsx").PlaybackState,
  isThisStageActive: boolean,
): string {
  if (!isThisStageActive) return "tap play to switch here";
  switch (state) {
    case "playing":
      return "● now playing";
    case "loading":
      return "buffering…";
    case "paused":
      return "paused — tap to resume";
    case "error":
      return "playback error";
    case "idle":
      return "tap play to listen";
  }
}

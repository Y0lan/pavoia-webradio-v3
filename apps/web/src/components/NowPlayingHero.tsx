import { useEffect, useState } from "react";
import type { NowPlaying as NowPlayingPayload, Stage } from "@pavoia/shared";

import { usePlayback } from "../audio/PlaybackProvider.tsx";
import { useArtistDrawer } from "./ArtistDrawer.tsx";
import { CoverImage } from "./CoverImage.tsx";
import { EqualizerBars } from "./EqualizerBars.tsx";

/* Estimated HLS live latency for our 3-second-segment / 6-segment-window
   engine setup with hls.js's `liveSyncDurationCount: 3`. The bar
   subtracts this when this stage is the actively-playing one so the
   visual progress matches what the listener actually hears, instead
   of the engine's "now"-cursor that's ~10 s ahead of the speaker. */
const HLS_AUDIO_LATENCY_SEC = 10;

/* Local TrackProgress — small enough to inline. Updates every second
   from `startedAt`, clamps to [0, durationSec], renders a thin accent
   bar with mono timestamps below.

   `audioOffsetSec` accounts for the gap between when the engine puts
   a segment on the wire and when the listener actually hears it
   (HLS live = ~3 segments * 3 s + fetch latency ≈ 10 s). When this
   stage is the active one in the player, we show the LISTENER's
   position, not the engine's — otherwise the progress bar is ~10 s
   ahead of what they're hearing. */
function TrackProgress({
  startedAt,
  durationSec,
  accent,
  audioOffsetSec,
}: {
  startedAt: number;
  durationSec: number;
  accent: string;
  audioOffsetSec: number;
}) {
  const [elapsedSec, setElapsedSec] = useState(() =>
    computeElapsed(startedAt, durationSec, audioOffsetSec),
  );
  useEffect(() => {
    setElapsedSec(computeElapsed(startedAt, durationSec, audioOffsetSec));
    const id = setInterval(() => {
      setElapsedSec(computeElapsed(startedAt, durationSec, audioOffsetSec));
    }, 1_000);
    return () => clearInterval(id);
  }, [startedAt, durationSec, audioOffsetSec]);

  const pct =
    durationSec > 0
      ? Math.min(100, Math.max(0, (elapsedSec / durationSec) * 100))
      : 0;

  return (
    <div className="space-y-2">
      <div
        className="h-[2px] overflow-hidden rounded-full bg-[var(--color-bg-soft)]"
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
      <div className="flex justify-between font-mono text-[10px] tabular-nums text-[var(--color-text-faint)]">
        <span>{formatTime(elapsedSec)}</span>
        <span>{formatTime(durationSec)}</span>
      </div>
    </div>
  );
}

function computeElapsed(
  startedAt: number,
  durationSec: number,
  audioOffsetSec: number,
): number {
  const sec = Math.max(0, (Date.now() - startedAt) / 1000 - audioOffsetSec);
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
  const { openArtist } = useArtistDrawer();
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
    <div className="flex h-full flex-col items-center overflow-hidden px-6 py-3 md:px-8 md:py-5">
      {/* Stage label (mono, prefixed with //) */}
      <div className="mb-2 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--color-text-faint)]">
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
          {isPlaying ? "on air" : "off"} · stage {String(stage.order + 1).padStart(2, "0")}
        </span>
      </div>

      {/* Stage title */}
      <h1
        className="font-serif text-3xl italic leading-tight text-[var(--color-text)] md:text-4xl"
      >
        {stage.fallbackTitle.toLowerCase()}
      </h1>

      {/* Stage description — full text, not truncated. Sidebar shows
          a one-clause preview; the page is where the room's vibe
          gets to breathe. */}
      <p className="mt-2 max-w-md text-balance text-center font-sans text-sm leading-relaxed text-[var(--color-text-soft)]">
        {stage.fallbackDescription}
      </p>

      {/* Cover art — flex-1 absorbs the remaining vertical space and
          centers the cover in it. The cover itself is sized via a
          viewport-aware max-width so it scales down on shorter
          screens (dvh aware) and never overflows wide containers. */}
      <div className="relative my-2 flex w-full flex-1 items-center justify-center md:my-3">
        <CoverImage
          plexCoverUrl={track?.coverUrl}
          className="aspect-square w-full rounded-sm shadow-2xl ring-1 ring-[var(--color-card-border-strong)]"
          loading="eager"
          style={{
            // Cap to whichever is smaller: 80% of viewport width, or
            // the vertical room left after the title block + meta +
            // play button + persistent bar slack.
            maxWidth: "min(80vw, calc(100dvh - 420px))",
            // Vinyl gradient as the fallback backdrop (visible only
            // when the cover img isn't loaded yet / failed).
            backgroundImage: `
              radial-gradient(circle at 30% 30%, ${stage.gradient.from}, transparent 60%),
              radial-gradient(circle at 70% 70%, ${stage.gradient.via}, transparent 65%),
              ${stage.gradient.to}
            `,
          }}
          fallback={
            // Vinyl-record concentric circles, when no Plex thumb is
            // available or the image load failed.
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
              <div className="absolute inset-[48%] rounded-full bg-black" />
            </div>
          }
        />

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
            <h2 className="line-clamp-2 font-sans text-2xl font-semibold leading-tight text-[var(--color-text)] md:text-3xl">
              {track.title}
            </h2>
            {typeof track.artistRatingKey === "number" ? (
              <button
                type="button"
                onClick={() => openArtist(track.artistRatingKey!)}
                className="mt-2 truncate font-serif text-lg italic text-[var(--color-text-soft)] underline-offset-4 transition-colors hover:text-[var(--color-text)] hover:underline md:text-xl"
                aria-label={`Open ${track.artist} details`}
              >
                {track.artist}
              </button>
            ) : (
              <p className="mt-2 truncate font-serif text-lg italic text-[var(--color-text-soft)] md:text-xl">
                {track.artist}
              </p>
            )}
            <p className="mt-1.5 truncate font-mono text-[11px] uppercase tracking-wider text-[var(--color-text-faint)]">
              {track.album}
              {typeof track.albumYear === "number" ? ` · ${track.albumYear}` : ""}
            </p>
          </>
        ) : (
          <>
            <h2 className="font-sans text-2xl font-semibold text-[var(--color-text)] md:text-3xl">
              {placeholderTitle(status)}
            </h2>
            <p className="mt-2 font-serif text-base italic text-[var(--color-text-soft)]">
              {placeholderSubtitle(status, stage)}
            </p>
          </>
        )}
      </div>

      {/* Progress bar — only when we have a real track. When this
          stage is the actively playing one, apply HLS_AUDIO_LATENCY_SEC
          so the bar reflects what the listener is HEARING, not what
          the engine just emitted. When the stage is selected but not
          playing, show the engine's true progress (no offset). */}
      {track && startedAt !== null && status === "playing" ? (
        <div className="mt-3 w-full max-w-md">
          <TrackProgress
            startedAt={startedAt}
            durationSec={track.durationSec}
            accent={stage.accent}
            audioOffsetSec={isThisStageActive ? HLS_AUDIO_LATENCY_SEC : 0}
          />
        </div>
      ) : null}

      {/* Play/pause — large, accent-ringed, the festival hero button.
          Wrapper is items-center so button + caption both sit at the
          same horizontal center regardless of caption length. */}
      <div className="mt-3 flex flex-col items-center">
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
            // Play triangle is right-pointing, so its visual mass is
            // already biased to the left of the SVG canvas. Use a
            // viewBox that places the triangle's centroid at the SVG
            // center — no margin offset needed, button stays centered.
            <svg
              viewBox="2 2 20 20"
              width="36"
              height="36"
              fill={stage.accent}
              aria-hidden="true"
            >
              <path d="M8 5.14v13.72L19 12 8 5.14z" />
            </svg>
          )}
        </button>

        {/* Status caption under the button */}
        <p
          className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]"
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

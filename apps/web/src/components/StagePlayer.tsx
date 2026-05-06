import type { Stage } from "@pavoia/shared";

import { useHls } from "../audio/useHls.ts";
import { EqualizerBars } from "./EqualizerBars.tsx";
import { PlayPauseButton } from "./PlayPauseButton.tsx";

interface StagePlayerProps {
  stage: Stage;
  /** HLS m3u8 path (NowPlaying.streamUrl, e.g. /hls/opening/index.m3u8). */
  streamUrl: string;
}

/**
 * Hidden audio element + Play/Pause button + lightweight error
 * surface. One per stage detail page; stage switch unmounts and
 * recreates, which destroys the underlying Hls.js instance and
 * fully releases the network buffer.
 */
export function StagePlayer({ stage, streamUrl }: StagePlayerProps) {
  const { audioRef, state, error, play, pause } = useHls(streamUrl);

  return (
    <div className="flex items-center gap-5">
      <PlayPauseButton
        state={state}
        accent={stage.accent}
        onPlay={() => {
          void play();
        }}
        onPause={pause}
      />
      {/* Live region so screen readers announce state transitions
          (buffering, paused, playback error) without needing focus
          on the button. polite + atomic = read the full status text
          when it changes, don't interrupt mid-utterance. */}
      <div
        className="min-w-0 flex-1"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="flex items-center gap-2">
          {state === "playing" ? (
            <EqualizerBars color={stage.accent} />
          ) : null}
          <div className="text-sm font-medium text-slate-200">
            {labelForState(state, stage)}
          </div>
        </div>
        {error ? (
          <p className="mt-0.5 truncate text-xs text-rose-400/80">{error}</p>
        ) : null}
      </div>
      <audio
        ref={audioRef}
        preload="none"
        // We render no native controls — PlayPauseButton is the only
        // affordance. crossOrigin "anonymous" is required for hls.js
        // to fetch segments via fetch() when CORS is needed. Engine
        // serves /hls/* with permissive CORS via createHlsHandler.
        crossOrigin="anonymous"
        className="sr-only"
      />
    </div>
  );
}

function labelForState(
  state: ReturnType<typeof useHls>["state"],
  stage: Stage,
): string {
  switch (state) {
    case "playing":
      return `Streaming ${stage.fallbackTitle}`;
    case "loading":
      return "Buffering…";
    case "paused":
      return "Paused";
    case "error":
      return "Playback error";
    case "idle":
      return "Press play to listen";
  }
}

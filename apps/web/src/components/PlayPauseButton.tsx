import type { PlaybackState } from "../audio/useHls.ts";

interface PlayPauseButtonProps {
  state: PlaybackState;
  accent: string;
  onPlay: () => void;
  onPause: () => void;
  /** Disabled when the underlying stream URL isn't yet available. */
  disabled?: boolean;
}

/**
 * Single circular button with three visual states:
 *   - idle / paused / error → play triangle (accent-colored fill)
 *   - loading             → spinner ring
 *   - playing             → pause bars
 *
 * v1's button had finer-grained loading detection but for radio's
 * essentially-binary user model (you're listening or you're not),
 * this is simpler and the listener gets exactly the affordance they
 * expected. Slice E adds an EqualizerBars decoration for the
 * "playing" state.
 */
export function PlayPauseButton({
  state,
  accent,
  onPlay,
  onPause,
  disabled = false,
}: PlayPauseButtonProps) {
  const isPlaying = state === "playing";
  const isLoading = state === "loading";

  const ariaLabel = isPlaying ? "Pause" : "Play";

  return (
    <button
      type="button"
      onClick={isPlaying ? onPause : onPlay}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={isPlaying}
      className="group relative flex h-16 w-16 items-center justify-center rounded-full border border-slate-700 bg-slate-900/80 text-slate-100 transition-all hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50 md:h-20 md:w-20"
      style={
        isPlaying
          ? {
              borderColor: accent,
              backgroundColor: `${accent}22`,
            }
          : undefined
      }
    >
      {isLoading ? <Spinner accent={accent} /> : null}
      {!isLoading && isPlaying ? <PauseIcon /> : null}
      {!isLoading && !isPlaying ? <PlayIcon accent={accent} /> : null}
    </button>
  );
}

function PlayIcon({ accent }: { accent: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill={accent}
      aria-hidden="true"
      className="ml-1 transition-transform group-hover:scale-110"
    >
      <path d="M8 5.14v13.72L19 12 8 5.14z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function Spinner({ accent }: { accent: string }) {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="animate-spin"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="#475569"
        strokeWidth="3"
        fill="none"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke={accent}
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

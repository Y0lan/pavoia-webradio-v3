import type { PlaybackState } from "../audio/PlaybackProvider.tsx";

interface PlayPauseButtonProps {
  state: PlaybackState;
  accent: string;
  onPlay: () => void;
  onPause: () => void;
  disabled?: boolean;
  /** "lg" for the StageDetailPage hero (~80 px); "md" for inline use. */
  size?: "md" | "lg";
}

/**
 * Round play/pause with the GAENDE accent ring + soft glow when
 * playing. No card chrome — the button IS the affordance, lets the
 * stage's gradient backdrop show through.
 *
 * Three visual states:
 *   - idle / paused / error → play triangle
 *   - loading              → spinner ring
 *   - playing              → pause bars
 */
export function PlayPauseButton({
  state,
  accent,
  onPlay,
  onPause,
  disabled = false,
  size = "md",
}: PlayPauseButtonProps) {
  const isPlaying = state === "playing";
  const isLoading = state === "loading";
  const ariaLabel = isPlaying ? "Pause" : "Play";

  const dim = size === "lg" ? 80 : 56;
  const iconSize = size === "lg" ? 32 : 22;
  const ariaPressedAttr =
    state === "playing" ? "true" : state === "paused" ? "false" : undefined;

  return (
    <button
      type="button"
      onClick={isPlaying ? onPause : onPlay}
      disabled={disabled}
      aria-label={ariaLabel}
      {...(ariaPressedAttr !== undefined ? { "aria-pressed": ariaPressedAttr } : {})}
      className="group relative flex items-center justify-center rounded-full transition-all duration-200 hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        width: dim,
        height: dim,
        border: `2px solid ${accent}`,
        backgroundColor: isPlaying ? `${accent}20` : `${accent}0d`,
        boxShadow: isPlaying ? `0 0 24px ${accent}33` : `0 0 12px ${accent}1a`,
      }}
    >
      {isLoading ? (
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="animate-spin"
        >
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
            stroke={accent}
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      ) : isPlaying ? (
        <svg
          viewBox="0 0 24 24"
          width={iconSize}
          height={iconSize}
          fill={accent}
          aria-hidden="true"
        >
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
        </svg>
      ) : (
        // Tighter viewBox so the right-pointing triangle's centroid
        // lands on the SVG center — keeps the button visually
        // balanced without a left/right margin hack.
        <svg
          viewBox="2 2 20 20"
          width={iconSize + 2}
          height={iconSize + 2}
          fill={accent}
          aria-hidden="true"
        >
          <path d="M8 5.14v13.72L19 12 8 5.14z" />
        </svg>
      )}
    </button>
  );
}

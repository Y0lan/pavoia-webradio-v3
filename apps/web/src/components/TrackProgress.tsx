import { useEffect, useState } from "react";

interface TrackProgressProps {
  /** Wall-clock ms when the track started playing (NowPlaying.startedAt). */
  startedAt: number;
  /** Track duration in seconds (PublicTrack.durationSec). */
  durationSec: number;
  /** Accent color for the progress fill (stage.accent). */
  accent: string;
}

/**
 * Local elapsed-time ticker driven from `startedAt` rather than from
 * server polls — so the bar moves smoothly between 5 s /now refetches.
 *
 * Updates once per second; that's enough resolution for a track-length
 * bar and avoids re-renders on every animation frame.
 *
 * Out-of-range elapsed values (negative if startedAt is in the future,
 * or >duration if a poll missed the boundary) are clamped to [0, dur]
 * so the bar never overflows.
 */
export function TrackProgress({
  startedAt,
  durationSec,
  accent,
}: TrackProgressProps) {
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
    <div className="space-y-1.5">
      <div
        className="h-1 overflow-hidden rounded-full bg-slate-800"
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
      <div className="flex justify-between text-xs tabular-nums text-slate-400">
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

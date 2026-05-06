interface EqualizerBarsProps {
  /** Color of the bars. Usually the stage's accent. */
  color: string;
  /** Width of each bar (Tailwind class fragment OK; defaults to "0.5"). */
  size?: "sm" | "md";
}

/**
 * Decorative four-bar pulsing animation used as a "stage is live"
 * affordance next to the play button. Pure visual — no audio
 * analysis. v1 had the same pattern; we use CSS animation-delay
 * staggers instead of v1's inline keyframes so Tailwind 4 can
 * inline + minify the tokens.
 *
 * Each bar pulses on its own offset with a different period so the
 * pattern feels organic rather than mechanical.
 */
export function EqualizerBars({ color, size = "md" }: EqualizerBarsProps) {
  const barWidth = size === "sm" ? "w-0.5" : "w-1";
  const containerWidth = size === "sm" ? "w-4" : "w-5";

  return (
    <div
      className={`flex h-5 ${containerWidth} items-end justify-between`}
      aria-hidden="true"
    >
      {BARS.map((bar) => (
        <span
          key={bar.key}
          className={`${barWidth} animate-eq-bar rounded-t-sm`}
          style={{
            backgroundColor: color,
            animationDuration: bar.duration,
            animationDelay: bar.delay,
          }}
        />
      ))}
    </div>
  );
}

const BARS = [
  { key: "a", duration: "0.9s", delay: "0s" },
  { key: "b", duration: "1.2s", delay: "0.15s" },
  { key: "c", duration: "1.0s", delay: "0.30s" },
  { key: "d", duration: "1.4s", delay: "0.05s" },
];

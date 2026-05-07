import { useStages } from "../api/stages.ts";

/**
 * Landing screen — the eye as the festival's identity, dropped on
 * a slow drifting backdrop. Mood the listener walks into before
 * they pick a stage.
 */
export function HomePage() {
  const { data: stages, isLoading, isError } = useStages();
  const audioStages = (stages ?? []).filter((s) => !s.disabled);

  return (
    <section className="relative h-full overflow-hidden">
      {/* Slow drifting mood backdrop — union of stage palettes so the
          home screen feels like the festival's whole night. */}
      <div
        className="absolute inset-0 opacity-40 animate-mood-shift"
        style={{
          backgroundImage:
            "linear-gradient(125deg, #2d1b4e 0%, #1a0d14 25%, #3d2a0a 50%, #1a1010 75%, #2d1b4e 100%)",
          backgroundSize: "240% 240%",
        }}
      />
      {/* Vignette */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 30%, rgba(8,5,5,0.7) 100%)",
        }}
      />

      <div className="relative z-10 flex h-full flex-col items-center px-6 py-5 md:px-12 md:py-8">
        {/* Tiny caption strip — not the hero anymore, just signage */}
        <p className="self-start font-mono text-[11px] tracking-[0.06em] text-[var(--color-text-soft)]">
          <span className="text-[var(--color-accent-dim)]">//</span>{" "}
          pâvoia · webradio · est. 2026 · curated by{" "}
          <span className="text-[var(--color-accent)]">gaende</span>
        </p>

        {/* The eye — BIG, the festival's mark. Wrapped in a slowly
            pulsing radial glow so it looks alive even before the
            GIF blinks. */}
        <div className="relative my-auto flex flex-col items-center">
          <div
            className="absolute inset-0 -z-10 animate-glow-pulse"
            style={{
              background:
                "radial-gradient(circle at center, rgba(232,80,32,0.22) 0%, rgba(232,80,32,0.08) 30%, transparent 65%)",
              transform: "scale(1.6)",
            }}
            aria-hidden="true"
          />
          <img
            src="/pavoia-logo.gif"
            alt="Pâvoia"
            className="h-[clamp(180px,38vh,360px)] w-auto"
            style={{
              filter:
                "drop-shadow(0 0 40px rgba(232,80,32,0.35)) drop-shadow(0 0 80px rgba(232,80,32,0.18))",
            }}
          />

          <p className="mt-5 text-balance text-center font-script text-3xl leading-snug text-[var(--color-text)] md:text-4xl">
            eleven stages, one night,{" "}
            <span className="text-[var(--color-text-soft)]">
              picked apart from the algorithm.
            </span>
          </p>
        </div>

        {/* CTA strip — bottom of viewport */}
        <div className="flex items-center gap-3">
          <span
            className="animate-blink font-mono text-sm text-[var(--color-accent)]"
            aria-hidden="true"
          >
            ▸
          </span>
          <p className="font-mono text-[12px] uppercase tracking-[0.18em] text-[var(--color-text-soft)]">
            {isLoading
              ? "loading stages…"
              : isError
                ? "engine offline · check the sidebar"
                : `pick a stage — ${audioStages.length} live`}
          </p>
        </div>
      </div>
    </section>
  );
}

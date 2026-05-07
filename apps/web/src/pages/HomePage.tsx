import { useStages } from "../api/stages.ts";

/**
 * Landing screen — typographic poster with the GAENDE wordmark
 * treatment. Slow ambient gradient drift in the background, scanlines
 * + grain layered on top by the body. The mood the listener walks
 * into before they pick a stage.
 */
export function HomePage() {
  const { data: stages, isLoading, isError } = useStages();
  const audioStages = (stages ?? []).filter((s) => !s.disabled);

  return (
    <section className="relative h-full overflow-hidden">
      {/* Slow drifting mood backdrop — uses the union of stage palettes
          so the home screen feels like the festival's whole night. */}
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

      <div className="relative z-10 flex h-full flex-col px-6 py-6 md:px-12 md:py-10">
        {/* Top metadata strip */}
        <header className="font-mono text-[11px] tracking-[0.06em] text-[var(--color-text-soft)]">
          <span className="text-[var(--color-accent-dim)]">//</span>{" "}
          pavoia · webradio · est. 2026 · curated by{" "}
          <span className="text-[var(--color-accent)]">gaende</span>
        </header>

        {/* Hero — eleven stages, one night */}
        <div className="mt-auto">
          <h1
            className="font-mono font-bold leading-[0.85] tracking-[0.05em] text-[var(--color-accent)]"
            style={{
              fontSize: "clamp(2.5rem, 11vw, 8rem)",
              textShadow: "0 0 60px rgba(232,80,32,0.25)",
            }}
          >
            PAVOIA
          </h1>

          <p
            className="mt-4 max-w-xl font-serif text-2xl italic leading-snug text-[var(--color-text)] md:text-3xl"
          >
            eleven stages,
            <br />
            one night,
            <br />
            <span className="text-[var(--color-text-soft)]">
              picked apart from the algorithm.
            </span>
          </p>

          <p className="mt-5 max-w-md font-sans text-sm leading-relaxed text-[var(--color-text-soft)]">
            A curator's collection played as radio — full albums, hidden
            B-sides, forgotten 90s vinyl, daily diggings. Tune into a
            stage, the rest of the night carries on around you.
          </p>

          <div className="mt-6 flex items-center gap-3">
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
      </div>
    </section>
  );
}

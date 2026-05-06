import { useParams } from "@tanstack/react-router";

import { useStages } from "../api/stages.ts";
import { useStageNow } from "../api/now.ts";
import { NowPlayingHero } from "../components/NowPlayingHero.tsx";

/**
 * Per-stage takeover. The whole page is the now-playing experience
 * for this stage — atmospheric per-stage gradient backdrop, big
 * hero typography, big play button. Spotify-style now-playing,
 * GAENDE-aesthetic.
 */
export function StageDetailPage() {
  const { stageId } = useParams({ from: "/stage/$stageId" });
  const { data: stages, isLoading: stagesLoading, isError: stagesError } =
    useStages();
  const { data: now, error: nowError } = useStageNow(stageId);

  if (stagesLoading || (!stagesError && !stages)) {
    return (
      <section className="px-8 py-12">
        <p className="font-mono text-xs uppercase tracking-wider text-[--color-text-faint]">
          // loading stage…
        </p>
      </section>
    );
  }

  if (stagesError) {
    return (
      <section className="px-8 py-12">
        <h2 className="font-serif text-2xl italic text-[--color-text]">
          engine unreachable
        </h2>
        <p className="mt-2 font-sans text-sm text-[--color-text-soft]">
          Can't load stage <code className="font-mono text-[--color-accent]">{stageId}</code> right now.
          See the sidebar for diagnostics.
        </p>
      </section>
    );
  }

  const stage = stages?.find((s) => s.id === stageId);

  if (!stage || stage.disabled) {
    return (
      <section className="px-8 py-12">
        <h2 className="font-serif text-2xl italic text-[--color-text]">
          {stage?.disabled ? "stage unavailable" : "stage not found"}
        </h2>
        <p className="mt-2 font-sans text-sm text-[--color-text-soft]">
          {stage?.disabled ? (
            <>
              Stage <code className="font-mono text-[--color-accent]">{stageId}</code> has no audio (UI-only).
            </>
          ) : (
            <>
              No stage with id <code className="font-mono text-[--color-accent]">{stageId}</code>.
            </>
          )}
        </p>
      </section>
    );
  }

  return (
    <section className="relative min-h-dvh overflow-hidden">
      {/* Atmosphere — per-stage gradient + grain. Each stage is its
          own room; the whole page changes mood. */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 100% 70% at 25% 15%, ${stage.gradient.from}b3, transparent 55%),
            radial-gradient(ellipse 80% 90% at 80% 90%, ${stage.gradient.via}99, transparent 50%),
            ${stage.gradient.to}
          `,
        }}
      />
      {/* Vignette pulls focus to the center */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 30%, rgba(8,5,5,0.65) 100%)",
        }}
      />

      <div className="relative z-10">
        {!now ? (
          <p className="px-8 py-12 font-mono text-xs uppercase tracking-wider text-[--color-text-faint]">
            // loading current track…
            {nowError ? (
              <span className="ml-2 text-[--color-amber]">
                · {nowError instanceof Error ? nowError.message : "error"}
              </span>
            ) : null}
          </p>
        ) : (
          <NowPlayingHero
            stage={stage}
            payload={now}
            streamUrl={now.streamUrl}
          />
        )}
        {nowError ? (
          <p className="mt-2 px-8 text-center font-mono text-[10px] uppercase tracking-wider text-[--color-amber]">
            // live updates stalled — last good snapshot shown
          </p>
        ) : null}
      </div>
    </section>
  );
}

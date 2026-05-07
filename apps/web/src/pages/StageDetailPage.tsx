import { useParams } from "@tanstack/react-router";

import { useStages } from "../api/stages.ts";
import { useStageNow } from "../api/now.ts";
import { NowPlayingHero } from "../components/NowPlayingHero.tsx";
import { StageAtmosphere } from "../components/StageAtmosphere.tsx";

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
        <p className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-faint)]">
          // loading stage…
        </p>
      </section>
    );
  }

  if (stagesError) {
    return (
      <section className="px-8 py-12">
        <h2 className="font-serif text-2xl italic text-[var(--color-text)]">
          engine unreachable
        </h2>
        <p className="mt-2 font-sans text-sm text-[var(--color-text-soft)]">
          Can't load stage <code className="font-mono text-[var(--color-accent)]">{stageId}</code> right now.
          See the sidebar for diagnostics.
        </p>
      </section>
    );
  }

  const stage = stages?.find((s) => s.id === stageId);

  if (!stage || stage.disabled) {
    return (
      <section className="px-8 py-12">
        <h2 className="font-serif text-2xl italic text-[var(--color-text)]">
          {stage?.disabled ? "stage unavailable" : "stage not found"}
        </h2>
        <p className="mt-2 font-sans text-sm text-[var(--color-text-soft)]">
          {stage?.disabled ? (
            <>
              Stage <code className="font-mono text-[var(--color-accent)]">{stageId}</code> has no audio (UI-only).
            </>
          ) : (
            <>
              No stage with id <code className="font-mono text-[var(--color-accent)]">{stageId}</code>.
            </>
          )}
        </p>
      </section>
    );
  }

  return (
    <section className="relative min-h-dvh overflow-hidden">
      {/* Atmospheric backdrop — blurred cover (when available) +
          breathing gradient orbs in the stage's palette + vignette.
          Drives the page's mood; foreground content sits above it. */}
      <StageAtmosphere
        stage={stage}
        plexCoverUrl={now?.track?.coverUrl}
      />

      <div className="relative z-10">
        {!now ? (
          <p className="px-8 py-12 font-mono text-xs uppercase tracking-wider text-[var(--color-text-faint)]">
            // loading current track…
            {nowError ? (
              <span className="ml-2 text-[var(--color-amber)]">
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
          <p className="mt-2 px-8 text-center font-mono text-[10px] uppercase tracking-wider text-[var(--color-amber)]">
            // live updates stalled — last good snapshot shown
          </p>
        ) : null}
      </div>
    </section>
  );
}

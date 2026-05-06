import { useParams } from "@tanstack/react-router";

import { lazy, Suspense } from "react";

import { useStages } from "../api/stages.ts";
import { useStageNow } from "../api/now.ts";
import { NowPlaying } from "../components/NowPlaying.tsx";

// Lazy-load the player + hls.js so the home and sidebar bundles
// don't pay the ~500 KB HLS cost. Only listeners who navigate to
// a stage detail page pull in the audio code.
const StagePlayer = lazy(async () => {
  const mod = await import("../components/StagePlayer.tsx");
  return { default: mod.StagePlayer };
});

/**
 * Per-stage detail page. Slice C will fill this with a NowPlaying
 * card driven by /api/stages/:id/now polling. Slice D adds audio
 * playback. For Slice B all we ship is the layout + correct stage
 * resolution from the URL.
 */
export function StageDetailPage() {
  const { stageId } = useParams({ from: "/stage/$stageId" });
  const { data: stages, isLoading, isError } = useStages();

  // While useStages is still resolving, render a quiet loading state
  // instead of flashing "Stage not found" before the data lands.
  if (isLoading || (!isError && !stages)) {
    return (
      <section className="px-8 py-12">
        <p className="text-sm text-slate-500">Loading stage…</p>
      </section>
    );
  }

  // Engine unreachable — Sidebar shows the verbose error; here we
  // just say enough to avoid confusion.
  if (isError) {
    return (
      <section className="px-8 py-12">
        <h2 className="text-xl font-semibold text-slate-200">
          Engine unreachable
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          Can't load stage <code className="text-slate-300">{stageId}</code>{" "}
          right now. See the sidebar for diagnostics.
        </p>
      </section>
    );
  }

  const stage = stages?.find((s) => s.id === stageId);

  // Disabled stages (Bus) intentionally don't have a detail page.
  // Block direct URL navigation to keep the sidebar and routing in
  // sync — Slice F will route /stage/bus to a separate easter-egg
  // dialog instead.
  if (!stage || stage.disabled) {
    return (
      <section className="px-8 py-12">
        <h2 className="text-xl font-semibold text-slate-200">
          {stage?.disabled ? "Stage unavailable" : "Stage not found"}
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          {stage?.disabled ? (
            <>
              Stage <code className="text-slate-300">{stageId}</code> has no
              audio (UI-only).
            </>
          ) : (
            <>
              No stage with id <code className="text-slate-300">{stageId}</code>.
            </>
          )}
        </p>
      </section>
    );
  }

  return (
    <section
      className="relative min-h-dvh overflow-hidden"
      style={{
        // Subtle gradient backdrop using the stage's own palette.
        // Heavy on the via/to ends so foreground text stays readable.
        background: `radial-gradient(ellipse at top, ${stage.gradient.from}66 0%, ${stage.gradient.via}88 40%, ${stage.gradient.to} 100%)`,
      }}
    >
      <div className="relative z-10 px-8 py-12 md:px-16 md:py-20">
        <div className="flex items-baseline gap-4">
          <span className="text-5xl leading-none">{stage.icon}</span>
          <h2 className="text-3xl font-bold text-slate-100 md:text-4xl">
            {stage.fallbackTitle}
          </h2>
        </div>
        <p className="mt-3 max-w-prose text-base text-slate-300/90">
          {stage.fallbackDescription}
        </p>

        <div className="mt-12">
          <StageNowSection stageId={stage.id} stage={stage} />
        </div>
      </div>
    </section>
  );
}

interface StageNowSectionProps {
  stageId: string;
  stage: import("@pavoia/shared").Stage;
}

function StageNowSection({ stageId, stage }: StageNowSectionProps) {
  const { data, isLoading, error } = useStageNow(stageId);

  if (isLoading) {
    return (
      <article className="rounded-2xl border border-slate-800/60 bg-black/40 p-6 backdrop-blur-sm md:p-8">
        <p className="text-sm text-slate-500">Loading current track…</p>
      </article>
    );
  }

  // The blocking error state only fires on initial-load failure
  // (data is undefined). TanStack Query keeps the last successful
  // snapshot in `data` across transient refetch errors, so a 5 s
  // poll that flakes mid-listen doesn't replace the live card with
  // an error panel. The lower-corner badge still surfaces "stale"
  // so the listener knows the timestamp may be lagging.
  if (!data) {
    return (
      <article className="rounded-2xl border border-rose-900/60 bg-rose-950/20 p-6 backdrop-blur-sm md:p-8">
        <p className="text-sm font-medium text-rose-300">
          Couldn't load the current track for this stage.
        </p>
        <p className="mt-1 text-xs text-rose-400/80">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </article>
    );
  }

  return (
    <>
      <div className="rounded-2xl border border-slate-800/60 bg-black/40 p-6 backdrop-blur-sm md:p-8">
        <Suspense
          fallback={
            <p className="text-sm text-slate-500">Loading player…</p>
          }
        >
          <StagePlayer stage={stage} streamUrl={data.streamUrl} />
        </Suspense>
      </div>
      <div className="mt-4">
        <NowPlaying stage={stage} payload={data} />
      </div>
      {error ? (
        <p className="mt-2 text-xs text-amber-300/80">
          ⚠ Live updates are stalled (engine unreachable). Track shown is
          the last good snapshot.
        </p>
      ) : null}
    </>
  );
}

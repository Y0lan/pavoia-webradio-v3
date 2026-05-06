import { useParams } from "@tanstack/react-router";

import { useStages } from "../api/stages.ts";

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

  if (!stage) {
    return (
      <section className="px-8 py-12">
        <h2 className="text-xl font-semibold text-slate-200">
          Stage not found
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          No stage with id <code className="text-slate-300">{stageId}</code>.
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

        <div className="mt-12 rounded-2xl border border-slate-800/60 bg-black/30 px-6 py-8 backdrop-blur-sm">
          <p className="text-sm text-slate-400">
            <span
              className="mr-2 inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: stage.accent }}
            />
            now-playing card lands in Slice C; audio in Slice D.
          </p>
        </div>
      </div>
    </section>
  );
}

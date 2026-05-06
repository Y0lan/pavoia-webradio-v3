import { useStages } from "../api/stages.ts";

/**
 * Landing page when no stage is selected. v1's equivalent showed a
 * default stream playing immediately; v3 starts in a "pick a stage"
 * state so the listener's first interaction is intentional.
 */
export function HomePage() {
  const { data: stages, isLoading, isError } = useStages();

  // Tagline copy depends on whether we successfully reached the engine.
  // The Sidebar shows a verbose error UI when isError is true; here we
  // just degrade to a neutral prompt so we never flash a misleading
  // "0 stages broadcasting".
  let tagline: string;
  if (isLoading) {
    tagline = "Loading…";
  } else if (isError || !stages) {
    tagline = "Pick a stage from the sidebar to listen.";
  } else {
    const audioCount = stages.filter((s) => !s.disabled).length;
    tagline = `${audioCount} stages broadcasting from gaende's vault. Pick one to listen.`;
  }

  return (
    <section className="flex min-h-dvh items-center justify-center px-8 py-12">
      <div className="max-w-md text-center">
        <h2 className="bg-gradient-to-br from-fuchsia-300 via-amber-200 to-emerald-300 bg-clip-text text-3xl font-bold leading-tight text-transparent md:text-5xl">
          welcome to pavoia
        </h2>
        <p className="mt-4 text-balance text-sm text-slate-400 md:text-base">
          {tagline}
        </p>
      </div>
    </section>
  );
}

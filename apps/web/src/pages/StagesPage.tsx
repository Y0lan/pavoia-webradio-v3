import { useQuery } from "@tanstack/react-query";
import type { Stage } from "@pavoia/shared";

interface StagesBody {
  readonly stages: readonly Stage[];
}

async function fetchStages(): Promise<StagesBody> {
  const res = await fetch("/api/stages");
  if (!res.ok) {
    throw new Error(`/api/stages failed: HTTP ${res.status}`);
  }
  return (await res.json()) as StagesBody;
}

export function StagesPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["stages"],
    queryFn: fetchStages,
  });

  if (isLoading) {
    return (
      <main className="min-h-dvh p-8">
        <h1 className="text-2xl font-semibold">Pavoia</h1>
        <p className="mt-4 text-slate-400">Loading stages…</p>
      </main>
    );
  }

  if (isError) {
    return (
      <main className="min-h-dvh p-8">
        <h1 className="text-2xl font-semibold">Pavoia</h1>
        <p className="mt-4 text-rose-400">
          Failed to reach the engine. Is the SSH tunnel open?
        </p>
        <pre className="mt-2 text-sm text-slate-400">
          {error instanceof Error ? error.message : String(error)}
        </pre>
      </main>
    );
  }

  const stages = data?.stages ?? [];

  return (
    <main className="min-h-dvh p-8">
      <h1 className="text-2xl font-semibold">Pavoia</h1>
      <p className="mt-2 text-slate-400">
        {stages.length} stages, {stages.filter((s) => !s.disabled).length}{" "}
        audio streams
      </p>
      <ul className="mt-6 space-y-2">
        {stages.map((stage) => (
          <li
            key={stage.id}
            className="rounded-lg border border-slate-700 px-4 py-3"
            style={{
              borderLeftColor: stage.accent,
              borderLeftWidth: "4px",
            }}
          >
            <div className="flex items-baseline gap-3">
              <span className="text-2xl">{stage.icon}</span>
              <span className="font-medium">{stage.fallbackTitle}</span>
              {stage.disabled ? (
                <span className="ml-auto text-xs uppercase tracking-wide text-slate-500">
                  disabled
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-slate-400">
              {stage.fallbackDescription}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}

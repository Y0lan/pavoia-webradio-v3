// Typed wrappers around the engine's HTTP API. Keep the network shape
// in one place so components don't sprinkle `fetch` calls + ad-hoc
// types across the tree.

import { useQuery } from "@tanstack/react-query";
import type { Stage } from "@pavoia/shared";

interface StagesBody {
  readonly stages: readonly Stage[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function fetchStages(): Promise<StagesBody> {
  const res = await fetch("/api/stages");
  if (!res.ok) {
    throw new ApiError(`/api/stages returned HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as StagesBody;
}

/**
 * Engine catalog of all stages. Static for the lifetime of the engine
 * process — TanStack's stale-while-revalidate is overkill here, but
 * the contract matches every other API call so `useQuery` is the
 * cleanest hook.
 *
 * Cache forever (Infinity staleTime) — operators restart the engine
 * to change the stage list, which means a page reload anyway.
 */
export function useStages() {
  return useQuery({
    queryKey: ["stages"],
    queryFn: fetchStages,
    staleTime: Infinity,
    select: (body) => body.stages,
  });
}

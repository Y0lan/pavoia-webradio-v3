import { useQuery } from "@tanstack/react-query";
import type { NowPlaying } from "@pavoia/shared";

import { ApiError } from "./stages.ts";

async function fetchNow(stageId: string): Promise<NowPlaying> {
  const res = await fetch(
    `/api/stages/${encodeURIComponent(stageId)}/now`,
  );
  if (!res.ok) {
    throw new ApiError(
      `/api/stages/${stageId}/now returned HTTP ${res.status}`,
      res.status,
    );
  }
  return (await res.json()) as NowPlaying;
}

/**
 * Polls /api/stages/:id/now every 5 s — matches v1's polling cadence
 * and the SLIM_V3 spec. TanStack Query handles the visibility-pause
 * automatically: when the tab goes hidden the interval halts, when
 * it returns we refetch immediately.
 *
 * Pass `null` to disable the query (e.g. PersistentPlayerBar before
 * anything has started playing). Hooks rules require the call to be
 * unconditional, so we just gate it via `enabled`.
 */
export function useStageNow(stageId: string | null) {
  return useQuery({
    queryKey: ["now", stageId ?? "__none__"],
    queryFn: () => fetchNow(stageId ?? ""),
    enabled: stageId !== null && stageId !== "",
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
  });
}

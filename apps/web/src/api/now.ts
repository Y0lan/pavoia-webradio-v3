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
 */
export function useStageNow(stageId: string) {
  return useQuery({
    queryKey: ["now", stageId],
    queryFn: () => fetchNow(stageId),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    // Treat the snapshot as fresh for one tick. If we leave staleTime
    // at the global 5 s default, focus events trigger a flood of
    // refetches; pinning to the interval keeps it predictable.
    staleTime: 5_000,
  });
}

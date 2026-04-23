// Periodic Plex playlist poller.
//
// Every `intervalMs` (default 60s per SLIM_V3 §"Audio engine"):
//   1. For each binding (stageId + plexPlaylistId), call
//      plexClient.fetchPlaylist().
//   2. Compare the new track set to the last known set BY ratingKey.
//   3. If the SET changed (additions/removals), call onTracksChanged
//      so the bootstrap layer can stop the old supervisor and start a
//      new one with the fresh tracks.
//   4. If only ORDER changed, do nothing — restarts are jarring and
//      the next track will play in the new order anyway.
//   5. Plex errors per stage go to onError but do not stop the poller.
//
// The poller does NOT know about supervisors / registries / startStage
// — that coupling lives in bootstrap. Keeps this module pure and
// testable without spawning ffmpeg.

import type { Track } from "@pavoia/shared";
import type { PlexApiError, PlexClient } from "../plex/client.ts";

export interface StageBinding {
  stageId: string;
  plexPlaylistId: number;
}

export interface PollerInput {
  plexClient: PlexClient;
  bindings: readonly StageBinding[];
  /** Default 60_000. Must be >= 1000 ms (enforced by config). */
  intervalMs: number;
  /**
   * Track sets the bootstrap layer already fetched at startup.
   * Without this, the FIRST tick would fire onTracksChanged for every
   * stage, restarting them all immediately.
   */
  initialTracks: ReadonlyMap<string, readonly Track[]>;
  /** Called when a stage's track SET (not order) has changed. */
  onTracksChanged: (
    stageId: string,
    tracks: readonly Track[],
  ) => void | Promise<void>;
  /** Called when fetching one stage fails. Default: no-op. The poller
   *  itself does not stop — next tick will retry. */
  onError?: (stageId: string, err: PlexApiError) => void;
  /** Injectable for tests. Default: real setInterval/clearInterval. */
  schedule?: (cb: () => void, ms: number) => () => void;
}

export interface PollerController {
  /** Stop scheduling future ticks. Resolves once any in-flight tick
   *  has finished (so callers can deterministically clean up). */
  stop(): Promise<void>;
}

export function startPlexPoller(input: PollerInput): PollerController {
  const {
    plexClient,
    bindings,
    intervalMs,
    initialTracks,
    onTracksChanged,
    onError = () => {},
    schedule = defaultSchedule,
  } = input;

  // Last-known ratingKey set per stage. Mutable across ticks.
  const lastKnown = new Map<string, ReadonlySet<number>>();
  for (const b of bindings) {
    const seed = initialTracks.get(b.stageId) ?? [];
    lastKnown.set(b.stageId, ratingKeySet(seed));
  }

  let stopped = false;
  let tickInFlight: Promise<void> | null = null;

  const tick = async () => {
    if (stopped) return;
    // Run all stage fetches in parallel — Plex handles concurrent
    // requests fine, and serializing would push tail latency past
    // the poll interval on a 10-stage stage list.
    await Promise.all(
      bindings.map((b) => pollOne(b)),
    );
  };

  const pollOne = async (b: StageBinding): Promise<void> => {
    let result;
    try {
      result = await plexClient.fetchPlaylist(b.plexPlaylistId);
    } catch (err) {
      // PlexApiError is what we expect; anything else is a programmer
      // bug we still want to surface but not crash the poller for.
      try {
        onError(b.stageId, err as PlexApiError);
      } catch {
        /* never let onError take the poller down */
      }
      return;
    }

    const next = ratingKeySet(result.tracks);
    const prev = lastKnown.get(b.stageId) ?? new Set<number>();
    if (setsEqual(prev, next)) return;

    lastKnown.set(b.stageId, next);
    try {
      await onTracksChanged(b.stageId, result.tracks);
    } catch {
      // onTracksChanged failures (e.g. supervisor restart hiccup)
      // mustn't kill the poller — next tick will detect the same
      // diff again and try once more.
    }
  };

  const cancel = schedule(() => {
    if (stopped) return;
    tickInFlight = tick().finally(() => {
      tickInFlight = null;
    });
  }, intervalMs);

  return {
    async stop() {
      if (stopped) {
        if (tickInFlight) await tickInFlight;
        return;
      }
      stopped = true;
      cancel();
      if (tickInFlight) await tickInFlight;
    },
  };
}

function ratingKeySet(tracks: readonly Track[]): ReadonlySet<number> {
  const s = new Set<number>();
  for (const t of tracks) s.add(t.plexRatingKey);
  return s;
}

function setsEqual<T>(
  a: ReadonlySet<T>,
  b: ReadonlySet<T>,
): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

function defaultSchedule(cb: () => void, ms: number): () => void {
  const handle = setInterval(cb, ms);
  return () => clearInterval(handle);
}

// Periodic Plex playlist poller.
//
// Every `intervalMs` (default 60s per SLIM_V3 §"Audio engine"):
//   1. For each binding (stageId + plexPlaylistId), call
//      plexClient.fetchPlaylist().
//   2. Compare the new track LIST (ordered) to the last known list.
//   3. If anything changed — additions, removals, OR reorders — call
//      onTracksChanged. The bootstrap layer routes that to the
//      supervisor's setTracks(), which queues the new list and applies
//      it at the next track boundary. Reorders matter: the curator's
//      intent for play order should be preserved, not silently
//      ignored.
//   4. Plex errors per stage go to onError but do not stop the poller.
//   5. lastKnown is updated only AFTER onTracksChanged resolves
//      successfully — so a transient supervisor-restart failure makes
//      the NEXT tick see the same diff and retry, rather than getting
//      stuck on an outdated track list forever.
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

  // Last-known ratingKey LIST (ordered) per stage. Mutable across
  // ticks. We compare lists, not sets, so curator reorders are
  // detected and forwarded to the supervisor.
  const lastKnown = new Map<string, readonly number[]>();
  for (const b of bindings) {
    const seed = initialTracks.get(b.stageId) ?? [];
    lastKnown.set(b.stageId, ratingKeyList(seed));
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

    const next = ratingKeyList(result.tracks);
    const prev = lastKnown.get(b.stageId) ?? [];
    if (listsEqual(prev, next)) return;

    try {
      await onTracksChanged(b.stageId, result.tracks);
      // Only commit lastKnown AFTER the callback succeeds. If
      // setTracks/restart failed (transient ffmpeg-spawn issue,
      // supervisor mid-shutdown, etc.), leaving lastKnown unchanged
      // means the NEXT tick sees the same diff and retries. Without
      // this ordering, a single failed update would strand the stage
      // on its previous queue until the process restarts.
      lastKnown.set(b.stageId, next);
    } catch {
      // onTracksChanged failures don't kill the poller — the diff
      // remains uncommitted and the next tick will retry.
    }
  };

  const cancel = schedule(() => {
    if (stopped) return;
    // Skip the tick if one is already in flight. setInterval doesn't
    // wait for async callbacks; a slow Plex response (our 10s default
    // timeout >> user's 1s minimum intervalMs) would otherwise start
    // overlapping fetches that race on lastKnown — an older response
    // could commit AFTER a newer one and revert a stage to a stale
    // list. Also preserves the invariant that stop() awaits THE ONE
    // in-flight promise.
    if (tickInFlight) return;
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

function ratingKeyList(tracks: readonly Track[]): readonly number[] {
  return tracks.map((t) => t.plexRatingKey);
}

function listsEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function defaultSchedule(cb: () => void, ms: number): () => void {
  const handle = setInterval(cb, ms);
  return () => clearInterval(handle);
}

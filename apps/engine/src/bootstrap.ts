// Wires every engine subsystem together for `index.ts`.
//
// Concretely: validated config → Plex client → for each audio stage,
// fetch its playlist + start a supervisor + register → 60 s Plex
// polling loop that swaps a stage's tracks when Plex changes →
// Hono app holding a reference to the registry.
//
// Kept separate from `index.ts` so it can be exercised by tests
// without binding a port. Tests inject a mock Plex client + mock
// `startStage` so the suite doesn't need ffmpeg or a Plex server.
//
// Errors during initial per-stage fetch are LOGGED, not fatal — a
// single broken Plex playlist must not prevent the other 9 stages
// from coming up. The poller will retry the broken stage on its next
// tick.

import path from "node:path";
import { Hono } from "hono";
import { AUDIO_STAGES, type Stage } from "@pavoia/shared";

import type { EngineConfig } from "./config.ts";
import { createApp } from "./app.ts";
import {
  createPlexClient,
  type PlexApiError,
  type PlexClient,
  type PlexClientConfig,
} from "./plex/index.ts";
import {
  createStageRegistry,
  startStage,
  type StageController,
  type StageEvent,
  type StageRegistry,
  type StartStageConfig,
} from "./stages/index.ts";
import {
  startPlexPoller,
  type PollerController,
  type StageBinding,
} from "./stages/poller.ts";

/** Subset of Plex client config the bootstrap layer derives from
 *  EngineConfig — extracted so tests can stub the client without
 *  reconstructing the env. */
type PlexClientFactoryInput = Pick<
  PlexClientConfig,
  "baseUrl" | "token" | "libraryRoot"
>;

export interface BootstrapInput {
  config: EngineConfig;
  /** Inject a pre-built Plex client (tests). When omitted, builds one
   *  from `config`. */
  plexClient?: PlexClient;
  /** Inject a custom Plex client factory (advanced tests). Ignored if
   *  `plexClient` is provided. */
  createPlexClientImpl?: (cfg: PlexClientFactoryInput) => PlexClient;
  /** Inject a custom startStage (tests). Default: real `startStage`. */
  startStageImpl?: typeof startStage;
  /** Inject a Plex poller scheduler (tests). Default: real setInterval. */
  pollerSchedule?: (cb: () => void, ms: number) => () => void;
  /** Engine event log sink. Default: console.log/console.error with
   *  `[engine]` / `[stage:<id>]` prefixes. */
  log?: (line: string) => void;
  /** Source of audio stages. Default: AUDIO_STAGES from @pavoia/shared.
   *  Tests use a smaller subset to keep parallelism bounded. */
  audioStages?: readonly Stage[];
}

export interface BootstrapResult {
  registry: StageRegistry;
  poller: PollerController;
  app: Hono;
  /** Stops the poller, then every supervisor in the registry. Safe to
   *  call multiple times. */
  shutdown(): Promise<void>;
}

export async function bootstrap(
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const {
    config,
    startStageImpl = startStage,
    log = (line) => console.log(line),
    audioStages = AUDIO_STAGES,
    pollerSchedule,
  } = input;

  const plexClient =
    input.plexClient ??
    (input.createPlexClientImpl ?? createPlexClient)({
      baseUrl: config.plexBaseUrl,
      token: config.plexToken,
      libraryRoot: config.libraryRoot,
    });

  const registry = createStageRegistry();

  // For each audio stage with a Plex playlist id, fetch + spawn.
  // Fetches run in PARALLEL — the Plex client's per-request timeout
  // is 10s and v3 has 10 audio stages, so a serial bootstrap could
  // delay HTTP bind + signal-handler install by up to ~100s on a
  // slow/down Plex. The watchdog would see HTTP 000 and a SIGTERM
  // mid-bootstrap couldn't reach already-spawned supervisors. Plex
  // handles concurrent reads fine and Whatbox is local-host fast in
  // production anyway.
  //
  // Per-stage failures are non-fatal: log + start with empty tracks
  // (→ curating mode), poller retries on its next tick.
  const initialTracks = new Map<string, readonly import("@pavoia/shared").Track[]>();
  const bindings: StageBinding[] = [];
  const stagesToBoot = audioStages.filter(
    (s): s is Stage & { plexPlaylistId: number } => s.plexPlaylistId !== null,
  );
  for (const stage of stagesToBoot) {
    bindings.push({ stageId: stage.id, plexPlaylistId: stage.plexPlaylistId });
  }
  const fetched = await Promise.all(
    stagesToBoot.map(async (stage) => {
      try {
        const result = await plexClient.fetchPlaylist(stage.plexPlaylistId);
        if (result.skipped > 0) {
          log(
            `[engine] stage=${stage.id} initial Plex fetch: ${result.tracks.length} tracks, ${result.skipped} skipped`,
          );
        } else {
          log(
            `[engine] stage=${stage.id} initial Plex fetch: ${result.tracks.length} tracks`,
          );
        }
        return { stage, tracks: result.tracks };
      } catch (err) {
        log(
          `[engine] stage=${stage.id} initial Plex fetch FAILED — starting in curating mode (poller will retry): ${formatErr(err)}`,
        );
        return {
          stage,
          tracks: [] as readonly import("@pavoia/shared").Track[],
        };
      }
    }),
  );
  // Most-recently-known tracks per stage. Updated by the poller and
  // used by the liveness watcher to revive a supervisor that died
  // unexpectedly without waiting for a Plex change.
  const knownTracks = new Map<string, readonly import("@pavoia/shared").Track[]>();

  let shuttingDown = false;

  function spawnAndWatch(
    stage: Stage,
    tracks: readonly import("@pavoia/shared").Track[],
  ): StageController {
    const controller = startStageImpl(
      buildStageConfig(stage, tracks, config, log),
    );
    registry.register(controller);
    // If the supervisor's run loop terminates unexpectedly (HLS dir
    // mkdir mid-run, fallback preflight invalidated post-startup,
    // etc.) AND we're not shutting down, immediately revive with the
    // last-known tracks. Without this, a stage that died while Plex
    // returned the same playlist would stay dead until the next
    // unrelated Plex edit OR engine restart.
    controller.done
      .then(() => {
        if (shuttingDown) return;
        // Only revive if the registered controller is still THIS one.
        // A `setTracks → done` racing a poller-driven restart is
        // possible; the most-recently-registered one wins.
        if (registry.get(stage.id) !== controller) return;
        const tracksNow = knownTracks.get(stage.id) ?? [];
        log(
          `[engine] stage=${stage.id} supervisor terminated unexpectedly — reviving with ${tracksNow.length} known tracks`,
        );
        spawnAndWatch(stage, tracksNow);
      })
      .catch(() => {
        // controller.done shouldn't reject (supervisor wraps loop in
        // .catch().finally()), but defensively swallow.
      });
    return controller;
  }

  for (const { stage, tracks } of fetched) {
    initialTracks.set(stage.id, tracks);
    knownTracks.set(stage.id, tracks);
    spawnAndWatch(stage, tracks);
  }

  // 60 s polling loop swaps a stage's tracks when Plex changes.
  const poller = startPlexPoller({
    plexClient,
    bindings,
    intervalMs: config.plexPollIntervalMs,
    initialTracks,
    onTracksChanged: async (stageId, tracks) => {
      const prev = registry.get(stageId);
      const stage = audioStages.find((s) => s.id === stageId);
      if (!stage) {
        log(
          `[engine] poller produced unknown stageId=${stageId} (programmer bug?), skipping`,
        );
        return;
      }
      // Always keep knownTracks current so the liveness watcher (in
      // spawnAndWatch above) can revive a dying supervisor with the
      // freshest playlist.
      knownTracks.set(stageId, tracks);
      // A controller that has reached "stopped" (fallback preflight
      // failure + crash cap + etc.) is already a dead ringer —
      // setTracks() on it would land in a run loop that has already
      // returned. Treat stopped same as missing so Plex updates can
      // bring a stage back to life without a full engine restart.
      if (prev && prev.status() !== "stopped") {
        // The existing supervisor stays alive — setTracks queues the
        // new list so the change applies at the next natural track
        // boundary (per SLIM_V3 §"Audio engine"). Listeners hear the
        // current track to completion, then the new queue.
        log(
          `[engine] stage=${stageId} Plex tracks changed (${tracks.length} now) — queued for next track boundary`,
        );
        prev.setTracks(tracks);
      } else {
        if (prev) {
          log(
            `[engine] stage=${stageId} previous controller was stopped — starting a fresh supervisor with ${tracks.length} tracks`,
          );
        } else {
          log(
            `[engine] stage=${stageId} Plex tracks available (${tracks.length}) — starting supervisor`,
          );
        }
        spawnAndWatch(stage, tracks);
      }
    },
    onError: (stageId, err) => {
      log(`[engine] stage=${stageId} Plex poll error: ${formatPlexErr(err)}`);
    },
    ...(pollerSchedule !== undefined ? { schedule: pollerSchedule } : {}),
  });

  const app = createApp({ registry, hlsRoot: config.hlsRoot });

  let shutdownPromise: Promise<void> | null = null;
  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    // Set the flag BEFORE awaiting so the liveness watcher
    // (spawnAndWatch) sees it and skips revival when registry.stopAll
    // makes every supervisor's run loop terminate.
    shuttingDown = true;
    shutdownPromise = (async () => {
      await poller.stop();
      await registry.stopAll();
    })();
    return shutdownPromise;
  }

  return { registry, poller, app, shutdown };
}

function buildStageConfig(
  stage: Stage,
  tracks: readonly import("@pavoia/shared").Track[],
  config: EngineConfig,
  log: (line: string) => void,
): StartStageConfig {
  return {
    stageId: stage.id,
    tracks,
    hlsDir: path.join(config.hlsRoot, stage.id),
    fallbackFile: config.fallbackFile,
    ffmpegBin: config.ffmpegBin,
    onEvent: (e: StageEvent) => {
      // Compact one-line log per event. Crash + watchdog timeouts
      // include the most useful detail; the rest just announce
      // their type so we have a timeline in journalctl-equivalent.
      switch (e.type) {
        case "track_started":
          log(
            `[stage:${stage.id}] track_started ratingKey=${e.track.plexRatingKey} title=${JSON.stringify(e.track.title)}`,
          );
          break;
        case "crash":
          log(
            `[stage:${stage.id}] crash track=${e.track?.plexRatingKey ?? "fallback"} consecutive=${e.consecutive} exit=${JSON.stringify(e.exit)}`,
          );
          break;
        case "watchdog_timeout":
          log(
            `[stage:${stage.id}] watchdog_timeout ratingKey=${e.track.plexRatingKey} after=${e.timeoutMs}ms`,
          );
          break;
        case "preflight_failed":
          log(
            `[stage:${stage.id}] preflight_failed ratingKey=${e.track.plexRatingKey} reason=${e.reason}`,
          );
          break;
        case "skipped_after_repeated_crashes":
          log(
            `[stage:${stage.id}] skipped_after_repeated_crashes ratingKey=${e.track.plexRatingKey}`,
          );
          break;
        case "status":
          log(`[stage:${stage.id}] status=${e.status}`);
          break;
        default:
          // track_ended, curating_started, curating_ended — quieter
          break;
      }
    },
    onStderrLine: (line) => log(`[ffmpeg:${stage.id}] ${line}`),
  };
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatPlexErr(err: PlexApiError): string {
  return `${err.detail.kind}${"status" in err.detail ? ` status=${err.detail.status}` : ""}`;
}

// Ensure StageController is a value-position re-export so callers
// don't need to dive into stages/index.ts to reference the type.
export type { StageController };

// Public surface of the per-stage ffmpeg supervisor.
//
// Task 3 deliverable — the supervisor is pure infrastructure. Wiring
// the 10 audio stages and the /api/stages HTTP endpoints lands in
// Task 5 (engine index.ts).

export { buildFfmpegArgs } from "./ffmpeg-args.ts";
export type { BuildFfmpegArgsInput } from "./ffmpeg-args.ts";

export { runTrack } from "./runner.ts";
export type { RunTrackInput, TrackExit } from "./runner.ts";

export { prepareStageDir, cleanStageDir } from "./hls-dir.ts";

export { startStage, defaultSleep } from "./supervisor.ts";
export type {
  StartStageConfig,
  StageController,
  StageStatus,
  StageEvent,
  RunTrackFn,
} from "./supervisor.ts";

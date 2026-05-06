import type { NowPlaying as NowPlayingPayload, Stage } from "@pavoia/shared";

import { TrackProgress } from "./TrackProgress.tsx";

interface NowPlayingProps {
  stage: Stage;
  payload: NowPlayingPayload;
}

/**
 * Card showing the currently audible track on a stage.
 *
 * Three states:
 *   - playing + track: title/artist/album/year + progress bar
 *   - curating (fallback loop is on, no real track) or any other
 *     status without a track: an honest placeholder that says so
 *   - any unrecognized state: same placeholder; never a crash
 *
 * Cover art is intentionally text-only for now. Slice E (player
 * chrome polish) adds a Plex-thumb proxy on the engine side and
 * wires the cover image here.
 */
export function NowPlaying({ stage, payload }: NowPlayingProps) {
  const { status, track, startedAt } = payload;

  if (track && startedAt !== null && status === "playing") {
    const yearSuffix =
      typeof track.albumYear === "number" ? ` · ${track.albumYear}` : "";
    return (
      <article className="rounded-2xl border border-slate-800/60 bg-black/40 p-6 backdrop-blur-sm md:p-8">
        <StatusPill status={status} accent={stage.accent} />
        <h3 className="mt-4 text-balance text-2xl font-semibold leading-tight text-slate-100 md:text-3xl">
          {track.title}
        </h3>
        <p className="mt-1 text-base text-slate-300">{track.artist}</p>
        <p className="mt-0.5 text-sm text-slate-400">
          {track.album}
          {yearSuffix}
        </p>
        <div className="mt-6">
          <TrackProgress
            startedAt={startedAt}
            durationSec={track.durationSec}
            accent={stage.accent}
          />
        </div>
      </article>
    );
  }

  return (
    <article className="rounded-2xl border border-slate-800/60 bg-black/40 p-6 backdrop-blur-sm md:p-8">
      <StatusPill status={status} accent={stage.accent} />
      <p className="mt-4 text-base text-slate-400">{describePlaceholder(status)}</p>
    </article>
  );
}

function StatusPill({
  status,
  accent,
}: {
  status: NowPlayingPayload["status"];
  accent: string;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-slate-700/60 bg-slate-900/60 px-3 py-1 text-xs uppercase tracking-wide text-slate-400">
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: status === "playing" ? accent : "#475569" }}
      />
      {label(status)}
    </div>
  );
}

function label(status: NowPlayingPayload["status"]): string {
  switch (status) {
    case "playing":
      return "Now playing";
    case "curating":
      return "Curating";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Stopped";
  }
}

function describePlaceholder(status: NowPlayingPayload["status"]): string {
  switch (status) {
    case "curating":
      return "Between tracks — fallback loop is playing.";
    case "starting":
      return "Stage is starting up…";
    case "stopping":
      return "Stage is shutting down.";
    case "stopped":
      return "Stage is offline.";
    case "playing":
      // Edge case: status=playing but track or startedAt missing.
      // The supervisor briefly sits here between a track ending and
      // the next first segment landing on disk.
      return "Loading next track…";
  }
}

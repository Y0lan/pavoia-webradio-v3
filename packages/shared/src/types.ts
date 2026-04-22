// Core domain types shared between engine and web.
// Runtime validation via zod lives alongside in schemas.ts (Week 1 work).

export type StageId =
  | "gaende-favorites"
  | "opening"
  | "ambiance-safe"
  | "bermuda-day"
  | "bermuda-night"
  | "fontanna-laputa"
  | "palac-slow-hypno"
  | "palac-dance"
  | "etage-0"
  | "closing"
  | "bus";

export type Stage = {
  id: StageId;
  /** Display order in the UI sidebar. */
  order: number;
  /** Plex playlist ratingKey. null for non-audio stages (Bus). */
  plexPlaylistId: number | null;
  /** Emoji shown next to the stage name. */
  icon: string;
  /** Fallback title if Plex doesn't provide one. */
  fallbackTitle: string;
  /** Fallback description if Plex summary is empty. */
  fallbackDescription: string;
  /** Gradient from/via/to hex colors for the stage background. */
  gradient: { from: string; via: string; to: string };
  /** Accent color (hex) for UI elements tinted to this stage. */
  accent: string;
  /** True for stages with no audio (Bus mystery). Clicking shows an overlay instead. */
  disabled: boolean;
};

/**
 * **Engine-only track shape.** Contains the absolute filesystem path on
 * Whatbox (`filePath`) — NEVER serialize this over HTTP or WebSocket. All
 * client-facing code must project it to {@link PublicTrack} via
 * {@link toPublicTrack} first.
 *
 * @internal
 */
export type Track = {
  plexRatingKey: number;
  /** Fallback identity when Plex ratingKey rotates after library maintenance. */
  fallbackHash: string;
  title: string;
  artist: string;
  album: string;
  albumYear: number | null;
  durationSec: number;
  /** Absolute filesystem path on Whatbox. Used by engine only, never sent to clients. */
  filePath: string;
  /** Plex-relative thumbnail path (no token). Engine proxies via /art/:ratingKey. */
  coverUrl: string | null;
};

/**
 * The track shape that is safe to send to clients over HTTP or WebSocket.
 *
 * Uses an **allowlist** projection (`Pick`) rather than a denylist
 * (`Omit<Track, "filePath">`) so that any new engine-internal field added
 * to {@link Track} later — a debug log path, a signed URL, a local cache
 * marker, etc. — does NOT automatically leak to clients. Each new public
 * field has to be added here explicitly, making the audit trail obvious.
 */
export type PublicTrack = Pick<
  Track,
  | "plexRatingKey"
  | "fallbackHash"
  | "title"
  | "artist"
  | "album"
  | "albumYear"
  | "durationSec"
  | "coverUrl"
>;

/** Project an engine-internal Track into a client-safe PublicTrack.
 *  Mirrors the {@link PublicTrack} Pick — keep them in sync. */
export function toPublicTrack(t: Track): PublicTrack {
  return {
    plexRatingKey: t.plexRatingKey,
    fallbackHash: t.fallbackHash,
    title: t.title,
    artist: t.artist,
    album: t.album,
    albumYear: t.albumYear,
    durationSec: t.durationSec,
    coverUrl: t.coverUrl,
  };
}

/**
 * Lifecycle states of a per-stage ffmpeg supervisor. Mirrored on the
 * client so the UI can distinguish "playing a real track" from
 * "curating fallback" from "stopped" without duck-typing the track
 * field. Re-exported by @pavoia/engine's stages/supervisor.ts to
 * keep both sides on a single source of truth.
 */
export type StageStatus =
  | "starting"
  | "playing"
  | "curating"
  | "stopping"
  | "stopped";

export type NowPlaying = {
  stageId: StageId;
  /** Lifecycle state at the moment of the snapshot. */
  status: StageStatus;
  /**
   * The currently audible track. `null` during `curating` (fallback
   * loop is playing, not a real track), `starting`, `stopping`, or
   * `stopped`. Also `null` between a track ending and the next one's
   * first segment landing on disk.
   */
  track: PublicTrack | null;
  /**
   * Wall-clock epoch ms when the current track's first segment hit
   * disk (the supervisor's honest "now playing" moment). `null`
   * whenever `track` is `null`.
   */
  startedAt: number | null;
  /** HLS m3u8 URL for this stage. */
  streamUrl: string;
};

export type TrackChangedEvent = {
  type: "track_changed";
  stageId: StageId;
  track: PublicTrack;
  startedAt: number;
};

export type ListenerCountChangedEvent = {
  type: "listener_count_changed";
  counts: Record<StageId, number>;
  total: number;
};

export type StageStatusEvent = {
  type: "stage_status";
  stageId: StageId;
  status: "playing" | "curating" | "error";
  message?: string;
};

export type WsEvent =
  | TrackChangedEvent
  | ListenerCountChangedEvent
  | StageStatusEvent;

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
  coverUrl: string | null;
};

export type NowPlaying = {
  stageId: StageId;
  track: Track | null;
  /** Wall-clock epoch when the track started encoding. */
  startedAt: number;
  /** HLS m3u8 URL for this stage. */
  streamUrl: string;
};

export type TrackChangedEvent = {
  type: "track_changed";
  stageId: StageId;
  track: Track;
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

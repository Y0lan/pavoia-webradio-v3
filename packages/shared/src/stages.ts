// The canonical 11-stage definition for Pavoia Webradio v3.
//
// Plex ratingKeys verified 2026-04-21 via Week 0 Step 1 audit
// (see docs/WEEK0_LOG.md for the full audit). All stages live under
// /home/yolan/files/plex_music_library/opus/ on Whatbox.
//
// Stage metadata (icon, gradient, accent) ported from v1's streamMeta.js
// (the visual identity system that already works). Titles and descriptions
// are FALLBACKS only — at runtime the engine fetches them live from each
// Plex playlist's `summary` field so you can edit them in Plex without
// a deploy.

import type { Stage } from "./types.ts";

export const STAGES: Stage[] = [
  {
    id: "gaende-favorites",
    order: 0,
    plexPlaylistId: 147167,
    icon: "💜",
    fallbackTitle: "gaende's favorites",
    fallbackDescription:
      "Personal selection of tracks that hit different. Every genre, every mood.",
    gradient: { from: "#2d1b4e", via: "#1a0f30", to: "#0d0618" },
    accent: "#a78bfa",
    disabled: false,
  },
  {
    id: "opening",
    order: 1,
    plexPlaylistId: 162337,
    icon: "🌄",
    fallbackTitle: "Opening",
    fallbackDescription: "The warmup. First tracks of the night.",
    gradient: { from: "#1a0f30", via: "#2d1f1a", to: "#0d0618" },
    accent: "#fbbf24",
    disabled: false,
  },
  {
    id: "ambiance-safe",
    order: 2,
    plexPlaylistId: 145472,
    icon: "🛋️",
    fallbackTitle: "Ambiance / Safe Space",
    fallbackDescription:
      "The perfect comedown. Chill on the sofa with relaxing beats. Good vibes only.",
    gradient: { from: "#3d1f0a", via: "#2a1508", to: "#1a0c04" },
    accent: "#f59e0b",
    disabled: false,
  },
  {
    id: "bermuda-day",
    order: 3,
    plexPlaylistId: 146377,
    icon: "🌴",
    fallbackTitle: "Bermuda Before 18:00 / Oaza",
    fallbackDescription: "Sunlit grooves. Chat, move, breathe.",
    gradient: { from: "#0a3d3d", via: "#062a2a", to: "#041a1a" },
    accent: "#2dd4bf",
    disabled: false,
  },
  {
    id: "bermuda-night",
    order: 4,
    plexPlaylistId: 145468,
    icon: "🌅",
    fallbackTitle: "Bermuda (18:00–00:00)",
    fallbackDescription: "Progressive & indie. Sunset lift, growing tension.",
    gradient: { from: "#1a1040", via: "#2d1520", to: "#0d0618" },
    accent: "#f97316",
    disabled: false,
  },
  {
    id: "fontanna-laputa",
    order: 5,
    plexPlaylistId: 145469,
    icon: "⛲",
    fallbackTitle: "Fontanna / Laputa",
    fallbackDescription: "After-hour house, minimal, tech house. Plus surprises.",
    gradient: { from: "#0a2d1a", via: "#061a10", to: "#040e08" },
    accent: "#34d399",
    disabled: false,
  },
  {
    id: "palac-slow-hypno",
    order: 6,
    plexPlaylistId: 146686,
    icon: "🌙",
    fallbackTitle: "Palac Feel",
    fallbackDescription:
      "Melodic motion. Hypnotic & tender, harsh and heartbroken. Dance your emotions away.",
    gradient: { from: "#141230", via: "#0d0b20", to: "#080714" },
    accent: "#94a3b8",
    disabled: false,
  },
  {
    id: "palac-dance",
    order: 7,
    plexPlaylistId: 145470,
    icon: "🏛️",
    fallbackTitle: "Palac Dance",
    fallbackDescription:
      "High energy, darker side. Dance all night long.",
    gradient: { from: "#1a0a3d", via: "#0d1040", to: "#0a0620" },
    accent: "#c084fc",
    disabled: false,
  },
  {
    id: "etage-0",
    order: 8,
    plexPlaylistId: 145471,
    icon: "⛓️",
    fallbackTitle: "Etage 0",
    fallbackDescription:
      "Fast-paced underground. Hard techno, euro dance, trance, groove. Too hard for upstairs.",
    gradient: { from: "#1a1a1a", via: "#121212", to: "#0a0a0a" },
    accent: "#71717a",
    disabled: false,
  },
  {
    id: "closing",
    order: 9,
    plexPlaylistId: 162463,
    icon: "🌟",
    fallbackTitle: "Closing",
    fallbackDescription:
      "These are the tracks that could beautifully close PAVOIA. No categories.",
    gradient: { from: "#3d350a", via: "#2a2408", to: "#1a1604" },
    accent: "#fbbf24",
    disabled: false,
  },
  {
    id: "bus",
    order: 10,
    plexPlaylistId: null,
    icon: "🚌",
    fallbackTitle: "Bus",
    fallbackDescription: "Some things must be experienced in person.",
    gradient: { from: "#3d2a0a", via: "#2a1a08", to: "#1a1004" },
    accent: "#fb923c",
    disabled: true,
  },
];

/** Convenience: stages that actually have audio streams (excludes Bus). */
export const AUDIO_STAGES: Stage[] = STAGES.filter((s) => !s.disabled);

/** Lookup by id. */
export function getStage(id: string): Stage | undefined {
  return STAGES.find((s) => s.id === id);
}

/** Plex library root (all tracks verified to live under this path, Week 0 Step 1). */
export const PLEX_LIBRARY_ROOT = "/home/yolan/files/plex_music_library/opus";

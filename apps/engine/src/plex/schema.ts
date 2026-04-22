// Zod schemas for the subset of Plex's `/playlists/:id/items` JSON that v3
// actually consumes. Plex returns a much larger payload; we parse only the
// fields we need and tolerate unknowns via `.loose()` so a future Plex
// version that adds keys won't crash the engine.
//
// Optional fields use `.nullish()` because Plex is inconsistent — sometimes
// keys are omitted, sometimes present as `null`, sometimes as empty string.
//
// Per-item constraints are intentionally lax (`file` can be empty/missing,
// `Part` / `Media` can be empty arrays). A single malformed Plex row must
// NOT fail the whole playlist with `invalid_response`; the mapper in
// client.ts checks these fields and routes malformed rows to `skipped`
// via the `empty_path` / `missing_media` reasons.
//
// References:
//   - WEEK0_LOG.md Step 1 — verified `<Part file="...">` is a direct fs path
//   - SLIM_V3 Codex finding #9 — "Plex API media paths may not be direct fs"
//     (resolved: verified they are, for this library, UTF-8 end-to-end)

import { z } from "zod";

export const PlexPart = z
  .object({
    file: z.string().nullish(),
    size: z.number().int().nonnegative().nullish(),
  })
  .loose();

export const PlexMedia = z
  .object({
    Part: z.array(PlexPart).nullish(),
  })
  .loose();

export const PlexTrackMetadata = z
  .object({
    ratingKey: z.string().min(1),
    type: z.string(),
    title: z.string(),
    grandparentTitle: z.string().nullish(),
    parentTitle: z.string().nullish(),
    parentYear: z.number().int().nullish(),
    duration: z.number().int().nonnegative().nullish(),
    thumb: z.string().nullish(),
    Media: z.array(PlexMedia).nullish(),
  })
  .loose();

export const PlexPlaylistItemsResponse = z
  .object({
    MediaContainer: z
      .object({
        size: z.number().int().nonnegative(),
        totalSize: z.number().int().nonnegative().nullish(),
        Metadata: z.array(PlexTrackMetadata).nullish(),
      })
      .loose(),
  })
  .loose();

export type PlexPartT = z.infer<typeof PlexPart>;
export type PlexTrackMetadataT = z.infer<typeof PlexTrackMetadata>;
export type PlexPlaylistItemsResponseT = z.infer<typeof PlexPlaylistItemsResponse>;

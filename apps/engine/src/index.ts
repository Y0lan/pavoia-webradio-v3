// apps/engine entry point.
//
// Engine responsibilities (per docs/SLIM_V3.md + docs/WEEK0_LOG.md):
//   - One StageSupervisor per audio stage (10 of them, Bus excluded)
//   - Each supervisor polls its Plex playlist every 60s, spawns one ffmpeg
//     per track with HLS +append_list flags, emits track_changed events
//     on ffmpeg exit
//   - HLS segments write to /dev/shm/1008/radio-hls/<stage>/
//   - WebSocket hub broadcasts events to apps/web
//   - Hono serves /api/health for the cron watchdog and /api/stages,
//     /api/stages/:id/now for in-memory now-playing
//
// Week 1 starts here. See docs/CLAUDE.md for the sequencing.

import { STAGES, AUDIO_STAGES } from "@pavoia/shared";

console.log(`pavoia-webradio-v3 engine (placeholder)`);
console.log(`Stages configured: ${STAGES.length} (${AUDIO_STAGES.length} audio + 1 Bus)`);
console.log(`Week 1 implementation not started.`);

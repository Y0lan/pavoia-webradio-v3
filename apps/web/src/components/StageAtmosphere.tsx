import { motion, useReducedMotion } from "motion/react";
import type { Stage } from "@pavoia/shared";

import { coverProxyUrl } from "../api/plex.ts";

interface StageAtmosphereProps {
  stage: Stage;
  /** Plex cover URL of the currently playing track on this stage, if
   *  any. When provided, an oversized blurred copy of the cover sits
   *  behind everything — the Apple-Music-style ambient backdrop that
   *  inherits the album's actual color. Falls back to the stage
   *  gradient when null. */
  plexCoverUrl: string | null | undefined;
}

/**
 * Per-stage room atmosphere. Three layers, all behind the foreground
 * content:
 *
 *   1. Blurred cover backdrop — gives the page the album's actual
 *      hues, slowly drifting (ken-burns) so the screen never feels
 *      static even when the listener is just watching.
 *   2. Stage gradient orbs — pulsing low-frequency color washes in
 *      the stage's signature palette, "breathing" on a 6 s loop.
 *   3. Vignette + scanline grain (the body's globals already supply
 *      grain; we add a centered vignette to pull focus inward).
 *
 * Motion is driven by `motion/react` (framer-motion's successor),
 * already installed for use across the app.
 */
export function StageAtmosphere({ stage, plexCoverUrl }: StageAtmosphereProps) {
  const coverSrc = coverProxyUrl(plexCoverUrl);
  const reduce = useReducedMotion();

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* Base layer — solid stage color so the page has a fallback
          when both the blurred cover and the orbs are mid-fade. */}
      <div
        className="absolute inset-0"
        style={{ backgroundColor: stage.gradient.to }}
      />

      {/* Layer 1 — blurred cover backdrop. Reset opacity & key on
          coverSrc so a new track fades in cleanly. */}
      {coverSrc ? (
        <motion.img
          key={coverSrc}
          src={coverSrc}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 size-full object-cover"
          initial={{ opacity: 0, scale: 1.1, x: -10 }}
          animate={
            reduce
              ? { opacity: 0.55, scale: 1.1, x: -10, y: 0 }
              : {
                  opacity: 0.55,
                  // Slow ken-burns drift — scale + hint of x/y motion.
                  scale: [1.1, 1.18, 1.12, 1.1],
                  x: [-10, 12, -8, -10],
                  y: [0, -8, 6, 0],
                }
          }
          transition={
            reduce
              ? { opacity: { duration: 1.2, ease: "easeOut" } }
              : {
                  opacity: { duration: 1.2, ease: "easeOut" },
                  scale: { duration: 24, ease: "easeInOut", repeat: Infinity },
                  x: { duration: 32, ease: "easeInOut", repeat: Infinity },
                  y: { duration: 28, ease: "easeInOut", repeat: Infinity },
                }
          }
          style={{ filter: "blur(48px) saturate(1.25)" }}
        />
      ) : null}

      {/* Layer 2 — stage gradient orbs. Two breathing radial blobs
          using the stage's palette. Even when the cover backdrop is
          present, these add color motion + ground the page in the
          stage's identity. */}
      <motion.div
        aria-hidden="true"
        className="absolute inset-0"
        animate={reduce ? { opacity: 0.7 } : { opacity: [0.55, 0.85, 0.55] }}
        transition={
          reduce ? { duration: 0 } : { duration: 8, ease: "easeInOut", repeat: Infinity }
        }
        style={{
          background: `
            radial-gradient(ellipse 90% 60% at 25% 15%, ${stage.gradient.from}99, transparent 55%),
            radial-gradient(ellipse 70% 85% at 80% 90%, ${stage.gradient.via}88, transparent 50%)
          `,
        }}
      />
      <motion.div
        aria-hidden="true"
        className="absolute inset-0"
        animate={reduce ? { opacity: 0.55 } : { opacity: [0.4, 0.75, 0.4] }}
        transition={
          reduce
            ? { duration: 0 }
            : {
                duration: 11,
                ease: "easeInOut",
                repeat: Infinity,
                delay: 2,
              }
        }
        style={{
          background: `
            radial-gradient(ellipse 60% 70% at 75% 25%, ${stage.accent}33, transparent 55%),
            radial-gradient(ellipse 80% 60% at 20% 85%, ${stage.gradient.via}66, transparent 60%)
          `,
        }}
      />

      {/* Vignette — pulls focus toward center. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 30%, rgba(8,5,5,0.7) 100%)",
        }}
      />
    </div>
  );
}

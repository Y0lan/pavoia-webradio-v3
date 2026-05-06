import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";

/**
 * Cold-start HLS playback for one stage. Single audio element per
 * page; switching stages unmounts this hook (which destroys the
 * Hls.js instance and releases the element), then re-mounts at the
 * new stream URL. There is no crossfade or pre-warm — the SLIM_V3
 * decision was simpler-and-cleaner over slicker.
 *
 * Browser support:
 *   - Chromium / Firefox / Edge: hls.js (MSE).
 *   - Safari (iOS / macOS): native HLS via <audio src=...> when
 *     hls.js reports unsupported. We could force hls.js even on
 *     Safari but native is usually more battery-efficient.
 *   - Anything else (rare): we report an error state.
 *
 * Autoplay policy: browsers block .play() before user gesture, so
 * we don't auto-call it. The PlayPauseButton triggers play(); the
 * first user click is the gesture. Subsequent stage switches still
 * require a fresh click — if Slice E adds session-scoped "user
 * wants audio" memory, this hook can opt in then.
 */
export type PlaybackState =
  | "idle" // hooked up but never played in this mount
  | "loading" // waiting for buffer / first segment
  | "playing"
  | "paused"
  | "error";

export interface UseHlsResult {
  /** Attach to a hidden <audio> element. */
  audioRef: React.RefObject<HTMLAudioElement | null>;
  state: PlaybackState;
  error: string | null;
  play: () => Promise<void>;
  pause: () => void;
}

export function useHls(streamUrl: string): UseHlsResult {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  // Bumped on every streamUrl change so a play() rejection from a
  // torn-down stream (e.g. user clicked play, then immediately
  // switched stages) can't stamp the fresh stream as errored.
  const streamVersionRef = useRef(0);
  const [state, setState] = useState<PlaybackState>("idle");
  const [error, setError] = useState<string | null>(null);

  // Single effect that wires both the stream AND the audio-element
  // event listeners. They share the same lifecycle (mount/streamUrl
  // change/unmount), so combining them avoids the previous footgun
  // where the listeners' empty-deps effect could miss a late-mounted
  // ref (e.g. under React.lazy + Suspense).
  useEffect(() => {
    streamVersionRef.current += 1;
    const audio = audioRef.current;
    if (!audio) return;

    setState("idle");
    setError(null);

    let cancelled = false;

    // ── Media-element listeners ────────────────────────────────────
    const onPlay = () => setState("playing");
    const onPause = () => {
      // pause fires both on user pause AND on stream change cleanup.
      // The cleanup case is harmless: this effect's cleanup resets
      // state back to "idle" via the next mount.
      setState((prev) => (prev === "playing" ? "paused" : prev));
    };
    const onWaiting = () => setState("loading");
    const onPlaying = () => setState("playing");
    const onElementError = () => {
      setState("error");
      setError("Audio element reported an error.");
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("error", onElementError);

    // ── HLS attachment ─────────────────────────────────────────────
    if (Hls.isSupported()) {
      const hls = new Hls({
        // Live HLS tuning. The engine emits 3 s segments with a
        // 6-segment rolling window (Req K), so a small back-buffer
        // keeps memory bounded; capLevelToPlayerSize is moot for
        // audio-only streams.
        backBufferLength: 30,
        maxBufferLength: 30,
        // Engine drops segments that roll off the playlist; refusing
        // to seek past the live edge is the safest default.
        liveSyncDuration: 6,
      });
      hlsRef.current = hls;

      hls.loadSource(streamUrl);
      hls.attachMedia(audio);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (cancelled) return;
        if (!data.fatal) return;
        // hls.js exposes recovery APIs for the two common fatal
        // types. Try them once before falling through to a terminal
        // error state — this catches transient network blips and
        // the occasional decoder hiccup without losing playback.
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            setState("loading");
            return;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            setState("loading");
            return;
          default:
            setState("error");
            setError(`${data.type}: ${data.details}`);
        }
      });
    } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS path.
      audio.src = streamUrl;
    } else {
      setState("error");
      setError("HLS playback is not supported in this browser.");
    }

    return () => {
      cancelled = true;
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("error", onElementError);

      const hls = hlsRef.current;
      hlsRef.current = null;
      if (hls) {
        hls.destroy();
      }
      // Detach src so the element fully releases the network buffer.
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, [streamUrl]);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    // Snapshot the stream version before we await play(). If the
    // user switches stages mid-await, the rejection that fires when
    // the old element gets paused/unloaded must NOT clobber the
    // fresh stream's state.
    const versionAtCall = streamVersionRef.current;
    setState("loading");
    setError(null);
    try {
      await audio.play();
    } catch (err) {
      // Stale rejection from a torn-down stream — drop silently.
      if (versionAtCall !== streamVersionRef.current) return;
      // AbortError fires when the audio's src is yanked while a play
      // promise is in flight. Same source: stale, drop silently.
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Most common real failure: NotAllowedError before user gesture.
      // Surface it as an error state; the button will re-render its
      // "Play" affordance and the next click usually succeeds because
      // the gesture chain is now valid.
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  return { audioRef, state, error, play, pause };
}

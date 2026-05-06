// App-level audio player. Owns a singleton <audio> element and an
// Hls.js instance, exposes the playing-stage id + state to any
// component via context.
//
// Why "app-level":
//   v3.0 originally mounted hls.js inside StageDetailPage's
//   <StagePlayer>, so navigating to a different stage destroyed
//   the audio element and stopped playback. v1's UX (and what the
//   curator actually wants) is: pick a stage, hit play, then
//   browse the rest of the listings WHILE the audio keeps going.
//   That demands a player that outlives every route transition.
//
// hls.js is large (~500 KB minified) so we lazy-import it on the
// first play() call instead of pulling it into the initial main
// chunk. The first click pays the cost; every subsequent stage
// switch is instant.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type Hls from "hls.js";

export type PlaybackState =
  | "idle" // no stage loaded
  | "loading" // attaching / buffering / first segment
  | "playing"
  | "paused"
  | "error";

export interface PlaybackContextValue {
  /** Stage currently loaded in the player (whether playing or paused).
   *  null when nothing has been played yet. */
  playingStageId: string | null;
  state: PlaybackState;
  error: string | null;
  /** Switch to (or start) a stage. Tears down the previous stage's
   *  hls.js instance, attaches the new one, calls audio.play().
   *  No-op if the stage is already playing. */
  play: (stageId: string, streamUrl: string) => Promise<void>;
  /** Pause the current stream. Audio element keeps the source so
   *  resume() picks up at the live edge. */
  pause: () => void;
  /** Resume the currently-loaded stream after pause. No-op when
   *  state is "playing", "loading", or "idle". */
  resume: () => Promise<void>;
}

const Ctx = createContext<PlaybackContextValue | null>(null);

interface PlaybackProviderProps {
  children: ReactNode;
}

export function PlaybackProvider({ children }: PlaybackProviderProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // hls.js constructor + active instance.
  const HlsCtorRef = useRef<typeof Hls | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  // Bumped on every stream switch so a stale play() rejection from a
  // torn-down stream can't overwrite the new stream's state.
  const streamVersionRef = useRef(0);

  const [playingStageId, setPlayingStageId] = useState<string | null>(null);
  const [state, setState] = useState<PlaybackState>("idle");
  const [error, setError] = useState<string | null>(null);

  // Lazy-load hls.js on first use. After this, the constructor lives
  // in HlsCtorRef and subsequent play() calls are synchronous.
  const ensureHlsCtor = useCallback(async (): Promise<typeof Hls | null> => {
    if (HlsCtorRef.current) return HlsCtorRef.current;
    const mod = await import("hls.js");
    HlsCtorRef.current = mod.default;
    return HlsCtorRef.current;
  }, []);

  // Tear down the active hls.js instance + detach the audio element.
  const teardown = useCallback(() => {
    const audio = audioRef.current;
    const hls = hlsRef.current;
    hlsRef.current = null;
    if (hls) {
      try {
        hls.destroy();
      } catch {
        // hls.js sometimes throws during destroy if it's already torn
        // down; nothing to recover, just suppress.
      }
    }
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
  }, []);

  const play = useCallback(
    async (stageId: string, streamUrl: string) => {
      const audio = audioRef.current;
      if (!audio) return;

      // Same stage already playing? No-op — clicking play on the
      // active stage means "you already are".
      if (playingStageId === stageId && state === "playing") return;

      // Same stage but paused → just resume; no need to re-attach,
      // no need to bump the stream version (doing so would
      // invalidate the active stream's HLS error handler).
      if (playingStageId === stageId && hlsRef.current !== null) {
        const versionAtCall = streamVersionRef.current;
        setState("loading");
        setError(null);
        try {
          await audio.play();
        } catch (err) {
          if (versionAtCall !== streamVersionRef.current) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setState("error");
          setError(err instanceof Error ? err.message : String(err));
        }
        return;
      }

      // Different stage (or first play) → switch streams. Bump the
      // version NOW so any in-flight rejection from the old stream
      // can detect it's stale.
      streamVersionRef.current += 1;
      const versionAtCall = streamVersionRef.current;

      teardown();
      setError(null);
      setPlayingStageId(stageId);
      setState("loading");

      const HlsCtor = await ensureHlsCtor();
      // hls.js may not be available in extreme environments; treat
      // as fatal but recoverable on next try.
      if (!HlsCtor) {
        setState("error");
        setError("hls.js failed to load.");
        return;
      }
      // The user may have switched stages again while we were
      // awaiting the dynamic import. Bail if that happened.
      if (versionAtCall !== streamVersionRef.current) return;

      if (HlsCtor.isSupported()) {
        const hls = new HlsCtor({
          backBufferLength: 30,
          maxBufferLength: 30,
          liveSyncDuration: 6,
        });
        hlsRef.current = hls;
        hls.loadSource(streamUrl);
        hls.attachMedia(audio);
        hls.on(HlsCtor.Events.ERROR, (_event, data) => {
          if (versionAtCall !== streamVersionRef.current) return;
          if (!data.fatal) return;
          switch (data.type) {
            case HlsCtor.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              setState("loading");
              return;
            case HlsCtor.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              setState("loading");
              return;
            default:
              setState("error");
              setError(`${data.type}: ${data.details}`);
          }
        });
      } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari native HLS.
        audio.src = streamUrl;
      } else {
        setState("error");
        setError("HLS playback is not supported in this browser.");
        return;
      }

      try {
        await audio.play();
      } catch (err) {
        if (versionAtCall !== streamVersionRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [playingStageId, state, ensureHlsCtor, teardown],
  );

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const resume = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || playingStageId === null) return;
    if (state === "playing" || state === "loading" || state === "idle") return;

    // Resume on the SAME stream — don't bump the version (would
    // invalidate the active hls.js ERROR handler).
    const versionAtCall = streamVersionRef.current;
    setState("loading");
    setError(null);
    try {
      await audio.play();
    } catch (err) {
      if (versionAtCall !== streamVersionRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [playingStageId, state]);

  // Mirror native audio events into the state machine.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => setState("playing");
    const onPlaying = () => setState("playing");
    const onPause = () => {
      setState((prev) => (prev === "playing" ? "paused" : prev));
    };
    const onWaiting = () => setState("loading");
    const onElementError = () => {
      setState("error");
      setError("Audio element reported an error.");
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("error", onElementError);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("error", onElementError);
    };
  }, []);

  // App-shutdown teardown. The provider lives for the page lifetime,
  // so this rarely fires — but covers React StrictMode double-mount
  // and HMR.
  useEffect(() => {
    return () => {
      teardown();
    };
  }, [teardown]);

  const value = useMemo<PlaybackContextValue>(
    () => ({
      playingStageId,
      state,
      error,
      play,
      pause,
      resume,
    }),
    [playingStageId, state, error, play, pause, resume],
  );

  return (
    <Ctx.Provider value={value}>
      {/* The singleton <audio> element. Outside any route so it
       *  outlives navigation. */}
      <audio
        ref={audioRef}
        preload="none"
        crossOrigin="anonymous"
        className="sr-only"
      />
      {children}
    </Ctx.Provider>
  );
}

export function usePlayback(): PlaybackContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error("usePlayback must be used inside <PlaybackProvider>");
  }
  return v;
}

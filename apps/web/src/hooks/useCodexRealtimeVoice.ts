import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";

import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

export type CodexRealtimeVoiceStatus = "idle" | "connecting" | "live" | "error";

export interface CodexRealtimeVoiceController {
  readonly supported: boolean;
  readonly status: CodexRealtimeVoiceStatus;
  readonly muted: boolean;
  readonly error: string | null;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly toggleMuted: () => void;
}

interface LocalVoiceSession {
  readonly peer: RTCPeerConnection;
  readonly microphone: MediaStream;
  readonly events: RTCDataChannel;
  readonly audio: HTMLAudioElement;
  readonly abort: AbortController;
  readonly microphoneEnded: EventListener;
}

const ICE_GATHERING_TIMEOUT_MS = 15_000;
const MINIMUM_CODEX_REALTIME_VOICE_VERSION = [0, 145, 0] as const;

export function supportsCodexRealtimeVoiceVersion(version: string | null): boolean {
  if (!version) return true;
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return true;
  const installed = match.slice(1).map(Number);
  for (let index = 0; index < MINIMUM_CODEX_REALTIME_VOICE_VERSION.length; index += 1) {
    const minimum = MINIMUM_CODEX_REALTIME_VOICE_VERSION[index];
    if (minimum === undefined) continue;
    const difference = (installed[index] ?? 0) - minimum;
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export function waitForIceGathering(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (peer.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const finish = (cause?: unknown) => {
      globalThis.clearTimeout(timeoutId);
      peer.removeEventListener("icegatheringstatechange", handleStateChange);
      signal.removeEventListener("abort", handleAbort);
      if (cause === undefined) resolve();
      else reject(cause);
    };
    const handleStateChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const handleAbort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timeoutId = globalThis.setTimeout(
      () => finish(new Error("WebRTC ICE gathering timed out.")),
      ICE_GATHERING_TIMEOUT_MS,
    );
    peer.addEventListener("icegatheringstatechange", handleStateChange);
    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) handleAbort();
  });
}

function voiceErrorMessage(cause: unknown): string {
  if (cause instanceof DOMException) {
    if (cause.name === "NotAllowedError") return "Microphone access was denied.";
    if (cause.name === "NotFoundError") return "No microphone was found.";
  }
  return "Codex voice could not connect. Try again.";
}

function disposeLocalSession(session: LocalVoiceSession | null): void {
  if (!session) return;
  session.abort.abort();
  session.peer.onconnectionstatechange = null;
  session.peer.ontrack = null;
  session.events.close();
  session.microphone.getTracks().forEach((track) => {
    track.removeEventListener("ended", session.microphoneEnded);
    track.stop();
  });
  session.peer.close();
  session.audio.pause();
  session.audio.srcObject = null;
}

export function useCodexRealtimeVoice(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly enabled: boolean;
}): CodexRealtimeVoiceController {
  const startRemoteVoice = useAtomCommand(threadEnvironment.startRealtimeVoice, {
    reportFailure: false,
  });
  const stopRemoteVoice = useAtomCommand(threadEnvironment.stopRealtimeVoice, {
    reportFailure: false,
  });
  const localSessionRef = useRef<LocalVoiceSession | null>(null);
  const remoteStartedRef = useRef(false);
  const generationRef = useRef(0);
  const [status, setStatus] = useState<CodexRealtimeVoiceStatus>("idle");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported =
    typeof window !== "undefined" &&
    typeof RTCPeerConnection !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";

  const clearLocalSession = useCallback(() => {
    const session = localSessionRef.current;
    localSessionRef.current = null;
    disposeLocalSession(session);
  }, []);

  const stop = useCallback(async () => {
    generationRef.current += 1;
    const shouldStopRemote = remoteStartedRef.current || localSessionRef.current !== null;
    remoteStartedRef.current = false;
    clearLocalSession();
    setStatus("idle");
    setMuted(false);
    setError(null);

    if (shouldStopRemote && input.threadId) {
      await stopRemoteVoice({
        environmentId: input.environmentId,
        input: { threadId: input.threadId },
      });
    }
  }, [clearLocalSession, input.environmentId, input.threadId, stopRemoteVoice]);

  const start = useCallback(async () => {
    if (!input.enabled || !input.threadId || !supported || localSessionRef.current) return;
    const threadId = input.threadId;

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setStatus("connecting");
    setMuted(false);
    setError(null);

    try {
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (generationRef.current !== generation) {
        microphone.getTracks().forEach((track) => track.stop());
        return;
      }

      const peer = new RTCPeerConnection();
      const events = peer.createDataChannel("oai-events");
      const audio = new Audio();
      const abort = new AbortController();
      audio.autoplay = true;
      audio.setAttribute("playsinline", "");
      microphone.getAudioTracks().forEach((track) => peer.addTrack(track, microphone));

      const failSession = (message: string) => {
        if (generationRef.current !== generation || localSessionRef.current?.peer !== peer) {
          return;
        }
        generationRef.current += 1;
        remoteStartedRef.current = false;
        clearLocalSession();
        setStatus("error");
        setError(message);
        void stopRemoteVoice({
          environmentId: input.environmentId,
          input: { threadId },
        });
      };
      const microphoneEnded = () => failSession("Microphone access was lost. Try again.");
      const session = {
        peer,
        microphone,
        events,
        audio,
        abort,
        microphoneEnded,
      } satisfies LocalVoiceSession;
      localSessionRef.current = session;
      microphone.getAudioTracks().forEach((track) => {
        track.addEventListener("ended", microphoneEnded);
      });
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio
          .play()
          .catch(() => failSession("Codex voice audio playback was blocked. Try again."));
      };
      peer.onconnectionstatechange = () => {
        if (generationRef.current !== generation) return;
        if (peer.connectionState === "connected") {
          setStatus("live");
          return;
        }
        if (peer.connectionState !== "failed") return;
        failSession("The Codex voice connection was lost.");
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer, abort.signal);
      const localSdp = peer.localDescription?.sdp;
      if (!localSdp) throw new Error("WebRTC did not produce a local session description.");

      const result = await startRemoteVoice({
        environmentId: input.environmentId,
        input: { threadId, sdp: localSdp },
      });
      if (generationRef.current !== generation) {
        await stopRemoteVoice({
          environmentId: input.environmentId,
          input: { threadId },
        });
        return;
      }
      if (result._tag !== "Success") {
        throw new Error("Codex rejected the realtime voice session.", {
          cause: squashAtomCommandFailure(result),
        });
      }

      remoteStartedRef.current = true;
      await peer.setRemoteDescription({ type: "answer", sdp: result.value.sdp });
      setStatus("live");
    } catch (cause) {
      if (generationRef.current !== generation) return;
      generationRef.current += 1;
      const shouldStopRemote = remoteStartedRef.current;
      remoteStartedRef.current = false;
      clearLocalSession();
      setStatus("error");
      setError(voiceErrorMessage(cause));
      if (shouldStopRemote) {
        void stopRemoteVoice({
          environmentId: input.environmentId,
          input: { threadId },
        });
      }
    }
  }, [
    clearLocalSession,
    input.enabled,
    input.environmentId,
    input.threadId,
    startRemoteVoice,
    stopRemoteVoice,
    supported,
  ]);

  const toggleMuted = useCallback(() => {
    const microphoneTrack = localSessionRef.current?.microphone.getAudioTracks()[0];
    if (!microphoneTrack) return;
    const nextMuted = microphoneTrack.enabled;
    microphoneTrack.enabled = !nextMuted;
    setMuted(nextMuted);
  }, []);

  useEffect(() => {
    if (!input.enabled) {
      void stop();
    }
  }, [input.enabled, stop]);

  useEffect(() => {
    setStatus("idle");
    setMuted(false);
    setError(null);

    return () => {
      generationRef.current += 1;
      const shouldStopRemote = remoteStartedRef.current || localSessionRef.current !== null;
      remoteStartedRef.current = false;
      clearLocalSession();
      if (shouldStopRemote && input.threadId) {
        void stopRemoteVoice({
          environmentId: input.environmentId,
          input: { threadId: input.threadId },
        });
      }
    };
  }, [clearLocalSession, input.environmentId, input.threadId, stopRemoteVoice]);

  return { supported, status, muted, error, start, stop, toggleMuted };
}

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { waitForIceGathering } from "./useCodexRealtimeVoice";

class FakePeerConnection {
  iceGatheringState: RTCIceGatheringState = "gathering";
  readonly listeners = new Set<EventListenerOrEventListenerObject>();

  addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.delete(listener);
  }

  complete() {
    this.iceGatheringState = "complete";
    const event = new Event("icegatheringstatechange");
    for (const listener of this.listeners) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }
}

const asPeerConnection = (peer: FakePeerConnection) => peer as unknown as RTCPeerConnection;

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForIceGathering", () => {
  it("resolves only after ICE gathering completes", async () => {
    const peer = new FakePeerConnection();
    const result = waitForIceGathering(asPeerConnection(peer), new AbortController().signal);

    peer.complete();

    await expect(result).resolves.toBeUndefined();
    expect(peer.listeners).toHaveLength(0);
  });

  it("rejects when the session is cancelled", async () => {
    const peer = new FakePeerConnection();
    const abort = new AbortController();
    const result = waitForIceGathering(asPeerConnection(peer), abort.signal);

    abort.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(peer.listeners).toHaveLength(0);
  });

  it("rejects instead of sending a partial offer after the ICE deadline", async () => {
    vi.useFakeTimers();
    const peer = new FakePeerConnection();
    const result = waitForIceGathering(asPeerConnection(peer), new AbortController().signal);
    const assertion = expect(result).rejects.toThrow("WebRTC ICE gathering timed out.");

    await vi.advanceTimersByTimeAsync(15_000);

    await assertion;
    expect(peer.listeners).toHaveLength(0);
  });
});

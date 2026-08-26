import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  type CodexRealtimeVoiceController,
  supportsCodexRealtimeVoiceVersion,
} from "~/hooks/useCodexRealtimeVoice";
import { ComposerVoiceControl } from "./ComposerVoiceControl";

const makeVoice = (
  overrides: Partial<CodexRealtimeVoiceController> = {},
): CodexRealtimeVoiceController => ({
  supported: true,
  status: "idle",
  muted: false,
  error: null,
  start: async () => {},
  stop: async () => {},
  resumeAudio: async () => {},
  toggleMuted: () => {},
  ...overrides,
});

describe("ComposerVoiceControl", () => {
  it("gates known Codex versions before realtime v3 shipped", () => {
    expect(supportsCodexRealtimeVoiceVersion("0.144.0")).toBe(false);
    expect(supportsCodexRealtimeVoiceVersion("codex-cli 0.145.0")).toBe(true);
    expect(supportsCodexRealtimeVoiceVersion("0.146.1-alpha.1")).toBe(true);
    expect(supportsCodexRealtimeVoiceVersion(null)).toBe(true);
  });

  it("renders a compact microphone action before voice starts", () => {
    const markup = renderToStaticMarkup(
      <ComposerVoiceControl voice={makeVoice()} disabled={false} />,
    );

    expect(markup).toContain('aria-label="Talk to Codex"');
    expect(markup).toContain('data-codex-voice-state="idle"');
    expect(markup).toContain("[--control-icon-color:currentColor]");
  });

  it("shows mute and end actions while voice is live", () => {
    const markup = renderToStaticMarkup(
      <ComposerVoiceControl voice={makeVoice({ status: "live" })} disabled={false} />,
    );

    expect(markup).toContain("Voice live");
    expect(markup).toContain('aria-label="Mute microphone"');
    expect(markup).toContain('aria-label="End Codex voice"');
    expect(markup.match(/\[--control-icon-color:currentColor\]/g)).toHaveLength(2);
    expect(markup).toContain("bg-success");
  });

  it("renders the muted state without hiding the end action", () => {
    const markup = renderToStaticMarkup(
      <ComposerVoiceControl voice={makeVoice({ status: "live", muted: true })} disabled={false} />,
    );

    expect(markup).toContain("Muted");
    expect(markup).toContain('aria-label="Unmute microphone"');
    expect(markup).toContain('aria-label="End Codex voice"');
  });

  it("keeps a blocked audio session live and offers a playback retry", () => {
    const markup = renderToStaticMarkup(
      <ComposerVoiceControl
        voice={makeVoice({
          status: "playback-blocked",
          error: "Codex audio is paused. Tap the speaker to resume.",
        })}
        disabled={false}
      />,
    );

    expect(markup).toContain("Audio paused");
    expect(markup).toContain('aria-label="Resume Codex audio"');
    expect(markup).toContain('aria-label="End Codex voice"');
    expect(markup).toContain("bg-warning");
  });
});

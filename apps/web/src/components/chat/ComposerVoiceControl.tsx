import { memo, type PointerEventHandler, type ReactElement } from "react";
import { MicIcon, MicOffIcon, PhoneOffIcon, Volume2Icon } from "lucide-react";

import type { CodexRealtimeVoiceController } from "~/hooks/useCodexRealtimeVoice";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const preserveComposerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

function VoiceButtonTooltip(props: { readonly label: string; readonly children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{props.children}</TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export const ComposerVoiceControl = memo(function ComposerVoiceControl(props: {
  readonly voice: CodexRealtimeVoiceController;
  readonly disabled: boolean;
  readonly disabledReason?: string;
}) {
  const { voice } = props;
  const active =
    voice.status === "connecting" || voice.status === "live" || voice.status === "playback-blocked";

  if (!active) {
    const tooltip = !voice.supported
      ? "Codex voice requires microphone and WebRTC support"
      : props.disabled
        ? (props.disabledReason ?? "Codex voice is unavailable while this thread connects")
        : (voice.error ?? "Talk to Codex");
    return (
      <VoiceButtonTooltip label={tooltip}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className={cn(
            "rounded-full text-secondary-label [--control-icon-color:currentColor] hover:text-foreground",
            voice.status === "error" && "text-destructive hover:text-destructive",
          )}
          disabled={props.disabled || !voice.supported}
          onPointerDown={preserveComposerFocus}
          onClick={() => void voice.start()}
          aria-label="Talk to Codex"
          data-codex-voice-state={voice.status}
        >
          <MicIcon className="size-4" />
        </Button>
      </VoiceButtonTooltip>
    );
  }

  const label =
    voice.status === "connecting"
      ? "Connecting…"
      : voice.status === "playback-blocked"
        ? "Audio paused"
        : voice.muted
          ? "Muted"
          : "Voice live";
  return (
    <div
      className="flex h-8 items-center gap-0.5 rounded-full border border-border/70 bg-muted/50 ps-2 pe-1"
      data-codex-voice-state={voice.status}
    >
      <span
        aria-hidden="true"
        className={cn(
          "me-1 size-1.5 rounded-full",
          voice.status === "connecting"
            ? "bg-muted-foreground"
            : voice.status === "playback-blocked"
              ? "bg-warning"
              : "bg-success",
        )}
      />
      <span className="hidden text-xs text-secondary-label sm:inline">{label}</span>
      {voice.status === "playback-blocked" ? (
        <VoiceButtonTooltip label={voice.error ?? "Resume Codex audio"}>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="rounded-full text-warning [--control-icon-color:currentColor] hover:text-warning"
            onPointerDown={preserveComposerFocus}
            onClick={() => void voice.resumeAudio()}
            aria-label="Resume Codex audio"
          >
            <Volume2Icon className="size-3.5" />
          </Button>
        </VoiceButtonTooltip>
      ) : null}
      <VoiceButtonTooltip label={voice.muted ? "Unmute microphone" : "Mute microphone"}>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="rounded-full text-secondary-label [--control-icon-color:currentColor] hover:text-foreground"
          disabled={voice.status === "connecting"}
          onPointerDown={preserveComposerFocus}
          onClick={voice.toggleMuted}
          aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
        >
          {voice.muted ? <MicOffIcon className="size-3.5" /> : <MicIcon className="size-3.5" />}
        </Button>
      </VoiceButtonTooltip>
      <VoiceButtonTooltip label="End Codex voice">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="rounded-full text-destructive [--control-icon-color:currentColor] hover:bg-destructive/10 hover:text-destructive"
          onPointerDown={preserveComposerFocus}
          onClick={() => void voice.stop()}
          aria-label="End Codex voice"
        >
          <PhoneOffIcon className="size-3.5" />
        </Button>
      </VoiceButtonTooltip>
    </div>
  );
});

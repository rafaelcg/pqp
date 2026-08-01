import {
  HeadphoneOff,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface VoiceStatusBarProps {
  channelName: string;
  status: "idle" | "joining" | "connected";
  peerCount: number;
  isMuted: boolean;
  isDeafened: boolean;
  usingSfu: boolean;
  onOpen: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onLeave: () => void;
}

export function VoiceStatusBar({
  channelName,
  status,
  peerCount,
  isMuted,
  isDeafened,
  usingSfu,
  onOpen,
  onToggleMute,
  onToggleDeafen,
  onLeave,
}: VoiceStatusBarProps) {
  const connected = status === "connected";
  const total = peerCount + 1;

  return (
    <div className="border-t border-ink-4/60 bg-ink px-2 py-2">
      <div className="flex items-center gap-2">
        {connected ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-success shadow-[0_0_8px_var(--glow-success)]"
            aria-hidden="true"
          />
        ) : (
          <Loader2
            className="h-3 w-3 shrink-0 animate-spin text-warning"
            aria-hidden="true"
          />
        )}
        <p
          aria-live="polite"
          className={cn(
            "min-w-0 flex-1 truncate text-xs font-semibold",
            connected ? "text-success" : "text-warning",
          )}
        >
          {connected ? "Voice connected" : "Connecting…"}
          {connected && (
            <span className="ml-1 font-normal text-paper-muted">
              · {total} {total === 1 ? "person" : "people"}
            </span>
          )}
        </p>
        {usingSfu && (
          <span className="shrink-0 rounded bg-ink-3 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-paper-muted">
            SFU
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label="Disconnect from voice"
          onClick={onLeave}
        >
          <PhoneOff className="h-4 w-4 text-danger" />
        </Button>
      </div>

      <div className="mt-1 flex items-center gap-1">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open voice channel ${channelName}`}
          className="min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-left text-sm text-paper-muted transition-colors hover:bg-ink-3 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
        >
          <Mic className="mr-1 inline-block h-3 w-3 align-[-1px] text-paper-muted" />
          {channelName}
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={isMuted}
          onClick={onToggleMute}
        >
          {isMuted ? (
            <MicOff className="h-4 w-4 text-danger" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={isDeafened ? "Undeafen" : "Deafen"}
          aria-pressed={isDeafened}
          onClick={onToggleDeafen}
        >
          {isDeafened ? (
            <HeadphoneOff className="h-4 w-4 text-danger" />
          ) : (
            <Headphones className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

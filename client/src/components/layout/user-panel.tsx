import { Mic, MicOff, Settings } from "lucide-react";
import { UserButton } from "@clerk/clerk-react";
import { Button } from "@/components/ui/button";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";

interface UserPanelProps {
  displayName: string;
  tag: string | null;
  isMuted: boolean;
  inVoice: boolean;
  showUserButton: boolean;
  onToggleMute: () => void;
  onOpenSettings: () => void;
}

export function UserPanel({
  displayName,
  tag,
  isMuted,
  inVoice,
  showUserButton,
  onToggleMute,
  onOpenSettings,
}: UserPanelProps) {
  return (
    <div className="safe-pb flex items-center gap-2 border-t border-ink-4/60 bg-ink px-2 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {showUserButton && !isDevAuthBypassEnabled() ? (
          <UserButton
            appearance={{
              elements: {
                avatarBox: "h-8 w-8 rounded-md",
              },
            }}
          />
        ) : (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-signal font-display text-xs font-bold text-ink">
            {displayName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{displayName}</p>
          <p className="truncate font-mono text-[11px] text-paper-muted">
            {tag ?? (inVoice ? (isMuted ? "Muted" : "In voice") : "Online")}
          </p>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={onToggleMute}
        disabled={!inVoice}
        title={isMuted ? "Unmute" : "Mute"}
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
        className="h-8 w-8 shrink-0"
        onClick={onOpenSettings}
        title="Settings"
      >
        <Settings className="h-4 w-4" />
      </Button>
    </div>
  );
}

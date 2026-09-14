import { useEffect, useRef } from "react";
import { Camera, CameraOff, Mic, MicOff, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * CONVIDADOS §3.4: "the guest's chrome is exactly four things and nothing
 * else." Not a corner badge — a fixed strip across the top of the stage,
 * never dismissible while the guest is on air, so nobody forgets what a
 * stray remark now reaches.
 *
 * `role="status"` `aria-live="polite"` and never colour alone (§6.2): the
 * words say it, the icon says it, the fill says it, and going on air moves
 * focus here.
 */
export function GuestOnAirStrip({
  micOn,
  cameraOn,
  onToggleMic,
  onToggleCamera,
  onLeave,
  className,
}: {
  micOn: boolean;
  cameraOn: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onLeave: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const stripRef = useRef<HTMLDivElement>(null);

  // "Going on air moves focus to the on-air strip" (§6.2).
  useEffect(() => {
    stripRef.current?.focus();
  }, []);

  return (
    <div
      ref={stripRef}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      data-watch-party-on-air-strip
      className={cn(
        "flex flex-col gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-on-danger-soft outline-none sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="motion-safe:absolute motion-safe:inline-flex h-full w-full animate-ping rounded-full bg-on-danger-soft opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-on-danger-soft" />
        </span>
        <div className="flex flex-col">
          <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide">
            <Radio className="h-3.5 w-3.5" aria-hidden="true" />
            {t("watchParty.guests.onAir")}
          </span>
          <span className="text-xs opacity-90">
            {t("watchParty.guests.onAirBody")}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-pressed={micOn}
          aria-label={t("watchParty.guests.mic")}
          onClick={onToggleMic}
          data-watch-party-guest-mic
        >
          {micOn ? (
            <Mic className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <MicOff className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {t("watchParty.guests.mic")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-pressed={cameraOn}
          aria-label={t("watchParty.guests.camera")}
          onClick={onToggleCamera}
          data-watch-party-guest-camera
        >
          {cameraOn ? (
            <Camera className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <CameraOff className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {t("watchParty.guests.camera")}
        </Button>
        <Button
          type="button"
          variant="danger"
          size="sm"
          onClick={onLeave}
          data-watch-party-guest-leave
        >
          {t("watchParty.guests.leave")}
        </Button>
      </div>
    </div>
  );
}

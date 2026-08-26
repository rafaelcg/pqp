import { Bug, Check, Download, Mic, MicOff, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { UserButton } from "@clerk/clerk-react";
import type { ManualStatus, UserStatus } from "@pqp/shared";
import { DownloadDialog } from "@/components/downloads/download-dialog";
import { DownloadHint } from "@/components/downloads/download-hint";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/user/status-dot";
import { UserAvatar } from "@/components/user/user-avatar";
import { isDesktopApp } from "@/lib/desktop";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import {
  dismissDownloadHint,
  isDownloadHintDismissed,
} from "@/lib/download-hint";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface UserPanelProps {
  displayName: string;
  tag: string | null;
  avatarUrl?: string | null;
  isMuted: boolean;
  inVoice: boolean;
  showUserButton: boolean;
  /** What this account chose. `invisible` is only ever shown to its owner. */
  manualStatus: ManualStatus;
  /** What everybody else is being told, including derived idle. */
  effectiveStatus: UserStatus;
  statusSaving: boolean;
  statusError: string | null;
  onSetStatus: (status: ManualStatus) => void;
  onToggleMute: () => void;
  onOpenSettings: () => void;
  /** Opens settings straight at the feedback section. */
  onOpenFeedback: () => void;
}

/**
 * Only the manual choices appear here.
 *
 * `idle` is deliberately absent, and its absence is the design: idle means "this
 * machine has not been touched in ten minutes", which is a fact the client
 * measures, not an opinion anyone gets to assert. Offering it would produce the
 * one state that can be simultaneously set and false — someone typing, showing
 * as away — and would then need a rule for whether real activity clears it,
 * where both answers are wrong. `offline` is absent for the same kind of reason:
 * it is the absence of a connection, and the way to have it is to close the tab.
 * Anyone who wants its *appearance* while staying connected wants `invisible`,
 * which is here and says so.
 */
const CHOICES: readonly {
  manual: ManualStatus;
  /** The pip a choice shows — invisible deliberately borrows offline's. */
  pip: UserStatus;
  labelKey: "status.online" | "status.dnd" | "status.invisible";
  hintKey?: "status.dndHint" | "status.invisibleHint";
}[] = [
  { manual: "online", pip: "online", labelKey: "status.online" },
  {
    manual: "dnd",
    pip: "dnd",
    labelKey: "status.dnd",
    hintKey: "status.dndHint",
  },
  {
    manual: "invisible",
    pip: "offline",
    labelKey: "status.invisible",
    hintKey: "status.invisibleHint",
  },
];

export function UserPanel({
  displayName,
  tag,
  avatarUrl = null,
  isMuted,
  inVoice,
  showUserButton,
  manualStatus,
  effectiveStatus,
  statusSaving,
  statusError,
  onSetStatus,
  onToggleMute,
  onOpenSettings,
  onOpenFeedback,
}: UserPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(isDownloadHintDismissed);
  const popoverRef = useRef<HTMLDivElement>(null);
  const showDownload = !isDesktopApp();
  const showHint = showDownload && !hintDismissed;

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      if (!popoverRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Your own row says "Invisible", not "Offline". They are the same pip to
  // everyone else and that is the point — but telling the person who chose it
  // that they are "Offline" would leave them unable to tell whether the setting
  // took, which is the failure a privacy control cannot afford.
  const ownLabel =
    manualStatus === "invisible" ? t("status.invisible") : undefined;

  return (
    <div className="safe-pb relative border-t border-ink-4/60 bg-ink">
      {showHint && (
        <DownloadHint
          onOpen={() => setDownloadOpen(true)}
          onDismiss={() => {
            dismissDownloadHint();
            setHintDismissed(true);
          }}
        />
      )}
      <div className="relative flex items-center gap-2 px-2 py-2">
        {open && (
          <div
            ref={popoverRef}
            role="menu"
            aria-label={t("status.change")}
            className="absolute bottom-full left-0 z-50 mb-2 w-64 overflow-hidden rounded-lg border border-ink-4 bg-ink-2 p-1 shadow-[var(--shadow-popover)] animate-fade-in"
          >
          {CHOICES.map((choice) => {
            const selected = choice.manual === manualStatus;
            return (
              <button
                key={choice.manual}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                disabled={statusSaving}
                className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none hover:bg-ink-3 focus-visible:bg-ink-3 disabled:pointer-events-none disabled:opacity-50"
                onClick={() => {
                  onSetStatus(choice.manual);
                  setOpen(false);
                }}
              >
                <StatusDot
                  status={choice.pip}
                  size="md"
                  className="mt-0.5"
                  label=""
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-paper">
                    {t(choice.labelKey)}
                  </span>
                  {/* The hint is not decoration. "Invisible" without the
                      sentence about voice channels is a promise the app does
                      not keep, and someone would only find that out from a
                      friend saying "I can see you in the call". */}
                  {choice.hintKey && (
                    <span className="mt-0.5 block text-[11px] leading-snug text-paper-muted">
                      {t(choice.hintKey)}
                    </span>
                  )}
                </span>
                {selected && (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-signal" />
                )}
              </button>
            );
          })}
          {statusError && (
            <p role="alert" className="px-2.5 py-1.5 text-[11px] text-danger">
              {statusError}
            </p>
          )}
          {/* The low-key home of the feedback box: one quiet menu item under
              the status choices, on every screen, costing no footer space. */}
          <div role="separator" className="my-1 border-t border-ink-4/60" />
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-paper outline-none hover:bg-ink-3 focus-visible:bg-ink-3"
            onClick={() => {
              onOpenFeedback();
              setOpen(false);
            }}
          >
            <Bug className="h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
            {t("userMenu.feedback")}
          </button>
          {showDownload && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-paper outline-none hover:bg-ink-3 focus-visible:bg-ink-3"
              onClick={() => {
                setDownloadOpen(true);
                setOpen(false);
              }}
            >
              <Download
                className="h-4 w-4 shrink-0 text-paper-muted"
                aria-hidden
              />
              {t("userMenu.download")}
            </button>
          )}
          </div>
        )}

        <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("status.change")}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-ink-2"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="relative shrink-0">
          <UserAvatar
            name={displayName}
            avatarUrl={avatarUrl}
            className="h-8 w-8"
            fallbackClassName="bg-signal text-xs text-ink"
          />
          <StatusDot
            status={effectiveStatus}
            label={ownLabel}
            className="absolute -bottom-0.5 -right-0.5"
            ringClassName="rounded-full bg-ink ring-2 ring-ink"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">
            {displayName}
          </span>
          {/* Was a hardcoded "Online" under every account regardless of
              anything. The tag stays the primary line when there is one —
              it is the thing people copy to add you — with the real status
              beside it rather than in place of it. */}
          <span className="flex items-center gap-1.5">
            {tag && (
              <span className="truncate font-mono text-[11px] text-paper-muted">
                {tag}
              </span>
            )}
            <span
              className={cn(
                "truncate text-[11px]",
                statusSaving ? "text-paper-muted/60" : "text-paper-muted",
              )}
            >
              {ownLabel ??
                t(
                  effectiveStatus === "online"
                    ? "status.online"
                    : effectiveStatus === "idle"
                      ? "status.idle"
                      : effectiveStatus === "dnd"
                        ? "status.dnd"
                        : "status.offline",
                )}
            </span>
          </span>
        </span>
      </button>

      {showUserButton && !avatarUrl && !isDevAuthBypassEnabled() && (
        <UserButton
          appearance={{ elements: { avatarBox: "h-8 w-8 rounded-md" } }}
        />
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={onToggleMute}
        disabled={!inVoice}
        title={isMuted ? t("userPanel.unmute") : t("userPanel.mute")}
        aria-label={isMuted ? t("userPanel.unmuteMic") : t("userPanel.muteMic")}
        aria-pressed={isMuted}
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
        title={t("userPanel.settings")}
        aria-label={t("userPanel.openSettings")}
      >
        <Settings className="h-4 w-4" />
      </Button>
      </div>
      <DownloadDialog
        open={downloadOpen}
        onClose={() => setDownloadOpen(false)}
      />
    </div>
  );
}

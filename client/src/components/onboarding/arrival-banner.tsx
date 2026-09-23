import { Check, Copy, PartyPopper, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Confetti } from "@/components/onboarding/confetti";
import type { ArrivalVariant } from "@/lib/arrival";
import { useTranslation } from "@/lib/i18n";
import { track } from "@/lib/track";
import { cn } from "@/lib/utils";

/**
 * "You're in {server}": one strip above the transcript, once per server.
 *
 * WHAT IT REPLACES. An invited stranger's first screen used to be `#general`
 * saying "Start the thread" over two lines of markdown syntax: the identical
 * empty state a server's own owner sees in a channel nobody has used. So the
 * moment somebody accepted an invitation, the product said nothing about where
 * they had arrived or what to do, and the one action that turns a stranger
 * into a member is saying something, which nothing asked them to do.
 *
 * FOUR THINGS TO SAY (`arrivalVariant` in `lib/arrival.ts` picks):
 *  - `text`: a text channel is open. Say oi in it.
 *  - `voice`: a voice channel is open and they are not in the call. Press the
 *    button. It goes by itself once they are in.
 *  - `home`: the community home (Baú) is open, which is where a server with it
 *    on lands a new member. Name a text channel to start in.
 *  - `owner`: they made this room this session and nobody else is in it. The
 *    only thing that changes that is the invite, so the strip carries the
 *    copy button rather than advice about greeting an empty room.
 *
 * WHY A STRIP AND NOT A DIALOG. A dialog over the transcript would have to be
 * dismissed before the channel could be read, which makes the first
 * interaction with a new room "close this". This sits above the messages,
 * pushes nothing around when it goes, and is legible without being answered.
 *
 * Dismissal is recorded by the caller (`lib/arrival.ts`), which is also what
 * suppresses it on the *second* visit even if this was never clicked.
 */

interface ArrivalBannerProps {
  variant: ArrivalVariant;
  serverName: string;
  /** The channel it names, without a `#`: the open one, or on `home` the first text channel. */
  channelName: string | null;
  /**
   * An invitee's first arrival after the wizard: one burst of confetti, the
   * moment the room they were invited to is on screen.
   */
  celebrate?: boolean;
  /** `owner` only: copy the short invite paste. Rejects when it could not. */
  onCopyInvite?: () => Promise<void>;
  onDismiss: () => void;
}

const COPY_MS = 1600;

export function ArrivalBanner({
  variant,
  serverName,
  channelName,
  celebrate = false,
  onCopyInvite,
  onDismiss,
}: ArrivalBannerProps) {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<"idle" | "busy" | "copied" | "failed">(
    "idle",
  );
  const timer = useRef<number | null>(null);

  useEffect(() => {
    track("arrival_view", { variant });
    // One view per banner, whatever the variant later becomes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );

  async function copy() {
    if (!onCopyInvite || copyState === "busy") {
      return;
    }
    setCopyState("busy");
    try {
      await onCopyInvite();
      setCopyState("copied");
      track("onboarding_invite_copied", { kind: "banner" });
    } catch {
      setCopyState("failed");
    }
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(() => setCopyState("idle"), COPY_MS);
  }

  const owner = variant === "owner";
  const title = owner
    ? t("arrival.owner.title")
    : t("arrival.title", { server: serverName });
  const body = owner
    ? copyState === "failed"
      ? t("arrival.owner.failed")
      : t("arrival.owner.body")
    : variant === "voice"
      ? t("arrival.bodyVoice")
      : variant === "home" && channelName
        ? t("arrival.bodyHome", { channel: channelName })
        : variant === "text" && channelName
          ? t("arrival.body", { channel: channelName })
          : t("arrival.bodyNoChannel");
  const Icon = owner ? Sparkles : PartyPopper;

  return (
    <div
      data-arrival-banner=""
      data-arrival-variant={variant}
      role="status"
      className="animate-rise flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-accent-soft px-4 py-3"
    >
      {celebrate && <Confetti />}
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-balance text-sm font-semibold text-on-accent-soft">
          {title}
        </p>
        <p
          className={cn(
            "mt-0.5 text-pretty text-sm",
            copyState === "failed" ? "text-danger" : "text-on-accent-soft/80",
          )}
        >
          {body}
        </p>
      </div>

      {owner && onCopyInvite ? (
        // On a phone the strip is too narrow for title, body and a button
        // side by side: the button takes its own full-width row under the
        // text, lined up with it (past the 32px icon and its 12px gap).
        <div className="order-last w-full pl-11 sm:order-none sm:w-auto sm:pl-0">
          <Button
            size="sm"
            data-arrival-copy-invite=""
            disabled={copyState === "busy"}
            className="shrink-0"
            onClick={() => void copy()}
          >
            {copyState === "copied" ? (
              <Check aria-hidden="true" className="animate-icon-swap h-3.5 w-3.5" />
            ) : (
              <Copy aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {copyState === "copied"
              ? t("arrival.owner.copied")
              : t("arrival.owner.copy")}
          </Button>
        </div>
      ) : (
        // Two ways out, because the strip is wide: a labelled button for the
        // reader who wants to answer it, and an X on a phone.
        <Button
          size="sm"
          variant="secondary"
          data-arrival-dismiss=""
          className="hidden shrink-0 sm:inline-flex"
          onClick={onDismiss}
        >
          {t("arrival.dismiss")}
        </Button>
      )}
      <button
        type="button"
        data-arrival-close=""
        aria-label={t("arrival.dismiss")}
        onClick={onDismiss}
        className={cn(
          "relative shrink-0 rounded-[var(--radius-control)] p-1.5 text-on-accent-soft/70 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
          // A 28px glyph with a 40px hit area.
          "after:absolute after:-inset-1.5 after:content-['']",
          !owner && "sm:hidden",
        )}
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}

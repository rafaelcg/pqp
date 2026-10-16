import { Check, Copy, Share2, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BringCrewStripKind } from "@/lib/bring-crew";
import {
  announcementUrl,
  defaultAnnouncementLang,
  discordAnnouncement,
} from "@/lib/discord-announcement";
import { useTranslation } from "@/lib/i18n";
import { track } from "@/lib/track";
import { cn } from "@/lib/utils";

const COPY_MS = 1600;

/**
 * "12 pessoas da tua galera já chegaram": the owner's strip over the channels
 * of a server copied from Discord, for the week after the import. Flag
 * `discord_bring_crew`; what it says is `bringCrewStrip` in `lib/bring-crew.ts`.
 *
 * Same slot and shape as the arrival strip, which it replaces on these
 * servers: one strip under the header, never a dialog. The button copies the
 * same announcement the import's last screen offered, in the app's language,
 * with the import's permanent link (or a fresh one if that was revoked).
 */
export function BringCrewStrip({
  kind,
  count,
  serverName,
  resolveInviteCode,
  onDismiss,
}: {
  kind: BringCrewStripKind;
  count: number;
  serverName: string;
  /** The import's invite, or a minted one. Rejects when neither is possible. */
  resolveInviteCode: () => Promise<string>;
  onDismiss: () => void;
}) {
  const { t, locale } = useTranslation();
  const [state, setState] = useState<"idle" | "busy" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);
  const canShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  useEffect(() => {
    track("bring_crew_strip_view", { kind });
  }, [kind]);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );

  async function announcement(): Promise<string> {
    const code = await resolveInviteCode();
    return discordAnnouncement(
      defaultAnnouncementLang(locale),
      serverName,
      announcementUrl(window.location.origin, code),
    );
  }

  function settle(next: "copied" | "failed" | "idle") {
    setState(next);
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    if (next !== "idle") {
      timer.current = window.setTimeout(() => setState("idle"), COPY_MS);
    }
  }

  async function copy() {
    if (state === "busy") {
      return;
    }
    setState("busy");
    try {
      await navigator.clipboard.writeText(await announcement());
      track("bring_crew_copy", { surface: "strip", via: "copy", kind });
      settle("copied");
    } catch {
      settle("failed");
    }
  }

  async function share() {
    if (state === "busy") {
      return;
    }
    setState("busy");
    try {
      await navigator.share({ text: await announcement() });
      track("bring_crew_copy", { surface: "strip", via: "share", kind });
      settle("idle");
    } catch (error) {
      settle(error instanceof Error && error.name === "AbortError" ? "idle" : "failed");
    }
  }

  const title =
    kind === "arrived"
      ? t("bringCrew.strip.arrived", { count })
      : kind === "reminder"
        ? count === 0
          ? t("bringCrew.strip.reminderNobody")
          : t("bringCrew.strip.reminderFew", { count })
        : t("bringCrew.strip.emptyTitle");
  const body =
    state === "failed"
      ? t("bringCrew.strip.failed")
      : kind === "arrived"
        ? t("bringCrew.strip.arrivedBody")
        : kind === "reminder"
          ? t("bringCrew.strip.reminderBody")
          : t("bringCrew.strip.emptyBody");

  return (
    <div
      data-bring-crew-strip=""
      data-bring-crew-kind={kind}
      role="status"
      className="animate-rise flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-accent-soft px-4 py-3"
    >
      <span
        aria-hidden="true"
        className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"
      >
        <Users className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p
          data-bring-crew-title=""
          className="text-balance text-sm font-semibold tabular-nums text-on-accent-soft"
        >
          {title}
        </p>
        <p
          className={cn(
            "mt-0.5 text-pretty text-sm",
            state === "failed" ? "text-danger" : "text-on-accent-soft/80",
          )}
        >
          {body}
        </p>
      </div>
      {/* On a phone the buttons take their own row under the text, lined up
          with it (past the 32px icon and its 12px gap), as the arrival strip
          does. */}
      <div className="order-last flex w-full gap-2 pl-11 sm:order-none sm:w-auto sm:pl-0">
        <Button
          size="sm"
          data-bring-crew-strip-copy=""
          disabled={state === "busy"}
          onClick={() => void copy()}
        >
          {state === "copied" ? (
            <Check aria-hidden="true" className="animate-icon-swap h-3.5 w-3.5" />
          ) : (
            <Copy aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {state === "copied"
            ? t("bringCrew.announcement.copied")
            : t("bringCrew.announcement.copy")}
        </Button>
        {canShare && (
          <Button
            size="sm"
            variant="secondary"
            aria-label={t("invite.paste.share")}
            disabled={state === "busy"}
            onClick={() => void share()}
          >
            <Share2 aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <button
        type="button"
        data-bring-crew-close=""
        aria-label={t("bringCrew.strip.close")}
        onClick={onDismiss}
        className={cn(
          "relative shrink-0 rounded-[var(--radius-control)] p-1.5 text-on-accent-soft/70 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
          "after:absolute after:-inset-1.5 after:content-['']",
        )}
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}

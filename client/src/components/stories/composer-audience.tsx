import { ChevronUp, Users, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { StoryAudienceOptions } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { StoryButton, StoryCheckRow, StorySwitch } from "./composer-ui";

/**
 * "Quem vê". The chip sits next to "Postar" and says where the story will go
 * in one line; the sheet is the full list, with the reason for every server
 * the person may not post to, and the replies switch.
 *
 * The sheet rises inside the composer's own column (never the browser's
 * window), so on a phone it covers the bottom of the canvas and on a desktop
 * it stays inside the phone-shaped column the rest of the composer lives in.
 */

interface AudienceState {
  options: StoryAudienceOptions | null;
  failed: boolean;
  serverIds: string[];
  friends: boolean;
  /** A server the story must go to (the call sticker's), and may not be unticked. */
  lockedServerId: string | null;
  repliesEnabled: boolean;
}

/** The one-line summary the chip shows. */
export function audienceSummary(
  state: Pick<AudienceState, "options" | "serverIds" | "friends">,
  t: (key: "stories.audience.friends" | "stories.compose.audienceNone" | "stories.compose.audienceMany", vars?: Record<string, string | number>) => string,
): { text: string; empty: boolean } {
  const names = state.serverIds
    .map((id) => state.options?.servers.find((server) => server.serverId === id)?.serverName)
    .filter((name): name is string => Boolean(name));
  const total = names.length + (state.friends ? 1 : 0);
  if (total === 0) {
    return { text: t("stories.compose.audienceNone"), empty: true };
  }
  if (total === 1) {
    return { text: names[0] ?? t("stories.audience.friends"), empty: false };
  }
  return { text: t("stories.compose.audienceMany", { count: total }), empty: false };
}

export function AudienceChip({
  summary,
  onOpen,
}: {
  summary: { text: string; empty: boolean };
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      data-story-audience=""
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`${t("stories.audience.title")}: ${summary.text}`}
      className={cn(
        "flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border px-3.5 text-left text-sm font-semibold transition-colors",
      )}
      style={{
        background: "var(--story-field-fill)",
        borderColor: summary.empty ? "var(--story-accent)" : "var(--story-field-edge)",
        color: "var(--story-on-media)",
      }}
    >
      <Users className="h-4 w-4 shrink-0" aria-hidden style={{ color: summary.empty ? "var(--story-accent)" : undefined }} />
      <span className="min-w-0 flex-1 truncate">{summary.text}</span>
      <ChevronUp className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
    </button>
  );
}

export function AudienceSheet({
  state,
  numberFormat,
  onClose,
  onRetry,
  onToggleServer,
  onToggleFriends,
  onRepliesChange,
}: {
  state: AudienceState;
  numberFormat: Intl.NumberFormat;
  onClose: () => void;
  onRetry: () => void;
  onToggleServer: (serverId: string, next: boolean) => void;
  onToggleFriends: (next: boolean) => void;
  onRepliesChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const { options } = state;

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-end">
      <button
        type="button"
        tabIndex={-1}
        aria-label={t("stories.compose.close")}
        className="story-dim absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        role="group"
        aria-label={t("stories.audience.title")}
        data-story-audience-sheet=""
        className="story-cmp-sheet relative flex max-h-[78%] flex-col rounded-t-[22px] border-t backdrop-blur-xl"
        style={{ background: "var(--story-tray)", borderColor: "var(--story-hairline)", color: "var(--story-on-media)" }}
      >
        <div className="flex items-center justify-between gap-3 px-5 pb-1 pt-4">
          <div className="min-w-0">
            <h2 className="font-display text-base font-extrabold leading-tight">{t("stories.audience.title")}</h2>
            <p className="mt-0.5 text-xs leading-snug" style={{ color: "var(--story-on-media-2)" }}>
              {t("stories.audience.body")}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="story-cbtn"
            aria-label={t("stories.compose.close")}
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-2 pt-1">
          {state.failed && (
            <div className="flex items-center gap-3 px-2 py-1">
              <p role="alert" className="flex-1 text-sm ">
                {t("stories.audience.loadFailed")}
              </p>
              <StoryButton size="sm" variant="quiet" onClick={onRetry}>
                {t("stories.viewer.retry")}
              </StoryButton>
            </div>
          )}
          {options?.servers.map((server) => {
            const locked = server.serverId === state.lockedServerId && server.canPost;
            const checked = state.serverIds.includes(server.serverId) || locked;
            const reason =
              server.blockedReason === "timed_out"
                ? t("stories.audience.timedOut")
                : server.blockedReason === "account_too_new"
                  ? t("stories.audience.tooNew")
                  : server.blockedReason
                    ? t("stories.audience.noPermission")
                    : null;
            return (
              <StoryCheckRow
                key={server.serverId}
                checked={checked && server.canPost}
                disabled={!server.canPost || locked}
                label={server.serverName}
                description={
                  reason ??
                  (locked
                    ? t("stories.audience.callServer")
                    : t("stories.audience.members", {
                        count: server.memberCount,
                        countLabel: numberFormat.format(server.memberCount),
                      }))
                }
                onCheckedChange={(next) => onToggleServer(server.serverId, next)}
              />
            );
          })}
          {options?.friends.enabled && (
            <StoryCheckRow
              checked={state.friends}
              disabled={!options.friends.canPost}
              label={t("stories.audience.friends")}
              onCheckedChange={onToggleFriends}
            />
          )}
          {options && state.serverIds.length === 0 && !state.friends && !state.lockedServerId && (
            <p className="px-2 pt-1 text-xs" style={{ color: "var(--story-on-media-2)" }}>
              {t("stories.audience.none")}
            </p>
          )}
          <div className="px-2 pt-2">
            <StorySwitch
              checked={state.repliesEnabled}
              onCheckedChange={onRepliesChange}
              label={t("stories.audience.replies")}
              description={t("stories.audience.repliesHint")}
            />
          </div>
        </div>
        <div className="flex items-center gap-3 px-5 pb-4 pt-2">
          <p className="min-w-0 flex-1 text-xs leading-snug" style={{ color: "var(--story-on-media-2)" }}>
            {t("stories.audience.footer")}
          </p>
          <StoryButton onClick={onClose}>{t("stories.compose.done")}</StoryButton>
        </div>
      </div>
    </div>
  );
}

import type { Channel } from "@pqp/shared";
import { ArrowUpRight, Check } from "lucide-react";
import { useMemo, useState } from "react";
import { ChannelIcon } from "@/components/layout/channel-icon";
import { heroHue, heroTintStyle } from "@/lib/hero-tint";
import {
  isOverviewStartHereChannel,
  loadOverviewStartHereIds,
  OVERVIEW_START_HERE_MAX,
  overviewStartHereHint,
  resolveOverviewStartHereChannels,
  saveOverviewStartHereIds,
  toggleOverviewStartHereId,
  type OverviewStartHereHint,
} from "@/lib/community-home/overview-start-here";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const HINT_KEY: Record<OverviewStartHereHint, MessageKey> = {
  avisos: "communityHome.startHere.hint.avisos",
  ajuda: "communityHome.startHere.hint.ajuda",
  geral: "communityHome.startHere.hint.geral",
  voice: "communityHome.startHere.hint.voice",
  watchParty: "communityHome.startHere.hint.watchParty",
};

function displayName(channel: Pick<Channel, "name" | "type">): string {
  if (channel.type === "text") {
    return `#${channel.name}`;
  }
  return channel.name;
}

function blurb(
  channel: Channel,
  t: (key: MessageKey, vars?: { name?: string }) => string,
): string {
  const topic = channel.topic?.trim();
  if (topic) {
    return topic;
  }
  const hint = overviewStartHereHint(channel);
  if (hint) {
    return t(HINT_KEY[hint]);
  }
  return t("communityHome.startHere.hint.fallback");
}

/**
 * Destination cards under the Overview poster. A tap opens the channel.
 * Staff can pick up to four while editing the page; that pick stays in
 * localStorage on this browser until the API stores it.
 */
export function OverviewStartHere({
  serverId,
  channels,
  editing = false,
  canManageServer = false,
  onOpenChannel,
}: {
  serverId: string;
  channels: readonly Channel[];
  editing?: boolean;
  canManageServer?: boolean;
  onOpenChannel: (channelId: string) => void;
}) {
  const { t } = useTranslation();
  const [storedIds, setStoredIds] = useState<string[] | null>(() =>
    loadOverviewStartHereIds(serverId),
  );
  const [storageServerId, setStorageServerId] = useState(serverId);
  if (storageServerId !== serverId) {
    setStorageServerId(serverId);
    setStoredIds(loadOverviewStartHereIds(serverId));
  }

  const selected = useMemo(
    () => resolveOverviewStartHereChannels(channels, storedIds),
    [channels, storedIds],
  );
  const candidates = useMemo(
    () =>
      channels
        .filter(isOverviewStartHereChannel)
        .slice()
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [channels],
  );

  const showPicker = editing && canManageServer;
  if (selected.length === 0 && !showPicker) {
    return null;
  }

  function commit(next: string[]): void {
    setStoredIds(next);
    saveOverviewStartHereIds(serverId, next);
  }

  return (
    <section className="animate-rise" data-overview-start-here>
      <div className="mb-4 flex items-end justify-between gap-3">
        <h2 className="font-display text-lg font-bold text-text">
          {t("communityHome.startHere.heading")}
        </h2>
        {showPicker && (
          <p className="text-xs tabular-nums text-text-tertiary">
            {t("communityHome.startHere.pickCount", {
              count: selected.length,
              max: OVERVIEW_START_HERE_MAX,
            })}
          </p>
        )}
      </div>

      {showPicker && (
        <div
          className="mb-5 rounded-[var(--radius-panel)] border border-border bg-surface-1 p-3 sm:p-4"
          data-overview-start-here-pick
        >
          <p className="mb-1 text-sm font-semibold text-text">
            {t("communityHome.startHere.pickTitle")}
          </p>
          <p className="mb-3 text-xs leading-5 text-text-tertiary">
            {t("communityHome.startHere.pickHelp")}
          </p>
          <ul className="flex flex-wrap gap-2">
            {candidates.map((channel) => {
              const on = selected.some((row) => row.id === channel.id);
              const blocked = !on && selected.length >= OVERVIEW_START_HERE_MAX;
              return (
                <li key={channel.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    disabled={blocked}
                    onClick={() =>
                      commit(
                        toggleOverviewStartHereId(
                          channels,
                          storedIds,
                          channel.id,
                        ),
                      )
                    }
                    className={cn(
                      "inline-flex h-10 items-center gap-2 rounded-full border px-3 text-sm transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset disabled:opacity-40",
                      on
                        ? "border-accent bg-accent-soft text-on-accent-soft"
                        : "border-border bg-surface-0 text-text hover:bg-surface-2",
                    )}
                    data-overview-pick={channel.id}
                  >
                    {on && <Check className="h-3.5 w-3.5" aria-hidden />}
                    <span className="font-medium">{displayName(channel)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {selected.length > 0 && (
        <ul
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          data-overview-start-here-cards
        >
          {selected.map((channel) => (
            <li key={channel.id} className="min-w-0">
              <button
                type="button"
                onClick={() => onOpenChannel(channel.id)}
                className="cta-lift group relative flex h-full min-h-[11.5rem] w-full flex-col items-start overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface-1 p-5 text-left shadow-[var(--shadow-1)] transition-colors duration-[var(--duration-fast)] hover:border-border-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset"
                data-overview-channel={channel.id}
              >
                <span
                  aria-hidden
                  className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl text-text shadow-[var(--shadow-hero-avatar)] ring-2 ring-surface-0"
                  style={heroTintStyle(heroHue(channel.name), 55)}
                >
                  <ChannelIcon channel={channel} className="h-5 w-5" />
                </span>
                <span className="font-display text-xl font-bold leading-tight tracking-tight text-text">
                  {displayName(channel)}
                </span>
                <span className="mt-2 line-clamp-3 text-sm leading-6 text-text-secondary">
                  {blurb(channel, t)}
                </span>
                <span className="mt-auto flex items-center gap-1 pt-4 text-sm font-medium text-accent">
                  {t("communityHome.startHere.open", {
                    name: displayName(channel),
                  })}
                  <ArrowUpRight
                    className="h-4 w-4 transition-transform duration-[var(--duration-fast)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

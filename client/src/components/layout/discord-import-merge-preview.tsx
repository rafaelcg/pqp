import { Hash, Lock, MessagesSquare, Mic, ShieldCheck } from "lucide-react";
import type { CSSProperties } from "react";
import {
  discordMergeIsEmpty,
  type DiscordMergePreview,
  type MergeAddedChannel,
  type MergeSkipReason,
} from "@pqp/shared";
import { CheckRow } from "@/components/ui/check-row";
import { MAPPED_AWAY_KEYS } from "@/components/layout/discord-import-preview";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The preview step of "import into a server that already exists": what will be
 * added, what is already there and stays as it is, and what was left out and
 * why. Strictly a reading of `planDiscordMerge`; it decides nothing.
 */

const SKIP_KEYS: Record<MergeSkipReason, MessageKey> = {
  exists: "importDiscordMerge.skip.exists",
  duplicate: "importDiscordMerge.skip.duplicate",
  channelLimit: "importDiscordMerge.skip.channelLimit",
  categoryLimit: "importDiscordMerge.skip.categoryLimit",
};

const STAGGER_CAP = 10;

function staggerVars(index: number): CSSProperties {
  return { "--stagger": index } as CSSProperties;
}

function ChannelIcon({ channel }: { channel: Pick<MergeAddedChannel, "type" | "isPrivate"> }) {
  const Icon = channel.isPrivate
    ? Lock
    : channel.type === "voice"
      ? Mic
      : channel.type === "forum"
        ? MessagesSquare
        : Hash;
  return (
    <Icon
      aria-hidden
      className={cn(
        "h-3.5 w-3.5 shrink-0",
        channel.isPrivate ? "text-warning" : "text-paper-muted",
      )}
    />
  );
}

export function sumUntickedRules(
  preview: Pick<DiscordMergePreview, "addableRoles">,
  picked: ReadonlySet<number>,
): number {
  return preview.addableRoles
    .filter((role) => !picked.has(role.templateId))
    .reduce((total, role) => total + role.overwriteCount, 0);
}

export function DiscordImportMergePreview({
  preview,
  serverName,
  pickedRoles,
  onToggleRole,
}: {
  preview: DiscordMergePreview;
  serverName: string;
  pickedRoles: ReadonlySet<number>;
  onToggleRole: (templateId: number) => void;
}) {
  const { t } = useTranslation();
  const reduced = usePrefersReducedMotion();
  const empty = discordMergeIsEmpty(preview);

  // The sidebar the way it will read: loose channels first, then each category
  // in the order the template has them, new and reused alike.
  const groups: {
    key: string;
    name: string | null;
    badge: "new" | "here" | null;
    channels: MergeAddedChannel[];
  }[] = [];
  const loose = preview.addedChannels.filter((channel) => channel.categoryName === null);
  if (loose.length > 0) {
    groups.push({ key: "loose", name: null, badge: null, channels: loose });
  }
  for (const category of preview.addedCategories) {
    groups.push({
      key: `new-${category.templateId}`,
      name: category.name,
      badge: "new",
      channels: preview.addedChannels.filter(
        (channel) => channel.parentTemplateId === category.templateId,
      ),
    });
  }
  for (const category of preview.reusedCategories) {
    const channels = preview.addedChannels.filter(
      (channel) => channel.parentExistingId === category.existingId,
    );
    if (channels.length > 0) {
      groups.push({
        key: `here-${category.existingId}`,
        name: category.existingName.trim(),
        badge: "here",
        channels,
      });
    }
  }

  const here = preview.skipped.filter((item) => item.reason === "exists");
  const left = preview.skipped.filter((item) => item.reason !== "exists");
  const untickedRules = sumUntickedRules(preview, pickedRoles);
  const channelCount = preview.addedChannels.length;
  const categoryCount = preview.addedCategories.length;

  let index = 0;
  const next = () => staggerVars(Math.min(index++, STAGGER_CAP));

  return (
    <div className="space-y-4 text-sm" data-testid="discord-merge-preview">
      <p
        className="flex items-start gap-2 rounded-md border border-signal/35 bg-signal/5 px-3 py-2 text-paper"
        data-testid="discord-merge-safe"
      >
        <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-signal" />
        <span>{t("importDiscordMerge.preview.safe", { server: serverName })}</span>
      </p>

      {preview.isDirty && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-paper">
          {t("importDiscord.preview.unsynced")}
        </p>
      )}

      {empty ? (
        <p
          className="rounded-md border border-ink-4/60 bg-channel px-3 py-3 text-paper"
          data-testid="discord-merge-empty"
        >
          {t("importDiscordMerge.preview.empty")}
        </p>
      ) : (
        <section
          aria-labelledby="discord-merge-added"
          className="overflow-hidden rounded-xl border border-ink-4/60 bg-channel"
        >
          <div className="border-b border-ink-4/60 px-4 py-3">
            <h3 id="discord-merge-added" className="font-display text-base font-bold leading-tight">
              {t("importDiscordMerge.preview.addedTitle")}
            </h3>
            <p className="mt-0.5 text-xs text-paper-muted">
              {[
                channelCount > 0
                  ? t("importDiscordMerge.count.channels", { count: channelCount })
                  : null,
                categoryCount > 0
                  ? t("importDiscordMerge.count.categories", { count: categoryCount })
                  : null,
              ]
                .filter(Boolean)
                .join(", ")}
            </p>
          </div>
          <div className="max-h-64 overflow-y-auto px-1 py-3" data-testid="discord-merge-added">
            {groups.map((group) => (
              <div key={group.key} className="mb-2 last:mb-0">
                {group.name !== null && (
                  <div
                    style={reduced ? undefined : next()}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-paper-muted",
                      !reduced && "animate-rise",
                    )}
                  >
                    <span className="truncate">{group.name}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold tracking-wider",
                        group.badge === "new"
                          ? "bg-signal/15 text-signal"
                          : "bg-ink-3 text-paper-muted",
                      )}
                    >
                      {group.badge === "new"
                        ? t("importDiscordMerge.preview.newBadge")
                        : t("importDiscordMerge.preview.hereBadge")}
                    </span>
                  </div>
                )}
                <div className={cn(group.name !== null && "ml-2 border-l border-ink-4/70 pl-2")}>
                  {group.channels.map((channel) => (
                    <div
                      key={channel.templateId}
                      style={reduced ? undefined : next()}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-paper-muted",
                        !reduced && "animate-rise",
                      )}
                    >
                      <ChannelIcon channel={channel} />
                      <span className="truncate">{channel.name}</span>
                      {channel.isPrivate && (
                        <span className="ml-auto shrink-0 rounded bg-warning/10 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-warning">
                          {t("importDiscord.preview.private")}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {here.length > 0 && (
        <details className="rounded-xl border border-ink-4/60 bg-channel" data-testid="discord-merge-here">
          <summary className="cursor-pointer rounded-xl px-4 py-3 font-display text-base font-bold leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50">
            {t("importDiscordMerge.preview.hereTitle", { count: here.length })}
          </summary>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto px-4 pb-3 text-paper-muted">
            {here.map((item, i) => (
              <li key={`${item.kind}-${item.name}-${i}`} className="flex gap-1.5">
                <span className="truncate">{item.name}</span>
                {item.categoryName && (
                  <span className="shrink-0 text-paper-muted/70">
                    {t("importDiscordMerge.preview.inCategory", { category: item.categoryName.trim() })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {left.length > 0 && (
        <section className="rounded-xl border border-ink-4/60 bg-channel" data-testid="discord-merge-left">
          <div className="border-b border-ink-4/60 px-4 py-3">
            <h3 className="font-display text-base font-bold leading-tight">
              {t("importDiscordMerge.preview.leftTitle", { count: left.length })}
            </h3>
          </div>
          <ul className="max-h-40 space-y-1 overflow-y-auto px-4 py-3 text-paper-muted">
            {left.map((item, i) => (
              <li key={`${item.kind}-${item.name}-${i}`}>
                <span className="text-paper">{item.name}</span>
                {" "}
                <span>{t(SKIP_KEYS[item.reason])}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(preview.usage.channels.existing + channelCount + categoryCount >=
        preview.usage.channels.max ||
        left.some((item) => item.reason === "channelLimit" || item.reason === "categoryLimit")) && (
        <p className="text-xs text-paper-muted" data-testid="discord-merge-limits">
          {t("importDiscordMerge.preview.limits", {
            channels: preview.usage.channels.max,
            categories: preview.usage.categories.max,
          })}
        </p>
      )}

      {(preview.addableRoles.length > 0 || preview.reusedRoles.length > 0) && (
        <section className="rounded-xl border border-ink-4/60 bg-channel" data-testid="discord-merge-roles">
          <div className="border-b border-ink-4/60 px-4 py-3">
            <h3 className="font-display text-base font-bold leading-tight">
              {t("importDiscordMerge.roles.title")}
            </h3>
            <p className="mt-0.5 text-xs text-paper-muted">{t("importDiscordMerge.roles.hint")}</p>
          </div>
          <div className="px-2 py-2">
            {preview.addableRoles.length > 0 && !preview.canCreateRoles && (
              <p className="px-2 py-1 text-xs text-paper-muted">
                {t("importDiscordMerge.roles.noPermission")}
              </p>
            )}
            {preview.canCreateRoles &&
              preview.addableRoles.map((role) => (
                <CheckRow
                  key={role.templateId}
                  checked={pickedRoles.has(role.templateId)}
                  onCheckedChange={() => onToggleRole(role.templateId)}
                  label={role.name}
                  swatch={role.color}
                  description={
                    role.overwriteCount > 0
                      ? t("importDiscordMerge.roles.rules", { count: role.overwriteCount })
                      : undefined
                  }
                />
              ))}
            {preview.canCreateRoles && untickedRules > 0 && (
              <p className="px-2 pt-1 text-xs text-paper-muted" data-testid="discord-merge-rules-left">
                {t("importDiscordMerge.roles.rulesLeft", { count: untickedRules })}
              </p>
            )}
            {preview.reusedRoles.length > 0 && (
              <p className="px-2 pt-1 text-xs text-paper-muted">
                {t("importDiscordMerge.roles.reused", {
                  names: preview.reusedRoles.map((role) => role.existingName).join(", "),
                })}
              </p>
            )}
          </div>
        </section>
      )}

      <p className="text-xs text-paper-muted">{t("importDiscordMerge.preview.notCopied")}</p>

      {preview.mappedAway.length > 0 && (
        <details className="text-xs text-paper-muted">
          <summary className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50">
            {t("importDiscordMerge.preview.mappedTitle")}
          </summary>
          <ul className="mt-1 space-y-0.5 pl-4">
            {preview.mappedAway.map((item, i) => (
              <li key={`${item.reason}:${item.name ?? i}`}>
                {t(MAPPED_AWAY_KEYS[item.reason], item.name ? { name: item.name } : undefined)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

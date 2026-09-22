import {
  Ban,
  ChevronRight,
  Hash,
  Link2,
  Lock,
  MessageSquare,
  Mic,
  Minus,
  Paperclip,
  Smile,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type {
  DiscordImportPlan,
  MappedAwayReason,
  NotInTemplateReason,
} from "@pqp/shared";
import { ServerIcon } from "@/components/layout/server-identity";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The Discord import's preview: what will be created, and what will not.
 *
 * Its own file so two surfaces draw the SAME component: the Create community
 * dialog, with the plan the API returned, and the `/vem` campaign page, with a
 * fixed plan of the public Friends & Family template. A landing page that
 * showed a picture of this screen would drift from it the first time the
 * screen changed; this cannot.
 */

type PlanChannel = DiscordImportPlan["channels"][number];

const STAGGER_CAP = 10;

function staggerVars(index: number): CSSProperties {
  return { "--stagger": index } as CSSProperties;
}

const NOT_IN_TEMPLATE_KEYS: Record<NotInTemplateReason, MessageKey> = {
  members: "importDiscord.dropped.members",
  messages: "importDiscord.dropped.messages",
  attachments: "importDiscord.dropped.attachments",
  customEmoji: "importDiscord.dropped.customEmoji",
  webhooks: "importDiscord.dropped.webhooks",
  bans: "importDiscord.dropped.bans",
  discordInvites: "importDiscord.dropped.discordInvites",
};

const MAPPED_AWAY_KEYS: Record<MappedAwayReason, MessageKey> = {
  permissionBits: "importDiscord.mapped.permissionBits",
  overwrites: "importDiscord.mapped.overwrites",
  nsfw: "importDiscord.mapped.nsfw",
  slowmode: "importDiscord.mapped.slowmode",
  bitrate: "importDiscord.mapped.bitrate",
  forumTags: "importDiscord.mapped.forumTags",
  threads: "importDiscord.mapped.threads",
  directory: "importDiscord.mapped.directory",
  serverIcon: "importDiscord.mapped.serverIcon",
  unsanitisableRole: "importDiscord.mapped.unsanitisableRole",
  roleCap: "importDiscord.mapped.roleCap",
  flattenAnnouncement: "importDiscord.mapped.flattenAnnouncement",
  flattenForum: "importDiscord.mapped.flattenForum",
  flattenMedia: "importDiscord.mapped.flattenMedia",
  flattenStage: "importDiscord.mapped.flattenStage",
  topicTruncated: "importDiscord.mapped.topicTruncated",
};

export function DiscordImportPreview({
  plan,
  snapshotLabel,
}: {
  plan: DiscordImportPlan;
  snapshotLabel: string | null;
}) {
  const { t } = useTranslation();
  const reduced = usePrefersReducedMotion();
  const categories = plan.channels
    .filter((channel) => channel.type === "category")
    .sort((a, b) => a.position - b.position);
  const topText = plan.channels
    .filter((channel) => channel.type === "text" && channel.parentTemplateId == null)
    .sort((a, b) => a.position - b.position);
  const topVoice = plan.channels
    .filter((channel) => channel.type === "voice" && channel.parentTemplateId == null)
    .sort((a, b) => a.position - b.position);
  const cosmeticRoles = plan.roles;

  const comingCount =
    topText.length +
    topVoice.length +
    categories.length +
    plan.channels.filter((channel) => channel.parentTemplateId != null).length +
    (cosmeticRoles.length > 0 ? 1 : 0);
  let comingIndex = 0;
  const nextComing = () => staggerVars(Math.min(comingIndex++, STAGGER_CAP));

  return (
    <div className="space-y-4 text-sm">
      {plan.isDirty && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-paper">
          {t("importDiscord.preview.unsynced")}
        </p>
      )}
      {snapshotLabel && (
        <p className="text-paper-muted">
          {t("importDiscord.preview.snapshot", { date: snapshotLabel })}
        </p>
      )}
      <p className="text-paper-muted">{t("importDiscord.preview.renameNote")}</p>

      <aside className="overflow-hidden rounded-xl border border-ink-4/60 bg-channel">
        <div className="flex min-h-14 items-center gap-2.5 border-b border-ink-4/60 px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-ink-3 font-display text-xs font-bold text-paper">
            <ServerIcon name={plan.serverName} iconUrl={plan.iconUrl} />
          </span>
          <p className="truncate font-display text-base font-bold leading-tight">
            {plan.serverName}
          </p>
        </div>
        <div className="max-h-72 overflow-y-auto px-1 py-3">
          {topText.length > 0 && (
            <PreviewSection label={t("chrome.text")}>
              {topText.map((channel) => (
                <PreviewChannelRow
                  key={channel.templateId}
                  channel={channel}
                  reduced={reduced}
                  style={nextComing()}
                />
              ))}
            </PreviewSection>
          )}
          {topVoice.length > 0 && (
            <PreviewSection label={t("chrome.voice")}>
              {topVoice.map((channel) => (
                <PreviewChannelRow
                  key={channel.templateId}
                  channel={channel}
                  reduced={reduced}
                  style={nextComing()}
                />
              ))}
            </PreviewSection>
          )}
          {categories.length > 0 && (
            <PreviewSection label={t("chrome.categories")}>
              {categories.map((category) => {
                const children = plan.channels
                  .filter(
                    (channel) => channel.parentTemplateId === category.templateId,
                  )
                  .sort((a, b) => a.position - b.position);
                const headerStyle = nextComing();
                return (
                  <div key={category.templateId} className="mb-1">
                    <div
                      className={cn(
                        "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide text-paper-muted",
                        !reduced && "animate-rise",
                      )}
                      style={reduced ? undefined : headerStyle}
                    >
                      <ChevronRight className="h-3 w-3 shrink-0 rotate-90" />
                      <span className="truncate">{category.name}</span>
                    </div>
                    <div className="ml-2 border-l border-ink-4/70 pl-2">
                      {children.map((child) => (
                        <PreviewChannelRow
                          key={child.templateId}
                          channel={child}
                          reduced={reduced}
                          style={nextComing()}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </PreviewSection>
          )}
          {cosmeticRoles.length > 0 && (
            <PreviewSection label={t("importDiscord.preview.rolesSection")}>
              <ul
                className={cn(
                  "flex flex-wrap gap-1.5 px-2 py-1",
                  !reduced && "animate-rise",
                )}
                style={reduced ? undefined : nextComing()}
              >
                {cosmeticRoles.map((role) => (
                  <li
                    key={role.name}
                    className="rounded-full border border-ink-4 bg-ink-3/50 px-2 py-0.5 text-xs"
                    style={role.color ? { color: role.color } : undefined}
                  >
                    {role.name}
                  </li>
                ))}
              </ul>
              <p className="px-2 pt-1 text-[11px] text-paper-muted">
                {t("importDiscord.preview.rolesHint")}
              </p>
            </PreviewSection>
          )}
        </div>
      </aside>

      <aside
        className={cn(
          "overflow-hidden rounded-xl border border-ink-4/60 bg-channel",
          !reduced && "animate-rise",
        )}
        style={reduced ? undefined : staggerVars(Math.min(comingCount, STAGGER_CAP) + 4)}
      >
        <div className="border-b border-ink-4/60 px-4 py-3">
          <p className="font-display text-base font-bold leading-tight text-paper-muted">
            {t("importDiscord.dropped.sectionTitle")}
          </p>
        </div>
        <div className="max-h-56 overflow-y-auto px-1 py-3">
          <PreviewSection label={t("importDiscord.dropped.notInTemplateTitle")}>
            {plan.notInTemplate.map((reason) => (
              <DroppedRow
                key={reason}
                icon={NOT_IN_TEMPLATE_ICONS[reason]}
                label={t(NOT_IN_TEMPLATE_KEYS[reason])}
              />
            ))}
          </PreviewSection>
          {plan.mappedAway.length > 0 && (
            <PreviewSection label={t("importDiscord.dropped.mappedTitle")}>
              {plan.mappedAway.map((item, index) => (
                <DroppedRow
                  key={`${item.reason}:${item.name ?? index}`}
                  icon={Minus}
                  label={t(
                    MAPPED_AWAY_KEYS[item.reason],
                    item.name ? { name: item.name } : undefined,
                  )}
                />
              ))}
            </PreviewSection>
          )}
        </div>
      </aside>
    </div>
  );
}

function PreviewSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 px-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

function PreviewChannelRow({
  channel,
  reduced,
  style,
}: {
  channel: PlanChannel;
  reduced: boolean;
  style: CSSProperties;
}) {
  const { t } = useTranslation();
  const Icon = channel.isPrivate ? Lock : channel.type === "voice" ? Mic : Hash;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-paper-muted",
        !reduced && "animate-rise",
      )}
      style={reduced ? undefined : style}
    >
      <Icon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          channel.isPrivate ? "text-warning" : "text-paper-muted",
        )}
      />
      <span className="truncate">{channel.name}</span>
      {channel.isPrivate && (
        <span className="ml-auto shrink-0 rounded bg-warning/10 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-warning">
          {t("importDiscord.preview.private")}
        </span>
      )}
    </div>
  );
}

const NOT_IN_TEMPLATE_ICONS: Record<NotInTemplateReason, LucideIcon> = {
  members: Users,
  messages: MessageSquare,
  attachments: Paperclip,
  customEmoji: Smile,
  webhooks: Webhook,
  bans: Ban,
  discordInvites: Link2,
};

function DroppedRow({
  icon: Icon,
  label,
}: {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <div className="flex items-start gap-1.5 rounded-md px-2 py-1.5 text-sm text-paper-muted/80">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" />
      <span className="leading-snug">{label}</span>
    </div>
  );
}


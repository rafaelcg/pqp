import type { Channel, ServerBotActivityItem, ServerBotDto, ServerBotOverview } from "@pqp/shared";
import { CARD_LIST, CARD_SURFACE } from "@/components/ui/card";
import {
  Alarm,
  ChartBar,
  ChatCircleDots,
  Hash as HashGlyph,
  LinkSimple,
  PaperPlaneTilt,
  PushPin,
  Timer as TimerGlyph,
  Trash,
  UserMinus as UserMinusGlyph,
  Wrench as WrenchGlyph,
  X as XGlyph,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { IconSwap } from "@/components/ui/icon";
import { useRedesign } from "@/lib/redesign";
import {
  AlarmClock,
  BarChart3,
  Hash,
  Link2,
  MessageSquarePlus,
  Pin,
  Send,
  Timer,
  Trash2,
  UserMinus,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

export type BotTab = "overview" | "voice" | "powers";

const TABS: Array<[BotTab, MessageKey]> = [
  ["overview", "bots.settings.tab.overview"],
  ["voice", "bots.settings.tab.voice"],
  ["powers", "bots.settings.tab.powers"],
];

/** The bot page's three tabs: a real tablist, arrow keys move between them. */
export function BotTabs({ value, onChange }: { value: BotTab; onChange: (next: BotTab) => void }) {
  const { t } = useTranslation();
  return (
    <Tabs
      label={t("bots.settings.tabs")}
      variant="underline"
      value={value}
      onValueChange={onChange}
      items={TABS.map(([id, label]) => ({ id, label: t(label) }))}
    />
  );
}

const ACTIVITY_ICON: Record<string, LucideIcon> = {
  create_channel: Hash,
  edit_channel: Hash,
  move_channel: Hash,
  delete_channel: Trash2,
  delete_message: Trash2,
  pin_message: Pin,
  post_message: Send,
  create_thread: MessageSquarePlus,
  create_forum_post: MessageSquarePlus,
  reply_forum_post: MessageSquarePlus,
  create_poll: BarChart3,
  create_invite: Link2,
  create_reminder: AlarmClock,
  cancel_reminder: AlarmClock,
  timeout_member: Timer,
  kick_member: UserMinus,
  ban_member: UserMinus,
};

/** The same map in filled Phosphor, for the redesign. */
const ACTIVITY_GLYPH: Record<string, PhosphorIcon> = {
  create_channel: HashGlyph,
  edit_channel: HashGlyph,
  move_channel: HashGlyph,
  delete_channel: Trash,
  delete_message: Trash,
  pin_message: PushPin,
  post_message: PaperPlaneTilt,
  create_thread: ChatCircleDots,
  create_forum_post: ChatCircleDots,
  reply_forum_post: ChatCircleDots,
  create_poll: ChartBar,
  create_invite: LinkSimple,
  create_reminder: Alarm,
  cancel_reminder: Alarm,
  timeout_member: TimerGlyph,
  kick_member: UserMinusGlyph,
  ban_member: UserMinusGlyph,
};

/** Today's numbers and the latest things the bot did. */
export function BotOverviewPanel({
  bot,
  overview,
  channels,
  onOpenPowers,
}: {
  bot: ServerBotDto;
  overview: ServerBotOverview | null;
  channels: Channel[];
  /** Opens the Canais e poderes tab, where the bot's channels are marked. */
  onOpenPowers?: () => void;
}) {
  const { t, locale } = useTranslation();
  const redesign = useRedesign();
  const confirmedToday = overview?.confirmedToday ?? 0;
  const used = overview?.repliesToday ?? bot.repliesToday;
  const max = overview?.repliesPerDay ?? bot.repliesPerDay;
  const homes = channels.filter((channel) => bot.channelIds.includes(channel.id));
  const homeNames = homes.slice(0, 3).map((channel) => `#${channel.name}`);
  const more = homes.length - homeNames.length;
  // Under the redesign a zero reads as a word ("Nenhum canal"), not CLDR's "0 canal".
  const nowhere = redesign && homes.length === 0;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t("bots.overview.replies")}>
          <p className="font-display text-3xl font-extrabold text-text">
            {used} <span className="text-base font-semibold text-text-tertiary redesign:text-text-secondary">{t("bots.overview.of", { max })}</span>
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${max > 0 ? Math.min(100, (used / max) * 100) : 0}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-text-tertiary redesign:text-text-secondary">{t("bots.overview.resets")}</p>
        </Stat>
        <Stat label={t("bots.overview.actions")}>
          <p className="font-display text-3xl font-extrabold text-text">{overview?.actionsToday ?? 0}</p>
          <p className="mt-2 text-xs text-text-tertiary redesign:text-text-secondary">
            {redesign && confirmedToday === 0
              ? t("bots.overview.confirmedNone")
              : t("bots.overview.confirmed", { count: confirmedToday })}
          </p>
        </Stat>
        <Stat label={t("bots.overview.lives")}>
          <p className={cn("font-display text-3xl font-extrabold text-text", nowhere && "redesign:text-xl redesign:font-bold")}>
            {nowhere ? t("bots.overview.channelsNone") : t("bots.overview.channels", { count: homes.length })}
          </p>
          {nowhere ? (
            // Awake but in no channel: say so, and a button to the tab that marks them.
            <>
              {bot.enabled && <p className="mt-2 text-xs text-text-secondary">{t("bots.overview.nowhere")}</p>}
              {onOpenPowers && (
                <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={onOpenPowers}>
                  {t("bots.overview.pickChannels")}
                </Button>
              )}
            </>
          ) : (
            <p className="mt-2 truncate text-xs text-text-tertiary">
              {homeNames.join(", ")}
              {more > 0 ? ` ${t("bots.overview.andMore", { count: more })}` : ""}
            </p>
          )}
        </Stat>
      </div>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-text">{t("bots.overview.recent")}</h3>
        {!overview || overview.recent.length === 0 ? (
          <p className={cn(CARD_SURFACE, "p-4 text-sm text-text-tertiary redesign:text-text-secondary")}>
            {t("bots.overview.nothingYet", { name: bot.name })}
          </p>
        ) : (
          <ul className={cn(CARD_SURFACE, CARD_LIST)}>
            {overview.recent.map((item, index) => (
              <ActivityRow key={index} item={item} locale={locale} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={cn(CARD_SURFACE, "p-4")}>
      <p className="mb-1 text-xs font-bold uppercase tracking-wide text-text-tertiary redesign:text-[length:var(--section-label-size)] redesign:font-semibold redesign:normal-case redesign:tracking-normal redesign:text-text-secondary">{label}</p>
      {children}
    </div>
  );
}

function ActivityRow({ item, locale }: { item: ServerBotActivityItem; locale: Parameters<typeof intlLocale>[0] }) {
  const { t } = useTranslation();
  const cancelled = item.kind === "cancelled";
  const Icon = cancelled ? X : (ACTIVITY_ICON[item.tool ?? ""] ?? Wrench);
  const glyph = cancelled ? XGlyph : (ACTIVITY_GLYPH[item.tool ?? ""] ?? WrenchGlyph);
  const tone = cancelled
    ? "bg-surface-3 text-text-secondary"
    : item.status === "failed"
      ? "bg-danger-soft text-on-danger-soft"
      : item.tool?.startsWith("delete") || item.tool === "kick_member" || item.tool === "ban_member"
        ? "bg-warning-soft text-on-warning-soft"
        : "bg-accent-soft text-on-accent-soft";
  const who = item.requesterName ?? "";
  const by = cancelled
    ? t("bots.overview.cancelledBy", { who, count: Number(item.label) || 0 })
    : item.confirmed
      ? t("bots.overview.confirmedBy", { who })
      : t("bots.overview.askedBy", { who });
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-control)] redesign:rounded-full", tone)}>
        <IconSwap off={Icon} on={glyph} offClassName="h-4 w-4" />
      </span>
      <p className="min-w-0 flex-1 truncate text-sm text-text">
        {cancelled ? t("bots.overview.planCancelled") : item.label}
        {item.status === "failed" && <span className="text-danger"> · {t("bots.overview.failed")}</span>}
        {who && <span className="text-text-tertiary"> · {by}</span>}
      </p>
      <time className="shrink-0 text-xs text-text-tertiary" dateTime={item.at}>
        {new Date(item.at).toLocaleTimeString(intlLocale(locale), { hour: "2-digit", minute: "2-digit" })}
      </time>
    </li>
  );
}

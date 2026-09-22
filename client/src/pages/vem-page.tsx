import { useAuth, useClerk } from "@clerk/clerk-react";
import {
  ArrowDown,
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Hash,
  LayoutList,
  Lock,
  Mic,
} from "lucide-react";
import { Fragment, useEffect, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { DiscordImportPlan } from "@pqp/shared";
import { DiscordImportPreview } from "@/components/layout/discord-import-preview";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import {
  intentStorage,
  stashCreateIntent,
  type CreateIntent,
} from "@/lib/handle-intent";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * `/vem`: the "Vem pra pqp" campaign page.
 *
 * ONE ARGUMENT: moving a group is a social cost, and pqp attacks it directly.
 * The sidebar comes over from a Discord template link in two minutes, and the
 * people come over by clicking an invite that opens in the browser. Everything
 * on the page serves that, in the order a skeptical visitor asks: what is it,
 * how exactly does the import work, what is already there when my friends
 * arrive, how does it compare, and the objections.
 *
 * NOT `/vs-discord` AND NOT `/tela`. Both of those are framed on the Discord
 * suspension in Brazil; this campaign never mentions it, and the suite pins
 * that (`marketing-meta.test.ts`). Copy source: the campaign's LANDING.md.
 *
 * THE WALKTHROUGH IS THE REAL FLOW. Step 3 is the shipped preview component
 * itself (`DiscordImportPreview`) fed a fixed plan of the public template;
 * steps 2 and 4 are drawn from the same catalogue keys the dialog renders
 * (`importDiscord.*`, `communities.create.*`), so a copy change in the product
 * shows up here too, in the visitor's language and theme. Steps 1 and 5 happen on Discord, and are drawn as a
 * generic silhouette on purpose: no Discord logo, colour or UI.
 *
 * EVERY CTA CARRIES AN INTENT through sign-up (`CreateIntent` in
 * `lib/handle-intent.ts`): "copy my Discord layout" lands on Create community
 * already at the template box, "create my community" on the name field.
 *
 * Role tokens only, so it follows the visitor's theme; it sits outside
 * `DarkRoutes` in `main.tsx`.
 */

/** In page order. The edge serves the same pairs as FAQPage (`VEM_FAQ`). */
export const VEM_FAQ_IDS = [
  "friends",
  "safe",
  "free",
  "bots",
  "messages",
  "install",
  "size",
  "back",
] as const;

const FEATURE_IDS = [
  "share",
  "watch",
  "voice",
  "chat",
  "handle",
  "roles",
  "free",
  "own",
  "brazil",
] as const;

const COMPARE_IDS = [
  "voice",
  "share",
  "watch",
  "import",
  "price",
  "open",
  "selfhost",
  "brazil",
  "apps",
  "bots",
  "maturity",
  "age",
] as const;

const COMES_KEYS: MessageKey[] = [
  "vem.import.comes.name",
  "vem.import.comes.channels",
  "vem.import.comes.names",
  "vem.import.comes.topics",
  "vem.import.comes.roles",
  "vem.import.comes.private",
];

/** The public "Friends & Family" template: no real people in it. */
const SAMPLE_SERVER = "Friends & Family";
const SAMPLE_INVITE = "https://pqp.gg/app/invite/fR3nds";

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

const EYEBROW = "text-xs font-semibold uppercase tracking-[0.18em] text-accent";
const H2 =
  "text-balance font-display text-3xl font-bold tracking-tight text-text sm:text-4xl";
const PANEL = "rounded-[var(--radius-panel)] border border-border bg-surface-1";

// ---------------------------------------------------------------------------
// CTAs
// ---------------------------------------------------------------------------

interface VemCtaProps {
  intent: CreateIntent;
  label: MessageKey;
  /** Where on the page, for the Umami event. */
  placement: string;
  variant?: "default" | "secondary";
  className?: string;
}

const CTA_CLASS = "cta-lift h-12 px-6 text-base";

function appHref(intent: CreateIntent): string {
  return `/app?create=${intent}`;
}

/**
 * A sign-up button that remembers what it was pressed for.
 *
 * The Umami attributes are inert unless the hosted build carries the tag
 * (`VITE_UMAMI_WEBSITE_ID`), which is the whole analytics story on a
 * self-host: nothing.
 */
function VemCta(props: VemCtaProps) {
  return isDevAuthBypassEnabled() ? (
    <BypassVemCta {...props} />
  ) : (
    <ClerkVemCta {...props} />
  );
}

/** Dev bypass has no ClerkProvider: the account already exists, go straight in. */
function BypassVemCta({
  intent,
  label,
  placement,
  variant,
  className,
}: VemCtaProps) {
  const { t } = useTranslation();
  return (
    <Button asChild variant={variant} className={cn(CTA_CLASS, className)}>
      <Link
        to={appHref(intent)}
        data-umami-event="vem-cta"
        data-umami-event-intent={intent}
        data-umami-event-placement={placement}
      >
        {t(label)}
      </Link>
    </Button>
  );
}

function useOpenAuth() {
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const navigate = useNavigate();
  return (mode: "signUp" | "signIn", target: string) => {
    const go = () => void navigate(target);
    if (isSignedIn) {
      go();
      return;
    }
    if (!isLoaded) {
      go();
      return;
    }
    try {
      const open =
        mode === "signUp"
          ? clerk.openSignUp({ forceRedirectUrl: target })
          : clerk.openSignIn({ forceRedirectUrl: target });
      void Promise.resolve(open).catch(go);
    } catch {
      go();
    }
  };
}

function ClerkVemCta({
  intent,
  label,
  placement,
  variant,
  className,
}: VemCtaProps) {
  const { t } = useTranslation();
  const openAuth = useOpenAuth();
  return (
    <Button
      type="button"
      variant={variant}
      className={cn(CTA_CLASS, className)}
      data-umami-event="vem-cta"
      data-umami-event-intent={intent}
      data-umami-event-placement={placement}
      onClick={() => {
        // Stashed BEFORE Clerk takes over: the modal can end in a navigation
        // this page does not survive. The URL carries it too, as the belt.
        stashCreateIntent(intentStorage(), intent);
        openAuth("signUp", appHref(intent));
      }}
    >
      {t(label)}
    </Button>
  );
}

const INLINE_LINK =
  "font-medium text-text underline decoration-text-tertiary/50 underline-offset-4 transition-colors hover:decoration-text";

function SignInLink() {
  if (isDevAuthBypassEnabled()) {
    return <SignInBypass />;
  }
  return <SignInClerk />;
}

function SignInBypass() {
  const { t } = useTranslation();
  return (
    <Link to="/app" className={INLINE_LINK}>
      {t("vem.hero.signIn")}
    </Link>
  );
}

function SignInClerk() {
  const { t } = useTranslation();
  const openAuth = useOpenAuth();
  return (
    <button
      type="button"
      className={INLINE_LINK}
      data-umami-event="vem-sign-in"
      onClick={() => openAuth("signIn", "/app")}
    >
      {t("vem.hero.signIn")}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/**
 * `t()` with one slot rendered as a node. The catalogue keeps the sentence
 * whole (translators see `{option}` in place); the page bolds the value.
 */
function withSlot(
  sentence: string,
  marker: string,
  node: ReactNode,
): ReactNode {
  const parts = sentence.split(marker);
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 && node}
    </Fragment>
  ));
}

/** A window chrome for the drawn frames: three quiet dots, no product name. */
function FrameShell({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure
      role="img"
      aria-label={label}
      className={cn(
        "overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface-1 shadow-[var(--shadow-2)]",
        className,
      )}
    >
      <div aria-hidden className="select-none">
        {children}
      </div>
    </figure>
  );
}

function Bar({ className }: { className?: string }) {
  return (
    <span className={cn("block h-2.5 rounded-full bg-surface-3", className)} />
  );
}

// ---------------------------------------------------------------------------
// The hero's picture: the same room, there and here
// ---------------------------------------------------------------------------

function SidebarSilhouette() {
  const rows = [
    { w: "w-20", lock: false },
    { w: "w-24", lock: false },
    { w: "w-16", lock: true },
    { w: "w-28", lock: false },
    { w: "w-20", lock: true },
    { w: "w-24", lock: false },
  ];
  return (
    <div className="flex h-full flex-col gap-4 p-4 opacity-60 blur-[1px]">
      <div className="flex items-center gap-2.5">
        <span className="h-8 w-8 rounded-[var(--radius-card)] bg-surface-3" />
        <Bar className="w-24" />
      </div>
      <Bar className="h-2 w-14 opacity-70" />
      <div className="space-y-3">
        {rows.slice(0, 3).map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            {row.lock ? (
              <Lock className="h-3 w-3 text-text-tertiary" />
            ) : (
              <span className="h-3 w-3 rounded-sm bg-surface-3" />
            )}
            <Bar className={row.w} />
          </div>
        ))}
      </div>
      <Bar className="h-2 w-16 opacity-70" />
      <div className="space-y-3">
        {rows.slice(3).map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            {row.lock ? (
              <Lock className="h-3 w-3 text-text-tertiary" />
            ) : (
              <span className="h-3 w-3 rounded-sm bg-surface-3" />
            )}
            <Bar className={row.w} />
          </div>
        ))}
      </div>
    </div>
  );
}

function SidebarRow({
  icon: Icon,
  name,
  selected = false,
}: {
  icon: typeof Hash;
  name: string;
  selected?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-[var(--radius-control)] px-2 py-1.5 text-sm",
        selected
          ? "bg-accent-soft font-semibold text-on-accent-soft"
          : "text-text-secondary",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-80" />
      <span className="truncate">{name}</span>
    </div>
  );
}

function SidebarCategory({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1 px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">
      <ChevronRight className="h-3 w-3 rotate-90" />
      {label}
    </div>
  );
}

/** The Friends & Family template as the import builds it, names untouched. */
function PqpSidebar() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-card)] bg-surface-2 font-display text-xs font-bold text-text">
          FR
        </span>
        <span className="truncate font-display text-sm font-bold text-text">
          {SAMPLE_SERVER}
        </span>
      </div>
      <div className="px-2 pb-3">
        <SidebarCategory label="Text Channels" />
        <SidebarRow icon={Hash} name="general" selected />
        <SidebarRow icon={Hash} name="games" />
        <SidebarRow icon={Hash} name="music" />
        <SidebarCategory label="Voice Channels" />
        <SidebarRow icon={Mic} name="Lounge" />
        <SidebarRow icon={Mic} name="Stream Room" />
      </div>
    </div>
  );
}

function MoveVisual() {
  const { t } = useTranslation();
  return (
    <figure
      role="img"
      aria-label={t("vem.hero.visualLabel")}
      className="relative mx-auto w-full max-w-md lg:max-w-none"
    >
      <div
        aria-hidden
        className="grid grid-cols-[minmax(0,0.8fr)_auto_minmax(0,1fr)] items-stretch gap-2 sm:gap-3"
      >
        <div className="flex flex-col">
          <span className="mb-2 flex min-h-10 items-end text-[11px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">
            {t("vem.hero.before")}
          </span>
          <div className="flex-1 rounded-[var(--radius-panel)] border border-dashed border-border bg-surface-1/60">
            <SidebarSilhouette />
          </div>
        </div>
        <div className="flex items-center pt-6">
          <ArrowRight className="h-5 w-5 text-text-tertiary" />
        </div>
        <div className="flex flex-col">
          <span className="mb-2 flex min-h-10 items-end text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary">
            {t("vem.hero.after")}
          </span>
          <div className="flex-1 overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface-1 shadow-[var(--shadow-2)]">
            <PqpSidebar />
          </div>
        </div>
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// The walkthrough's drawn frames
// ---------------------------------------------------------------------------

/** Step 1, on Discord, drawn as a generic settings page. */
function TemplatesMock() {
  const { t } = useTranslation();
  return (
    <FrameShell label={t("vem.import.shot1")}>
      <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[9rem_minmax(0,1fr)]">
        <div className="hidden space-y-3 border-r border-border bg-surface-0/60 p-4 sm:block">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">
            {t("vem.import.mock.settings")}
          </span>
          <Bar className="w-16" />
          <Bar className="w-20" />
          <span className="-mx-2 block rounded-[var(--radius-control)] bg-surface-2 px-2 py-1 text-xs font-semibold text-text">
            {t("vem.import.mock.templates")}
          </span>
          <Bar className="w-14" />
          <Bar className="w-[4.5rem]" />
        </div>
        <div className="min-w-0 space-y-4 p-4 sm:p-5">
          <p className="font-display text-base font-bold text-text">
            {t("vem.import.mock.templates")}
          </p>
          <div className="space-y-2">
            <Bar className="w-full max-w-[14rem]" />
            <Bar className="w-3/4 max-w-[10rem]" />
          </div>
          <div className="space-y-2 rounded-[var(--radius-card)] border border-border bg-surface-0/60 p-3">
            <p className="text-xs font-semibold text-text-secondary">
              {t("vem.import.mock.templateName")}
            </p>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate rounded-[var(--radius-control)] border border-border bg-surface-1 px-2.5 py-2 font-mono text-xs text-text">
                discord.new/fR3nds
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-control)] bg-surface-3 px-3 py-2 text-xs font-semibold text-text">
                <Copy className="h-3.5 w-3.5" />
                {t("vem.import.mock.copy")}
              </span>
            </div>
          </div>
        </div>
      </div>
    </FrameShell>
  );
}

/** Step 2, the real Create community dialog, drawn from its own keys. */
function CreateDialogMock() {
  const { t } = useTranslation();
  return (
    <FrameShell label={t("vem.import.shot2")}>
      <div className="border-b border-border px-5 pb-4 pt-5">
        <p className="font-display text-xl font-bold text-text">
          {t("communities.create.title")}
        </p>
        <p className="mt-1 text-sm text-text-tertiary">
          {t("communities.create.body")}
        </p>
      </div>
      <div className="space-y-4 px-5 py-4">
        <span className="block rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 py-2 text-sm text-text-tertiary">
          {t("communities.create.placeholder")}
        </span>
        <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-tertiary">
          <span className="h-px flex-1 bg-border" />
          {t("importDiscord.mode.or")}
          <span className="h-px flex-1 bg-border" />
        </div>
        <div className="flex w-full items-start gap-3 rounded-[var(--radius-card)] border-2 border-accent bg-accent-soft px-4 py-3.5 text-left">
          <LayoutList className="mt-0.5 h-5 w-5 shrink-0 text-on-accent-soft" />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-on-accent-soft">
              {t("importDiscord.mode.discord")}
            </span>
            <span className="mt-0.5 block text-sm text-text-secondary">
              {t("importDiscord.mode.discordBody")}
            </span>
          </span>
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <span className="rounded-[var(--radius-control)] px-4 py-2 text-sm text-text-tertiary">
          {t("invite.join.cancel")}
        </span>
        <span className="rounded-[var(--radius-control)] bg-surface-2 px-4 py-2 text-sm font-semibold text-text-tertiary">
          {t("chrome.create")}
        </span>
      </div>
    </FrameShell>
  );
}

/**
 * The plan `POST /api/import/discord/preview` returns for the public
 * "Friends & Family" template (discord.new/fR3nds is illustrative; the tree
 * and the dropped list are what the real template maps to).
 */
const SAMPLE_PLAN: DiscordImportPlan = {
  serverName: SAMPLE_SERVER,
  templateUpdatedAt: "2020-05-01T00:00:00.000Z",
  isDirty: false,
  iconUrl: null,
  channels: [
    {
      templateId: 1,
      parentTemplateId: null,
      type: "category",
      name: "Text Channels",
      topic: null,
      topicTruncated: false,
      position: 0,
      isPrivate: false,
    },
    {
      templateId: 2,
      parentTemplateId: 1,
      type: "text",
      name: "general",
      topic: null,
      topicTruncated: false,
      position: 0,
      isPrivate: false,
    },
    {
      templateId: 3,
      parentTemplateId: 1,
      type: "text",
      name: "games",
      topic: null,
      topicTruncated: false,
      position: 1,
      isPrivate: false,
    },
    {
      templateId: 4,
      parentTemplateId: 1,
      type: "text",
      name: "music",
      topic: null,
      topicTruncated: false,
      position: 2,
      isPrivate: false,
    },
    {
      templateId: 5,
      parentTemplateId: null,
      type: "category",
      name: "Voice Channels",
      topic: null,
      topicTruncated: false,
      position: 1,
      isPrivate: false,
    },
    {
      templateId: 6,
      parentTemplateId: 5,
      type: "voice",
      name: "Lounge",
      topic: null,
      topicTruncated: false,
      position: 0,
      isPrivate: false,
    },
    {
      templateId: 7,
      parentTemplateId: 5,
      type: "voice",
      name: "Stream Room",
      topic: null,
      topicTruncated: false,
      position: 1,
      isPrivate: false,
    },
  ],
  roles: [],
  everyonePermissions: null,
  overwrites: [],
  privateChannelNames: [],
  notInTemplate: [
    "members",
    "messages",
    "attachments",
    "customEmoji",
    "webhooks",
    "bans",
  ],
  mappedAway: [],
};

/** Step 3, the real preview component with the dialog's own frame around it. */
function PreviewMock() {
  const { t, locale } = useTranslation();
  const snapshot = new Date(SAMPLE_PLAN.templateUpdatedAt!).toLocaleDateString(
    locale === "pt-BR" ? "pt-BR" : "en",
    { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" },
  );
  return (
    <FrameShell label={t("vem.import.shot3")}>
      <div className="border-b border-border px-5 pb-4 pt-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
          {t("importDiscord.eyebrow")}
        </p>
        <p className="mt-1 font-display text-xl font-bold text-text">
          {t("importDiscord.preview.title")}
        </p>
        <p className="mt-1 text-sm text-text-tertiary">
          {t("importDiscord.preview.subtitle", { name: SAMPLE_SERVER })}
        </p>
      </div>
      <div className="px-5 py-4">
        <DiscordImportPreview plan={SAMPLE_PLAN} snapshotLabel={snapshot} />
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <span className="rounded-[var(--radius-control)] px-4 py-2 text-sm text-text-tertiary">
          {t("importDiscord.preview.back")}
        </span>
        <span className="rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-semibold text-on-accent">
          {t("importDiscord.preview.confirm")}
        </span>
      </div>
    </FrameShell>
  );
}

function pasteMessage(t: ReturnType<typeof useTranslation>["t"]): string {
  return t("importDiscord.done.pasteMessage", {
    server: SAMPLE_SERVER,
    link: SAMPLE_INVITE,
  });
}

/** Step 4, the import's last screen, drawn from its own keys. */
function DoneMock() {
  const { t } = useTranslation();
  return (
    <FrameShell label={t("vem.import.shot4")}>
      <div className="border-b border-border px-5 pb-4 pt-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
          {t("importDiscord.eyebrow")}
        </p>
        <p className="mt-1 font-display text-xl font-bold text-text">
          {t("importDiscord.done.title")}
        </p>
        <p className="mt-1 text-sm text-text-tertiary">
          {t("importDiscord.done.body")}
        </p>
      </div>
      <div className="space-y-4 px-5 py-4 text-sm">
        <div>
          <p className="text-text">{t("importDiscord.done.invite")}</p>
          <div className="mt-1 flex gap-2">
            <span className="min-w-0 flex-1 truncate rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 py-2 text-text-secondary">
              {SAMPLE_INVITE}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 py-2 text-text">
              <Copy className="h-4 w-4" />
              {t("importDiscord.done.copyInvite")}
            </span>
          </div>
        </div>
        <div>
          <p className="text-text">{t("importDiscord.done.pasteLabel")}</p>
          <p className="mt-1 rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 py-2 leading-relaxed text-text">
            {pasteMessage(t)}
          </p>
          <span className="mt-2 inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 py-2 text-text">
            <Copy className="h-4 w-4" />
            {t("importDiscord.done.copyMessage")}
          </span>
        </div>
      </div>
    </FrameShell>
  );
}

/** Step 5, back on Discord: a generic channel with the pasted message. */
function PasteBackMock() {
  const { t } = useTranslation();
  const message = pasteMessage(t);
  const [before, after = ""] = message.split(SAMPLE_INVITE);
  return (
    <FrameShell label={t("vem.import.shot5")}>
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Hash className="h-4 w-4 text-text-tertiary" />
        <span className="font-semibold text-text">
          {t("vem.import.mock.channel")}
        </span>
        <Bar className="ml-3 hidden w-24 opacity-60 sm:block" />
      </div>
      <div className="space-y-5 px-5 py-5">
        <div className="flex gap-3 opacity-50">
          <span className="h-9 w-9 shrink-0 rounded-full bg-surface-3" />
          <div className="flex-1 space-y-2 pt-1">
            <Bar className="w-20" />
            <Bar className="w-4/5 max-w-[16rem]" />
          </div>
        </div>
        <div className="flex gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-bold text-text">
            {t("vem.import.mock.you").slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-text">
                {t("vem.import.mock.you")}
              </span>
              <span className="text-xs text-text-tertiary">
                {t("vem.import.mock.now")}
              </span>
            </p>
            <p className="mt-0.5 break-words text-sm leading-relaxed text-text-secondary">
              {before}
              <span className="text-text underline underline-offset-2">
                {SAMPLE_INVITE}
              </span>
              {after}
            </p>
          </div>
        </div>
      </div>
    </FrameShell>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface StepDef {
  title: MessageKey;
  body: MessageKey;
  visual: ReactNode;
}

function ImportSteps() {
  const { t } = useTranslation();
  const optionMarker = "\u0000";
  const steps: StepDef[] = [
    {
      title: "vem.import.step1.title",
      body: "vem.import.step1.body",
      visual: <TemplatesMock />,
    },
    {
      title: "vem.import.step2.title",
      body: "vem.import.step2.body",
      visual: <CreateDialogMock />,
    },
    {
      title: "vem.import.step3.title",
      body: "vem.import.step3.body",
      visual: <PreviewMock />,
    },
    {
      title: "vem.import.step4.title",
      body: "vem.import.step4.body",
      visual: <DoneMock />,
    },
    {
      title: "vem.import.step5.title",
      body: "vem.import.step5.body",
      visual: <PasteBackMock />,
    },
  ];

  return (
    <ol className="mt-14 space-y-16 sm:space-y-20">
      {steps.map((step, index) => {
        const body =
          step.body === "vem.import.step2.body"
            ? withSlot(
                t(step.body, { option: optionMarker }),
                optionMarker,
                <strong className="font-semibold text-text">
                  {t("importDiscord.mode.discord")}
                </strong>,
              )
            : t(step.body);
        return (
          <li
            key={step.title}
            className="grid grid-cols-[minmax(0,1fr)] items-center gap-6 lg:grid-cols-2 lg:gap-14"
          >
            <div className={cn(index % 2 === 1 && "lg:order-2")}>
              <p className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent font-display text-sm font-bold text-on-accent">
                  {index + 1}
                </span>
                <span className="sr-only">
                  {t("vem.import.stepLabel", { n: index + 1 })}
                </span>
                <span className="font-display text-2xl font-bold tracking-tight text-text">
                  {t(step.title)}
                </span>
              </p>
              <p className="mt-4 max-w-lg text-pretty text-base leading-relaxed text-text-secondary sm:text-lg">
                {body}
              </p>
            </div>
            <div className={cn("w-full", index % 2 === 1 && "lg:order-1")}>
              {step.visual}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ComesAndStays() {
  const { t } = useTranslation();
  return (
    <div className="mt-16 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
      <div className={cn(PANEL, "p-6 sm:p-8")}>
        <h3 className="font-display text-xl font-bold tracking-tight text-text">
          {t("vem.import.comes.title")}
        </h3>
        <ul className="mt-5 space-y-3">
          {COMES_KEYS.map((key) => (
            <li key={key} className="flex items-start gap-3 text-text">
              <Check
                aria-hidden
                className="mt-0.5 h-4 w-4 shrink-0 text-success"
              />
              <span className="text-pretty leading-relaxed">{t(key)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className={cn(PANEL, "space-y-6 p-6 sm:p-8")}>
        <div>
          <h3 className="font-display text-xl font-bold tracking-tight text-text">
            {t("vem.import.stays.title")}
          </h3>
          <p className="mt-4 text-pretty font-semibold leading-relaxed text-text">
            {t("vem.import.stays.list")}
          </p>
          <p className="mt-2 text-pretty leading-relaxed text-text-secondary">
            {t("vem.import.stays.body")}
          </p>
        </div>
        <div className="border-t border-border pt-6">
          <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-text-tertiary">
            {t("vem.import.details.title")}
          </h3>
          <p className="mt-2 text-pretty text-sm leading-relaxed text-text-secondary">
            {t("vem.import.details.body")}
          </p>
        </div>
      </div>
    </div>
  );
}

function Compare() {
  const { t } = useTranslation();
  return (
    <>
      <div className="mt-10 hidden overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface-1 md:block">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{t("vem.compare.caption")}</caption>
          <thead>
            <tr className="border-b border-border bg-surface-2">
              <th
                scope="col"
                className="w-[34%] px-5 py-4 text-xs font-semibold uppercase tracking-[0.16em] text-text-tertiary"
              >
                {t("vem.compare.col.thing")}
              </th>
              <th
                scope="col"
                className="w-[33%] border-l border-border px-5 py-4 font-brand text-lg tracking-tight text-accent"
              >
                {t("vem.compare.col.pqp")}
              </th>
              <th
                scope="col"
                className="w-[33%] border-l border-border px-5 py-4 text-xs font-semibold uppercase tracking-[0.16em] text-text-tertiary"
              >
                {t("vem.compare.col.discord")}
              </th>
            </tr>
          </thead>
          <tbody>
            {COMPARE_IDS.map((id) => (
              <tr key={id} className="border-b border-border last:border-b-0">
                <th
                  scope="row"
                  className="px-5 py-4 align-top font-semibold text-text"
                >
                  {t(`vem.compare.${id}.label` as MessageKey)}
                </th>
                <td className="border-l border-border px-5 py-4 align-top text-text">
                  {t(`vem.compare.${id}.pqp` as MessageKey)}
                </td>
                <td className="border-l border-border px-5 py-4 align-top text-text-secondary">
                  {t(`vem.compare.${id}.discord` as MessageKey)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul
        className="mt-8 space-y-3 md:hidden"
        aria-label={t("vem.compare.caption")}
      >
        {COMPARE_IDS.map((id) => (
          <li
            key={id}
            className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-1"
          >
            <p className="border-b border-border px-4 py-3 text-sm font-semibold text-text">
              {t(`vem.compare.${id}.label` as MessageKey)}
            </p>
            <dl className="divide-y divide-border text-sm">
              <div className="flex gap-3 px-4 py-3">
                <dt className="w-16 shrink-0 font-brand tracking-tight text-accent">
                  {t("vem.compare.col.pqp")}
                </dt>
                <dd className="text-text">
                  {t(`vem.compare.${id}.pqp` as MessageKey)}
                </dd>
              </div>
              <div className="flex gap-3 px-4 py-3">
                <dt className="w-16 shrink-0 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                  {t("vem.compare.col.discord")}
                </dt>
                <dd className="text-text-secondary">
                  {t(`vem.compare.${id}.discord` as MessageKey)}
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * `/vem#importar` has to land on the section even though the page is a lazy
 * chunk the browser's own anchor jump runs before. One effect, once, after the
 * first paint of this page.
 */
function useScrollToHash() {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const id = decodeURIComponent(hash.slice(1));
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView({ block: "start" });
    }
  }, [hash]);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function VemPage() {
  const { t, locale } = useTranslation();
  useScrollToHash();
  // The anchor is the Portuguese word everywhere (`/discord` points at it and
  // it is what gets shared); English readers get it as an alias below.
  const importAnchor = "importar";

  return (
    <div className="flex min-h-full flex-col bg-surface-0 text-text">
      <Seo
        title={t("vem.seo.title")}
        description={t("vem.seo.description")}
        path="/vem"
        image={locale === "en" ? "/images/og-vem-en.png" : "/images/og-vem.png"}
      />
      <MarketingNav />

      <main className="relative flex-1 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[42rem] bg-[radial-gradient(ellipse_at_top,var(--glow-accent),transparent_60%)]"
          aria-hidden
        />

        {/* Hero */}
        <section
          className="relative mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] items-center gap-12 px-4 pb-16 pt-12 sm:px-8 sm:pt-20 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-16 lg:pb-24"
          aria-labelledby="vem-title"
        >
          <div>
            <p className={cn(EYEBROW, "animate-rise")} style={stagger(0)}>
              {t("vem.hero.eyebrow")}
            </p>
            <h1
              id="vem-title"
              className="animate-rise mt-5 text-balance font-display text-5xl font-extrabold leading-[1.02] tracking-tight text-text sm:text-6xl lg:text-7xl"
              style={stagger(1)}
            >
              {t("vem.hero.titleLead")}{" "}
              <span className="text-accent">{t("vem.hero.titleAccent")}</span>
            </h1>
            <p
              className="animate-rise mt-6 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary sm:text-xl"
              style={stagger(2)}
            >
              {t("vem.hero.body")}
            </p>
            <div
              className="animate-rise mt-9 flex flex-col gap-3 sm:flex-row sm:items-center"
              style={stagger(3)}
            >
              <VemCta
                intent="new"
                label="vem.cta.create"
                placement="hero"
                className="w-full sm:w-auto"
              />
              <Button
                asChild
                variant="secondary"
                className={cn(CTA_CLASS, "w-full sm:w-auto")}
              >
                <a
                  href={`#${importAnchor}`}
                  data-umami-event="vem-how-import"
                  onClick={(event) => {
                    const target = document.getElementById(importAnchor);
                    if (target) {
                      event.preventDefault();
                      target.scrollIntoView({ behavior: "smooth" });
                      window.history.replaceState(null, "", `#${importAnchor}`);
                    }
                  }}
                >
                  {t("vem.cta.howImport")}
                  <ArrowDown aria-hidden className="h-4 w-4" />
                </a>
              </Button>
            </div>
            <p
              className="animate-rise mt-5 text-sm text-text-tertiary"
              style={stagger(4)}
            >
              {t("vem.hero.hint")} {t("vem.hero.signInPrompt")} <SignInLink />
            </p>
          </div>

          <div className="animate-rise" style={stagger(3)}>
            <MoveVisual />
          </div>
        </section>

        {/* Quick proof */}
        <section
          className="relative border-y border-border bg-surface-1"
          aria-label={t("vem.hero.eyebrow")}
        >
          <ul className="mx-auto grid max-w-6xl gap-x-8 gap-y-4 px-4 py-8 text-sm leading-relaxed text-text-secondary sm:grid-cols-2 sm:px-8 lg:grid-cols-4">
            <li className="flex gap-3">
              <Check
                aria-hidden
                className="mt-0.5 h-4 w-4 shrink-0 text-success"
              />
              <span>
                {t("vem.proof.party")}{" "}
                <Link
                  to="/blog"
                  className={cn(INLINE_LINK, "whitespace-nowrap")}
                >
                  {t("vem.proof.partyLink")}
                </Link>
              </span>
            </li>
            {(
              [
                "vem.proof.open",
                "vem.proof.region",
                "vem.proof.platforms",
              ] as const
            ).map((key) => (
              <li key={key} className="flex gap-3">
                <Check
                  aria-hidden
                  className="mt-0.5 h-4 w-4 shrink-0 text-success"
                />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Import walkthrough */}
        <section
          id={importAnchor}
          className="relative mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-8 sm:py-28"
          aria-labelledby="vem-import-title"
        >
          {/* English speakers guess `#import`; keep it working. */}
          <span id="import" className="absolute -top-20" aria-hidden />
          <div className="max-w-3xl">
            <p className={EYEBROW}>{t("vem.import.eyebrow")}</p>
            <h2 id="vem-import-title" className={cn(H2, "mt-4")}>
              {t("vem.import.title")}
            </h2>
            <p className="mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-text-secondary">
              {t("vem.import.lede")}
            </p>
          </div>

          <ImportSteps />
          <ComesAndStays />

          <div className="mt-12 flex justify-center">
            <VemCta
              intent="discord"
              label="vem.cta.import"
              placement="import"
            />
          </div>
        </section>

        {/* What they find */}
        <section
          className="border-t border-border bg-surface-1"
          aria-labelledby="vem-features-title"
        >
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-8 sm:py-28">
            <div className="max-w-3xl">
              <p className={EYEBROW}>{t("vem.features.eyebrow")}</p>
              <h2 id="vem-features-title" className={cn(H2, "mt-4")}>
                {t("vem.features.title")}
              </h2>
            </div>
            <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURE_IDS.map((id) => (
                <li
                  key={id}
                  className="rounded-[var(--radius-panel)] border border-border bg-surface-0 p-6"
                >
                  <h3 className="text-balance font-display text-lg font-bold leading-snug tracking-tight text-text">
                    {t(`vem.features.${id}.title` as MessageKey)}
                  </h3>
                  <p className="mt-3 text-pretty text-sm leading-relaxed text-text-secondary">
                    {t(`vem.features.${id}.body` as MessageKey)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Side by side */}
        <section
          className="mx-auto max-w-6xl px-4 py-20 sm:px-8 sm:py-28"
          aria-labelledby="vem-compare-title"
        >
          <div className="max-w-3xl">
            <p className={EYEBROW}>{t("vem.compare.eyebrow")}</p>
            <h2 id="vem-compare-title" className={cn(H2, "mt-4")}>
              {t("vem.compare.title")}
            </h2>
            <p className="mt-5 text-pretty text-lg leading-relaxed text-text-secondary">
              {t("vem.compare.intro")}
            </p>
          </div>
          <Compare />
          <p className="mt-8 max-w-3xl text-pretty leading-relaxed text-text-secondary">
            {t("vem.compare.closing")}
          </p>
        </section>

        {/* FAQ */}
        <section
          className="border-t border-border bg-surface-1"
          aria-labelledby="vem-faq-title"
        >
          <div className="mx-auto max-w-3xl px-4 py-20 sm:px-8 sm:py-28">
            <h2 id="vem-faq-title" className={H2}>
              {t("vem.faq.title")}
            </h2>
            <dl className="mt-10 divide-y divide-border border-y border-border">
              {VEM_FAQ_IDS.map((id) => (
                <div key={id} className="py-6">
                  <dt className="font-display text-lg font-bold tracking-tight text-text">
                    {t(`vem.faq.${id}.q` as MessageKey)}
                  </dt>
                  <dd className="mt-2 text-pretty leading-relaxed text-text-secondary">
                    {t(`vem.faq.${id}.a` as MessageKey)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* Final CTA */}
        <section
          className="relative mx-auto max-w-4xl px-4 py-20 text-center sm:px-8 sm:py-28"
          aria-labelledby="vem-final-title"
        >
          <h2 id="vem-final-title" className={cn(H2, "sm:text-5xl")}>
            {t("vem.final.title")}
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-text-secondary">
            {t("vem.final.body")}
          </p>
          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <VemCta intent="new" label="vem.cta.create" placement="final" />
            <VemCta
              intent="discord"
              label="vem.cta.import"
              placement="final"
              variant="secondary"
            />
          </div>
          <p className="mt-10 font-display text-2xl font-bold tracking-tight text-text">
            {t("vem.final.closing")}
          </p>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-sm leading-relaxed text-text-tertiary">
            {t("vem.footer.iphone")}{" "}
            <Link to="/beta" className={INLINE_LINK}>
              {t("vem.footer.iphoneLink")}
            </Link>{" "}
            {t("vem.footer.android")}{" "}
            <Link to="/android" className={INLINE_LINK}>
              {t("vem.footer.androidLink")}
            </Link>{" "}
            {t("vem.footer.code")}{" "}
            <a
              href={SOURCE_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={INLINE_LINK}
            >
              {t("vem.footer.codeLink")}
            </a>
          </p>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}

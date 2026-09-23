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
import {
  Fragment,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { DiscordImportPlan } from "@pqp/shared";
import { DiscordImportPreview } from "@/components/layout/discord-import-preview";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { useScrollReveal } from "@/hooks/use-scroll-reveal";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import {
  createIntentHref,
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
 *
 * MOTION tells the same story as the copy: the headline lands word by word,
 * the old sidebar empties while the pqp one fills in the same order and the
 * crew turns up in the voice channel, and each step of the walkthrough plays
 * its one click when it scrolls in. CSS keyframes on transform and opacity
 * only (`vem-*` in `index.css`); `useScrollReveal` starts the clock per block.
 * The DOM is always the finished page: reduced motion, no JavaScript and
 * crawlers all get it as is.
 */

/** The hero's clock (ms): eyebrow, then the words, then everything else. */
const HERO_WORDS = 90;
const HERO_BODY = 760;

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

/** An animation delay in milliseconds, read by every `vem-*` class as `--d`. */
function at(ms: number): CSSProperties {
  return { "--d": Math.round(ms) } as CSSProperties;
}

const EYEBROW = "text-xs font-semibold uppercase tracking-[0.18em] text-accent";
const H2 =
  "text-balance font-display text-3xl font-bold tracking-tight text-text sm:text-4xl";
const PANEL = "rounded-[var(--radius-panel)] border border-border bg-surface-1";

// ---------------------------------------------------------------------------
// CTAs
// ---------------------------------------------------------------------------

/**
 * The page's two buttons, by the name the Umami events already report. Each
 * is the same `CreateIntent` a `?import=discord` campaign link carries, so a
 * CTA and a link land in exactly the same place.
 */
const VEM_INTENTS = {
  discord: { mode: "import", source: null },
  new: { mode: "name", source: null },
} as const satisfies Record<string, CreateIntent>;

type VemIntent = keyof typeof VEM_INTENTS;

interface VemCtaProps {
  intent: VemIntent;
  label: MessageKey;
  /** Where on the page, for the Umami event. */
  placement: string;
  variant?: "default" | "secondary";
  className?: string;
}

const CTA_CLASS = "cta-lift vem-cta h-12 px-6 text-base";

function appHref(intent: VemIntent): string {
  return createIntentHref(VEM_INTENTS[intent]);
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
        stashCreateIntent(intentStorage(), VEM_INTENTS[intent]);
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

/**
 * The walkthrough's pointer. It sits inside the control it clicks, glides in,
 * presses at 60% of its run and leaves, so its own style is invisible and a
 * page with no motion simply has no cursor. The click lands at `delay + ~1s`
 * (`CLICK_AFTER`), which is when the control's own reaction is timed.
 */
const CLICK_AFTER = 1000;

/** When a step's pointer sets off, after its frame has risen into place. */
const STEP_CURSOR = 380;
/** Step 3 waits for the real preview's tree to finish assembling first. */
const PREVIEW_CURSOR = 900;

function FakeCursor({ delay }: { delay: number }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 20"
      className="vem-cursor pointer-events-none absolute left-[62%] top-[58%] z-10 h-5 w-4"
      style={at(delay)}
    >
      <path
        d="M1.5 1.5v14.2l3.9-3.6 2.6 6 2.4-1-2.6-5.9h5.3z"
        className="fill-text stroke-surface-0"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Copy becomes a check when the pointer clicks it; both stay in the DOM. */
function CopiedIcon({
  at: when,
  className,
}: {
  at: number;
  className: string;
}) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <Copy
        className="vem-swap-out absolute inset-0 h-full w-full"
        style={at(when)}
      />
      <Check className="vem-swap-in h-full w-full" style={at(when)} />
    </span>
  );
}

/**
 * The headline, one word at a time, each rising out of its own clipped box.
 * A beat after a full stop, so "Muda de casa." lands before "Leva a galera."
 * Real words in real text: it reads, wraps and balances like any heading.
 */
function HeadlineWords({
  lead,
  accent,
  start,
}: {
  lead: string;
  accent: string;
  start: number;
}) {
  const words = [
    ...lead
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => ({ word, accent: false })),
    ...accent
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => ({ word, accent: true })),
  ];
  let delay = start;
  return words.map(({ word, accent: isAccent }, index) => {
    const style = at(delay);
    delay += /[.!?]$/.test(word) ? 210 : 75;
    return (
      <Fragment key={index}>
        {index > 0 && " "}
        <span className="vem-word-clip">
          <span
            className={cn("vem-word", isAccent && "text-accent")}
            style={style}
          >
            {word}
          </span>
        </span>
      </Fragment>
    );
  });
}

// ---------------------------------------------------------------------------
// The hero's picture: the same room, there and here
// ---------------------------------------------------------------------------

/*
 * The move, as a timeline (ms after the picture scrolls in). The old sidebar
 * empties top to bottom while the pqp one fills in the same order, each pqp
 * row entering from the side the old place is on; then `general` is selected
 * and the crew turns up in Lounge, one of them already talking.
 */
const MOVE_START = 820;
const MOVE_STEP = 105;
const MOVE_SELECT = MOVE_START + 8 * MOVE_STEP + 120;
const MOVE_CREW = MOVE_SELECT + 180;

function SidebarSilhouette() {
  const rows = [
    { w: "w-20", lock: false },
    { w: "w-24", lock: false },
    { w: "w-16", lock: true },
    { w: "w-28", lock: false },
    { w: "w-20", lock: true },
    { w: "w-24", lock: false },
  ];
  // Header, category, three rows, category, three rows: nine pieces leaving
  // in the order their counterparts arrive on the right.
  const leave = (piece: number) => at(MOVE_START - 60 + piece * MOVE_STEP);
  const row = (item: (typeof rows)[number], piece: number) => (
    <div
      key={piece}
      className="vem-dim flex items-center gap-2"
      style={leave(piece)}
    >
      {item.lock ? (
        <Lock className="h-3 w-3 text-text-tertiary" />
      ) : (
        <span className="h-3 w-3 rounded-sm bg-surface-3" />
      )}
      <Bar className={item.w} />
    </div>
  );
  return (
    <div className="flex h-full flex-col gap-4 p-4 opacity-60 blur-[1px]">
      <div className="vem-dim flex items-center gap-2.5" style={leave(0)}>
        <span className="h-8 w-8 rounded-[var(--radius-card)] bg-surface-3" />
        <Bar className="w-24" />
      </div>
      <span className="vem-dim block" style={leave(1)}>
        <Bar className="h-2 w-14 opacity-70" />
      </span>
      <div className="space-y-3">
        {rows.slice(0, 3).map((item, index) => row(item, 2 + index))}
      </div>
      <span className="vem-dim block" style={leave(5)}>
        <Bar className="h-2 w-16 opacity-70" />
      </span>
      <div className="space-y-3">
        {rows.slice(3).map((item, index) => row(item, 6 + index))}
      </div>
    </div>
  );
}

function SidebarRow({
  icon: Icon,
  name,
  piece,
  selected = false,
  children,
}: {
  icon: typeof Hash;
  name: string;
  piece: number;
  selected?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="vem-from-left" style={at(MOVE_START + piece * MOVE_STEP)}>
      <div
        className={cn(
          "relative flex items-center gap-1.5 rounded-[var(--radius-control)] px-2 py-1.5 text-sm",
          selected
            ? "font-semibold text-on-accent-soft"
            : "text-text-secondary",
        )}
      >
        {selected && (
          // The selection is its own layer so it can fade in: opacity, not a
          // background-colour transition.
          <span
            className="vem-fade absolute inset-0 rounded-[var(--radius-control)] bg-accent-soft"
            style={at(MOVE_SELECT)}
          />
        )}
        <Icon className="relative h-3.5 w-3.5 shrink-0 opacity-80" />
        <span className="relative truncate">{name}</span>
      </div>
      {children}
    </div>
  );
}

function SidebarCategory({ label, piece }: { label: string; piece: number }) {
  return (
    <div
      className="vem-from-left flex items-center gap-1 px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary"
      style={at(MOVE_START + piece * MOVE_STEP)}
    >
      <ChevronRight className="h-3 w-3 rotate-90" />
      {label}
    </div>
  );
}

/** Initials only: the crew is anyone's, and nobody on it is a real person. */
const CREW = ["M", "J", "L", "R"];

/** Who is in Lounge, drawn like the app's voice roster, the first one talking. */
function LoungeCrew() {
  return (
    <div className="flex items-center gap-1.5 pb-1 pl-7 pt-0.5">
      {CREW.map((initial, index) => (
        <span
          key={initial}
          className="vem-pop relative flex h-6 w-6 items-center justify-center"
          style={at(MOVE_CREW + index * 85)}
        >
          {index === 0 && (
            <span
              className="vem-ring absolute inset-0 rounded-full border-2 border-accent"
              style={at(MOVE_CREW + 500)}
            />
          )}
          <span
            className={cn(
              "relative flex h-6 w-6 items-center justify-center rounded-full bg-surface-3 text-[10px] font-bold text-text-secondary",
              index === 0 &&
                "text-text shadow-[var(--shadow-speaking)] ring-2 ring-accent",
            )}
          >
            {initial}
          </span>
        </span>
      ))}
    </div>
  );
}

/** The Friends & Family template as the import builds it, names untouched. */
function PqpSidebar() {
  return (
    <div className="flex h-full flex-col">
      <div
        className="vem-from-left flex items-center gap-2.5 border-b border-border px-4 py-3"
        style={at(MOVE_START - 60)}
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-card)] bg-surface-2 font-display text-xs font-bold text-text">
          FR
        </span>
        <span className="truncate font-display text-sm font-bold text-text">
          {SAMPLE_SERVER}
        </span>
      </div>
      <div className="px-2 pb-3">
        <SidebarCategory label="Text Channels" piece={1} />
        <SidebarRow icon={Hash} name="general" piece={2} selected />
        <SidebarRow icon={Hash} name="games" piece={3} />
        <SidebarRow icon={Hash} name="music" piece={4} />
        <SidebarCategory label="Voice Channels" piece={5} />
        <SidebarRow icon={Mic} name="Lounge" piece={6}>
          <LoungeCrew />
        </SidebarRow>
        <SidebarRow icon={Mic} name="Stream Room" piece={7} />
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
        <div className="vem-rise flex flex-col" style={at(280)}>
          <span className="mb-2 flex min-h-10 items-end text-[11px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">
            {t("vem.hero.before")}
          </span>
          <div className="flex-1 rounded-[var(--radius-panel)] border border-dashed border-border bg-surface-1/60">
            <SidebarSilhouette />
          </div>
        </div>
        <div className="vem-fade flex items-center pt-6" style={at(330)}>
          <span className="vem-nudge block" style={at(MOVE_START)}>
            <ArrowRight className="h-5 w-5 text-text-tertiary" />
          </span>
        </div>
        <div className="vem-rise flex flex-col" style={at(380)}>
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
              <span
                className="vem-press relative inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-control)] bg-surface-3 px-3 py-2 text-xs font-semibold text-text"
                style={at(STEP_CURSOR + CLICK_AFTER)}
              >
                <CopiedIcon
                  at={STEP_CURSOR + CLICK_AFTER + 40}
                  className="h-3.5 w-3.5"
                />
                {t("vem.import.mock.copy")}
                <FakeCursor delay={STEP_CURSOR} />
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
        <div
          className="vem-press relative flex w-full items-start gap-3 rounded-[var(--radius-card)] border-2 border-border px-4 py-3.5 text-left"
          style={at(STEP_CURSOR + CLICK_AFTER)}
        >
          {/* Chosen on the click: the selected look is a layer that fades in. */}
          <span
            className="vem-fade absolute -inset-0.5 rounded-[var(--radius-card)] border-2 border-accent bg-accent-soft"
            style={at(STEP_CURSOR + CLICK_AFTER + 60)}
          />
          <LayoutList className="relative mt-0.5 h-5 w-5 shrink-0 text-on-accent-soft" />
          <span className="relative min-w-0 flex-1">
            <span className="block font-semibold text-on-accent-soft">
              {t("importDiscord.mode.discord")}
            </span>
            <span className="mt-0.5 block text-sm text-text-secondary">
              {t("importDiscord.mode.discordBody")}
            </span>
          </span>
          <ChevronRight className="relative mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
          <FakeCursor delay={STEP_CURSOR} />
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
        <span
          className="vem-press relative rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-semibold text-on-accent"
          style={at(PREVIEW_CURSOR + CLICK_AFTER)}
        >
          {t("importDiscord.preview.confirm")}
          <FakeCursor delay={PREVIEW_CURSOR} />
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
            <span
              className="vem-press relative inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 py-2 text-text"
              style={at(STEP_CURSOR + CLICK_AFTER)}
            >
              <CopiedIcon
                at={STEP_CURSOR + CLICK_AFTER + 40}
                className="h-4 w-4"
              />
              {t("importDiscord.done.copyInvite")}
              <FakeCursor delay={STEP_CURSOR} />
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
        <div className="vem-rise flex gap-3" style={at(STEP_CURSOR + 200)}>
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
            <div data-reveal className={cn(index % 2 === 1 && "lg:order-2")}>
              <p className="flex items-center gap-3">
                <span
                  className="vem-pop flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent font-display text-sm font-bold text-on-accent"
                  style={at(0)}
                >
                  {index + 1}
                </span>
                <span className="sr-only">
                  {t("vem.import.stepLabel", { n: index + 1 })}
                </span>
                <span
                  className="vem-rise font-display text-2xl font-bold tracking-tight text-text"
                  style={at(70)}
                >
                  {t(step.title)}
                </span>
              </p>
              <p
                className="vem-rise mt-4 max-w-lg text-pretty text-base leading-relaxed text-text-secondary sm:text-lg"
                style={at(150)}
              >
                {body}
              </p>
            </div>
            <div
              data-reveal="late"
              className={cn("vem-rise w-full", index % 2 === 1 && "lg:order-1")}
              style={at(60)}
            >
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
      <div
        data-reveal
        className={cn(PANEL, "vem-rise p-6 sm:p-8")}
        style={at(0)}
      >
        <h3 className="font-display text-xl font-bold tracking-tight text-text">
          {t("vem.import.comes.title")}
        </h3>
        <ul className="mt-5 space-y-3">
          {COMES_KEYS.map((key, index) => (
            <li
              key={key}
              className="vem-rise flex items-start gap-3 text-text"
              style={at(160 + index * 70)}
            >
              <Check
                aria-hidden
                className="vem-pop mt-0.5 h-4 w-4 shrink-0 text-success"
                style={at(260 + index * 70)}
              />
              <span className="text-pretty leading-relaxed">{t(key)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div
        data-reveal
        className={cn(PANEL, "vem-rise space-y-6 p-6 sm:p-8")}
        style={at(120)}
      >
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
      <div
        data-reveal
        className="vem-rise mt-10 hidden overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface-1 md:block"
        style={at(0)}
      >
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
            data-reveal
            className="vem-rise overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-1"
            style={at(0)}
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
  const mainRef = useRef<HTMLElement>(null);
  useScrollToHash();
  useScrollReveal(mainRef);
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

      <main ref={mainRef} className="relative flex-1 overflow-hidden">
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
            <p className={cn(EYEBROW, "vem-rise")} style={at(0)}>
              {t("vem.hero.eyebrow")}
            </p>
            <h1
              id="vem-title"
              className="mt-5 text-balance font-display text-5xl font-extrabold leading-[1.02] tracking-tight text-text sm:text-6xl lg:text-7xl"
            >
              <HeadlineWords
                lead={t("vem.hero.titleLead")}
                accent={t("vem.hero.titleAccent")}
                start={HERO_WORDS}
              />
            </h1>
            <p
              className="vem-rise mt-6 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary sm:text-xl"
              style={at(HERO_BODY)}
            >
              {t("vem.hero.body")}
            </p>
            <div
              className="vem-rise mt-9 flex flex-col gap-3 sm:flex-row sm:items-center"
              style={at(HERO_BODY + 90)}
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
                className={cn(CTA_CLASS, "vem-cta-arrow w-full sm:w-auto")}
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
              className="vem-rise mt-5 text-sm text-text-tertiary"
              style={at(HERO_BODY + 180)}
            >
              {t("vem.hero.hint")} {t("vem.hero.signInPrompt")} <SignInLink />
            </p>
          </div>

          {/* Its own clock: on a desktop it starts with the page, on a phone it
              sits below the fold and plays when the reader gets to it. */}
          <div data-reveal="late">
            <MoveVisual />
          </div>
        </section>

        {/* Quick proof */}
        <section
          className="relative border-y border-border bg-surface-1"
          aria-label={t("vem.hero.eyebrow")}
        >
          <ul
            data-reveal
            className="mx-auto grid max-w-6xl gap-x-8 gap-y-4 px-4 py-8 text-sm leading-relaxed text-text-secondary sm:grid-cols-2 sm:px-8 lg:grid-cols-4"
          >
            <li className="vem-rise flex gap-3" style={at(0)}>
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
            ).map((key, index) => (
              <li
                key={key}
                className="vem-rise flex gap-3"
                style={at(80 + index * 80)}
              >
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
          <div data-reveal className="max-w-3xl">
            <p className={cn(EYEBROW, "vem-rise")} style={at(0)}>
              {t("vem.import.eyebrow")}
            </p>
            <h2
              id="vem-import-title"
              className={cn(H2, "vem-rise mt-4")}
              style={at(80)}
            >
              {t("vem.import.title")}
            </h2>
            <p
              className="vem-rise mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-text-secondary"
              style={at(160)}
            >
              {t("vem.import.lede")}
            </p>
          </div>

          <ImportSteps />
          <ComesAndStays />

          <div
            data-reveal
            className="vem-rise mt-12 flex justify-center"
            style={at(0)}
          >
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
            <div data-reveal className="max-w-3xl">
              <p className={cn(EYEBROW, "vem-rise")} style={at(0)}>
                {t("vem.features.eyebrow")}
              </p>
              <h2
                id="vem-features-title"
                className={cn(H2, "vem-rise mt-4")}
                style={at(80)}
              >
                {t("vem.features.title")}
              </h2>
            </div>
            <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURE_IDS.map((id, index) => (
                <li
                  key={id}
                  data-reveal
                  className="vem-rise rounded-[var(--radius-panel)] border border-border bg-surface-0 p-6"
                  style={at((index % 3) * 90)}
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
          <div data-reveal className="max-w-3xl">
            <p className={cn(EYEBROW, "vem-rise")} style={at(0)}>
              {t("vem.compare.eyebrow")}
            </p>
            <h2
              id="vem-compare-title"
              className={cn(H2, "vem-rise mt-4")}
              style={at(80)}
            >
              {t("vem.compare.title")}
            </h2>
            <p
              className="vem-rise mt-5 text-pretty text-lg leading-relaxed text-text-secondary"
              style={at(160)}
            >
              {t("vem.compare.intro")}
            </p>
          </div>
          <Compare />
          <p
            data-reveal
            className="vem-rise mt-8 max-w-3xl text-pretty leading-relaxed text-text-secondary"
            style={at(0)}
          >
            {t("vem.compare.closing")}
          </p>
        </section>

        {/* FAQ */}
        <section
          className="border-t border-border bg-surface-1"
          aria-labelledby="vem-faq-title"
        >
          <div className="mx-auto max-w-3xl px-4 py-20 sm:px-8 sm:py-28">
            <h2
              id="vem-faq-title"
              data-reveal
              className={cn(H2, "vem-rise")}
              style={at(0)}
            >
              {t("vem.faq.title")}
            </h2>
            <dl className="mt-10 divide-y divide-border border-y border-border">
              {VEM_FAQ_IDS.map((id) => (
                <div
                  key={id}
                  data-reveal
                  className="vem-rise py-6"
                  style={at(0)}
                >
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
          <div data-reveal>
            <h2
              id="vem-final-title"
              className={cn(H2, "vem-rise sm:text-5xl")}
              style={at(0)}
            >
              {t("vem.final.title")}
            </h2>
            <p
              className="vem-rise mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-text-secondary"
              style={at(90)}
            >
              {t("vem.final.body")}
            </p>
          </div>
          <div
            data-reveal
            className="vem-rise mt-9 flex flex-col justify-center gap-3 sm:flex-row"
            style={at(180)}
          >
            <VemCta intent="new" label="vem.cta.create" placement="final" />
            <VemCta
              intent="discord"
              label="vem.cta.import"
              placement="final"
              variant="secondary"
            />
          </div>
          <p
            data-reveal
            className="vem-rise mt-10 font-display text-2xl font-bold tracking-tight text-text"
            style={at(0)}
          >
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

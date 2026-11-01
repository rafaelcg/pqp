import { Breu, BreuSpeechBubble } from "@/components/breu/breu";
import { PANE_HEADER_REDESIGN } from "@/components/ui/pane-header";
import { SIDEBAR_FOOTER_CARD_REDESIGN } from "@/components/ui/sidebar-block";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import {
  ChannelListSkeleton,
  MessageListSkeleton,
  ServerRailSkeleton,
  Skeleton,
} from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { useRedesign } from "@/lib/redesign";
import { CaretRight } from "@phosphor-icons/react";
import { Icon } from "@/components/ui/icon";
import {
  loadChannelSidebarWidth,
} from "@/lib/channel-sidebar-width";
import { FRAME_REDESIGN, PANE_MAIN_REDESIGN, PANE_SIDE_REDESIGN, RAIL_REDESIGN } from "@/components/ui/pane";
import { cn } from "@/lib/utils";

/**
 * The boot screen: one skeleton, one card, one label, from the first frame of
 * `/app` until the app replaces it.
 *
 * The boot has three stages that each used to draw their own copy (the chat
 * chunk loading, Clerk loading, the bootstrap reads), with a different label
 * each and a card that grew with the label, so the screen visibly jumped and
 * Breu's loop started over at every handoff. Now each stage renders
 * `BootShellHold`, which draws nothing, and `BootShellHost` near the router
 * root draws this shell while any hold is mounted. A handoff unmounts one hold
 * and mounts the next in the same commit, so the shell (and Breu inside it) is
 * never unmounted between stages.
 */
export function AppLoadingShell() {
  const { t } = useTranslation();
  const text = t("app.loading");
  return (
    <div
      className={cn("relative flex h-full overflow-hidden", FRAME_REDESIGN)}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={text}
    >
      <nav className={cn("flex h-full w-[72px] shrink-0 flex-col items-center border-r border-ink-4/40 bg-rail", RAIL_REDESIGN)}>
        <ServerRailSkeleton />
      </nav>

      {/* The same stored width the real column uses, so the first paint is
          already the width it is about to become. Read here rather than in an
          effect: an effect would paint 256 and then jump. */}
      <aside
        style={
          {
            "--channel-sidebar-width": `${loadChannelSidebarWidth(
              typeof window === "undefined" ? 0 : window.innerWidth,
            )}px`,
          } as CSSProperties
        }
        className={cn("hidden h-full w-[var(--channel-sidebar-width)] shrink-0 flex-col border-r border-ink-4/60 bg-channel md:flex", PANE_SIDE_REDESIGN, "md:redesign:h-auto")}
      >
        <div className="flex h-14 items-center border-b border-ink-4/60 px-4 redesign:border-b-0">
          <Skeleton className="h-5 w-28" />
        </div>
        <ChannelListSkeleton />
        <div className={cn("mt-auto border-t border-ink-4/60 p-3 redesign:border-t-0 redesign:p-1.5", SIDEBAR_FOOTER_CARD_REDESIGN)}>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      </aside>

      <main className={cn("flex min-w-0 flex-1 flex-col", PANE_MAIN_REDESIGN)}>
        <header className={cn("flex h-14 shrink-0 items-center border-b border-ink-4/60 px-4", PANE_HEADER_REDESIGN)}>
          <Skeleton className="h-5 w-36" />
        </header>
        <MessageListSkeleton />
        <div className="shrink-0 border-t border-ink-4/60 p-3 redesign:border-t-0 redesign:px-4 redesign:pb-4">
          <Skeleton className="h-10 w-full rounded-lg redesign:h-12 redesign:rounded-[var(--composer-radius,1.25rem)]" />
        </div>
      </main>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ink/40 backdrop-blur-[1px] redesign:bg-[color:color-mix(in_oklab,var(--color-canvas)_40%,transparent)] redesign:[:root[data-theme=light]_&]:bg-[color:color-mix(in_oklab,var(--color-canvas)_25%,transparent)]">
        {/* Under the redesign Breu and its label sit on their own card, off the skeleton bars. */}
        {/* A fixed size, so a label that changes (English until the reader's
            catalogue lands) never resizes the card. */}
        <div
          data-boot-card=""
          className="flex w-44 flex-col items-center gap-3 redesign:h-32 redesign:justify-center redesign:rounded-[var(--radius-card)] redesign:bg-pane-main redesign:px-4 redesign:ring-1 redesign:ring-inset redesign:ring-[color:var(--color-border)]"
        >
          {/* Breu at work, hopping and leaning on a steady 2s loop (still under
              reduced motion), instead of a spinning "pqp" ring: the most-seen
              moment Breu gets. */}
          <Breu mood="focused" size="sm" motion="working" />
          <p className="w-full text-center text-xs uppercase tracking-[0.2em] text-paper-muted redesign:text-[13px] redesign:font-semibold redesign:normal-case redesign:tracking-normal redesign:text-text-secondary">
            <BootLabel text={text} />
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The label, faded in when it changes after the first paint (the English word
 * swapped for the reader's own once the catalogue loads) instead of snapping.
 * The first word shows at once.
 */
function BootLabel({ text }: { text: string }) {
  const first = useRef(text);
  return (
    <span
      key={text}
      data-boot-label=""
      className={cn(
        "block truncate",
        text !== first.current && "animate-[fade-in_0.28s_ease_both] motion-reduce:animate-none",
      )}
    >
      {text}
    </span>
  );
}

let bootHolds = 0;
const bootHoldListeners = new Set<() => void>();

function changeBootHolds(delta: number): void {
  bootHolds += delta;
  for (const listener of [...bootHoldListeners]) {
    listener();
  }
}

function subscribeBootHolds(listener: () => void): () => void {
  bootHoldListeners.add(listener);
  return () => {
    bootHoldListeners.delete(listener);
  };
}

const BootShellHostContext = createContext(false);

/**
 * Draws the one boot shell while any `BootShellHold` is mounted below it.
 * The shell comes after `children`, in the same parent, which is exactly where
 * a stage's own shell used to be: a hold renders nothing, so while the app
 * boots the shell is the only thing in the frame.
 */
export function BootShellHost({ children }: { children: ReactNode }) {
  const held = useSyncExternalStore(
    subscribeBootHolds,
    () => bootHolds > 0,
    () => false,
  );
  return (
    <BootShellHostContext.Provider value>
      {children}
      {held ? <AppLoadingShell /> : null}
    </BootShellHostContext.Provider>
  );
}

/**
 * "This stage is still loading": the boot shell stays up while it is mounted.
 *
 * A layout effect, so the count moves inside the commit that swaps one stage
 * for the next (one hold's cleanup, the next one's setup) and the host's
 * re-render runs before the browser paints: the shell is never missing for a
 * frame. Outside a host (a test, a page that renders a stage alone) it draws
 * the shell itself, as the stages always did.
 */
export function BootShellHold() {
  const hosted = useContext(BootShellHostContext);
  useLayoutEffect(() => {
    if (!hosted) {
      return;
    }
    changeBootHolds(1);
    return () => changeBootHolds(-1);
  }, [hosted]);
  return hosted ? null : <AppLoadingShell />;
}

interface AppBootstrapErrorProps {
  message: string;
  onRetry: () => void;
}

export function AppBootstrapError({ message, onRetry }: AppBootstrapErrorProps) {
  const { t } = useTranslation();
  const redesign = useRedesign();
  const deploy = (
    <>
      {t("bootstrapError.deploy.1")}{" "}
      <code className="text-signal redesign:text-accent-text">VITE_API_URL</code>{" "}
      {t("bootstrapError.deploy.2")}{" "}
      <code className="text-signal redesign:text-accent-text">VITE_WS_URL</code>{" "}
      {t("bootstrapError.deploy.3")}{" "}
      <code className="text-signal redesign:text-accent-text">docs/DEPLOY.md</code>.
    </>
  );
  return (
    <div
      className={
        redesign
          ? // A wide screen puts the big Breu beside the text. Plain
            // `justify-center` here: a `redesign:` one would outrank `sm:`.
            "relative flex h-full flex-col items-start justify-center overflow-hidden bg-pane-main p-8 sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:p-12"
          : "relative flex h-full flex-col items-start justify-end overflow-hidden p-8 sm:p-12 redesign:justify-center redesign:bg-pane-main"
      }
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_80%_10%,var(--glow-danger),transparent_45%)] redesign:bg-[radial-gradient(circle_at_85%_0%,var(--glow-danger),transparent_35%)]" />
      {/* Under the redesign the failure is announced, and focus lands on the retry. */}
      <div className="relative z-10 max-w-lg" role={redesign ? "alert" : undefined}>
        {/* Its own line: inline, it sat beside "pqp.gg" on the baseline and floated above the text.
            Under the redesign only on a narrow screen: a wide one has the big Breu. */}
        <Breu mood="sad" size="md" className={cn("mb-2 block", redesign && "sm:hidden")} />
        <Link
          to="/"
          className="mb-3 inline-block text-xs uppercase tracking-[0.28em] text-signal redesign:text-sm redesign:font-bold redesign:normal-case redesign:tracking-normal redesign:text-accent-text"
        >
          pqp.gg
        </Link>
        <h1 className="font-display text-4xl font-extrabold leading-[0.95] sm:text-5xl redesign:font-[family-name:var(--type-title-font)] redesign:font-bold redesign:text-balance">
          {t("bootstrapError.title")}
        </h1>
        <p className="mt-4 text-paper-muted redesign:text-text-secondary">{message}</p>
        {redesign ? (
          // The deploy notes are for whoever hosts pqp, so under the redesign
          // they fold behind a disclosure instead of greeting every reader.
          <details className="group mt-3 text-sm text-text-secondary">
            <summary className="inline-flex cursor-pointer list-none select-none items-center gap-1.5 rounded-[var(--radius-control)] font-medium text-text-secondary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-focus-ring)] [&::-webkit-details-marker]:hidden">
              <Icon icon={CaretRight} kind="symbol" size="sm" className="text-text-tertiary transition-transform duration-[var(--duration-fast)] group-open:rotate-90 motion-reduce:transition-none" />
              {t("bootstrapError.deploy.details")}
            </summary>
            <p className="mt-2">{deploy}</p>
          </details>
        ) : (
          <p className="mt-3 text-sm text-paper-muted">{deploy}</p>
        )}
        <div className="mt-8 flex flex-wrap gap-3">
          <Button onClick={onRetry} autoFocus={redesign}>
            {t("bootstrapError.retry")}
          </Button>
          <Button variant="secondary" asChild>
            <Link to="/">{t("bootstrapError.home")}</Link>
          </Button>
        </div>
      </div>
      {redesign ? (
        // Decorative: the alert beside it is the message. Breu drops in,
        // sways, and says the brand word once he has landed.
        <div
          aria-hidden="true"
          data-bootstrap-breu=""
          className="pointer-events-none relative z-10 hidden shrink-0 sm:mr-[4%] sm:block"
        >
          <BreuSpeechBubble className="absolute right-[72%] top-[4%]">
            {t("bootstrapError.bubble")}
          </BreuSpeechBubble>
          <Breu mood="sad" size="xl" motion="oops" className="max-lg:h-48 max-lg:w-48" />
        </div>
      ) : null}
    </div>
  );
}

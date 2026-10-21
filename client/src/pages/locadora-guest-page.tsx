import type { BridgeUiActivityState, PublicAppsConfig } from "@pqp/shared";
import { RotateCcw, ScrollText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { AppsCta } from "@/components/apps-landing/apps-cta";
import { LocadoraGuestUpsell } from "@/components/apps-landing/locadora-guest-upsell";
import { AppFrame, type AppFrameHandle, type AppFrameStatus } from "@/components/apps/app-frame";
import { LanguagePicker } from "@/components/marketing/language-picker";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { usePublicAppsConfig } from "@/hooks/use-apps-landing";
import { parseAppsOrigin } from "@/lib/apps/apps-origin";
import { pickLocalFile, type PickOptions } from "@/lib/apps/file-pick";
import { createGuestTransport, guestUserDirectory, openGuestDeviceStore } from "@/lib/apps/guest-session";
import { LOCADORA_GUEST_REF } from "@/lib/apps-landing";
import { intentStorage } from "@/lib/handle-intent";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  LOCADORA_GUEST_EVENTS,
  LOCADORA_GUEST_PATH,
  UpsellMoments,
  guestRuntimeOf,
  hasCartridge,
  rememberUpsellDismissed,
  rememberUpsellShown,
  takeCartridge,
  trackLocadoraGuest,
  upsellAllowed,
} from "@/lib/locadora-guest";

/**
 * `pqp.gg/locadora/jogar` (and `/apps/locadora/play`): Locadora for somebody
 * with no account. Behind `locadora_guest` and `apps_landing` (the public
 * config's `guest`); off, unknown or with no apps origin, a redirect home.
 *
 * WHAT THIS PAGE TALKS TO. The public apps config (one unauthenticated GET,
 * shared with the landing) and the apps origin, which serves the real
 * Locadora bundle into the same `sandbox="allow-scripts"` frame a member
 * gets. Nothing else: no Clerk call until somebody presses "Criar conta",
 * no socket, no session route, no cookie. The session is the page's own
 * (`lib/apps/guest-session.ts`), the shelf lives in this browser's guest store
 * (apart from any account's), and the game file is read by the frame host's
 * picker and handed to the frame, never to the network:
 * `e2e/locadora-guest/canary.spec.ts` fails if a canary title, the file name or
 * the file's hash appears in any request this page makes.
 *
 * WHAT IS AROUND THE FRAME. A slim bar (the wordmark back to the landing,
 * the house rules, the language while no game is in, and "Criar conta
 * grátis") and nothing else: no sidebar, no chat, no launcher, and nothing
 * asked before playing. No age question either (Rafael's call, 2026-10-21:
 * only registering has an age requirement, and a player that collects nothing
 * should be the easiest thing to try; it is on the lawyer list,
 * `docs/EMULATOR_ROOM.md` item 10). Over the frame, at a calm moment only, the
 * sign-up card (`LocadoraGuestUpsell`).
 *
 * FROM THE DOOR. A cartridge picked or dropped on the landing's "Botar a fita"
 * is held in memory (`holdCartridge`) and handed to the frame's first pick
 * (`hello.pendingFile`), so the game boots with nothing in between.
 */

export function LocadoraGuestPage() {
  const { config, failed } = usePublicAppsConfig();
  if (failed) return <Navigate to="/" replace />;
  if (!config) return <div className="min-h-full bg-surface-0" aria-busy="true" />;
  const origin = config.locadora ? parseAppsOrigin(config.locadora.origin) : null;
  if (!config.enabled || !config.guest || !config.locadora || !origin) return <Navigate to="/" replace />;
  return <GuestPlayerPage config={config} origin={origin} />;
}

function GuestPlayerPage({ config, origin }: { config: PublicAppsConfig; origin: string }) {
  const { t, locale } = useTranslation();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [activity, setActivity] = useState<BridgeUiActivityState>("browsing");
  const inGame = activity !== "browsing";

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-surface-0 text-text" data-locadora-guest="">
      <Seo
        title={t("locadoraGuest.seo.title")}
        description={t("locadoraGuest.seo.description")}
        path={LOCADORA_GUEST_PATH}
        image="/images/og-locadora-chegou.jpg"
        noIndex
      />
      <header
        className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-3 sm:gap-3 sm:px-4"
        aria-label={t("locadoraGuest.bar.label")}
      >
        <Link
          to="/apps/locadora"
          aria-label={t("locadoraGuest.bar.home")}
          className="flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] px-1 font-brand text-xl tracking-tight text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          pqp
          <span className="hidden font-display text-sm font-semibold tracking-normal text-text-secondary min-[400px]:inline" aria-hidden>
            Locadora
          </span>
        </Link>
        <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 gap-1.5 px-2.5 text-sm"
            onClick={() => setRulesOpen(true)}
            data-locadora-rules-open=""
          >
            <ScrollText className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">{t("locadoraGuest.bar.rules")}</span>
            <span className="sr-only sm:hidden">{t("locadoraGuest.bar.rules")}</span>
          </Button>
          {/* Changing the language reloads the page: offered only while no
              game is in, so a click never throws away unsaved play. */}
          {!inGame && <LanguagePicker variant="solid" />}
          {/* The full label from `sm` up; a phone gets the short one so the bar never overflows. */}
          <AppsCta
            tag={LOCADORA_GUEST_REF}
            path="/locadora/jogar"
            label={t("locadoraGuest.bar.signup")}
            compact
            className="hidden sm:inline-flex"
            onActivate={() => trackLocadoraGuest(LOCADORA_GUEST_EVENTS.signupClick)}
          />
          <AppsCta
            tag={LOCADORA_GUEST_REF}
            path="/locadora/jogar"
            label={t("locadoraGuest.bar.signupShort")}
            compact
            className="sm:hidden"
            onActivate={() => trackLocadoraGuest(LOCADORA_GUEST_EVENTS.signupClick)}
          />
        </div>
      </header>

      {/* Straight into the player: no account, nothing asked, nothing collected. */}
      <main id="main" className="relative min-h-0 flex-1">
        <GuestPlayer config={config} origin={origin} locale={locale} onActivity={setActivity} />
      </main>

      <Dialog
        open={rulesOpen}
        title={t("locadoraGuest.rules.title")}
        onClose={() => setRulesOpen(false)}
        size="sm"
        footer={
          <Button type="button" variant="secondary" className="h-11 px-5" onClick={() => setRulesOpen(false)}>
            {t("locadoraGuest.rules.close")}
          </Button>
        }
      >
        <HouseRules className="px-5 py-4" />
      </Dialog>
    </div>
  );
}

/** The same three rules as the app's Balcão receipt, plus where a guest's shelf lives. */
function HouseRules({ className }: { className?: string }) {
  const { t } = useTranslation();
  const rules: MessageKey[] = [
    "locadoraGuest.rules.1",
    "locadoraGuest.rules.2",
    "locadoraGuest.rules.3",
    "locadoraGuest.rules.guest",
  ];
  return (
    <ul className={className} data-locadora-house-rules="">
      {rules.map((key) => (
        <li key={key} className="flex gap-3 py-1.5 text-sm leading-relaxed text-text-secondary">
          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
          {t(key)}
        </li>
      ))}
    </ul>
  );
}

/** How often the idle rule is looked at while the frame is calm. */
const IDLE_TICK_MS = 5_000;

function GuestPlayer({
  config,
  origin,
  locale,
  onActivity,
}: {
  config: PublicAppsConfig;
  origin: string;
  locale: string;
  onActivity: (state: BridgeUiActivityState) => void;
}) {
  const { t } = useTranslation();
  const app = config.locadora!.app;
  const runtime = useMemo(() => guestRuntimeOf(app), [app]);
  // one session per mount: "Tentar de novo" remounts with a new key, and so a new session
  const [attempt, setAttempt] = useState(0);
  const transport = useMemo(() => createGuestTransport(), [attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const nameRef = useRef(t("locadoraGuest.guestName"));
  nameRef.current = t("locadoraGuest.guestName");
  const users = useMemo(() => guestUserDirectory(() => nameRef.current), []);
  const frame = useRef<AppFrameHandle>(null);
  const [status, setStatus] = useState<AppFrameStatus["kind"]>("loading");
  const started = useRef(false);

  const moments = useRef<UpsellMoments>(new UpsellMoments(Date.now()));
  const [upsell, setUpsell] = useState(false);
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;

  const offer = useCallback(() => {
    if (document.visibilityState === "hidden") return;
    const storage = intentStorage();
    if (!upsellAllowed(storage)) return;
    rememberUpsellShown(storage);
    setUpsell(true);
    trackLocadoraGuest(LOCADORA_GUEST_EVENTS.upsellShown);
  }, []);

  const hostOptions = useMemo(
    () => ({
      guest: true,
      // a cartridge chosen at the landing's door: the frame's first pick gets it, with no second picker
      pendingFile: hasCartridge(),
      pickFile: (options: PickOptions) => {
        const held = takeCartridge();
        if (held && options.accept.includes(held.ext) && held.bytes.byteLength <= options.maxBytes) {
          return Promise.resolve({ kind: "picked" as const, bytes: held.bytes, ext: held.ext });
        }
        return pickLocalFile(options);
      },
      saveSync: null,
      openStore: openGuestDeviceStore,
      onActivity: (state: BridgeUiActivityState) => {
        onActivityRef.current(state);
        const decision = moments.current.activity(state, Date.now());
        if (decision === "hide") setUpsell(false);
        if (decision === "show") offer();
      },
    }),
    // a retry is a new frame: it says `pendingFile` only if a cartridge is still held
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [offer, attempt],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      if (moments.current.tick(Date.now()) === "show") offer();
    }, IDLE_TICK_MS);
    return () => clearInterval(timer);
  }, [offer]);

  // the page going away ends the frame's session, so it writes what it still can
  useEffect(() => {
    const end = () => transport.close();
    window.addEventListener("pagehide", end);
    return () => window.removeEventListener("pagehide", end);
  }, [transport]);

  return (
    <div className="absolute inset-0" data-guest-status={status}>
      <AppFrame
        key={attempt}
        ref={frame}
        app={runtime}
        appsOrigin={origin}
        transport={transport}
        users={users}
        title={t("locadoraGuest.frameTitle")}
        locale={locale}
        initialHeight={600}
        host={hostOptions}
        className="h-full w-full [&>iframe]:!h-full"
        onStatus={(next) => {
          setStatus(next.kind);
          if (next.kind === "ready" && !started.current) {
            started.current = true;
            trackLocadoraGuest(LOCADORA_GUEST_EVENTS.start);
          }
        }}
      />
      {status === "loading" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-surface-0" role="status">
          <span className="flex items-center gap-3 text-sm text-text-secondary">
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent motion-reduce:animate-none"
              aria-hidden
            />
            {t("locadoraGuest.loading")}
          </span>
        </div>
      )}
      {(status === "error" || status === "ended") && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-0 px-4" role="alert">
          <div className="max-w-sm text-center">
            <h1 className="font-display text-xl font-bold text-text">{t("locadoraGuest.error.title")}</h1>
            <p className="mt-2 text-text-secondary">{t("locadoraGuest.error.body")}</p>
            <Button type="button" className="mt-5 h-11 px-5" onClick={() => setAttempt((n) => n + 1)}>
              <RotateCcw className="h-4 w-4" aria-hidden />
              {t("locadoraGuest.error.retry")}
            </Button>
          </div>
        </div>
      )}
      {upsell && (
        <LocadoraGuestUpsell
          cloudSaves={config.cloudSaves}
          onDismiss={() => {
            rememberUpsellDismissed(intentStorage());
            setUpsell(false);
            frame.current?.focus();
          }}
        />
      )}
    </div>
  );
}

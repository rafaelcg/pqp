import { SignUpButton, SignedIn, SignedOut } from "@clerk/clerk-react";
import { ArrowUpRight, Check, Loader2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  HANDLE_MIN_LENGTH,
  normalizeHandle,
  publicProfileDisplayUrl,
  validateHandle,
  type HandleRejection,
} from "@pqp/shared";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { fetchPublicProfile } from "@/lib/api";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { intentStorage, stashHandleClaim } from "@/lib/handle-intent";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * `pqp.gg/garanta` — "claim your @".
 *
 * THE PITCH IS SCARCITY AND THE MECHANIC IS A TEXT BOX. Everything else on the
 * page is in service of the moment somebody types their own name and watches it
 * come back green: that is the hook, so it is above the fold, focused on load,
 * and answered in under a second. The three reasons below it exist for the
 * people who need one; nobody who typed their name into the box reads them.
 *
 * AVAILABILITY IS THE PUBLIC PROFILE ENDPOINT, and this is the neat part: a 404
 * from `GET /api/public/profiles/:handle` means "no page here", which is exactly
 * "this @ is free". No second endpoint, no enumeration surface that did not
 * already exist, and — importantly — no way for this page to answer a question
 * the profile page would answer differently.
 *
 * THE CHECK CANNOT RESERVE ANYTHING and the copy must not imply that it can. A
 * read is a read; two people can both be told `neymar` is free, and exactly one
 * of them will get it (the unique index decides — see `claimHandle`). That is
 * why the button says "garantir" and the confirmation comes after the write.
 */

/** Long enough that typing a name is one request, short enough to feel live. */
const DEBOUNCE_MS = 350;

type Availability =
  | { state: "idle" }
  | { state: "invalid"; reason: HandleRejection }
  | { state: "checking" }
  | { state: "free" }
  | { state: "taken" }
  | { state: "error" };

const REJECTION_KEY: Record<HandleRejection, MessageKey> = {
  length: "claim.tooShort",
  format: "claim.format",
  reserved: "claim.reserved",
  blocked: "claim.blocked",
};

export function ClaimPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const bypass = isDevAuthBypassEnabled();

  // Prefilled from `?handle=` so the "this @ is free — claim it" button on a
  // 404'd profile page lands here with the name already typed. Normalised on the
  // way in: the query string is user-writable and this value goes straight into
  // a request.
  const [raw, setRaw] = useState(() =>
    normalizeHandle(params.get("handle") ?? ""),
  );
  const handle = normalizeHandle(raw);
  const [availability, setAvailability] = useState<Availability>({
    state: "idle",
  });

  // The debounce, and the abort that goes with it. Without the abort, typing
  // `rafa` fires four requests whose answers can arrive out of order — and the
  // one that lands last wins, which is not the one that describes what is in
  // the box.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    if (!handle) {
      setAvailability({ state: "idle" });
      return;
    }
    const rejection = validateHandle(handle);
    if (rejection) {
      setAvailability({ state: "invalid", reason: rejection });
      return;
    }
    setAvailability({ state: "checking" });
    const controller = new AbortController();
    timer.current = window.setTimeout(() => {
      fetchPublicProfile(handle, { signal: controller.signal })
        .then((profile) =>
          setAvailability({ state: profile ? "taken" : "free" }),
        )
        .catch(() => {
          if (controller.signal.aborted) {
            return;
          }
          // A 429 from typing too fast, or the API being down. Neither of them
          // is "free", and rendering either as free is how somebody ends up
          // trying to claim a name that is already somebody else's page.
          setAvailability({ state: "error" });
        });
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    };
  }, [handle]);

  const ready = availability.state === "free";

  /**
   * Where the chosen name goes, and it goes twice on purpose.
   *
   * IN THE URL, as `/app?claim=<handle>`. This is the invite fix's lesson
   * applied to a name instead of a code: an intent that rides the path survives
   * anything, and Clerk hands `forceRedirectUrl` straight back. It is the
   * primary channel.
   *
   * AND IN STORAGE, because "hands it straight back" is a property of a
   * configuration rather than of the universe — an OAuth provider that comes
   * back in a new tab, a hosted sign-up page that normalises the redirect, or a
   * verification email opened on a phone all lose the query string. The stash
   * costs one localStorage write and an hour of TTL (see `lib/handle-intent.ts`)
   * and turns "the name was thrown away" into "the name was remembered".
   *
   * `/app` and not back to this page in either case: the claim runs once the
   * account exists AND has cleared the 18+ gate, which is `App`'s ready state
   * and nowhere earlier. Writing a handle for an account that may yet be refused
   * entry would be squatting on somebody else's behalf.
   */
  const appTarget = ready ? `/app?claim=${encodeURIComponent(handle)}` : "/app";
  const rememberClaim = useCallback(() => {
    if (ready) {
      stashHandleClaim(intentStorage(), handle);
    }
  }, [handle, ready]);

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title={t("claim.seo.title")}
        description={t("claim.seo.description")}
        path="/garanta"
      />
      <MarketingNav />

      <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-5 py-16 sm:px-8">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_-10%,var(--glow-accent),transparent_55%)]"
          aria-hidden
        />

        <div className="relative z-10 w-full max-w-lg text-center">
          <p
            className="animate-rise text-[11px] font-medium uppercase tracking-[0.28em] text-signal"
            style={{ "--stagger": 0 } as CSSProperties}
          >
            {t("claim.eyebrow")}
          </p>
          <h1
            className="animate-rise mt-4 font-display text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl"
            style={{ "--stagger": 1 } as CSSProperties}
          >
            {t("claim.title")}
          </h1>
          <p
            className="animate-rise mx-auto mt-4 max-w-md text-paper-muted"
            style={{ "--stagger": 2 } as CSSProperties}
          >
            {t("claim.body")}
          </p>

          <div
            className="animate-rise mt-9"
            style={{ "--stagger": 3 } as CSSProperties}
          >
            {/* The input is drawn as a URL rather than as a form field: the
                thing being claimed is an address, and showing it as one is what
                makes the value obvious without a sentence explaining it. */}
            <label
              htmlFor="claim-handle"
              className="mb-2 block text-xs uppercase tracking-wide text-paper-muted"
            >
              {t("claim.input.label")}
            </label>
            <div
              className={cn(
                "flex items-center gap-0 rounded-2xl border bg-ink-2 px-4 py-3 text-left transition-colors focus-within:ring-2 focus-within:ring-signal/50",
                availability.state === "free"
                  ? "border-success/60"
                  : availability.state === "taken" ||
                      availability.state === "invalid"
                    ? "border-danger/60"
                    : "border-ink-4",
              )}
            >
              <span className="select-none font-mono text-base text-paper-muted sm:text-lg">
                pqp.gg/@
              </span>
              <input
                id="claim-handle"
                value={raw}
                autoFocus
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="go"
                maxLength={20}
                placeholder={t("claim.input.placeholder")}
                onChange={(event) => setRaw(normalizeHandle(event.target.value))}
                className="min-w-0 flex-1 bg-transparent font-mono text-base text-paper outline-none placeholder:text-paper-muted/50 sm:text-lg"
              />
              <span className="ml-2 shrink-0" aria-hidden>
                {availability.state === "checking" && (
                  <Loader2 className="h-5 w-5 animate-spin text-paper-muted" />
                )}
                {availability.state === "free" && (
                  <Check className="h-5 w-5 text-success" />
                )}
                {(availability.state === "taken" ||
                  availability.state === "invalid") && (
                  <X className="h-5 w-5 text-danger" />
                )}
              </span>
            </div>

            <p
              role="status"
              aria-live="polite"
              className={cn(
                "mt-2 min-h-[1.25rem] text-sm",
                availability.state === "free"
                  ? "text-success"
                  : availability.state === "taken" ||
                      availability.state === "invalid" ||
                      availability.state === "error"
                    ? "text-danger"
                    : "text-paper-muted",
              )}
            >
              <AvailabilityMessage
                availability={availability}
                handle={handle}
                minLength={HANDLE_MIN_LENGTH}
              />
            </p>

            {/* Clerk's components need a provider, and the dev-bypass build
                renders none — so the bypass branch is a plain link, exactly as
                the landing page and the nav do it. */}
            <div className="mt-5">
              {bypass ? (
                <ClaimLink handle={handle} ready={ready} onClaim={rememberClaim} />
              ) : (
                <>
                  <SignedOut>
                    <SignUpButton mode="modal" forceRedirectUrl={appTarget}>
                      <Button
                        disabled={!ready}
                        onClick={rememberClaim}
                        className="cta-lift h-12 w-full rounded-full text-base"
                      >
                        {ready
                          ? t("claim.cta", { handle: `@${handle}` })
                          : t("claim.cta.signedIn")}
                        <ArrowUpRight aria-hidden className="h-4 w-4" />
                      </Button>
                    </SignUpButton>
                  </SignedOut>
                  <SignedIn>
                    <ClaimLink
                      handle={handle}
                      ready={ready}
                      onClaim={rememberClaim}
                    />
                  </SignedIn>
                </>
              )}
            </div>

            <p className="mt-4 text-xs text-paper-muted">{t("claim.rules")}</p>
          </div>
        </div>

        <ul className="relative z-10 mt-20 grid w-full max-w-3xl gap-8 sm:grid-cols-3">
          {([1, 2, 3] as const).map((n, i) => (
            <li
              key={n}
              className="animate-rise text-center sm:text-left"
              style={{ "--stagger": 4 + i } as CSSProperties}
            >
              <p className="font-mono text-xs text-signal">0{n}</p>
              <h2 className="mt-2 font-display text-base font-bold">
                {t(`claim.why.${n}.title` as MessageKey)}
              </h2>
              <p className="mt-1.5 text-sm text-paper-muted">
                {t(`claim.why.${n}.body` as MessageKey)}
              </p>
            </li>
          ))}
        </ul>
      </main>

      <MarketingFooter />
    </div>
  );
}

/** The signed-in (and dev-bypass) button: no auth modal, straight into the app. */
function ClaimLink({
  handle,
  ready,
  onClaim,
}: {
  handle: string;
  ready: boolean;
  onClaim: () => void;
}) {
  const { t } = useTranslation();
  const to = ready ? `/app?claim=${encodeURIComponent(handle)}` : "/app";
  return (
    <Button
      asChild={ready}
      disabled={!ready}
      className="cta-lift h-12 w-full rounded-full text-base"
    >
      {ready ? (
        <Link to={to} onClick={onClaim}>
          {t("claim.cta", { handle: `@${handle}` })}
          <ArrowUpRight aria-hidden className="h-4 w-4" />
        </Link>
      ) : (
        <span>{t("claim.cta.signedIn")}</span>
      )}
    </Button>
  );
}

function AvailabilityMessage({
  availability,
  handle,
  minLength,
}: {
  availability: Availability;
  handle: string;
  minLength: number;
}) {
  const { t } = useTranslation();
  switch (availability.state) {
    case "idle":
      return null;
    case "checking":
      return <>{t("claim.checking")}</>;
    case "free":
      return <>{t("claim.available", { handle: `@${handle}` })}</>;
    case "taken":
      return (
        <>
          {t("claim.taken", { handle: `@${handle}` })}{" "}
          <Link
            to={`/@${handle}`}
            className="underline underline-offset-2 hover:text-paper"
          >
            {publicProfileDisplayUrl(handle)}
          </Link>
        </>
      );
    case "invalid":
      return (
        <>
          {availability.reason === "length" && handle.length < minLength
            ? t("claim.tooShort")
            : t(REJECTION_KEY[availability.reason])}
        </>
      );
    case "error":
      return <>{t("claim.error")}</>;
  }
}

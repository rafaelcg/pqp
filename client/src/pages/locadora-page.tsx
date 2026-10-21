import { ArrowLeft, ChevronDown, Gamepad2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AppsCta } from "@/components/apps-landing/apps-cta";
import { AppsLandingGate } from "@/components/apps-landing/apps-landing-gate";
import { AppsShell } from "@/components/apps-landing/apps-shell";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { usePublicAppsConfig } from "@/hooks/use-apps-landing";
import { readLocalFile } from "@/lib/apps/file-pick";
import { appsDocsUrl, LOCADORA_LANDING_REF } from "@/lib/apps-landing";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { ACCOUNT_LINE_CLAIMS, claimView } from "@/lib/locadora-claims";
import { holdCartridge, LOCADORA_GUEST_PATH } from "@/lib/locadora-guest";
import { cn } from "@/lib/utils";

/**
 * `/apps/locadora` (and the short link `/locadora`): the player's door, not a
 * pitch. Rafael, 2026-10-21: "people want to play ASAP... we should just offer
 * to botar a fita".
 *
 * THE FIRST SCREEN IS ONE ACTION. The console with its slot, the cartridge
 * above it, and one huge "Botar a fita". With guest play on (the public
 * config's `guest`) the button opens the picker and the whole page is a drop
 * target: the file is read here under Locadora's own rules (`readLocalFile`:
 * its accept list and cap, bytes and an extension, never the name), held in
 * memory (`holdCartridge`) and the cartridge goes into the console, then the
 * guest player opens with it already in (`/locadora/jogar`, the frame's first
 * pick answers with it). Nothing in between and nothing sent anywhere. With
 * guest play off the same button is the sign-up.
 *
 * EVERYTHING ELSE IS FOOTER WEIGHT. The legal line under the button, one row
 * of console names, one quiet "Criar conta grátis" with a single line of what
 * an account adds (only claims whose gate is open, `ACCOUNT_LINE_CLAIMS`
 * through `claimView`), and the FAQ folded away under "Perguntas".
 *
 * FAST. The first view is three sprites (the sign, the console and the
 * cartridge, about 70 KB together) with their sizes set, nothing below the
 * fold loads an image, and the motion (the cartridge lifting on hover or drag,
 * sliding in when a file is chosen) is CSS that reduced motion turns off.
 */

const IMG = "/images/apps/";

const CONSOLE_NAMES = ["NES", "SNES", "Game Boy", "Game Boy Color", "Game Boy Advance"] as const;

/** How long the cartridge takes to slide in before the player opens (0 under reduced motion). */
const INSERT_MS = 520;

/** `hover`: the pointer or the keyboard is on the button. `drag`: a file is being carried over the page. */
type DoorState = "idle" | "hover" | "drag" | "inserting";

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function LocadoraPage() {
  return (
    <AppsLandingGate>
      <LocadoraPageBody />
    </AppsLandingGate>
  );
}

export function LocadoraPageBody() {
  const { t, locale } = useTranslation();
  const { config } = usePublicAppsConfig();
  const navigate = useNavigate();
  const guestApp = config?.guest === true ? (config.locadora?.app ?? null) : null;
  const files = guestApp?.capabilities.localFiles;
  const accept = files?.allowed ? (files.accept ?? []) : [];
  const maxBytes = files?.allowed ? (files.maxBytes ?? 0) : 0;
  const guest = guestApp !== null && accept.length > 0;
  const gates = { cloudSaves: config?.cloudSaves === true };
  const docsUrl = appsDocsUrl();

  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<DoorState>("idle");
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  /** A file from the picker or a drop: read it, put it in, open the player. */
  const insert = useCallback(
    async (file: File | null | undefined) => {
      if (!guest || !file || state === "inserting") return;
      const result = await readLocalFile(file, { accept, maxBytes });
      if (result.kind !== "picked") {
        setState("idle");
        setProblem(
          result.kind === "wrong-type"
            ? "locadoraPage.door.wrongType"
            : result.kind === "too-large"
              ? "locadoraPage.door.tooLarge"
              : "locadoraPage.door.unreadable",
        );
        return;
      }
      setProblem(null);
      holdCartridge({ bytes: result.bytes, ext: result.ext });
      setState("inserting");
      timer.current = setTimeout(() => void navigate(LOCADORA_GUEST_PATH), prefersReducedMotion() ? 0 : INSERT_MS);
    },
    // accept is rebuilt each render from the same config; its contents are what matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [guest, accept.join(","), maxBytes, state, navigate],
  );

  // A file dropped anywhere on the page goes to the door, never into the tab (which would open the file itself).
  useEffect(() => {
    const over = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
    };
    const drop = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setState((current) => (current === "drag" ? "idle" : current));
      void insert(event.dataTransfer.files[0]);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [insert]);

  const onDragEnter = (event: DragEvent) => {
    if (!guest || !event.dataTransfer.types.includes("Files")) return;
    if (state !== "inserting") setState("drag");
  };
  const onDragLeave = (event: DragEvent) => {
    if (state !== "drag") return;
    const to = event.relatedTarget as Node | null;
    if (!to || !event.currentTarget.contains(to)) setState("idle");
  };

  const dragging = state === "drag";
  const doorClass =
    "cta-lift h-16 w-full rounded-[var(--radius-panel)] px-8 text-xl font-extrabold tracking-tight sm:h-[4.5rem] sm:text-2xl md:w-auto md:min-w-[20rem]";

  const adds = ACCOUNT_LINE_CLAIMS.filter((claim) => claimView(claim, gates) === "shown").map((claim) => t(claim.titleKey));
  const addsLine = adds.length
    ? t("locadoraPage.account.adds", { list: new Intl.ListFormat(locale, { type: "conjunction" }).format(adds) })
    : null;

  const faq: { id: string; q: MessageKey; a: MessageKey }[] = [
    { id: "games", q: "locadoraPage.faq.games.q", a: "locadoraPage.faq.games.a" },
    { id: "file", q: "locadoraPage.faq.file.q", a: "locadoraPage.faq.file.a" },
    // "Não pra jogar" is only true while guest play is offered
    ...(guest
      ? [
          {
            id: "account",
            q: "locadoraPage.faq.account.q" as MessageKey,
            a: (gates.cloudSaves ? "locadoraPage.faq.account.aSaves" : "locadoraPage.faq.account.a") as MessageKey,
          },
        ]
      : []),
    { id: "free", q: "locadoraPage.faq.free.q", a: "locadoraPage.faq.free.a" },
    { id: "consoles", q: "locadoraPage.faq.consoles.q", a: "locadoraPage.faq.consoles.a" },
    { id: "phone", q: "locadoraPage.faq.phone.q", a: "locadoraPage.faq.phone.a" },
    { id: "who", q: "locadoraPage.faq.who.q", a: "locadoraPage.faq.who.a" },
    ...(docsUrl ? [{ id: "build", q: "locadoraPage.faq.build.q" as MessageKey, a: "locadoraPage.faq.build.a" as MessageKey }] : []),
  ];

  return (
    <AppsShell creditKey="locadoraPage.credit">
      <Seo
        title={t("locadoraPage.seo.title")}
        description={t("locadoraPage.seo.description")}
        path="/apps/locadora"
        image="/images/og-locadora-chegou.jpg"
      />

      {/* The door: a night scene in every theme (`.loc-night`). The whole panel takes a dropped file. */}
      <section className="relative mx-auto max-w-6xl px-0 sm:px-8 sm:pt-6" aria-labelledby="locadora-title">
        <div
          className="loc-night relative isolate overflow-hidden sm:rounded-[var(--radius-panel)] sm:shadow-[var(--shadow-2)]"
          data-locadora-hero=""
          data-door={state}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
        >
          <div className="loc-floor pointer-events-none absolute inset-x-[-20%] bottom-0 -z-10 h-40 sm:h-56" aria-hidden />
          <Link
            to="/apps"
            className="absolute left-3 top-3 z-10 inline-flex min-h-11 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-white/70 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:left-6 sm:top-5"
            data-apps-crumb=""
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {t("locadoraPage.crumb")}
          </Link>
          <div className="mx-auto flex max-w-5xl flex-col items-center gap-6 px-4 pb-10 pt-16 text-center sm:pb-14 md:grid md:grid-cols-2 md:grid-rows-[auto_auto] md:items-center md:gap-x-12 md:gap-y-8 md:px-10 md:pt-20 md:text-left lg:pb-16">
            <h1
              id="locadora-title"
              className="text-balance font-display text-[2.4rem] font-extrabold leading-[1.02] tracking-tight text-white sm:text-5xl md:self-end lg:text-6xl"
            >
              {t("locadoraPage.hero.title")}
            </h1>

            <Stage
              label={t("locadoraPage.hero.imageAlt")}
              sign={t("locadoraPage.hero.sign")}
              state={state}
              className="md:col-start-2 md:row-span-2 md:row-start-1"
            />

            <div className="flex w-full flex-col items-center gap-3 md:items-start md:self-start">
              {guest ? (
                <>
                  <input
                    ref={input}
                    type="file"
                    accept={accept.join(",")}
                    className="sr-only"
                    tabIndex={-1}
                    aria-hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      void insert(file);
                    }}
                  />
                  <Button
                    type="button"
                    className={cn(doorClass, dragging && "ring-4 ring-white/70")}
                    disabled={state === "inserting"}
                    onClick={() => {
                      setProblem(null);
                      input.current?.click();
                    }}
                    onMouseEnter={() => state === "idle" && setState("hover")}
                    onMouseLeave={() => state === "hover" && setState("idle")}
                    onFocus={() => state === "idle" && setState("hover")}
                    onBlur={() => state === "hover" && setState("idle")}
                    data-locadora-door=""
                  >
                    <Gamepad2 className="h-6 w-6" aria-hidden />
                    {state === "inserting" ? t("locadoraPage.door.inserting") : dragging ? t("locadoraPage.door.drop") : t("locadoraPage.door.cta")}
                  </Button>
                  <p className="text-sm text-white/75" aria-live="polite">
                    {problem ? <span className="font-semibold text-white">{t(problem)}</span> : t("locadoraPage.door.hint")}
                  </p>
                </>
              ) : (
                <>
                  <AppsCta tag={LOCADORA_LANDING_REF} path="/apps/locadora" label={t("locadoraPage.door.cta")} className={doorClass} />
                  <p className="text-sm text-white/75">{t("locadoraPage.door.hintMember")}</p>
                </>
              )}
              <p className="max-w-md text-balance text-xs leading-relaxed text-white/60" data-apps-legal="">
                {t("locadoraPage.legal")}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer weight: the consoles, the account in one line, the questions folded away. */}
      <section className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10 text-sm sm:px-8 sm:py-14" aria-label={t("locadoraPage.faq.title")}>
        <p className="flex flex-wrap items-center justify-center gap-2 text-text-secondary" data-locadora-consoles="">
          <span className="text-text-tertiary">{t("locadoraPage.consoles.label")}</span>
          {CONSOLE_NAMES.map((name) => (
            <span
              key={name}
              className="rounded-full border border-border bg-surface-1 px-3 py-1 font-medium text-text"
              data-locadora-console={name}
            >
              {name}
            </span>
          ))}
        </p>

        <p className="text-center text-text-secondary" data-locadora-account="">
          <AppsCta
            tag={LOCADORA_LANDING_REF}
            path="/apps/locadora"
            label={t("locadoraPage.account.link")}
            variant="ghost"
            compact
            className="mr-1 h-auto px-0 py-0 font-semibold text-accent underline-offset-4 hover:bg-transparent hover:text-accent hover:underline"
          />
          {addsLine && <span>{addsLine}</span>}
        </p>

        <details className="group mx-auto w-full max-w-xl rounded-[var(--radius-card)] border border-border bg-surface-1" data-locadora-faq="">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 px-4 font-semibold text-text marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring [&::-webkit-details-marker]:hidden">
            {t("locadoraPage.faq.title")}
            <ChevronDown
              className="h-4 w-4 shrink-0 text-text-tertiary transition-transform duration-[var(--duration-fast)] group-open:rotate-180 motion-reduce:transition-none"
              aria-hidden
            />
          </summary>
          <dl className="divide-y divide-border border-t border-border px-4">
            {faq.map((item) => (
              <div key={item.id} className="py-3" data-locadora-faq-item={item.id}>
                <dt className="font-semibold text-text">{t(item.q)}</dt>
                <dd className="mt-1 text-pretty leading-relaxed text-text-secondary">
                  {t(item.a)}
                  {item.id === "build" && docsUrl && (
                    <>
                      {" "}
                      <a href={docsUrl} className="font-medium text-accent underline-offset-4 hover:underline">
                        {t("locadoraPage.faq.build.link")}
                      </a>
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      </section>
    </AppsShell>
  );
}

/**
 * The sign in the corner and the console with its slot, the cartridge waiting
 * above it: it lifts while a file hovers the page or the pointer is on the
 * button, and slides in when one is chosen (`[data-door]` in index.css). One
 * picture to a screen reader; the parts are decoration.
 */
function Stage({ label, sign, state, className }: { label: string; sign: string; state: DoorState; className?: string }) {
  return (
    <div
      role="img"
      aria-label={label}
      className={cn("loc-stage relative mx-auto aspect-square w-full max-w-[19rem] sm:max-w-[24rem] lg:max-w-[28rem]", className)}
      data-locadora-stage=""
      data-door={state}
    >
      <div className="absolute left-0 top-[2%] w-[48%]" aria-hidden>
        <img
          src={`${IMG}neon-sign.webp`}
          width={480}
          height={335}
          alt=""
          decoding="async"
          className="block h-auto w-full"
        />
        <span className="loc-sign-text loc-sign-text-small absolute left-[34%] top-[27%] flex h-[37%] w-[54%] items-center justify-center font-display font-black leading-none">
          {sign}
        </span>
      </div>
      <div className="absolute bottom-[2%] right-0 w-[74%]" aria-hidden>
        <img
          src={`${IMG}cart.webp`}
          width={240}
          height={218}
          alt=""
          decoding="async"
          className="loc-door-cart absolute left-[29.5%] top-[-12%] z-10 w-[40%]"
        />
        <img
          src={`${IMG}console.webp`}
          width={480}
          height={416}
          alt=""
          fetchPriority="high"
          decoding="async"
          className="relative block h-auto w-full"
        />
        <span className="loc-door-led absolute left-[52%] top-[63%] h-[2.2%] w-[2.2%] rounded-full" />
      </div>
    </div>
  );
}

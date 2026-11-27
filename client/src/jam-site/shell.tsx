import { MoonIcon as Moon, Music2Icon, SunIcon as Sun, UserIcon, XIcon } from "./icons";
import { useEffect, useState, type ReactNode } from "react";
import { jamLanguage, jt } from "@/lib/i18n/jam-site";
import { useAsk } from "./auth-sheet";
import { mainHref } from "./attribution";
import { chooseLanguage, JAM_LANGUAGES } from "./language";
import { Link, mainOrigin, useJamRoute } from "./router";
import { jamPath } from "./route";
import { appHref, useSignedIn } from "./session";
import { setBrightness, useBrightness } from "./theme";
import { buttonClass } from "./ui";
import { cn } from "./util";

/** The frame of every page: a quiet header, the page, a quiet footer. */

export const CONTAINER = "mx-auto w-full max-w-[76rem] px-4 sm:px-8";

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("whitespace-nowrap font-brand text-[22px] leading-none tracking-tight", className)}>
      pqp <span className="text-accent">jam</span>
    </span>
  );
}

export function ThemeToggle() {
  const brightness = useBrightness();
  const next = brightness === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setBrightness(next)}
      aria-label={jt("theme.toggle")}
      data-jam-theme-toggle=""
      className={cn(buttonClass.base, buttonClass.icon, "max-[359px]:w-9")}
    >
      {brightness === "dark" ? <Sun className="h-[18px] w-[18px]" aria-hidden /> : <Moon className="h-[18px] w-[18px]" aria-hidden />}
    </button>
  );
}

/**
 * Where "Entrar" was. A visitor the app says is signed in (`session.ts`) gets
 * their initial and "Tuas músicas", linking to that list in the app (the songs they
 * started and the parts they sent, each with its answer: round 3, N-3); everybody else gets
 * "Entrar". Both are drawn at every width: at 390 px "Entrar" used to be hidden
 * altogether (finding m10), which left a signed-out phone with no way to sign in.
 */
function AccountLink() {
  const signedIn = useSignedIn();
  if (signedIn) {
    const initial = signedIn.name ? (Array.from(signedIn.name)[0] ?? "").toLocaleUpperCase() : "";
    return (
      <a
        href={appHref("/app?jam=mine")}
        aria-label={jt("nav.account")}
        title={signedIn.name ? `${signedIn.name} · ${jt("nav.account")}` : jt("nav.account")}
        data-jam-account=""
        className={cn(buttonClass.base, buttonClass.ghost, "h-11 gap-2 px-1 text-sm sm:pl-1.5 sm:pr-4")}
      >
        <span
          aria-hidden="true"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-extrabold text-on-accent-soft"
        >
          {initial || <UserIcon className="h-4 w-4" />}
        </span>
        {/* On a phone the short word says what the initial opens ("Músicas"): a bare note read as an unlabelled icon (launch screenshots, problem 7). Under 360 px there is no room for it, and the note stays, named by the link's own label. */}
        <Music2Icon className="h-4 w-4 shrink-0 text-text-secondary min-[360px]:hidden" aria-hidden />
        <span className="max-w-[6rem] truncate text-[13px] font-semibold text-text-secondary max-[359px]:hidden sm:hidden" data-jam-account-short="">
          {jt("nav.accountShort")}
        </span>
        {/* The door is named for what is behind it: the account chip opens "Tuas músicas" in the app (round 3, N-3). The name is in the title and on the initial. */}
        <span className="max-w-[9rem] truncate max-sm:hidden" data-jam-account-label="">
          {jt("nav.account")}
        </span>
      </a>
    );
  }
  return (
    <a href={mainHref("/app", mainOrigin())} data-jam-signin="" className={cn(buttonClass.base, buttonClass.ghost, "h-11 px-2 text-sm max-[359px]:px-1.5 min-[390px]:px-2.5 min-[430px]:px-[18px]")}>
      {jt("nav.signIn")}
    </a>
  );
}

export function Header() {
  const { mount, view } = useJamRoute();
  const ask = useAsk();
  const home = jamPath(mount, { kind: "home" });
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface-0">
      <div className={cn(CONTAINER, "flex h-16 items-center gap-1 min-[390px]:gap-2 min-[430px]:gap-3")}>
        <Link
          href={home}
          aria-label={jt("nav.home")}
          className="inline-flex h-11 items-center rounded-[var(--radius-control)] outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Wordmark className="max-[389px]:text-[19px]" />
        </Link>
        <nav aria-label={jt("nav.label")} className="ml-3 hidden sm:block">
          <Link
            href={home}
            aria-current={view.kind === "home" ? "page" : undefined}
            className={cn(
              "inline-flex h-10 items-center rounded-[var(--radius-pill)] px-4 text-sm font-bold outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
              view.kind === "home" ? "bg-surface-2 text-text" : "text-text-secondary hover:bg-surface-2 hover:text-text",
            )}
          >
            {jt("nav.explore")}
          </Link>
        </nav>
        <span className="flex-1" />
        <AccountLink />
        {/* below 480 px the long label ("Começar uma jam") does not fit beside the wordmark, "Entrar" and the toggle (390
            px is a common phone): the short one is drawn and the long one stays the name, which still contains it */}
        <button type="button" data-jam-start="" aria-label={jt("nav.start")} onClick={() => ask({ kind: "start" })} className={cn(buttonClass.base, buttonClass.primary, "h-11 px-3 text-sm max-[359px]:px-2.5 min-[390px]:px-4 min-[430px]:px-[18px]")}>
          <span className="max-[479px]:hidden">{jt("nav.start")}</span>
          <span className="min-[480px]:hidden" aria-hidden="true">
            {jt("nav.startShort")}
          </span>
        </button>
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * The language choice: three plain buttons, each named in its own language (and
 * marked with it, so a screen reader says "English" in English), the current one
 * pressed. A button and not a link because it reloads into the choice
 * (`language.ts`). No motion: a reload is its own transition.
 */
export function LanguageSwitch() {
  const current = jamLanguage();
  return (
    <div role="group" aria-label={jt("footer.language")} data-jam-language="" className="flex flex-wrap items-center max-sm:-mx-2 sm:-mr-2">
      {JAM_LANGUAGES.map(({ locale, label }) => (
        <button
          key={locale}
          type="button"
          lang={locale}
          aria-pressed={locale === current}
          data-jam-language-option={locale}
          onClick={() => {
            if (locale !== current) chooseLanguage(locale);
          }}
          className={cn(
            "inline-flex min-h-11 min-w-11 items-center justify-center rounded-sm px-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
            locale === current ? "font-bold text-text" : "",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Footer() {
  const origin = mainOrigin();
  // 44 px tall hit area, and the footer's padding gives back what the links take, so it looks as it did
  const link = "inline-flex min-h-11 min-w-11 items-center rounded-sm hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
  return (
    <footer className="mt-16 border-t border-border">
      <div className={cn(CONTAINER, "flex flex-col gap-1 py-5 text-sm text-text-secondary sm:flex-row sm:items-center sm:gap-x-6")}>
        <span className="max-sm:py-1">{jt("footer.line")}</span>
        <span className="flex-1 max-sm:hidden" />
        {/* the three links are one unit: on a phone they stay on one line under the sentence, never one orphaned word */}
        <nav className="flex flex-wrap gap-x-6" aria-label={jt("footer.line")}>
          <a className={link} href={mainHref("/", origin)}>
            {jt("footer.pqp")}
          </a>
          <a className={link} href={`${origin}/terms`}>
            {jt("footer.terms")}
          </a>
          <a className={link} href={`${origin}/privacy`}>
            {jt("footer.privacy")}
          </a>
        </nav>
        <LanguageSwitch />
      </div>
    </footer>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface-0 text-text">
      <a
        href="#jam-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-accent focus:px-4 focus:py-2 focus:text-on-accent"
      >
        {jt("nav.skip")}
      </a>
      <Header />
      <main id="jam-main" className="flex-1">
        {children}
      </main>
      <Footer />
    </div>
  );
}

/**
 * What the public page says when the app sent somebody back (`?from=app`,
 * `lib/jam-intent.ts`): recording in the app is on its way. Dismissable, and it
 * takes the marker off the address so a reload does not bring it back.
 */
export function FromAppNotice({ body }: { body: string }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("from") === "app") {
        url.searchParams.delete("from");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      // The notice just stays on the address; nothing breaks.
    }
  }, []);
  if (!open) return null;
  return (
    <div className="mt-3 flex items-start gap-3 rounded-[var(--radius-card)] border border-border bg-surface-1 py-3 pl-4 pr-2" role="status" data-jam-from-app="">
      <div className="min-w-0 flex-1">
        <p className="font-bold">{jt("fromApp.title")}</p>
        <p className="mt-0.5 text-sm text-text-secondary">{body}</p>
      </div>
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label={jt("sheet.close")}
        className={cn(buttonClass.base, buttonClass.icon)}
      >
        <XIcon className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

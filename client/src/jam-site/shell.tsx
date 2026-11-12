import { MoonIcon as Moon, SunIcon as Sun, XIcon } from "./icons";
import { useEffect, useState, type ReactNode } from "react";
import { jt } from "@/lib/i18n/jam-site";
import { useAsk } from "./auth-sheet";
import { Link, mainOrigin, useJamRoute } from "./router";
import { jamPath } from "./route";
import { setBrightness, useBrightness } from "./theme";
import { button, buttonClass } from "./ui";
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
      className={cn(buttonClass.base, buttonClass.icon, "pointer-coarse:h-11 pointer-coarse:w-11")}
    >
      {brightness === "dark" ? <Sun className="h-[18px] w-[18px]" aria-hidden /> : <Moon className="h-[18px] w-[18px]" aria-hidden />}
    </button>
  );
}

export function Header() {
  const { mount, view } = useJamRoute();
  const ask = useAsk();
  const home = jamPath(mount, { kind: "home" });
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface-0">
      <div className={cn(CONTAINER, "flex h-16 items-center gap-3")}>
        <Link
          href={home}
          aria-label={jt("nav.home")}
          className="rounded-[var(--radius-control)] outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Wordmark />
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
        <a href={`${mainOrigin()}/app`} className={cn(button("ghost"), "max-sm:hidden")}>
          {jt("nav.signIn")}
        </a>
        <button type="button" data-jam-start="" onClick={() => ask({ kind: "start" })} className={button("primary")}>
          {jt("nav.start")}
        </button>
        <ThemeToggle />
      </div>
    </header>
  );
}

export function Footer() {
  const origin = mainOrigin();
  return (
    <footer className="mt-20 border-t border-border">
      <div className={cn(CONTAINER, "flex flex-wrap items-center gap-x-6 gap-y-2 py-8 text-sm text-text-tertiary")}>
        <span>{jt("footer.line")}</span>
        <span className="flex-1 max-sm:hidden" />
        <a className="rounded-sm hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring" href={`${origin}/`}>
          {jt("footer.pqp")}
        </a>
        <a className="rounded-sm hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring" href={`${origin}/terms`}>
          {jt("footer.terms")}
        </a>
        <a className="rounded-sm hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring" href={`${origin}/privacy`}>
          {jt("footer.privacy")}
        </a>
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
        className={cn(buttonClass.base, buttonClass.icon, "h-9 w-9 pointer-coarse:h-11 pointer-coarse:w-11")}
      >
        <XIcon className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

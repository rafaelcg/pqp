import { MoonIcon as Moon, SunIcon as Sun } from "./icons";
import type { ReactNode } from "react";
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

function ThemeToggle() {
  const brightness = useBrightness();
  const next = brightness === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setBrightness(next)}
      aria-label={jt("theme.toggle")}
      data-jam-theme-toggle=""
      className={cn(buttonClass.base, buttonClass.icon)}
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
    <header className="sticky top-0 z-30 border-b border-border bg-surface-0/95 backdrop-blur-sm">
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
        <span className="flex-1" />
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

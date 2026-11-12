import { jt } from "@/lib/i18n/jam-site";
import { AskProvider } from "./auth-sheet";
import { useHead } from "./head";
import { HomePage } from "./home";
import { Link, mainOrigin, useJamRoute } from "./router";
import { jamPath } from "./route";
import { Page, Wordmark, CONTAINER } from "./shell";
import { SongPage } from "./song";
import { setBrightness, useBrightness } from "./theme";
import { button, Skeleton } from "./ui";
import { useJamConfig } from "./use-jam-data";
import { cn } from "./util";

/**
 * The public jam site, behind `GET /api/public/jams/config`. While the flag is
 * off the one thing that is asked of the API is that config: the "em breve"
 * page makes no other data call, and says `noindex`.
 */

function SoonPage() {
  const brightness = useBrightness();
  useHead({ title: jt("soon.metaTitle"), description: jt("soon.body"), noindex: true });
  return (
    <div className="flex min-h-dvh flex-col bg-surface-0 text-text" data-jam-soon="">
      <div className={cn(CONTAINER, "flex h-16 items-center justify-between")}>
        <Wordmark />
        <button
          type="button"
          onClick={() => setBrightness(brightness === "dark" ? "light" : "dark")}
          className={cn(button("ghost"), "px-3")}
        >
          {jt("theme.toggle")}
        </button>
      </div>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 pb-24">
        <h1 className="font-display text-[clamp(2.25rem,8vw,3.5rem)] font-extrabold leading-[1.02] tracking-[-0.025em]">
          {jt("soon.title")}
        </h1>
        <p className="mt-4 text-lg leading-7 text-text-secondary">{jt("soon.body")}</p>
        <div className="mt-8">
          <a href={`${mainOrigin()}/`} className={button("secondary", "lg")}>
            {jt("soon.cta")}
          </a>
        </div>
      </main>
    </div>
  );
}

function NotFound() {
  const { mount } = useJamRoute();
  useHead({ title: jt("meta.homeTitle"), noindex: true });
  return (
    <div className={cn(CONTAINER, "py-24 text-center")} data-jam-message="">
      <h1 className="text-2xl font-extrabold">{jt("notFound.title")}</h1>
      <div className="mt-6 flex justify-center">
        <Link href={jamPath(mount, { kind: "home" })} className={button("primary", "md")}>
          {jt("notFound.cta")}
        </Link>
      </div>
    </div>
  );
}

function Booting() {
  return (
    <div className={cn(CONTAINER, "pt-10")} aria-hidden="true">
      <Skeleton className="aspect-[16/10] w-full rounded-[var(--radius-panel)]" />
    </div>
  );
}

export function JamSite() {
  const config = useJamConfig();
  const { view } = useJamRoute();

  if (config.state === "off") {
    return <SoonPage />;
  }
  return (
    <AskProvider>
      <Page>
        {config.state === "loading" ? (
          <Booting />
        ) : config.state === "error" ? (
          <div className={cn(CONTAINER, "py-24 text-center")} role="alert" data-jam-error="">
            <h1 className="text-2xl font-extrabold">{jt("list.error")}</h1>
            <button type="button" onClick={config.retry} className={button("secondary", "md", "mt-6")}>
              {jt("retry")}
            </button>
          </div>
        ) : view.kind === "song" ? (
          <SongPage key={view.songId} songId={view.songId} />
        ) : view.kind === "home" ? (
          <HomePage />
        ) : (
          <NotFound />
        )}
      </Page>
    </AskProvider>
  );
}

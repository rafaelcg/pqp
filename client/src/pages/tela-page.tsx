import { SignUpButton, SignedIn, SignedOut } from "@clerk/clerk-react";
import { type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * `/tela`: the pt-BR search landing for "discord sem compartilhamento de tela
 * no brasil, o que usar agora".
 *
 * A DIFFERENT JOB FROM `/vs-discord`. That page is a scoreboard for somebody
 * already weighing the two products; this one meets somebody mid-search who
 * only wants to know what works TODAY, and answers that first, with pqp as one
 * of four honest options rather than the only one. Saying out loud that pqp is
 * ours is part of the answer, not a footnote: a comparison that hides its
 * author is the kind of page people learn to scroll past.
 *
 * The same truth rules as the scoreboard: the suspension stated as Discord
 * announced it, no opinion on the order, no mockery, no App Store claim, no
 * "better than Discord". Status lines about the other products are dated on
 * the page (`tela.options.asOf`) so a reader can tell how fresh they are.
 */

interface Option {
  id: "pqp" | "jitsi" | "teamspeak" | "meet";
  name: MessageKey;
  body: MessageKey;
  good: MessageKey;
  limit: MessageKey;
  /** The card that says "this one is ours", and carries the CTA. */
  ours?: boolean;
}

const OPTIONS: Option[] = [
  {
    id: "pqp",
    name: "tela.option.pqp.name",
    body: "tela.option.pqp.body",
    good: "tela.option.pqp.good",
    limit: "tela.option.pqp.limit",
    ours: true,
  },
  {
    id: "jitsi",
    name: "tela.option.jitsi.name",
    body: "tela.option.jitsi.body",
    good: "tela.option.jitsi.good",
    limit: "tela.option.jitsi.limit",
  },
  {
    id: "teamspeak",
    name: "tela.option.teamspeak.name",
    body: "tela.option.teamspeak.body",
    good: "tela.option.teamspeak.good",
    limit: "tela.option.teamspeak.limit",
  },
  {
    id: "meet",
    name: "tela.option.meet.name",
    body: "tela.option.meet.body",
    good: "tela.option.meet.good",
    limit: "tela.option.meet.limit",
  },
];

const STEPS: MessageKey[] = ["tela.how.1", "tela.how.2", "tela.how.3"];

/**
 * In page order. The edge middleware serves the same pairs as FAQPage JSON-LD
 * (`src/lib/marketing-meta.ts`, `TELA_FAQ`), and the suite pins the two
 * copies together, so a question added here without its edge twin fails the
 * tests rather than silently drifting.
 */
const FAQ_ITEMS: { id: string; question: MessageKey; answer: MessageKey }[] = [
  {
    id: "download",
    question: "tela.faq.download.q",
    answer: "tela.faq.download.a",
  },
  { id: "vpn", question: "tela.faq.vpn.q", answer: "tela.faq.vpn.a" },
  { id: "people", question: "tela.faq.people.q", answer: "tela.faq.people.a" },
  { id: "free", question: "tela.faq.free.q", answer: "tela.faq.free.a" },
  { id: "mobile", question: "tela.faq.mobile.q", answer: "tela.faq.mobile.a" },
  { id: "data", question: "tela.faq.data.q", answer: "tela.faq.data.a" },
];

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

function CreateRoomButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const bypass = isDevAuthBypassEnabled();
  const classes = cn("cta-lift h-11 px-6 text-base", className);

  if (bypass) {
    return (
      <Button asChild className={classes}>
        <Link to="/app">{t("tela.cta.create")}</Link>
      </Button>
    );
  }

  return (
    <>
      <SignedOut>
        <SignUpButton mode="modal" forceRedirectUrl="/app">
          <Button className={classes}>{t("tela.cta.create")}</Button>
        </SignUpButton>
      </SignedOut>
      <SignedIn>
        <Button asChild className={classes}>
          <Link to="/app">{t("tela.cta.create")}</Link>
        </Button>
      </SignedIn>
    </>
  );
}

export function TelaPage() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title={t("tela.seo.title")}
        description={t("tela.seo.description")}
        path="/tela"
      />
      <MarketingNav />

      <main className="relative flex-1 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--glow-accent),transparent_55%)]"
          aria-hidden
        />

        <div className="relative mx-auto max-w-5xl px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
          {/* The answer first. The H1 is the query and its reply in one line. */}
          <h1
            className="animate-rise mx-auto max-w-3xl text-balance text-center font-display text-3xl font-bold leading-[1.1] tracking-tight sm:text-5xl"
            style={stagger(0)}
          >
            {t("tela.hero.title")}
          </h1>

          <p
            className="animate-rise mx-auto mt-6 max-w-2xl text-pretty text-center text-base leading-relaxed text-paper-muted sm:text-lg"
            style={stagger(1)}
          >
            {t("tela.hero.lede")}
          </p>

          <div
            className="animate-rise mt-8 flex flex-wrap items-center justify-center gap-3"
            style={stagger(2)}
          >
            <CreateRoomButton />
            <Button
              asChild
              variant="secondary"
              className="cta-lift h-11 px-6 text-base"
            >
              <Link to="/vs-discord">{t("tela.cta.compare")}</Link>
            </Button>
          </div>

          <p
            className="animate-rise mx-auto mt-5 max-w-2xl text-pretty text-center text-xs leading-relaxed text-paper-muted/80"
            style={stagger(3)}
          >
            {t("tela.hero.disclosure")}
          </p>

          {/* What works today: four cards, ours marked as ours. */}
          <section
            className="animate-rise mt-16"
            style={stagger(4)}
            aria-labelledby="tela-options"
          >
            <h2
              id="tela-options"
              className="text-balance text-center font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("tela.options.title")}
            </h2>
            <ul className="mt-8 grid gap-4 sm:grid-cols-2">
              {OPTIONS.map((option) => (
                <li
                  key={option.id}
                  className={cn(
                    "relative flex flex-col overflow-hidden rounded-2xl border p-6",
                    option.ours
                      ? "border-signal/40 bg-signal/[0.07]"
                      : "border-ink-4 bg-ink-2/60",
                  )}
                >
                  {option.ours && (
                    <div
                      className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,var(--glow-accent),transparent_65%)]"
                      aria-hidden
                    />
                  )}
                  <div className="relative flex flex-1 flex-col">
                    <h3 className="flex items-baseline gap-2">
                      <span
                        className={cn(
                          "font-display text-xl font-bold tracking-tight",
                          option.ours ? "text-signal" : "text-paper",
                        )}
                      >
                        {t(option.name)}
                      </span>
                      {option.ours && (
                        <span className="rounded-full border border-signal/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-signal">
                          {t("tela.options.ours")}
                        </span>
                      )}
                    </h3>
                    <p className="mt-2 text-pretty text-sm leading-relaxed text-paper-muted">
                      {t(option.body)}
                    </p>
                    <dl className="mt-4 space-y-3 text-sm">
                      <div>
                        <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-success">
                          {t("tela.options.goodFor")}
                        </dt>
                        <dd className="mt-1 text-pretty leading-relaxed text-paper">
                          {t(option.good)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-warning">
                          {t("tela.options.limit")}
                        </dt>
                        <dd className="mt-1 text-pretty leading-relaxed text-paper-muted">
                          {t(option.limit)}
                        </dd>
                      </div>
                    </dl>
                    {option.ours && <CreateRoomButton className="mt-6 self-start" />}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mx-auto mt-4 max-w-2xl text-pretty text-center text-xs leading-relaxed text-paper-muted/80">
              {t("tela.options.asOf")}
            </p>
          </section>

          {/* How, in three real steps. */}
          <section
            className="animate-rise mt-20"
            style={stagger(5)}
            aria-labelledby="tela-how"
          >
            <h2
              id="tela-how"
              className="text-balance text-center font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("tela.how.title")}
            </h2>
            <ol className="mx-auto mt-8 flex max-w-xl flex-col gap-4">
              {STEPS.map((step, index) => (
                <li key={step} className="flex items-start gap-4">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-signal font-display text-sm font-bold text-ink">
                    {index + 1}
                  </span>
                  <span className="pt-1 text-pretty text-base leading-relaxed text-paper">
                    {t(step)}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          {/* The FAQ. Real page copy; the same pairs go out as FAQPage JSON-LD
              from the edge middleware, and the suite pins the copies together. */}
          <section
            className="animate-rise mt-20"
            style={stagger(6)}
            aria-labelledby="tela-faq"
          >
            <h2
              id="tela-faq"
              className="text-balance text-center font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("tela.faq.title")}
            </h2>
            <dl className="mx-auto mt-8 max-w-2xl space-y-4">
              {FAQ_ITEMS.map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-ink-4 bg-ink-2/60 p-5 sm:p-6"
                >
                  <dt className="font-display text-base font-bold tracking-tight text-paper">
                    {t(item.question)}
                  </dt>
                  <dd className="mt-2 text-pretty text-sm leading-relaxed text-paper-muted">
                    {t(item.answer)}
                    {item.id === "data" && (
                      <>
                        {" "}
                        <Link
                          to="/privacy"
                          className="text-paper underline decoration-paper-muted/40 underline-offset-4 hover:decoration-paper/60"
                        >
                          {t("tela.faq.data.link")}
                        </Link>
                      </>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section
            className="animate-rise mt-20 text-center"
            style={stagger(7)}
            aria-labelledby="tela-closing"
          >
            <h2
              id="tela-closing"
              className="text-balance font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("tela.cta.title")}
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-pretty text-base leading-relaxed text-paper-muted sm:text-lg">
              {t("tela.cta.body")}
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <CreateRoomButton />
              <Link
                to="/vs-discord"
                className="text-sm text-paper-muted underline decoration-paper-muted/40 underline-offset-4 hover:text-paper hover:decoration-paper/60"
              >
                {t("tela.cta.compare")}
              </Link>
            </div>
          </section>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}

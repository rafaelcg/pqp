import { Check, MonitorSmartphone, PhoneCall, Sparkles, X } from "lucide-react";
import { type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { AndroidPhone } from "@/components/marketing/android-phone";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { ANDROID_BETA_CONTACT_EMAIL, androidBetaLinks } from "@/lib/android-beta";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/**
 * `/android` — the closed-beta landing for the native Android app.
 *
 * IT IS NOT `/beta` WITH A DIFFERENT PHONE IN IT, and the difference is the
 * whole design. TestFlight is self-serve: one link, anybody who taps it is in,
 * so that page has one button and spends its words on why you want the app. A
 * Play **closed** track is two links in a fixed order — join the public Google
 * Group, which is the tester list, and only then open the Play opt-in URL — and
 * the failure it produces is silent: doing them the other way round lands you
 * on a Google page that does nothing and tells you nothing. A page that hides
 * that ordering manufactures its own support queue. So the ordering is the
 * shape of the page: numbered in the CTA labels, numbered again in the steps.
 *
 * THE SCARCITY IS REAL, WHICH IS THE ONLY REASON IT IS HERE. Google gates
 * production access for a new personal developer account behind 12 testers
 * opted in and 14 continuous days of testing (`docs/ANDROID_RELEASE.md`). The
 * list is finite and the people on it genuinely do get the app before there is
 * any public listing. Nothing on this page invents a countdown on top of that.
 *
 * HONEST ABOUT THE BUILD. The "what works / what does not" pair is taken from
 * **What is real** in `docs/ANDROID.md` and is not decoration: this app has no
 * reactions, no threads, no camera and no push, and a tester who finds that out
 * after installing is a tester who leaves before day 14.
 */

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

interface Perk {
  id: string;
  icon: typeof PhoneCall;
  title: MessageKey;
  body: MessageKey;
}

const PERKS: Perk[] = [
  {
    id: "voice",
    icon: PhoneCall,
    title: "androidPage.perk.voice.title",
    body: "androidPage.perk.voice.body",
  },
  {
    id: "screen",
    icon: MonitorSmartphone,
    title: "androidPage.perk.screen.title",
    body: "androidPage.perk.screen.body",
  },
  {
    id: "early",
    icon: Sparkles,
    title: "androidPage.perk.early.title",
    body: "androidPage.perk.early.body",
  },
];

/** Built and verified on a device. `docs/ANDROID.md` §What is real. */
const WORKS: MessageKey[] = [
  "androidPage.works.chat",
  "androidPage.works.voice",
  "androidPage.works.screen",
  "androidPage.works.dms",
  "androidPage.works.data",
];

/** Not built. Same section, same list, nothing softened. */
const MISSING: MessageKey[] = [
  "androidPage.missing.push",
  "androidPage.missing.reactions",
  "androidPage.missing.camera",
  "androidPage.missing.invites",
];

const STEPS: MessageKey[] = [
  "androidPage.how.1",
  "androidPage.how.2",
  "androidPage.how.3",
];

export function AndroidPage() {
  const { t } = useTranslation();
  const hasLinks = androidBetaLinks() !== null;

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title={t("androidPage.seo.title")}
        description={t("androidPage.seo.description")}
        path="/android"
      />
      <MarketingNav />

      <main className="relative flex-1 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--glow-accent),transparent_55%)]"
          aria-hidden
        />

        <div className="relative mx-auto w-full max-w-6xl px-5 pb-28 pt-14 sm:px-8 sm:pt-20">
          {/* Hero: copy and product side by side, rather than `/beta`'s single
              centred column. The screenshot is the argument here — a phone
              carrying a voice call and a real conversation says "this is a
              finished-feeling app" faster than the paragraph does. */}
          <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:gap-20">
            <div className="max-w-xl">
              <span
                className="animate-rise inline-flex items-center gap-2 rounded-full border border-signal/50 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-signal"
                style={stagger(0)}
              >
                {t("androidPage.badge")}
              </span>

              <h1
                className="animate-rise mt-6 text-balance font-display text-4xl font-extrabold leading-[1.04] tracking-tight sm:text-5xl"
                style={stagger(1)}
              >
                {t("androidPage.title")}
              </h1>

              <p
                className="animate-rise mt-6 text-pretty text-lg leading-relaxed text-paper-muted"
                style={stagger(2)}
              >
                {t("androidPage.body")}
              </p>

              <div className="animate-rise mt-9" style={stagger(3)}>
                <JoinActions />
              </div>

              {/* The quiet way out, and only when the loud one is the beta.
                  With no links the CTA block already IS "open it in the
                  browser", and two of those in a row reads as a stutter. */}
              {hasLinks && (
                <p className="animate-rise mt-6 text-sm" style={stagger(4)}>
                  <Link
                    to="/app"
                    className="text-paper-muted underline decoration-paper-muted/40 underline-offset-4 hover:text-paper hover:decoration-paper/60"
                  >
                    {t("androidPage.web")}
                  </Link>
                </p>
              )}
            </div>

            <div
              className="animate-rise mx-auto w-[220px] sm:w-[260px] lg:w-full"
              style={stagger(5)}
            >
              <AndroidPhone alt={t("androidPage.phone.alt")} loading="eager" />
            </div>
          </div>

          {/* Why the slots are counted, stated as the rule it is. This is the
              one claim on the page that could read as manufactured urgency, so
              it names the requirement instead of hinting at it. */}
          <section
            className="animate-rise mt-24 rounded-2xl border border-ink-4 bg-ink-2/60 p-7 sm:p-9"
            style={stagger(6)}
          >
            <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {t("androidPage.why.title")}
            </h2>
            <p className="mt-4 max-w-2xl text-pretty text-base leading-relaxed text-paper-muted">
              {t("androidPage.why.body")}
            </p>
            <p className="mt-3 max-w-2xl text-pretty text-base leading-relaxed text-paper-muted">
              {t("androidPage.why.deal")}
            </p>
          </section>

          <section className="animate-rise mt-20" style={stagger(7)}>
            <h2 className="text-center font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {t("androidPage.perks.title")}
            </h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              {PERKS.map((perk) => {
                const Icon = perk.icon;
                return (
                  <div
                    key={perk.id}
                    className="rounded-2xl border border-ink-4 bg-ink-2/60 p-6"
                  >
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-signal/12 text-signal">
                      <Icon aria-hidden className="h-5 w-5" />
                    </span>
                    <h3 className="mt-4 font-display text-base font-bold tracking-tight text-paper">
                      {t(perk.title)}
                    </h3>
                    <p className="mt-2 text-pretty text-sm leading-relaxed text-paper-muted">
                      {t(perk.body)}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>

          {/* The two lists next to each other, same size, same weight. Putting
              the gaps in a footnote under the wins would be the dishonest
              version of the same content. */}
          <section className="animate-rise mt-20" style={stagger(8)}>
            <h2 className="text-center font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {t("androidPage.state.title")}
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-pretty text-center text-sm leading-relaxed text-paper-muted">
              {t("androidPage.state.body")}
            </p>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <StateList
                title={t("androidPage.works.title")}
                items={WORKS}
                tone="yes"
              />
              <StateList
                title={t("androidPage.missing.title")}
                items={MISSING}
                tone="no"
              />
            </div>
          </section>

          <section className="animate-rise mt-20" style={stagger(9)}>
            <h2 className="text-center font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {t("androidPage.how.title")}
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

          <p className="mx-auto mt-16 max-w-xl text-pretty text-center text-sm leading-relaxed text-paper-muted">
            {t("androidPage.honest")}
          </p>

          <div className="mt-10 flex flex-col items-center">
            <JoinActions centered />
          </div>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}

/**
 * The two steps as two buttons, in order, numbered in their own labels.
 *
 * WHY BOTH ARE ON SCREEN AT ONCE and the second is not revealed by pressing the
 * first: this page gets re-opened. Somebody who joined the group yesterday and
 * came back to finish is not helped by a flow that makes them press "join the
 * group" again to reach the link they actually want. The ordering is carried by
 * the numbers in the labels, by the weight (primary, then secondary) and by the
 * line under them, rather than by hiding half the flow.
 *
 * WITHOUT THE LINKS (`androidBetaLinks()` null, i.e. either var unset): no
 * buttons at all, one line saying the slots are not open yet, and the action
 * that is still true — open pqp in the browser. Plus the address to write to,
 * so a person who wants in has somewhere to say so. No disabled button and no
 * "coming soon" with nothing behind it.
 */
function JoinActions({ centered = false }: { centered?: boolean }) {
  const { t } = useTranslation();
  const links = androidBetaLinks();

  if (!links) {
    return (
      <div className={centered ? "flex flex-col items-center" : undefined}>
        <Button
          asChild
          variant="secondary"
          className="cta-lift h-12 rounded-full px-6 text-base"
        >
          <Link to="/app">{t("androidPage.cta.browser")}</Link>
        </Button>
        <p
          className={`mt-4 max-w-md text-sm leading-relaxed text-paper-muted ${
            centered ? "text-center" : ""
          }`}
        >
          {t("androidPage.cta.pending")}{" "}
          <a
            href={`mailto:${ANDROID_BETA_CONTACT_EMAIL}`}
            className="underline decoration-paper-muted/40 underline-offset-4 hover:text-paper hover:decoration-paper/60"
          >
            {ANDROID_BETA_CONTACT_EMAIL}
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className={centered ? "flex flex-col items-center" : undefined}>
      <div
        className={
          centered
            ? "flex flex-wrap justify-center gap-3"
            : "flex flex-wrap gap-3"
        }
      >
        <Button asChild className="cta-lift h-12 rounded-full px-7 text-base">
          <a href={links.groupUrl} target="_blank" rel="noopener noreferrer">
            {t("androidPage.cta.group")}
          </a>
        </Button>
        <Button
          asChild
          variant="secondary"
          className="cta-lift h-12 rounded-full px-6 text-base"
        >
          <a href={links.optInUrl} target="_blank" rel="noopener noreferrer">
            {t("androidPage.cta.optIn")}
          </a>
        </Button>
      </div>
      <p
        className={`mt-4 max-w-md text-sm leading-relaxed text-paper-muted ${
          centered ? "text-center" : ""
        }`}
      >
        {t("androidPage.cta.sub")}
      </p>
    </div>
  );
}

function StateList({
  title,
  items,
  tone,
}: {
  title: string;
  items: MessageKey[];
  tone: "yes" | "no";
}) {
  const { t } = useTranslation();
  const Icon = tone === "yes" ? Check : X;

  return (
    <div className="rounded-2xl border border-ink-4 bg-ink-2/60 p-6">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.2em] text-paper-muted">
        {title}
      </h3>
      <ul className="mt-4 flex flex-col gap-3 text-sm">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-3">
            <Icon
              aria-hidden
              className={`mt-0.5 h-4 w-4 shrink-0 ${
                tone === "yes" ? "text-signal" : "text-paper-muted/60"
              }`}
            />
            <span
              className={
                tone === "yes"
                  ? "text-pretty text-paper"
                  : "text-pretty text-paper-muted"
              }
            >
              {t(item)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

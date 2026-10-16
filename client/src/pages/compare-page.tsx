import { type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { CompareCreateButton } from "@/components/marketing/compare-cta";
import { VerdictCell } from "@/components/marketing/compare-cells";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import {
  FACTS_CHECKED,
  factFor,
  formatCheckedDate,
  MATRIX_FEATURES,
  NOT_APPLICABLE,
  type CompareFeature,
  type CompareProduct,
} from "@/content/compare-facts";
import {
  comparePath,
  COMPARE_FAQ_IDS,
  COMPARE_PAGES,
  MATRIX_PRODUCTS,
  DISCORD_WHAT,
  PRODUCT_NAMES,
  WRITE_UPS,
} from "@/content/compare-products";
import { useTranslation, type MessageKey } from "@/lib/i18n";

const ROW_LABEL: Record<CompareFeature, MessageKey> = {
  price: "vsDiscord.row.price.label",
  openSource: "vsDiscord.row.openSource.label",
  selfHost: "vsDiscord.row.selfHost.label",
  screenShare: "vsDiscord.row.screenShare.label",
  screenAudio: "vsDiscord.row.screenAudio.label",
  watchParty: "vsDiscord.row.watchParty.label",
  layoutImport: "vsDiscord.row.layoutImport.label",
  apps: "vsDiscord.row.apps.label",
  ecosystem: "vsDiscord.row.ecosystem.label",
  maturity: "vsDiscord.row.maturity.label",
};

const HONEST: MessageKey[] = [
  "compare.honest.1",
  "compare.honest.2",
  "compare.honest.3",
  "compare.honest.4",
];

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

function isNotApplicable(product: CompareProduct, feature: CompareFeature): boolean {
  return NOT_APPLICABLE[product]?.includes(feature) ?? false;
}

/**
 * `/compare`: one dated, sourced matrix for pqp and the alternatives people
 * actually weigh against it. Every cell comes from `content/compare-facts.ts`;
 * pqp is in the same table under the same standard and the page lists what it
 * lacks before anything else. About features only, never a company's conduct.
 */
export function ComparePage() {
  const { t, locale } = useTranslation();
  const checked = formatCheckedDate(FACTS_CHECKED, locale);
  const name = (p: CompareProduct) => PRODUCT_NAMES[p];

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title={t("compare.seo.title")}
        description={t("compare.seo.description")}
        path="/compare"
      />
      <MarketingNav />

      <main className="relative flex-1 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--glow-accent),transparent_55%)]"
          aria-hidden
        />
        <div className="relative mx-auto max-w-6xl px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
          <h1
            className="animate-rise mx-auto max-w-3xl text-balance text-center font-display text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl"
            style={stagger(0)}
          >
            {t("compare.hero.title")}
          </h1>
          <p
            className="animate-rise mx-auto mt-6 max-w-2xl text-pretty text-center text-base leading-relaxed text-paper-muted sm:text-lg"
            style={stagger(1)}
          >
            {t("compare.hero.body")}
          </p>
          <p
            className="animate-rise mx-auto mt-4 max-w-2xl text-pretty text-center text-xs leading-relaxed text-paper-muted/80"
            style={stagger(1)}
          >
            {t("compare.hero.asOf", { date: checked })}
          </p>

          <section
            className="animate-rise mx-auto mt-12 max-w-3xl rounded-2xl border border-signal/30 bg-signal/[0.06] p-6 sm:p-8"
            style={stagger(2)}
            aria-labelledby="compare-answer"
          >
            <h2
              id="compare-answer"
              className="font-display text-xl font-bold tracking-tight"
            >
              {t("compare.answer.title")}
            </h2>
            <p className="mt-3 text-pretty text-base leading-relaxed text-paper">
              {t("compare.answer.body")}
            </p>
          </section>

          {/* The matrix. Desktop: a table that scrolls sideways before it
              squeezes. Mobile: one card per feature. */}
          <section
            className="animate-rise mt-20"
            style={stagger(3)}
            aria-labelledby="compare-matrix"
          >
            <h2
              id="compare-matrix"
              className="text-balance text-center font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("compare.matrix.title")}
            </h2>

            <div className="mt-8 hidden overflow-x-auto rounded-2xl border border-ink-4 bg-ink-2/60 lg:block">
              <table className="w-full min-w-[1040px] border-collapse text-left text-sm">
                <caption className="sr-only">{t("compare.matrix.caption")}</caption>
                <thead>
                  <tr className="border-b border-ink-4 bg-ink-3/80">
                    <th
                      scope="col"
                      className="w-[12%] px-4 py-4 text-xs font-semibold uppercase tracking-[0.16em] text-paper-muted"
                    >
                      {t("compare.matrix.col.feature")}
                    </th>
                    {MATRIX_PRODUCTS.map((p) => (
                      <th
                        key={p}
                        scope="col"
                        className={
                          p === "pqp"
                            ? "w-[22%] border-l border-signal/25 bg-signal/[0.07] px-4 py-4 font-brand text-lg tracking-tight text-signal"
                            : "w-[16.5%] border-l border-ink-4 px-4 py-4 text-xs font-semibold uppercase tracking-[0.14em] text-paper-muted"
                        }
                      >
                        {name(p)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {MATRIX_FEATURES.map((feature) => (
                    <tr
                      key={feature}
                      className="border-b border-ink-4/60 last:border-b-0 hover:bg-ink-3/30"
                    >
                      <th
                        scope="row"
                        className="px-4 py-4 align-top text-sm font-semibold text-paper"
                      >
                        {t(ROW_LABEL[feature])}
                      </th>
                      {MATRIX_PRODUCTS.map((p) => {
                        const fact = factFor(p, feature);
                        return (
                          <td
                            key={p}
                            className={
                              p === "pqp"
                                ? "border-l border-signal/25 bg-signal/[0.05] px-4 py-4 align-top"
                                : "border-l border-ink-4 px-4 py-4 align-top"
                            }
                          >
                            {fact ? (
                              <VerdictCell
                                status={fact.status}
                                body={fact.value[locale]}
                                sources={fact.sources}
                                muted={p !== "pqp"}
                              />
                            ) : isNotApplicable(p, feature) ? (
                              <p className="text-sm leading-snug text-paper-muted">
                                {t("compare.matrix.na")}
                              </p>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="mt-8 space-y-3 lg:hidden" aria-label={t("compare.matrix.caption")}>
              {MATRIX_FEATURES.map((feature) => (
                <li
                  key={feature}
                  className="overflow-hidden rounded-xl border border-ink-4 bg-ink-2/60"
                >
                  <p className="border-b border-ink-4/60 px-4 py-3 text-sm font-semibold text-paper">
                    {t(ROW_LABEL[feature])}
                  </p>
                  {MATRIX_PRODUCTS.map((p) => {
                    const fact = factFor(p, feature);
                    return (
                      <div
                        key={p}
                        className={
                          p === "pqp"
                            ? "flex gap-3 border-l-2 border-signal/40 bg-signal/[0.05] px-4 py-3"
                            : "flex gap-3 border-t border-ink-4/60 px-4 py-3"
                        }
                      >
                        <span
                          className={
                            p === "pqp"
                              ? "w-20 shrink-0 pt-px font-brand text-sm tracking-tight text-signal"
                              : "w-20 shrink-0 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-paper-muted"
                          }
                        >
                          {name(p)}
                        </span>
                        {fact ? (
                          <VerdictCell
                            status={fact.status}
                            body={fact.value[locale]}
                            sources={fact.sources}
                            muted={p !== "pqp"}
                          />
                        ) : (
                          <p className="text-sm leading-snug text-paper-muted">
                            {t("compare.matrix.na")}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </li>
              ))}
            </ul>
          </section>

          <section
            className="animate-rise mx-auto mt-20 max-w-3xl"
            style={stagger(4)}
            aria-labelledby="compare-honest"
          >
            <h2
              id="compare-honest"
              className="text-balance text-center font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("compare.honest.title")}
            </h2>
            <ul className="mt-6 space-y-2 rounded-2xl border border-ink-4 bg-ink-2/60 p-6 text-sm leading-relaxed text-paper-muted sm:p-8">
              {HONEST.map((key) => (
                <li key={key} className="flex gap-3">
                  <span
                    aria-hidden
                    className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                  />
                  <span className="text-paper">{t(key)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section
            className="animate-rise mt-20"
            style={stagger(5)}
            aria-labelledby="compare-products"
          >
            <h2
              id="compare-products"
              className="text-balance text-center font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("compare.products.title")}
            </h2>
            <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <li className="flex flex-col rounded-2xl border border-ink-4 bg-ink-2/60 p-6">
                <h3 className="font-display text-lg font-bold tracking-tight">Discord</h3>
                <p className="mt-2 flex-1 text-pretty text-sm leading-relaxed text-paper-muted">
                  {DISCORD_WHAT[locale]}
                </p>
                <Link
                  to={comparePath("discord")}
                  className="mt-4 text-sm font-semibold text-signal underline decoration-signal/40 underline-offset-4 hover:decoration-signal"
                >
                  {t("compare.vs.link")}
                </Link>
              </li>
              {COMPARE_PAGES.map((p) => (
                <li
                  key={p}
                  className="flex flex-col rounded-2xl border border-ink-4 bg-ink-2/60 p-6"
                >
                  <h3 className="font-display text-lg font-bold tracking-tight">
                    {name(p)}
                  </h3>
                  <p className="mt-2 flex-1 text-pretty text-sm leading-relaxed text-paper-muted">
                    {WRITE_UPS[p].what[locale]}
                  </p>
                  <Link
                    to={comparePath(p)}
                    className="mt-4 text-sm font-semibold text-signal underline decoration-signal/40 underline-offset-4 hover:decoration-signal"
                  >
                    {t("compare.products.more")}
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section
            className="animate-rise mx-auto mt-20 max-w-3xl"
            style={stagger(6)}
            aria-labelledby="compare-method"
          >
            <h2
              id="compare-method"
              className="text-balance text-center font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("compare.method.title")}
            </h2>
            <p className="mt-4 text-pretty text-center text-sm leading-relaxed text-paper-muted sm:text-base">
              {t("compare.method.body")}
            </p>
          </section>

          <section
            className="animate-rise mt-20"
            style={stagger(7)}
            aria-labelledby="compare-faq"
          >
            <h2
              id="compare-faq"
              className="text-balance text-center font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("compare.faq.title")}
            </h2>
            <dl className="mx-auto mt-8 max-w-2xl space-y-4">
              {COMPARE_FAQ_IDS.map((id) => (
                <div
                  key={id}
                  className="rounded-xl border border-ink-4 bg-ink-2/60 p-5 sm:p-6"
                >
                  <dt className="font-display text-base font-bold tracking-tight text-paper">
                    {t(`compare.faq.${id}.q` as MessageKey)}
                  </dt>
                  <dd className="mt-2 text-pretty text-sm leading-relaxed text-paper-muted">
                    {t(`compare.faq.${id}.a` as MessageKey)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section
            className="animate-rise mt-20 text-center"
            style={stagger(8)}
            aria-labelledby="compare-closing"
          >
            <h2
              id="compare-closing"
              className="text-balance font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("compare.cta.title")}
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-pretty text-base leading-relaxed text-paper-muted sm:text-lg">
              {t("compare.cta.body")}
            </p>
            <div className="mt-8 flex justify-center">
              <CompareCreateButton surface="compare" />
            </div>
          </section>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}

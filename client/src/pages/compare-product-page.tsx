import { type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { CompareCreateButton } from "@/components/marketing/compare-cta";
import { SourceLinks, VerdictCell } from "@/components/marketing/compare-cells";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import {
  FACTS_CHECKED,
  factFor,
  formatCheckedDate,
  MATRIX_FEATURES,
  type CompareFeature,
} from "@/content/compare-facts";
import {
  comparePath,
  PRODUCT_NAMES,
  WRITE_UPS,
  type DetailProduct,
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

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

/**
 * `/compare/<product>`: the short page behind one column of the hub. What it
 * is, where it is ahead of pqp, where pqp differs, who should pick which, and
 * the same dated, sourced rows. Written from `content/compare-products.ts` and
 * `content/compare-facts.ts`, which carry the sources.
 */
export function CompareProductPage({ product }: { product: DetailProduct }) {
  const { t, locale } = useTranslation();
  const name = PRODUCT_NAMES[product];
  const writeUp = WRITE_UPS[product];
  const checked = formatCheckedDate(FACTS_CHECKED, locale);
  const vars = { name };

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title={t("compare.product.seo.title", vars)}
        description={t("compare.product.seo.description", vars)}
        path={comparePath(product)}
      />
      <MarketingNav />

      <main className="relative flex-1 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--glow-accent),transparent_55%)]"
          aria-hidden
        />
        <div className="relative mx-auto max-w-4xl px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
          <p className="animate-rise text-center text-sm" style={stagger(0)}>
            <Link
              to="/compare"
              className="text-paper-muted underline decoration-paper-muted/40 underline-offset-4 hover:text-paper hover:decoration-paper/60"
            >
              {t("compare.product.back")}
            </Link>
          </p>
          <h1 className="animate-rise mt-6 text-center" style={stagger(1)}>
            <span className="flex flex-col items-center gap-2 sm:flex-row sm:items-baseline sm:justify-center sm:gap-5">
              <span className="font-brand text-5xl tracking-tight text-paper sm:text-6xl">
                pqp
              </span>
              <span className="inline-block -rotate-6 font-brand text-2xl text-signal sm:text-3xl">
                vs
              </span>
              <span className="font-brand text-5xl tracking-tight text-paper-muted sm:text-6xl">
                {name}
              </span>
            </span>
            <span className="mt-5 block text-balance font-display text-lg font-bold tracking-tight sm:text-xl">
              {t("compare.product.tagline")}
            </span>
          </h1>
          <p
            className="animate-rise mx-auto mt-4 max-w-2xl text-pretty text-center text-xs leading-relaxed text-paper-muted/80"
            style={stagger(2)}
          >
            {t("compare.hero.asOf", { date: checked })}
          </p>

          <section
            className="animate-rise mt-14 grid gap-4 md:grid-cols-2"
            style={stagger(3)}
          >
            <div className="rounded-2xl border border-ink-4 bg-ink-2/60 p-6 md:col-span-2">
              <h2 className="font-display text-lg font-bold tracking-tight">
                {t("compare.product.what.title")}
              </h2>
              <p className="mt-2 text-pretty text-sm leading-relaxed text-paper-muted">
                {writeUp.what[locale]}
              </p>
            </div>
            <div className="rounded-2xl border border-ink-4 bg-ink-2/60 p-6">
              <h2 className="font-display text-lg font-bold tracking-tight">
                {t("compare.product.ahead.title", vars)}
              </h2>
              <p className="mt-2 text-pretty text-sm leading-relaxed text-paper-muted">
                {writeUp.ahead[locale]}
              </p>
            </div>
            <div className="rounded-2xl border border-signal/30 bg-signal/[0.06] p-6">
              <h2 className="font-display text-lg font-bold tracking-tight">
                {t("compare.product.different.title")}
              </h2>
              <p className="mt-2 text-pretty text-sm leading-relaxed text-paper">
                {writeUp.different[locale]}
              </p>
            </div>
          </section>

          <section
            className="animate-rise mt-14"
            style={stagger(4)}
            aria-labelledby="compare-product-table"
          >
            <h2
              id="compare-product-table"
              className="text-balance text-center font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("compare.product.table.title")}
            </h2>
            <div className="mt-8 hidden overflow-hidden rounded-2xl border border-ink-4 bg-ink-2/60 md:block">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">{t("compare.matrix.caption")}</caption>
                <thead>
                  <tr className="border-b border-ink-4 bg-ink-3/80">
                    <th
                      scope="col"
                      className="w-[20%] px-5 py-4 text-xs font-semibold uppercase tracking-[0.16em] text-paper-muted"
                    >
                      {t("compare.matrix.col.feature")}
                    </th>
                    <th
                      scope="col"
                      className="w-[40%] border-l border-signal/25 bg-signal/[0.07] px-5 py-4 font-brand text-lg tracking-tight text-signal"
                    >
                      pqp
                    </th>
                    <th
                      scope="col"
                      className="w-[40%] border-l border-ink-4 px-5 py-4 text-xs font-semibold uppercase tracking-[0.16em] text-paper-muted"
                    >
                      {name}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {MATRIX_FEATURES.map((feature) => {
                    const pqp = factFor("pqp", feature)!;
                    const other = factFor(product, feature)!;
                    return (
                      <tr
                        key={feature}
                        className="border-b border-ink-4/60 last:border-b-0 hover:bg-ink-3/30"
                      >
                        <th
                          scope="row"
                          className="px-5 py-4 align-top text-sm font-semibold text-paper"
                        >
                          {t(ROW_LABEL[feature])}
                        </th>
                        <td className="border-l border-signal/25 bg-signal/[0.05] px-5 py-4 align-top">
                          <VerdictCell
                            status={pqp.status}
                            body={pqp.value[locale]}
                            sources={pqp.sources}
                          />
                        </td>
                        <td className="border-l border-ink-4 px-5 py-4 align-top">
                          <VerdictCell
                            status={other.status}
                            body={other.value[locale]}
                            sources={other.sources}
                            muted
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <ul className="mt-8 space-y-3 md:hidden" aria-label={t("compare.matrix.caption")}>
              {MATRIX_FEATURES.map((feature) => {
                const pqp = factFor("pqp", feature)!;
                const other = factFor(product, feature)!;
                return (
                  <li
                    key={feature}
                    className="overflow-hidden rounded-xl border border-ink-4 bg-ink-2/60"
                  >
                    <p className="border-b border-ink-4/60 px-4 py-3 text-sm font-semibold text-paper">
                      {t(ROW_LABEL[feature])}
                    </p>
                    <div className="flex gap-3 border-l-2 border-signal/40 bg-signal/[0.05] px-4 py-3">
                      <span className="w-16 shrink-0 pt-px font-brand text-sm tracking-tight text-signal">
                        pqp
                      </span>
                      <VerdictCell
                        status={pqp.status}
                        body={pqp.value[locale]}
                        sources={pqp.sources}
                      />
                    </div>
                    <div className="flex gap-3 border-t border-ink-4/60 px-4 py-3">
                      <span className="w-16 shrink-0 break-words pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-paper-muted">
                        {name}
                      </span>
                      <VerdictCell
                        status={other.status}
                        body={other.value[locale]}
                        sources={other.sources}
                        muted
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section
            className="animate-rise mt-14 grid gap-4 md:grid-cols-2"
            style={stagger(5)}
            aria-labelledby="compare-product-pick"
          >
            <h2
              id="compare-product-pick"
              className="text-balance font-display text-2xl font-bold tracking-tight sm:text-3xl md:col-span-2 md:text-center"
            >
              {t("compare.product.pick.title")}
            </h2>
            <div className="rounded-2xl border border-ink-4 bg-ink-2/60 p-6">
              <h3 className="font-display text-base font-bold tracking-tight">
                {t("compare.product.pickThem", vars)}
              </h3>
              <p className="mt-2 text-pretty text-sm leading-relaxed text-paper-muted">
                {writeUp.pickThem[locale]}
              </p>
            </div>
            <div className="rounded-2xl border border-signal/30 bg-signal/[0.06] p-6">
              <h3 className="font-display text-base font-bold tracking-tight">
                {t("compare.product.pickPqp")}
              </h3>
              <p className="mt-2 text-pretty text-sm leading-relaxed text-paper">
                {writeUp.pickPqp[locale]}
              </p>
              <CompareCreateButton surface={`compare-${product}`} className="mt-5" />
            </div>
          </section>

          <section className="animate-rise mx-auto mt-14 max-w-2xl text-center" style={stagger(6)}>
            <h2 className="font-display text-base font-bold tracking-tight">
              {t("compare.product.sources.title")}
            </h2>
            <div className="mt-2 flex justify-center text-sm">
              <SourceLinks urls={writeUp.sources} />
            </div>
            <p className="mt-6 text-pretty text-sm leading-relaxed text-paper-muted">
              {t("compare.method.body")}
            </p>
            <p className="mt-6 text-sm">
              <Link
                to="/compare"
                className="text-paper-muted underline decoration-paper-muted/40 underline-offset-4 hover:text-paper hover:decoration-paper/60"
              >
                {t("compare.product.back")}
              </Link>
            </p>
          </section>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}

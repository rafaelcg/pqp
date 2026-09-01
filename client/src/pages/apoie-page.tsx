import { Check, Copy, Heart } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { Navigate } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import { useTranslation } from "@/lib/i18n";
import { supportLinks, type SupportLinks } from "@/lib/support-links";

/**
 * `/apoie` and `/support`: one page, two names, asking for a gift toward the
 * hosting bill and promising nothing in return.
 *
 * THE PROMISE IS THE POINT. No perks, no tiers, no badge, no refunds, and the
 * product does not change for anyone who gives. That is said on the page in
 * plain words because a donation page that hints at benefits is a store, and a
 * store has obligations (delivery, consumer law, receipts) this project is not
 * set up to carry. The copy names the real number, on the order of US$50 a
 * month, so the ask is sized to the truth rather than to what a reader might
 * fear.
 *
 * Both links come from `lib/support-links.ts`, which is empty on a self-hosted
 * build; `ApoieRoute` turns that into a redirect so nobody else's copy of the
 * site ever asks for money on our behalf.
 */

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

/**
 * The routed element. Reads the build's links once and either renders the
 * page or sends the visitor home. Separated from `ApoiePage` so the page can be
 * rendered with explicit links in a test, and so `main.tsx` does not have to
 * know how "enabled" is decided.
 */
export function ApoieRoute() {
  const links = supportLinks();
  if (!links) {
    return <Navigate to="/" replace />;
  }
  return <ApoiePage links={links} />;
}

export function ApoiePage({ links }: { links: SupportLinks }) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      {/* Both routes canonicalise to `/apoie`, the way `/claim` does to
          `/garanta`: one page, one address in the index. */}
      <Seo
        title={t("apoie.seo.title")}
        description={t("apoie.seo.description")}
        path="/apoie"
      />
      <MarketingNav />

      <main className="relative flex-1 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--glow-accent),transparent_55%)]"
          aria-hidden
        />

        <div className="relative mx-auto max-w-3xl px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
          <div className="animate-rise flex justify-center" style={stagger(0)}>
            <span className="inline-flex items-center gap-2 rounded-full border border-signal/50 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-signal">
              <Heart aria-hidden className="h-3.5 w-3.5" />
              {t("apoie.badge")}
            </span>
          </div>

          <h1
            className="animate-rise mt-6 text-balance text-center font-brand text-4xl leading-[1.05] tracking-tight sm:text-5xl"
            style={stagger(1)}
          >
            {t("apoie.title")}
          </h1>

          {/* Two paragraphs, in the first person. The first says what the
              money is for and who is asking; the second says what it does not
              buy. Neither is a footnote. */}
          <p
            className="animate-rise mx-auto mt-8 max-w-xl text-pretty text-base leading-relaxed text-paper-muted sm:text-lg"
            style={stagger(2)}
          >
            {t("apoie.body.1")}
          </p>
          <p
            className="animate-rise mx-auto mt-5 max-w-xl text-pretty text-base leading-relaxed text-paper-muted sm:text-lg"
            style={stagger(3)}
          >
            {t("apoie.body.2")}
          </p>

          <div className="mt-14 grid gap-4 sm:grid-cols-1">
            {links.sponsorUrl && (
              <section
                className="animate-rise rounded-2xl border border-ink-4 bg-ink-2/60 p-6 sm:p-8"
                style={stagger(4)}
                aria-labelledby="apoie-sponsors"
              >
                <h2
                  id="apoie-sponsors"
                  className="font-display text-xl font-bold tracking-tight text-paper sm:text-2xl"
                >
                  {t("apoie.sponsors.title")}
                </h2>
                <p className="mt-2 text-pretty text-sm leading-relaxed text-paper-muted sm:text-base">
                  {t("apoie.sponsors.body")}
                </p>
                <Button asChild className="cta-lift mt-6 h-11 px-6 text-base">
                  <a
                    href={links.sponsorUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("apoie.sponsors.cta")}
                  </a>
                </Button>
              </section>
            )}

            {links.pixKey && (
              <section
                className="animate-rise rounded-2xl border border-ink-4 bg-ink-2/60 p-6 sm:p-8"
                style={stagger(5)}
                aria-labelledby="apoie-pix"
              >
                <h2
                  id="apoie-pix"
                  className="font-display text-xl font-bold tracking-tight text-paper sm:text-2xl"
                >
                  {t("apoie.pix.title")}
                </h2>
                <p className="mt-2 text-pretty text-sm leading-relaxed text-paper-muted sm:text-base">
                  {t("apoie.pix.body")}
                </p>

                <CopyField
                  label={t("apoie.pix.keyLabel")}
                  value={links.pixKey}
                  className="mt-6"
                />
                {links.pixBrCode && (
                  <CopyField
                    label={t("apoie.pix.brcodeLabel")}
                    value={links.pixBrCode}
                    className="mt-4"
                    multiline
                  />
                )}
              </section>
            )}
          </div>

          <p
            className="animate-rise mx-auto mt-14 max-w-xl text-pretty text-center text-sm leading-relaxed text-paper-muted"
            style={stagger(6)}
          >
            {t("apoie.closing")}{" "}
            <a
              href={SOURCE_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-paper underline decoration-paper-muted/40 underline-offset-4 hover:decoration-paper/60"
            >
              {t("apoie.closing.link")}
            </a>
          </p>
          <p
            className="animate-rise mt-4 text-center font-display text-base font-bold tracking-tight text-paper"
            style={stagger(7)}
          >
            {t("apoie.thanks")}
          </p>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}

/**
 * A labelled value in monospace with its own Copy button. The BR code is a
 * few hundred characters of payload nobody reads, so it wraps and gets a
 * smaller face; the key is short and stays on one line.
 */
function CopyField({
  label,
  value,
  className,
  multiline = false,
}: {
  label: string;
  value: string;
  className?: string;
  multiline?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  function copy() {
    const clipboard =
      typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard) {
      setCopied(false);
      return;
    }
    void clipboard.writeText(value).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => {
        setCopied(false);
      },
    );
  }

  return (
    <div className={className}>
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-paper-muted">
        {label}
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start">
        <code
          className={
            multiline
              ? "min-w-0 flex-1 break-all rounded-lg border border-ink-4 bg-ink px-3 py-2 font-mono text-xs leading-relaxed text-paper"
              : "min-w-0 flex-1 truncate rounded-lg border border-ink-4 bg-ink px-3 py-2 font-mono text-sm text-paper"
          }
          title={multiline ? undefined : value}
        >
          {value}
        </code>
        <Button
          type="button"
          variant="secondary"
          onClick={copy}
          aria-label={t("apoie.copy.aria", { what: label })}
          aria-live="polite"
          className="shrink-0 gap-2"
        >
          {copied ? (
            <Check aria-hidden className="h-4 w-4 text-success" />
          ) : (
            <Copy aria-hidden className="h-4 w-4" />
          )}
          {copied ? t("apoie.copied") : t("apoie.copy")}
        </Button>
      </div>
    </div>
  );
}

import { ArrowUpRight, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import { type MessageKey, useTranslation } from "@/lib/i18n";
import { playStoreUrl } from "@/lib/play-store";
import { isSupportPageEnabled, supportPagePath } from "@/lib/support-links";
import { cn } from "@/lib/utils";
import { rich } from "./rich";
import { CONTAINER, H3, HEADER_GAP_SUPPORT, Section, SectionHeader } from "./ui";

/**
 * The worries people have before they move a crew, asked in their words and
 * answered plainly. Native <details>: keyboard and screen reader behaviour
 * come from the browser, and the answers are all there without JavaScript.
 * The component is stateless on purpose, so React never re-applies `open`
 * and closes what a reader opened. Where the browser supports
 * `::details-content`, the panel eases open; elsewhere it simply appears.
 *
 * It is a support section (`weight="support"`: tighter padding, smaller
 * headline) and reads at reading width: one column, no aside, no lede, no
 * numbers (the questions are not a sequence). The two page links that used to
 * sit in the aside go on one line under the list. Nothing reveals on scroll
 * or lifts on hover; an open row changes its plus to paper, not lime.
 *
 * Each answer is one plain string, and the FAQ JSON-LD for "/" must serve
 * exactly that text (`LANDING_FAQ` in `lib/marketing-meta.ts`), so the page
 * and the search snippet say the same thing. With a Google Play listing,
 * that is the `.a.play` answer for the phone question. A link never sits
 * inside an answer: it goes on its own line under it (`FaqLinks`), and that
 * line is where a hosted-only link is gated. `data-faq-question` and
 * `data-faq-answer` mark the two texts a parity test reads; `data-faq-link`
 * marks the line it skips.
 */

const A =
  "text-paper underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-white/60 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal";

/** `/#faq`, the anchor the old landing's FAQ had, still lands here. */
const ALIASES = ["faq"] as const;

type FaqId = "friends" | "history" | "free" | "phone" | "install" | "data" | "future";

/**
 * In page order, which is also the JSON-LD order. `aPlay` is the answer while
 * the build links a Google Play listing (`playStoreUrl()`); without one, `a`
 * is the APK wording.
 */
const FAQ = [
  { id: "friends", q: "home.faq.friends.q", a: "home.faq.friends.a" },
  { id: "history", q: "home.faq.history.q", a: "home.faq.history.a" },
  { id: "free", q: "home.faq.free.q", a: "home.faq.free.a" },
  { id: "phone", q: "home.faq.phone.q", a: "home.faq.phone.a", aPlay: "home.faq.phone.a.play" },
  { id: "install", q: "home.faq.install.q", a: "home.faq.install.a" },
  { id: "data", q: "home.faq.data.q", a: "home.faq.data.a" },
  { id: "future", q: "home.faq.future.q", a: "home.faq.future.a" },
] as const satisfies readonly { id: FaqId; q: MessageKey; a: MessageKey; aPlay?: MessageKey }[];

/** The repository as an address, the way the other link lines show theirs. */
const REPO_LABEL = SOURCE_REPO_URL.replace(/^https?:\/\//, "");

export function Perguntas() {
  const { t } = useTranslation();
  const hasPlay = playStoreUrl() !== null;

  return (
    <Section id="perguntas" aliases={ALIASES} labelledBy="perguntas-title" weight="support">
      <div className={CONTAINER}>
        <SectionHeader
          titleId="perguntas-title"
          title={rich(t("home.faq.title"), { accent: t("home.faq.titleAccent") })}
        />

        {/* The list and the links read at reading width, on the header's left edge. */}
        <div className={cn("max-w-3xl", HEADER_GAP_SUPPORT)}>
          <ul className="border-t border-white/10">
            {FAQ.map((item, i) => (
              <li key={item.id} className="border-b border-white/10">
                <details
                  open={i === 0}
                  className={cn(
                    "group [interpolate-size:allow-keywords]",
                    "[&::details-content]:h-0 [&::details-content]:overflow-clip [&::details-content]:transition-[height,content-visibility] [&::details-content]:duration-300 [&::details-content]:ease-out [&::details-content]:[transition-behavior:allow-discrete]",
                    "open:[&::details-content]:h-auto motion-reduce:[&::details-content]:transition-none",
                  )}
                >
                  <summary className="-mx-3 flex min-h-11 cursor-pointer list-none items-start gap-4 rounded-xl px-3 py-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal sm:gap-6 [&::-webkit-details-marker]:hidden">
                    <H3 className="min-w-0 flex-1 text-paper/85 transition-colors duration-300 ease-out group-hover:text-paper group-open:text-paper text-pretty">
                      <span data-faq-question="">{t(item.q)}</span>
                    </H3>
                    <span
                      aria-hidden
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 text-paper-muted transition-[transform,color,border-color] duration-300 ease-out group-hover:border-white/25 group-hover:text-paper group-open:rotate-45 group-open:border-white/25 group-open:text-paper motion-reduce:transition-none"
                    >
                      <Plus className="h-4 w-4" />
                    </span>
                  </summary>
                  <div className="max-w-3xl space-y-3 pb-7 pr-2 text-[15px] leading-relaxed text-paper-muted text-pretty sm:pr-14 sm:text-base">
                    <p data-faq-answer="">{t("aPlay" in item && hasPlay ? item.aPlay : item.a)}</p>
                    <FaqLinks id={item.id} />
                  </div>
                </details>
              </li>
            ))}
          </ul>

          {/* The two page links that sat in the header's aside. */}
          <ul className="mt-8 flex flex-wrap gap-x-8 gap-y-1 text-sm">
            <li>
              <Link to="/vs-discord" className={cn(A, "inline-flex min-h-10 items-center gap-1.5 no-underline")}>
                {t("home.faq.compare")}
                <ArrowUpRight className="h-3.5 w-3.5 text-paper-muted" aria-hidden />
              </Link>
            </li>
            <li>
              <Link to="/status" className={cn(A, "inline-flex min-h-10 items-center gap-1.5 no-underline")}>
                {t("home.faq.status")}
                <ArrowUpRight className="h-3.5 w-3.5 text-paper-muted" aria-hidden />
              </Link>
            </li>
          </ul>
        </div>
      </div>
    </Section>
  );
}

/**
 * The line under an answer that holds its link, or nothing. Every page it
 * names exists on any build, except the donation page, which is drawn only
 * when `isSupportPageEnabled()` says this build has one.
 */
function FaqLinks({ id }: { id: FaqId }) {
  const { t, locale } = useTranslation();
  switch (id) {
    case "free":
      if (!isSupportPageEnabled()) return null;
      return (
        <p data-faq-link="">
          {rich(t("home.faq.free.link"), {
            link: (
              <Link to={supportPagePath(locale)} className={A}>
                {t("home.faq.free.linkLabel")}
              </Link>
            ),
          })}
        </p>
      );
    case "phone":
      return (
        <p data-faq-link="">
          {rich(t("home.faq.phone.link"), {
            android: (
              <Link to="/android" className={A}>
                pqp.gg/android
              </Link>
            ),
            beta: (
              <Link to="/beta" className={A}>
                pqp.gg/beta
              </Link>
            ),
          })}
        </p>
      );
    case "install":
      return (
        <p data-faq-link="">
          {rich(t("home.faq.install.link"), {
            link: (
              <Link to="/download" className={A}>
                pqp.gg/download
              </Link>
            ),
          })}
        </p>
      );
    case "data":
      return (
        <p data-faq-link="">
          {rich(t("home.faq.data.link"), {
            link: (
              <Link to="/privacy" className={A}>
                {t("home.faq.data.linkLabel")}
              </Link>
            ),
          })}
        </p>
      );
    case "future":
      return (
        <p data-faq-link="">
          {rich(t("home.faq.future.link"), {
            link: (
              <a href={SOURCE_REPO_URL} target="_blank" rel="noopener noreferrer" className={A}>
                {REPO_LABEL}
              </a>
            ),
          })}
        </p>
      );
    default:
      return null;
  }
}

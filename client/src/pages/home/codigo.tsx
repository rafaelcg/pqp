import { ArrowUpRight, Check, CodeXml, Info } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatPostDate } from "@/lib/blog/format";
import { POSTS, blogReadLocaleFor, postLocale, postTitle } from "@/lib/blog/posts";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { isSupportPageEnabled, supportPagePath } from "@/lib/support-links";
import { cn } from "@/lib/utils";
import { OndeStrip } from "./onde";
import { rich } from "./rich";
import { BTN_SECONDARY, CARD, CARD_RAISED, CONTAINER, Eyebrow, H3, HEADER_GAP_SUPPORT, Section, SectionHeader } from "./ui";

/**
 * Trust, in normal-person language. The lede carries the page's one promise
 * (no paid plan, no card, and, where donations exist, donating unlocks
 * nothing). Then two doors with the same code behind them: the hosted pqp.gg
 * (the default) and a copy of your own; where the calls run, read live from
 * `/status.json`, as one unboxed line; who makes it, signed with two names
 * that link to their own sites; and the three newest release notes so the
 * page shows the project is moving. `posts.ts` is metadata only (titles and
 * dates, no bodies), so the strip costs a few kilobytes.
 *
 * It is a support section (`weight="support"`: tighter padding, smaller
 * headline). The two doors are its one boxed element: "Usa o nosso" keeps
 * the lime edge as its recommended cue, and the footnote under each door is
 * plain small text with an info icon, not a box inside the box.
 *
 * HOSTED-ONLY. Donating exists only when `isSupportPageEnabled()` (a build
 * without `VITE_SPONSOR_URL` or `VITE_PIX_KEY` redirects `/apoie` to `/`,
 * `lib/support-links.ts`). Without it, the lede drops the donation clause and
 * the makers line offers the contact page instead of the donate button. The
 * first door is headed "pqp.gg" and its body starts with "No pqp.gg", so its
 * facts (São Paulo, the nightly backup) read as the hosted service's.
 *
 * OLD ANCHORS. `#hosting` (the shared nav and footer) lands on this section
 * through `aliases`, and `#where` (old links and three release notes) lands
 * on the status strip through a wrapper that renders even when the strip
 * hides itself.
 *
 * Motion: none. Nothing here reveals on scroll, tilts or leans; a hover moves
 * colour only.
 */

const REPO_LABEL = SOURCE_REPO_URL.replace(/^https?:\/\//, "");

/** The two makers' own sites. Each name in the signature links to one. */
const RAFAEL_URL = "https://rafael.ltd";
const ANDRE_URL = "https://ndre.dev";

const NAME_LINK =
  "underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-white/60 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal";

const OURS: readonly MessageKey[] = ["home.code.ours.browser", "home.code.ours.server", "home.code.ours.backup"];

const YOURS: readonly MessageKey[] = [
  "home.code.yours.license",
  "home.code.yours.export",
  "home.code.yours.copy",
  "home.code.yours.data",
];

export function Codigo() {
  const { t, locale } = useTranslation();
  const support = isSupportPageEnabled();
  const readLocale = blogReadLocaleFor(locale);
  const notes = POSTS.slice(0, 3);
  return (
    <Section id="codigo" aliases={["hosting"]} labelledBy="codigo-title" weight="support">
      <div className={CONTAINER}>
        <SectionHeader
          titleId="codigo-title"
          title={rich(t("home.code.title"), { accent: t("home.code.titleAccent") })}
          lede={support ? t("home.code.lede.support") : t("home.code.lede")}
          aside={<RepoLink />}
        />

        {/* The two doors: the section's one boxed element. */}
        <div className={cn("grid gap-4 md:grid-cols-2 md:gap-5", HEADER_GAP_SUPPORT)}>
          <article className={cn(CARD_RAISED, "flex flex-col border-signal/40 p-7 sm:p-9")}>
            {/* literal-ok: the hosted service's name, the same in every language */}
            <Door label="pqp.gg" title={t("home.code.ours.title")}>
              {t("home.code.ours.body")}
            </Door>
            <Ticks items={OURS} className="mb-8 mt-8" />
            <Note>{t("home.code.ours.note")}</Note>
          </article>

          <article className={cn(CARD, "flex flex-col p-7 sm:p-9")}>
            <Door label={t("home.code.yours.label")} title={t("home.code.yours.title")}>
              {t("home.code.yours.body")}
            </Door>
            <Ticks items={YOURS} className="mb-8 mt-8" />
            <Note>
              {rich(t("home.code.yours.note"), {
                people: <span className="text-paper">{t("home.code.yours.notePeople")}</span>,
              })}
            </Note>
          </article>
        </div>

        {/* Where the calls run, read live. The wrapper always renders and
            carries `#where`; the line inside may hide itself. */}
        <div id="where">
          <OndeStrip className="mt-10" />
        </div>

        {/* Who makes it, signed, and how to help (or, without donations, how to reach us). */}
        <div className="mt-10 grid gap-6 border-t border-white/[0.06] pt-10 md:grid-cols-12 md:items-center md:gap-10">
          <div className="md:col-span-5">
            <H3 size="md" className="text-paper">
              {t("home.code.makers.title")}
            </H3>
            <p className="mt-2 text-lg leading-snug text-paper">
              {rich(t("home.code.makers.names"), {
                // literal-ok: two people's names, the same in every language
                rafael: (
                  <a href={RAFAEL_URL} target="_blank" rel="noopener noreferrer" className={NAME_LINK}>
                    Rafael
                  </a>
                ),
                // literal-ok: two people's names, the same in every language
                andre: (
                  <a href={ANDRE_URL} target="_blank" rel="noopener noreferrer" className={NAME_LINK}>
                    André
                  </a>
                ),
              })}
            </p>
          </div>
          <div className="flex flex-col items-start gap-5 md:col-span-7 md:flex-row md:items-center md:justify-between md:gap-8">
            <p className="max-w-sm text-base leading-relaxed text-paper-muted text-pretty">
              {support ? t("home.code.makers.donate") : t("home.code.makers.contact")}
            </p>
            <Link to={support ? supportPagePath(locale) : "/contact"} className={cn(BTN_SECONDARY, "shrink-0")}>
              {support ? t("home.code.makers.donateCta") : t("home.code.makers.contactCta")}
            </Link>
          </div>
        </div>

        {/* The project, moving: the three newest release notes, in the
            reader's language where the post has it (`postLocale`). */}
        {notes.length > 0 && (
          <div className="mt-14">
            <div className="flex items-baseline justify-between gap-4">
              <Eyebrow as="h3">{t("home.code.notes.title")}</Eyebrow>
              <Link
                to="/blog"
                className="inline-flex min-h-10 items-center gap-1 rounded-full text-sm font-medium text-paper transition-colors hover:text-paper-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
              >
                {t("home.code.notes.all")}
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
            <ol className="mt-4 grid border-t border-white/[0.07] md:grid-cols-3">
              {notes.map((post) => {
                const shown = postLocale(post, readLocale);
                return (
                  <li
                    key={post.slug}
                    className="border-b border-white/[0.07] md:border-b-0 md:border-r md:last:border-r-0 md:[&:not(:first-child)]:pl-6"
                  >
                    <Link
                      to={`/blog/${post.slug}`}
                      lang={shown === locale ? undefined : shown}
                      className="group block rounded-xl py-5 pr-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                    >
                      <time dateTime={post.date} className="font-mono text-xs text-paper-muted tabular-nums">
                        {formatPostDate(post.date, shown)}
                      </time>
                      <span className="mt-2 block font-display text-lg font-semibold leading-snug text-paper text-pretty transition-colors group-hover:text-paper-muted">
                        {postTitle(post, readLocale)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>
    </Section>
  );
}

/** The repository, as one mono pill. Right-aligned in the header's aside from `lg`. */
function RepoLink() {
  const { t } = useTranslation();
  return (
    <div className="lg:flex lg:justify-end">
      <a
        href={SOURCE_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group inline-flex h-12 max-w-full items-center gap-3 rounded-full border border-white/10 bg-ink-2/80 pl-4 pr-3 font-mono text-sm text-paper transition-colors hover:border-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
      >
        <CodeXml className="h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
        <span className="truncate">{REPO_LABEL}</span>
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/[0.06] transition-colors group-hover:bg-white/[0.14]">
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="sr-only">{t("home.code.repo.sr")}</span>
      </a>
    </div>
  );
}

/** A door's head: where it runs, its name, one line. */
function Door({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <>
      <p className="flex items-center gap-2 font-mono text-xs text-paper-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-paper-muted/60" aria-hidden />
        {label}
      </p>
      <H3 size="lg" className="mt-5">
        {title}
      </H3>
      <p className="mt-3 max-w-sm leading-relaxed text-paper-muted">{children}</p>
    </>
  );
}

/** The footnote both doors end on: plain small text with an info icon, pinned to the bottom so the two doors line up. */
function Note({ children }: { children: ReactNode }) {
  return (
    <p className="mt-auto flex gap-2.5 text-sm leading-relaxed text-paper-muted">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-paper" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** A door's list. `items` are keys, translated here at render. */
function Ticks({ items, className }: { items: readonly MessageKey[]; className?: string }) {
  const { t } = useTranslation();
  return (
    <ul className={cn("space-y-3.5", className)}>
      {items.map((item) => (
        <li key={item} className="flex items-start gap-3 text-[15px] leading-snug text-paper">
          <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/[0.08] text-paper" aria-hidden>
            <Check className="h-3 w-3" strokeWidth={3} />
          </span>
          {t(item)}
        </li>
      ))}
    </ul>
  );
}

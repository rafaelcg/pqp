import { normalizeHandle, validateHandle, type HandleRejection } from "@pqp/shared";
import { ArrowRight, Check, EyeOff, UserPlus, Users } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useCommunitiesEnabled } from "@/hooks/use-communities-enabled";
import { heroHue, heroTintStyle, initialsFor } from "@/lib/hero-tint";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import "./shared/mock.css";
import { BrowserFrame, Clip, Reveal, stillImg, useMediaQuery } from "./cinema";
import "./mudanca.css";
import {
  BTN_DEMO,
  BTN_PRIMARY,
  CARD,
  CONTAINER,
  Caption,
  ExampleTag,
  H3,
  HEADER_GAP,
  Section,
  SectionHeader,
} from "./ui";
import { rich } from "./rich";

/**
 * "Seu endereço": type a name, watch pqp.gg/@nome become a profile page.
 * The field runs the same normaliser and validator as the real claim page
 * (`@pqp/shared`), so what it accepts here is what /garanta accepts. Whether
 * a name is free is the database's call, so this never says "disponível".
 *
 * Beside the playground, the real thing: the sample owner's public page,
 * recorded from the app. At lg it stays in view (sticky) while the playground
 * scrolls past.
 *
 * The drawn banner and poster follow the app's own rule (`heroTintStyle` over
 * `heroHue`, the same call the real public pages make): a field tinted from
 * the handle, or from the community's slug. So they are whatever the real
 * page draws for that name, with the scrim it uses. No gradients of our own,
 * no grain, no blobs. (Today the app's tint tokens in index.css resolve the
 * hue at :root, so every banner, here and on the real page, is the default
 * wash; these start to differ per name when the app fixes that, with no
 * change here. The sample names were picked so none of their hues, near or
 * far end, lands in the violet band, 275 to 345.)
 *
 * The Community block below advertises `pqp.gg/c/<slug>`, which exists only
 * where the server turns communities on (`COMMUNITIES_ENABLED`, off by
 * default). It renders only when `useCommunitiesEnabled()` says so, the same
 * probe the shared header and footer use, and it carries `id="communities"`
 * for their `/#communities` links. Without it the section ends at the
 * playground and still reads whole.
 *
 * The turn-over of the card (`mu-arroba-flip`) lives in mudanca.css.
 */

const SETTLE_MS = 350;

/** The recorded page's address, as the frame shows it. Must match the footage. */
const PROFILE_URL = "pqp.gg/@zeca";

/** The shared normaliser trims, which would eat a space typed mid-name. Keep it as `_`. */
function sanitize(raw: string): string {
  const clean = normalizeHandle(raw);
  return clean && /\s$/.test(raw) && clean.length < 20 ? `${clean}_` : clean;
}

function displayName(handle: string): string {
  return handle
    .split(/[_.-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** The hint under the field: the rules while it is empty, else why the name is refused. */
const HINT = {
  empty: "home.handle.hint.empty",
  length: "home.handle.hint.length",
  format: "home.handle.hint.format",
  reserved: "home.handle.hint.reserved",
  blocked: "home.handle.hint.blocked",
} as const satisfies Record<"empty" | HandleRejection, MessageKey>;

export function SeuArroba() {
  const { t, locale } = useTranslation();
  const communities = useCommunitiesEnabled();
  const inputId = useId();
  const hintId = useId();
  const [value, setValue] = useState("");
  // The name on the card. Empty means nothing typed yet: the card then shows
  // the placeholder in the reader's language, so a reader who types the
  // placeholder itself still gets a real card.
  const [settled, setSettled] = useState("");

  const problem = value ? validateHandle(value) : null;
  const valid = value.length > 0 && problem === null;

  // Turn the card over once typing pauses, never on every keystroke. A name
  // that is refused leaves the card on the last good one.
  useEffect(() => {
    if (value && !valid) return;
    const next = valid ? value : "";
    const timer = window.setTimeout(() => setSettled(next), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [value, valid]);

  const placeholder = t("home.handle.input.placeholder");
  const isPlaceholder = settled === "";
  const shown = settled || placeholder;
  const name = isPlaceholder ? t("home.handle.card.placeholderName") : displayName(settled);
  // The real page shows the month the account was made
  // (`publicProfile.memberSince`, month and year), so an account made today
  // says this month.
  const since = useMemo(
    () => new Intl.DateTimeFormat(intlLocale(locale), { month: "long", year: "numeric" }).format(new Date()),
    [locale],
  );
  // The claim page reads `?handle=` and runs the same normaliser, so a valid
  // name arrives there already typed. The button follows what is typed now,
  // not the card, which waits for typing to pause.
  const claimHref = valid ? `/garanta?handle=${encodeURIComponent(value)}` : "/garanta";

  return (
    <Section id="arroba" labelledBy="arroba-title">
      <div className={CONTAINER}>
        <SectionHeader
          titleId="arroba-title"
          title={rich(t("home.handle.title"), { accent: t("home.handle.titleAccent") })}
          lede={t("home.handle.lede")}
        />

        <div className={cn(HEADER_GAP, "grid grid-cols-1 gap-14 lg:grid-cols-12 lg:items-start lg:gap-12")}>
          {/* The playground: type a name, the claim button and the card follow. */}
          <div className="w-full max-w-2xl lg:col-span-5 lg:max-w-none">
            <div>
              <label htmlFor={inputId} className="block text-sm font-medium text-paper-muted">
                {t("home.handle.input.label")}
              </label>
              <div
                className={cn(
                  "mt-3 flex h-16 items-center gap-1 rounded-2xl border bg-ink-2/80 pl-4 pr-3 transition-colors focus-within:border-signal/60 sm:h-20 sm:pl-6 sm:pr-4 lg:h-[4.5rem] lg:pl-5",
                  problem ? "border-white/20" : "border-white/10",
                )}
              >
                <span aria-hidden className="shrink-0 font-handle text-lg text-paper-muted sm:text-3xl lg:text-2xl">
                  pqp.gg/@
                </span>
                <input
                  id={inputId}
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={20}
                  value={value}
                  placeholder={placeholder}
                  aria-describedby={hintId}
                  aria-invalid={problem ? true : undefined}
                  onChange={(e) => setValue(sanitize(e.target.value))}
                  className="h-full min-w-0 flex-1 bg-transparent font-handle text-lg font-semibold text-paper caret-signal outline-none placeholder:text-paper-muted/40 sm:text-3xl lg:text-2xl"
                />
                <span
                  aria-hidden
                  className={cn(
                    "grid h-8 w-8 shrink-0 place-items-center rounded-full transition-[opacity,transform] duration-200 sm:h-10 sm:w-10",
                    valid ? "scale-100 bg-signal text-ink opacity-100" : "scale-75 opacity-0",
                  )}
                >
                  <Check className="h-4 w-4 sm:h-5 sm:w-5" strokeWidth={3} />
                </span>
              </div>
              {/* Two lines reserved: the empty hint wraps and the others do not, and the button below must not jump. */}
              <p
                id={hintId}
                aria-live="polite"
                className={cn(
                  "mt-3 min-h-10 text-sm",
                  problem && problem !== "length" ? "text-amber-300" : "text-paper-muted",
                )}
              >
                {valid
                  ? rich(t("home.handle.preview"), {
                      handle: <span className="font-handle text-paper">@{value}</span>,
                    })
                  : t(HINT[problem ?? "empty"])}
              </p>

              <div className="mt-5 flex flex-col items-start gap-3">
                <Link to={claimHref} className={cn(BTN_PRIMARY, "max-w-full")}>
                  <span className="min-w-0 truncate">
                    {valid
                      ? rich(t("home.handle.claimNamed"), { handle: <span className="font-handle">@{value}</span> })
                      : t("home.handle.claim")}
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
                </Link>
                <p className="text-sm text-paper-muted">{t("home.handle.rules")}</p>
              </div>
            </div>

            {/* The profile page that name would open. */}
            <Reveal className="mt-10">
              <article aria-label={t("home.handle.card.label")}>
                <BrowserFrame url={`pqp.gg/@${shown}`} bodyClassName="overflow-hidden">
                  <ExampleTag className="absolute right-3 top-3 z-[1] border-white/25 bg-ink/70 text-paper backdrop-blur-sm" />
                  {/* Identity. Turns over when the name settles; fades under reduced motion. */}
                  <div key={shown} className="mu-arroba-flip relative">
                    {/* The real page's rule: a tint from the handle, dissolving into the card. */}
                    <div aria-hidden className="relative h-28 sm:h-36" style={heroTintStyle(heroHue(shown), 45)}>
                      <span className="absolute inset-0 bg-[image:var(--scrim-hero)]" />
                    </div>
                    <div className="px-6 pb-7 sm:px-8">
                      <span
                        aria-hidden
                        className="relative -mt-12 grid h-24 w-24 place-items-center rounded-full bg-signal font-display text-4xl font-bold text-ink ring-4 ring-ink"
                      >
                        {name.charAt(0)}
                      </span>
                      <p
                        className={cn(
                          "mt-4 break-words font-display text-2xl font-bold sm:text-3xl",
                          isPlaceholder && "text-paper/70",
                        )}
                      >
                        {name}
                      </p>
                      <p className="mt-0.5 break-all font-handle text-lg text-signal">@{shown}</p>
                      <p className="mt-1 text-sm text-paper-muted">{t("home.handle.card.since", { date: since })}</p>
                      {/* A picture of the page's own button, not a control. */}
                      <span aria-hidden className={cn(BTN_DEMO, "pointer-events-none mt-5")}>
                        <UserPlus className="h-4 w-4" />
                        {t("home.handle.card.add")}
                      </span>

                      <div className="mt-6">
                        <p className="text-[13px] font-medium text-paper-muted">{t("home.handle.card.connections")}</p>
                        {/* Provider names only, no status dot: a sample, not a claim that anything is linked. */}
                        <ul className="mt-2.5 flex flex-wrap gap-2">
                          {["Steam", "Battle.net", "Twitch"].map((c) => (
                            <li
                              key={c}
                              className="inline-flex h-8 items-center rounded-full border border-white/10 bg-white/[0.03] px-3 text-xs font-medium text-paper"
                            >
                              {c}
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2.5 text-xs leading-relaxed text-paper-muted">
                          {t("home.handle.card.connectionsNote")}
                        </p>
                      </div>
                    </div>
                  </div>
                </BrowserFrame>
              </article>
            </Reveal>
          </div>

          {/* The real page, recorded from the app. */}
          <div className="order-first lg:sticky lg:top-24 lg:order-none lg:col-span-7 lg:self-center">
            <RealProfile />
          </div>
        </div>

        {communities && <Community />}
      </div>
    </Section>
  );
}

/**
 * Communities get an address too: a poster, never a member list. Rendered
 * only where communities are on (see the top of the file); `id` is the
 * target of the shared header and footer's `/#communities`.
 */
function Community() {
  const { t } = useTranslation();
  const name = t("home.handle.community.name");
  // The real page seeds its hue from the slug, never the name (a name can be
  // edited; the address is what people shared), and so does this.
  const hue = heroHue(t("home.handle.community.slug").split("/").pop() ?? "");
  return (
    <div id="communities" className="mt-20 grid items-center gap-8 sm:mt-24 lg:grid-cols-12 lg:gap-12">
      <div className="lg:col-span-6">
        <H3 size="lg">{t("home.handle.community.title")}</H3>
        <p className="mt-3 font-mono text-sm text-paper-muted">{t("home.handle.community.address")}</p>
        <p className="mt-4 max-w-md leading-relaxed text-paper-muted text-pretty">{t("home.handle.community.body")}</p>
      </div>

      <Reveal variant="scale" className="lg:col-span-6">
        <article
          aria-label={t("home.handle.community.label")}
          className={cn(CARD, "relative mx-auto max-w-md overflow-hidden lg:mx-0")}
        >
          {/* The tint the app draws for a community with no uploaded banner or icon. */}
          <div className="relative h-36 overflow-hidden sm:h-44" style={heroTintStyle(hue, 45)}>
            <span aria-hidden className="absolute inset-0 bg-[image:var(--scrim-hero)]" />
            <ExampleTag className="absolute right-3 top-3 border-white/25 bg-ink/70 text-paper backdrop-blur-sm" />
          </div>
          <div className="relative -mt-8 px-5 pb-5">
            <span
              aria-hidden
              className="grid h-14 w-14 place-items-center rounded-2xl font-display text-xl font-bold text-paper ring-4 ring-ink-2"
              style={heroTintStyle(hue, 60)}
            >
              {initialsFor(name)}
            </span>
            <p className="mt-3 font-display text-xl font-bold">{name}</p>
            <p className="mt-0.5 text-sm text-paper-muted">{t("home.handle.community.tagline")}</p>
            <p className="mt-1 font-mono text-xs text-paper-muted">{t("home.handle.community.slug")}</p>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-1 text-paper">
                <Users className="h-3.5 w-3.5" aria-hidden />
                {t("home.handle.community.members")}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-paper-muted ring-1 ring-inset ring-white/10">
                <EyeOff className="h-3.5 w-3.5" aria-hidden />
                {t("home.handle.community.private")}
              </span>
            </div>
          </div>
        </article>
      </Reveal>
    </div>
  );
}

/**
 * How the recorded page sits in its frame. These are the numbers to re-tune
 * when the footage is re-recorded; each is a whole class string so Tailwind
 * sees it.
 *
 * Wide screens (from `sm`) show the desktop recording, `profile`, 1920 by
 * 1200: the page's centred card (about 1020 wide) with the site's footer
 * below it, and a strip under the card that reads "GARANTA O SEU @". The
 * loop scrolls the page about 250 rows, so the strip rises from row 1000 to
 * row 743 and holds there for most of the loop. The window therefore ends at
 * row 730, above the strip's highest point, and starts at row 60, under the
 * site's own menu, so it is 670 rows tall and 1072 wide (16 / 10): the card
 * fills the frame, the depoimentos scroll into it from below and the strip
 * never comes in. That is a push-in of 1.79 about the top of the picture
 * (rows 60 to 730 is the origin at 11.3% of the height).
 *
 * The still under reduced motion is the first frame, before the page has
 * scrolled, so it takes a taller window (see `PROFILE_PUSH_IN`).
 *
 * Phones (below `sm`) show a recording made at a phone's width instead,
 * `profile-phone` (960 by 1422, from a 390 by 844 page at 3x): the avatar down
 * to the first depoimento at rest, scrolling to both and back. The depoimentos
 * are 14 px text in that page and the frame shows the page at 0.9 of its size,
 * so they read at about 12.6 px, where the desktop recording, cropped to fit
 * a 350 px frame, drew them at about 6. The recording needs no crop of its own
 * here (the strip is outside its window), so none of the classes below apply
 * to it.
 */
const PROFILE_FRAME = "aspect-[16/10]";
const PROFILE_PUSH_IN = [
  "[&_img]:origin-[50%_11.3%] [&_video]:origin-[50%_11.3%] [&_img]:scale-[1.79] [&_video]:scale-[1.79]",
  // With reduced motion the picture is the loop's first frame and never
  // scrolls, so the depoimentos (rows 710 to 916) sit below the loop's
  // window. This still shows rows 72 to 961 instead: under the site's menu
  // (its button ends at row 66), with the card and both depoimentos, and
  // above the strip (its rule is at row 976).
  "motion-reduce:[&_img]:origin-[50%_23.1%] motion-reduce:[&_img]:scale-[1.35]",
].join(" ");

/** Below this width the page shows the phone recording (`sm`, where the frame outgrows a phone's page). */
const PHONE_PROFILE_MEDIA = "(max-width: 639px)";
/** The phone recording's own shape: its frame is as tall as the page it shows. */
const PHONE_PROFILE_FRAME = "aspect-[960/1422]";
const PHONE_PROFILE_STILL = { src: "/media/home/profile-phone.webp", width: 960, height: 1422 } as const;

/**
 * The sample owner's public page, the real footage. On a phone it is the page
 * as a phone draws it; from `sm` it is the desktop page, scrolled until the
 * card's bottom sits just above the window's edge, and the fade at the bottom
 * softens where the depoimentos leave it.
 */
function RealProfile() {
  const { t } = useTranslation();
  const phone = useMediaQuery(PHONE_PROFILE_MEDIA);
  const alt = t("home.handle.real.alt");
  return (
    <Reveal variant="scale" as="figure" className={phone ? "mx-auto max-w-[22rem]" : undefined}>
      <BrowserFrame
        url={PROFILE_URL}
        bodyClassName={cn(phone ? PHONE_PROFILE_FRAME : PROFILE_FRAME, "overflow-hidden")}
      >
        {phone ? (
          <Clip
            name="profile-phone"
            fallbackStill={{ ...PHONE_PROFILE_STILL, alt }}
            label={t("home.handle.real.label")}
            position="object-top"
            className="absolute inset-0"
            controlsClassName="bottom-auto top-3"
          />
        ) : (
          <>
            <Clip
              name="profile"
              fallbackStill={stillImg("profile", alt, "(min-width: 1024px) 760px, 100vw")}
              label={t("home.handle.real.label")}
              position="object-center"
              className={cn("absolute inset-0", PROFILE_PUSH_IN)}
              // Top right: the bottom of the window fades out (below).
              controlsClassName="bottom-auto top-3"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-[12%] bg-gradient-to-t from-ink from-[12%] to-transparent"
            />
          </>
        )}
      </BrowserFrame>
      <figcaption>
        <Caption example>{t("home.handle.real.caption")}</Caption>
        <p className="mt-3 flex items-start gap-2 text-sm text-paper-muted">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
          {t("home.handle.real.note")}
        </p>
      </figcaption>
    </Reveal>
  );
}

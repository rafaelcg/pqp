/**
 * The app's string catalogue — English, plus the machinery to look a string up.
 *
 * WHY NOT AN I18N LIBRARY
 *
 * react-intl, i18next and friends are 15–40 KB gzipped before a single string
 * ships, and they buy features this app does not use: ICU plurals, gendered
 * selects, date/number formatting, namespaces, lazy namespace resolution. What
 * the funnel actually needs is "look up a key, substitute a couple of values,
 * fall back to English". That is the twenty lines below. `client/bench/` and the
 * code-splitting in `main.tsx` exist because this project treats the initial
 * download as a budget, and a dependency that outweighs the strings it serves
 * does not clear it. If the app later needs real plural rules, `Intl.PluralRules`
 * is already in every target browser at zero bytes.
 *
 * WHY FLAT KEYS
 *
 * A single-level object with dotted keys means `keyof typeof en` IS the key
 * type: every `t()` call is checked at compile time and autocompletes, with no
 * recursive mapped types to maintain. Nested objects would need a path-flattening
 * type that costs more to read than it saves.
 *
 * ENGLISH IS THE SOURCE OF TRUTH. Translations are `Partial`, so a key nobody
 * has translated yet renders the English sentence — never a key name, never an
 * empty string. That is what makes it safe to add a string here and translate it
 * in a later commit.
 */

import type { Locale } from "@/lib/locale";

export const en = {
  // ---------------------------------------------------------------- marketing
  "nav.howItWorks": "How it works",
  "nav.selfHost": "Self-host",
  "nav.signIn": "Sign in",
  "nav.signUp": "Spin up a server",
  "nav.openApp": "Open the app",

  "landing.seo.title": "pqp — group chat you own",
  "landing.seo.description":
    "Chaotic group chat with servers, channels, and voice that just works. Open source — self-host or use pqp.gg.",
  "landing.hero.title": "Your friends. Your server. Your mess.",
  "landing.hero.body":
    "Chaotic group chat you actually own — text that flies, voice that doesn't flake. Self-host if you want the keys, or just use ours.",

  "landing.trust.openSource": "Open source",
  "landing.trust.selfHostable": "Self-hostable",
  "landing.trust.meshVoice": "Mesh voice",
  "landing.trust.inviteCodes": "Invite codes",
  "landing.trust.yourKeys": "Your keys",

  "landing.pitch.title": "Tired of renting the room?",
  "landing.pitch.body":
    "Big chat apps rewrite the house rules, bury your servers, and treat your crew like inventory. pqp is the opposite: make a server, invite people, talk. Keep the keys if you want — or use ours and skip the ops.",

  "landing.how.title": "Three moves. Then you're loud.",
  "landing.how.body": "No onboarding maze. Create, invite, cause problems.",
  "landing.how.step1.title": "Make a server",
  "landing.how.step1.body":
    "Name it something stupid. Text and voice channels show up ready.",
  "landing.how.step2.title": "Drop an invite",
  "landing.how.step2.body":
    "Share a code. Friends pile in — no app-store gatekeeping.",
  "landing.how.step3.title": "Talk",
  "landing.how.step3.body":
    "Spam the channels. Jump into mesh voice when the group chat isn't enough.",

  "landing.hosting.title": "Run it yourself — or don't",
  "landing.hosting.body": "Same product. You pick who babysits the metal.",
  "landing.hosting.selfHost.title": "Self-host",
  "landing.hosting.selfHost.body":
    "Clone the repo, point it at Postgres, plug in your own Clerk keys. Your data stays on your box. Unlimited for OSS use — you own the stack.",
  "landing.hosting.hosted.title": "Hosted at pqp.gg",
  "landing.hosting.hosted.body":
    "Sign up and go. We run the servers, auth, and storage. Same chaos, zero ops.",

  "landing.cta.title": "The room's empty. Fix that.",
  "landing.cta.body":
    "Spin up a server in under a minute. Invite the chaos later.",

  "footer.tagline":
    "Group chat you own. Self-host or use pqp.gg — same chaos either way.",
  "footer.product": "Product",
  "footer.legal": "Legal",
  "footer.status": "Status",
  "footer.privacy": "Privacy",
  "footer.terms": "Terms",
  "footer.cookies": "Cookies",
  "footer.copyright":
    "© {year} pqp. Open source. Built for the group that won't shut up.",

  // ------------------------------------------------------- app bootstrap shell
  "app.seo.title": "App — pqp",
  "app.seo.description": "Open pqp — servers, text, and voice.",
  "app.loading": "Loading…",
  "app.loading.signingIn": "Signing in…",
  "app.loading.servers": "Loading servers…",

  "signedOut.title": "Sign in to talk.",
  "signedOut.body": "Create an account or sign in to open your servers.",
  "signedOut.createAccount": "Create account",

  "bootstrapError.title": "Can't reach the API",
  "bootstrapError.fallback": "Failed to load servers from the API",
  // Split around the two <code> elements. This paragraph is aimed at whoever
  // deployed the site rather than at a visitor, which is why the identifiers
  // inside it stay verbatim while the prose around them translates.
  "bootstrapError.deploy.1":
    "The marketing site on Cloudflare Pages is static. Sign-in works via Clerk, but servers need a hosted API (Railway/Docker) with",
  "bootstrapError.deploy.2": "and",
  "bootstrapError.deploy.3": "set at build time. See",
  "bootstrapError.retry": "Try again",
  "bootstrapError.home": "Back to home",

  // ------------------------------------------------------------- empty states
  "empty.noServers.title": "No servers yet",
  "empty.noServers.body": "Create a server or join with an invite code.",
  "empty.pickChannel.title": "Pick a channel",
  "empty.pickChannel.body": "Open the sidebar and choose text or voice.",
  "empty.noConversation.title": "No conversation open",
  "empty.noConversation.body":
    "Pick someone from the list, or message anyone by handle.",
  "empty.createServer": "Create server",
  "empty.joinInvite": "Join invite",
  "empty.newMessage": "New message",
  "empty.openNav": "Open navigation",

  "sso.title": "Available to you",
  "sso.body.one":
    "Your verified email lets you join this server without an invite.",
  "sso.body.many":
    "Your verified email lets you join these servers without an invite.",
  "sso.join": "Join",
  "sso.joining": "Joining…",
  "sso.joinFailed": "Could not join {name}",

  // ------------------------------------------------------- connection status
  "connection.reconnecting": "Connection lost — reconnecting…",
  "connection.unauthorized": "Session expired — reconnecting…",
  "connection.dismiss": "Dismiss",
  "connection.authFailed": "Realtime authentication failed — sign in again",
  "connection.wsUrlFailed":
    "Realtime connection failed — check the WebSocket URL",

  // ------------------------------------------------------------------ age gate
  "ageGate.eyebrow": "Before you start",
  "ageGate.title": "Confirm your date of birth",
  "ageGate.description": "pqp is for people aged {age} and over.",
  "ageGate.intro":
    "We ask once, and we do not check it against any document — we are taking your word for it. Please make it accurate before you continue, because you cannot change this answer later.",
  "ageGate.legend": "Date of birth",
  "ageGate.day": "Day",
  "ageGate.day.placeholder": "DD",
  "ageGate.month": "Month",
  "ageGate.year": "Year",
  "ageGate.year.placeholder": "YYYY",
  "ageGate.warning":
    "You can only answer this once. If the date you enter is under {age}, this account will be closed and you will not be able to try a different date.",
  "ageGate.submit": "Continue",
  "ageGate.submitting": "Saving…",
  "ageGate.error.badDate":
    "That is not a date we can read. Check the day, month and year.",
  "ageGate.error.save":
    "Could not save that. Check your connection and try again.",

  "ageGate.month.1": "January",
  "ageGate.month.2": "February",
  "ageGate.month.3": "March",
  "ageGate.month.4": "April",
  "ageGate.month.5": "May",
  "ageGate.month.6": "June",
  "ageGate.month.7": "July",
  "ageGate.month.8": "August",
  "ageGate.month.9": "September",
  "ageGate.month.10": "October",
  "ageGate.month.11": "November",
  "ageGate.month.12": "December",

  "ageGate.blocked.eyebrow": "Age check",
  "ageGate.blocked.title": "pqp is for {age} and over",
  "ageGate.blocked.body":
    "Thanks for answering honestly. The date of birth you gave is under {age}, so this account is closed. That is a rule about the service, not a judgement about you — pqp is built for adults and we are not able to make exceptions to it.",
  // Split around the inline link to /terms. The link sits at the very end of
  // the sentence on purpose: a link mid-sentence would need each segment to
  // carry its own leading space or comma, and languages disagree about which.
  // Here the only thing after the link is the full stop.
  "ageGate.blocked.appeal.before":
    "If you entered the wrong date by mistake, you can ask us to look at it again. The address for appeals — and for asking us to delete the account and the data attached to it — is on our",
  "ageGate.blocked.appeal.link": "Terms page",
  "ageGate.blocked.appeal.after": ".",
  "ageGate.blocked.wait":
    "Please do not open another account in the meantime — we would rather settle this one.",
  "ageGate.blocked.back": "Back to pqp.gg",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
/** What a translation ships: anything it omits falls through to English. */
export type PartialMessages = Partial<Messages>;

/** Values substituted into `{placeholder}` slots. */
export type MessageVars = Record<string, string | number>;

/**
 * Look a key up, English behind it, and fill in any `{placeholder}` slots.
 *
 * The fallback is deliberately per-key rather than per-catalogue: a translation
 * that covers nine strings out of ten renders nine translated and one English,
 * which is a page a user can still act on. Falling back wholesale would throw
 * away nine good sentences to avoid one mixed paragraph.
 */
export function translate(
  catalogue: PartialMessages | undefined,
  key: MessageKey,
  vars?: MessageVars,
): string {
  // `||` rather than `??`: an empty string in a translation is a missing
  // translation, not a deliberate blank, and must not win over English.
  const template = catalogue?.[key] || en[key];
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    // An unknown placeholder is left verbatim rather than blanked, so a typo
    // shows up as `{age}` on screen instead of silently eating the number.
    return value === undefined ? whole : String(value);
  });
}

/**
 * The catalogue currently on screen, for the handful of non-React modules that
 * produce user-visible strings (`lib/realtime.ts`). `I18nProvider` is the only
 * writer — this is a mirror of React state, never a second source of truth for
 * which language is active.
 */
let active: PartialMessages | undefined;

export function setActiveCatalogue(catalogue: PartialMessages | undefined) {
  active = catalogue;
}

/** `t()` for modules that cannot use the hook. */
export function translateMessage(key: MessageKey, vars?: MessageVars): string {
  return translate(active, key, vars);
}

/**
 * Fetch a locale's catalogue, or `undefined` for English (which is already in
 * the bundle). Kept beside the catalogue itself so the dynamic `import()` — the
 * thing that decides chunk boundaries — is visible next to what it loads.
 */
export async function loadCatalogue(
  locale: Locale,
): Promise<PartialMessages | undefined> {
  if (locale === "pt-BR") {
    const module = await import("./messages.pt-BR");
    return module.ptBR;
  }
  return undefined;
}

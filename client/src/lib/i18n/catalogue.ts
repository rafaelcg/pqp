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
  // The Portuguese hero is a pun ("vem pra pqp") that does not survive
  // translation, so English carries the intent — an invitation — rather than
  // the joke. Both name the same three things the product actually has: voice,
  // text, screen share. There is no camera video; do not add one here.
  "landing.hero.title": "Come hang out at pqp.",
  "landing.hero.body":
    "Voice, chat and screen sharing for your people. Make a server, share the link. That's it.",

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

  // Every line below describes something that ships today and is on by default
  // — no env var, no flag, no admin-only path. Attachments are deliberately
  // absent: they are dark unless S3_* is configured, and production is not.
  // Camera video, custom emoji, threads and slow mode do not exist at all.
  "landing.features.title": "The basics, done right.",
  "landing.features.body":
    "No roadmap promises. Everything here works today — in the browser, on the desktop, or installed on your phone.",

  "landing.features.voice.title": "Voice channels",
  // The 5–8 figure is the real mesh ceiling (MESH_VOICE_LIMIT), stated as a
  // fact. Hiding it is how the first full channel becomes a broken promise.
  "landing.features.voice.body":
    "Jump in and talk. Audio goes straight between you — 5 to 8 people per channel.",
  "landing.features.screen.title": "Screen sharing",
  "landing.features.screen.body":
    "Show the game, the code or the bug to everyone in the channel. One person at a time.",
  "landing.features.chat.title": "Chat with no fuss",
  "landing.features.chat.body":
    "Markdown, replies, reactions, pinned messages and @mentions. Paste a link and it unfurls.",
  "landing.features.search.title": "Find what was said",
  "landing.features.search.body":
    "Search a whole server by word and land on the message, with what came before and after.",
  "landing.features.dms.title": "DMs and group chats",
  "landing.features.dms.body":
    "Message someone privately, or put up to 10 people in the same group.",
  "landing.features.structure.title": "Your server, your rules",
  "landing.features.structure.body":
    "Categories to keep it tidy, private channels, and three roles: owner, admin, member.",
  "landing.features.invites.title": "An invite is just a link",
  "landing.features.invites.body":
    "Send it and they're in. Cap how many times it works and how long it lasts.",
  "landing.features.moderation.title": "Moderation that holds",
  "landing.features.moderation.body":
    "Kick, ban, delete and take reports from inside the app — all of it logged.",

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
  // The closing CTA and the share/invite copy point outward — "go to pqp" —
  // where the hero pointed inward ("come to pqp"). The contrast is deliberate.
  // The arrow is drawn in JSX and hidden from assistive tech, so it stays out
  // of the string a translator has to carry.
  "landing.cta.action": "Head to pqp",

  // ------------------------------------------------------- desktop downloads
  // Secondary to the hero's real call to action on purpose: the web app is the
  // product and the desktop shell is a convenience, so this reads as a line of
  // text rather than a second button competing for the same click.
  //
  // Only macOS is signed and notarized. Windows and Linux are not, and the
  // strings below say so at the point of download — a SmartScreen dialog that
  // arrives unannounced reads as "this app is malware", which is a worse
  // outcome than one honest sentence. Nothing here mentions an app store,
  // because there is none, and nothing promises auto-update.
  "download.mac.appleSilicon": "Download for Mac (Apple Silicon)",
  "download.mac.intel": "Download for Mac (Intel)",
  "download.mac.either": "Download for Mac:",
  "download.mac.appleSiliconShort": "Apple Silicon",
  "download.mac.intelShort": "Intel",
  // Shown only when the browser refuses to say which chip this Mac has. The
  // instruction has to be followable by someone who has never opened About This
  // Mac, because the alternative is a download that will not run.
  "download.mac.whichChip":
    "Not sure which? Apple menu → About This Mac. Anything that says Apple M1 or newer is Apple Silicon.",
  "download.windows": "Download for Windows",
  "download.windows.unsigned":
    "The Windows build isn't signed yet, so SmartScreen warns the first time you open it.",
  "download.linux": "Download for Linux:",
  "download.linux.appImage": "AppImage",
  "download.linux.deb": ".deb",
  // The `.full` variants are the accessible names for the two links above.
  // "AppImage" on its own is what a screen reader announces out of context,
  // and out of context it says nothing about what the link does.
  "download.linux.appImage.full": "Download for Linux (AppImage)",
  "download.linux.deb.full": "Download for Linux (.deb)",
  "download.linux.unsigned": "The Linux builds aren't signed either.",
  "download.unsigned.help": "Why",
  "download.other": "Desktop downloads",
  // A phone gets pointed at the browser, never at a .dmg — and never at a store
  // listing, which does not exist. It is installable from the browser menu
  // (docs/PWA.md), which is the honest version of "get the app".
  "download.mobile":
    "There's no app to install here — open pqp in your browser and add it to your home screen from the browser menu.",

  "footer.tagline":
    "Group chat you own. Self-host or use pqp.gg — same chaos either way.",
  "footer.product": "Product",
  "footer.desktop": "Desktop app",
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

  // ------------------------------------------------------ first-run onboarding
  // Register: the same voice as the landing page — short sentences, confident,
  // no exclamation marks, no emoji. This is a conversation, not a setup wizard,
  // so nothing here says "step 1 of 3", "welcome aboard" or "you're all set".
  //
  // English is the source of truth and has to read like someone wrote it, not
  // like a translation of the Portuguese. Where the pun does not survive (the
  // handle is "seu @" in Brazil and has no snappy English equivalent) English
  // carries the meaning rather than the joke.
  // The confetti screen. The confetti does the celebrating; the words stay
  // deadpan, because understatement next to a screenful of falling paper is
  // funnier than enthusiasm next to it — and because this product does not
  // shout. "One field" is the joke: it is genuinely one field, and calling it
  // paperwork is the only exaggeration on the screen.
  "onboarding.handle.eyebrow": "You're in",
  "onboarding.handle.title": "Now the paperwork",
  "onboarding.handle.description":
    "One field. This is the name people type to find you — we took it off your account, and the number is yours.",
  "onboarding.handle.label": "Handle",
  "onboarding.handle.hint":
    "Lowercase, numbers and _ only. The number after it comes free.",
  "onboarding.handle.confirm": "Looks right",
  "onboarding.handle.reassigned":
    "Somebody already had that one. You got {tag}.",
  // Not "try again" — all 9,999 numbers behind that name are gone and repeating
  // the request cannot work. The only way out is a different name, so say so.
  "onboarding.handle.error.taken":
    "That name is full — every number behind it is taken. Pick another one.",
  "onboarding.handle.error.invalid":
    "Lowercase, numbers and _ only, between 2 and 32 characters.",
  "onboarding.handle.error.generic": "Couldn't save that. Try again.",

  "onboarding.profile.eyebrow": "Your face",
  "onboarding.profile.title": "Now the part people see",
  "onboarding.profile.description":
    "The handle is how they find you. This is how they see you.",
  "onboarding.profile.displayName": "Display name",
  "onboarding.profile.displayNamePlaceholder": "Whatever you go by",
  "onboarding.profile.avatar": "Avatar",
  "onboarding.profile.avatarUrl": "Avatar image URL",
  "onboarding.profile.avatarUrlPlaceholder": "https://… image URL",
  "onboarding.profile.avatarPreset": "Use this avatar",
  "onboarding.profile.avatarClear": "Clear",
  "onboarding.profile.error": "Couldn't save that. Try again.",

  "onboarding.landing.eyebrow": "Last thing",
  "onboarding.landing.title": "Nobody's here yet",
  "onboarding.landing.description":
    "Make a server and send the link, or paste one somebody sent you.",
  "onboarding.landing.createLabel": "Make a server",
  "onboarding.landing.createPlaceholder": "Name it something stupid",
  "onboarding.landing.createAction": "Create",
  "onboarding.landing.createHint":
    "Text and voice channels show up ready. Invite people whenever.",
  "onboarding.landing.joinLabel": "Or use an invite",
  "onboarding.landing.joinPlaceholder": "Invite code or link",
  "onboarding.landing.joinAction": "Go in",
  "onboarding.landing.createError": "Couldn't create that. Try again.",
  "onboarding.landing.joinError": "That invite doesn't work. Ask for another.",

  // One label for both skippable steps. "Skip" reads like abandoning something;
  // this is a choice to do it later, and both of these really can be.
  "onboarding.skip": "I'll do this later",
  "onboarding.continue": "Continue",
  "onboarding.saving": "Saving…",
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

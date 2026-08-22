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
  "nav.signUp": "Start a community",
  "nav.openApp": "Open the app",
  "nav.blog": "Release notes",

  // ------------------------------------------------------------------- blog
  // `blog.seo.*` is duplicated in `src/lib/blog-meta.ts` (the edge writes the
  // head before this catalogue exists) and `blog-meta.test.ts` pins the pair,
  // so the two cannot drift.
  "blog.seo.title": "Release notes — pqp",
  "blog.seo.description":
    "What changed in pqp and when. Each note says what started working, what still does not, and why.",
  "blog.hero.title": "Release notes",
  "blog.hero.lede":
    "What changed, on the day it changed. Written by the person who shipped it, including the parts that are not finished.",
  "blog.back": "All release notes",
  "blog.notFound.title": "There is no note at this address",
  "blog.notFound.body":
    "The link may be old, or the address may have a typo in it. The full list is one click away.",

  "landing.seo.title": "pqp — group chat you own",
  "landing.seo.description":
    "Chaotic group chat with communities, channels, and voice that just works. Open source — self-host or use pqp.gg.",
  // The Portuguese hero is a pun ("vem pra pqp") that does not survive
  // translation, so English carries the intent — an invitation — rather than
  // the joke. Both name the same three things the product actually has: voice,
  // text, screen share. There is no camera video; do not add one here.
  "landing.hero.title": "Come hang out at pqp.",
  "landing.hero.body":
    "Voice, chat and screen sharing for your people. Make a community, share the link. That's it.",

  "landing.trust.openSource": "Open source",
  "landing.trust.selfHostable": "Self-hostable",
  "landing.trust.meshVoice": "Mesh voice",
  "landing.trust.inviteCodes": "Invite codes",
  "landing.trust.yourKeys": "Your keys",

  "landing.pitch.title": "Tired of renting the room?",
  "landing.pitch.body":
    "Big chat apps rewrite the house rules, bury your communities, and treat your crew like inventory. pqp is the opposite: make a community, invite people, talk. Keep the keys if you want — or use ours and skip the ops.",

  "landing.how.title": "Three moves. Then you're loud.",
  "landing.how.body": "No onboarding maze. Create, invite, cause problems.",
  "landing.how.step1.title": "Make a community",
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
  // Camera video, custom emoji and slow mode do not exist at all. (Threads
  // ship now, but the landing copy below predates them — update it
  // deliberately, not from this comment.)
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
    "Search a whole community by word and land on the message, with what came before and after.",
  "landing.features.dms.title": "DMs and group chats",
  "landing.features.dms.body":
    "Message someone privately, or put up to 10 people in the same group.",
  "landing.features.structure.title": "Your community, your rules",
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
    "Spin up a community in under a minute. Invite the chaos later.",
  // The closing CTA and the share/invite copy point outward — "go to pqp" —
  // where the hero pointed inward ("come to pqp"). The contrast is deliberate.
  // The arrow is drawn in JSX and hidden from assistive tech, so it stays out
  // of the string a translator has to carry.
  "landing.cta.action": "Head to pqp",
  "landing.cta.beta": "On iPhone? Grab a spot in the iOS beta.",

  // ------------------------------------------------- communities (marketing)
  //
  // The directory itself is behind sign-in, so this section is the only place
  // on the open web that says the feature exists. It sells the ONE thing that
  // is different about it — you walk in, nobody approves you — rather than
  // listing what a community "can do", because a community can do exactly what
  // any other room here can do.
  "landing.communities.eyebrow": "Communities",
  "landing.communities.title": "Rooms you can just walk into",
  "landing.communities.body":
    "Not everything starts with an invite. The directory is full of rooms about one stupid thing each — pick one, tap join, you're in. Or make yours and let people find it.",
  "landing.communities.point1.title": "No invite, no queue",
  "landing.communities.point1.body":
    "One tap and you're inside. Nobody has to approve you first.",
  "landing.communities.point2.title": "Sorted the way people talk",
  "landing.communities.point2.body":
    "Games, music, football, humour — ten categories, no taxonomy lecture.",
  "landing.communities.point3.title": "Yours stays yours",
  "landing.communities.point3.body":
    "List it when you want to be found, unlist it when you don't. You still run the room.",
  "landing.communities.action": "Find your people",
  // ------------------------------------------------------- handles & profiles
  //
  // The Orkut-throwback surfaces: `pqp.gg/garanta` (where you claim an @) and
  // `pqp.gg/@you` (what you get for it). English exists so the pages are not
  // broken outside Brazil; pt-BR is the one that was written first and the one
  // that carries the joke. See `messages.pt-BR.ts`.
  "claim.seo.title": "Claim your @ on pqp",
  "claim.seo.description":
    "pqp.gg/@you — one name, first come, first served. Free, and yours.",
  "claim.eyebrow": "One name. Yours.",
  "claim.title": "Claim your @ on pqp",
  "claim.body":
    "Your page, your link, your people. Type a name and see if it is still free.",
  "claim.input.label": "The @ you want",
  "claim.input.placeholder": "yourname",
  "claim.checking": "Checking…",
  "claim.available": "{handle} is free. Take it.",
  "claim.taken": "{handle} is taken. Try another.",
  "claim.reserved": "That one is reserved.",
  "claim.blocked": "Pick another one.",
  "claim.tooShort": "At least 3 characters.",
  "claim.format": "Letters, numbers, and . _ - between them.",
  "claim.error": "Could not check that right now. Try again.",
  "claim.cta": "Claim {handle}",
  "claim.cta.signedIn": "Claim it",
  "claim.claiming": "Claiming…",
  "claim.claimed": "Done. Your link is {url}",
  "claim.rules":
    "One @ per account. You can change it once every 30 days, so pick well.",
  "claim.why.1.title": "A link you can say out loud",
  "claim.why.1.body":
    "Put it in your bio. It works from anywhere, signed in or not.",
  "claim.why.2.title": "People find you, not a number",
  "claim.why.2.body":
    "No more spelling out four digits. One name, and it is the one you chose.",
  "claim.why.3.title": "First come, first served",
  "claim.why.3.body":
    "There is exactly one of each. The good ones go early — that is how this works.",
  "claim.existing": "You already have one: {url}",

  "publicProfile.loading": "Loading…",
  "publicProfile.seo.title": "{name} (@{handle}) on pqp",
  "publicProfile.seo.description": "{name} is on pqp. Add them.",
  "publicProfile.communities": "Communities",
  // The Orkut sentence, and the one string on this page worth arguing about:
  // it is "member of N communities", not "N communities". The fact being shown
  // is belonging, not inventory.
  "publicProfile.achievements": "Achievements",
  "publicProfile.achievements.cacaBugs": "Found a real bug and told us",
  "publicProfile.communities.count": "member of {count} communities",
  "publicProfile.communities.count.one": "member of 1 community",
  "publicProfile.depoimentos": "{count} testimonials",
  "publicProfile.depoimentos.one": "1 testimonial",
  "publicProfile.depoimentos.title": "Testimonials",
  "publicProfile.depoimentos.more": "and {count} more",
  "publicProfile.memberSince": "on pqp since {date}",
  "publicProfile.cta.add": "Add me on pqp",
  "publicProfile.cta.open": "Open in pqp",
  "publicProfile.copy": "Copy link",
  "publicProfile.copied": "Copied",
  "publicProfile.footer": "pqp.gg — group chat you own",
  "publicProfile.footer.cta": "Claim your @",
  "publicProfile.free.title": "@{handle} is free.",
  "publicProfile.free.body":
    "Nobody has taken this one yet. It could be yours in about ten seconds.",
  "publicProfile.free.cta": "Claim @{handle}",
  "publicProfile.unavailable.title": "Could not load that profile",
  "publicProfile.unavailable.body":
    "Something went wrong on our end. Try again in a moment.",
  "publicProfile.retry": "Try again",

  "handle.claimed.notice": "Your link is {url} — copy it and go show off.",
  "handle.claim.failed": "Could not save that @: {reason}",
  "handle.add.sent": "Friend request sent to {name}.",
  "handle.add.accepted": "You and {name} are friends now.",
  "handle.add.failed": "Could not add that person.",
  "handle.join.done": "You're in {name}.",
  "handle.join.already": "You were already in {name}.",
  "handle.join.failed": "Could not join that community.",

  // ------------------------------------------------- public community pages
  "publicCommunity.seo.title": "{name} — a community on pqp",
  "publicCommunity.seo.description":
    "{name} is a community on pqp. Come in.",
  "publicCommunity.members": "{count} members",
  "publicCommunity.members.one": "1 member",
  "publicCommunity.membersLabel": "people in here",
  "publicCommunity.since": "here since {date}",
  "publicCommunity.cta.join": "Join the community",
  "publicCommunity.cta.open": "Open in pqp",
  "publicCommunity.copy": "Copy link",
  "publicCommunity.copied": "Copied",
  "publicCommunity.footer.cta": "Make your own community",
  "publicCommunity.missing.title": "This community is not here.",
  "publicCommunity.missing.body":
    "The link may be wrong, or the community may have been taken down. Have a look at the others.",
  "publicCommunity.missing.cta": "See what else is out there",
  "publicCommunity.unavailable.title": "Could not load that community",
  "publicCommunity.unavailable.body":
    "Something went wrong on our end. Try again in a moment.",
  "publicCommunity.retry": "Try again",
  "publicCommunity.whatIsPqp.title": "What is pqp?",
  "publicCommunity.whatIsPqp.body":
    "Voice, chat and screen sharing for your people. Free, open source, and yours to keep.",

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

  // ------------------------------------------------------------ legal pages
  // The prose of /terms, /privacy and /cookies is NOT here — it lives as whole
  // documents per language under `pages/legal/`, because a policy is edited and
  // reviewed as a document and because a Portuguese chat user should not
  // download three policies to open /app. See `pages/legal/document.tsx`.
  //
  // These two are the chrome the document does not own: the eyebrow and the
  // date line are printed by `components/marketing/legal-page.tsx`, which is
  // still hardcoded English. They are defined here so wiring them up is a
  // two-line change in that file rather than a translation job.
  "legal.eyebrow": "Legal",
  "legal.updated": "Last updated: {date}",

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

  // ------------------------------------------------------------- vs Discord
  // Scoreboard marketing page at /vs-discord. Claims must stay true — see
  // docs/superpowers/specs/2026-08-20-vs-discord-and-testflight-design.md.
  // Never put vendor region codes (Fly, gru) in end-user strings.
  "vsDiscord.seo.title": "pqp vs Discord (2026): an honest comparison",
  "vsDiscord.seo.description":
    "Screen share and camera in calls work on pqp. In Brazil, Discord’s screen share, video, and Go Live have been suspended since 17 Aug 2026 (Discord’s letter; no return date). Free, open source, open beta.",
  "vsDiscord.hero.tagline": "an honest comparison (2026)",
  "vsDiscord.hero.body":
    "Discord is excellent — we are not going to pretend otherwise. Since 17 August 2026, Go Live, video, and screen share have been suspended in Brazil by ANPD order, with no return date. Communities that lived on watch parties, study-with-screen, and RPG tables lost the main tool. pqp is open source, free, and in open beta. Here is the scoreboard — including where Discord still wins.",
  "vsDiscord.hero.disclaimer":
    "Product claim, not legal advice: Discord has said screen share, video, and Go Live are suspended in Brazil since 17 Aug 2026 under an ANPD order, with no return date in their letter.",
  "vsDiscord.featured.pqpDetail":
    "Screen share, and camera in calls — right from the browser, today.",
  "vsDiscord.featured.discordDetail":
    "Since 17 Aug 2026, by ANPD order — no return date announced.",
  "vsDiscord.table.title": "The full scoreboard",
  "vsDiscord.table.caption": "Feature scoreboard",
  "vsDiscord.table.col.feature": "Thing",
  "vsDiscord.table.col.pqp": "pqp",
  "vsDiscord.table.col.discord": "Discord",
  "vsDiscord.chip.works": "Works",
  "vsDiscord.chip.suspended": "Suspended",
  "vsDiscord.chip.yes": "Yes",
  "vsDiscord.chip.no": "No",
  "vsDiscord.chip.partial": "Partial",
  "vsDiscord.row.screen.label": "Screen share & video in Brazil",
  "vsDiscord.row.price.label": "Price",
  "vsDiscord.row.price.pqp": "Free",
  "vsDiscord.row.price.discord": "Free (paid extras via Nitro)",
  "vsDiscord.row.openSource.label": "Open source",
  "vsDiscord.row.openSource.pqp": "Yes",
  "vsDiscord.row.openSource.discord": "No",
  "vsDiscord.row.selfHost.label": "Run on your own server",
  "vsDiscord.row.selfHost.pqp": "Yes",
  "vsDiscord.row.selfHost.discord": "No",
  "vsDiscord.row.ageGate.label": "Age verification",
  "vsDiscord.row.ageGate.pqp": "Native, from day one",
  "vsDiscord.row.ageGate.discord": "Yes",
  "vsDiscord.row.apps.label": "Native apps (desktop / phone)",
  "vsDiscord.row.apps.pqp":
    "Desktop ships. iOS is in TestFlight beta — not a public App Store listing yet.",
  "vsDiscord.row.apps.discord": "Yes, and they are excellent",
  "vsDiscord.row.ecosystem.label": "Ecosystem (bots, integrations)",
  "vsDiscord.row.ecosystem.pqp": "Just getting started",
  "vsDiscord.row.ecosystem.discord": "Huge",
  "vsDiscord.row.maturity.label": "Maturity",
  "vsDiscord.row.maturity.pqp": "Open beta",
  "vsDiscord.row.maturity.discord": "A decade on the road",
  "vsDiscord.row.region.label": "Servers in Brazil",
  "vsDiscord.row.region.pqp": "Yes",
  "vsDiscord.row.region.discord": "Yes",
  "vsDiscord.closing.title": "Honest summary",
  "vsDiscord.closing.body":
    "If your community needs shared screens and you want something free and open, try pqp today — takes a minute, no card. If you need a mature ecosystem with bots and polished store apps, Discord is still unbeatable — when video comes back.",
  "vsDiscord.cta.create": "Create a room",
  "vsDiscord.cta.beta": "Join the iOS beta",
  "vsDiscord.cta.beta.hint":
    "Install via TestFlight, takes a minute and it's free.",
  "vsDiscord.cta.compare": "pqp vs Discord",
  "betaPage.seo.title": "iOS beta — pqp on iPhone",
  "betaPage.seo.description":
    "Early access to pqp on iPhone. Voice, screen share, and camera in the call, from your pocket. Spots via TestFlight, free and in open beta.",
  "betaPage.badge": "Early access · limited spots",
  "betaPage.title": "pqp on your iPhone, before everyone else",
  "betaPage.body":
    "While the App Store version isn't out yet, you get in through the front door: the iOS beta on TestFlight. Voice, screen share, and camera in the call, straight from your pocket.",
  "betaPage.cta": "Get the iOS beta",
  "betaPage.cta.sub": "Install via TestFlight, takes a minute. Free.",
  "betaPage.web": "or open it now in the browser",
  "betaPage.perks.title": "What you get",
  "betaPage.perk.share.title": "Screen and camera in the call",
  "betaPage.perk.share.body":
    "Share your screen and turn on the camera in a call, from your phone, no workarounds.",
  "betaPage.perk.early.title": "Before everyone else",
  "betaPage.perk.early.body":
    "You try the iPhone app before there's a public listing, and what you report shapes what ships.",
  "betaPage.perk.free.title": "Free and open",
  "betaPage.perk.free.body":
    "No charge, no card. Open source, servers in São Paulo.",
  "betaPage.how.title": "How to join",
  "betaPage.how.1": "Tap join the beta and it opens in TestFlight.",
  "betaPage.how.2": "Install pqp like any other app.",
  "betaPage.how.3": "Sign in and you're in.",
  "betaPage.honest":
    "It's a TestFlight beta, not an App Store listing. It's young, built by one person, so expect rough edges. If something breaks, we fix it fast.",

  // The questions people actually type into a search box after the 17 Aug 2026
  // suspension, answered in the page's voice. Same truth rules as the rows
  // above: product claims only, no legal advice, no return-date speculation,
  // and no promise about DRM'd streaming content. The edge middleware serves
  // these four pairs as FAQPage JSON-LD (src/lib/marketing-meta.ts) — the
  // suite pins the two copies together, so edit both or the tests fail.
  "vsDiscord.faq.title": "Quick questions",
  "vsDiscord.faq.why.q": "Why is Discord screen share suspended in Brazil?",
  "vsDiscord.faq.why.a":
    "Discord announced that screen share, video, and Go Live are suspended for users in Brazil since 17 August 2026, complying with a preventive order from the ANPD, Brazil's data-protection authority. That is Discord's own announcement — this page is a product comparison, not legal advice.",
  "vsDiscord.faq.when.q": "When does Discord screen share come back in Brazil?",
  "vsDiscord.faq.when.a":
    "No date has been announced. Discord's letter to its Brazilian community says they are working to restore the features, without saying when.",
  "vsDiscord.faq.how.q": "How can my group share a screen today?",
  "vsDiscord.faq.how.a":
    "Create a community on pqp.gg, send the invite link, and share your screen straight from the browser — the game, the code, the slides. Free, nothing to install; there's a desktop app too.",
  "vsDiscord.faq.catch.q": "Is pqp really free? What's the catch?",
  "vsDiscord.faq.catch.a":
    "Free and open source. Use the hosted service at pqp.gg, or run your own copy on your own machines — the code is public. It's an open beta: young, honest about it, and built in the open.",

  "footer.iosBeta": "Join the iOS beta",
  "footer.vsDiscord": "pqp vs Discord",
  "footer.tela": "Screen share in Brazil: what to use",

  // The pt-BR search landing at /tela, for "discord sem compartilhamento de
  // tela no brasil, o que usar agora". Portuguese is the page's first
  // language; these are the source strings it falls back to. Same truth rules
  // as /vs-discord: state the suspension as Discord announced it, no opinion
  // on the order, no mockery, no App Store claim, never "better than Discord",
  // and say out loud that pqp is ours. The FAQ pairs are duplicated as
  // FAQPage JSON-LD in src/lib/marketing-meta.ts, pinned by the suite.
  "tela.seo.title":
    "Discord screen share suspended in Brazil? What to use now | pqp",
  "tela.seo.description":
    "Discord screen share suspended in Brazil since 17 Aug? Here is what works today to share your screen with friends in the browser, nothing to download. An honest comparison, with pqp and other options.",
  "tela.hero.title":
    "Discord without screen share in Brazil? You can still share your screen today, in the browser.",
  "tela.hero.lede":
    "Since 17 August 2026, Discord's screen share, video and Go Live are suspended in Brazil under an ANPD order; voice and text keep working. This page is about what you can use right now. Keep the Discord server if you like, and share the screen somewhere else.",
  "tela.hero.disclosure":
    "Full disclosure: pqp is our product. The other options below are listed because they solve the same problem, and one of them may fit you better.",
  "tela.options.title": "What works today",
  "tela.options.goodFor": "Good for",
  "tela.options.limit": "Limit",
  "tela.options.ours": "ours",
  "tela.option.pqp.name": "pqp.gg",
  "tela.option.pqp.body":
    "Voice, text, screen share and camera, in the browser, nothing to download. Free, open source, servers in São Paulo. Open beta, built by one person.",
  "tela.option.pqp.good":
    "A small group of friends that wants a room that stays: channels, voice and a screen, with the link shared once.",
  "tela.option.pqp.limit":
    "Peer-to-peer voice holds up well to about 5 or 6 people per room; past that, quality drops. Bigger rooms are being tested. It is a beta: expect rough edges.",
  "tela.option.jitsi.name": "Jitsi Meet",
  "tela.option.jitsi.body":
    "Video calls in the browser with screen share, no account needed. Free and open source.",
  "tela.option.jitsi.good":
    "A one-off call: open a link, share the screen, done.",
  "tela.option.jitsi.limit":
    "It is a meeting, not a community chat: no channels, no history, and the room is empty when everybody leaves.",
  "tela.option.teamspeak.name": "TeamSpeak 6",
  "tela.option.teamspeak.body":
    "Voice servers with screen share inside a server. Desktop app.",
  "tela.option.teamspeak.good":
    "Groups that already run a TeamSpeak server and want a screen in it.",
  "tela.option.teamspeak.limit":
    "Needs the app and a server; 1-to-1 calls with screen share are still in alpha.",
  "tela.option.meet.name": "Google Meet",
  "tela.option.meet.body":
    "Screen share works, in the browser, with a Google account.",
  "tela.option.meet.good":
    "A quick call with people who all have a Google account already.",
  "tela.option.meet.limit":
    "The free plan has a time limit on group calls, and it is a meeting, not a place your group lives in.",
  "tela.options.asOf":
    "Status as of 21 August 2026, from each company's own public notes. If something changed, tell us: contato@pqp.gg.",
  "tela.how.title": "How to do it on pqp in one minute",
  "tela.how.1":
    "Create a room: sign up (free, no card) and create a community. You get a voice channel right away.",
  "tela.how.2":
    "Send the invite link to your people. Nobody downloads anything; it opens in the browser.",
  "tela.how.3":
    "Everybody joins the voice channel and whoever wants to shares the screen, or the camera. That is it.",
  "tela.faq.title": "Quick questions",
  "tela.faq.download.q": "Do I need to download anything?",
  "tela.faq.download.a":
    "No. pqp runs in the browser on desktop and on Android. There is a desktop app if you want one, and an iOS beta via TestFlight, but neither is required.",
  "tela.faq.vpn.q": "Do I need a VPN?",
  "tela.faq.vpn.a":
    "No. This is not a way around anything: pqp is a different app with its own servers in Brazil, and screen share is a feature it has. Nothing here touches Discord.",
  "tela.faq.people.q": "How many people can share a screen in one room?",
  "tela.faq.people.a":
    "Voice is peer-to-peer, which is great for a small group: 5 or 6 people per room works well. Beyond that, quality drops. Bigger rooms are being tested and are not the default yet.",
  "tela.faq.free.q": "Is it free?",
  "tela.faq.free.a":
    "Yes. pqp is open source under the AGPL (github.com/rafaelcg/pqp). Use the hosted service at pqp.gg for free, or run your own copy.",
  "tela.faq.mobile.q": "Does it work on a phone?",
  "tela.faq.mobile.a":
    "On Android, the browser works. On iPhone there is a beta via TestFlight at pqp.gg/beta; it is not on the App Store yet.",
  "tela.faq.data.q": "What do you keep about me?",
  "tela.faq.data.a":
    "Less than you would expect, and all of it is listed in plain language in the privacy policy at pqp.gg/privacy. No ad trackers and no analytics cookies.",
  "tela.faq.data.link": "Read the privacy policy",
  "tela.cta.title": "Want to try it now?",
  "tela.cta.body":
    "A room takes a minute to make and the link is all your friends need.",
  "tela.cta.create": "Create a free room",
  "tela.cta.compare": "See the full pqp vs Discord comparison",

  // A phone gets pointed at the browser, never at a .dmg — and never at a store
  // listing, which does not exist. It is installable from the browser menu
  // (docs/PWA.md), which is the honest version of "get the app". When
  // VITE_TESTFLIGHT_URL is set, HeroDownload offers that instead.
  "download.mobile.beta": "On iPhone? Grab a spot in the iOS beta on TestFlight.",

  // ------------------------------------------------------- app bootstrap shell
  "app.seo.title": "App — pqp",
  "app.seo.description": "Open pqp — communities, text, and voice.",
  "app.loading": "Loading…",
  "app.loading.signingIn": "Signing in…",
  "app.loading.servers": "Loading communities…",

  "signedOut.title": "Sign in to talk.",
  "signedOut.body": "Create an account or sign in to open your communities.",
  "signedOut.createAccount": "Create account",

  "bootstrapError.title": "Can't reach the API",
  "bootstrapError.fallback": "Failed to load communities from the API",
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
  "empty.noServers.title": "No communities yet",
  "empty.noServers.body": "Make a community or join with an invite code.",
  "empty.pickChannel.title": "Pick a channel",
  "empty.pickChannel.body": "Open the sidebar and choose text or voice.",
  "empty.noConversation.title": "No conversation open",
  "empty.noConversation.body":
    "Pick someone from the list, or message anyone by handle.",
  "empty.createServer": "Create community",
  "empty.joinInvite": "Join invite",
  "empty.newMessage": "New message",
  "empty.openNav": "Open navigation",

  "sso.title": "Available to you",
  "sso.body.one":
    "Your verified email lets you join this community without an invite.",
  "sso.body.many":
    "Your verified email lets you join these communities without an invite.",
  "sso.join": "Join",
  "sso.joining": "Joining…",
  "sso.joinFailed": "Could not join {name}",

  // ----------------------------------------------------------- communities
  //
  // The whole surface is dark unless the server answers `enabled` on
  // `/api/communities/config`, so none of these strings render on a
  // deployment that has not turned the directory on.
  //
  // The English here is the fallback and the source of truth for the keys; the
  // register that matters is the pt-BR in messages.pt-BR.ts, because this is a
  // feature built for Brazil and the copy is the product. Category labels live
  // beside the slugs on purpose — a new slug cannot ship without a label.
  "communities.title": "Communities",
  "communities.subtitle": "Public rooms anyone can join. Find your people.",
  // The directory took over the whole viewport, so it now has a headline
  // rather than a title bar — and a headline has to earn the space. It says
  // what the reader gets to do, not what the screen is called.
  "communities.hero.title": "Find your people",
  "communities.hero.body":
    "Open rooms you can walk straight into — no invite, nobody to approve you. Pick a category, or search for the joke you already have in mind.",
  "communities.close": "Close the directory",
  "communities.search": "Search communities",
  "communities.searchPlaceholder": "Search by name…",
  "communities.category.all": "All",
  "communities.category.games": "Games",
  "communities.category.musica": "Music",
  "communities.category.futebol": "Football",
  "communities.category.estudos": "Study",
  "communities.category.anime": "Anime",
  "communities.category.tech": "Tech",
  "communities.category.humor": "Humour",
  "communities.category.series-filmes": "Series & film",
  "communities.category.corre": "Hustle",
  "communities.category.geral": "General",
  // The language segment. The two codes are printed as codes on purpose —
  // "Portuguese"/"English" spelled out is twice the width for a control that
  // sits at the end of a filter row, and PT/EN is what every other product this
  // audience uses prints there.
  "communities.language.label": "Language",
  "communities.language.pt": "PT",
  "communities.language.en": "EN",
  "communities.language.all": "All",
  "communities.settings.language": "Language",
  "communities.members": "{count} members",
  "communities.members.one": "1 member",
  "communities.join": "Join",
  "communities.joining": "Joining…",
  "communities.open": "Open",
  "communities.joinFailed": "Could not join {name}",
  "communities.loading": "Loading…",
  "communities.loadMore": "Show more",
  "communities.empty.title": "Nothing here yet",
  "communities.empty.body":
    "No community matches that. Try another category, or make one yourself.",
  "communities.empty.searchHint":
    "Brand-new communities only show up in search until somebody else joins.",
  "communities.failed": "Could not load communities.",
  "communities.retry": "Try again",
  "communities.joinedBadge": "You're in",
  // The way out of an empty grid, and a first-class destination in its own
  // right rather than a consolation prize — a directory whose only answer to
  // "there is nothing for me here" is a shrug teaches people not to come back.
  "communities.create.title": "Make your own",
  "communities.create.body":
    "Nothing here fits? Start a community, name it something stupid, and send the link.",
  "communities.create.action": "Create a community",
  "communities.create.placeholder": "Community name",
  "communities.share": "Copy the public link",
  "communities.shared": "Link copied",
  "communities.report": "Report this community",
  "communities.reportTitle": "Report community",
  "communities.reportBody":
    "This goes to the people who run pqp — not to this community's owner. Tell us what is wrong with it.",

  // The owner's opt-in. Every line here is doing legal work as much as
  // product work: somebody flipping this switch has to understand that they
  // are publishing the room, not decorating it.
  "communities.settings.title": "Community listing",
  "communities.settings.explainer":
    "Listing this community puts it in the public directory. Anyone with a pqp account can find it by name or category, see how many members it has, and join with one tap — no invite, no approval from you.",
  "communities.settings.explainerModeration":
    "You still run the room: kicks, bans and channel privacy all work the same. But reports about a listed community go to the people who run pqp, who can remove the listing.",
  "communities.settings.toggle": "List this community publicly",
  "communities.settings.tagline": "One line about it",
  "communities.settings.taglinePlaceholder": "What is this place?",
  "communities.settings.taglineHint": "{count} characters left",
  "communities.settings.category": "Category",
  // The public address. Worded as a URL rather than as a "slug", because the
  // owner is choosing the thing they will paste into a group chat and nobody
  // outside this repo has ever called that a slug.
  "communities.settings.slug": "Public address",
  "communities.settings.slugHint":
    "Made from the name when you list it. Change it here — old links stop working.",
  "communities.settings.slugPlaceholder": "your-community",
  "communities.settings.slugTaken":
    "That address is taken. Try another one.",
  "communities.settings.slugUnderivable":
    "This name cannot become a web address. Type one below.",
  "communities.settings.save": "Save",
  "communities.settings.saving": "Saving…",
  "communities.settings.saved": "Listing updated.",
  "communities.settings.failed": "Could not update the listing.",
  "communities.settings.suspended":
    "This listing was removed by the people who run pqp. The community itself is untouched and everyone in it can still use it — it is only hidden from the directory.",
  // The member's own badge switch, on the community's context menu. Worded as
  // the ACTION each state offers rather than as a state ("Shown on profile"),
  // because a context-menu row that describes a state reads as a checkbox and
  // this one is a button.
  "communities.showOnProfile": "Show on my profile",
  "communities.hideFromProfile": "Hide from my profile",

  // -------------------------------------------------------------- depoimentos
  // Orkut's testimonials. THE COPY IS PART OF THE FEATURE: this is nostalgia,
  // and it has to sound like somebody wrote it rather than like a product
  // shipped it. The Portuguese is the source of truth here — pt-BR is where
  // "depoimento" is a word people already have feelings about — and English
  // keeps the loan word rather than translating it to "testimonial", which is
  // a word for an invoice. See client/src/lib/i18n/messages.pt-BR.ts.
  "depoimentos.section": "Depoimentos",
  "depoimentos.write": "Write a depoimento",
  "depoimentos.written": "Sent to {name}. They decide whether to show it.",
  "depoimentos.writeFailed": "Couldn't send it — try again.",
  "depoimentos.remove": "Remove {name}'s depoimento",
  "depoimentos.communities": "Communities",
  "depoimentos.communities.more": "+{count}",
  // ---- the compose sheet, and the DM fork ----
  // `publicNotice` is the most important sentence in this feature. It states
  // the consequence in the order it happens — they read it, they decide, and
  // then it is on their profile for anyone who can see it.
  "depoimentos.compose.title": "A depoimento for {name}",
  "depoimentos.compose.placeholder":
    "Say the thing you'd say out loud about them…",
  "depoimentos.compose.publicNotice":
    "This goes public on their profile if they accept it. Want to send it privately instead?",
  "depoimentos.compose.send": "Send",
  "depoimentos.compose.sendAsDm": "Send as a DM",
  "depoimentos.compose.cancel": "Cancel",
  // ---- the queue ----
  "depoimentos.pending": "Depoimentos waiting on you",
  "depoimentos.pending.hint":
    "Only you can see these. Publish one and it goes on your profile; refuse it and it's gone — they're never told either way.",
  "depoimentos.approve": "Publish",
  "depoimentos.reject": "Refuse",
  "depoimentos.approve.confirm.title": "Publish this on your profile?",
  "depoimentos.approve.confirm.body":
    "Everyone who can see your profile will read it, with {name}'s name on it. You can take it down whenever you like.",
  "depoimentos.approve.confirm.publish": "Publish it",
  "depoimentos.approve.confirm.wait": "Not yet",
  "depoimentos.published": "It's on your profile.",
  // The live nudge. Deliberately vague about direction — the frame is
  // content-free and fires for both halves, and the lists it refreshed already
  // say which one happened.
  "depoimentos.nudge": "Something changed in your depoimentos.",

  // ------------------------------------------------------- connection status
  "connection.reconnecting": "Connection lost — reconnecting…",
  "connection.unauthorized": "Session expired — reconnecting…",
  "connection.dismiss": "Dismiss",
  "connection.authFailed": "Realtime authentication failed — sign in again",
  "connection.wsUrlFailed":
    "Realtime connection failed — check the WebSocket URL",

  // ---------------------------------------------------------------- user status
  // Four states everybody can see, plus the one only its owner sees. "Invisible"
  // and "Offline" are the same pip on purpose — that is the entire point of the
  // feature — so only the labels tell them apart, and only for the account
  // itself.
  "status.online": "Online",
  "status.idle": "Idle",
  "status.dnd": "Do not disturb",
  "status.offline": "Offline",
  "status.invisible": "Invisible",
  "status.change": "Change your status",
  // Says what invisibility does *and* what it does not, because a privacy
  // control people mis-read is a privacy control that fails. Voice is the one
  // deliberate exception: a call you joined is a room you can be heard in.
  "status.invisibleHint":
    "You'll show as offline to everyone, and you won't appear in channel or typing indicators. Voice channels you join still show you — people can hear you there.",
  "status.dndHint": "You stay visible; this device stops popping notifications.",
  "status.saveFailed": "Could not change your status — try again",

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
  "onboarding.profile.avatarUpload": "Upload a photo",
  "onboarding.profile.avatarUploading": "Uploading…",
  "onboarding.profile.error": "Couldn't save that. Try again.",

  "onboarding.landing.eyebrow": "Last thing",
  "onboarding.landing.title": "Nobody's here yet",
  "onboarding.landing.description":
    "Make a community and send the link, or paste one somebody sent you.",
  "onboarding.landing.createLabel": "Make a community",
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

  // ------------------------------------------------------------- first run
  // The three rows the hub offers a new account, and the only nudge in the
  // product about any of them. The wizard is a modal that ends in two clicks and
  // every one of these is skippable from inside it, so finishing it says nothing
  // about whether somebody has a server, a friend, or a face.
  //
  // Each row is written as the thing you get, not the chore you do — "find your
  // people", not "add a friend" — and each has a real button next to it. The
  // done state is a tick and a shrug, never a congratulation: this product does
  // not applaud people for filling in a form.
  "firstRun.title": "Three things and this place works",
  "firstRun.dismiss": "Hide this",
  "firstRun.done": "Done",
  "firstRun.server.title": "Get into a community",
  "firstRun.server.body": "Make one for your people, or paste an invite you were sent.",
  "firstRun.server.create": "Make a community",
  "firstRun.server.join": "Use an invite",
  // Prints the reader's own handle, because "add someone by their handle" is
  // useless advice until you know that you have one and what it is. The wizard
  // showed it once, on a screen they are unlikely to ever see again.
  "firstRun.friend.title": "Find your people",
  "firstRun.friend.body":
    "Add someone by their handle. Yours is {tag} — hand it out.",
  "firstRun.friend.action": "Add a friend",
  "firstRun.avatar.title": "Put a face on it",
  "firstRun.avatar.body": "A letter in a box works. A photo works better.",
  "firstRun.avatar.action": "Pick an avatar",

  // ------------------------------------------------------- invite arrival
  // Shown once, on the transcript, the first time this device opens a server
  // the account has just joined. Without it, an invited stranger's first screen
  // is "Start the thread" over a markdown cheatsheet — the same thing the
  // server's owner sees in a channel nobody has used, and nothing on it says
  // where they are or what to do.
  //
  // The channel name arrives with no `#`; the component draws that, so pt-BR
  // cannot accidentally drop it.
  "arrival.title": "You're in {server}",
  "arrival.body": "Say oi in #{channel}. That's the whole trick — nobody knows you're here until you say something.",
  "arrival.bodyNoChannel": "Pick a channel on the left and say something. Nobody knows you're here until you do.",
  "arrival.dismiss": "Got it",

  // ------------------------------------------------------------ invite panel
  // Both halves of one dialog: handing out a link, and walking in with one.
  //
  // These were hardcoded English until now, which made the *join* half the one
  // untranslated screen on the newcomer path — a Brazilian who clicks a friend's
  // link met an English form at the single highest-stakes moment the product
  // has. Arriving from a link no longer stops here at all (the app joins and
  // opens the channel), so the join half is now what a *pasted* code and a
  // failed auto-join get.
  "invite.create.eyebrow": "Invite people",
  "invite.create.description":
    "Anyone with the link can join until it expires or you revoke it.",
  "invite.create.serverFallback": "Community",
  "invite.create.notAllowed": "Only owners and admins can make invites.",
  "invite.create.activeTitle": "Live invites",
  "invite.create.loading": "Loading invites…",
  "invite.create.none": "No invites yet. Make one to share this community.",
  "invite.create.action": "Make an invite link",
  "invite.create.creating": "Making…",
  "invite.create.copyLink": "Copy invite link for code {code}",
  "invite.create.share": "Share invite link for code {code}",
  "invite.create.copyCode": "Copy invite code {code}",
  "invite.create.revoke": "Revoke invite {code}",
  "invite.create.copied": "Copied",
  "invite.create.copyFailed":
    "Clipboard is blocked — select the link and copy it by hand.",
  "invite.create.failed": "Couldn't make an invite.",
  "invite.create.revokeFailed": "Couldn't revoke that.",
  "invite.create.loadFailed": "Couldn't load the invites.",
  "invite.close": "Close",
  "invite.join.eyebrow": "Join a community",
  "invite.join.title": "Invite code",
  "invite.join.description": "Paste an invite link, or type the code you were given.",
  "invite.join.label": "Invite code",
  "invite.join.placeholder": "Invite code or link",
  "invite.join.preview": "Joins {name}",
  "invite.join.action": "Go in",
  "invite.join.joining": "Going in…",
  "invite.join.cancel": "Cancel",
  "invite.join.failed": "That invite doesn't work. Ask for another.",
  // Expiry and use counters, on the create side.
  "invite.expiry.never": "Never expires",
  "invite.expiry.expired": "Expired",
  "invite.expiry.hours": "Expires in {count}h",
  "invite.expiry.days": "Expires in {count}d",
  "invite.uses.unlimited": "{count} uses",
  "invite.uses.capped": "{used}/{max} uses",

  // ------------------------------------------------------------------- voice
  // Labels and states, so the bar is clarity rather than voice. Three different
  // things are deliberately three different words and must stay that way in
  // every language: `tile.muted` is *your own* microphone off, `tile.deafened`
  // is *all* incoming audio off, and `tile.silenced` is one peer turned down to
  // zero for you alone. Collapsing any two of them into one word makes a tile
  // that cannot be read.
  "voice.channelFallback": "Voice",
  "voice.live": "Live",
  // The mesh ceiling is a fact, not a suggestion — the landing page states the
  // same limit (5 to 8 per channel) and the two must agree. A translation that
  // turns this into advice is wrong.
  "voice.meshWarning":
    "Mesh limit approaching — configure an SFU for larger calls.",
  "voice.idle.body": "Join voice to talk. Chat stays available beside you.",
  "voice.join": "Join Voice",
  "voice.connectingTo": "Connecting to {channel}…",
  "voice.cancel": "Cancel",
  "voice.alone": "You're the only one here so far.",

  "voice.tile.you": "(you)",
  "voice.tile.presenting": "Presenting",
  "voice.tile.deafened": "Deafened",
  "voice.tile.muted": "Muted",
  "voice.tile.mutedTitle": "Microphone muted",
  "voice.tile.silenced": "Silenced",
  "voice.tile.connecting": "Connecting",
  "voice.tile.disconnected": "Disconnected",
  "voice.tile.retry": "Retry",
  "voice.tile.mutePeer": "Mute {name}",
  "voice.tile.unmutePeer": "Unmute {name}",
  "voice.tile.volumeFor": "Volume for {name}",
  "voice.tile.volumePercent": "{percent} percent",

  "voice.control.mute": "Mute microphone",
  "voice.control.unmute": "Unmute microphone",
  "voice.control.deafen": "Deafen",
  "voice.control.undeafen": "Undeafen",
  "voice.control.share": "Share your screen",
  "voice.control.stopShare": "Stop sharing your screen",
  "voice.control.shareUnavailable":
    "Share your screen (unavailable on this device)",
  "voice.control.shareTaken": "Someone else is already sharing their screen",
  "voice.control.leave": "Leave",

  "voice.bar.connected": "Voice connected",
  "voice.bar.connecting": "Connecting…",
  "voice.bar.person": "{count} person",
  "voice.bar.people": "{count} people",
  "voice.bar.leave": "Disconnect from voice",
  "voice.tile.live": "Live",
  "voice.tile.holdToTalk": "Hold to talk",
  "voice.ptt.hold": "Hold to talk",
  "voice.ptt.transmitting": "Transmitting",
  "voice.ptt.blocked": "Muted — push-to-talk is off",
  "voice.ptt.hintKey": "Hold {key} or the button above.",
  "voice.ptt.hintButton": "Hold the button above to talk.",
  "voice.ptt.unfocused":
    "This window isn't focused — the key won't reach it. Click here first, or use the button.",
  "voice.bar.pttLive": "Live",
  "voice.bar.pttIdle": "PTT",
  "voice.bar.open": "Open voice channel {name}",

  "voice.share.someone": "Someone",
  "voice.share.youPresenting": "You are presenting",
  "voice.share.peerPresenting": "{name} is presenting",
  "voice.share.stop": "Stop sharing",
  "voice.share.fullscreen": "View fullscreen",
  "voice.share.exitFullscreen": "Exit fullscreen",
  "voice.share.waiting": "Connecting to presenter's screen…",
  // Most shares carry no sound, and the presenter is the last person to find
  // out: their own machine is playing the film, so the silence only exists on
  // everyone else's side. Said once, quietly, right where they can act on it.
  "voice.share.noAudio":
    "Sharing without sound. To send the audio too, share a Chrome tab and tick the share-tab-audio box.",
  /** The same fact, short enough for a status line that truncates. */
  "voice.share.noAudioShort": "no sound",
  // Shown on the press that opens the picker, because the tick box is inside
  // that dialog and the dialog does not say what it is for.
  // ------------------------------------------------------------ call rating
  // Asked once after a call worth rating, never more than once every six
  // hours. The two end labels carry the scale, because a bare 1-to-5 does not
  // say which end is good.
  "call.rating.ask": "How was that call?",
  "call.rating.score": "Rate {score} out of 5",
  "call.rating.low": "Unusable",
  "call.rating.high": "Perfect",
  "call.rating.notePlaceholder": "What went wrong? (optional)",
  "call.rating.send": "Send",
  "call.rating.dismiss": "Close",
  "call.rating.thanks": "Thanks. That helps.",

  "voice.share.tickAudio":
    "Pick a Chrome tab and tick \u201cAlso share tab audio\u201d to send the sound too.",
  // A refused fullscreen used to be swallowed, which is how "I clicked it and
  // nothing happened" became a bug report nobody could act on. Quiet helper
  // text, not an alert — the call is still fine, only the frame did not grow.
  "voice.share.fullscreenBlocked": "The browser wouldn't open fullscreen.",

  // One wording for "this browser cannot capture a screen", read by the control
  // that greys itself out (`components/voice/capabilities.ts`) and by the error
  // path in `hooks/use-voice.ts`. One key is what stops the two from drifting.
  "voice.screenShareUnsupported":
    "Screen sharing isn't supported by this browser.",
  "voice.screenShareInsecure":
    "Screen sharing needs a secure (HTTPS) connection.",

  "voice.error.shareTaken": "Someone else is already sharing their screen.",
  "voice.error.channelFull": "This voice channel is full (max {limit}).",
  "voice.error.micFailed": "Failed to access microphone",
  "voice.error.micBlocked":
    "Microphone access was blocked. Allow it in your browser settings, then rejoin.",
  "voice.error.shareFailed": "Failed to start screen share",
  "voice.error.shareBlocked": "Screen share was blocked or cancelled.",
  "voice.error.noVideoTrack": "No video track from screen capture",
  "voice.error.transportUnsupported":
    "This call runs on a voice server this app build cannot use, so you have not joined it. Nobody in the call can hear you.",
  "voice.error.transportUnreachable":
    "Could not reach the voice server, so you have not joined this call. Check your network and try again.",

  // --- conversation calls ---
  "voice.error.cameraFailed": "Failed to access camera",
  "voice.error.cameraBlocked":
    "Camera access was blocked. Allow it in your browser settings and try again.",
  "call.incoming.title": "Incoming call",
  "call.incoming.groupTitle": "Incoming group call",
  "call.incoming.accept": "Accept",
  "call.incoming.decline": "Decline",
  "call.incoming.ignore": "Ignore",
  "call.panel.start": "Start call",
  "call.panel.join": "Join call",
  "call.panel.leave": "Leave",
  "call.panel.inCall": "{count} in call",
  "call.panel.calling": "Calling…",
  "call.panel.connecting": "Connecting…",
  "call.panel.declined": "{name} declined",
  "call.panel.cameraOn": "Turn camera off",
  "call.panel.cameraOff": "Turn camera on",
  "call.panel.mute": "Mute",
  "call.panel.unmute": "Unmute",
  "call.startVoice": "Start voice call",
  "call.startVideo": "Start video call",
  // The header's join affordance while a call is already live here.
  "call.header.joinCount": "Join call · {count}",
  "call.stage.collapse": "Collapse call",
  "call.stage.expand": "Expand call",
  "call.stage.duration": "Call duration",
  "call.stage.selfPreview": "Your camera preview",

  // ------------------------------------------------------------ channel meta
  // The channel image is a URL, not an upload — rendered to everyone in the
  // server, so it is restricted to https rather than accepting whatever a
  // pasted link happens to be.
  "channel.meta.image.error.httpsOnly":
    "Image links need to start with https://.",
  "channel.meta.image.error.invalid": "That doesn't look like a URL.",
  "channel.meta.error.generic": "Couldn't save that. Try again.",

  // ----------------------------------------------------------------- friends
  // The home view when nothing is selected: who is around, and the requests
  // waiting on you. "Pending" covers both directions; the section headings
  // inside it tell them apart.
  "friends.title": "Friends",
  "friends.tab.online": "Online",
  "friends.tab.all": "All",
  "friends.tab.pending": "Pending",
  "friends.addFriend": "Add friend",
  "friends.addFriend.hint":
    "Handles are exact — ask for the name#0000 and type it here.",
  "friends.addFriend.label": "Add a friend by handle",
  "friends.requestSent": "Request sent to {name}.",
  "friends.requestAccepted": "You and {name} are now friends.",
  "friends.requestFailed": "Couldn't send that request.",
  "friends.incoming": "Incoming — waiting on you",
  "friends.outgoing": "Sent — waiting on them",
  "friends.accept": "Accept",
  "friends.decline": "Decline",
  "friends.cancelRequest": "Cancel request",
  "friends.remove": "Remove friend",
  "friends.message": "Message",
  "friends.empty.online": "Nobody's around right now.",
  "friends.empty.all.title": "No friends here yet",
  "friends.empty.all.body":
    "Add someone by their handle and they'll show up here — with a dot that says whether they're around.",
  "friends.empty.pending": "No pending requests. Quiet is fine.",
  "friends.loadFailed": "Couldn't load your friends — try again.",
  "friends.retry": "Try again",
  "friends.onlineCount": "{count} online",
  "friends.pendingBadge": "{count} pending",
  // The ✕ on a friend row is small and unlabelled, and unfriending is silent —
  // so the confirmation states the consequence rather than asking "are you
  // sure?". Declining a request has no equivalent, on purpose: nothing is lost.
  "friends.remove.confirm.title": "Remove {name} from your friends?",
  "friends.remove.confirm.body":
    "They won't be told. Either of you can ask again later.",
  "friends.remove.keep": "Keep them",
  // What a live `friend-activity` frame says when this view is already open.
  // Never names the other person: the frame carries no name, and the row that
  // just appeared already does.
  "friends.nudge.request": "Someone sent you a friend request.",
  "friends.nudge.accepted": "Your friend request was accepted.",

  // ----------------------------------------------------------------- profile
  // The card that opens on a left-click of somebody's avatar or name, wherever
  // they are drawn. It is the app's only one-click route to "add friend", so
  // its primary button is deliberately the widest thing on it.
  "profile.cardLabel": "{name}'s profile",
  "profile.addFriend": "Add friend",
  "profile.acceptRequest": "Accept request",
  "profile.cancelRequest": "Cancel request",
  "profile.cancelRequest.confirm":
    "Take back your request to {name}? They won't be told either way.",
  "profile.keep": "Keep waiting",
  "profile.friends": "Friends",
  "profile.removeFriend": "Remove friend",
  "profile.removeFriend.confirm":
    "Remove {name} from your friends? They won't be told.",
  "profile.unblock": "Unblock",
  "profile.block": "Block",
  "profile.block.confirm":
    "Block {name}? This ends the friendship and hides their messages.",
  "profile.report": "Report",
  "profile.more": "More",
  "profile.isYou": "This is you.",
  "profile.loading": "Loading",
  "profile.friendsSince": "Friends since {date}",
  // ---- the enforcement ladder, on the card, for a moderator only ----
  // Wording matches the members panel's, because they are the same three
  // actions and a moderator should not have to learn two vocabularies for one
  // ladder. "Time out" before the two red ones: the order IS the ladder.
  "profile.mod.timeout": "Time out",
  "profile.mod.endTimeout": "End timeout",
  "profile.mod.kick": "Remove from community",
  "profile.mod.ban": "Ban from community",
  "profile.mod.cancel": "Cancel",
  "profile.mod.reason": "Reason",
  "profile.mod.reason.placeholder": "Reason (optional)",
  "profile.mod.timeout.title": "Time out {name}",
  "profile.mod.timeout.duration": "How long",
  "profile.mod.timeout.body":
    "They can still read. They can't post, react or join voice in this community until it ends.",
  "profile.mod.timeout.apply": "Time them out",
  "profile.mod.duration.minutes": "{count} min",
  "profile.mod.duration.hours": "{count} h",
  "profile.mod.duration.days": "{count} d",
  "profile.mod.kick.title": "Remove {name} from this community?",
  "profile.mod.kick.body":
    "They lose access now but can rejoin with any invite.",
  "profile.mod.ban.title": "Ban {name} from this community?",
  "profile.mod.ban.body":
    "They lose access and can't rejoin. The reason is kept on the ban list.",
  "profile.mod.timeoutEnded": "{name} can speak again.",
  "profile.mod.kicked": "{name} was removed from the community.",
  "profile.mod.banned": "{name} was banned.",
  "profile.open": "Open {name}'s profile",
  "profile.viewProfile": "View profile",

  // ------------------------------------------------------------- member list
  // The always-there sidebar down the right of a server channel — who is here,
  // grouped by rank and then by presence. Headings carry their own count
  // because "Online" without a number is the one thing every reader wants to
  // know and cannot see from a scrollbar.
  "memberList.title": "Members",
  "memberList.toggle": "Member list",
  "memberList.close": "Hide the member list",
  // One heading shape for every section, so a custom role later needs a label
  // and nothing else. The dash is an em dash, matching Discord and Stoat.
  "memberList.sectionHeading": "{label} — {count}",
  "memberList.owner": "Owner",
  "memberList.admins": "Admins",
  "memberList.online": "Online",
  "memberList.offline": "Offline",
  // A group conversation's people: participants, not members — nobody is a
  // member of a DM and nobody moderates one.
  "memberList.participants": "Participants",
  "memberList.inVoice": "In voice — {channel}",
  "memberList.mention": "Mention",
  // The door into the moderation panel. Kick, ban and timeout deliberately do
  // not live in this sidebar — see the note in member-sidebar.tsx.
  "memberList.manage": "Manage members…",
  "memberList.loading": "Loading the list…",
  "memberList.loadFailed": "Couldn't load the member list.",
  "memberList.empty": "Nobody here yet.",
  "memberList.showMore": "Show {count} more",

  // The quick-reaction strip across the top of a message's context menu. One
  // row of emoji, never a column of menu items.
  "reactions.quick": "Quick reactions",
  "reactions.more": "More reactions",

  // ----------------------------------------------------------------- threads
  // A reply-chain that becomes its own scoped conversation off a message.
  // pt-BR keeps the English word "thread" — it is what BR gamers actually say
  // (see the note at the top of messages.pt-BR.ts about loanwords); "tópico"
  // reads as a web forum from 2005.
  "thread.start": "Start thread",
  "thread.open": "Open thread",
  "thread.title": "Thread",
  "thread.close": "Close thread",
  "thread.archived": "Archived",
  "thread.archivedHint":
    "Quiet for {days}+ days — replying wakes it back up.",
  "thread.replies.one": "{count} reply",
  "thread.replies.many": "{count} replies",
  "thread.noReplies": "No replies yet",
  "thread.chip.aria": "Open thread {name}, {replies}",
  "thread.originDeleted": "The original message was deleted",
  "thread.placeholder": "Reply in thread",
  "thread.loading": "Loading thread…",
  "thread.error.start": "Couldn't start the thread. Try again.",

  // ---------------------------------------------------------------- settings
  // The whole settings surface, section by section. It was hardcoded English
  // until the redesign split it into sections — which is also what made the
  // gap obvious, since a section heading nobody can read is a door nobody
  // opens.
  "settings.title": "Settings",
  "settings.eyebrow": "Your account",
  "settings.nav.label": "Settings sections",
  "settings.cancel": "Cancel",
  "settings.save": "Save",
  "settings.saving": "Saving…",
  "settings.saveFailed": "Failed to save",

  "settings.section.profile": "Profile",
  "settings.section.voice": "Voice & Audio",
  "settings.section.notifications": "Notifications",
  "settings.section.appearance": "Appearance & Language",
  "settings.section.privacy": "Privacy",
  "settings.section.data": "Your data",
  "settings.section.feedback": "Feedback",
  "settings.feedback.description": "Bugs, ideas, anything on your mind",
  "settings.feedback.intro":
    "Found a bug? Tell us — a confirmed catch earns the 🐛 caça-bugs badge on your public profile. Ideas and gripes welcome too.",
  "settings.feedback.kind.label": "What is it?",
  "settings.feedback.kind.bug": "Bug",
  "settings.feedback.kind.idea": "Idea",
  "settings.feedback.kind.other": "Other",
  "settings.feedback.placeholder":
    "What happened, and where? The more detail, the faster the hunt.",
  "settings.feedback.send": "Send it",
  "settings.feedback.done":
    "Got it. If the bug checks out, the badge is yours. 🐛",
  "settings.feedback.again": "Send another",
  "settings.feedback.error": "Sending failed. Try again.",
  "userMenu.feedback": "Send feedback",

  // -- profile
  "settings.profile.description": "How you show up to everybody else.",
  "settings.profile.handle": "Your handle",
  "settings.profile.avatar": "Avatar",
  "settings.profile.avatar.urlPlaceholder": "https://… image URL",
  "settings.profile.avatar.urlLabel": "Avatar image URL",
  "settings.profile.avatar.preset": "Use preset avatar",
  "settings.profile.avatar.clear": "Clear",
  "settings.profile.avatar.upload": "Upload a photo",
  "settings.profile.avatar.uploading": "Uploading…",
  // The banner. Its hint names the one page it appears on, because that is the
  // only place it is drawn and an owner who cannot find their own change will
  // reasonably conclude the upload failed.
  "settings.profile.banner": "Profile banner",
  "settings.profile.banner.hint":
    "The strip across the top of your public page. {width}×{height} works best.",
  "settings.profile.banner.empty": "No banner — your page draws its own.",
  "settings.profile.banner.upload": "Upload a banner",
  "settings.profile.banner.replace": "Replace",
  "settings.profile.banner.uploading": "Uploading…",
  "settings.profile.banner.remove": "Remove",
  "settings.profile.banner.removing": "Removing…",
  "settings.profile.banner.unconfigured":
    "This server has no file storage set up, so banners cannot be uploaded here.",
  "settings.profile.banner.failed": "Could not upload that banner.",
  "settings.profile.banner.removeFailed": "Could not remove the banner.",
  "settings.profile.displayName": "Display name",
  "settings.profile.username": "Username",
  "settings.profile.usernamePlaceholder": "cool_name",
  "settings.profile.usernameHint":
    "Becomes username#1234 — discriminator auto-assigned if taken.",
  "settings.profile.saveNote":
    "This section applies when you save. Everything else applies the moment you change it.",
  // The public handle. A second name field next to `username`, which reads as
  // redundant until you know why — so the hint says why, in one line, rather
  // than leaving people to guess which of the two is "the real one".
  "settings.profile.publicHandle": "Your public link",
  "settings.profile.publicHandle.placeholder": "yourname",
  "settings.profile.publicHandle.hint":
    "A page anyone can open, even without an account. Different from your username#1234, and there is only one of each.",
  "settings.profile.publicHandle.cooldown":
    "You can change this again on {date}.",
  "settings.profile.publicHandle.copy": "Copy link",
  "settings.profile.publicHandle.copied": "Copied",
  "settings.profile.publicHandle.view": "Open",

  // -- voice & audio
  "settings.voice.description":
    "Devices and levels apply when joining voice. Changes while connected update live when possible.",
  "settings.voice.permissionNeeded":
    "Microphone permission needed to list devices and show input level.",
  "settings.voice.inputDevice": "Input device",
  "settings.voice.systemDefault": "System default",
  "settings.voice.inputVolume": "Input volume",
  "settings.voice.inputLevel": "Input level",
  "settings.voice.percent": "{percent}%",
  "settings.voice.inputMode": "Input mode",
  "settings.voice.mode.activity": "Voice activity",
  "settings.voice.mode.activityHint":
    "Your mic is open whenever you are not muted.",
  "settings.voice.mode.ptt": "Push to talk",
  "settings.voice.mode.pttHint":
    "Your mic stays closed until you hold a key or the button.",
  "settings.voice.pttKey": "Push-to-talk key",
  "settings.voice.pttHint":
    "{key} works while this window is focused and you are not typing. It cannot work while another app is in front — the voice panel has a hold-to-talk button for that.",
  "settings.voice.pttNoKeyboard":
    "This device has no keyboard to bind, so push-to-talk uses the hold-to-talk button in the voice panel.",
  "settings.voice.processing": "Microphone processing",
  "settings.voice.processing.echo": "Echo cancellation",
  "settings.voice.processing.echoHint":
    "Stops others hearing themselves back through your speakers.",
  "settings.voice.processing.noise": "Noise suppression",
  "settings.voice.processing.noiseHint":
    "Removes fans and keyboards — and some of your consonants.",
  "settings.voice.processing.gain": "Automatic gain control",
  "settings.voice.processing.gainHint":
    "Evens out your level, and raises the room between sentences.",
  "settings.voice.processing.note":
    "Changing these re-opens the microphone. Nobody is dropped from the call.",
  "settings.voice.outputDevice": "Output device",
  "settings.voice.outputUnsupported":
    "Output device selection is not supported in this browser.",
  "settings.voice.outputVolume": "Output volume",
  "settings.voice.muteOnJoin": "Mute mic when joining voice",
  "settings.voice.compactPeers": "Compact peer list",

  // -- notifications
  "settings.notifications.description":
    "What reaches you, and where. Per-community and per-channel settings win over these.",
  "settings.notifications.unsupported":
    "This browser cannot show desktop notifications.",
  "settings.notifications.denied":
    "Blocked for this site. Allow notifications in your browser's site settings to turn them back on — the page cannot ask again.",
  "settings.notifications.turnOff": "Turn off",
  "settings.notifications.enable": "Enable desktop notifications",
  "settings.notifications.on": "On for this account.",
  "settings.notifications.willAsk": "Your browser will ask for permission.",
  "settings.notifications.levelLabel": "Default notification level",
  "settings.notifications.level.all": "All messages",
  "settings.notifications.level.mentions": "Only @mentions",
  "settings.notifications.level.none": "Nothing",
  "settings.notifications.levelHint":
    "Applies where a community or channel has no setting of its own. Right-click a community or channel to change just that one.",
  "settings.push.title": "Push — when the app is closed",
  "settings.push.needsInstall":
    "On iPhone and iPad, push only works from the installed app: open pqp in Safari, tap Share, then “Add to Home Screen”, and enable push from inside the installed app.",
  "settings.push.unsupported":
    "This browser cannot receive push notifications.",
  "settings.push.notConfigured": "Push is not configured on this server.",
  "settings.push.turnOff": "Turn off on this device",
  "settings.push.enable": "Enable push on this device",
  "settings.push.on":
    "Mentions, replies and DMs reach this device when the app is closed.",
  "settings.push.off":
    "Only mentions, replies and direct messages — never every message.",
  "settings.push.denied":
    "Notifications are blocked for this site. Allow them in your browser's settings first.",
  "settings.push.failed":
    "Could not subscribe this device. Try again after a reload.",
  "settings.push.unreachable":
    "Could not reach the server. Your subscription was not saved.",
  "settings.push.dmDetails": "Show who sent a direct message",
  "settings.push.dmDetailsHint":
    "Off, a DM push says only “New direct message”. Message text is never included either way.",

  // -- appearance & language
  "settings.appearance.description":
    "How pqp looks, and which language it speaks.",
  "settings.appearance.theme": "Theme",
  "settings.appearance.theme.light": "Light",
  "settings.appearance.theme.dark": "Dark",
  "settings.appearance.theme.system": "System",
  // Lower case on purpose — these two only ever appear inside the sentence
  // below, never on their own.
  "settings.appearance.resolved.light": "light",
  "settings.appearance.resolved.dark": "dark",
  "settings.appearance.themeFollowing":
    "Following your system — currently {theme}.",
  "settings.appearance.themeHint":
    "Applies immediately, and follows your account to other devices.",
  "settings.appearance.language": "Language",
  "settings.appearance.languageHint":
    "The page reloads to switch language. Save your profile first if you were editing it.",
  "settings.appearance.language.en": "English",
  "settings.appearance.language.ptBR": "Português (Brasil)",
  "settings.appearance.chat": "Chat",
  "settings.appearance.linkPreviews": "Show link previews",

  // -- privacy
  "settings.privacy.description":
    "Who can reach you. Enforced on the server, not just here.",
  "settings.privacy.dmLabel": "Who can start a direct message with you",
  "settings.privacy.dm.everyone": "Anyone",
  "settings.privacy.dm.serverMembers": "People I share a community with",
  "settings.privacy.dm.nobody": "No one",
  "settings.privacy.dmHint":
    "Applies to new conversations. Anyone you are already talking to can still reach you — tightening this is not a way to disappear on someone mid-sentence.",
  "settings.privacy.saveFailed": "Could not save that",
  "settings.privacy.blocked": "Blocked",
  "settings.privacy.blockedEmpty":
    "Nobody. Blocking someone stops their messages reaching you and hides what they say in shared channels behind a tap.",
  "settings.privacy.unblock": "Unblock",

  // -- your data
  "settings.data.description":
    "Take everything with you, or close the account for good.",
  "settings.data.export": "Download my data",
  "settings.data.exporting": "Preparing…",
  "settings.data.exportHint": "A JSON file of everything we hold about you.",
  "settings.data.exportBody":
    "It includes your profile, your settings, every message you wrote, the communities you are in, and who you have blocked. It does not include messages other people wrote — including their side of your direct messages. Those are their words, not your data, and you can still read them here in the app.",
  "settings.data.exportFailed": "Could not build your export",
  "settings.data.delete": "Delete my account",
  "settings.data.deleteHint":
    "Permanent. There is no undo and no backup to restore from.",

  // -- delete confirmation
  "settings.delete.eyebrow": "Account",
  "settings.delete.title": "Delete your account",
  "settings.delete.keep": "Keep my account",
  "settings.delete.confirm": "Delete for ever",
  "settings.delete.deleting": "Deleting…",
  "settings.delete.failed": "Could not delete your account",
  "settings.delete.lead":
    "This cannot be undone. We keep no backup you can be restored from, and nobody at pqp can bring your account back.",
  "settings.delete.whatGoes": "What is deleted",
  "settings.delete.goes.profile": "Your profile, handle, avatar and settings.",
  "settings.delete.goes.messages":
    "Every message you have written, everywhere — including in direct messages. Other people will see gaps where your messages were.",
  "settings.delete.goes.files":
    "Your files and images, and the reactions you left.",
  "settings.delete.goes.memberships":
    "Your memberships, your conversations, and the list of people you blocked.",
  "settings.delete.goes.signIn":
    "Your sign-in. You will not be able to log back in.",
  "settings.delete.goes.servers":
    "Any community you own on your own, with nobody else in it.",
  "settings.delete.whatStays": "What is kept, and why",
  "settings.delete.stays.moderation":
    "Moderation records of actions you took in other people's communities, with your name removed. Deleting an account must not erase the record of how it was used to moderate somebody else.",
  "settings.delete.stays.bans":
    "Bans you issued. Removing them would let everybody you banned back into communities you no longer have anything to do with.",
  "settings.delete.stays.reports":
    "Reports other people filed about you, with your name removed. We are not able to let an account be deleted as a way of clearing its own record.",
  "settings.delete.staysNote":
    "All of these are pruned on their own schedule. The privacy policy explains them in full.",
  "settings.delete.ownedTitle":
    "Do one of these first, for each community you own",
  "settings.delete.ownedBody":
    "Other people are still in these communities, so we will not delete them out from under them. In each community's settings, either hand it to another member or delete the community yourself.",
  "settings.delete.ownedMember": "— {count} other member",
  "settings.delete.ownedMembers": "— {count} other members",
  "settings.delete.typeLabel": "Type your handle to confirm",
  "settings.delete.typeAria": "Type {handle} to confirm deletion",

  // ---------------------------------------------------------- server settings
  //
  // Sectioned for the same reason the account settings above were, and after
  // the same complaint: one column that ran a rename, a retention policy, an
  // SSO domain, a public-listing switch, a moderation queue, an audit log and
  // the button that destroys the server all past each other, with scrolling as
  // the only navigation. The section names are the whole fix — a person looking
  // for "how do I stop strangers walking in" should be able to see the door.
  "serverSettings.eyebrow": "Community settings",
  "serverSettings.nav.label": "Community settings sections",
  "serverSettings.close": "Close",

  "serverSettings.section.overview": "Overview",
  "serverSettings.overview.description":
    "What this community is called and what it looks like.",
  "serverSettings.section.access": "Access",
  "serverSettings.access.description":
    "Who can walk in, and how they find their way here.",
  "serverSettings.section.moderation": "Moderation",
  "serverSettings.moderation.description":
    "Reports from members, and how long messages are kept.",
  "serverSettings.section.audit": "Audit log",
  "serverSettings.audit.description":
    "Every moderator action taken in this server, newest first.",
  "serverSettings.section.danger": "Danger zone",
  "serverSettings.danger.description":
    "Take the data with you, hand the server on, or end it.",

  // -- who may see what
  "serverSettings.readOnly.admin":
    "Only the server owner can rename this server, change its pictures, transfer ownership, or delete it.",
  "serverSettings.readOnly.member":
    "Only owners and admins can change server settings. Ask one if something here needs to change.",

  // -- overview: name
  "serverSettings.name.title": "Community name",
  "serverSettings.name.label": "Community name",
  "serverSettings.name.save": "Save",
  "serverSettings.name.saving": "Saving…",
  "serverSettings.name.saved": "Server renamed.",
  "serverSettings.name.failed": "Failed to rename server",

  // -- overview: icon and banner
  "serverSettings.identity.title": "Icon & banner",
  "serverSettings.identity.description":
    "The icon is what this server looks like in the sidebar. The banner runs across the top of the channel list, with the name over it. Both are optional — without them the server draws its first two letters, which is how it looks today.",
  "serverSettings.identity.icon": "Icon",
  "serverSettings.identity.iconHint":
    "Square. Cropped from the middle and scaled to {size}×{size}.",
  "serverSettings.identity.banner": "Banner",
  "serverSettings.identity.bannerHint":
    "Wide. Cropped from the middle and scaled to {width}×{height}.",
  "serverSettings.identity.bannerEmpty": "No banner",
  "serverSettings.identity.upload": "Upload",
  "serverSettings.identity.replace": "Replace",
  "serverSettings.identity.uploading": "Uploading…",
  "serverSettings.identity.remove": "Remove",
  "serverSettings.identity.removing": "Removing…",
  "serverSettings.identity.failed": "That upload failed.",
  "serverSettings.identity.removeFailed": "Could not remove that picture.",
  "serverSettings.identity.unconfigured":
    "This deployment has no file storage configured, so pictures cannot be uploaded. The server keeps its monogram.",

  // -- access: SSO email domain
  "serverSettings.sso.title": "SSO email domain",
  "serverSettings.sso.description":
    "Anyone with a verified email at this domain can join {server} without an invite. Only verified addresses count, and existing bans still apply. Leave empty to turn this off.",
  "serverSettings.sso.label": "SSO email domain",
  "serverSettings.sso.save": "Save",
  "serverSettings.sso.saving": "Saving…",
  "serverSettings.sso.saved": "SSO domain updated.",
  "serverSettings.sso.failed": "Failed to update the SSO domain",

  // -- moderation: retention
  "serverSettings.retention.title": "Message retention",
  "serverSettings.retention.description":
    "Automatically delete messages older than this, across every channel in {server}. Pinned messages are never touched.",
  "serverSettings.retention.label": "Message retention",
  "serverSettings.retention.forever": "Keep forever",
  "serverSettings.retention.days30": "30 days",
  "serverSettings.retention.days90": "90 days",
  "serverSettings.retention.year": "1 year",
  "serverSettings.retention.saved": "Retention updated.",
  "serverSettings.retention.failed": "Failed to update retention",

  // -- audit log
  "serverSettings.audit.title": "Audit log",
  "serverSettings.audit.loading": "Loading…",
  "serverSettings.audit.empty":
    "Nothing recorded yet. Kicks, bans, role changes, and channel or server edits will show up here.",
  "serverSettings.audit.loadMore": "Load more",
  "serverSettings.audit.loadingMore": "Loading…",
  "serverSettings.audit.failed": "Failed to load the audit log",
  "serverSettings.audit.failedMore": "Failed to load more",
  "serverSettings.audit.departedActor": "A departed account",
  // A short, human verb phrase per action — the actor's name and (for
  // role/ban actions) the reason carry the rest of the sentence.
  "serverSettings.audit.action.member.kick": "kicked a member",
  "serverSettings.audit.action.member.ban": "banned a member",
  "serverSettings.audit.action.member.unban": "unbanned a member",
  "serverSettings.audit.action.member.role_update":
    "changed a member's role",
  "serverSettings.audit.action.channel.create": "created a channel",
  "serverSettings.audit.action.channel.update": "updated a channel",
  "serverSettings.audit.action.channel.delete": "deleted a channel",
  "serverSettings.audit.action.channel.move": "reordered a channel",
  "serverSettings.audit.action.message.delete": "deleted someone's message",
  "serverSettings.audit.action.server.update": "renamed the server",
  "serverSettings.audit.action.server.retention_update":
    "changed message retention",
  "serverSettings.audit.action.server.icon_update":
    "changed the server icon",
  "serverSettings.audit.action.server.banner_update":
    "changed the server banner",
  "serverSettings.audit.action.server.ownership_transfer":
    "transferred ownership",
  "serverSettings.audit.action.server.data_export":
    "exported the server's data",
  "serverSettings.audit.action.invite.create": "created an invite",
  "serverSettings.audit.action.invite.delete": "revoked an invite",
  "serverSettings.audit.action.server.sso_domain_update":
    "changed the SSO email domain",
  "serverSettings.audit.action.member.sso_join":
    "joined via SSO email domain",
  "serverSettings.audit.action.server.community_update":
    "changed the public community listing",
  "serverSettings.audit.action.member.community_join":
    "joined from the community directory",
  "serverSettings.audit.action.webhook.create": "created a webhook",
  "serverSettings.audit.action.webhook.delete": "deleted a webhook",
  "serverSettings.audit.action.report.resolve": "closed a report",

  // -- danger zone
  "serverSettings.export.title": "Export data",
  "serverSettings.export.description":
    "Download every channel, member, and message in {server} as a JSON file. Attachment bytes are not included — only their filenames and sizes.",
  "serverSettings.export.action": "Export server data",
  "serverSettings.export.preparing": "Preparing export…",
  "serverSettings.export.failed": "Failed to export data",

  "serverSettings.transfer.title": "Transfer ownership",
  "serverSettings.transfer.description":
    "The new owner gets full control of {server}. You become an admin and cannot take ownership back yourself.",
  "serverSettings.transfer.loading": "Loading members…",
  "serverSettings.transfer.nobody":
    "There is nobody else in this server to hand it to.",
  "serverSettings.transfer.label": "New owner",
  "serverSettings.transfer.placeholder": "Select a member…",
  "serverSettings.transfer.action": "Transfer ownership",
  "serverSettings.transfer.confirmLead":
    "Hand {server} to {member}? Type {phrase} to confirm.",
  "serverSettings.transfer.confirmAria":
    "Type {phrase} to confirm the transfer",
  "serverSettings.transfer.confirm": "Confirm transfer",
  "serverSettings.transfer.transferring": "Transferring…",
  "serverSettings.transfer.cancel": "Cancel",
  "serverSettings.transfer.failed": "Failed to transfer ownership",
  "serverSettings.transfer.membersFailed": "Failed to load members",

  "serverSettings.delete.title": "Delete community",
  "serverSettings.delete.description":
    "Every channel, message, and invite in {server} is deleted for everyone. This cannot be undone.",
  "serverSettings.delete.action": "Delete community",
  "serverSettings.delete.typeLabel": "Type {server} to confirm.",
  "serverSettings.delete.typeAria": "Type {server} to confirm deletion",
  "serverSettings.delete.confirm": "Delete forever",
  "serverSettings.delete.deleting": "Deleting…",
  "serverSettings.delete.cancel": "Cancel",
  "serverSettings.delete.failed": "Failed to delete server",
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

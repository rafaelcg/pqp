# App Store Optimization (ASO)

Keyword research and the reasoning behind the iOS App Store metadata
(`ios/app-store/metadata/`) and the Play Store listing text
(`android/play-listing/`). Written 2026-09-17. Read `docs/PARITY.md` before
changing any claim in either store's copy: it is the source of truth for what
each platform actually does, and both listings are held to it.

## Why the bare name "pqp" is not the App Store name

Apple already has an app registered under the name "pqp" (a different
developer, unrelated to this project). App Store names must be unique across
the whole store, so ours has to be a variant. Google Play has no equivalent
collision for `gg.pqp.app`, but the Play title uses the same variant anyway:
consistent branding across both stores beats squeezing three extra letters
of keyword space out of a bare "pqp" on Play, and the keyword-rich variant is
better ASO regardless of whether it was forced.

## Store character limits

| Field | Apple App Store | Google Play |
|---|---|---|
| Name / title | 30 | 30 |
| Subtitle | 30 | (no separate field; short description does this job) |
| Short description | (n/a) | 80 |
| Keywords | 100, comma-separated, no space after a comma | (no dedicated field; Play indexes the title and description text itself) |
| Promotional text | 170 | (n/a) |
| Description | 4000 | 4000 |

Two mechanics worth knowing before writing either listing:

- **Apple indexes name + subtitle + keywords as one bag of words**, not as
  phrases. A word already spent in the name or subtitle is wasted if it also
  appears in the keywords field (Apple ignores the duplicate for indexing
  purposes), so the three fields should carry as few repeated words as
  possible to maximize the total surface. This is why the keywords file below
  reads as a flat word list rather than the multi-word phrases a human would
  write in a sentence: single words recombine into more query matches per
  character spent than fixed phrases do.
- **The App Store description is not indexed for search at all.** Only name,
  subtitle and keywords affect what a search surfaces. The description
  (and promotional text) exist purely to convert a visitor who already found
  the listing, so they are optimized for honesty and a fast pitch, not for
  keyword density. Google Play is the opposite: title, short description
  *and* full description all feed Play's search index, which is part of why
  the Play short description below still carries a keyword ("alternativa" /
  "alternative") that the iOS subtitle does not bother repeating.

## Keyword research

### pt-BR (primary market)

Ranked roughly by expected search volume and intent match, drawn from the
product's own vocabulary (`client/src/locales/pt-BR/translation.json`) and
the terms a Brazilian Discord user would actually type:

| Term | Why |
|---|---|
| discord alternativa / alternativa ao discord | Direct category search. The single highest-intent term in this market right now: Discord suspended screen sharing, video and Go Live in Brazil on 2026-08-17 by ANPD order (`client/src/locales/pt-BR/translation.json` `vsDiscord.*`, `/vs-discord` on the site), which is actively sending Brazilian users looking for something that still does it |
| discord brasil | Same driver. High volume, unbranded enough to be fair game |
| chat de voz | Category term, already in the current name |
| comunidade | Product's own word for a server, already in the current name |
| servidor | Discord's own vocabulary; users search in Discord's terms even when looking for an alternative |
| watch party | The product's flagship differentiator. Already proven at scale: `landing.hero.body` in the translation file cites a real watch party with 100+ people on 2026-09-05 |
| assistir junto | Natural-language phrasing of "watch party" a Portuguese speaker would type instead of the English loanword |
| compartilhar tela / tela compartilhada | The exact capability Discord lost in Brazil. Second-highest-intent term after "discord alternativa" for the same reason |
| chamada em grupo | Group voice call, generic category term |
| amigos | Friends list, generic but high volume |
| gamer / jogos | Category, high volume, matches `androidPage.perk.*` copy |
| twitch | The watch party's actual use case (`landing.proof.watchParty`); Twitch streamers and their communities are close to the target audience |
| live | Very short, high-frequency word for "livestream" in Brazilian Portuguese, used in the current keywords file already |
| DM | Direct message, short and already product vocabulary |
| código aberto / open source | Differentiator versus every closed competitor, and genuinely searched by the self-hosting crowd |
| grátis / sem anúncio / sem cartão | Price objection handling; "sem cartão" (no card) appears repeatedly across the site's own copy (`betaPage.perk.free.body`, `apoie.body.1`) because it is a real objection Brazilian users raise |
| bate-papo | A native Portuguese synonym for "chat" that does not literally contain the word "chat", useful for keyword-field coverage without wasting characters on a word already in the name |
| mensagem | Message, generic |
| grupo | Group, generic, pairs with "chamada em grupo" and "DM em grupo" |
| rede social | Broader category a user might type without knowing the specific term "Discord alternative" |

### en-US (secondary market)

| Term | Why |
|---|---|
| discord alternative | Direct category search, the anchor term |
| voice chat | Category term, in the current name |
| community / communities | Product's own word, in the current name |
| server / servers | Discord's vocabulary carried over, in the current subtitle |
| watch party / watch together | Same differentiator as pt-BR, phrased both the branded and natural-language way |
| screen share | Category term and a real capability gap versus mobile-only chat apps (see docs/PARITY.md, this is stronger on desktop/web than on either phone today, so the app description should not overclaim it on iOS or Android) |
| group call | Generic, high volume |
| friends | Generic, high volume |
| gaming / gamer | Category |
| twitch | Same reasoning as pt-BR |
| live / livestream | Short, high-frequency |
| DM | Short, product vocabulary |
| open source | Differentiator, real audience (self-hosters, the AGPL crowd) |
| free / no ads | Price objection handling |
| self-hosted | Narrower but high-intent: the AGPL / "own your server" crowd who would specifically search for this rather than "free" |
| text chat / messaging | Generic |
| social app | Broader category fallback |

## Competitor titles and subtitles (verified)

Checked against live store listings, 2026-09-17:

| App | App Store | Google Play |
|---|---|---|
| Discord | "Discord - Talk, Play, Hang Out" (en); pt-BR listing is "Discord - Converse e Jogue" (id 985746746) | "Discord - Talk, Play, Hang Out" (package `com.discord`) |
| TeamSpeak | App Store id `577628510`, name confirmed only as "TeamSpeak 3" from the store URL slug, subtitle not independently confirmed | "TeamSpeak 3 - Voice Chat" (package `com.teamspeak.ts3client`), short description built around "advanced voice chat and communication app... for online gamers, friends, family, and small businesses" |
| Guilded | Positions itself as "an advanced gaming chat platform... with calendars, advanced voice chat, and forums", the closest direct competitor in positioning terms, though its own live store copy was not independently confirmed in this pass |
| Telegram | "Telegram Messenger" on both stores, no category qualifier in the name itself, relies on brand recognition rather than keyword-stuffing |
| WhatsApp | Same pattern: brand name only, no category words in the title, because it does not need to be discovered by category, it is typed directly |

Two things worth taking from this: Discord's own title spends its 30
characters on a punchy tagline ("Talk, Play, Hang Out"), not on category
keywords, because it already wins on brand search. pqp is not there yet, so
its name/subtitle spends the same budget on category and differentiator
words instead ("chat de voz", "comunidade", "watch party") the way TeamSpeak
does. Telegram and WhatsApp's bare-brand titles are not a model to copy here
for the same reason Discord's tagline approach half-is: pqp needs to be found
by category search before it can afford to rely on brand recognition alone.

## Chosen App Store metadata

### pt-BR

| Field | Value | Length |
|---|---|---|
| Name | `pqp: chat de voz e comunidade` | 29 / 30 |
| Subtitle | `Servidor, chamada, watch party` | 30 / 30 |
| Keywords | `alternativa,discord,brasil,código,aberto,jogos,amigos,live,dm,gamer,twitch,grátis,grupo,mensagem` | 96 / 100 |
| Promotional text | `Chat de voz e texto de código aberto: comunidade, servidor e watch party pra mais de 100 pessoas. Entra na call, compartilha a tela, manda DM. De graça, sem anúncio.` | 165 / 170 |

The keywords field deliberately skips "chat", "voz", "comunidade" (in the
name) and "servidor", "chamada", "watch", "party" (in the subtitle), and
instead spends its 96 characters on: the Discord-suspended-in-Brazil angle
("alternativa", "discord", "brasil"), the open source differentiator
("código", "aberto"), and category/audience words not covered elsewhere
("jogos", "amigos", "live", "dm", "gamer", "twitch", "grátis", "grupo",
"mensagem").

### en-US

| Field | Value | Length |
|---|---|---|
| Name | `pqp: voice chat & community` | 27 / 30 |
| Subtitle | `Servers, calls, watch parties` | 29 / 30 |
| Keywords | `discord,alternative,open,source,gaming,friends,live,dm,twitch,free,screen,share,selfhosted,gamer` | 96 / 100 |
| Promotional text | `Open source voice and text chat: communities, servers and watch parties for 100+ people. Join the call, share your screen, DM a friend. Free, no ads.` | 149 / 170 |

Same structure: name and subtitle carry "voice chat", "community",
"servers", "calls", "watch parties"; keywords fill in "discord",
"alternative", "open source", "screen share", "self-hosted" and the
remaining category/audience words.

### Description structure (both locales)

The first two short paragraphs carry the whole pitch and as many
high-value keyword words as read naturally, because only that much is
visible before an App Store visitor has to tap "more". Everything after that
is feature bullets under all-caps section headers (unchanged structure from
before this pass, since it already worked), ending with the same honest iOS
parity disclaimer the previous copy had: no group DMs, no raising your hand
in a call, no starting your own watch party on iOS yet, all three confirmed
still true against `docs/PARITY.md` as of this pass. The one addition is a
verified, true social-proof line: the 100+-person watch party on
2026-09-05 (`landing.hero.body`, `landing.proof.watchParty`), placed in the
second paragraph rather than buried in a bullet.

## Chosen Play Store listing

### pt-BR

| Field | Value | Length |
|---|---|---|
| Title | `pqp: chat de voz e comunidade` | 29 / 30 |
| Short description | `Alternativa livre ao Discord: voz, chat e mensagem direta em grupo. Sem anúncio.` | 80 / 80 |

"Livre" doubles as the Brazilian free-software community's own word
("software livre" is the standard Portuguese term for FOSS), so it reads
naturally as both "free" and "open" without spending characters on both.

### en-US

| Field | Value | Length |
|---|---|---|
| Title | `pqp: voice chat & community` | 27 / 30 |
| Short description | `Open source Discord alternative: voice chat, DMs and group chat. No ads.` | 72 / 80 |

Full descriptions for both locales are in `android/play-listing/*/full_description.txt`.
They are **not** the iOS description reused: Android's real capability set
differs from iOS's in ways that matter for honest copy, per `docs/PARITY.md`:

- Android has **group DMs up to 10 people**; iOS is 1:1 only. This is a real
  Android advantage over iOS worth stating plainly, and both listings do.
- Android has **no watch party support at all** (not even the audience-only
  half iOS has). The Android copy never claims it, and says so plainly in
  its closing beta note rather than omitting it silently.
- Android has **no camera send**, on either voice transport. Not claimed.
- Android's **communities directory is missing** (joining by invite link
  works; browsing the public directory does not). Not claimed as browsable.
- Android's **screen share send** works on mesh (small rooms, DM calls) but
  not on the LiveKit/SFU rooms watch parties and big servers use; **receive**
  works everywhere with audio. The copy states this distinction rather than
  claiming screen share works in every room.

## Screenshot captions

Short captions per scene, for both locales, to overlay if/when the
screenshots get text treatment later. Matched to each platform's real
8-scene list (`ios/app-store/screenshots/README.md` for iOS,
`android/play-listing/README.md` for Android; the two lists differ because
the platforms' capabilities differ, see above).

### iOS (`ios/app-store/screenshots/<locale>/6.9-iphone/`)

| # | Scene | pt-BR caption | en-US caption |
|---|---|---|---|
| 01 | Onboarding | Chat de voz e texto, de graça e sem anúncio | Voice and text chat, free and no ads |
| 02 | Hub | Suas comunidades, tudo num lugar só | Every community, in one place |
| 03 | Channels | Canais de texto e voz, igual você já conhece | Text and voice channels, the layout you already know |
| 04 | Chat | Reação, resposta, GIF, tudo em tempo real | Reactions, replies, GIFs, all in real time |
| 05 | Voice call | Entra na call e conversa com áudio limpo | Join the call and talk with clear audio |
| 06 | DM | Manda mensagem direta pra um amigo | Message a friend directly |
| 07 | Friends | Veja quem tá online agora | See who is online right now |
| 08 | Settings | Seu perfil, sua privacidade, seus dados | Your profile, your privacy, your data |

### Android (`android/play-listing/README.md` scene list)

| # | Scene | pt-BR caption | en-US caption |
|---|---|---|---|
| 01 | Onboarding / sign-in | Entra com a sua conta e já tá dentro | Sign in and you're in |
| 02 | Servers | Seus servidores, sempre à mão | Your servers, always a tap away |
| 03 | Channels | Canais de texto e voz num app só | Text and voice channels in one app |
| 04 | Chat | Reação, resposta, GIF, anexo de qualquer tipo | Reactions, replies, GIFs, any file attached |
| 05 | Voice call | Chamada de voz com áudio limpo, direto no bolso | Voice calls with clear audio, right in your pocket |
| 06 | Group DM | Mensagem direta em grupo, até 10 pessoas | Group DMs, up to 10 people |
| 07 | Friends | Veja quem tá online agora | See who is online right now |
| 08 | You / settings | Seus dados são seus: exporta ou apaga quando quiser | Your data is yours: export or delete it anytime |

## Sources

Competitor listing data pulled 2026-09-17 via live web search against
`apps.apple.com` and `play.google.com` listing pages for Discord (id
985746746, package `com.discord`) and TeamSpeak (package
`com.teamspeak.ts3client`); Guilded and the Telegram/WhatsApp comparison are
general-knowledge positioning notes, not independently re-verified against a
live listing in this pass, and should be spot-checked again before this
document is treated as current for more than a few months.

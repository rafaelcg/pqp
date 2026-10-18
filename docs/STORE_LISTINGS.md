# Store listings (App Store and Google Play)

Where the listing text lives, the limits, the rules, what is published today,
and the checklist to run on every mobile release. The reasoning behind the
words is in [`docs/ASO.md`](./ASO.md); the plan this came from is
`~/.config/pqp/marketing/seo-aso-plan-2026-10-16.md` (Rafael's machine).
`client/src/lib/store-metadata.test.ts` enforces the limits and the rules below
on every CI run, so a listing that breaks one does not merge.

## Where the text lives

| Store | Files | Locales | How it gets there |
|---|---|---|---|
| App Store | `ios/app-store/metadata/<locale>/*.txt` | `en-US`, `pt-BR`, `es-MX` | `.github/workflows/ios-store-metadata.yml` (fastlane `deliver`), manual dispatch |
| Google Play | `android/play-listing/<locale>/{title,short_description,full_description}.txt` | `en-US`, `pt-BR`, `es-419` | Pasted by hand in Play Console (no fastlane `supply` yet), see `android/play-listing/README.md` |

Locale spelling: `es-MX` is the code `deliver` and App Store Connect use for
Mexican Spanish (Apple also has `es-ES`). `es-419` is Play's code for Latin
American Spanish. Both Spanish listings are **pending native review**
(`client/src/locales/es/REVIEW_ES.md` is the same open item). Neither app has a
Spanish interface yet (`CFBundleLocalizations` is `en`, `pt-BR`; Android
`localeFilters` is `en`, `pt-rBR`), so both Spanish descriptions say so in
their last paragraph. Keep that sentence until there are Spanish strings.

## Limits

| Field | App Store | Google Play |
|---|---|---|
| Name / title | 30 | 30 |
| Subtitle | 30 | none |
| Short description | none | 80 |
| Keywords | 100, comma list, no space after a comma | none (Play indexes the text) |
| Promotional text | 170 (not indexed) | none |
| Description | 4000 (not indexed) | 4000 (indexed) |
| What's New | 4000 | 500 per language in Play Console |

Counted in characters (NFC code points), which is how the test counts.

## Rules (all enforced by the test unless marked)

- No other product's name in the App Store name, subtitle, keywords or
  promotional text, nor in the Play title or short description. Apple guideline
  2.3.7 bars trademarked terms and popular app names in metadata; Play's
  metadata policy bars misleading references to other apps. The App Store
  descriptions avoid the word too. `discord` was in both iOS keyword files and
  the Play short description until 2026-10-16.
- Keyword field: one comma list, no spaces, no empty or duplicate entries, no
  word already in the name or subtitle (Apple indexes the three fields as one
  bag of words), no singular and plural of the same word.
- pt-BR uses "tu" and colloquial verbs, never "voce" (enforced for singular and
  plural). No em dashes, no emoji, nothing about the Brazil suspension, ANPD or
  anybody's bans, and never "solo". pqp is made by two brothers.
- Claims about our own product must match `docs/PARITY.md` and the build in
  the store. (Not testable: re-read it every release, see the checklist.)
  Claims about other products are factual, dated and about features, and live in
  the description at most, never in an indexed field.

## What is in the files (2026-10-16)

### App Store

| Locale | Name | Subtitle | Keywords |
|---|---|---|---|
| pt-BR | `pqp: chat de voz e comunidade` (29) | `Tela com som e watch party` (26) | `servidor,compartilhar,assistir,juntos,amigos,grupo,chamada,jogos,live,twitch,código,aberto,grátis,dm` (100) |
| en-US | `pqp: voice chat & community` (27) | `Screen share & watch parties` (28) | `server,friends,group,call,gaming,live,twitch,free,open,source,selfhosted,streamer,dm,together,talk` (98) |
| es-MX | `pqp: chat de voz y comunidad` (28) | `Pantalla y watch party gratis` (29) | `servidor,compartir,ver,juntos,amigos,grupo,llamada,juegos,streamer,twitch,código,abierto,gamer,dm` (97) |

Promotional text (132 / 133 / 135 characters): "Assiste a tela compartilhada com
som, entra no watch party da galera e chama o grupo pra voz. Código aberto, de
graça e sem anúncio." and the en-US and es-MX equivalents in
`promotional_text.txt`.

The description's first paragraph is the conversion pitch (what the visitor
sees before "more"): shared screen with sound, watch party, servers and
direct messages, free, no ads, made by two brothers.

The iOS text does **not** claim sending a screen share from the phone
(`docs/IOS.md`: nobody has verified it on a device) and does not claim hosting
a watch party. It says watching works. If both get verified on a phone, update
the promotional text and the WATCH PARTY section.

### Google Play

| Locale | Title | Short description |
|---|---|---|
| pt-BR | `pqp: chat de voz e comunidade` (29) | `Tela com som, watch party e chat de voz. Código aberto, de graça, sem anúncio.` (78) |
| en-US | `pqp: voice chat & community` (27) | `Open source voice chat: screen share with sound, watch parties, servers. No ads.` (80) |
| es-419 | `pqp: chat de voz y comunidad` (28) | `Chat de voz: pantalla con sonido, watch party y servidores. Gratis, sin anuncios` (80) |

The previous pt-BR short description, `Alternativa livre ao Discord: voz, chat e
mensagem direta em grupo. Sem anúncio.`, names another product. If Rafael wants
to test it against the new one, do it as a Store listing experiment in Play
Console (free), not by editing the file, and a variant that wins there still
does not go into the repo without the policy question being answered.

## Publishing

### App Store (the coordinator runs this, after Rafael has read the files)

Nothing here runs on merge. The listing text reaches App Store Connect only
when somebody dispatches the workflow:

```bash
gh workflow run ios-store-metadata.yml -f app_version=1.0 -f skip_screenshots=true
```

- `skip_screenshots=true` for a text-only refresh (what a copy change needs).
  The repo has screenshots for `en-US` and `pt-BR` only; `es-MX` has none. App
  Store Connect is expected to fall back to the primary language's screenshots
  for a locale with none, **unverified**: check the version page after the
  first run and, if Apple demands its own set, capture es-MX shots the way
  `ios/app-store/screenshots/README.md` describes.
- `app_version` is the marketing version the listing is written for. A public
  version does not exist yet (TestFlight only, `docs/TESTFLIGHT.md`), so create
  the version in App Store Connect first or let `deliver` create it.
- `release_notes.txt` ("What's New") cannot be set on the very first version of
  an app. If the first dispatch reports that, the other fields were still
  written; ignore it, the notes apply from version 1.0.1 on.
- Leave `submit_for_review` off. Age rating, pricing, App Privacy answers, the
  review account and which build ships stay in App Store Connect by hand.
- Needs the three Apple secrets the workflow already uses. Agents and
  contributors never run it and never touch those credentials.

### Google Play (Rafael pastes, or later `fastlane supply`)

Play Console, your app, Grow, Store presence, Main store listing, one language
tab per locale (add `Spanish (Latin America)`, code `es-419` once). Paste title, short
description and full description from the three files. Play's "What's new" is
separate and is written at promotion time (`docs/ANDROID_RELEASE.md` §9).

## Per-release ASO checklist

Run on every iOS tag (`ios-vX.Y.Z`) and every Android promotion. Whoever cuts
the mobile release owns it; the coordinator dispatches the App Store workflow
and Rafael pastes into Play Console.

1. **Claims.** Re-read the rows `docs/PARITY.md` and `docs/HANDOVER.md` changed
   for the release (watch party, screen share send, camera send, directory,
   group DMs). Fix any description line that became false or stale. Both
   store texts have been wrong in both directions before: the Android text said
   watch parties were missing for weeks after the viewer stage shipped.
2. **What's New**, three languages, three sentences at most. What a person can
   do now that they could not before. No "build", "token", "mesh", "SFU", no
   "bug fixes and improvements". Reuse the lead of the weekly release note when
   there is one. Only mention a feature the person will actually see: several
   are behind a runtime flag (`docs/HANDOVER.md` lists which are on).
3. **Screenshots.** Replace any that show a changed screen. Keep the first
   frame the shared-screen viewer (`docs/ASO.md` captions).
4. **Name, subtitle, keywords.** Edit the files, run
   `pnpm --filter @pqp/client exec vitest run src/lib/store-metadata.test.ts`
   (word repeats, plural/singular pairs, limits, no other product's name).
5. **Publish.** iOS: dispatch the workflow (above). Play: paste.
6. **Play health.** Check the pre-launch report and Android vitals. A crash or
   ANR regression costs more than any keyword.
7. **Reviews.** Reply to new reviews within a few days, in the review's
   language, positive and concrete ("planned + works today + invitation").
   Log rating count and average in the weekly sheet.
8. **Learn.** After a few weeks of data, read App Store Connect search terms and
   Play Console search terms and move keywords by evidence, not opinion.
9. **When the iOS listing goes public**: add it to AlternativeTo,
   `ORGANIZATION_SAME_AS`, the smart-banner meta, `llms.txt` and the README, and
   change `docs/TESTFLIGHT.md` ("Public App Store listing").

## Open items for Rafael

- Native review of the es-MX and es-419 text, and a decision on listing Spanish
  on stores for apps without a Spanish interface.
- `twitch` stays in the keyword fields as audience vocabulary. It is a service
  name; Apple's 2.3.7 enforcement is inconsistent. Drop it if the first review
  pushes back (the cost is one word).
- Whether to run the Play short-description experiment (above).

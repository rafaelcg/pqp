# Play Store listing text

Proposed copy for the Play Console store listing, `gg.pqp.app`. Nothing here
is uploaded automatically; there is no `fastlane/metadata/android` directory
and no CI step that reads this one (see `docs/ANDROID_RELEASE.md` §9, which
notes the same for release-notes text). Paste it in by hand, or wire up
`fastlane supply` later if that becomes worth it.

pt-BR is the primary language (the audience, per `CLAUDE.md`), not a
translation of the English. Write each locale on its own, in the product's
own voice (`docs/ASO.md` has the keyword research and reasoning behind the
word choices).

## Files, and where they go in Play Console

Play Console → your app → **Grow → Store presence → Main store listing**,
one language tab per locale:

| File | Play Console field | Limit |
|---|---|---|
| `<locale>/title.txt` | App name | 30 characters |
| `<locale>/short_description.txt` | Short description | 80 characters |
| `<locale>/full_description.txt` | Full description | 4000 characters |

Play has no separate "subtitle" field the way the App Store does; the short
description does that job here, so it deliberately does not repeat every
word already spent in the title (same rule the iOS keywords field follows,
see `docs/ASO.md`).

## Graphics (not included here, still needed)

| Asset | Spec | Status |
|---|---|---|
| App icon | 512×512 PNG, 32-bit, no alpha | Exists: export the adaptive icon's foreground on the brand's near-black, per `docs/ANDROID_RELEASE.md` §7 |
| **Feature graphic** | 1024×500 PNG or JPEG, no alpha | **Required for production, not yet made.** This is the banner Play shows at the top of the listing and in search/category surfaces; distinct from a screenshot |
| Phone screenshots | 16:9 or 9:16, min 320px on the short side, max 3840px, **2 to 8 images** | **Not started.** No screenshot set exists for Android yet, unlike iOS |

## Screenshots still to capture

`docs/ANDROID_RELEASE.md` §7 sketched four generic shots before the app had
real content or voice ships. Propose the same **8 scenes iOS already
captured** (`ios/app-store/screenshots/README.md`) instead, adjusted for what
Android actually does. iOS and Android parity is not 1:1
(`docs/PARITY.md`), and a screenshot claiming a feature the build does not
have is a Play policy problem, not just an honesty one. Camera send, watch
parties and the community directory are all missing on Android today, so
they are dropped from this list rather than carried over from the iOS set.

| # | Scene | Shows | Notes |
|---|---|---|---|
| 01 | Onboarding / sign-in | First-run screen | iOS has a three-beat intro; Android's onboarding is itself a gap (`docs/PARITY.md` "Onboarding... missing" for Android), so this may just be the sign-in screen for now |
| 02 | Servers | The server list | `docs/review/play-listing/01-servidores.png` is an earlier draft capture worth checking before reshooting |
| 03 | Channels | Text channels, a voice channel with people in it | `docs/review/play-listing/02-canais.png` |
| 04 | Chat | A real transcript: reactions, a reply, a pinned message, a GIF | `docs/review/play-listing/03-conversa.png`. Do not stage threads or polls in the shot, neither exists on Android (`docs/PARITY.md`) |
| 05 | Voice call | The call bar: mute, speakerphone, hang up, a couple of participants | `docs/review/play-listing/04-chamada.png` is an earlier draft. No camera tiles turned on by the demo account: camera **send** does not exist on Android, only receive, and receive is unverified on hardware. A shot with the local user's camera on would misrepresent the app |
| 06 | Direct message | A **group** DM with 3+ people, not a 1:1 | `docs/review/play-listing/05-mensagens.png` is an earlier draft, worth checking whether it is already a group DM. Worth calling out over iOS's screenshot: Android has group DMs (up to 10) and iOS does not yet (`docs/PARITY.md` Social table). Shows a genuine Android advantage |
| 07 | Friends | Online friends, a pending request | `docs/review/play-listing/06-amigos.png` |
| 08 | You / settings | Profile, data export, delete account | No earlier draft exists for this one; it needs a fresh capture |

Capture on a Pixel emulator (per `docs/ANDROID_RELEASE.md` §7), status bar
clean (`adb shell cmd statusbar` or demo mode), against a seeded local dev
server the same way the iOS set was made
(`ios/app-store/screenshots/README.md` "How these were made" is a good
template: `DEV_AUTH_BYPASS=true`, extra content seeded over the wire for a
populated roster, friends list and group DM). pt-BR first, en-US second.

Caption text to overlay on each scene (both locales) is in `docs/ASO.md`
under "Screenshot captions", written to match this 8-scene list, not the
iOS one, so scene 06 there is captioned for a group DM and there is no
watch-party caption at all.

## Other Play Console fields this doesn't cover

Filled in already for the approved submission per `docs/ANDROID_RELEASE.md`
§5–§7: the foreground-service declaration, the Data safety form, the content
rating questionnaire, and the privacy policy URL. This directory is store
*listing copy* only: title, descriptions, and what screenshots to take.

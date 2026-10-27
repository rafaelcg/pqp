# Onboarding and hints

Every surface that teaches, invites or nudges, and the rules they share.
Adding one means adding a row here.

## The surfaces

| Surface | Component | Shape | Shows when | Goes away |
|---|---|---|---|---|
| Age gate | `components/user/age-gate-dialog.tsx` | Dialog, not dismissible. Screen **one** of the first run: it draws the same `StepDots` as the wizard (`components/onboarding/step-dots.tsx`), and once answered it stays on screen in its saving state until the wizard takes the same panel over with `Dialog entrance={false}`, so the two read as one window with no loading screen between them | `me.ageGate` is not `passed` | The server records a birthdate |
| Live preview age step (signed out) | `components/live-preview/live-preview-panel.tsx` | A sheet (`Dialog`, a bottom sheet on a phone) over the live page, which itself covers the community page or the invite gate. Same date fields (`components/user/birth-date-fields.tsx`), wording and `MINIMUM_AGE_YEARS` as the age gate, checked on the device; see `docs/WATCH_PARTY.md` §"Watching without an account" | A signed-out visitor taps "Assistir agora" on a live community watch party (`live_preview` flag) | Answered. Nothing is sent or stored but the verdict: adult for the tab, under the threshold for a day on the device |
| Wizard | `components/onboarding/onboarding-flow.tsx` | **One** Dialog, steps that crossfade (`animate-step-out` / `animate-step-in`, header included via `headerKey`), dots in the footer counted from the gate. **você**: name, photo (presets + upload, no URL field), and the `@` chip (tap copies, Trocar edits); on an invite link it shows the room that is waiting (icon, name, faces) and its button is "Entrar em {server}". **sala** (cold only): three doors, one open at a time: Criar do zero, Já tenho um servidor no Discord (closes the wizard, opens the create dialog on the paste), Me mandaram um convite. **pronto** (after Criar): `ServerReadyPanel`, the invite link and the pastes, organizer confetti. Screens per path (`screensFor` in `lib/onboarding.ts`): invite 2, `?import=` 2, cold 4. A community's public link (`/c/<slug>`, arriving as `?join=`) takes the invite path: the person came for one room, and on 2026-09-26 the cold path's Criar door moved 7 of 93 mid-show sign-ups into servers of their own, away from the party they came for | `preferences.onboardedAt` absent | `onboardedAt` (preference, cross-device) |
| Server ready | `components/onboarding/server-ready-panel.tsx` | The invite link (copies with a check, an accent ring and a "now paste it" line) plus `InvitePaste`. Shared by the wizard's last step and the create dialog's done step, so both ways of making a room end with the invite in hand | a room was just made | the step or dialog closing |
| First-run checklist | `components/onboarding/first-run-card.tsx` | Inline card in the hub, rows land staggered. The server row has three doors: Criar, Trazer do Discord, Usar convite. While it shows, the friends empty state says nothing (it repeated the friend row) | not dismissed and one of server / friend / avatar still open | `firstRunDismissedAt` (preference), or auto-stamped when all three are done |
| Arrival banner | `components/onboarding/arrival-banner.tsx` | Strip under the channel header, and under the community home's header (`CommunityHomeFeed banner`). Variant from `arrivalVariant` (`lib/arrival.ts`): `text` (say oi in #channel), `voice` (press Entre na call; gone once in the call), `home` (start in #channel or join the call), `owner` (a room this account made this session and is alone in: "Sua sala tá pronta", with **Copiar convite**). Nothing at all over a watch party that is live (`party` surface): the film is the welcome, and the old "pick a channel" copy took the height a phone needed for the picture. A join while a party is live lands ON the party (`refreshAfterJoin`, `lib/live-party-landing.ts`), not on Overview or `#general`. An invitee's first arrival after the wizard fires the confetti once (`pqp:confetti-spent`, session) | first visit to a server just joined or made | Session; `pqp:arrived-servers` remembers the join |
| Chama teus amigos | `components/onboarding/newcomer-invite-strip.tsx`, rules in `lib/newcomer-invite.ts` | Strip in the arrival strip's slot (under a public community's channel or Baú header), taking its place. **Chamar amigos** opens Criar sala with "Sala de {nome}" filled in; the dialog ends on the invite (`?ref=chama`) | flag `newcomer_invite_moment` on, first-run finished under 7 days ago, no friends and no sent request, in nothing but public communities somebody else owns (the QG placement). Not over a live party or the watch-now strip. Same flag makes the hub checklist's server row ignore the placed community | `pqp:newcomer-invite-2026-10` ("Agora não"), or a friend or a room of your own |
| Traz tua galera | `components/onboarding/bring-crew-strip.tsx`, rules in `lib/bring-crew.ts` and `bringCrewPhase` (`@pqp/shared`) | Strip in the arrival strip's slot (channel pane and Baú home), with **Copiar anúncio** and a share button where the device has one. The import's last screen shows the same announcement (`bring-crew-announcement.tsx`) | flag `discord_bring_crew` on for the server, it was made by a Discord import in the last 7 days, and the reader may manage it. "Traz tua galera do Discord" while nobody came, "N pessoas da tua galera já chegaram" after, and a day in with fewer than 3, the reminder ("Só 1 pessoa chegou até agora"). Replaces the owner arrival strip there; yields to a live stream and a live party | X. Closing the first day still lets the reminder through once; closing the reminder ends it. `pqp:bring-crew-dismissed:<serverId>`, written on dismiss on every host (furniture, like the download strip) |
| Veio do Discord? | `components/onboarding/discord-import-notice.tsx`, rules and store in `lib/discord-import-notice.ts` | Strip in the arrival strip's slot, in a server's **main text channel** only (the first text channel; never a DM, never another channel). A labelled region (not a live region): "Veio do Discord? Traz teu servidor pra cá", one line that says nothing is deleted, one primary **Importar do Discord** and an X (at every width, like the crew strip's). Last in line behind the arrival strip, the crew strip and the newcomer strip, and it yields to a live stream, a live party, a call, and any corner card or attached hint | flag `discord_import_notice` on, the reader owns the server or has Manage Server, the server was **not** made by a Discord import (`imported === false` on the arrivals route; unknown shows nothing), is under 30 days old with 20 members or fewer and 8 channels or fewer | X: hidden 14 days, may show **once more**, a second X ends it; the button ends it at once. `pqp:discord-import-notice:<userId>:<serverId>` in the hints store (`{closes, lastClosedAt, clicked}`; not persisted on localhost without `pqp:hints-persist`). Funnel: `discord_import_notice_view` (once per server per load) / `_click` / `_dismiss` |
| Watch now strip | `components/watch-now/watch-now-banner.tsx`, rules in `lib/watch-now.ts` (`docs/plans/WATCH_NOW.md`) | Strip under the channel header, above the arrival strip, in the open server's channels and in a conversation. One primary button, `Assistir` (or `Voltar pra transmissão` when already seated), and `Agora não`. A labelled region with a quiet `role="status"`, never an alert; collapses out over `--duration-base`, instantly under reduced motion | flag `watch_now_banner` on for the server (the deployment-wide answer in a conversation), somebody other than you is sharing a screen in a voice channel you may view AND connect to, or a watch party is live, and its picture is not what the pane shows already (a party's open channel, a room you are seated in). Not for a blocked sharer or your own share. **The arrival strip yields to it**: a live stream is the welcome, and two instructions for one screen is the failure it exists to fix | `Agora não` (that stream, `sessionStorage`, forgotten when the stream ends), or the stream ending. Joins nobody without a tap |
| Watch now hint | `components/layout/feature-hint.tsx` (`watchNow`), hung under the strip | Inline CornerCard, first in the attached queue after the call dock (a moment, not a state) | the strip is up for somebody who arrived in this server this session or whose first-run finished under 24 h ago | `pqp:feature-hint-watch-now-2026-10` (impression). Copy: "Tem uma transmissão ao vivo, toque em Assistir" |
| Conversas empty list | `components/conversations/conversations-empty.tsx`, drawn by `FriendsView` (`hero`) | Centered block above the friends tabs: "Tuas conversas moram aqui", **Adicionar amigo**, **Chamar alguém pro pqp** (copies the profile link, or the site), and up to three people from the account's own rooms (never a listed community's roster) with **Dizer oi**. While it is up, the friends tab's own "Nenhum amigo" block stands down | flag `conversations_home` on and the account has no conversation at all | the first conversation |
| Friend accepted | `components/conversations/friend-accepted-toast.tsx` | Toast at the top right (DM toast shell), "Tu e {name} agora são amigos" with **Mandar um oi** | flag `conversations_home` on and somebody accepted a request this account sent (not one it accepted itself), seen as a new friend after the `friend-activity` nudge | 12 s, X, or the button (opens the conversation) |
| Owner empty channel | `components/chat/message-list.tsx` (`EmptyState`) | Centered empty state: "Só você aqui por enquanto" with a secondary Copiar convite (the banner above carries the loud one). Everybody else gets "Comece a conversa / Dá um oi", no markdown (the composer format hint teaches it) | the reader made this server this session and is its only member | somebody else joins. **The button is hidden by `hint_diet`** (the line of text stays, and the arrival banner above carries Copiar convite). |
| Baú intro | `components/community-home/community-home-onboarding.tsx` (staging) | Inline card in the feed | member's first Baú | `communityHomeIntroDismissedAt` (preference) |
| Baú post | `components/community-home/community-home-post-hint.tsx` | Corner card | a publish in the open server while looking at another channel (unread went up; not the author) | CTA opens Baú; X / Escape / 8 s. Not a campaign: no `lib/hints.ts` key |
| Update ready | `components/layout/update-prompt.tsx` | Corner card, and a rail icon while a build waits | a new build is waiting | Reload. Later snoozes 20 min; Escape does not touch it |
| QG invite | `components/layout/qg-hint.tsx` | Corner card with hero | QG is listed and not joined | `pqp:qg-hint-…` (impression) |
| Aparecer no diretório | `components/communities/listing-nudge-hint.tsx`, rules in `lib/community-listing-nudge.ts` | Corner card, after the QG. Names the room, says what listing means (the directory switch's own line), a directory-row preview of the room, **Aparecer no diretório** (lists it in place) and Agora não. Not over a live party or the watch-now strip | flag `community_listing_nudge` on (default), the account owns a room with a public address that is not listed, not suspended, and passes the directory's quality bar (`GET /api/communities/listing-nudge` picks the biggest). Never for an empty shell | `communityListingNudgeAt` (preference, stamped when it paints; the server reads it too, so no device asks again) |
| O fórum abriu | `components/layout/forum-announcement-hint.tsx`, rules and store in `lib/forum-announcement.ts` | Corner card (`forumNews`, after the listing nudge, before Voz limpa and the year-round campaigns). Title, one line ("Ideia, bug, dúvida ou o que tu tá montando: um assunto por post, e a conversa fica."), **Abrir o fórum** (opens the server's first forum channel the person can see) and Agora não. A labelled landmark, never a live region and never takes focus; a dismissal hands focus back to where a keyboard user came from | flag `forum_announcement` on for the open server (served as `announce` on `GET /api/forum/config?serverId=`, only ever true beside `forum_channels`), the server is in the account's own list, it has a forum the person can see, and the person is not on a forum. Never in a call, a share, an app or over a live party, whatever `hint_budget` says, and not while the arrival strip is up for that server (a fresh join gets one instruction); a focused composer or a draft holds only its entrance | `pqp:forum-announcement-2026-10:<serverId>` in the hints store (per browser), stamped by either button, the X, Escape, or **opening the forum channel by any route**. Painting is not an impression: a card that yielded to a call comes back after it |
| Notification offer | `components/layout/notify-offer-hint.tsx`, rules in `shouldQueueNotifyOffer` (`lib/notifications.ts`) | Corner card, after a waiting build and a Baú post, before the QG. "Quer ser avisado quando te chamarem?" with **Ativar notificações** (the click is the gesture the browser's permission prompt needs) and Agora não | flag `desktop_notify_default_on` on, a browser tab (never the desktop app), banners off, permission still undecided, and a DM or a mention reached the tab while it was hidden; drawn when the person is back. Not over a live party | `pqp:notify-offer-2026-10` (impression), or the permission being answered |
| Voz limpa nudge | `components/voice/voice-clean-hint.tsx` | Inline CornerCard above the user bar | first voice call with the mic on since ship, desktop (≥640px), not presenting a watch party | `voiceCleanNudgeDismissedAt` (preference — "Ativar" or "Depois" both count). Narrower than 640px: no card, a NOVO dot on the Settings noise-suppression row instead. **The card is hidden by `hint_diet`** (never drawn, nothing stored); the NOVO dot stays. |
| Party newcomer strip | `components/onboarding/party-newcomer-strip.tsx`, rules in `lib/party-newcomer.ts` | One-line strip under the party bar, above the split | flag `party_newcomer_experience` on for the server, a live party, no seat, an account whose first-run finished under 24 h ago. While it is up the Watch party viewer hint below stands down | `pqp:party-newcomer-strip-2026-09` (dismiss). Same flag also puts the rail away and gives the chat a floor on a phone, and holds the Get the app strip back for that newcomer |
| Seasonal look | `components/layout/seasonal-look-hint.tsx`, windows in `lib/seasonal-looks.ts` | Corner card with a miniature of the look. **Experimentar** switches the look on the spot through `chooseLook` (the picker's own door, so a dark-only look still gives the old mode back), then the card stays up with **Desfazer** and **Manter**. Agora não closes it | the look's season (Halloween 1 Oct to 2 Nov, Christmas 1 Dec to 6 Jan, the reader's local calendar), that look not already on, not over a live party. `localStorage["pqp:season"]` = `halloween` / `christmas` / `none` overrides the calendar for QA | `pqp:seasonal-look-<look>-<year>` (impression), one per season. **Hidden by `hint_diet`** (never drawn, nothing stored). |
| Mobile beta | `components/layout/mobile-beta-hint.tsx` | Corner card | phone browser, not the native app | `pqp:mobile-beta-hint-…` (impression) |
| What's new (corner) | `components/layout/whats-new-prompt.tsx` | Corner card | pack id unseen | `pqp:whats-new` (impression). **Hidden by `hint_diet`** (never drawn, nothing stored). |
| What's New (rail) | `components/layout/whats-new-view.tsx` + sparkle on `server-rail.tsx` | Rail icon, lime pip | newest `/blog` slug unseen | `pqp:whats-new-feed` (opening the feed) |
| Apps news | `components/layout/apps-hint.tsx`, key in `lib/apps/apps-hint.ts` | Corner card, `appsNews` in `CORNER_HINT_ORDER` (after Novidades, before cargos). "Novo: apps no canal", a miniature of the composer's button, **Entendi** | the runtime flag `apps` is on for the open server and at least one app is released there, in a text or voice channel; not over a live party or the watch-now strip | `pqp:apps-hint-2026-10` (impression). A server without apps never draws it, so nobody is told about a button they cannot see |
| Cargos tip | `components/layout/cargos-hint.tsx` | Corner card | can manage roles | `pqp:cargos-hint-…` (impression). **Hidden by `hint_diet`** (never drawn, nothing stored). |
| Get the app strip | `components/downloads/download-hint.tsx` | Sidebar strip | desktop browser | `pqp:download-hint-dismissed` (dismiss) |
| Música pip | `lib/music-pip.ts`, drawn on the Música tile of the call dock | A lime NOVO pip on the tile, not a card: outside `CORNER_HINT_ORDER` and the attached queue, so it arbitrates with nothing and can sit beside a hint that won the slot | the same gate as the Music card (in a call, with SPEAK) until somebody opens the Fila panel | `pqp:music-pip-2026-09`, spent by **opening the panel** from any of its doors (the dock tile, the bar's queue icon, the sidebar radio's start button), never by painting. Kept under `hint_diet`: use spends it |
| Voz limpa NOVO dot | `components/settings/voice-section.tsx` (`showVoiceCleanBadge`, the noise-suppression row), rules in `lib/voice-clean.ts` | A NOVO dot on the Settings row, the same nudge's narrow-screen form | under 640px, where the Voz limpa card does not draw | `voiceCleanNudgeDismissedAt` (preference). Kept under `hint_diet` |
| OBS virtual camera tip | `components/voice/obs-virtual-camera-hint.tsx`, rules in `lib/obs-virtual-camera.ts`; drawn in Settings, Voice, under the camera picker | One line (`SettingsNotice`) with a Dismiss button: OBS sends its whole scene, so the fix is "Output type: Source" in OBS | the selected camera's label looks like OBS's virtual camera | `pqp:obs-virtual-camera-hint-dismissed` (written on every host, never through `lib/hints.ts`, so it is not a `hints-persist` case). Not a campaign: it answers the device the person chose |
| Linux share audio hint | `components/voice/linux-share-audio-hint.tsx`, rules in `lib/linux-share-audio-hint.ts` | A pill over the share controls: in a browser, Chromium on Linux carries sound only for a tab share; in the desktop shell, until the runtime flag and the shell say it can (`lib/linux-shell-share-audio.ts`), sound is not carried at all. One hint with two doors (before the picker, and a share that started with no audio track) | Linux, share controls on screen, not yet dismissed. Steps aside once the shell carries sound | `pqp:linux-share-audio-hint-2026-09`, written only on dismiss (a call that ends before it is read shows it again) |
| Game capture notice | `components/voice/share-game-capture-notice.tsx`, rules in `lib/share-game-capture-hint.ts` | Presenter's card when the shared picture died (black, stalled, ended within 60 s), almost always a game in exclusive fullscreen; names the fix | flag `share_game_capture_hint` on (per server), the **Windows desktop app only**, and the shell confirms exclusive fullscreen: never on pixels alone | `pqp:share-game-capture-hint-off` ("Não mostrar de novo"); silenced, the picture watch does not even start |
| Call rating prompt | `components/voice/call-rating-prompt.tsx`, gates in `lib/call-rating.ts` and `hooks/use-call-rating.ts` | "How was that call?", numbers 1 to 5 (a note only on a low score), after the call ends | the call lasted at least a minute, somebody else was there, and none was asked in the last 6 hours | `pqp:call-rating-asked` (a timestamp, written when it is asked; the X is final). A post-call question, not a hint: **not** held by `hint_budget` |
| Story first-run row | `components/stories/story-strip.tsx` (`FirstRunRow`), rules in `lib/stories/strip-state.ts` | A row in the stories strip: post your first story | `stories` on for the server, the person may post, the strip says `firstRunHint`, and no ring (their own or anybody's) is live; never on the Conversas strip, which has its own bubble | `pqp:stories-first-run:<userId>:<audience>` through `lib/hints.ts`, written on its X |
| Cinema hint | `components/voice/cinema-hint.tsx` | One-line strip above the call controls | iPhone/iPad in a browser tab (not standalone), a share on the stage | `pqp:cinema-hint-…` (impression, `lib/cinema-hint.ts`) |
| Call grew | `components/voice/capacity-notice.tsx` | Inline CornerCard above the call controls | the room's limits went up while you were sitting in it | `pqp:voice-capacity-<voiceChannelId>` (impression, `lib/voice-capacity.ts`) |
| Fallback microphone | `components/voice/mic-fallback-notice.tsx` | Inline CornerCard above the call controls | the saved microphone would not start and the call is on a substitute (`VoiceState.micFallback`) | Close button (remembered per device pair for the call, `use-voice.ts`'s `dismissMicFallbackNotice`), or the saved device answering again on its own or by hand |
| Meet the bot | `components/bots/bot-intro-hint.tsx` | Inline CornerCard over the conversation, out of the flow, above the composer. "Conheça o {name}" with BETA: how to call it, that it can err, what it reads and who processes it. **Dizer oi** puts `@handle oi!` in the composer (nothing is sent) | a server bot still in the server has a message in the open channel | `pqp:bot-intro-<serverId>` (Agora não, Dizer oi, X), once per server |
| Composer format | `components/layout/feature-hint.tsx` in the composer | Inline CornerCard above Aa / + | first text channel, once | `pqp:feature-hint-composer-format-…`. **Hidden by `hint_diet`** (never drawn, nothing stored). |
| Voice note transcription | `components/chat/voice-note-transcription-notice.tsx` (a `FeatureHint`, not in the attached queue) | Inline CornerCard above the composer, with an "Abrir Configurações" action that opens Privacidade | the first time somebody records a voice note where transcripts exist (flag `voice_note_transcription` on for that server, or globally in a conversation) and their `voiceTranscription.mine` is still on. Shown while recording, never blocks it; the composer-format card steps aside meanwhile | `pqp:feature-hint-voice-note-transcription-2026-10` (impression) |
| Call dock | `components/layout/feature-hint.tsx` in the call dock's hint slot (`CallControls`, collapsed) | Inline CornerCard above the dock's control row | first time the voice-only call bar docks in the composer, in a room you are connected to. First of the attached hints: every in-call hint below points at a control that now lives in the dock | `pqp:feature-hint-call-dock-…` (impression). Entendi, or pressing any control in the dock, closes it. **Hidden by `hint_diet`** (never drawn, nothing stored). |
| Watch party | `components/layout/feature-hint.tsx` in the call dock's hint slot or above the stage controls, and on the sidebar's voice bar | Inline CornerCard | first time in a call that can share | `pqp:feature-hint-watch-party-…`. **Hidden by `hint_diet`** (never drawn, nothing stored). |
| Watch party viewer | `components/watch-party/watch-party-panel.tsx` (live bar) | Inline CornerCard, under the party bar | first time watching a live party without a seat | `pqp:feature-hint-watch-party-viewer-…` |
| Bring friends | `components/layout/bring-friends-hint.tsx` on the call bar or the in-call strip | Inline CornerCard | first time you are presenting a screen share in a server call with fewer than three people. Not DMs, not viewers | `pqp:feature-hint-bring-friends-2026-09`. CTA copies the short invite paste |
| Music field | `components/layout/feature-hint.tsx` in the Fila panel, under the field | Inline CornerCard | first time the queue panel is opened, by somebody with SPEAK (`shouldOfferMusicFieldHint`). Before `music` in the order: a moment beats a standing tip, the same rule the two watch party hints follow | `pqp:feature-hint-music-field-2026-09` (impression). **Hidden by `hint_diet`** (never drawn, nothing stored). |
| Music | `components/layout/feature-hint.tsx` in the call dock's hint slot (`CallControls`) | Inline CornerCard above the dock's control row, plus a lime pip on the Música tile | in a call, with SPEAK, nothing playing in the room and the Fila panel shut (`shouldOfferMusicHint`). After the share tips: both fire for anyone in any call, and share is the older control | `pqp:feature-hint-music-2026-09-2` (impression). The pip is separate, `pqp:music-pip-2026-09` in `lib/music-pip.ts`, and is spent by opening the panel rather than by the card painting. **The card is hidden by `hint_diet`** (never drawn, nothing stored); the pip is not, because opening the panel spends it. |
| Watch party waitlist | `components/watch-party/live-party-block.tsx` (teaser) + `components/watch-party/waitlist/watch-party-waitlist-dialog.tsx` | Sidebar card in the create slot ("Acesso antecipado", then "Na lista"), opening a Dialog with the stage illustration and the form. Also opened by `?intent=watch-party-waitlist` (the public `/watch-party` page) once onboarding is done | the open server answered `enabled: false` on `GET /api/live-hls/config?serverId=` and the deployment runs the campaign (`WATCH_PARTY_WAITLIST`). Never on a server that runs watch parties | Not a hint: it is the entry point until the operator turns the server on, then the real create control replaces it |
| Watch party liberada | `components/watch-party/waitlist/watch-party-approved-toasts.tsx` | Toast at the top, the session reminders' shell | the operator turned on a server this person waited for (live frame, or `GET /api/watch-party/waitlist/approvals` at boot) | Abrir servidor or Depois, either one acks it on the server (`seen_at`), cross-device |
| Channel pin | `components/layout/feature-hint.tsx` in the channel list | Inline CornerCard | first time a server list is open | `pqp:feature-hint-channel-pin-…`. **Hidden by `hint_diet`** (never drawn, nothing stored). |
| Forum | `components/layout/feature-hint.tsx` (`forum`) under Novo post in `components/forum/forum-pane.tsx` | Inline CornerCard, last in the attached queue. "Cada post é uma conversa": a title, tags, and check whether somebody already asked | first time somebody who may post opens a forum that has posts, with no post open. Never on an empty forum (its empty state already explains) and never while posts are paused | `pqp:feature-hint-forum-2026-10` (impression) |
| Shortcuts | `components/layout/shortcuts-hint.tsx` | Corner card, last in the queue | `/app` on a keyboard, after a quiet beat, no attached hint up | `pqp:feature-hint-shortcuts-…`. **Hidden by `hint_diet`** (never drawn, nothing stored). |

## The rules

**No campaign card over a live party.** While the open channel is a watch
party on air, QG, the phone app, What's new, cargos and shortcuts do not
take the corner (`selectedPartyLive` in `App`). The phone-app card is a way
out of the page, and 8 of the 51 phone sessions a streamer's link created
mid-show on 2026-09-26 went to `/android` instead of the film. The whole tail
yields, not one card, or the next card in line takes the corner over the
picture. The update notice, a Baú post and the voice nudge still may. The same
tail yields while the **watch-now strip** is on screen (`campaignsYield` in
`App`): a stream is live in this server, the strip is the one thing a newcomer is
being asked to do, and the first thing a stranger is told must not be "join the
QG" (Filminho, 2026-10-04).

**A hint that has had its turn stops holding the slot.** `winningFeatureHint`
hands the one attached slot to the first id that wants it, and `wanting` is
built from standing conditions (connected, in a call, a dock on screen) that
do not change when somebody presses Entendi. So a card already seen went on
winning for the rest of the load and every tip behind it waited for good.
`spendFeatureHintForLoad` is what the queue skips on. Localhost remembers
nothing, so every reload replays the cards, unless `pqp:hints-persist` is `1`.

**The diet and the quiet contexts (`hint_diet`, `hint_budget`).** Two global
runtime flags, both off by default, from the 2026-10-20 hints audit (which
counted 20 surfaces before a new owner sent a message, 17 for an invitee; see
`docs/FEATURE_FLAGS.md`). Both are client presentation read from
`GET /api/onboarding/config` (`lib/hint-config.ts`), and until the first answer
lands (or 2 s) the queues hold every unsolicited hint.

- **`hint_diet`** hides the hints that repeat what the app shows: one list,
  `HINT_DIET_IDS` in `lib/hint-diet.ts` (What's new, cargos, shortcuts, Voz
  limpa and seasonal-look cards; the call dock, watch party, music, music field,
  composer format and channel pin coach marks; the owner empty channel's Copiar
  convite). It is read where the queues read: `winningCornerHint` and
  `winningFeatureHint` skip a hidden id (the next card takes the slot),
  `isFeatureHintSeen` says "seen", `rememberFeatureHint` stores nothing. **A
  hidden hint never writes storage**, so the flag off restores everything. Not
  on the list: the Música pip and the Voz limpa NOVO dot (spent by use or by a
  setting), QG, listing nudge, mobile beta, the notify offer, bringFriends,
  watchNow, the watch party host and viewer hints, forum, the first-run checklist.
  Adding an id to the list is how a later audit removes another hint.
- **`hint_budget`** holds an unsolicited hint, without dropping it, while a quiet
  context is true (`lib/hint-quiet.ts`, applied in `App` next to `campaignsYield`):
  voice connected, an app or game session the person sits in, a share or a live
  party, the composer focused or holding a draft (`registerComposerActivity`,
  reported by `message-composer.tsx`), or a modal dialog open (`aria-modal`).
  A corner card that is held records no impression and shows when the context
  ends; an attached coach mark is held through the provider's `yielding`, not
  spent. **Never held:** real failures (mic fallback, audio health, stale chunk,
  sanctions), the update indicator, event notifications (a Baú post and the
  notify offer are the two corner ids exempt, `QUIET_EXEMPT_CORNER_IDS`), the
  arrival banner, the voice note transcription notice (consent) and the call
  rating prompt. Not covered by the winners and so not held yet: the strips
  that decide for themselves (the Discord import notice already yields to a
  call and a party; the newcomer and crew strips are the arrival strip's
  slot), the download strip and the story first-run row. The global time budget,
  the merged queue, account-level seen state and a master switch are later
  steps of the audit.

Locadora (on its integration branch, not on `main`) has its own first-run
inside the app frame: welcome, fullscreen hint, double-click hint and a turbo
toast. The bridge's `hello` push does not carry a hints field yet, so neither
flag reaches it; the audit proposes `hello.hints` before it merges. The Apps
card of that branch is not a surface on `main` and has no row here yet.

**Once means once, including within a page load.** `components/layout/feature-hint.tsx`
keeps two per-load sets. `eligibleThisLoad` holds a card eligible through a
remount that changed nothing, because the call stage swaps its collapsed
strip for the expanded one and React StrictMode remounts in dev, and neither
should hide a card on the real tree. `dismissedThisLoad` is the other half:
Entendi, the X, and a gate that turns off after the card was shown all spend
the card for the rest of the load. Without it a hint whose gate follows live
state (a track starting, a panel opening) unmounts and is handed straight
back, which teaches people to swat it. A hint with a live gate is therefore
mounted with `enabled={...}` rather than behind a `&&` that unmounts it, or
the card cannot tell the two cases apart.

**One corner at a time.** Every corner card renders through
`components/layout/corner-card.tsx` and is arbitrated by
`lib/corner-hints.ts` (`CORNER_HINT_ORDER`: update, communityHomePost, notifyOffer, qg, listingNudge, forumNews, voiceClean,
seasonalLook, mobileBeta, whatsNew, appsNews, cargos, shortcuts; `voiceClean` is the one entry that
does not paint in the bottom-right corner; it shares the list because "never
two cards at once" is the rule, not the position). The update prompt is
mounted in `main.tsx` outside `App`;
it reports through `lib/update-prompt-state.ts` so the queue in `App` yields
to it. Two cards in the same corner is a stack, and the one underneath records
its impression without ever being seen. Being in the order is not enough:
a card has to take `enabled` and paint only when it holds the corner. QG
reported that it wanted the corner and then rendered anyway until 9 Sep 2026,
which put it and the update notice on screen together with an Escape listener
each, and one keypress silenced the update instead of the card the person was
aiming at. Composer format, Watch party / share,
and Fixar use the same `CornerCard` frame with `layout="inline"` next to the
control, always out of the flow so the control does not move; they share `lib/feature-hints.ts` so only one of those mounts, and they
yield while a campaign owns the corner. "The call controls moved" is first in
`ATTACHED_FEATURE_HINT_ORDER`: the voice-only call bar docks in the composer
since September 2026, and every in-call hint points at a control that now
lives there. The two watch party hints come next because they are moments
(setting a show up, landing in one) rather than states, and must not queue
behind the standing "share is on the call bar" tip that fires for anyone in
any call.

**One shell.** `CornerCard` owns the frame (radius, border, shadow, width,
safe area), the entrance (`animate-pop-in`), the exit (`animate-pop-out`,
the card unmounts itself after it), Escape, and the close button (floating on
the hero when there is one, in the title row otherwise). A card passes
`title`, `body`, an optional `hero`, children for a preview, and a `footer`.

**One store.** `lib/hints.ts` is the only place that decides whether a
"show once" card was seen: on `localhost` nothing is ever remembered, so a
developer sees every card again on every reload (set `pqp:hints-persist` to
`1` to make dismissals stick like production), never for an automated browser
(`navigator.webdriver`: Playwright, and CDP drivers unless they hide the flag),
and hostile or
missing storage reads as seen. The per-surface libs (`qg-hint.ts`,
`cargos-hint.ts`, `mobile-beta-hint.ts`, `feature-hints.ts`) keep their names as
thin wrappers. The download strip is the exception on purpose: it is furniture,
written on dismiss, on every host.

**Say what changed, not what it is called.** The call-grew card fires on the
*capability*, never on the transport's name: `lib/voice-capacity.ts` reads
`MESH_VOICE_LIMIT`, `SCREEN_SHARE_LIMIT` and `CAMERA_LIMIT` out of
`@pqp/shared` and compares the before with the after, so a room that changed
media path without gaining anything says nothing, and the numbers in the
sentence cannot drift from the numbers the server enforces. It is keyed per
voice channel, and only somebody who was seated across the change has a
"before" to have grown from (`VoiceState.capacityRoseFrom`), so a person who
walks into an already-promoted room is told nothing, because nothing changed
for them.

**The update notice is not a hint.** It is the one prompt in the product
that cannot be acted on later by other means, and it gates every other client
fix, so it plays by different rules and only these: it is first in
`CORNER_HINT_ORDER` and `elevated` in the shell, so it cannot be covered;
`dismissOnEscape={false}`, because Escape means "get the thing I just opened
out of my way" and nobody opened this; and while a build is waiting the server
rail carries a `RefreshCw` icon (`data-update-rail`) that brings the card back
through a snooze and through a call. `lib/update-prompt-state.ts` holds the
two facts apart: `waiting` (a build is precached, drawn by the rail) and
`showing` (the card is up, read by the queue). The in-call hush stays: a
reload kills a screen share and a browser cannot restore one without the
picker. The rail icon is what makes it a hush rather than a disappearance.

**Preference vs. localStorage.** Things that answer a question about the
*account* (the wizard, the checklist, the Baú intro) are preferences and
follow the person to the next device. Campaign cards are per browser: seeing
the QG invite twice on two machines is fine; re-running the wizard is not.

**Motion.** Dialogs rise (`animate-rise`), once: a panel that takes over from
another in the same spot passes `entrance={false}`. Steps inside the wizard
crossfade (`animate-step-out` 120 ms left, `animate-step-in` from the right,
together, header included); a field under the control that asked for it
unfolds (`animate-door-reveal`); a copied invite swells a ring
(`animate-copy-flash`) and swaps its icon (`animate-icon-swap`); corner cards
pop (`animate-pop-in` / `-out`); list rows that arrive together stagger
(`--stagger`). All of it is off under `prefers-reduced-motion`, and confetti
becomes a still row.

**The funnel.** `lib/track.ts` sends named events to the hosted site's Umami
and is a no-op anywhere the tag was not injected (every self-host):
`onboarding_start`, `onboarding_step_view`, `age_gate_pass` / `age_gate_block`,
`onboarding_you_next`, `onboarding_room_door`, `onboarding_server_created`,
`onboarding_invite_copied`, `onboarding_done`, `arrival_view`,
`arrival_first_message`, `arrival_first_voice`, `invite_gate_view`, `newcomer_invite_view` / `_click` / `_dismiss`, `discord_import_notice_view` / `_click` / `_dismiss` (`{existing}`), and for Conversas `dm_open` `{source}` / `dm_start` `{source, kind}` (`lib/conversation-events.ts`: which door led to a conversation, never who). The Clerk trip on a community poster is timed by `signup_cta_click` (the tap, with `webview` when it is an in-app browser) and `signup_return` (the account exists, with `seconds` and `bucket` since the tap), both from `lib/signup-assist.ts`. With `VITE_SIGNUP_ASSIST=true` (or `localStorage["pqp:signup-assist"]="on"`), a poster that reloads while Clerk holds a sign-up waiting on its emailed code reopens the modal and fires `signup_resume_open`. Links copied
from first-run surfaces carry `?ref=onboarding`, so joins through them are
counted apart from `convite` and `discord`.

**Signed out on an invite link.** `ClerkAppGate` asks
`GET /api/public/invites/:code` once per code, with no auth header, and says
"Você foi convidado pra {server}" when it answers. Any other answer (404, 429,
an API without the route) keeps the generic copy; the sign-in redirect carries
the code either way.

## Adding a card

1. Decide its persistence: preference (account question) or `lib/hints.ts`
   key (campaign).
2. Render it with `CornerCard` (corner, or `layout="inline"` next to a
   control). An inline card must be **out of the flow**: wrap it in something
   that takes no room (`absolute`, or a `relative h-0` sibling) with
   `pointer-events-none` on the wrapper and `[&>*]:pointer-events-auto` on the
   card, or it pushes the control it explains down the screen the moment it
   appears and swallows clicks on whatever it spans. The call dock's cards go
   one step further: the dock animates open by collapsing a row that has to be
   `overflow-hidden`, so they portal into a host the outlet hangs above it
   (`useCallDockHintHost`).
3. If it is a corner card, add its id to `CORNER_HINT_ORDER` in product
   order and pass `enabled={cornerHint === "<id>"}` from `App`. Render nothing
   when `enabled` is false, and do not spend the impression either: a card that
   yielded the corner was never seen.
4. Add the row above.

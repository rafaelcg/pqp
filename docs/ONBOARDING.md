# Onboarding and hints

Every surface that teaches, invites or nudges, and the rules they share.
Adding one means adding a row here.

## The surfaces

| Surface | Component | Shape | Shows when | Goes away |
|---|---|---|---|---|
| Age gate | `components/user/age-gate-dialog.tsx` | Dialog, not dismissible. Screen **one** of the first run: it draws the same `StepDots` as the wizard (`components/onboarding/step-dots.tsx`), and once answered it stays on screen in its saving state until the wizard takes the same panel over with `Dialog entrance={false}`, so the two read as one window with no loading screen between them | `me.ageGate` is not `passed` | The server records a birthdate |
| Wizard | `components/onboarding/onboarding-flow.tsx` | **One** Dialog, steps that crossfade (`animate-step-out` / `animate-step-in`, header included via `headerKey`), dots in the footer counted from the gate. **você**: name, photo (presets + upload, no URL field), and the `@` chip (tap copies, Trocar edits); on an invite link it shows the room that is waiting (icon, name, faces) and its button is "Entrar em {server}". **sala** (cold only): three doors, one open at a time: Criar do zero, Já tenho um servidor no Discord (closes the wizard, opens the create dialog on the paste), Me mandaram um convite. **pronto** (after Criar): `ServerReadyPanel`, the invite link and the pastes, organizer confetti. Screens per path (`screensFor` in `lib/onboarding.ts`): invite 2, `?import=` 2, cold 4 | `preferences.onboardedAt` absent | `onboardedAt` (preference, cross-device) |
| Server ready | `components/onboarding/server-ready-panel.tsx` | The invite link (copies with a check, an accent ring and a "now paste it" line) plus `InvitePaste`. Shared by the wizard's last step and the create dialog's done step, so both ways of making a room end with the invite in hand | a room was just made | the step or dialog closing |
| First-run checklist | `components/onboarding/first-run-card.tsx` | Inline card in the hub, rows land staggered. The server row has three doors: Criar, Trazer do Discord, Usar convite. While it shows, the friends empty state says nothing (it repeated the friend row) | not dismissed and one of server / friend / avatar still open | `firstRunDismissedAt` (preference), or auto-stamped when all three are done |
| Arrival banner | `components/onboarding/arrival-banner.tsx` | Strip under the channel header, and under the community home's header (`CommunityHomeFeed banner`). Variant from `arrivalVariant` (`lib/arrival.ts`): `text` (say oi in #channel), `voice` (press Entre na call; gone once in the call), `home` (start in #channel or join the call), `owner` (a room this account made this session and is alone in: "Sua sala tá pronta", with **Copiar convite**). An invitee's first arrival after the wizard fires the confetti once (`pqp:confetti-spent`, session) | first visit to a server just joined or made | Session; `pqp:arrived-servers` remembers the join |
| Owner empty channel | `components/chat/message-list.tsx` (`EmptyState`) | Centered empty state: "Só você aqui por enquanto" with a secondary Copiar convite (the banner above carries the loud one). Everybody else gets "Comece a conversa / Dá um oi", no markdown (the composer format hint teaches it) | the reader made this server this session and is its only member | somebody else joins |
| Baú intro | `components/community-home/community-home-onboarding.tsx` (staging) | Inline card in the feed | member's first Baú | `communityHomeIntroDismissedAt` (preference) |
| Baú post | `components/community-home/community-home-post-hint.tsx` | Corner card | a publish in the open server while looking at another channel (unread went up; not the author) | CTA opens Baú; X / Escape / 8 s. Not a campaign: no `lib/hints.ts` key |
| Update ready | `components/layout/update-prompt.tsx` | Corner card, and a rail icon while a build waits | a new build is waiting | Reload. Later snoozes 20 min; Escape does not touch it |
| QG invite | `components/layout/qg-hint.tsx` | Corner card with hero | QG is listed and not joined | `pqp:qg-hint-…` (impression) |
| Voz limpa nudge | `components/voice/voice-clean-hint.tsx` | Inline CornerCard above the user bar | first voice call with the mic on since ship, desktop (≥640px), not presenting a watch party | `voiceCleanNudgeDismissedAt` (preference — "Ativar" or "Depois" both count). Narrower than 640px: no card, a NOVO dot on the Settings noise-suppression row instead |
| Mobile beta | `components/layout/mobile-beta-hint.tsx` | Corner card | phone browser, not the native app | `pqp:mobile-beta-hint-…` (impression) |
| What's new (corner) | `components/layout/whats-new-prompt.tsx` | Corner card | pack id unseen | `pqp:whats-new` (impression) |
| What's New (rail) | `components/layout/whats-new-view.tsx` + sparkle on `server-rail.tsx` | Rail icon, lime pip | newest `/blog` slug unseen | `pqp:whats-new-feed` (opening the feed) |
| Cargos tip | `components/layout/cargos-hint.tsx` | Corner card | can manage roles | `pqp:cargos-hint-…` (impression) |
| Get the app strip | `components/downloads/download-hint.tsx` | Sidebar strip | desktop browser | `pqp:download-hint-dismissed` (dismiss) |
| Cinema hint | `components/voice/cinema-hint.tsx` | One-line strip above the call controls | iPhone/iPad in a browser tab (not standalone), a share on the stage | `pqp:cinema-hint-…` (impression, `lib/cinema-hint.ts`) |
| Call grew | `components/voice/capacity-notice.tsx` | Inline CornerCard above the call controls | the room's limits went up while you were sitting in it | `pqp:voice-capacity-<voiceChannelId>` (impression, `lib/voice-capacity.ts`) |
| Fallback microphone | `components/voice/mic-fallback-notice.tsx` | Inline CornerCard above the call controls | the saved microphone would not start and the call is on a substitute (`VoiceState.micFallback`) | Close button (remembered per device pair for the call, `use-voice.ts`'s `dismissMicFallbackNotice`), or the saved device answering again on its own or by hand |
| Composer format | `components/layout/feature-hint.tsx` in the composer | Inline CornerCard above Aa / + | first text channel, once | `pqp:feature-hint-composer-format-…` |
| Call dock | `components/layout/feature-hint.tsx` in the call dock's hint slot (`CallControls`, collapsed) | Inline CornerCard above the dock's control row | first time the voice-only call bar docks in the composer, in a room you are connected to. First of the attached hints: every in-call hint below points at a control that now lives in the dock | `pqp:feature-hint-call-dock-…` (impression). Entendi, or pressing any control in the dock, closes it |
| Watch party | `components/layout/feature-hint.tsx` in the call dock's hint slot or above the stage controls, and on the sidebar's voice bar | Inline CornerCard | first time in a call that can share | `pqp:feature-hint-watch-party-…` |
| Watch party viewer | `components/watch-party/watch-party-panel.tsx` (live bar) | Inline CornerCard, under the party bar | first time watching a live party without a seat | `pqp:feature-hint-watch-party-viewer-…` |
| Bring friends | `components/layout/bring-friends-hint.tsx` on the call bar or the in-call strip | Inline CornerCard | first time you are presenting a screen share in a server call with fewer than three people. Not DMs, not viewers | `pqp:feature-hint-bring-friends-2026-09`. CTA copies the short invite paste |
| Music field | `components/layout/feature-hint.tsx` in the Fila panel, under the field | Inline CornerCard | first time the queue panel is opened, by somebody with SPEAK (`shouldOfferMusicFieldHint`). Before `music` in the order: a moment beats a standing tip, the same rule the two watch party hints follow | `pqp:feature-hint-music-field-2026-09` (impression) |
| Music | `components/layout/feature-hint.tsx` in the call dock's hint slot (`CallControls`) | Inline CornerCard above the dock's control row, plus a lime pip on the Música tile | in a call, with SPEAK, nothing playing in the room and the Fila panel shut (`shouldOfferMusicHint`). After the share tips: both fire for anyone in any call, and share is the older control | `pqp:feature-hint-music-2026-09-2` (impression). The pip is separate, `pqp:music-pip-2026-09` in `lib/music-pip.ts`, and is spent by opening the panel rather than by the card painting |
| Channel pin | `components/layout/feature-hint.tsx` in the channel list | Inline CornerCard | first time a server list is open | `pqp:feature-hint-channel-pin-…` |
| Shortcuts | `components/layout/shortcuts-hint.tsx` | Corner card, last in the queue | `/app` on a keyboard, after a quiet beat, no attached hint up | `pqp:feature-hint-shortcuts-…` |

## The rules

**A hint that has had its turn stops holding the slot.** `winningFeatureHint`
hands the one attached slot to the first id that wants it, and `wanting` is
built from standing conditions (connected, in a call, a dock on screen) that
do not change when somebody presses Entendi. So a card already seen went on
winning for the rest of the load and every tip behind it waited for good. On
a developer's machine, where nothing is remembered so every card can be seen
again, that is every session: `callDock` is first, so the music card could
never once be drawn. `spendFeatureHintForLoad` is what the queue skips on.

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
`lib/corner-hints.ts` (`CORNER_HINT_ORDER`: update, communityHomePost, qg, voiceClean,
mobileBeta, whatsNew, cargos, shortcuts — `voiceClean` is the one entry that
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
"show once" card was seen: never on `localhost` (developers see every card on
every reload), never for Playwright (`navigator.webdriver`), and hostile or
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
`arrival_first_message`, `arrival_first_voice`, `invite_gate_view`. Links copied
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

# Onboarding and hints

Every surface that teaches, invites or nudges, and the rules they share.
Adding one means adding a row here.

## The surfaces

| Surface | Component | Shape | Shows when | Goes away |
|---|---|---|---|---|
| Age gate | `components/user/age-gate-dialog.tsx` | Dialog, not dismissible | `me.ageGate` is not `passed` | The server records a birthdate |
| Wizard | `components/onboarding/onboarding-flow.tsx` | **One** Dialog, three steps that slide in, progress dots in the footer | `preferences.onboardedAt` absent | `onboardedAt` (preference, cross-device) |
| First-run checklist | `components/onboarding/first-run-card.tsx` | Inline card in the hub, rows land staggered | not dismissed and one of server / friend / avatar still open | `firstRunDismissedAt` (preference), or auto-stamped when all three are done |
| Arrival banner | `components/onboarding/arrival-banner.tsx` | Strip under the channel header | first visit to a server just joined | Session; `pqp:arrived-servers` remembers the join |
| Baú intro | `components/community-home/community-home-onboarding.tsx` (staging) | Inline card in the feed | member's first Baú | `communityHomeIntroDismissedAt` (preference) |
| Baú post | `components/community-home/community-home-post-hint.tsx` | Corner card | a publish in the open server while looking at another channel (unread went up; not the author) | CTA opens Baú; X / Escape / 8 s. Not a campaign: no `lib/hints.ts` key |
| Update ready | `components/layout/update-prompt.tsx` | Corner card, and a rail icon while a build waits | a new build is waiting | Reload. Later snoozes 20 min; Escape does not touch it |
| QG invite | `components/layout/qg-hint.tsx` | Corner card with hero | QG is listed and not joined | `pqp:qg-hint-…` (impression) |
| Mobile beta | `components/layout/mobile-beta-hint.tsx` | Corner card | phone browser, not the native app | `pqp:mobile-beta-hint-…` (impression) |
| What's new (corner) | `components/layout/whats-new-prompt.tsx` | Corner card | pack id unseen | `pqp:whats-new` (impression) |
| What's New (rail) | `components/layout/whats-new-view.tsx` + sparkle on `server-rail.tsx` | Rail icon, lime pip | newest `/blog` slug unseen | `pqp:whats-new-feed` (opening the feed) |
| Cargos tip | `components/layout/cargos-hint.tsx` | Corner card | can manage roles | `pqp:cargos-hint-…` (impression) |
| Get the app strip | `components/downloads/download-hint.tsx` | Sidebar strip | desktop browser | `pqp:download-hint-dismissed` (dismiss) |
| Cinema hint | `components/voice/cinema-hint.tsx` | One-line strip above the call controls | iPhone/iPad in a browser tab (not standalone), a share on the stage | `pqp:cinema-hint-…` (impression, `lib/cinema-hint.ts`) |
| Call grew | `components/voice/capacity-notice.tsx` | Inline CornerCard above the call controls | the room's limits went up while you were sitting in it | `pqp:voice-capacity-<voiceChannelId>` (impression, `lib/voice-capacity.ts`) |
| Composer format | `components/layout/feature-hint.tsx` in the composer | Inline CornerCard above Aa / + | first text channel, once | `pqp:feature-hint-composer-format-…` |
| Watch party | `components/layout/feature-hint.tsx` on the call bar or the in-call strip | Inline CornerCard | first time in a call that can share | `pqp:feature-hint-watch-party-…` |
| Watch party viewer | `components/watch-party/watch-party-panel.tsx` (live bar) | Inline CornerCard, under the party bar | first time watching a live party without a seat | `pqp:feature-hint-watch-party-viewer-…` |
| Channel pin | `components/layout/feature-hint.tsx` in the channel list | Inline CornerCard | first time a server list is open | `pqp:feature-hint-channel-pin-…` |
| Shortcuts | `components/layout/shortcuts-hint.tsx` | Corner card, last in the queue | `/app` on a keyboard, after a quiet beat, no attached hint up | `pqp:feature-hint-shortcuts-…` |

## The rules

**One corner at a time.** Every corner card renders through
`components/layout/corner-card.tsx` and is arbitrated by
`lib/corner-hints.ts` (`CORNER_HINT_ORDER`: update, communityHomePost, qg, mobileBeta, whatsNew,
cargos, shortcuts). The update prompt is mounted in `main.tsx` outside `App`;
it reports through `lib/update-prompt-state.ts` so the queue in `App` yields
to it. Two cards in the same corner is a stack, and the one underneath records
its impression without ever being seen. Being in the order is not enough:
a card has to take `enabled` and paint only when it holds the corner. QG
reported that it wanted the corner and then rendered anyway until 9 Sep 2026,
which put it and the update notice on screen together with an Escape listener
each, and one keypress silenced the update instead of the card the person was
aiming at. Composer format, Watch party / share,
and Fixar use the same `CornerCard` frame with `layout="inline"` next to the
control; they share `lib/feature-hints.ts` so only one of those mounts, and they
yield while a campaign owns the corner. The two watch party hints are first in
`ATTACHED_FEATURE_HINT_ORDER` because they are moments (setting a show up,
landing in one) rather than states, and must not queue behind the standing
"share is on the call bar" tip that fires for anyone in any call.

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

**Motion.** Dialogs rise (`animate-rise`); steps inside the wizard slide
(`animate-step-in`); corner cards pop (`animate-pop-in` / `-out`); list rows
that arrive together stagger (`--stagger`). All of it is off under
`prefers-reduced-motion`.

## Adding a card

1. Decide its persistence: preference (account question) or `lib/hints.ts`
   key (campaign).
2. Render it with `CornerCard` (corner, or `layout="inline"` next to a control).
3. If it is a corner card, add its id to `CORNER_HINT_ORDER` in product
   order and pass `enabled={cornerHint === "<id>"}` from `App`. Render nothing
   when `enabled` is false, and do not spend the impression either: a card that
   yielded the corner was never seen.
4. Add the row above.

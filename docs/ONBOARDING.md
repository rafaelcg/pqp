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
| Update ready | `components/layout/update-prompt.tsx` | Corner card | a new build is waiting | Reload, or Later (session snooze) |
| QG invite | `components/layout/qg-hint.tsx` | Corner card with hero | QG is listed and not joined | `pqp:qg-hint-…` (impression) |
| Mobile beta | `components/layout/mobile-beta-hint.tsx` | Corner card | phone browser, not the native app | `pqp:mobile-beta-hint-…` (impression) |
| What's new (corner) | `components/layout/whats-new-prompt.tsx` | Corner card | pack id unseen | `pqp:whats-new` (impression) |
| What's New (rail) | `components/layout/whats-new-view.tsx` + sparkle on `server-rail.tsx` | Rail icon, lime pip | newest `/blog` slug unseen | `pqp:whats-new-feed` (opening the feed) |
| Cargos tip | `components/layout/cargos-hint.tsx` | Corner card | can manage roles | `pqp:cargos-hint-…` (impression) |
| Get the app strip | `components/downloads/download-hint.tsx` | Sidebar strip | desktop browser | `pqp:download-hint-dismissed` (dismiss) |

## The rules

**One corner at a time.** Every corner card renders through
`components/layout/corner-card.tsx` and is arbitrated by
`lib/corner-hints.ts` (`CORNER_HINT_ORDER`: update, qg, mobileBeta, whatsNew,
cargos). The update prompt is mounted in `main.tsx` outside `App`; it reports
through `lib/update-prompt-state.ts` so the queue in `App` yields to it. Two
cards in the same corner is a stack, and the one underneath records its
impression without ever being seen.

**One shell.** `CornerCard` owns the frame (radius, border, shadow, width,
safe area), the entrance (`animate-pop-in`), the exit (`animate-pop-out`,
the card unmounts itself after it), Escape, and the close button (floating on
the hero when there is one, in the title row otherwise). A card passes
`title`, `body`, an optional `hero`, children for a preview, and a `footer`.

**One store.** `lib/hints.ts` is the only place that decides whether a
"show once" card was seen: never on `localhost` (developers see every card on
every reload), never for Playwright (`navigator.webdriver`), and hostile or
missing storage reads as seen. The per-surface libs (`qg-hint.ts`,
`cargos-hint.ts`, `mobile-beta-hint.ts`) keep their names as thin wrappers.
The download strip is the exception on purpose: it is furniture, written on
dismiss, on every host.

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
2. Render it with `CornerCard` (corner) or `animate-rise` on an inline card.
3. If it is a corner card, add its id to `CORNER_HINT_ORDER` in product
   order and pass `enabled={cornerHint === "<id>"}` from `App`.
4. Add the row above.

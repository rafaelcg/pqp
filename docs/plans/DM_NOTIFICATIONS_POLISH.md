# DM list and notification polish, with the arrival toast

> Spec, not code. Written 2026-09-13 against `main` (`c67bf0b9`). A Sonnet
> implementer builds exactly what is written here; a QA agent runs §9.
> Everything below was read in the tree, not guessed: the file and line
> references are the current state, and where a thing already exists this says
> so rather than describing it as new.

Owner's ask: the DM system "needs to look more polished", and when you are
online and a DM arrives, show a popup in the top right like the old MSN
Messenger.

Half of that already exists. `client/src/components/dm/dm-toasts.tsx` ships a
DM arrival card today. It is in the wrong corner, it says "1 nova mensagem"
instead of the message, it cannot be paused, and it is drawn in five deprecated
colour tokens. The rest of this file is the delta.

---

## 1. Principles

1. **Quiet by default.** A DM interrupts once; a conversation of twenty
   messages still interrupts once.
2. **One place for a count, one colour per meaning.** Red is unread messages.
   Accent is friend requests. A number never appears twice in two colours.
3. **The conversation you are looking at never notifies you** — no toast, no
   sound, no OS banner, no badge.
4. **Phone parity.** Every rule here holds at 390px, and the phone reads the
   same suppression table as the desktop.
5. **An interruption is an event, not a campaign.** The toast never joins the
   `lib/corner-hints.ts` queue and never takes the bottom-right corner.

---

## 2. The DM list and header

### 2.1 What is unpolished today

Read before changing anything: `client/src/components/layout/dm-list.tsx`,
`client/src/components/layout/server-rail.tsx` (lines 168-218),
`client/src/components/friends/friends-view.tsx` (lines 230-290).

| # | Problem | Where |
|---|---|---|
| a | The same friend-request number is **lime** on the rail Home bubble (`tone="signal"`) and **red** on the "Amigos" sidebar row (`bg-danger`). One fact, two alarm levels. | `server-rail.tsx:193`, `dm-list.tsx:198` |
| b | Three counters for two facts on one screen: rail bubble, "Amigos" row badge, "Pendentes (1)" tab badge. The Pendentes badge is red, which reads as an alarm for something the user is already looking at. | `friends-view.tsx:281` |
| c | A conversation row is one line: avatar, name, time, badge. No preview, so the list cannot answer "what did they say" without opening each one. | `dm-list.tsx` `ConversationRow` |
| d | The `+` in the header is a 28px hit target (`p-1.5` around `h-4 w-4`). The phone close button next to it is 24px. Both are under 44px. | `dm-list.tsx:139-160` |
| e | The header reads `Mensagens` at `text-base font-bold` and the Friends entry below it reads at `text-sm` inside the scroll area, so the nav entry looks like a conversation that happens to be first. | `dm-list.tsx:137,171` |
| f | Rows are 30px tall with a 24px avatar. A messaging app's primary list is denser than its own message rows. | `dm-list.tsx:389` |
| g | The unread pill on the left edge is `-left-1` and the row padding is `px-2`, so the marker and the avatar are 4px apart at one width and touching at another. | `dm-list.tsx:395` |

### 2.2 Hierarchy

Three bands in the sidebar, top to bottom, with the visual weight in that
order:

```
┌─ header, h-56px ──────────────────────────────┐
│  Mensagens                    [ + ]  [ x ]    │   ← 44px hit targets
├───────────────────────────────────────────────┤
│  [👥] Amigos                            (2)   │   ← nav band, 40px
│                                               │
│  CONVERSAS                                    │   ← eyebrow, 11px
│  [av] Ana Beatriz              14:02    (3)   │   ← row band, 52px
│       você: bora hoje?                        │
│  [av] Mesa do RPG              ontem          │
│       Caio: levei o mapa                      │
└───────────────────────────────────────────────┘
```

Concrete values:

- **Header.** `h-14` stays (56px). Title `font-display text-base font-semibold
  text-text`. The two controls become `h-9 w-9` (`--control-md`) with the icon
  at `h-4 w-4`, `rounded-[var(--radius-control)]`, `hover:bg-surface-2`.
- **Nav band.** The Amigos row keeps its position and gets `h-10`, `px-2`,
  `gap-2`, icon `h-4 w-4`, label `text-sm font-medium`. A 1px
  `border-border` divider sits under it with `my-2`.
- **Eyebrow.** New: `CONVERSAS` / `CONVERSATIONS`, `text-[11px] font-semibold
  uppercase tracking-wider text-text-tertiary`, `px-2 pb-1`. Keys
  `dm.sectionLabel`. Rendered only when there is at least one conversation.
  This is what stops the Amigos row reading as conversation zero.
- **Row band.** Two lines, 52px tall, avatar 32px (`h-8 w-8`), `px-2 py-1.5`,
  `gap-2.5`, `rounded-[var(--radius-control)]`.

### 2.3 The conversation row

Component: `ConversationRow` in `dm-list.tsx`. Two lines.

Line 1: title (`text-sm`, truncate) · spacer · relative time (`text-[11px]
tabular-nums text-text-tertiary`) · unread pill.
Line 2: preview (`text-xs text-text-tertiary truncate`), or the typing line
when somebody is typing in that conversation, or the draft mark.

States:

| State | Title | Preview | Time | Pill | Row |
|---|---|---|---|---|---|
| Read | `text-text-secondary` | `text-text-tertiary` | `text-text-tertiary` | none | — |
| Unread | `text-text font-semibold` | `text-text-secondary` | `text-text` | red count | 3px `bg-text` marker, `absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full` |
| Selected | `text-text` | `text-text-secondary` | `text-text-secondary` | none (opening clears) | `bg-surface-2` |
| Muted | `text-text-tertiary` | `text-text-tertiary` | — | none, `BellOff` `h-3 w-3` instead | `opacity-60` (was 50, which fails the text floor) |
| Live call | title unchanged | replaced by "Em chamada" / "In a call", `text-success` | — | — | phone icon stays `text-success` |

The unread pill: `min-w-[18px] h-[18px] px-1 rounded-full bg-danger
text-on-danger text-[10px] font-bold leading-none tabular-nums`, capped at
`99+` through the existing `formatBadgeCount`. Keeps `animate-badge-pop` and
`data-dm-unread`.

**The preview needs data that does not exist.** `dmSummarySchema`
(`packages/shared/src/dm.ts:78`) carries `lastMessageAt` and no text. See §2.7.

### 2.4 The `+` (new DM)

It opens `NewDmDialog` (`client/src/components/user/new-dm-dialog.tsx`), which
is correct and stays. Three changes:

1. Hit target `h-9 w-9`, tooltip label stays `dm.new` ("Nova mensagem" / "New
   message").
2. It gets a keyboard shortcut, `Ctrl/Cmd+K` is taken by search, so **`Ctrl/Cmd
   + Shift + M`**, registered in `client/src/lib/keyboard-shortcuts.ts` with the
   label key `shortcuts.newDm` ("Nova conversa" / "New conversation").
3. On an empty list the `+` is not the only way in: the empty state's own
   button already exists and keeps working.

### 2.5 Empty states

| Case | Copy (pt-BR) | Copy (en) | Key |
|---|---|---|---|
| No conversations, has friends | **Nenhuma conversa ainda.** / Comece uma com alguém da sua lista. | **No conversations yet.** / Start one with someone on your list. | `dm.empty`, new `dm.empty.body` |
| No conversations, no friends | **Nenhuma conversa ainda.** / Adicione alguém primeiro. | **No conversations yet.** / Add someone first. | `dm.empty`, new `dm.empty.noFriends` |
| Filtered to nothing (future search) | out of scope, §10 | | |

Both render the existing `dm.messageSomeone` link button below, and the
no-friends variant points at Amigos instead of the new-DM dialog.

### 2.6 Friends tabs, and where the request counter lives

**Pendentes stays under Amigos.** It is a friends concept; hoisting it into the
conversation list would put two unrelated queues in one column.

The counter rules, which resolve problems (a) and (b):

| Surface | Shows | Colour | Why |
|---|---|---|---|
| Rail Home bubble | friend requests **and** unread DMs, as today | requests `accent` (top corner), unread `danger` (bottom corner) | The rail is the only surface visible from inside a server; it is allowed to carry both. |
| Sidebar "Amigos" row | friend requests only | **`accent` fill with `on-accent` text** (changed from `bg-danger`) | Same fact as the rail corner, so the same colour. |
| "Pendentes" tab | the same number | **neutral: `text-text-tertiary` count in parentheses, no pill** | You are already inside the view. A red pill on a tab you can see is an alarm about something in front of you, which principle 3 forbids. |

Copy for the tab becomes `Pendentes (1)` / `Pending (1)` via a new key
`friends.tab.pendingCount` with `{count}`, rendered inside the existing button
rather than as a badge. `friends.pendingBadge` stays for the screen-reader
strings on the rail and the Amigos row.

### 2.7 Data the list needs

Two additive changes, both conversation-only.

**(A) `DmSummary.lastMessage`** — `packages/shared/src/dm.ts`:

```ts
lastMessage: z.object({
  authorId: z.string().uuid(),
  authorName: z.string(),
  /** Already redacted and truncated by the server. Never raw markdown. */
  preview: z.string().max(140),
  /** True when the message was attachments only and preview is a label. */
  isAttachment: z.boolean(),
}).nullable(),
```

**(B) `channel-activity.preview`** — `packages/shared/src/chat.ts:282`. That
schema's comment says in as many words that it "deliberately carries no message
content — it is a notification, not a delivery". That is the right rule for
server channels and it stays. The field is added **only for `kind` of `dm` or
`group`**, optional, and the server omits it when the recipient has turned
previews off:

```ts
preview: z.string().max(140).optional(),
authorName: z.string().max(64).optional(),
```

Server-side redaction, one function, `server/src/services/dm-preview.ts`:

- strip markdown syntax to its text (reuse nothing from the client; a small
  regex pass over `**`, `*`, `` ` ``, `~~`, `>` and link syntax, keeping the
  link's label),
- collapse whitespace and newlines to single spaces,
- replace a `<@id>` mention with `@displayName` when the name is at hand, else
  drop it,
- truncate to 140 with a trailing `…`,
- an attachments-only message becomes the key-free literal the client
  translates: send `isAttachment: true` and an empty preview, and the client
  renders `dm.preview.attachment` ("Enviou um arquivo" / "Sent a file"),
- a message whose content is only a GIF or embed uses `dm.preview.gif`
  ("Enviou um GIF" / "Sent a GIF").

Own message prefix: the client prefixes `dm.preview.you` ("você: " / "you: ")
when `authorId` is the reader. A group prefixes the author's first name plus
`": "`. A 1:1 from the other person has no prefix.

Gate: a new preference `notifications.previewInApp`, **default true**, read
server-side before the frame is built and client-side before the row renders.
See §6.

---

## 3. The in-app arrival toast

Component: `client/src/components/dm/dm-toasts.tsx` (`DmToasts`), rebuilt. Pure
stack logic moves to `client/src/lib/dm-toast-queue.ts` so it is unit-testable
without a DOM.

### 3.1 Position

| Breakpoint | Position |
|---|---|
| `>= 640px` (sm) | `fixed right-4 top-[max(1rem,env(safe-area-inset-top))]`, `items-end`, `z-40`. Directly under the incoming-call overlay, which is already `sm:right-4 sm:top-4 z-50` (`incoming-call-overlay.tsx:46`) — a ringing call always wins. |
| `< 640px` | `fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+72px)]`, `z-40`, so it sits **above** the composer rather than under the channel header where a thumb cannot reach it. |

The bottom-right corner stays free: `CornerCard` owns
`sm:right-4 sm:bottom-4` at `z-30`/`z-40` (`corner-card.tsx:139`). The toast
never enters `CORNER_HINT_ORDER`. On a phone the toast and a corner card would
collide, so **a corner card yields**: when any toast is up, `App` passes
`cornerHint === null` for the duration, the same way it already yields to the
update prompt. The card records no impression while it yields
(`docs/ONBOARDING.md` §Adding a card, rule 3).

### 3.2 Size and contents

- Width `320px` on desktop (`w-80`), full width minus the 12px gutters on a
  phone. Min height `64px`.
- `elevation-3` (surface + border + shadow as one class),
  `rounded-[var(--radius-card)]`, `p-3`, `gap-3`.
- Avatar `h-10 w-10 rounded-full`. A group shows the existing `AvatarStack`
  capped at 3.
- Line 1: sender display name, `text-sm font-semibold text-text`, truncate.
  For a group: `Ana · Mesa do RPG`, with the conversation title after a middle
  dot at `text-text-tertiary`.
- Line 2: the preview, `text-xs text-text-secondary`, **two lines max**
  (`line-clamp-2`), never more. With previews off, or with no preview on the
  frame, it falls back to the existing `notify.messages` / `notify.mentions`
  count string.
- Line 3, only when coalesced: `+ mais 2 mensagens` / `+ 2 more messages`, key
  `dmToast.more` with `_one`/`_other`, `text-[11px] text-text-tertiary`.
- No "Abrir" button. The whole card is the button — the current `dmToast.open`
  pill eats 64px of a 320px card to say what a card that is already clickable
  says by being clickable. The key is kept in the catalogue for the
  screen-reader name.
- Dismiss: `X`, `h-7 w-7`, `text-text-tertiary hover:bg-surface-2
  hover:text-text`, `aria-label` `dmToast.dismiss`. Visible always (it is a
  timed surface; hover-to-reveal loses a race with the timer).

All of it in role tokens. The current file writes `border-ink-4/70`,
`bg-ink-2`, `text-paper`, `text-paper-muted`, `bg-signal`, `text-ink` — all six
are deprecated aliases under `docs/DESIGN.md` Rule 4 and must not survive this
change.

### 3.3 Animation

- Enter: existing `animate-toast-in` (`0.26s var(--ease-emphasized)`,
  `translateX(16px) scale(0.98)` → rest). It already slides **from the right**,
  which is only correct once the toast is on the right. On a phone the same
  class is used and the 16px horizontal slide reads as a small settle; do not
  add a second keyframe set for it.
- Exit: existing `animate-toast-out` (`0.18s`), then unmount after 200ms.
- Both are already inside the `prefers-reduced-motion: reduce` block at
  `index.css:1505`, which drops them to a plain opacity change. Nothing new to
  add; do not introduce a transform outside that block.
- Reorder within the stack uses no animation. A card that moves because the one
  above it left simply moves.

### 3.4 Lifetime

- 6000ms, unchanged (`TOAST_MS`).
- **Pause on hover and on focus-within.** The remaining time is held, not
  reset: store `expiresAt` and, on `pointerleave`/`blur`, re-arm with
  `max(1500, remaining)` so a card the pointer brushed does not vanish under
  it.
- A coalesced message resets the full 6000ms.
- `document.visibilityState` going `hidden` freezes every timer; coming back
  re-arms each with 3000ms, so a tab returned to after an hour is not greeted
  by three cards from an hour ago — it shows them briefly and clears.

### 3.5 Stack, coalescing, order

- At most **3** cards (`MAX_CARDS`, unchanged). Newest on top, which on a
  top-anchored stack means **first in the DOM order**; on the phone's
  bottom-anchored stack the container is `flex-col-reverse` so newest is still
  nearest the thumb.
- One card per `channelId`. A second message from the same conversation
  updates that card in place: preview replaced with the newest message, count
  incremented, timer reset, position unchanged (it does **not** jump to the
  top — a card moving under a pointer that is about to click it is how the
  wrong conversation gets opened).
- A fourth conversation pushes the oldest card out with `animate-toast-out`.

### 3.6 Suppression

One pure function, `shouldShowArrivalToast(input): boolean`, in
`client/src/lib/dm-toast-queue.ts`. Today's `wantsActivityToast`
(`notifications.ts`) checks only `documentVisible` and `kind`, which is why a
visible-but-unfocused window currently gets **both** a toast and an OS banner.

```ts
export interface ArrivalToastInput {
  kind: ChannelKind;             // only "dm" | "group" ever toast
  channelId: string;
  selectedChannelId: string | null;
  documentVisible: boolean;      // document.visibilityState === "visible"
  windowFocused: boolean;        // document.hasFocus(), tracked by focus/blur
  level: NotificationLevel;      // resolved, most-specific-wins
  doNotDisturb: boolean;
  immersive: boolean;            // html[data-immersive-stage] is set
}
```

| Condition | Toast | OS notification | Sound |
|---|---|---|---|
| `kind === "server"` | no | per existing rules | per existing rules |
| conversation is open **and** window focused | no | no | no |
| conversation is open, window blurred | no | yes | yes |
| `level === "none"` (muted) | no | no | no |
| `doNotDisturb` | no | no | no |
| `immersive` (fullscreen watch party / call stage) | no | no | yes, if enabled |
| window not focused (tab visible or not) | **no** | yes | yes |
| visible, focused, looking elsewhere | **yes** | **no** | yes |

The last two rows are the fix. `documentVisible && windowFocused` is the toast's
territory and nothing else's; everything outside it belongs to the OS. That is
the dedupe rule in §4, stated once.

`immersive` is read from `html[data-immersive-stage]`, the attribute
`hooks/use-immersive-stage.ts` already sets and `index.css:1756` already keys
on. Do not invent a second "am I in a watch party" signal.

### 3.7 Click, keyboard, screen reader

- Click anywhere on the card body: dismiss it, `selectConversation(channelId)`,
  and focus the composer. Already wired through `onOpen`.
- `X` or `Escape`: `Escape` dismisses **all** cards (current behaviour, keep).
  Add `Escape` only firing when a card has focus **or** no dialog/menu is open,
  through the existing `lib/escape-unless-overlay.ts`.
- Swipe to dismiss on touch: horizontal `pointerdown` → `pointermove` past
  **48px** in either direction dismisses; under 48px springs back over 150ms.
  Vertical movement over 12px cancels the gesture so a page scroll is never
  eaten.
- The container is `role="region"` with `aria-label` `dmToast.region`
  ("Mensagens novas" / "New messages"). Each card is `role="status"`
  `aria-live="polite"` — never `assertive`; a DM does not interrupt a screen
  reader mid-sentence.
- Each card is reachable by Tab while it is up, and the card body is a real
  `<button>` (it already is). The card's accessible name is
  `dmToast.aria` ("Mensagem nova de {name}" / "New message from {name}") plus
  the preview when there is one.

### 3.8 Sound

There is already a DM cue: `playCue("message")` fires from
`notifications.ts` `flush()` for `dm`/`group`, gated by `SoundState.message`,
which defaults **on**. The catalogue already has
`settings.notifications.sounds.message` ("Mensagem" / "Message").

**There is no switch for it in Settings.** `SOUND_CUE_OPTIONS`
(`settings-modal.tsx:2112`) lists mention, voiceJoin, voiceLeave, incomingCall
and outgoingCall, and skips `message`. So the one sound a DM makes is the one
sound a user cannot turn off. Add the row; see §6.

The toast introduces **no second sound**. The cue and the card are two halves of
one arrival.

---

## 4. OS notifications

No new transport. The existing two are `notifications.ts` `deliver()` (live tab
or Electron) and `server/src/services/push.ts` (closed app, VAPID + APNs).

### 4.1 What fires when

The table in §3.6 is the whole answer for a live client. For a client with no
socket at all, `shouldPush` (`push.ts:504`) already decides, and its matrix is
correct as written: DND blocks, `none` blocks, a conversation message pushes at
`all` only. Nothing changes there.

### 4.2 Dedupe

One rule: **the OS carries it only when the window is not focused.** A focused
window's DM gets a toast and no banner; a blurred window's DM gets a banner and
no toast. `deliver()` is reached through `flush()`, which is reached through
`notifyChannelActivity`; add the `windowFocused` field to `ActivityContext` and
short-circuit `deliver()` when a toast was shown for the same burst. The
existing `tag: channelId` continues to collapse repeats in the OS.

### 4.3 Copy

`buildPushPayload` (`push.ts:590`) writes **hardcoded English**: `"New direct
message"`, `"Sent you a direct message"`, `"Mentioned you in a direct
message"`, `"New group message"`, `` `${author} mentioned you` ``. On a
pt-BR-first product every push notification is in the wrong language.

Fix, scoped: a two-language table in `server/src/services/push-copy.ts`, keyed
off a new `user_preferences.settings.locale` (`"pt-BR" | "en"`, written by the
client whenever the language switches, defaulting to `"pt-BR"` when absent —
the instance's own default, not the browser's). No i18next on the server; five
strings do not earn a dependency.

| Case | pt-BR | en |
|---|---|---|
| DM, details off | title `pqp`, body `Mensagem nova` | title `pqp`, body `New direct message` |
| Group, details off | title `pqp`, body `Mensagem nova em um grupo` | title `pqp`, body `New group message` |
| DM, details on | title `{author}`, body `Te mandou uma mensagem` | title `{author}`, body `Sent you a direct message` |
| DM mention/reply, details on | title `{author}`, body `Te citou em uma mensagem` | title `{author}`, body `Mentioned you in a direct message` |
| Group, details on | title `{author}`, body `Mensagem nova em um grupo` | title `{author}`, body `New message in a group chat` |
| Server mention | title `#{channel} — {server}`, body `{author} te citou` | unchanged |
| Server reply | title as above, body `{author} respondeu você` | unchanged |

**Push still carries no message text**, whatever `previewInApp` says. The two
settings are separate on purpose: an in-app toast is behind an unlocked session
the person is sitting at; a push lands on a lock screen in someone else's line
of sight. `dmDetails` stays default **false**.

### 4.4 Click-through

Unchanged and already correct: `path` is `/app/dm/<channelId>`, the service
worker's `notificationclick` focuses the client, Electron's main process raises
the window. Verify only that the path still resolves after the route changes in
this spec — it does; no route changes here.

---

## 5. Badges: one truth per fact

Two facts, two colours, and each fact is derived in exactly one place.

### 5.1 Unread messages (red)

The single source is the live `unread` map in `App.tsx`, summed by
`conversationUnreadTotals` (`lib/conversations.ts`). Every surface reads that
sum; none keeps its own.

| Surface | Shows | Notes |
|---|---|---|
| Rail Home bubble | `homeUnread.count`, red, bottom corner when requests also present | unchanged |
| Sidebar conversation row | per-conversation count, red | mentions win over count, as today |
| Tab title | `(n)` prefix via `setUnreadBadge` | **change:** it currently passes only `mentions`. For conversations the count *is* the signal — a DM has no mentions. Pass `mentions + conversationUnreadTotals().count`, capped at 99+. |
| Dock / taskbar | `getDesktop()?.setBadgeCount` | same number as the title |
| Installed PWA | **new:** `navigator.setAppBadge(n)` / `clearAppBadge()` inside `setUnreadBadge`, in a `try/catch` (absent on iOS Safari and on Firefox) | |
| Favicon dot | **no** | Rejected: a canvas-drawn favicon has to be redrawn on every count change and on every theme change, it is invisible in a pinned tab, and the title badge already answers the same question in the same strip of screen. |

### 5.2 Friend requests (accent)

Single source: `pendingActionCount(data, pendingDepoimentos)` in
`friends-model.ts`, already the one function. Surfaces per §2.6. The colour
changes on the Amigos row; nothing else about the number moves.

### 5.3 How counts clear

| Action | Clears |
|---|---|
| Opening a conversation | that conversation's row badge, its toast card, its burst, and its share of every roll-up. Already wired through `selectConversation`. |
| Reading with the window blurred | nothing. The read cursor only moves on a focused window; a background tab that happens to have a conversation selected keeps the badge. |
| Marking all read (future) | out of scope, §10 |
| Muting a conversation | the badge stops rendering (already: `muted` zeroes it), the count is **not** deleted. Unmuting shows it again. |
| Accepting or declining a request | the request counter, everywhere, on the next `friend-activity` frame |

---

## 6. Settings: one section

Everything lives in the existing **Notificações** section
(`settings-modal.tsx`, `NotificationsSection`, `section === "notifications"`).
No new section, no new modal.

Order inside the section, top to bottom:

1. **Notificações do sistema** — the permission button and state. Unchanged.
2. **Nível padrão de notificação** — the three-way. Unchanged.
3. **Mensagens diretas** — **new block**, key `settings.notifications.dm.label`
   ("Mensagens diretas" / "Direct messages"):
   - `Switch` **Mostrar o aviso no canto** / **Show the corner popup** —
     `notifications.arrivalToast`, default **true**. Hint:
     `Aparece no canto quando chega uma mensagem e você está com o pqp aberto.`
     / `Appears in the corner when a message arrives and pqp is open.`
   - `Switch` **Mostrar a prévia da mensagem** / **Show the message preview** —
     `notifications.previewInApp`, default **true**, disabled when the toast
     switch is off. Hint: `Vale no aviso do canto e na lista de conversas.` /
     `Applies to the corner popup and the conversation list.`
   - `Switch` **Notificações no celular podem dizer quem mandou** / **Phone
     notifications may name the sender** — the existing `push.dmDetails`,
     default **false**, moved here from the push block so all three DM privacy
     choices are adjacent. Hint mentions that the message text is never sent to
     a phone.
4. **Sons** — the existing block, with **`message` added to
   `SOUND_CUE_OPTIONS` as the first row**, using the catalogue key
   `settings.notifications.sounds.message` that already exists and is currently
   unreachable.
5. **Web Push** — unchanged, minus the `dmDetails` row that moved up.

**Do Not Disturb is not here.** It is a status, set from the user panel's
status menu (`components/layout/user-panel.tsx`, `use-status.ts:95`), and
duplicating it in Settings gives "leave me alone" two homes. That menu is §8. The section gets
one sentence pointing at it: `settings.notifications.dndHint` — `Não Perturbe
fica no seu status, embaixo à esquerda. Ele silencia tudo isto.` / `Do Not
Disturb lives in your status, bottom left. It silences all of this.`

**Per-conversation mute** stays exactly where it is: right-click a
conversation row → Notificações → Tudo / Só menções / Nada, through
`notificationLevelItems` and `useChannelNotificationLevel`. It already writes
the same per-channel store a server channel does; do not add a second one.

New preference keys go into `packages/shared` `notificationPreferencesSchema`
alongside `desktop`, `default`, `servers`, `channels`. Note the warning in
`notifications.ts` `toPreferences`: **every field, every time** — the store
merges one level deep, so the two new booleans must be written on every commit
or they take the others with them.

---

## 7. Phone and desktop

### 7.1 Phone, 390px

- The sidebar is a drawer at `w-[min(100%-72px,16rem)]`, so the two-line row
  gets 184px of text width. Title truncates, preview truncates, the time
  column is fixed at 34px. Verify at 390px that a 20-character display name
  plus `14:02` plus a `12` pill does not wrap.
- Toast anchors bottom (§3.1), full width minus 12px gutters, `safe-pb`.
- Swipe to dismiss is the primary gesture; the `X` stays for accessibility.
- Hit targets: every control named in this spec is `h-9` (36px) minimum with
  `p-2` around a 16px icon, and the row itself is 52px.
- The toast must never cover the composer. On a phone the composer is the
  bottom 56px plus safe area; the 72px offset in §3.1 clears it.
- Tooltips are inert on touch (`docs/DESIGN.md` §Tooltip), so the `+` needs its
  `aria-label` independent of the tooltip — pass `name` to `Tooltip`, which
  sets it.

### 7.2 Electron

- `getDesktop()?.notify` already exists and already wins over
  `new Notification()` in `deliver()`. Keep it, and keep the `path` so the main
  process can raise the window on the right conversation.
- The in-app toast **also** renders in Electron, under the same focus rule: an
  unfocused Electron window gets the native notification, a focused one gets
  the toast. `document.hasFocus()` is correct in a BrowserWindow.
- `setBadgeCount` already fires from `setUnreadBadge` and picks up the count
  change in §5.1 for free.
- Electron menu strings live in `electron/locales/` and are not touched here.

---

## 8. The user bar: status and Não perturbe

The bottom-left user bar (avatar, name, `@handle`, mic, headphones, gear) is
`client/src/components/layout/user-panel.tsx`. Most of what this section asks
for is already built there and the delta is small; what follows says exactly
which parts are new, because half of this spec being "keep it" is the useful
half.

### 8.1 What already exists

- The avatar is already a `<button aria-haspopup="menu" aria-expanded>` that
  opens a popover anchored `bottom-full left-0`, 256px wide.
- That popover already holds, in order: **Mudar nome e foto**, a separator, the
  recado field, a separator, the status choices, a separator, **Enviar
  feedback** and **Baixar o app**.
- The choices are already `role="menuitemradio"` with `aria-checked`, a
  `StatusDot` per row, a hint line under the ones that need one, and a `Check`
  on the selected row.
- `StatusDot` (`components/user/status-dot.tsx`) already draws green
  (`text-success`), amber crescent (`text-warning`), red **with a horizontal
  dash cut out of it** (`text-danger`, `<rect x=2 y=5 w=8 h=2>`) and a hollow
  ring (`text-text-muted`). Colour is never the only channel: each state has its
  own shape, cut with an SVG mask, for the one reader in twelve who cannot tell
  the first three apart by hue. **Do not add a colour or a shape; the tokens the
  addendum asks for are the ones already drawn.**
- Escape already closes the popover, through
  `lib/escape-unless-overlay.ts` so a dialog opened on top keeps the key.
- The choice is already persisted **per account, server-side**: `setManual` in
  `hooks/use-status.ts` writes `updatePreferences({ status })`, the server
  stores it at `user_preferences.settings.status`, and `server/src/ws/status.ts`
  reads it once per socket. It is the one preference in the app written
  optimistically **and rolled back with a visible error**, because "I clicked
  invisible, the write failed, nobody told me" is somebody believing they are
  hidden while they are not.

### 8.2 The delta

**Three changes. Nothing else in this file moves.**

**(a) A fourth choice, `away`.** The menu ships Online / Não perturbe /
Invisível. The addendum asks for Online / Ausente / Não perturbe.

> `packages/shared/src/status.ts` argues at length against a *manual* idle, and
> the argument is right as stated: "idle" is a measurement, and asserting a
> measurement needs a rule for whether real activity clears it, where both
> answers are wrong. The rule that dissolves it is that **manual `away` is not
> idle**. It is a declaration, it is sticky, and activity never clears it —
> exactly like `dnd`, which nobody expects typing to cancel. What was rejected
> was a manual value that shares storage and semantics with the derived one;
> what this adds is a fourth manual value that outranks the timer.

- `manualStatusSchema` gains `"away"`: `["online", "away", "dnd", "invisible"]`.
- `userStatusSchema` does **not** change. Manual `away` resolves to `idle` on
  the wire, so every reader (member list, profile card, iOS, Android) renders
  the amber crescent it already renders and no client needs a release.
- `resolveOwnStatus` (`use-status.ts`) and `externalStatus`
  (`server/src/ws/status.ts`) both gain one line, in the same order:
  `invisible → offline`, `dnd → dnd`, **`away → idle`**, else `idle ? idle :
  online`. The existing test that pins the client table against the server
  table covers the new row for free.
- The timer is untouched: a person on `online` still goes derived-idle after
  `IDLE_AFTER_MS`, and coming back clears it. A person on `away` stays away.
- `away` is **presence only**. It suppresses nothing: no toast rule, no sound
  rule, no push rule reads it. `shouldPush` keys on `dnd` and must not learn
  about `away`.

**(b) Invisível stays, and the menu has four rows, not three.** Removing it
would delete a shipped privacy control whose guarantee is enforced by the type
system (`invisible` is deliberately absent from `userStatusSchema`, so a
function returning `UserStatus` cannot leak it). The order is:

| Row | pt-BR | en | Pip | Hint |
|---|---|---|---|---|
| 1 | **Online** | **Online** | green, filled | none |
| 2 | **Ausente** | **Away** | amber crescent | `status.awayHint`: `Fica assim até você mudar. Nada é silenciado.` / `Stays until you change it. Nothing is silenced.` |
| 3 | **Não perturbe** | **Do not disturb** | red with a dash | existing `status.dndHint` |
| 4 | **Invisível** | **Invisible** | hollow ring | existing `status.invisibleHint` |

Copy keys: `status.online`, `status.dnd`, `status.invisible` and their hints all
exist. Reuse **`status.idle`** for row 2 rather than adding a key: its pt-BR is
already `Ausente`, and its **en changes from `Idle` to `Away`** so the two
languages name the same pip the same way. New key: `status.awayHint` only.

**(c) A discreet DND indicator, with a way out.** Today Não perturbe shows as a
red pip on a 12px avatar corner and nothing else, so somebody who set it three
hours ago has no way to notice that is why the app has gone quiet.

Add one chip in the user bar, immediately left of the gear:

- `h-8 w-8` ghost button, `BellOff` at `h-4 w-4`, `text-danger`.
- Rendered only when `manualStatus === "dnd"`.
- `Tooltip` with `label` `status.dnd` and `detail` `status.dndClear`
  (`Clique para voltar ao Online.` / `Click to go back to Online.`); the tooltip
  sets the accessible name, so no separate `aria-label`.
- Clicking it calls `onSetStatus("online")` directly. One click out of a mode is
  the whole reason the indicator earns its 32px.
- On `compact` (the 72px icons-only sidebar) it stacks with the other three
  controls exactly as they already stack.

**Not** on the second line under the name. That line is one identity string
(`@handle`, else the tag), and the file carries a comment about what happened
last time status words were put there: `dev_us… O…`. `invisible` is the single
exception, because there the pip itself lies.

### 8.3 Keyboard and screen reader

- The avatar is a `<button>` with `aria-haspopup="menu"` and `aria-expanded`.
  Enter or Space opens; focus moves to the first row.
- **The status rows are `role="menuitemradio"` inside a `role="group"` with
  `aria-label` `status.change`, not a listbox.** The container is a menu that
  also holds Mudar nome e foto, the recado field, Enviar feedback and Baixar o
  app; a `listbox` may only contain `option` children, so a listbox here would
  be invalid ARIA and screen readers would read the menu's other rows out of
  their container. The behaviour the addendum asks for is what changes:
  `menuitemradio` already carries single-select semantics, and the rows gain
  **roving arrow-key focus** (`ArrowDown` / `ArrowUp` wrap within the group,
  `Home` / `End` jump), which the popover does not have today.
- `Tab` leaves the group and continues through the menu's other items;
  `Shift+Tab` goes back.
- `Escape` closes and returns focus to the avatar button. Already wired, and
  already correctly deferential to an overlay opened on top.
- A click outside closes. Already wired.
- The pip's `aria-label` is the state's own word, already set by `StatusDot`,
  and the own-account pip says **Invisível** where everyone else's says
  **Offline** — two genuinely different facts, and the existing `label`
  override is how that is said. `away` needs no override: the person's own row
  and everyone else's pip mean the same thing.

### 8.4 Phone

The same menu, from the same avatar, in the drawer footer. `UserPanel` is
already passed as the `footer` prop of both `DmList` and `ChannelList`, so the
sidebar drawer at `< md` already carries it; nothing is rebuilt for the phone.

- The popover is 256px wide and anchored `bottom-full left-0` inside a drawer
  that is `min(100% - 72px, 16rem)`, so at 390px it fits with 6px to spare.
  Verify it does not clip: if it does, the fix is `left-0 right-0 w-auto` below
  `sm`, not a second component.
- The chip in (c) is a 32px target in a row of 32px targets and needs no phone
  variant.
- Tooltips are inert on touch, so the chip's meaning has to survive without
  one: the red `BellOff` beside a red pip is the redundancy, and tapping it is
  recoverable (it sets Online, which the pip confirms immediately).

---

## 9. Acceptance criteria

Run with the dev bypass and two identities (`CLAUDE.md` §A second local user):
window A is the default Dev User, window B sets
`localStorage.setItem("pqp:dev-user-suffix","bob")` before loading `/app`.

### List and header

1. [ ] The sidebar header is 56px, `Mensagens`, and the `+` and phone-close
      controls are each at least 36x36 CSS px (measure in devtools).
2. [ ] `Ctrl/Cmd+Shift+M` opens the new-conversation dialog from anywhere in
      `/app`.
3. [ ] Under the Amigos row there is a `CONVERSAS` eyebrow when at least one
      conversation exists, and no eyebrow when the list is empty.
4. [ ] A conversation row is two lines and about 52px tall, with a 32px avatar.
5. [ ] With one unread, the row's title is bold, the left marker is drawn, the
      preview line is the sender's last message, and the red pill shows `1`.
6. [ ] B sends three messages; the pill reads `3` and the preview is the
      **third** message, not the first.
7. [ ] B sends only an image; the preview reads `Enviou um arquivo`.
8. [ ] A's own last message in a conversation previews as `você: …`.
9. [ ] In a group, the preview is prefixed with the author's first name.
10. [ ] Muting a conversation (right-click → Notificações → Nada) removes the
       pill, shows a bell-off glyph, and dims the row; unmuting restores the
       pill with the count intact.
11. [ ] The `Amigos` row badge is the **accent** colour, matching the rail's
       top-corner badge, not red.
12. [ ] The `Pendentes` tab shows `Pendentes (1)` in plain text, with no red
       pill.
13. [ ] At 390px nothing in the sidebar wraps or overflows horizontally.

### Toast

14. [ ] A is looking at a server channel, window focused. B sends a DM. A card
       appears **top right on desktop**, under where an incoming call would be,
       within 500ms.
15. [ ] The card is 320px wide, shows the avatar, the sender's name, and up to
       two lines of the message.
16. [ ] Clicking the card opens that conversation and focuses the composer.
17. [ ] The `X` dismisses only that card.
18. [ ] `Escape` dismisses every card.
19. [ ] The card disappears on its own after about 6 seconds.
20. [ ] Hovering the card stops the countdown; moving away gives it at least
       1.5 more seconds.
21. [ ] A second message from the same person **updates the same card** (the
       preview changes, the count line appears, the timer restarts) and does
       not add a second card, and the card does not change position.
22. [ ] Four different people write: three cards, newest on top, the oldest
       gone.
23. [ ] With the conversation already open and the window focused, no card
       appears.
24. [ ] With the conversation open but the window blurred (click another app),
       no card appears and an OS notification does (with permission granted).
25. [ ] With the window blurred and another channel open, no card appears on
       return — the OS carried it.
26. [ ] With DND on (status menu → Não Perturbe), no card, no sound, no banner;
       the unread pill still increments.
27. [ ] With the conversation muted, no card.
28. [ ] While a watch party is in immersive fullscreen, no card.
29. [ ] With `prefers-reduced-motion: reduce` forced in devtools, the card
       fades without sliding.
30. [ ] At 390px the card is at the **bottom**, above the composer, and a
       horizontal swipe of more than 48px dismisses it while a vertical drag
       scrolls the page.
31. [ ] While a card is up, no onboarding corner card is drawn; after it goes,
       the corner card appears and only then records its impression.
32. [ ] An incoming call card and a DM card at once: the call is on top.
33. [ ] With **Mostrar a prévia da mensagem** off, the card falls back to
       `1 nova mensagem` and the sidebar preview line disappears.
34. [ ] With **Mostrar o aviso no canto** off, no card ever appears; sound and
       badges are unaffected.

### Badges and settings

35. [ ] The browser tab title reads `(1) …` for one unread DM, and clears on
       opening the conversation.
36. [ ] In the installed PWA, the app icon carries the same number (Chrome
       Android / desktop; skip on iOS).
37. [ ] Settings → Notificações has a **Mensagens diretas** block with three
       switches, and a **Mensagem** row in Sounds.
38. [ ] Turning the **Mensagem** sound off silences the DM ping and leaves the
       mention ping alone.
39. [ ] The DND hint sentence points at the status menu and there is no DND
       control in Settings.
40. [ ] Every switch survives a reload and appears on the other window after
       `/api/me` lands (preferences, not localStorage alone).

### Push copy

41. [ ] With the client in pt-BR, a push to a closed phone reads
       `Mensagem nova`, not `New direct message`.
42. [ ] With `dmDetails` on, the title is the sender's name and the body is
       `Te mandou uma mensagem`.
43. [ ] No push payload ever contains message text, with any setting.

### User bar: status and Não perturbe

47. [ ] Clicking the avatar in the bottom-left bar opens the menu; clicking it
       again, or pressing `Escape`, closes it and returns focus to the avatar.
48. [ ] The menu lists four states in order: **Online**, **Ausente**, **Não
       perturbe**, **Invisível** (en: Online, Away, Do not disturb, Invisible).
49. [ ] Each row carries its own pip **shape**, not only its colour: filled
       green, amber crescent, red with a horizontal dash, hollow ring.
50. [ ] The selected row shows a check, and the pip on the avatar changes to
       match it immediately.
51. [ ] `ArrowDown` / `ArrowUp` move between the four states and wrap; `Home`
       and `End` jump to the first and last; `Tab` leaves the group and reaches
       **Enviar feedback**.
52. [ ] A screen reader announces the group as "Mudar o seu status" and each row
       as a radio item with its checked state. Nothing is announced as a
       listbox.
53. [ ] Choosing **Ausente** turns the avatar pip amber, and it is **still
       amber after typing, clicking and moving the pointer** for a minute.
54. [ ] Choosing **Ausente** silences nothing: a DM from window B still toasts,
       still pings, and still badges.
55. [ ] In window B, the person who chose **Ausente** appears in the member list
       with the amber crescent, indistinguishable from someone who went idle on
       the timer.
56. [ ] Choosing **Não perturbe** suppresses the toast, the sound and the OS
       banner (criterion 26), and leaves the unread pill incrementing.
57. [ ] With **Não perturbe** on, a red `BellOff` chip appears in the user bar
       immediately left of the gear; hovering it explains what it is; clicking
       it sets Online and the chip disappears.
58. [ ] The chip is absent for Online, Ausente and Invisível.
59. [ ] The second line under the display name still reads `@handle` (or the
       tag) in every state except **Invisível**, which still reads "Invisível".
60. [ ] Choosing a state, reloading, and reopening the menu shows the same state
       selected; opening window B's app on the same account shows it too
       (server-side, `user_preferences.settings.status`).
61. [ ] Killing the network and choosing a state rolls the selection back and
       shows the `status.saveFailed` line inside the menu.
62. [ ] At 390px, the menu opens inside the sidebar drawer's footer, fits the
       viewport with no horizontal clipping, and every row is at least 36px
       tall.
63. [ ] No bell or inbox icon was added anywhere.

### Design system

44. [ ] `rg -n "ink-|paper|signal|bg-channel" client/src/components/dm/
       client/src/components/layout/dm-list.tsx` returns nothing.
45. [ ] `pnpm --filter @pqp/client bench:tokens` passes with `leaks: 0`.
46. [ ] `pnpm --filter @pqp/client i18n:check` passes (every new key in both
       `en` and `pt-BR`, single-brace slots, `_one`/`_other` families, no em
       dash).

### Expected automated coverage

**Vitest**

| File | Asserts |
|---|---|
| `client/src/lib/dm-toast-queue.test.ts` (new) | `shouldShowArrivalToast` over the full §3.6 table, one case per row, including the focused/blurred split that today's `wantsActivityToast` gets wrong; coalescing keeps position; the cap drops the oldest; pause holds `expiresAt`. |
| `client/src/lib/notifications.test.ts` | `deliver()` is not reached when a toast was shown for the same burst; `setUnreadBadge` includes conversation counts. |
| `client/src/lib/conversations.test.ts` | preview prefixing (`você:`, group author, none for a 1:1), attachment and GIF fallbacks, 140-char truncation. |
| `server/src/services/dm-preview.test.ts` (new) | markdown stripped, mentions resolved, newlines collapsed, 140 cap, attachment-only yields empty + `isAttachment`. |
| `server/src/services/push.test.ts` | the §4.3 copy table in both locales; no payload contains message text; `dmDetails` default false. |
| `packages/shared/src/status.test.ts` | `manualStatusSchema` accepts `away` and still refuses anything else; `userStatusSchema` is unchanged and still has no `invisible`; `externalStatus` maps `away → idle`. |
| `client/src/hooks/use-status.test.ts` | `resolveOwnStatus` for all four manual values crossed with idle true/false, pinned against the server table as it already is; activity does **not** clear `away`; `setDoNotDisturb` fires for `dnd` only and never for `away`. |
| `packages/shared/src/dm.test.ts` | `lastMessage` nullable and capped; `channel-activity` with `preview` parses for `dm`/`group` and a frame **without** it still parses (old servers). |

**Playwright**

| File | Asserts |
|---|---|
| `client/e2e/dm-toast.spec.ts` (exists, extend) | criteria 14, 16, 17, 19, 21, 23; the card is right-anchored (`boundingBox().x + width` within 24px of the viewport's right edge). |
| `client/e2e/dm-toast-suppression.spec.ts` (new) | criteria 26, 27, 33, 34 by flipping preferences over the API before loading. |
| `client/e2e/user-status-menu.spec.ts` (new) | criteria 47-53, 57, 58, 60 in one browser context; criterion 55 needs the second context the DM specs already build. |
| `client/e2e/dm-list-polish.spec.ts` (new) | criteria 5, 6, 10, 11, 12, and 13 at 390x844. |

`dm-toast.spec.ts` already builds two accounts over the API with
`Bearer dev-local-token:<suffix>`; copy that harness rather than writing a new
one.

---

## 10. Out of scope

Deliberately not in this change. Each is a separate PR.

- **Search inside the conversation list.** A filter field in the DM header is
  worth having and is a different problem (debounce, empty state, server-side
  search over participants).
- **"Marcar todas como lidas."** Needs a server route and a read-cursor
  decision per conversation; the badge rules above hold either way.
- **Typing indicator in the sidebar row.** Line 2 leaves room for it and the
  frame (`typing-broadcast`) already exists, but it needs a per-conversation
  subscription the client does not keep today.
- **Reply from the toast.** MSN did it; it needs a composer in a 320px card, a
  send path outside the open channel, and an error state with nowhere to
  render. Later, if the toast proves itself.
- **Grouping the list into Fixadas / Recentes.** Pinning already exists on the
  rail (`lib/pinned-conversations.ts`); a second grouping in the sidebar is a
  design question of its own.
- **A bell or inbox in the chrome.** Mentions and friend requests missed while
  away have no catch-up surface, and adding one is a feature with its own read
  model, not a control on the user bar.
- **Notification scheduling ("quiet hours").** DND covers the manual case.
- **Native Android and iOS parity for the toast.** Both have their own
  notification surfaces; this spec changes the server copy they read (§4.3) and
  nothing else about them.
- **A general `Toast` primitive in `ui/`.** `docs/DESIGN.md` lists it under
  Planned primitives and three surfaces now draw their own container
  (`DmToasts`, `ChannelSessionToasts`, `IncomingCallOverlay`). Extracting it is
  the right next step and is not this change — doing both at once means a
  redesign and a refactor in one diff.

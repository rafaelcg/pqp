# Watch party: one stage, one bar, one panel

Status: built 2026-09-18, passes 1 to 5 on this branch, one commit each. What each pass did not do is recorded in its section. Scope: the web client, every role (host,
co-host, guest, seatless viewer, seated audience), every state (draft,
scheduled, live, host reconnecting, host gone, ended). No schema change, no
server change. Every option, permission and wire frame stays as it is; this
plan moves controls, it does not add or remove capabilities.

Trigger: André's review of the host surface on 2026-09-18 (a live party in a
local mesh room, no picture). His words: "there's a lot wrong about this UI,
a lot of stuff can be merged into one, buttons and actions should maybe be
in a bottom bar near the composer, overall it's just very hard to use."

This is the third plan for this surface. `WATCH_PARTY_SETUP_UX.md` fixed the
draft flow. `WATCH_PARTY_PRESENTER_UI.md` (built as #538, landed via #600)
split the presenter bar from the audience bar and added the dock and the
mixer dialog. The screen this plan starts from is the output of those two,
and it still has four stacked bars, two black tiles and an empty log before
any content. The previous passes each added a well-designed layer. This one
removes layers.

## 1. The screen today, counted

Host, live, sharing, no viewers. Top to bottom:

| # | Region | What is in it | File |
|---|---|---|---|
| 1 | Channel header | `sessao`, pin, history, settings, members | `App.tsx` channel header |
| 2 | Party header | avatar, name + pencil, AO VIVO pill, viewers, link icon, options icon, Encerrar | `watch-party-panel.tsx` `LiveSurface` chrome, presenter bar |
| 3 | Status strip | health dot, "Preparando a transmissão", "Mic mudo: ninguém te ouve", Ativar mic | `watch-party-transmission.tsx` + `watch-party-mic-muted-warning` |
| 4 | Dock | Mic mutado pill + meter, Trocar, Parar de compartilhar, Áudio | `LiveSurface` dock |
| 5 | Stage | "Sua tela" tile with Fechar, "Público" tile, both black | `presenter-stage.tsx` |
| 6 | Atividade | empty log, "Nada ainda…", count chip | `presenter-stage.tsx` |
| 7 | Chat | header with three icons, empty state, composer | `App.tsx` split pane |
| 8 | User dock | avatar, second mic mute, headphones, settings | `App.tsx` sidebar |

Eight regions. Four of them are bars (1 to 4). The one thing the host has to
do next, wait for the transcode, is a grey sentence in bar 3. The mic is
controllable from bar 3, bar 4 and region 8. Nothing on the screen is the
picture the audience will see, because the "Público" tile is off by default
and "Sua tela" is a preview the host already has in the shared window.

The complete control inventory this plan was written against is in §9.
Nothing in §9 is dropped; every item is either kept where it is, moved, or
merged, and the table says which.

## 2. The rule

Discord Go Live, YouTube Live Control Room, Twitch Studio, Apple SharePlay
and Google Meet all draw the same three things:

1. **One stage.** The picture owns the screen. Every state of the broadcast
   (preparing, live, reconnecting, ended) is drawn over the picture, not in a
   bar above it.
2. **One bar.** Every action that changes the output sits in one row at the
   bottom of the stage: mute, share, camera, leave. It is the only place
   those actions exist. In fullscreen it fades.
3. **One panel.** Everything that is not the picture or an action is a side
   panel with tabs: chat, people, activity. The composer lives in the panel.

pqp has all three today, plus five things that are none of them. The plan is
to keep the three and fold the five in.

## 3. Target layout

### 3.1 Host and co-host, live

```
┌──────────────────────────────────────────────────────────┬───────────────────┐
│ ● AO VIVO  Sessão de teste ✎   👁 12 · 47 min   🔗  ⚙  [Encerrar] │  Chat  Pessoas  ⋯ │
├──────────────────────────────────────────────────────────┤                   │
│                                                          │                   │
│                                                          │                   │
│                    THE PICTURE                           │   messages        │
│           (host's share, as the audience sees it)        │                   │
│                                                          │                   │
│   ┌─────────┐                                            │                   │
│   │ you PiP │   ← optional, host's own capture           │                   │
│   └─────────┘                                            │                   │
│                                                          ├───────────────────┤
│  🎤 ▂▃▅  │ ⏹ Parar ▾ │ 📷 │ 🔊 Áudio │ ✋ 2 │ 👥 No ar 1/4 │  ⛶  │ Mensagem em sessao │
└──────────────────────────────────────────────────────────┴───────────────────┘
```

- **Header** is the channel header. The party's identity replaces the
  channel name while a party exists (the channel name goes to the tooltip
  and the breadcrumb). Facts on the left, three actions on the right: copy
  link, options, Encerrar. Pin, history, settings and members from the old
  channel header move into the `⋯` of the side panel.
- **Stage** shows what the audience sees: the `HlsWatchPlayer` at real delay
  once the transcode is up (today's "Público" monitor, promoted), the host's
  own capture before that (today's "Sua tela", demoted to a PiP toggle once
  the audience view exists). While preparing, the host's capture fills the
  stage with a spinner and one line over the bottom edge. The host never
  sees a black rectangle.
- **Bar** sits over the bottom of the stage, aligned with the composer. Left
  group is what changes the output: mic with meter, share (one button, its
  menu holds Trocar and Parar), camera when the flag allows it, Áudio
  (opens today's mixer dialog). Middle group is people: raised hands with a
  count, "No ar" with a count. Right group: fullscreen. Nothing else.
- **Panel** has tabs. Chat is the default. Pessoas holds the roster, the
  hands queue, "No ar", and "Chamar alguém". Atividade is not a tab; joins,
  reactions and hands are rendered as system lines inside Chat (§5.4).
- **Status** is drawn over the picture: a thin line at the top edge of the
  stage with the health dot and one sentence, clickable, opening today's
  transmission dialog. Grey while idle, absent while green, amber or red
  with the sentence when there is something to say. The mic warning is the
  mic button turning amber with a tooltip, not a sentence in a strip.

### 3.2 Seatless viewer, live

```
┌──────────────────────────────────────────────────────────┬───────────────────┐
│ ● AO VIVO  Sessão de teste   com Dev User bob · 👁 12    🔗 │  Chat  Pessoas    │
├──────────────────────────────────────────────────────────┤                   │
│                                                          │                   │
│                    THE PICTURE                           │                   │
│                                                          │                   │
│                                                          ├───────────────────┤
│  🔊 ─────  │ ✋ Pedir pra falar │ ❤️ 🔥 😂 │  ⛶  │ ✕ Parar de assistir │ Mensagem em sessao │
└──────────────────────────────────────────────────────────┴───────────────────┘
```

Same shell. The bar carries volume, the guest request when the host allows
it, reactions when they are on, fullscreen, and the way out. Reactions are
today's floating emoji picker, moved into the bar. The holding screen
("Segura que já vem" / "Bolhas de espera") is the stage's empty state and
keeps its copy; it just stops being a different page.

### 3.3 Guest on air

The on-air strip ("VOCÊ ESTÁ NO AR") stays, because it must not be missable,
but it is drawn as the bar itself turning red with the same three controls
(mic, camera, Sair do ar), not a second row above the stage.

### 3.4 Draft and scheduled

Out of scope for the layout. `WATCH_PARTY_SETUP_UX.md` already put the green
room in this shape (preview left, card right, one red button). What changes
here is that the green room's preview pane becomes the same stage component
as live, so going live is a state change of one surface rather than a
different component mounting.

### 3.5 Phone width

Stage on top, edge to edge, 16:9. Bar under it. Panel is the rest of the
screen with the same tabs, the composer pinned to the bottom. Fullscreen
rotates. The host on a phone cannot share (`canPutPictureUp` false); the bar
shows the same shape with share disabled and its tooltip explaining why.

## 4. Passes

Five passes. Each one ships alone, each one deletes something, and each one
leaves the screen better than it found it. Order matters: every pass relies
on the one before it having settled the region it touches.

### Pass 1: one header

Merge regions 1 and 2. Move region 3's mic warning into the mic control.

- The channel header takes `PartyIdentity` (avatar, name, rename, live pill,
  "com {host}", viewer count, uptime) when a party exists on the channel.
- Copy link, Opções and Encerrar move to the right of the channel header.
  Assumir appears in their place while the host is gone and the viewer is
  eligible.
- Pin, "Transmissões anteriores", channel settings and the member toggle
  move into a `⋯` menu at the far right. Members stays as the toggle it is
  today on non-party channels.
- The muted-mic sentence and its "Ativar mic" link are deleted. The dock's
  mic pill turns amber while muted with a share in progress; its tooltip
  is the sentence. (Pass 2 moves the pill; the state travels with it.)
- The host-gone banner stays as the only remaining strip, since it is a
  real interruption.

Deletes: the presenter bar and audience bar (`data-watch-party-bar`), the
mic-muted warning. Keeps every test id by moving it to the new element.

Risk: low. No control changes meaning, it moves 40 pixels up.

### Pass 2: one bar

Build the bottom bar and move regions 4 and 8's duplicates into it.

- New component `WatchPartyBar` positioned at the bottom of the stage,
  overlapping the picture, same height and baseline as the composer.
  (Built 2026-09-18 as `WatchPartyBarSlot`: a row in the flow under the
  picture rather than an overlay, after the overlay version climbed over
  the header whenever the stage pane was empty. The overlay returns in
  pass 5 as part of `StageChrome`, where the fade rules live.)
- Host group: mic (pill + meter, today's `data-watch-party-mic`), share
  button with menu (Compartilhar tela / Trocar / Parar de compartilhar),
  camera (only when `LIVE_HLS_CAMERA` config says yes), Áudio (mixer
  dialog). The dock is deleted.
- People group: `✋ N` opens the Pessoas tab scrolled to the hands queue
  (Pass 4 owns the tab; until then it opens today's options dialog at the
  hands section). `👥 No ar N/max` is today's `data-watch-party-guests-dock`
  button, moved.
- Right group: fullscreen (today's `useWatchFullscreen` toggle, moved out of
  the player's overlay).
- Viewer variant: volume, Pedir pra falar (`GuestRequestButton`), reactions,
  fullscreen, Parar de assistir. Delete the player-overlay copies of leave
  and fullscreen.
- Guest variant: the on-air strip's three controls, bar tinted red, the
  strip's `role=status` announcement kept as a visually hidden live region
  plus the tint.
- The sidebar user dock keeps its mic and headphones; they mirror the bar
  and are not watch-party specific. This is the one accepted duplicate: it
  is the app-wide control and Discord keeps it too.
- The generic call bar's "Watch party" button on ordinary voice channels is
  untouched; it is a different entry point on a different channel type.

Deletes: the dock, the on-air strip as a separate row, the overlay leave and
fullscreen buttons, the reactions floating picker's trigger.

Risk: medium. The bar overlaps the picture, so the fade rules from
`watch-stage.tsx` (pointer stillness, reduced motion, hidden bar swallows
the first press) apply to it. Host bar never fades outside fullscreen.

### Pass 3: one stage

Replace region 5 and the waiting placeholder with one stage that has states.

- `WatchPartyStage` renders, in order of preference: the audience view
  (`HlsWatchPlayer` at real delay, today's "Público" monitor) when a stream
  URL exists; the host's own capture when sharing but not yet streaming; the
  holding screen otherwise. One component, one `data-watch-party-stage`
  with a `state` attribute: `holding | preparing | live | reconnecting |
  ended`.
- "Sua tela" becomes a PiP toggle in the bar's share menu ("Ver minha
  captura"), default off once the audience view is up, default on before.
  Today's two `localStorage` keys keep their names.
- Status line at the top edge of the picture: health dot and sentence from
  `watch-party-transmission.tsx`'s collapsed row, click opens the same
  dialog. Absent while green.
- "Preparando a transmissão" is the `preparing` state: the host's capture
  with a spinner and the sentence over the bottom edge, above the bar.
- The holding screen (`StreamStartingSoon`, "Segura que já vem", the bubbles)
  is the `holding` state and keeps its copy. `EndedWatchStage` is `ended`.
- The go-live checklist that today repeats inside the waiting placeholder is
  deleted there; it lives in the green room only. Its one blocking rule
  (Firefox) becomes the share button's disabled tooltip.
- The mini-player (`WATCH_DOCK_BOX`, return and close) is unchanged; it is
  the stage docked, which it already is.

Deletes: `presenter-stage.tsx`'s two-monitor layout, the waiting placeholder
in `LiveSurface`, the live-surface checklist copy.

Risk: medium. The stage must survive `LiveSurface`'s "surface returns null
when a stream exists" rule, which exists so the picture belongs to the call
stage. The stage becomes that picture. This is the split surgery #538
avoided; it is the pass that makes the rest possible.

### Pass 4: one panel

Fold region 6 and the two guest systems into a tabbed panel around region 7.

- Tabs: Chat (default), Pessoas. A third tab appears only when it has
  content: Convidados while `guests !== "off"` on the host side.
- Pessoas: roster (seated, watching count), then hands queue, then "No ar",
  then "Chamar alguém" with the candidate list. This is `GuestPanel` moved
  out of its dialog and given the roster on top.
- The legacy hands list in the options dialog is deleted from the UI. The
  data (`stage.hands`, `stage.invited`) still flows through
  `withLegacyWatchPartyVoice`; the panel reads the guests shape only. This
  is the one place the plan touches something that looks like behaviour:
  it is not, because the shared schema already derives one from the other,
  and the inventory found a host today sees two different "Pedindo pra
  falar" lists for the same people.
- Atividade is deleted as a region. Joins, leaves, reactions bursts and
  hands become system lines in Chat, rendered like a Discord join message,
  collapsible with a "mostrar atividade" toggle in the panel's `⋯`. The
  "Chamar" button on a hand-raise line stays, inline.
- The chat header's three icons (split layout, collapse, hide) move to `⋯`.
- The composer is the panel's footer on every tab.
- Co-hosts stay in the options dialog. They are set once per party.

Deletes: `presenter-stage.tsx`'s activity panel, the legacy hands and
invited lists in `WatchPartyOptionsDialog`, the guests dock button's
dialog (its content moves to the tab).

Risk: medium. Chat is shared with every channel type; the system lines
need a message kind the chat list already understands, or a local overlay
of non-message rows. Prefer the overlay: no protocol change.

### Pass 5: viewer polish, the chrome, and phones

- The layers over the picture, per §10: one `StageChrome`, one z scale,
  no full-tile click targets, faded means `pointer-events-none`, and the
  clickability check in Playwright.
- Fullscreen and volume move from the player's own bar into the bar.
- Reactions in the bar with the same burst rendering on the stage.
- Fullscreen: bar fades, chat overlay toggle stays in the bar.
- Phone layout per §3.5.
- The "Entrar na call" overlay button in `watch-stage.tsx` (only rendered
  when `onJoin` is passed) is deleted from the watch party path for good,
  so the code cannot grow it back.
- Empty states: one sentence each, no bullet cards.

Deletes: the seatless join button code path for watch parties.

## 5. Decisions taken in this plan

Written down so a later pass does not reopen them.

1. **Atividade folds into Chat, not into Pessoas.** It is a timeline; a
   timeline belongs with the other timeline. Discord and Twitch both render
   joins and raids inline in chat.
2. **The host bar does not fade** outside fullscreen. A control bar that
   disappears while somebody needs it is a hang-up button that vanishes.
   The viewer bar fades, as it does today.
3. **The user dock keeps its mic.** It is the app's mute, not the party's.
   Everything else that duplicated it goes.
4. **Co-hosts stay behind the gear.** Set once, rarely changed.
5. **No new options.** Every switch, select and radio in
   `WatchPartyOptionsPanel` stays exactly where it is.
6. **Copy is unchanged** except where a sentence becomes a tooltip. New
   labels follow `WATCH_PARTY_SETUP_UX.md` §4 (pt-BR, verbs, no "call").
7. **Test ids move with their controls.** `client/e2e/watch-party.spec.ts`
   should pass with selector changes only, never with a behaviour change.

## 6. What this does not do

- No server or protocol change. Not `restarts-api` in any pass.
- No change to the transcode, the edge, or how a viewer gets a picture.
- No change to the draft green room beyond sharing the stage component.
- iOS and Android are not touched; they have their own surfaces.
- Music, raised-hands ordering, slow mode, reactions rules: unchanged.

## 7. Verification per pass

Each pass is one PR. Each PR:

1. Runs `pnpm --filter @pqp/client typecheck`, `lint`, `test`.
2. Runs `client/e2e/watch-party.spec.ts` and `dm-call-screen-share.spec.ts`.
3. Includes before/after screenshots of host, viewer and guest at desktop
   and phone width, from a local mesh party (the picture cannot be
   reproduced locally; the states around it can).
4. Lists what it deleted, by file and line count. A pass that deletes
   nothing has not finished.

The playing state (a real transcode) is verified on staging before merge,
by the operator, per `docs/EVENT_RUNBOOK.md`.

## 8. Order and size

| Pass | Files most touched | Est. size | Depends on |
|---|---|---|---|
| 1 header | `App.tsx` channel header, `watch-party-panel.tsx` bar | small | none |
| 2 bar | new `watch-party-bar.tsx`, `watch-party-panel.tsx` dock, `guests/*` strip | medium | 1 |
| 3 stage | new `watch-party-stage.tsx`, `presenter-stage.tsx`, `watch-stage.tsx`, `call-stage.tsx` split | large | 2 |
| 4 panel | new `watch-party-panel-tabs.tsx`, `guests/guest-panel.tsx`, chat list overlay | medium | 3 |
| 5 polish | `watch-stage.tsx`, reactions, phone CSS | small | 4 |

`watch-party-panel.tsx` is 2,880 lines and `call-stage.tsx` is 4,119. Pass
3 is the one that has to cut into both. Do it as its own PR with nothing
else in it.

## 9. Inventory: every control, and where it goes

Built from a full read of the watch party components on 2026-09-18. Legend
for "Goes": **keep** (same place), **move** (new place, same behaviour),
**merge** (becomes part of another control), **delete** (UI only; data and
handlers stay).

### Sidebar (`live-party-block.tsx`)

| Control | Goes |
|---|---|
| Live card (avatar, pill, name, host, viewers, uptime), click to watch | keep |
| Right-click: Limpar mensagens, Copiar ID, Transmissões anteriores | keep |
| Pending card (draft / scheduled) | keep |
| "Criar watch party" row | keep |
| History links | keep |

### Channel header (`App.tsx`)

| Control | Goes |
|---|---|
| Channel name | merge into header identity (tooltip) — pass 1 |
| Pin | move to panel `⋯` — pass 1 |
| History | move to panel `⋯` — pass 1 |
| Channel settings | move to panel `⋯` — pass 1 |
| Members toggle | keep on non-party channels; on party channels becomes the Pessoas tab — pass 4 |

### Party bar, presenter (`watch-party-panel.tsx` `LiveSurface` chrome)

| Control | Goes |
|---|---|
| `PartyIdentity`: avatar, name, rename pencil, live / reconnecting pill, viewers | move to header — pass 1 |
| Copy link (icon) | move to header — pass 1 |
| Opções (gear) | move to header — pass 1 |
| Assumir | move to header — pass 1 |
| Encerrar + ConfirmDialog | move to header — pass 1 |

### Party bar, audience

| Control | Goes |
|---|---|
| Identity, mic pill, seat controls, Sair do palco, link, Assumir | identity to header (pass 1); mic and Sair do palco to bar (pass 2) |

### Status strip

| Control | Goes |
|---|---|
| Health dot + summary + uptime (click opens transmission dialog) | move to stage top edge, absent while green — pass 3 |
| "Sem áudio", "Sem som", strain pills | merge into the same status line — pass 3 |
| "Mic mudo: ninguém te ouve" + Ativar mic | merge into mic button amber state + tooltip — pass 1 |
| Transmission dialog (stat tiles, strain, silent-audio fix, camera note, quality select, mixer summary + Ajustar, footnote) | keep as the dialog — unchanged |

### Dock

| Control | Goes |
|---|---|
| Mic pill + `DockMicLevel` meter, states off / muted / room / everyone | move to bar — pass 2 |
| Falar (audience seat speak) | move to bar — pass 2 |
| Pedir pra falar / Entrar no palco (audience) | move to bar — pass 2 |
| Compartilhar tela | merge into share button — pass 2 |
| Trocar | merge into share menu — pass 2 |
| Parar de compartilhar | merge into share menu (and the button's primary while sharing) — pass 2 |
| Áudio (mixer dialog: Padrão, output meter, mic slider, tab slider) | move to bar; dialog unchanged — pass 2 |
| Câmera (new, 2026-09-18: the host had no camera control at all under the party chrome, while `LIVE_HLS_CAMERA` already sends it to the audience) | added to bar |

### Options dialog

| Control | Goes |
|---|---|
| Convidados radios (off / invite / request) | keep |
| Chat lento select + nudge | keep |
| Reações switch | keep |
| Baixa latência switch (flag) | keep |
| Quem pode ver (fact) | keep |
| Meu mic vai no stream | keep |
| `VoiceTrackModeToggle` (flag) | keep |
| Co-host section (Promover / Tirar co-host / filter) | keep |
| Legacy hands queue ("Pedindo pra falar", Chamar, overflow) | delete from UI; Pessoas tab shows the guests queue — pass 4 |
| Legacy invited list ("No palco", Tirar) | delete from UI; Pessoas tab "No ar" — pass 4 |

### Presenter stage

| Control | Goes |
|---|---|
| "Sua tela" monitor + Mostrar prévia / Fechar | merge into stage as PiP toggle in share menu — pass 3 |
| "Público" monitor + Ver como o público / Fechar | merge into stage as the default picture — pass 3 |
| Atividade feed (hands with Chamar, joins, leaves, reaction bursts) + count chip | move to Chat as system lines — pass 4 |
| Empty copy "Nada na tela" / "Aparece quando…" | delete; stage states replace them — pass 3 |

### Waiting placeholder and holding screen

| Control | Goes |
|---|---|
| `StreamStartingSoon` captions, Radio icon, host / viewer body copy | move into stage `holding` / `preparing` states — pass 3 |
| Go-live checklist (live-surface copy) | delete; green room copy stays — pass 3 |
| Firefox block sentence | merge into share button disabled tooltip — pass 3 |
| `EndedWatchStage` two variants | move into stage `ended` state — pass 3 |

### Host-gone banner

| Control | Goes |
|---|---|
| "O host caiu" banner | keep as the one strip — pass 1 |

### Guests overlay (`guests/*`)

| Control | Goes |
|---|---|
| `GuestRequestButton` (idle / pending + Desistir + position / declined + cooldown) | move to viewer bar — pass 2 |
| `GuestInviteDialog` (Entrar no ar / Agora não) | keep |
| `GuestOnAirStrip` (dot, VOCÊ ESTÁ NO AR, Mic, Câmera, Sair do ar) | merge into bar red variant; live region kept — pass 2 |
| `GuestHeaderAvatars` | move to header beside viewers — pass 1 |
| Guests dock button "No ar N/max" | move to bar — pass 2 |
| `GuestPanel`: No ar (Tirar do ar), Pedindo pra falar (Chamar / Dispensar, overflow), Chamar alguém (candidates, filter, at-limit note) | move to Pessoas tab — pass 4 |

### Viewer stage (`watch-stage.tsx`)

| Control | Goes |
|---|---|
| `HlsWatchPlayer` cinema / mini, camera corner | keep, wrapped by stage — pass 3 |
| Fullscreen toggle | move to bar — pass 2 |
| Chat overlay toggle (fullscreen only) | move to bar, fullscreen only — pass 5 |
| Dual-device warning | keep, drawn over stage — pass 3 |
| Parar de assistir | move to bar — pass 2 |
| Entrar na call (only when `onJoin`) | delete for watch party channels — pass 5 |
| "{n} assistindo" meta | merge into header — pass 1 |
| Mini player return / close | keep |

### Call stage (`call-stage.tsx`)

| Control | Goes |
|---|---|
| Generic call controls hidden under `watchPartyChrome` | keep hidden; the bar is the replacement |
| Presenting overlay suppressed for party | keep |
| Solo-tile presenter stage substitution | replaced by `WatchPartyStage` — pass 3 |
| `PeerAudioMenu` per share tile | keep |
| "Watch party" button on ordinary voice channels | keep, out of scope |

### Sidebar user dock

| Control | Goes |
|---|---|
| Mic, headphones, settings | keep (app-wide, accepted duplicate) |

### Feature hints

| Control | Goes |
|---|---|
| `FeatureHint watchPartyViewer` | keep, anchored to the bar — pass 2 |

## 10. The layers over the picture

Added 2026-09-18 after André's note: "some buttons were not clickable
because of the overlay that appears when you hover over the stream". Mapped
from the code, not from a screenshot, because the failure is in the stacking
and the pointer rules rather than in what is visible.

### 10.1 What is drawn over a picture today

Three surfaces draw a picture, and each has its own set of layers.

**The seatless viewer's player** (`hls-watch-player.tsx`, `layout="cinema"`):

| Layer | z | Pointer | Fades | What |
|---|---|---|---|---|
| holding / dead / VOD loading | 10 | none, except the dead card | no | full-bleed state cards |
| camera PiP corner box | 30 | auto, own hover-only swap and corner buttons | no | the presenter's face |
| delay badge + LL badge | 40 | none on the box, auto on the badge | no | top left |
| slow-start notice | 40 | none | no | top left, under the badge |
| chrome: top gradient row (meta, Parar de assistir before pass 2) | 50 | container none, row auto | yes | gradient `pb-8` reaches well under the buttons |
| chrome: bottom bar (play, volume, live, fit, PiP, quality, fullscreen, and since pass 2 the party bar slot) | 50 | container none, row auto | yes | gradient `pt-10` reaches well above the buttons |
| quality menu | inside 50 | auto | pinned open | anchored `bottom-10 right-0` |
| chat overlay in fullscreen | 40 (CSS) | auto | no | right column; was 20 once and Leave fullscreen sat under it |
| reactions burst | 20 | none | no | `live-reactions-overlay.tsx` |

**The seated stage** (`call-stage.tsx`, host and guests):

| Layer | z | Pointer | Fades | What |
|---|---|---|---|---|
| top status overlay (presenter name, warnings) | 10 | container none, buttons auto | yes | hidden for the local presenter under `watchPartyChrome` |
| warning strips (mic fallback, danger) | 20 / 30 | auto | no | full-width, top |
| control bar (hidden under `watchPartyChrome`; the party bar replaces it) | 20 | container none, groups auto | yes | bottom |
| per-tile hover labels and menus (`ScreenTileFrame`, camera tiles) | 20 | auto | hover-only on pointer devices | `opacity-0` until `group-hover` |
| tile zoom target (`cursor-zoom-in`, full tile) | 1 | auto | no | **covers the whole tile**; anything in the tile below z-20 is unreachable |
| drag-to-move self tile | 10 | auto | no | |
| fullscreen container | 50 (fixed) | | | in-page fullscreen |

**The host's new stage** (`watch-party-stage.tsx`, pass 3): status pill top
left (portalled, z-30 slot), reconnecting pill top left, PiP bottom left,
self-monitor toggle top right, preparing line bottom centre. None fade. The
party bar is a row under the picture, not an overlay (pass 2, revised).

### 10.2 The rules that exist, and where they disagree

1. **Two fade systems.** `useIdleChrome` runs once in the player and once in
   the call stage, each with its own `barHovered` / `barFocused` /
   menu-open pinned set. A control that belongs to neither (a portalled
   party control, a badge) either never fades or fades with whichever
   container it landed in.
2. **Hidden chrome swallows the first press.** `swallowPressWhileHidden`
   on both bars: a press on a faded bar wakes it and is otherwise dropped.
   Correct on purpose, and exactly what "the button did not work" feels
   like from the other side, because the bar is at `opacity-0` but still
   laid out, so the pointer is on a button it cannot see.
3. **`pointer-events-none` containers with `pointer-events-auto` rows.** The
   pattern is right, but it is applied per element by hand in six places,
   and a child that forgets `pointer-events-auto` is a dead button, while a
   container that forgets `pointer-events-none` blocks the picture
   underneath (double-click, tap to toggle).
4. **Gradients wider than their buttons.** The top row pads `pb-8` and the
   bottom bar `pt-10`, both `pointer-events-auto`. Together they own about
   a third of a 16:9 picture, and a press there wakes or swallows instead
   of reaching the tile, the badge or the reaction under it.
5. **Full-tile click targets.** The seated stage's zoom target is an
   `absolute inset-0 z-[1]` button over every share tile. Every control
   inside the tile has to out-rank it, and the ones that do are at z-20 by
   convention, not by rule. This is the most likely cause of the report:
   a control drawn into a tile at the default z sits under the zoom target
   and takes no clicks.
6. **The z scale is folklore.** 1, 10, 20, 30, 40, 50 are chosen per file
   with comments explaining the last collision (`z-30 is above the pictures
   (z-20) and below the chrome (z-50)`; `z-20 sat under it, so Leave
   fullscreen could not be clicked`). Each fix is local.

### 10.3 What pass 5 does about it

Built 2026-09-18, with two of the five rules below changed by what the
code and its tests turned out to already decide.

- **One z scale**, `client/src/lib/stage-layers.ts`, imported by the
  player, the seated stage, the host stage, the mini player, the music tile,
  the reactions overlay and the party bar: `tileTarget 0 < labels/state 10
  < reactions 20 < tileControls 30 < badges 40 < chrome 50 < menus 60`, the
  fullscreen chat overlay at 45 in `index.css`. No stage file writes a
  `z-*` literal now.
- **The full-tile click target sits at the bottom.** It stays (the camera
  tile tests pin click-to-zoom, and the target is a real button for the
  keyboard), but at `z-0` and rendered before the tile's overlays, so every
  later control paints above it whether or not it sets a z of its own.
  Before, a control at the default z sat under the target's `z-[1]` and
  took no clicks; that is the most likely shape of the reported bug.
- **The player's gradients do not take the pointer.** Its top row and
  bottom bar are `pointer-events-none`; only the button groups inside are
  interactive, so a press on the picture under a gradient's reach lands on
  the picture. The seated stage's control bar keeps the pointer on its
  whole box: `dm-call-screen-share.spec.ts` pins that resting the pointer
  on the bar, padding included, holds it open, and the participant chips
  above it sit above the chrome for that reason.
- **Faded chrome keeps taking the pointer.** NOT changed, on purpose:
  `use-idle-chrome.test.ts` pins it ("a hit-target check that precedes
  the pointer move must still find the bar; the bar swallows the press
  itself while hidden"), and the reason is a thumb on the picture right
  where the hang-up button is. The plan's "faded means gone" is withdrawn.
- **The clickability check exists**: the last test in
  `client/e2e/watch-party.spec.ts` walks every awake button on the stage,
  the party header and the chat header for the host and for a seatless
  viewer with a picture, and asserts `elementFromPoint` at its centre is
  the button. Its first run caught the player bar's right-hand group
  (fullscreen, Parar de assistir) losing its pointer to the video.
- **`StageChrome` is not built.** One shared component for the three
  chrome sets would be a rewrite of two files of four thousand lines each
  for the same rules the ladder and the pointer rule already impose. Left
  for a pass of its own if the rules prove insufficient.
- **Reactions stay where they are.** There are no seatless reactions to
  move; the seated reactions bar lives inside the call stage's screen
  stage and was not moved into the party bar.
- **A seatless viewer is never offered a seat** on a watch party channel:
  `WatchChannelStage` refuses `onJoin` for one even when a caller passes
  it, so the third join button cannot grow back.

### 10.4 What is drawn over the picture now, per role

Mapped again on staging (2026-09-18, after passes 1 to 5) from André's
screenshot of the host stage: "there's still 2 sets of controls when you
hover over the stream". The host's audience view was the HLS player in
its `tile` layout, and a tile draws its own chrome (live badge, a volume
slider, fit, quality, picture-in-picture) under the party bar, reachable
by nobody. The rule that closes this class: **a stage draws one chrome,
and a player embedded in a stage draws none.** `HlsWatchPlayer` has a
`monitor` layout for that, the picture and nothing else, and the host
stage uses it.

The complete set, one row per element, after that change:

**Host and co-host** (`WatchPartyStage` inside the call stage, seated):

| Element | Where | Layer | Fades |
|---|---|---|---|
| Transmission status pill (dot, sentence folds while green) | top left, status slot | chrome | no |
| Reconnecting pill | top left, under the status | chrome | no |
| Self-monitor toggle ("Mostrar prévia" / "Fechar") | top right | in stage | no |
| Own capture, picture-in-picture | bottom left, above the bar | in stage | no |
| "Preparando a transmissão" line | bottom centre, above the bar | in stage | no |
| The bar (mic, seat, share / Trocar / Parar, Câmera, Áudio, No ar, guests) | bottom, stage slot | chrome | no |
| Audience view player | the picture | picture | draws nothing |
| Call stage's own bar (empty under the party chrome) | bottom | chrome | inert: no gradient, no pointer, only its notices |

**Seatless viewer** (`WatchChannelStage`, the player in `cinema` layout):

| Element | Where | Layer | Fades |
|---|---|---|---|
| Delay / live badge | top left | badges | no |
| Slow-start notice, dual-device warning | top left / bottom centre | badges | no |
| Top row: audience count | top right | chrome | yes |
| Bottom bar: play, volume, live, fit, PiP, quality, fullscreen, then the party slot (request, Parar de assistir) | bottom | chrome | yes |
| Camera PiP corner | a corner | tileControls | no |
| Reactions bursts | over the picture | reactions | no |

**Seated guest or audience seat** (the call stage under `watchPartyChrome`):

| Element | Where | Layer | Fades |
|---|---|---|---|
| Presenter's share tile with its own hover controls (fullscreen, pin, audio menu) | the grid | tileControls | hover |
| Zoom target | whole tile, bottom of the stack | tileTarget | no |
| Participant chips | above the bar | above chrome | with the bar |
| The bar (mic, Falar, Sair do palco, on-air strip) | bottom, stage slot | chrome | no |
| Call chrome (top status, control bar) | hidden under `watchPartyChrome`; the bar's box stays for its notices but paints nothing and takes no pointer | | |

Anything not in these three tables is a bug against §10.4.

### 10.5 The camera's corner and size

André asked (2026-09-18) for the host to choose which corner the camera
sits in and how big it is. Today both are the VIEWER's: the player draws
the camera egress as a picture-in-picture and `lib/watch-camera-pip.ts`
keeps the corner per browser, with a swap and a corner control on the
box. A host-chosen corner and size would have to travel with the stream
(a field on `LiveHlsStream`, set from the party options, honoured by web,
iOS and Android players as the default a viewer can still override).
That is a protocol change and `restarts-api`, so it is not in this PR;
the toggle is.

## 11. Open questions for Rafael

1. The status line "absent while green": does he want a permanent green
   dot as reassurance, YouTube-style? Default in this plan: absent.
2. Reactions in the viewer bar or floating over the picture as today?
   Default: in the bar, bursts over the picture.
3. Should the Pessoas tab exist on ordinary voice channels too, replacing
   the members toggle everywhere? Out of scope here, but pass 4 should not
   make it harder.

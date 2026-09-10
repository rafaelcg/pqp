# Watch party setup UX: make it as easy as pressing Go live

Status: proposal, 2026-09-10. Scope is the client only. No schema, no
server change, no new option. The state machine, the options object and
every e2e selector in `client/e2e/watch-party.spec.ts` stay as they are.

## 1. What the big products do

We looked at Twitch, YouTube Live, Kick, Discord (Go Live and Stages),
Instagram Live, TikTok LIVE, and the watch-together products (Teleparty,
Prime Video Watch Party, Disney+ GroupWatch, Hulu, SharePlay). The findings
that matter for us:

1. **Preview before broadcast, always.** YouTube's "Ready to go live?" step,
   TikTok and Instagram's live camera, Discord's source thumbnails. The person
   sees the picture before anyone else can.
2. **One primary action, and it is a verb.** "Go live", "Go LIVE", "Start
   party". Never two coloured buttons on the same screen. Discord's picker
   makes the confirm the only coloured element.
3. **Two steps at most, and step one is "what am I sharing".** Nobody asks
   for options before there is a source. Discord Go Live is exactly two
   decisions: which window, and with sound. Then one button.
4. **Disclosure by frequency of change, not by difficulty.** Things you
   touch every stream sit one click away; things you set once live in a
   settings tree. YouTube collapses latency, DVR and chat rules under
   "Advanced". Instagram puts every optional control on a side rail of icons
   over the preview, and never blocks the button on any of them.
5. **Almost everything stays editable live.** Title, category, chat mode,
   share quality, moderators. Only irreversible things lock.
6. **Moderators are added in the moment, from the person.** Twitch: click a
   name in chat, "Add Moderator". Instagram: while live. Only TikTok
   pre-loads them, because it has no dashboard to do it from later.
7. **Safe silent defaults.** Muted autoplay with an obvious unmute, quality
   Auto, host-only control on by default (Teleparty).
8. **"Announced but no picture yet" is a real screen, not a spinner.**
   YouTube's scheduled page has a countdown, a reminder bell and chat already
   open so people gather before the video exists.
9. **A live player owes the viewer two controls: unmute and jump to live.**
   Everything else is a secondary menu.
10. **The heavyweight native watch parties died** (Prime, April 2024;
    Disney+ GroupWatch, 2023). The survivor, Teleparty, is: open the video,
    click, "Start party", copy link, paste in your chat app.

Sources are at the end.

## 2. Where we are

The pieces already exist and the model is right (a party is an event, the
channel is the room, the stream is separate). What is wrong is the setup
screen, which puts every decision on the table at once.

On the setup screen today (`watch-party-panel.tsx:369`):

- Preview pane, empty, with "Escolher o que compartilhar".
- A 72-unit right rail with: name field, "Voz" select, "Chat lento" select,
  "Reações ao vivo" checkbox, "Quem pode ver" details, then a co-host block
  with a search box and five people each with a full-width green "Promover"
  button, plus "Mais 11 pessoas".
- A feature-hint card floating over the preview.
- A bottom bar with "Ainda não tá no ar", a long hint sentence, "Descartar"
  and a red "Ir ao vivo".

Specific problems, grounded in the code:

| Problem | Where |
|---|---|
| Five green "Promover" buttons are the most prominent thing on screen. Co-hosts are the rarest decision, and every product adds them in the moment. | `watch-party-cohosts.tsx:237` |
| "Ir ao vivo" is enabled with no source picked. Gate is `busy` only. A host can go live to a black screen, which is the exact bug the docs call out. | `watch-party-panel.tsx:616` |
| Two coloured buttons compete: green "Promover" x5 and red "Ir ao vivo". | rail vs bottom bar |
| Voice, chat lento and reactions are shown as form controls with helper text, before there is a picture. Defaults are already right (`voiceEnabled=false`, `slowMode=0`, `reactions=true`). | `watch-party-options.tsx:121` |
| On narrow screens the whole rail is `hidden sm:block`: name, options and co-hosts vanish with no replacement. | `watch-party-panel.tsx:522` |
| The hint card ("Nova watch party: você monta...") repeats what the status bar already says. | `watch-party-panel.tsx:630` |
| The "Antes de transmitir" disclosure appears before the picker has even been opened, and the host-ack sheet can appear again at go-live. Two interruptions for one promise. | `App.tsx:3803`, `startScreenShareGated` |
| Nothing on the setup or live screen lets the host share the party. For a Brazilian crew the announcement goes on WhatsApp; today they have to copy the URL bar. | none |

## 3. Target flow

Three screens, each with one job and one coloured button.

### 3.1 Create (dialog, keep as is)

"Criar watch party" → name, optional "Marcar uma hora" → **Montar**.
Already right. One change: pre-fill the name with a suggestion based on the
weekday ("Sessão de sábado"), selected, so Enter works on an empty head.

### 3.2 Montar (setup, the redesign)

Layout, desktop:

```
+----------------------------------------------------------+-----------+
| ● Só você tá vendo isso            Teste sábado  [editar] |           |
|                                                          |  chat     |
|              [ preview, or the empty state ]             |  (as      |
|                                                          |  today)   |
|                                                          |           |
| ■ Voz desligada · Reações ligadas · Chat normal  Ajustar |           |
+----------------------------------------------------------+           |
| Descartar        [Copiar link]      [ Ir ao vivo ]        |           |
+----------------------------------------------------------+-----------+
```

Step order matches Discord: source first, then the button.

1. **Empty state** is the only thing on the preview: icon, "Nada
   escolhido ainda", one big neutral button "Escolher o que compartilhar",
   and one line under it: "Escolhe a aba do filme e marca compartilhar áudio
   da aba". The disclosure ("Antes de transmitir") opens **from this button**,
   once, and the picker opens on "Entendi". Nothing fires again at go-live.
2. **After the pick**: preview plays, the pill says "Só você tá vendo isso",
   a small "Trocar" sits on the preview. If the picked stream has no audio
   track, an amber line appears under the preview: "Sem áudio. Troca e marca
   compartilhar áudio da aba." (the most common failure in the QA doc, step 3).
3. **Ir ao vivo** is the only coloured button. It is disabled until a stream
   exists, with the reason as its tooltip and as the status-bar text
   ("Escolhe o que compartilhar primeiro"). Once a stream exists the status
   bar says "Quando você clicar, o bloco aparece pra todo mundo do servidor."
4. **Options collapse to one summary line** above the status bar: "Voz
   desligada · Reações ligadas · Chat normal · Todo mundo pode ver", with
   "Ajustar" opening the same options dialog the live view already has
   (`watch-party-panel.tsx:979`, testid `watch-party-options-drawer`). One
   options surface for draft and live, instead of a rail and a dialog.
5. **Co-hosts leave the setup screen.** They live in the options dialog (as
   today, `cohostSection`) and, later, on the member card ("Promover a
   co-host") the way Twitch does "Add Moderator". The summary line shows
   "Sem co-host" with the same "Ajustar" link, so it is discoverable.
6. **Copiar link** in the status bar, next to Descartar: copies
   `https://pqp.gg/app/...` for the channel, toast "Link copiado. Manda no
   grupo." On mobile it uses the Web Share sheet, which lands in WhatsApp.
7. **Name** moves onto the preview header as inline text with a pencil
   (the live bar already has `[data-watch-party-rename]`; reuse it).
8. **Drop the feature-hint card** on this screen. The status bar carries
   the same sentence.

Layout, narrow (under `sm`):

- Preview on top, status bar pinned to the bottom, options summary line
  between them. The "Ajustar" dialog is already a `Dialog`, which is a
  bottom sheet at this width.
- A phone browser cannot `getDisplayMedia`. When `screenCaptureEnvironment`
  says no, the empty state says so instead of showing a dead button: "Pra
  transmitir, abre o pqp no computador. Daqui você pode marcar a hora e
  ajustar as opções." The Ir ao vivo button stays hidden; "Marcar hora" and
  "Ajustar" stay.

### 3.3 Ao vivo (host)

Mostly as is. Two changes:

- Add "Copiar link" to the bar's right cluster, before Options.
- Keep the transmission readout collapsed by default (already so) and make
  the "silent audio" pill say what to do: "Sem som. Trocar a aba" opens the
  picker.

### 3.4 The audience, before and during

- **Scheduled / announced, no picture** (`watch-party-waiting`): make it a
  gathering screen, not a placeholder. Host avatar and name, party name,
  countdown or "Começa quando o host apertar", the "Me avisa" reminder
  toggle that already exists on sessions, and chat open beside it. The block
  at the top of the sidebar already brings people here; the screen should
  give them a reason to stay.
- **Live**: the player already does the right two things (big "Toca pra
  ligar o som", "Pular pro ao vivo"). Two defaults for our network reality:
  the quality menu starts on **Auto**, and the initial rung on a connection
  the browser reports as slow (`navigator.connection.effectiveType` of
  `3g` or worse, or `saveData`) is the lowest one, 480p, with a one-line
  toast "Começou em 480p pra não travar. Muda em Qualidade." Buffer before
  play stays generous; a 30 s delay that never stalls beats a 10 s delay
  that does.
- "Entrar na call" stays where it is. It is the one thing a viewer might
  want that is not watching.
- **The chat goes beside the film.** Twitch, YouTube and Kick all draw a
  stream the same way: video wide on the left, a narrow chat column on the
  right, and a "theatre mode" that hides everything else. A watch party
  room starts side by side on its own (its own stored choice,
  `watchOrientation`, so it never rearranges an ordinary call), with a
  340px chat minimum instead of the transcript's 560, which is what kept
  side by side from ever appearing on a laptop. A live stream steps the
  member column aside without writing the preference; the channel list
  stays, because the live party block lives in it. **Modo cinema** on the
  player folds the channel list to icons as well; Escape undoes it. Shipped.
- **Stream chat.** Beside a film the transcript takes the shape every
  stream has: no avatars, every message carries its name, `name: message`
  on one line, names always coloured (role colour first, a hue hashed from
  the id otherwise, so the same person keeps it), no timestamps, a crown
  before the host and a star before a co-host. The room decides it (a
  `watch_party` channel), not a setting; anything that is not plain text
  keeps its ordinary block under the line. Shipped.

## 4. Copy rules (pt-BR)

The whole product speaks informal Brazilian Portuguese already ("tá", "pra",
"galera"). Keep that register and these rules:

- One verb per button: Escolher, Trocar, Ajustar, Copiar link, Ir ao vivo,
  Encerrar, Descartar.
- Status lines say what happens next, not what state we are in: "Quando
  você clicar, aparece pra todo mundo" beats "Ainda não tá no ar" on its own.
- Errors say the fix: "Sem áudio. Troca e marca compartilhar áudio da aba."
- Never "stream", "broadcast", "egress". Use "transmitir", "ao vivo",
  "compartilhar".
- Numbers in copy as numerals ("480p", "30 s").

Keys go under the existing `watchParty.*` namespace in both locales; the
e2e asserts the English strings listed in section 6.

## 5. Implementation steps

Each step is one PR, and the app works after each one.

1. **Gate Ir ao vivo on a source, move the disclosure to the pick.**
   `SetupStage.goLive` requires `stream`; button `disabled` with a `title`;
   status bar text switches on `stream`. `handleWatchPartyGoLive` passes a
   flag so `startScreenShareGated` does not ask again when the setup screen
   already did. Add the no-audio warning from `stream.getAudioTracks()`.
   Smallest, highest value. Files: `watch-party-panel.tsx`, `App.tsx:3803`.
2. **Collapse the rail into the summary line plus the options dialog.**
   Extract the dialog body from `LiveSurface` (`:979`) into
   `WatchPartyOptionsDialog` used by both `SetupStage` and `LiveSurface`.
   Add `WatchPartyOptionsSummary` (pure, from `party.options` and cohost
   count). Delete the `aside`. Move the name to the preview header using the
   existing rename affordance. Drop the setup `FeatureHint`.
   Files: `watch-party-panel.tsx`, `watch-party-options.tsx`,
   `watch-party-cohosts.tsx` (unchanged internally).
3. **Copiar link** on setup and live bars. Web Share when available, clipboard
   otherwise. One helper in `client/src/lib/share-link.ts` if none exists.
4. **Narrow layout.** Stack preview / summary / status; detect
   `screenCaptureEnvironment` and swap the empty state on phones.
5. **Audience waiting screen.** Rework `watch-party-waiting` into the
   gathering layout; reuse the session reminder toggle.
6. **Player defaults for slow networks.** `hls-watch-player.tsx`: initial
   level from `navigator.connection`, toast once per session.
7. **Co-host from the member card.** Adds "Promover a co-host" to the member
   context menu when a party is active and the viewer may appoint. Last,
   because the dialog already covers the need.
8. **Modo host.** Twitch's Stream Manager, YouTube's Live Control Room and
   Kick's dashboard are the streamer's view of the room: the picture, the
   numbers, the chat and a row of one-click actions, on a page of their own.
   pqp has the pieces scattered across three surfaces (the readout on the
   bar, the options dialog with the hands queue inside it, moderation on the
   member card), and a host running a show opens all three.

   A first cut put those controls in a strip under the live bar. It read as
   debug chrome, not a dashboard, and was reverted: the controls need a
   layout of their own, not a row.

   **Not a separate site.** Twitch and YouTube can live on another domain
   because the picture comes from OBS. Here the host's share is a
   `getDisplayMedia` capture bound to this tab and their seat is a socket in
   this tab; another origin would mean re-capturing, re-joining, and two
   windows on one laptop. Discord keeps Go Live in the client for the same
   reason. So: a full-screen mode inside the SPA.

   **The route.** `/app/server/:id/channel/:cid/host`, opened from a
   "Modo host" button on the live bar (host and co-hosts only). Same tab,
   same session, same capture. The server rail, the channel list and the
   member list go away; "Sair do modo host" brings them back. Viewers never
   see any of it.

   ```
   +------------------------------------+---------------------------+
   |                                    | AGORA                     |
   |   preview (what the room sees)     | 12 assistindo · 47 min    |
   |   ● AO VIVO  · Trocar · Encerrar   | 720p · 9 s · upload ok    |
   |                                    +---------------------------+
   +------------------------------------+ AÇÕES                     |
   |                                    | Chat lento [off|10s|30s]  |
   |   chat (full height, moderation    | Reações      [on]         |
   |   one click on each message)       | Voz          [off]        |
   |                                    | Copiar link · Opções      |
   |                                    +---------------------------+
   |                                    | PALCO   fila + quem tá up |
   +------------------------------------+---------------------------+
   ```

   - **Preview** is the host's own outgoing picture (the setup surface's
     `<video>` bound to the shared stream), with the live pill, Trocar and
     Encerrar on it. Not the HLS playback: the host must see what leaves
     the machine, now, not 30 s later.
   - **Agora** is the transmission summary the bar already computes
     (`watch-party-transmission.tsx`) plus viewers and uptime. Read only.
   - **Ações**: slow mode as a segmented control (off, 10 s, 30 s; the full
     ladder stays in Opções), reactions and voice as switches, Copiar link
     and Opções. Same `onOptionsChange` as the dialog.
   - **Palco**: the hands queue and who is up, when the floor is invited.
   - **Chat** is the ordinary channel chat, full height, with the timeout
     action one click on each message (it exists on the message menu).
   - **Moderação count**: open reports on this channel. The one server
     piece: reports are instance-scoped today (`GET /api/reports/instance`),
     so it needs a server-scoped read filtered to the channel, gated on
     MODERATE_MEMBERS. Ship the mode without it first.
   - **Narrow screens:** the same route, stacked: preview, actions, chat.
   - **Not in the first cut:** a viewer list by name. Seatless viewers are a
     count on the server (`channelLive.watching`), and a roster would be a
     new endpoint and a new privacy question (an audience that can be
     enumerated is an audience that can be harassed). Decide separately.

   Client-only except the report count. About two days. Its own PR after
   this one merges, so the setup redesign is not held for it.

Steps 1 to 3 are the "really easy to use" part and can ship this week.
Steps 1 to 7 shipped in the first PR; step 8 is the follow-up.

## 6. What the e2e pins, and what changes

Keep every `data-*` and `data-testid` listed in `watch-party.spec.ts`;
the summary line and the setup options dialog reuse
`watch-party-options-drawer`, `[data-watch-party-options-toggle]`,
`[data-watch-party-voice]`, `[data-watch-party-cohosts]` and the
promote/demote attributes, so the co-host and options tests pass with the
dialog opened from setup instead of from the rail.

Text assertions to update when the copy moves: "Not live yet" (line 1036,
the status bar now carries the "pick a source first" sentence until a
stream exists), and the go-live test at 1039 and 1049, which today clicks
Ir ao vivo without a stream. That test must first inject a fake stream (the
spec already substitutes the `stream` field for the audience; the same hook
serves the host) or assert that the button is disabled, which is the new
behaviour and worth pinning.

## 7. Out of scope

- Quality as a party option (deliberately absent, `watch-party-session.ts:377`).
- Any change to `channel_sessions`, the state machine or the HLS seam.
- iOS and Android host flows (phones are viewers; the audience screen in
  3.4 applies to them).

## Sources

- YouTube live basics: https://support.google.com/youtube/answer/9227509
- YouTube latency modes: https://support.google.com/youtube/answer/7444635
- Twitch Stream Manager breakdown: https://stream-rise.com/blog/stream-manager
- Kick, how to stream: https://help.kick.com/en/articles/7066931-how-to-stream-on-kick-com
- Kick viewer and streamer controls: https://help.kick.com/en/articles/10137491-viewer-controls-streamer-controls
- Discord Go Live and screen share: https://support.discord.com/hc/en-us/articles/360040816151-Go-Live-and-Screen-Share
- Discord Stage channels FAQ: https://support.discord.com/hc/en-us/articles/1500005513722-Stage-Channels-FAQ
- TikTok LIVE help: https://www.tiktok.com/live/studio/help/article/1023/how-to-go-live-in-tiktok_en-US
- Instagram Live walkthrough: https://later.com/blog/instagram-live/
- Teleparty support: https://www.teleparty.com/support
- Prime Video Watch Party shutdown: https://www.howtogeek.com/prime-video-watch-party-shutdown/
- Disney+ GroupWatch removal: https://www.howtogeek.com/disney-quietly-removed-its-groupwatch-feature/
- Hulu Watch Party: https://help.hulu.com/article/hulu-watch-party

## 8b. The host's voice in the stream, and the seat button

Built 2026-09-10, after Andre asked whether the audience could hear him. They
could not: the transcode carried the window's audio only. Option 1 of
`WATCH_PARTY_STREAM_AUDIO.md` is now in: the browser mixes the host's mic
into the share's audio track (`lib/screen-mix.ts`), a per-computer switch
"Meu mic vai no stream" defaults on, and the live bar's mic pill says one of
four things: fora da call, mutado, só a sala ouve, todo mundo te ouve.

The seat button went with it for the people running the show: a watch party
is not a lobby. With voice off the host is seated by going live or sharing,
a co-host by Assumir; "Entrar na call" is only offered once the party has
voice on. A host who wants to chat with friends while the film plays uses a
voice channel.

Still open: OBS (step 9), via a LiveKit ingress that publishes an RTMP feed
into the room as the presenter.

## 10. The duplicates, and one control bar per state

Andre, hosting a live party on 2026-09-10: "there's 2 share screen buttons,
2 end buttons, everything is so confusing." He is right, and the reason is
structural: a watch party channel stacks THREE control surfaces that were
designed separately. The channel header (the room), the party bar (the
event), and the generic call strip (the seat). Each has its own idea of
sharing and of leaving.

### 10.1 Inventory, host on a live party, voice off

| Surface | Control | What it does | Duplicate of |
|---|---|---|---|
| channel header | `1 aqui` | seat count | the bar's "ninguém assistindo" |
| party bar | name + pencil | rename | setup name field |
| party bar | AO VIVO pill | state | the sidebar card's pill (fine) |
| party bar | mic pill | mic state, read only | the mute button bottom-left, the call strip's mute |
| party bar | Copiar link | share the link | setup status row's Copiar link (same action, one per state: fine) |
| party bar | Opções | options dialog | setup's "Ajustar" (same dialog, two labels) |
| party bar | Encerrar | ends the PARTY | the call strip's Sair, which only leaves the seat; setup's Descartar |
| party bar | Entrar na call | takes a seat | going live, Compartilhar tela and Assumir all seat you; now hidden with voice off |
| readout row | TRANSMISSÃO | stats | none |
| waiting surface | Compartilhar tela | joins and opens the picker | the call strip's share icon, the setup's Escolher |
| call strip | raise hand | asks to speak | meaningless for the host; only for invited-floor parties |
| call strip | camera | camera to the room | the stream never carries it |
| call strip | mouse cursor | cursor in the share | a share option, not a bar control |
| call strip | share icon | opens the picker | the waiting surface's button |
| call strip | share with sound icon | same, system audio | the tab picker already asks |
| call strip | Sair (red) | leaves the seat, party stays live | reads as "end"; Encerrar is the end |
| bottom-left | mic / headphones | mute, deafen | the only mute control, far from the bar |
| setup surface | Escolher / Trocar | the picker | the strip's share icon |
| setup status row | Descartar | drops the draft | Encerrar's sibling, different word |
| setup status row | Ir ao vivo | goes live | none |

Two rows of the same verb three times over, and the red button on the
strip is the wrong one to press.

### 10.2 The rule

**One control bar per state, and the generic call strip does not appear in a
watch party channel.** The seat is an implementation detail of the party
(the host holds one so the SFU can carry their share); the person never
asked for a call and must not be handed a call's furniture.

- **Draft:** preview, then one row: `Escolher o que compartilhar` /
  `Trocar`, `Copiar link`, `Opções`, `Descartar`, `Ir ao vivo`. As today,
  with "Ajustar" renamed to "Opções" so the word is the same before and
  during.
- **Live, host:** one row on the party bar: **mic button** (the pill becomes
  the mute toggle: fora / mutado / só a sala / todo mundo te ouve, click
  mutes), `Compartilhar tela` / `Trocar` / `Parar de compartilhar`,
  `Copiar link`, `Opções`, `Encerrar`. The call strip is hidden. Leaving
  the seat without ending is not a thing a host does on purpose; closing
  the tab is handled by the host-gone flow and Assumir.
- **Live, co-host:** the same row minus Encerrar until they take over.
- **Live, viewer:** the player's own controls, `Copiar link`, and
  `Entrar na call` only when the party has voice on.
- **Voice on:** the strip is still hidden; what a seated speaker needs (mute,
  raise or lower hand, leave the stage) is on the bar, in the party's own
  words: `Sair do palco`, never `Sair`.
- **Camera and cursor** leave the watch party entirely. The stream does not
  carry a camera, and cursor is a share option that belongs in the picker
  step, not on a bar.
- **The channel header's `N aqui`** is hidden in a watch party channel; the
  bar's "N assistindo" is the number that means something.

### 10.3 Steps

1. Hide the call strip (`CallStage` compact controls) in a `watch_party`
   channel while a party exists, and move mute onto the bar's mic pill as
   a toggle. The mute button bottom-left keeps working; the bar gets the
   one that is in front of the host.
2. Share controls on the bar: `Compartilhar tela` when nothing is going
   out, `Trocar` and `Parar de compartilhar` while it is. Same handler the
   waiting surface's button uses; the waiting surface keeps its big button
   for the empty state, the bar keeps the small one always.
3. Rename setup's `Ajustar` to `Opções`. Hide the channel header count.
4. Voice-on parties: `Sair do palco`, hand up and down, on the bar.
5. Remove camera and cursor from watch party channels.

Client-only, one PR, about a day. The e2e that pin `call-stage-collapsed`
in a watch party (`watch-party.spec.ts`, the seat tests) move to the bar's
controls.

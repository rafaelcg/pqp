# Watch party: the presenter's surface

Status: 2026-09-13. §6.1 to §6.4 built on the same branch as the audience bar split, plus the live layout below. Scope: the web client, host and
co-host only, while a party is live. The audience surface is out of scope
here (the bar split landed on the same branch and is enough for now).

Trigger: Moonkase's party on 2026-09-12. The feedback was "separate the
streamer UI from the spectator UI", "volume controls for the streamer and the
film", and "the join call thing confused people". The last one was retired by
#533 before this doc. The first two are what this doc is about, and the
screenshot that started it shows the problem: seven actions on one row, the
same share button twice on the screen, and the microphone's state in three
places.

## 1. What YouTube does (Live Control Room, webcam mode)

The webcam path is the closest analogue to pqp: a browser, no encoder, share
screen built in.

- The preview is the whole left of the screen. Chat is a column on the right.
- The header holds facts, not actions: title, a red LIVE mark, elapsed time,
  views and likes. One "Edit" opens stream settings.
- The bottom of the preview is the control row: microphone mute with a small
  audio meter beside it, "SHARE SCREEN" in the middle (becomes "Stop
  sharing"), an arrow icon that copies the shareable link, and "End Stream"
  at the end.
- Stream health is a panel beside the preview, not a row above it. It is
  green until it is not.
- A compact "Live Control Panel" exists for a second monitor: views, chat, and
  nothing else.

Sources: [YouTube Help, webcam streams](https://support.google.com/youtube/answer/9228389?hl=en),
[Social Media Examiner walkthrough](https://www.socialmediaexaminer.com/how-to-easily-go-live-on-youtube-from-computer/),
[Creator Essentials, Live Control Room](https://www.creatoressentials.com/glossary/live-control-room/).

## 2. What Twitch does (Stream Manager and Twitch Studio)

Twitch splits the two jobs into two products.

- Stream Manager is the dashboard: a grid of widgets you can drag. Stream
  Health (bitrate, dropped frames, ingest, colour-coded), Quick Actions (a row
  of one-press buttons you set up once), Activity Feed, Chat, Stream Info
  (title and category, editable live). There is no End Stream button in
  Stream Manager at all. The stream ends when the encoder stops.
- Twitch Studio is the encoder: preview in the middle, chat and activity on
  the right, and a bottom bar with the things that change what goes out:
  webcam off, mic mute, speaker mute, audio levels, and an audio mixer button
  that opens meters and sliders for every source. "Start Stream" sits alone
  at the bottom.

Sources: [Stream Rise, Stream Manager](https://stream-rise.com/blog/stream-manager),
[Stream Hub, Stream Manager features](https://streamhub.world/streamer-blog/twitch/1474-best-twitch-stream-manager-features-for-live-production-and-moderation/),
[XDA, streaming with Twitch Studio](https://www.xda-developers.com/how-to-stream-on-twitch/),
[Nerd or Die, Twitch Studio](https://nerdordie.com/blog/tutorials/twitch-studio-overlays-and-settings/).

## 3. The pattern both share

1. The picture is the hero and never moves.
2. The header is facts: name, LIVE, viewers, time, health.
3. Controls that change the output (mic, screen, camera, mixer) sit together
   in one row under the picture, like a video call.
4. Exactly one labeled destructive action, isolated: End Stream.
5. Settings and the link are icons or a panel, not buttons among actions.
6. Meters are visible without opening anything.
7. Health is a colour that only demands attention when it changes.

## 4. What pqp does today

Full inventory with file and line references is in the branch's research
notes; this is the shape.

| Surface | What is there |
|---|---|
| Live bar (one row) | identity and viewer count; mic pill (also the mute button); Falar and Entrar no palco when voice is on; Compartilhar tela, or Trocar and Parar de compartilhar; Áudio (mixer dialog, new); Copiar link; Opções; Assumir; Encerrar |
| Under the bar | the mic-muted banner with Ativar mic; the host-gone strip; the Transmissão disclosure (closed by default: summary line, then five stat tiles, quality select, mixer summary, footnote) |
| Empty stage | rotating headline, caption, the go-live checklist, a second Compartilhar tela |
| Sidebar call strip | Na call, link quality, Sair da call (red), channel row, Ligar câmera, a third Compartilhar tela |
| User panel | mute and deafen, a third mute control |
| Over the presenter's own share | Esconder prévia, Parar, Tela cheia, elapsed time, uplink strain line. No HLS chrome: a presenter never sees the delay badge, the quality menu or the player volume, because they are not watching the HLS |
| Opções dialog | Voz (one select), Deixar pedir pra falar, Chat lento, Reações, Quem pode ver (fact), Meu mic vai no stream, co-hosts, the raised-hand queue, No palco |

## 5. Gaps

Numbered so the proposal can point at them.

1. No hierarchy. Seven actions on the bar carry the same weight. Encerrar is
   red, but Compartilhar tela is also filled and sits beside it.
2. Share is reachable from three places at once for a seated host: the bar,
   the empty stage, and the sidebar strip. Section 10 of the setup plan says
   the generic call strip does not appear for a watch party; that is true of
   the in-pane strip and not of the sidebar one (`App.tsx` renders it on
   `voiceState.status` alone).
3. Mute is three controls for one state: the bar pill, the banner's Ativar
   mic, and the user panel. The muted state itself renders in four places.
4. Sair da call, red, in the sidebar, is one click from Encerrar's job and
   does something else. This is the exact button section 10 named as wrong.
5. The mixer's meters are behind a click. YouTube puts a meter beside the mic
   button; Twitch Studio shows levels on the bar. Today a host learns their
   mic is low from the audience.
6. Health is a disclosure row. Collapsed, it shows one summary sentence and at
   most one pill. Open, it pushes the preview down. Neither product does this;
   both keep health beside the picture.
7. Audience count, uptime and stream state each render in two to four places.
8. No camera control at all on the watch-party bar, while the sidebar strip
   still offers Ligar câmera (the audience never sees it; the checklist says
   so).
9. The presenter has no honest view of what the audience gets. They see
   their own share at zero delay, the HLS at ten seconds is invisible to them.
   A co-host who is not sharing sees the full HLS player with delay badge and
   quality menu. The two people running the show see different pictures.

Not gaps, by decision (do not re-open):

- Opções is a dialog, not a drawer (measured: the drawer took the preview
  from 735 px to 149 px).
- The audience never joins a call. Viewer controls are out of scope here.
- Encerrar must always be reachable and must never clip or collapse.
- Voz is one select. Quality lives with the numbers it changes, not in Opções.

## 6. Proposal

Three parts, in the order they should ship.

### 6.1 Header is facts, plus one red button

Identity, AO VIVO, then one status line that absorbs the Transmissão
summary: `12 assistindo · 43 min · 720p · ~20 s atrás`, with a health dot
(green, amber, red) in front of it. The dot and the line open the details
dialog (the five tiles, quality, the footnote). Right side: link icon, gear
icon (Opções), Encerrar. Nothing else labeled. Gaps 1, 6, 7.

Assumir stays here when it applies; it is rare and it is the one time the
header needs a second action.

### 6.2 A dock under the picture

One row, always in the same place, for the things that change what goes out:

| Button | States | Replaces |
|---|---|---|
| Mic | fora da call, mutado, só a sala, todo mundo; a small meter beside it | bar pill, banner's Ativar mic |
| Tela | Compartilhar, then Trocar and Parar | bar share trio, empty-stage button, sidebar strip share |
| Áudio | opens the mixer | bar Áudio, transmission's Ajustar |

The mic-muted banner survives as a sentence above the dock while presenting
muted (it decides whether the recording has a voice), but it loses its
button. Gaps 2, 3, 5.

Built: the dock is the last row of the chrome column, directly above the
split. The picture is drawn by the call stage, not by the panel, so "under
the picture" would mean moving the split; above it, in a row of its own,
keeps the same relationship with none of that surgery. The mic meter shows
only while a share is mixing, because that is the only time the mix has a
mic branch to read.

Camera is not on the dock. The audience never sees it (B6 is not built), so a
camera button here would promise something the stream does not do. Gap 8 is
closed by hiding the sidebar strip's camera for a watch party.

### 6.3 Hide the sidebar call strip for a live watch party the person runs

Section 10 already decided this. `App.tsx` needs the same `watchPartyChrome`
condition the in-pane strip uses. Sair da call goes with it. Link quality
moves into the header's health dot. Gaps 2, 4.

### 6.4 Later, not this pass

- Gap 9, what the presenter sees: a "Ver como o público" toggle that swaps the
  local share for the HLS with its delay badge. Costs a second decode on the
  host's machine and a decision about whether it counts as a viewer.
- Camera PiP in the stream (postmortem B6). Until it exists, no camera control
  on the watch-party surface.

## 7. Counting

| | Today | Proposed |
|---|---|---|
| Labeled actions on the bar | 7 (up to 9 with Falar, Assumir) | 1 (Encerrar), plus Assumir when it applies |
| Places to start a share | 3 | 1 |
| Mute controls | 3 | 1 |
| Rows between the bar and the picture | up to 3 (banner, host-gone, Transmissão) | up to 2 (banner sentence, host-gone) |
| Clicks to see the mic meter | 1 | 0 |

## 8. The live layout (built 2026-09-13)

What the presenter sees once their share is up, after the pattern of
Twitch Studio and YouTube's live view:

- The pane stops mirroring the host's tab at full size. It draws
  `WatchPartyPresenterStage`: a small monitor of the outgoing picture, a
  second monitor of what the audience gets (the HLS at its real delay,
  forced silent, opt-in because it is a second decode), and the room's
  activity under both (people arriving, raised hands with Chamar inline,
  reactions).
- Chat comes back if the host had collapsed it, and the roster column is
  put away, the same way it is for a viewer.
- The strips between the header and the picture went from five to three:
  header, one status row (health dot, summary, uptime, and the muted mic
  as the amber end of the same line with Ativar mic inline), the dock.
  The stage overlay is not drawn over the presenter's own share.
- Going live with the mic muted asks once, "Ativar o mic?", instead of a
  permanent red strip.

Gap 9 is closed by the audience monitor. Camera in the stream (B6) is
still not built, and the presenter surface still offers no camera.

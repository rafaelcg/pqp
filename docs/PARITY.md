# Client parity: Web, Electron, iOS, Android

First pass 2026-09-06 against `main` at `c268a86`; refreshed the same day
against `a6b150ff`, after the batch that landed Electron push-to-talk and a
tray, Android DM calls, Android chat and Android invites, iOS and Android
SPEAK, Android share watching on the media server, and iOS share publishing.
No code was changed for this document. Every cell was verified in the file
named beside it; where a doc and the code disagree, the code wins and the
disagreement is noted.

One thing to hold while reading the voice rows: a big room is a media-server
room **in production today**, not a future flag.
`server/src/voice/transport-policy.ts` sends every listed community, and every
server of ten or more members, to LiveKit the moment a call opens, and
`https://api.pqp.gg/ready` reports LiveKit healthy. Peer-to-peer is what is
left for DM calls and small servers.

Audience: whoever picks the next platform gap. The ranking at the bottom is
tuned for people who arrived from a Twitch watch party: voice, screen share,
the join flow and notifications come first, moderation and profile polish
after.

## How to read the cells

- **full**: the capability works the way the web does it.
- **partial**: exists, with the missing part stated.
- **missing**: nothing to point at.
- **n/a**: does not apply to the platform (a browser picker on a phone, a PWA
  install prompt in a native app).
- **unverified**: built, never run on real hardware. Treat as partial for
  planning.

Electron loads the hosted web client (`electron/main.js`, `docs/DESKTOP.md`),
so its column is "same as web" unless a row says otherwise. Only differences
are spelled out.

Paths are relative to the repo root. `ios/` means
`ios/pqp/Sources/`, `android/` means
`android/app/src/main/kotlin/gg/pqp/app/`.

## The matrix

### Text chat

| Capability | Web | Electron | iOS | Android |
|---|---|---|---|---|
| Send, receive, optimistic rows, typing | full (`client/src/hooks/use-chat.ts`) | same | full (`ios/Chat/ChatModel.swift`) | full (`android/ui/screens/ChatViewModel.kt`) |
| Markdown rendering | full: blocks, code fences, spoilers, mention chips (`client/src/lib/chat-markdown.ts`) | same | partial: inline only via `AttributedString(markdown:)`, no headings, quotes, fenced code, spoilers or mention pills (`ios/Chat/ChatView.swift` `MessageBodyText`) | full: hand-rolled Discord-shaped parser, bold, italic, strike, code, fences, quotes, links, mention runs (`android/ui/chat/ChatMarkdown.kt`, `android/ui/chat/MessageBody.kt`) |
| Formatting shortcuts (Cmd/Ctrl+B, I, E, Shift+X) | full (`client/src/lib/composer-formatting.ts`) | same | missing: plain `TextField` composer (`ios/Chat/ChatView.swift` `Composer`) | missing (`android/ui/screens/ChatScreen.kt` composer) |
| Format bar | open PR #263 | same | missing | missing |
| Emoji picker and `:shortcode:` expansion | full (`client/src/components/chat/emoji-picker-panel.tsx`, `client/src/lib/emoji-shortcodes.ts`) | same | partial: hand-built catalog of about 70 entries, no shortcodes (`ios/Chat/Pickers.swift` `EmojiCatalog`) | partial: only the fixed quick-reaction set, no picker, no shortcodes (`android/ui/screens/Reactions.kt`) |
| Reactions, who reacted | full (`client/src/components/chat/message-list.tsx`, `client/src/lib/reaction-who.ts`) | same | full (`ios/Chat/ChatView.swift` `ReactionRow`) | full, no "who reacted" (`android/ui/screens/Reactions.kt`) |
| Attachments: upload | full, any file, drag, paste (`client/src/lib/attachments.ts`) | same | partial: photos only, re-encoded JPEG, no documents, video, audio or PDF (`ios/Core/AttachmentUploader.swift`, `ios/Chat/ChatView.swift:71`) | full, any file via SAF (`android/attachments/AttachmentApi.kt`) |
| Attachments: view | full (`client/src/components/chat/attachment-grid.tsx`) | same | full: images, GIFs, video, zoom (`ios/Chat/MediaPlayerView.swift`, `ios/Media/ZoomableMediaView.swift`) | partial: images, GIFs, video via Media3; audio is a download chip (`android/ui/media/MessageMedia.kt`) |
| GIF picker | full (`client/src/components/chat/gif-picker-panel.tsx`) | same | full (`ios/Chat/Pickers.swift` `GifGrid`) | full (`android/ui/screens/ChatScreen.kt` `GifPickerSheet`; pasted links in `android/ui/media/GifLinks.kt`) |
| Replies | full (`client/src/components/chat/message-list.tsx`) | same | full (`ios/Chat/ChatView.swift` `ReplyChip`) | full (`android/ui/chat/MessageActions.kt` `ComposerTarget.Reply`, `android/ui/screens/ChatScreen.kt` `MessageActionsSheet`) |
| Threads | full (`client/src/components/chat/thread-panel.tsx`) | same | partial: derived from the last ~100 messages, no archive (`ios/Chat/ThreadViews.swift`) | missing (`android/core/Models.kt:13` ignores the field) |
| Forward | full (`client/src/components/chat/forward-dialog.tsx`) | same | missing | missing |
| Polls, `/draw` chance card, slash commands | full (`client/src/lib/slash-commands.ts`, `client/src/components/chat/poll-card.tsx`) | same | missing (renders nothing special) | partial: chance card renders (`android/ui/chat/ChanceCard.kt`), no polls, no commands |
| Mentions: autocomplete and rendering | full (`client/src/lib/mention-autocomplete.ts`, `client/src/lib/remark-mentions.ts`) | same | partial: mention counts and badges, no `@` autocomplete, no pills (`ios/Home/HomeView.swift:263`, `ios/Chat/ChatView.swift`) | partial: `@` autocomplete and mention runs in the body, no coloured pill for the reader (`android/ui/chat/MentionAutocomplete.kt`, `android/ui/chat/ChatMarkdown.kt`) |
| Slow mode | full (`client/src/components/chat/message-composer.tsx`) | same | full, with `retryAfterMs` draft restore (`ios/Chat/ChatModel.swift:319`) | missing: no `slowMode` anywhere; `message-rejected` is handled since PR #218 but no countdown (`android/core/RealtimeClient.kt`) |
| Edit and delete own message, Arrow Up edits last | full (`client/src/lib/edit-last-message.ts`) | same | full (`ios/Chat/MessageActionsOverlay.swift`) | partial: edit and delete rows in the sheet, no Arrow-Up-edits-last (`android/ui/chat/MessageActions.kt`, `android/ui/screens/ChatViewModel.kt:215`) |
| Pins | full (`client/src/components/chat/pinned-messages-panel.tsx`) | same | full (`ios/Home/ServerToolsView.swift` `PinnedMessagesView`) | full: pin / unpin row, pinned sheet, `MANAGE_MESSAGES` gate (`android/ui/chat/MessageActions.kt`, `android/ui/screens/ChatScreen.kt` `PinnedSheet`) |
| Message search | full (`client/src/components/search/search-dialog.tsx`) | same | partial: server-wide, no `from:` / `has:` filters (`ios/Home/ServerToolsView.swift` `SearchView`) | missing (people search only, `android/social/ui/PeopleSearch.kt`) |
| Link embeds | full (`client/src/components/chat/message-body.tsx`) | same | full, with a preview toggle (`ios/Chat/Pickers.swift` `EmbedCard`) | missing |
| Unread divider, read state | full (`client/src/lib/unread-divider.ts`) | same | full (`ios/Core/ReadCache.swift`) | partial: unread badges, no divider (`android/social/ui/SocialComponents.kt:215`) |
| Report a message / person / community | full (`client/src/components/chat/report-dialog.tsx`) | same | full (`ios/Home/ReportSheet.swift`) | full (`android/reports/ui/ReportSheet.kt`) |

### Social

| Capability | Web | Electron | iOS | Android |
|---|---|---|---|---|
| DMs, group DMs | full (`client/src/components/layout/dm-list.tsx`) | same | partial: 1:1 only, the picker starts one conversation with one person (`ios/Home/NewConversationView.swift`, `docs/IOS.md` "Not built yet") | full, groups up to 10 (`android/social/ui/NewConversationSheet.kt`) |
| Pinned conversations | full (`client/src/lib/pinned-conversations.ts`) | same | missing | missing |
| Friends, requests, add by tag or handle | full (`client/src/components/friends/friends-view.tsx`) | same | full (`ios/Home/FriendsView.swift`) | full (`android/social/ui/FriendsScreen.kt`) |
| Block / unblock, blocked list | full (`client/src/components/user/profile-relations.ts`) | same | full (`ios/Home/SettingsViews.swift` Blocked) | partial: block from a friend row, no blocked list screen (`android/social/ui/FriendsScreen.kt`) |
| Presence and self status (online, idle, dnd, invisible) | full (`client/src/hooks/use-status.ts`) | same | full (`ios/Home/MembersView.swift:268`, `ios/Core/APIClient.swift:538`) | partial: friends only, by 15 s polling; no self status, no presence in servers (`android/social/ui/FriendsScreen.kt:125`) |
| Member sidebar | full (`client/src/components/layout/member-sidebar.tsx`); search in open PR #262 | same | full (`ios/Home/MembersView.swift`) | missing: no members list (`android/ui/screens/ServersScreen.kt:291`) |
| User profile card | full (`client/src/components/user/user-profile-popover.tsx`) | same | full (`ios/Home/UserProfileSheet.swift`) | missing: no other-user profile screen |
| Depoimentos | full (`client/src/components/depoimentos/depoimentos-section.tsx`) | same | full (`ios/Home/DepoimentoViews.swift`) | missing (`android/social/ui/FriendsScreen.kt:163` comment) |
| Handle claim and share | full (`client/src/pages/claim-page.tsx`) | same | full (`ios/Home/SettingsViews.swift` `HandleRow`) | partial: shown, not claimable (`android/ui/screens/YouScreen.kt:220`) |
| Public profile `/@handle`, banner | full (`client/src/pages/public-profile-page.tsx`, `client/src/lib/banner-upload.ts`) | same (unknown `/@handle` lands on `/app`, `client/src/main.tsx:129`) | partial: no `@handle` deep link, others' profiles show `name#1234`, banner is a local colour band (`ios/Home/UserProfileSheet.swift:509`, `ios/Core/DeepLink.swift`) | missing: `bannerUrl` decoded, never rendered (`android/core/Models.kt:41`) |
| Communities directory | full (`client/src/components/communities/communities-view.tsx`) | same | full (`ios/Home/CommunitiesView.swift`) | missing |
| Baú / community home | full: feed, post, comment, VIP, admin (`client/src/components/community-home/community-home-feed.tsx`) | same | full read side, no post composer (`ios/Home/CommunityHomeView.swift`) | partial: read, like, comment, no composer, VIP unlock disabled (`android/bau/ui/BauScreen.kt`) |
| Game connections (Steam, Twitch, Battle.net) | full (`client/src/components/connections/connections-section.tsx`) | same, IdP hosts allowed in-window (`electron/lib/nav-policy.js`) | missing (no hits in `ios/`) | missing (`docs/ANDROID.md` "Not built") |
| Achievements, rank marks, crachá | full (`client/src/components/profile/achievements.tsx`, `client/src/components/marketing/cracha-canvas.tsx`) | same | missing | missing |

### Voice, video, screen

| Capability | Web | Electron | iOS | Android |
|---|---|---|---|---|
| Voice channel row: tap opens the view, does not join | full: a click/tap only ever selects and shows chat + stage, a genuine double click/tap joins (`touch-manipulation` on the row so a phone emits `dblclick`), Enter joins, the Entrar button, the context menu and the header call button still join (`client/src/components/layout/channel-list.tsx` `ChannelRow`). Stricter than #360, which also joined on a second tap of the already-selected row; the phones never had that either, and their one-press join is the same header button web has | same | full since #339 (`ios/`) | full since #339 (`android/app/src/main/kotlin/gg/pqp/app/ui/screens/ChannelsScreen.kt`) |
| Mesh voice, mute, deafen | full (`client/src/lib/peer-connection-manager.ts`) | same | full (`ios/Voice/VoiceClient.swift`) | full, audio measured by `getStats` but never by a human ear (`android/voice/VoiceEngine.kt`, `docs/ANDROID.md` "What is real") |
| LiveKit / SFU voice | full (`client/src/lib/livekit-session.ts`) | same | full: joins, publishes mic, receives shares and publishes one with the web's ladder (`ios/Voice/LiveKitVoiceClient.swift`, `ios/Voice/VideoQuality.swift` `sfuScreenPlan`) | partial: audio, share watching with its sound, and camera tiles; no share publish, no camera publish, no stats (`android/voice/LiveKitEngine.kt`) |
| Resume media across an API restart | full, 90 s orphan window (`client/src/lib/realtime.ts`, `client/src/hooks/use-voice.ts`) | same, plus `setBackgroundThrottling(false)` (`electron/main.js:939`) | partial: LiveKit resumes, mesh is rebuilt (`ios/Voice/VoiceModel.swift:507`) | partial: call is rebuilt, not resumed; `resumeToken` sent since PR #270 (`android/voice/VoiceController.kt`) |
| Speaking indicators | full (`client/src/hooks/use-voice.ts`) | same | full, 300 ms `audioLevel` polling (`ios/Voice/VoiceClient.swift`) | missing |
| Per-peer volume | full (`client/src/components/voice/peer-tile-controls.tsx`) | same | full (`ios/Voice/RemoteAudio.swift`) | missing |
| Push-to-talk | full, in-window only (`client/src/components/voice/use-push-to-talk.ts`) | full: global hotkey while the window is unfocused, in-window otherwise (`electron/lib/global-ptt.js`, `electron/main.js:1216`); menu has Cmd/Ctrl+Shift+M toggle mute | missing (`ios/Core/APIClient.swift:546` says `inputMode` is not modelled) | missing |
| Voice activity gate | open PR #259 (`client/src/components/layout/settings-modal.tsx`) | same | missing | missing |
| Noise suppression, echo, auto gain toggles | full (`client/src/components/layout/settings-modal.tsx`) | same | missing as settings; `.voiceChat` mode gives AEC (`ios/Voice/VoiceClient.swift`) | missing as settings; hardware NS always on (`android/voice/VoiceEngine.kt:256`) |
| Input / output device pickers | full (`client/src/lib/audio-devices.ts`) | partial: output device unsupported (`settings.voice.outputUnsupported_desktop`, `client/src/locales/en/translation.json`) | partial: speaker / earpiece toggle only (`ios/Voice/VoiceView.swift:270`) | partial: speakerphone toggle only (`android/ui/components/CallBar.kt:162`) |
| Join muted in a crowded room | full (`client/src/lib/join-muted.ts`) | same | full, as a preference (`ios/Voice/VoiceModel.swift:316`) | full (`android/voice/VoiceController.kt` `onWelcome`) |
| Server mute / deafen / disconnect / move (moderator) | full on LiveKit (`client/src/components/layout/members-panel.tsx`); mesh in open PR #223 | same | missing: no frame or action (`ios/Core/Moderation.swift:32`); receiver side in open PR #222 | full receiver side: `voice-moderation` muted / unmuted / moved / disconnected (`android/voice/VoiceController.kt`); mesh in open PR #221; no moderator UI |
| SPEAK / STREAM permission enforcement | full: listen-only join, disabled unmute, badge (`client/src/components/voice/capabilities.ts`); STREAM split in open PR #254 | same | full for SPEAK: `welcome.canSpeak` and `voice-speak-changed` lock the mic and hide share, with the web's copy (`ios/Voice/VoiceSpeakRule.swift`, `ios/Voice/VoiceView.swift:275`); STREAM not split yet | full for SPEAK (`android/voice/SpeakRule.kt`, `android/voice/VoiceController.kt:741`, `android/ui/components/CallBar.kt:147`); STREAM not split yet |
| Screen share: send | full, tab / window / screen (`client/src/components/voice/screen-share-view.tsx`) | partial: own picker with screens and windows, no tab; system picker on macOS 15+ (`electron/lib/display-sources.js`, `electron/picker/`) | unverified: ReplayKit extension built, never run on a phone; publishes on both transports (`ios/Broadcast/SampleHandler.swift`, `ios/Voice/LiveKitVoiceClient.swift:262`, `docs/IOS.md` "Device-only") | full on mesh, missing on LiveKit (`android/voice/ScreenCapture.kt`) |
| Screen share: send with sound | full (`client/src/lib/screen-capture-audio.ts`) | partial: Windows loopback only, toggle hidden on macOS and Linux (`electron/lib/display-sources.js` `captureResponse`) | missing | missing |
| Screen share: receive, with share audio | full (`client/src/components/voice/screen-stage.tsx`) | same | full, both transports (`ios/Voice/ScreenShareReceiver.swift`) | full, both transports, with share audio (`android/voice/RemoteVideoFeed.kt`, `android/voice/LiveKitEngine.kt`, `android/ui/components/RemoteVideoView.kt`) |
| Camera: receive | full, rail tiles and stage (`client/src/hooks/use-voice.ts`) | same | full, both transports (`ios/Voice/VoiceClient.swift`, `ios/Voice/LiveKitVoiceClient.swift`) | both transports, **unverified on hardware**: a strip of tiles under the call bar, tap for full screen; on LiveKit only the tiles on screen are delivered and the layer is capped per surface (`android/ui/components/CameraRail.kt`, `android/voice/CameraDemand.kt`) |
| Camera: send | full (`client/src/hooks/use-voice.ts`) | same, macOS permission prompt (`electron/main.js:501`) | full, channels and DM calls (`ios/Voice/VoiceModel.swift` `toggleCamera`) | missing, either transport |
| Video quality ladder, send and receive readouts | full (`client/src/components/voice/video-quality-menu.tsx`) | same | full for mesh (`ios/Voice/VideoQuality.swift`) | missing |
| Watch party / cinema mode | full: immersive stage, idle chrome (`client/src/hooks/use-immersive-stage.ts`); tab-share-with-sound control in open PR #258 | same, minus tab share (see send row) | missing (no hits in `ios/`) | missing (no hits in `android/`) |
| Live reactions over a share | full, behind `VITE_LIVE_REACTIONS` (off by default): a six-emoji bar on the stage, floating particles for the room, static counter chip under `prefers-reduced-motion` (`client/src/components/voice/live-reactions-overlay.tsx`, `live-reactions-bar.tsx`) | same | missing | missing |
| Stop watching one share, share volume separate from voice | full (PRs #214, #215, `client/src/components/voice/screen-stage.tsx`) | same | partial: watch or not per share; no separate share volume | missing |
| Connection quality bars, relayed badge | open PR #261 | same | missing | partial: "Silent" detection only (`android/voice/VoiceStats.kt`) |
| Connection doctor | full (`client/src/lib/connection-doctor.ts`) | same | missing | open PR #217 |
| Call rating prompt | full (`client/src/components/voice/call-rating-prompt.tsx`) | same | full (`ios/Voice/CallRating.swift`) | missing |
| DM calls, ringing, incoming banner | full (`client/src/components/dm/incoming-call-overlay.tsx`) | same | full (`ios/Voice/CallModel.swift`, `ios/Voice/CallStageView.swift`) | full while the app is open: ring frames, a ringtone that respects DND, incoming banner, accept and decline (`android/voice/CallMachine.kt`, `android/voice/Ringer.kt`, `android/ui/components/IncomingCallBanner.kt`); a ring to a closed app still needs the push server leg |
| Background audio while the app is hidden | n/a | n/a | partial: `audio` + `voip` background modes, no CallKit or PushKit (`ios/pqp/Info.plist:70`) | full: foreground service with Hang up (`android/voice/VoiceService.kt`) |

#### The `live-reaction` frames, for whoever picks this up on a phone

Two frames on the voice signalling socket, defined in
`packages/shared/src/live-reactions.ts` and handled in `server/src/ws/voice.ts`
and `server/src/ws/live-reactions.ts`.

Client to server, one tap:

```json
{ "type": "live-reaction", "channelId": "<voice channel uuid>", "emoji": "🔥" }
```

Server to the room, coalesced over 250 ms:

```json
{
  "type": "live-reactions",
  "channelId": "<voice channel uuid>",
  "items": [{ "emoji": "🔥", "count": 12 }, { "emoji": "😂", "count": 3 }],
  "seq": 41
}
```

What a native client needs, and nothing more:

- Send `live-reaction` only while it holds a peer in that room. The server
  drops it otherwise, silently, and it also drops anything past five per second
  per socket. A refusal is never announced, so do not build a retry on the
  absence of an echo.
- The emoji must be one of the six in `LIVE_REACTION_EMOJIS`. It is a closed
  set on the server too, so a seventh is a dropped frame, not a rendered one.
- On `live-reactions`, spawn `count` particles per emoji rather than one per
  frame. This is the part that is easy to get wrong: the frame is counts, not
  taps, and treating it as one tap makes a room of two hundred look like a room
  of four.
- Burst past `LIVE_REACTION_BURST_THRESHOLD` (10) reactions in one window. The
  constant is shared so the three platforms burst at the same crowd size.
- Echo the local tap immediately. A round trip plus the coalescing window is
  long enough to read as a dead button.
- Honour the platform's reduced-motion setting by drawing a static counter
  instead of particles, the way the web does. Not slower particles: none.
- Nothing is stored anywhere. A window that arrives while the app is
  backgrounded is correctly lost, and there is no history to fetch on join.

### Notifications and arrival

| Capability | Web | Electron | iOS | Android |
|---|---|---|---|---|
| In-app notifications, per-channel levels, DND | full (`client/src/lib/notifications.ts`) | same, native `notify()` with click-to-navigate (`electron/main.js:305`) | full (`ios/Home/SettingsViews.swift:35`) | partial: default level only, no per-channel level UI (`android/push/PushSettings.kt`) |
| Push when no socket is live | full: Web Push with VAPID (`client/src/lib/push.ts`) | missing: "This app cannot receive push notifications" (`translation.json` `settings.push.unsupported_desktop`) | full client side, APNs leg on the server; a real device push is unverified (`ios/Core/PushNotifications.swift`, `docs/HANDOVER.md` verification table) | partial: FCM client built, **no server leg and no Firebase project** (`android/push/PqpMessagingService.kt`, `server/src/services/push.ts` knows only `web` and `apns`) |
| Sounds | full (`client/src/lib/sounds.ts`) | same | missing: haptics only (`docs/IOS.md` parity table) | partial: channel default sound only (`android/push/PushNotifier.kt`) |
| Unread badge on the icon | n/a (tab title) | full: dock badge, taskbar flash on Windows (`electron/main.js:329`) | partial: badge comes from the payload, app never sets it | missing: in-app only |
| Update prompt | full: service worker prompt, never mid-call (`client/src/components/layout/update-prompt.tsx`) | same for the client; shell via electron-updater from GitHub Releases, silent on unsigned macOS (`electron/lib/updater.js`) | missing: no minimum-version check | missing: no Play in-app update, no sideload check (`docs/ANDROID_RELEASE.md`) |
| Invites: create, list, revoke | full (`client/src/components/layout/invite-panel.tsx`) | same | full (`ios/Home/ServerToolsView.swift:8`) | full: create, list, copy, share, revoke (`android/invites/ui/InviteSheet.kt`, `android/core/ApiClient.kt:186`) |
| Deep links: invite, DM, channel | full (`client/src/lib/app-route.ts`) | full: `pqp://` handler, single instance (`electron/main.js:354`, `client/src/components/desktop-bridge.tsx`) | full: universal links plus `pqp://`; no `@handle` or `/c/` target (`ios/Core/DeepLink.swift`) | full for invites: `pqp://` plus verified `https://pqp.gg/app/invite/` App Links (`android/AndroidManifest.xml:87`, `client/public/.well-known/assetlinks.json`, `android/push/DeepLink.kt`) |
| Onboarding, first-run card, corner hints | full (`client/src/components/onboarding/onboarding-flow.tsx`, `client/src/lib/corner-hints.ts`) | same, mobile beta card suppressed (`client/src/lib/mobile-beta-hint.ts:50`) | full: three-beat intro, first-run checklist shared with web (`ios/Onboarding/FirstRun.swift`) | missing |
| Sign-in | Clerk modal (`client/src/main.tsx`) | in-window Clerk popups; Google passkey hangs, hint dialog only (`electron/lib/passkey-hint.js`); system browser handoff in open PR #210 | Clerk native `AuthView`, Google and Apple (`ios/Core/Auth.swift`) | Clerk native `AuthView`, Google; a completed real sign-in is unverified (`android/ui/screens/SignInScreen.kt`) |
| Age gate | full (`client/src/components/user/age-gate-dialog.tsx`) | same | full (`ios/Onboarding/AgeGateView.swift`) | full (`android/ui/screens/AgeGateScreen.kt`) |
| What's New | full (`client/src/components/layout/whats-new-view.tsx`) | same | missing | missing |

### Servers, moderation, settings

| Capability | Web | Electron | iOS | Android |
|---|---|---|---|---|
| Create server, Discord import | full (`client/src/components/layout/create-server-dialog.tsx`) | same | partial: create, no import | partial: create, no import |
| Channels: create, rename, delete, categories, favorites, collapse | full (`client/src/components/layout/channel-list.tsx`, `client/src/lib/channel-favorites.ts`) | same | partial: no favorites, no drag reorder within a category (`ios/Chat/ChannelListView.swift`) | partial: read-only sectioned list (`android/ui/screens/ChannelsScreen.kt`) |
| Roles: 20 permission bits, colours, hierarchy, drag | full (`client/src/components/layout/roles-settings-section.tsx`) | same | missing: legacy owner / admin / member rank only (`ios/Core/Moderation.swift`) | missing: rank chip only (`android/ui/screens/ServersScreen.kt:273`) |
| Per-channel overwrites | full (`client/src/lib/overwrite-tristate.ts`) | same | missing | missing |
| Kick, ban, ban list, timeout, nickname | full (`client/src/components/layout/members-panel.tsx`) | same | full except nickname (`ios/Home/MembersView.swift`, `ios/Core/APIClient.swift:697`) | missing |
| Audit log | full (`client/src/components/layout/server-settings-dialog.tsx`) | same | full (`ios/Home/SettingsViews.swift:606`) | missing |
| Reports queue (instance / server) | full (`client/src/components/layout/reports-section.tsx`) | same | missing | missing |
| Incoming and outgoing webhooks | full (`client/src/components/layout/webhooks-panel.tsx`, `outgoing-webhooks-section.tsx`) | same | partial: incoming only (`ios/Home/SettingsViews.swift:796`) | missing: renders webhook authors only |
| Server identity: icon, banner, slug, community listing | full (`client/src/components/layout/server-identity-section.tsx`) | same | partial: rename only | missing |
| Server export, retention, SSO domain, ownership transfer, delete | full (`server-settings-dialog.tsx`) | same | full (`ios/Home/SettingsViews.swift:537`) | partial: leave and delete only |
| Private channel members | full (`client/src/components/layout/channel-members-panel.tsx`) | same | full (`ios/Home/ChannelMembersView.swift`) | missing |
| Settings: profile, avatar, banner | full (`client/src/components/layout/settings-modal.tsx`) | same | partial: avatar and name, no banner (`ios/Core/AvatarUploader.swift`) | missing: read-only header (`android/ui/screens/YouScreen.kt`) |
| Settings: voice | full | same, minus output device | partial: mute on join, video quality (`ios/Home/SettingsViews.swift:209`) | missing |
| Settings: appearance (theme, accent, contrast, reduced motion) | full (`client/src/lib/theme.ts`, `client/src/lib/accent.ts`) | same, theme mirrored to the shell (`electron/lib/theme-state.js`) | missing: hard-coded dark (`ios/Design/Theme.swift`) | partial: follows system light / dark, no switch (`android/ui/theme/Theme.kt`) |
| Settings: privacy (DM privacy, blocks) | full | same | full | missing |
| Settings: keyboard shortcut map | open PR #265 | same | n/a | n/a |
| LGPD export and account deletion | full (`settings-modal.tsx` data tab) | same | full (`ios/Home/AccountDataViews.swift`) | full (`android/account/ui/YourDataSection.kt`) |
| i18n | en, pt-BR (`client/src/locales/`) | same, plus shell menus (`electron/locales/`) | en, pt-BR, coverage enforced by build phase (`ios/pqp/Resources/Localizable.xcstrings`, `ios/Scripts/check-localization.py`) | en, pt-BR, nothing enforces parity (`android/app/src/main/res/values-pt-rBR/`) |
| Language switch in-app | full | same | missing (follows system) | missing (follows system) |
| Fullscreen, immersive stage | full (`client/src/lib/fullscreen.ts`) | same, `fullscreen` permission allowed (`electron/main.js:480`) | full (`ios/Voice/ScreenShareViews.swift`) | full for a share (`android/ui/components/ScreenShareView.kt`) |
| iPad / tablet layout | n/a | n/a | missing: `TARGETED_DEVICE_FAMILY: "1"`, iPhone only (`ios/project.yml`; `docs/IOS.md` says universal, the project file disagrees) | missing: phone layout only |

### Electron-only surface (nothing on web)

| Capability | State | Where |
|---|---|---|
| Native menus, Cmd/Ctrl+Shift+M toggle mute | full | `electron/main.js:366` |
| Tray, minimize to tray | full: call status, mute, deafen, leave, show, keep-in-tray, quit; hides to tray on close during a call | `electron/lib/tray-icon.js`, `electron/lib/tray-menu.js`, `electron/lib/tray-state.js`, `electron/main.js:1083` |
| Start at login | missing | nothing calls `setLoginItemSettings` |
| Global push-to-talk hotkey | full: registered while the window is unfocused | `electron/lib/global-ptt.js`, `electron/main.js:1216` |
| Auto-update of the shell | partial: unsigned macOS builds fail silently, Windows unsigned (SmartScreen) | `electron/lib/updater.js`, `electron/README.md:184` |
| System-browser sign-in | open PR #210 | `electron/lib/nav-policy.js` today keeps Clerk in-window |
| Screen picker (screens and windows, thumbnails, macOS permission deep link) | full | `electron/picker/`, `electron/lib/display-sources.js` |
| Window state, custom title bar on macOS | full | `electron/lib/window-state.js`, `client/src/components/layout/desktop-title-bar.tsx` |
| Bundled offline client (`PQP_LOAD_STATIC=1`) | broken against production CORS and Clerk | `docs/DESKTOP.md` §1 |
| App icon | missing (default Electron icon) | `docs/HANDOVER.md` "Suggested next work" 7 |

## Landed since the first pass

Every PR in this table is now merged into `main`. It is kept as a record of
which cells above moved, and of what the batch on 2026-09-06 actually
contained.

| PR | Covers | Platform |
|---|---|---|
| #223 | Server mute on mesh rooms (server side, `restarts-api`) | server |
| #222 | Server mute on mesh, receiver side | iOS |
| #221 | Server mute on mesh, receiver side | Android |
| #254 | STREAM split from SPEAK, per-channel Mute and Move, one channel settings dialog (`restarts-api`) | web + server |
| #259 | Voice activity gate so the mic is not always open | web |
| #258 | Watch party control: tab share with sound | web |
| #261 | Connection quality bars and relayed badge | web |
| #265 | Keyboard shortcut map | web |
| #263 | Composer format bar | web |
| #262 | Member sidebar search | web |
| #257 | Accessible confirms and channel announcements | web |
| #256 | Status pips in sync with the member list | web |
| #210 | Desktop sign-in in the system browser (`restarts-api`) | Electron + server |
| #217 | Connection doctor and 4401 retry | Android |
| #218 | `message-rejected`, `peer-updated`, slow mode frames, Baú read marker | Android |
| #270 | Android 0.3.0 for the LiveKit build, `resumeToken` on the mint | Android |
| #248 (merged) | Android joins LiveKit rooms | Android |
| #243 (merged) | iOS joins LiveKit rooms | iOS |
| #267, #269 | Voice registry M4 and M5, cross-instance rings and moderation | server |

## Ranked gaps

Ranking rule: a person who came from a Twitch watch party opens the app on
whatever they have in hand, joins a voice room that is probably on LiveKit
because it is crowded, expects to watch the stream and hear the room, and
expects a buzz when someone talks to them after they close the app. Anything
that breaks that arc outranks anything that only polishes it. Umami says the
audience is Windows 76%, Android 14%, iOS 6% (`docs/ANDROID.md`), which is why
Windows-flavoured Electron gaps sit higher than an equal iOS gap.

### Top 10

The numbering is the first pass's. Items 5, 6, 7 and 8 landed the same day and
are struck through below rather than deleted, so a reader can see what moved.
On the current code the top of the list is item 2, Android push.

1. **Android cannot send a share on a media-server room.** Watching one
   landed with sound (`android/voice/LiveKitEngine.kt:387,411`), so the
   remaining half is publishing: `LiveKitEngine.startScreenShare` returns
   `false` and `VoiceController.kt:762` offers the control on peer-to-peer
   rooms only, which is exactly the transport a watch party is not on. Size
   **M**. Start at `android/voice/ScreenCapture.kt` and
   `android/voice/LiveKitEngine.kt`. Reference:
   `client/src/lib/livekit-session.ts`, `ios/Voice/LiveKitVoiceClient.swift:262`.

2. **Android push has no server leg.** A phone that closes the app never
   hears about a DM, a mention or a ring. The client, the payload and the
   settings screen are built; `server/src/services/push.ts` knows `web` and
   `apns` only, and no Firebase project exists. Size **M** (server FCM v1 HTTP
   with a service account, a `fcm` member on `GET /api/push/config`, the
   `android` platform on `push_subscriptions`) plus the operator work of
   creating the project. Start at `server/src/services/push.ts`,
   `server/src/services/apns.ts` as the template, `docs/ANDROID.md` "What the
   server needs, precisely". `restarts-api`. Not covered by an open PR.

3. **iOS screen share send has never run on a phone.** The ReplayKit
   extension, App Group socket and NV12 bridge exist, and the media-server
   half now publishes through a `BufferCapturer` with the web's ladder
   (`ios/Voice/LiveKitVoiceClient.swift:262`), so the hidden-on-LiveKit half
   of this gap is closed. What is left is hardware: ReplayKit has no simulator
   equivalent, so the extension, the socket and the rotation mapping are only
   ever exercised by `-pqp.fakeScreenShare`. Size **M** to verify on a device.
   Start at `ios/Broadcast/SampleHandler.swift`,
   `ios/Voice/ScreenShareController.swift`; `docs/IOS.md` "Device-only".

4. **iOS has no moderator UI for server mute.** The three PRs this item
   asked for (#223 server, #222 iOS receiver, #221 Android receiver) are all
   merged, so the mesh half exists on every client's receiving side. The hole
   left is the acting side on iOS: **S** on top of
   `ios/Home/UserProfileSheet.swift` and `ios/Core/APIClient.swift` (the route
   is `POST /api/servers/:serverId/members/:userId/voice-mute`).

5. ~~**Android has no DM calls and no ring.**~~ Landed: ring frames,
   `CallMachine`, a DND-aware `Ringer`, an incoming banner and outgoing
   placement (`android/voice/CallFrames.kt`, `android/voice/CallMachine.kt`,
   `android/voice/Ringer.kt`, `android/ui/components/IncomingCallBanner.kt`,
   `android/ui/PqpApp.kt:237`). A ring that reaches a **closed** app is still
   gap 2's push server leg.

6. ~~**Electron push-to-talk is not global, and there is no tray.**~~
   Landed: `globalShortcut` registered while the window is unfocused
   (`electron/lib/global-ptt.js`, `electron/main.js:1216`) and a tray with call
   status, mute, deafen, leave, show and quit (`electron/lib/tray-menu.js`,
   `electron/lib/tray-state.js`). Start at login is still missing.

7. ~~**iOS and Android join a LiveKit room without the SPEAK bits.**~~
   Landed on both (`ios/Voice/VoiceSpeakRule.swift`,
   `android/voice/SpeakRule.kt`): a listen-only seat joins muted, the unmute is
   locked, share is hidden, and `voice-speak-changed` unlocks it live. The
   STREAM half of the split is still web and server only.

8. ~~**Android cannot create or show an invite.**~~ Landed: create, list,
   copy, share and revoke (`android/invites/ui/InviteSheet.kt`), plus verified
   `https://pqp.gg/app/invite/` App Links with a real
   `client/public/.well-known/assetlinks.json`.

9. **Android chat: the slow-mode countdown, and the reader's mention
   pill.** The bundle this item asked for landed, markdown, edit, delete,
   reply, pins, `@` autocomplete and the GIF picker included
   (`android/ui/chat/`). What is left is small: `slowMode` is still not
   modelled anywhere on the client, so a rejected send has no countdown, and a
   mention renders as a run rather than a coloured pill. Size **S**. Start at
   `android/core/RealtimeClient.kt` and `android/ui/chat/ChatMarkdown.kt`.

10. **No update prompt on iOS or Android, and Electron's updater is silent
    on unsigned macOS.** The web reloads itself; a phone on build 12 with the
    broken share button stays there until it happens to check TestFlight. Size
    **S** each: a `minimumClientVersion` per platform on `GET /api/me` or
    `/status.json`, a banner that deep-links to TestFlight, Play or the
    `android-beta` APK. Electron needs code signing before its updater can be
    trusted, which is an operator task, not code. Start at
    `server/src/api/me.ts`, `ios/App/PqpApp.swift`, `android/ui/PqpApp.kt`,
    `electron/lib/updater.js`. Not covered.

### Next tier, in order

11. iOS: push-to-talk and voice activity gate (missing entirely; web has PTT, #259 adds VAD).
12. Android: speaking indicators and per-peer volume (`android/voice/VoiceStats.kt` already polls stats).
13. iOS: game connections (Steam, Twitch, Battle.net) so a Twitch-linked profile shows on the phone.
14. Android: members list, kick, ban, timeout; then roles.
14b. Android: camera **send** (receive shipped; `CAMERA_LIMIT` allows eight on a media-server room).
14c. iOS and Android: **follow a room promotion** (`voice-transport-changed`). A
    mesh room whose fourth camera moves it to the SFU releases every seat that
    did not declare `SOCKET_CAPS.voiceTransportChanged` at `auth`; both native
    clients are in that group, so a phone in such a call is dropped with
    `voice-transport-unsupported { reason: "promoted" }` and has to rejoin.
    Both already run LiveKit rooms, so the missing piece is only the mid-call
    swap: declare the cap, then on the frame tear the mesh engine down and
    bring the LiveKit engine up **against the same peer id**, keeping mute,
    camera and share intent. Android's `WireProtocolTest.deliberatelyIgnored`
    holds the entry to delete when it lands. See `docs/voice-backends.md`
    "The one time a live room changes transport".
15. iOS and Android: roles and permission bits beyond owner / admin / member.
16. iOS: group DMs (API takes nine, picker takes one).
17. Android: presence in servers and a self status picker.
18. iOS: sounds (haptics only today).
19. iOS: light theme and a theme setting; Android: a theme switch.
20. Electron: screen-share audio on macOS (needs a loopback device or Electron's `audio: "loopback"` gaining macOS support), tab sharing is out of reach for a shell picker.
21. Android: onboarding and first-run card (shares the server preference iOS uses).
22. Android: Baú post composer; iOS the same.
23. Both mobile clients: What's New.
24. Electron: app icon, code signing on both platforms.

## Doc drift found on the way

- `docs/IOS.md` "Not built yet" says the target builds universal;
  `ios/project.yml` sets `TARGETED_DEVICE_FAMILY: "1"`.
- `docs/IOS.md` parity table lists screen share as done; the detailed section
  says sending has never run on a phone. The table is right about the code and
  wrong about the verification.
- `docs/ANDROID.md` "Not built" is accurate against the code as of this audit.

# Redesign inventory

Every element of the signed-in web app (`client/`, which Electron also loads), in
redesign order. The redesign goes top to bottom through this list. Status and
scores live in [`LOG.md`](./LOG.md), not here.

Built on 2026-10-26 from three read-only sweeps of `main` at `de37c1f8e`. Paths
are under `client/src/`. Counts are non-test files.

Marks used below:

- **Dup**: the same thing is built more than once. The redesign keeps one.
- **One-off**: a local control that should be a `ui/` primitive.
- **Flag**: two versions live behind a feature flag. Both need a decision.

## The numbers that shaped the order

| Fact | Count |
|---|---|
| Arbitrary text sizes (`text-[11px]` and similar) | 785 in 191 files |
| Files that use the type tokens | 1 |
| Deprecated color names (`ink`, `paper`, `signal`) in class names | about 3,500 |
| Raw `<button>` | 598 in 197 files, 195 icon-only |
| Native `title=` tooltips | 468 in 203 files |
| Avatar renderers | 1 shared (`UserAvatar`) plus 9 parallel |
| Tab implementations | 7 |
| Toast implementations | 7 |
| Phone breakpoint definitions | at least 5 |
| Largest files | `App.tsx` 15,202 lines, `voice/call-stage.tsx` 5,945, `chat/message-list.tsx` 5,131, `layout/channel-list.tsx` 4,281, `voice/hls-watch-player.tsx` 4,205 |

## 1. Tokens

Defined in `index.css` (5,024 lines), mirrored by `lib/design-tokens.ts`,
shown at `/qa/ui`, measured by `bench/theme-tokens.mjs`.

| Id | Element | Today | Notes |
|---|---|---|---|
| `t-type` | Type scale and fonts | Five `--type-*` roles, used in one file. Four families (Instrument Sans, Gabarito, Bricolage, Dela Gothic One). | 785 arbitrary sizes, 15+ distinct px values from 8 to 44. A heading rule in `index.css` forces `-0.03em` tracking on every `font-display`. |
| `t-spacing` | Spacing | Tailwind 4px scale, not redefined. | 363 arbitrary sizes, 64 arbitrary paddings and gaps. |
| `t-radius` | Radius | `--radius-tick/control/card/panel/pill`. | Used through `var()` 420 times, beside 1,300+ static `rounded-*`. |
| `t-elevation` | Elevation and shadow | `elevation-1/2/3` utilities, `--shadow-1/2/3`. | 46 uses of the levels, 80+ hand-written shadows. |
| `t-color` | Color roles, looks, light, contrast, accent hue | Role tokens plus 10 looks (Clássico, Harmony, Hearth, Night, Ocean, Catppuccin, Everforest, Halloween, Christmas, retro), light, high contrast, custom hue. | The redesign redraws Clássico. Every other look only retints roles, so it must keep working on the new structure. About 3,500 deprecated alias uses. 51 files use raw `white`/`black` (media surfaces). |
| `t-icons` | Icon size and stroke | `lucide-react`, stroke 2, sizes `h-3` to `h-5`. | Scattered `strokeWidth` overrides (1 to 3). 19 inline SVGs. |
| `t-motion` | Motion | Three durations, two curves, 69 keyframes. | Mostly consistent. |
| `t-density` | Control heights and chat density | `--control-sm/md/lg`, user chat size and gap. | Keep the user setting. |

## 2. Primitives (`components/ui/`)

Existing primitives first, then the missing ones that the sweeps found rebuilt
by hand across the app.

| Id | Primitive | Importers | Duplicates and one-offs to fold in |
|---|---|---|---|
| `p-button` | Button (default, secondary, ghost, danger; sm, default, icon) | 183 | 598 raw buttons. |
| `p-icon-button` | Icon button (new) | none | 195 icon-only raw buttons, `PostIconButton` (forum), `ChromeButton` (stories), `CHANNEL_ACTION_TILE`, `HEADER_ACTION_TILE`. |
| `p-tooltip` | Tooltip | 57 | 468 `title=` attributes. |
| `p-input` | Input, Textarea | 36, 8 | 81 raw inputs, 13 raw textareas. |
| `p-select` | Select (planned) | none | 21 native selects, `SettingsSelect`. |
| `p-checkbox` | Checkbox (planned), CheckRow, Switch | 9, 18 | 5 native checkboxes, 5 hand-rolled switches, custom `role=checkbox` in stories and new-conversation. |
| `p-radio` | RadioGroup (segmented, chips, list) | 13 | 45 custom radios in 19 files, `bots/radio-choices.tsx`, `kit/choice-grid`. |
| `p-tabs` | Tabs (planned) | none | 7 tab systems: friends, reports, all-reports, roles editor, call-split, profile popover, bot overview. |
| `p-slider` | Slider | 13 | 11 range inputs (watch player, transmission, peer audio, story text). |
| `p-menu` | Menu, ContextMenu | 15, 23 | Hand-built menus in user panel (status), video quality, watch player, composer, message list ("more" popover beside the context menu). |
| `p-popover` | Popover (new) | none | Profile popover, peer audio, soundboard, app launcher, emoji and GIF pickers, update indicator, forum tag icon picker. Each has its own portal. |
| `p-dialog` | Dialog, ConfirmDialog, PromptDialog | 50, 24, 1 | 14 `role=dialog` overlays outside it, 4 sheets, 3 native `window.prompt`/`confirm` (nickname, kick). |
| `p-sheet` | Sheet (new) | none | `story-viewers-sheet`, `schedule-session-sheet`, `hls-host-ack-sheet`, `app-join-sheet`, phone sheets in launcher, soundboard, music queue. |
| `p-toast` | Toast (planned) | none | 7 bespoke toasts plus inline `appNotice` and voice-clean toast. |
| `p-banner` | Banner / strip (new) | none | About 10 strips: connection, stale chunk, sanction, watch-now, read-only notice, inline danger/warning/success bars in `App.tsx`, arrival, bring-crew, newcomer, Discord import. |
| `p-badge` | Badge (status word), count badge (planned) | 7 | About 121 hand-made pills: `kit/badge`, command chip, thread chip, forum tag chip, live pill, viewer chip, mode chip, reaction chip, download chip, `RailPill`, `RailCountBadge`. |
| `p-avatar` | Avatar and presence | `UserAvatar` 65 | `voice-avatar`, two `BotFace`, `CommunityAvatar`, guest avatars, `OccupantFaces`, app `Avatars`, `ServerIcon`, `ChannelIcon`, `StatusDot`, story ring. |
| `p-list-row` | List row (new) | none | Channel row, thread row, member row (twice), conversation row, friend row, voice occupant row, emoji row, follow row, activity row, preview row. |
| `p-card` | Card (new) | none | Community card, forward, Baú post (three versions), chance, poll, voice note, bot action, corner card, live-preview cards. |
| `p-section-header` | Section and pane header (new) | none | Category headers (three), member sections, `kit/pane-header`, server settings `SectionHeader`. |
| `p-empty` | Empty state (new) | none | 10+ local empty states (message list, search, forum with 6 variants, conversations, friends, watch party, app launcher, communities, settings kit, no selection). |
| `p-loading` | Skeleton and spinner | Skeleton 16 | 44 `animate-spin`, local skeletons in friends, forum, communities, settings, Baú. |
| `p-scroll` | ScrollArea | 0 | Unused. Decide: adopt or delete. |
| `p-settings-kit` | Settings kit (`settings/kit/`, 28 files) | about 30 | A second primitive layer for user settings only. Its badge, notice, empty, select and switch row duplicate `ui/`. |

## 3. App shell

Top to bottom, as a person sees it. The whole shell is `MainAppContent` in `App.tsx`.

| Id | Element | Files | Variants and glued-on parts | Dup / flag |
|---|---|---|---|---|
| `s-frame` | App frame and layout | `App.tsx`, `main.tsx` (`DesktopShell`), `layout/desktop-title-bar.tsx`, `index.css` (`.app-shell`), `hooks/use-*-up.ts`, `lib/phone-tabs.ts`, sidebar width and member preferences | Resizable sidebar (200 to 420), icons-only sidebar, member column vs drawer at 1100px, thread panel in the member slot, Novidades view, directory overlay, Electron title bar, dev-bypass bar, retro layer | Phone breakpoint defined 3 ways here alone. |
| `s-rail` | Server rail | `layout/server-rail.tsx`, `server-identity.tsx`, `update-indicator.tsx` | Home door (friend-request and DM counts), surfaced and pinned conversations, server tiles (selected, unread, muted, mention, Baú count, public globe, live dot), add, join, Novidades, Discover, update | Dup: `PhoneServersScreen`. All legacy tokens. |
| `s-sidebar-header` | Server header, banner, menu, search entry | `layout/channel-list.tsx`, `server-identity.tsx` (`ServerBannerStrip`), `search/search-dialog.tsx` | Banner image, public badge, members, collapse, close (phone), server menu (8+ items) | |
| `s-sidebar-special` | Sidebar blocks above channels | `stories/story-strip.tsx`, pinned channels, `watch-party/live-party-block.tsx`, `community-home/community-home-preview.tsx` | Stories, pinned section, live party (5 states), Baú entry (NEW, fresh, unread) | |
| `s-category` | Category header | `layout/channel-list.tsx`, `channel-list-mixed.tsx`, `channel-section-header.tsx` | Collapse, add, drop target | Dup: 3 header implementations. Flag: mixed vs legacy layout. |
| `s-channel-row` | Text, forum and watch-party channel row | `layout/channel-list.tsx` (`ChannelRow`, `SidebarThreadRow`), `channel-icon.tsx` | Selected, unread pip, muted, mention count, draft, private, favorite, drag, hover pin and settings, threads nested, forum beta tag, live pill | Mixed tokens inside one row. |
| `s-voice-row` | Voice channel row and occupants | `layout/channel-list.tsx`, `voice-occupant-row.tsx`, `voice-occupant-badges.tsx`, `channel-session-hint.tsx` | Occupants with speaking ring, hand, share, camera, muted, app line; music card; scheduled session hint; connected ring | |
| `s-sidebar-rail` | Icons-only sidebar (72px) | `layout/channel-list.tsx` (`ChannelRailItem`) | Mention badge, occupant count, live dot | A second sidebar renderer. |
| `s-voice-strip` | Voice connection strip and music mini player | `voice/voice-status-bar.tsx`, `voice/music-mini-player.tsx`, `App.tsx` (`sidebarFooter`) | Quality, listen-only, PTT idle, leave, camera, share, coachmarks | |
| `s-user-panel` | User panel | `layout/user-panel.tsx` | Avatar and status, mic, deafen, DND bell, settings; hand-built status menu with custom status; download hint | One-off menu. All legacy tokens. |
| `s-header` | Conversation header | `App.tsx` (`chatPane`, `channelHeaderTools`, `HEADER_ACTION_TILE`), `dm/nudge-button.tsx` | Title, topic or "N aqui", join call, nudge, DM call buttons, schedule, pins, history, settings, members | Dup: 7 headers (chat, forum, Baú, friends, thread, call split, skeleton) plus the party bar. |
| `s-banners` | Strips above the conversation | `layout/connection-banner.tsx`, `watch-now/watch-now-banner.tsx`, `sanction-notice-bar.tsx`, onboarding strips, inline bars in `App.tsx` | Connection, error, idle, notice, upcoming session, watch now, arrival (4 kinds) | Becomes `p-banner`. |
| `s-message-row` | Message row and its parts | `chat/message-list.tsx` (`MessageRow`), `message-body.tsx`, `user/rank-marks.tsx`, `status-dot.tsx` | Avatar, author (role color, rank marks, bot, OP, webhook, AutoMod tags), time, grouping, compact/cozy, own, pending, failed, queued, blocked, mention highlight, flash, bulk select, editing, forum answer, stream variant | Dup: inline `EditComposer`; stream row is a third layout. |
| `s-message-content` | Content inside a message | `message-body.tsx`, `attachment-grid.tsx`, `voice-note-card.tsx`, `forward-card.tsx`, `poll-card.tsx`, `chance-card.tsx`, `bot-action-card.tsx`, `bau-post-card.tsx`, embeds, `custom-emoji.tsx`, `image-lightbox.tsx` | Markdown, mentions, code, quotes, links, embeds, images, files, voice notes, GIFs, polls, dice, bot cards, story quotes | |
| `s-message-chrome` | Reactions, reply, thread chip, hover toolbar, menus | `chat/message-list.tsx`, `thread-chip.tsx` | Reaction bar and who-tip, reply quote, thread chip, hover toolbar, "more" popover, context menu | Dup: "more" popover and context menu. |
| `s-log-chrome` | List chrome | `chat/message-list.tsx` | Day separator, unread rule, typing indicator, bot notice, empty, history failed, load newer, jump to present, jump notice, bulk delete bar | |
| `s-composer` | Composer | `chat/message-composer.tsx`, `autocomplete-menu.tsx`, `emoji-picker*.tsx`, `gif-picker*.tsx`, `composer-format-preview.tsx`, `poll-composer.tsx`, `voice-note-composer.tsx`, `composer-read-only-notice.tsx` | Music bar, call dock, reply bar, poll, attachment chips, format toolbar, insert menu, emoji, GIF, voice note, slow mode, read-only, embedded | Shared with thread panel and forum dialog. |
| `s-member-list` | Member list | `layout/member-sidebar.tsx`, `lib/member-groups.ts`, `chat/right-column-tabs.tsx` | Sections (roles, bots, friends, online, offline), paging, search, row with status line and "Na call", hover message, context menu | Dup: `layout/members-panel.tsx` redraws rows in a modal. |

## 4. Surfaces

| Id | Surface | Entry files | Notes | Dup / flag |
|---|---|---|---|---|
| `f-dm-home` | DM home and conversation list | `layout/dm-list.tsx`, `conversations/conversation-home-list.tsx`, `conversations-empty.tsx`, `onboarding/first-run-card.tsx` | Filters, pinned, typing, drafts, call button | Flag: classic vs home list. Retro third list. |
| `f-friends` | Friends | `friends/friends-view.tsx`, `user/user-search.tsx` | Own tablist, add panel, pending, unfriend confirm | Becomes `p-tabs`, `p-list-row`. |
| `f-new-dm` | New conversation and quick switcher | `user/new-dm-dialog.tsx`, `conversations/new-conversation-dialog.tsx`, `quick-switcher.tsx` | | Flag: two new-DM dialogs. |
| `f-user-settings` | User settings | `layout/settings-modal.tsx`, `settings/*-section.tsx`, `settings/kit/` | 12 sections in 4 groups; drafts plus unsaved bar on profile, instant save elsewhere | Cleanest surface. |
| `f-server-settings` | Server and channel settings | `layout/server-settings-dialog.tsx`, `channel-settings-dialog.tsx`, roles, emoji, automod, webhooks, audit, danger | 13 server sections, 5 channel sections | Own `Block`/`SectionHeader`, not the kit. |
| `f-invites` | Invites and server creation | `layout/invite-panel.tsx`, `invite-choice-row.tsx`, `create-server-dialog.tsx` | | |
| `f-call` | Call stage, dock, controls | `voice/call-stage.tsx` and 170 voice files, `layout/call-split.tsx`, `voice/call-dock.tsx` | Tiles, grid, screen, listener strip, raised hands, soundboard, reactions, music queue, overflow menus | Controls in 3 homes (stage, composer dock, app column). |
| `f-dm-call` | DM call, incoming call, rating | `dm/dm-call-stage.tsx`, `incoming-call-overlay.tsx`, `voice/call-rating-prompt.tsx` | | |
| `f-watch-party` | Watch party | `watch-party/` (24), `voice/hls-watch-player.tsx`, `watch-stage.tsx` | Setup, scheduled, live, options, history, waitlist, guests | 5 dialog shells. |
| `f-forum` | Forum channels | `forum/` (8) | Card, compact, gallery; post view; composer dialog | Own 767px breakpoint, own empty block. |
| `f-bau` | Baú (community home) | `community-home/` (15) | Feed, post card, compose card, follow | 3 versions of one post card. |
| `f-stories` | Stories | `stories/` (19) | Ring, strip, viewer, composer | Own control kit and tokens. Always dark. |
| `f-apps` | Apps, Locadora, emulator | `apps/` (13), `emulator/` | Launcher, session layout and strip, join sheet | 3 frame chromes. |
| `f-onboarding` | Onboarding, hints, corner cards | `onboarding/` (11), `layout/*-hint.tsx`, `corner-card.tsx` | Wizard, strips, corner cards, feature hints | 3 to 4 hint shapes. |
| `f-search` | Message search | `search/search-dialog.tsx` | | About 9 search inputs across the app. |
| `f-profile` | Profile popover, status menu, moderation | `user/user-profile-popover.tsx`, `layout/user-panel.tsx`, `user/member-moderation-dialog.tsx` | Tabs, depoimentos, achievements | Native prompt and confirm. |
| `f-communities` | Communities directory | `communities/communities-view.tsx`, `community-card.tsx` | Full-screen overlay | |
| `f-connections` | Connections | `connections/` | Inside user settings, callback overlay | |
| `f-bots` | Server bots | `bots/` (6), `layout/bots-settings-section.tsx` | Wizard, overview tabs | Duplicate radio group. |
| `f-states` | Empty, loading, error | `layout/app-loading-shell.tsx`, `ui/skeleton.tsx`, `error-boundary.tsx`, `HistoryFailed` | Splash, skeletons, spinners, error boundary | Error boundary copy is English only. AGENTS.md says to leave `error-boundary.tsx` alone unless the task is that file: ask before touching its copy. |

## 5. Phone layout

| Id | Element | Files | Notes |
|---|---|---|---|
| `m-shell` | Phone shell | `conversations/phone-tab-bar.tsx`, `phone-screens.tsx`, `lib/phone-tabs.ts` | Flag: bottom tabs vs the older drawer. |
| `m-breakpoints` | Breakpoints | `PHONE_QUERY`, forum 767px, stories 640px, `use-*-up`, CSS 639/640px | Collapse to one definition. |
| `m-sheets` | Phone sheets | launcher, soundboard, music queue, section rail strip | Built on `p-sheet`. |

## Out of scope

`ios/`, `android/`, marketing and public pages (`pages/home*`, `/@handle`,
`/c/<slug>`, blog, Locadora guest page), `tools/admin-dashboard`, and server
behaviour.

import {
  SignInButton,
  SignUpButton,
  useAuth,
  useSignIn,
  useUser,
} from "@clerk/clerk-react";
import {
  CalendarClock,
  History,
  Lock,
  Menu,
  MoreHorizontal,
  Phone,
  Pin,
  Settings,
  Users,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Menu as ActionMenu } from "@/components/ui/menu";
import { WatchPartyBarSlot } from "@/components/watch-party/watch-party-bar";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { createPortal } from "react-dom";
import { useAppShellDocument } from "@/lib/app-shell-document";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  WATCH_PARTY_MAX_GUESTS,
  connectionProviderFromPath,
  joinIntentFromSearch,
  normalizeHandle,
  Permission,
  publicProfileDisplayUrl,
  validateHandle,
  buildReplyExcerpt,
  isVoiceRoomChannelType,
  SIDEBAR_THREADS_PER_CHANNEL,
  withProfileUpdate,
  type VoiceAudienceEnforcement,
  type WatchParty,
  type WatchPartyOptions,
  type WatchPartyWaitlistSource,
} from "@pqp/shared";
import type {
  AgeGateStatus,
  BlockedUser,
  Channel,
  ChannelKind,
  ChannelSession,
  ChannelType,
  DmSummary,
  MemberRole,
  SanctionNotice,
  Server,
  ServerRemoved,
  ThreadSummary,
  User,
  VoiceRoomTransport,
} from "@pqp/shared";
import { MessageComposer } from "@/components/chat/message-composer";
import { VoiceNoteMiniPlayer } from "@/components/chat/voice-note-mini-player";
import {
  applyVoiceNoteListened,
  isVoiceNoteListenedFrame,
  setVoiceNoteViewer,
} from "@/lib/voice-note-player";
import { MessageList, type MessageAuthorInfo } from "@/components/chat/message-list";
import { BulkPurgeDialog } from "@/components/chat/bulk-purge-dialog";
import { ForwardDialog, type ForwardTarget } from "@/components/chat/forward-dialog";
import { ThreadPanel } from "@/components/chat/thread-panel";
import {
  ReportDialog,
  type ReportTarget,
} from "@/components/chat/report-dialog";
import {
  AppBootstrapError,
  AppLoadingShell,
} from "@/components/layout/app-loading-shell";
import { ChannelIcon } from "@/components/layout/channel-icon";
import { ChannelList } from "@/components/layout/channel-list";
import {
  ChannelSettingsDialog,
  type ChannelSettingsSectionId,
} from "@/components/layout/channel-settings-dialog";
import { DmCallStage } from "@/components/dm/dm-call-stage";
import { IncomingCallOverlay } from "@/components/dm/incoming-call-overlay";
import { ConnectionBanner } from "@/components/layout/connection-banner";
import { ConnectionDoctorDialog } from "@/components/layout/connection-doctor-dialog";
import { DmToasts } from "@/components/dm/dm-toasts";
import { WhatsNewPrompt } from "@/components/layout/whats-new-prompt";
import { DmList } from "@/components/layout/dm-list";
import { FriendsView } from "@/components/friends/friends-view";
import { CommunitiesView } from "@/components/communities/communities-view";
import { useCommunitiesEnabled } from "@/components/communities/use-communities-enabled";
import { setProfileVisibility } from "@/components/depoimentos/depoimentos-api";
import { waitingOnYou } from "@/components/depoimentos/depoimentos-model";
import {
  FriendsContext,
  useFriendsStore,
} from "@/components/friends/use-friends";
import { InvitePanel } from "@/components/layout/invite-panel";
import { MemberSidebar } from "@/components/layout/member-sidebar";
import { MembersPanel } from "@/components/layout/members-panel";
import {
  ProfilePopoverProvider,
  type ProfileWatchPartyContext,
} from "@/components/user/user-profile-popover";
import type { ProfileModerationContext } from "@/components/user/profile-relations";
import { PinnedMessagesPanel } from "@/components/chat/pinned-messages-panel";
import { ServerRail } from "@/components/layout/server-rail";
import { WhatsNewView } from "@/components/layout/whats-new-view";
import { AgeGateDialog } from "@/components/user/age-gate-dialog";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { NewDmDialog } from "@/components/user/new-dm-dialog";
import { CargosHint } from "@/components/layout/cargos-hint";
import { BringFriendsServerProvider } from "@/components/layout/bring-friends-hint";
import { FeatureHintProvider } from "@/components/layout/feature-hint";
import { MobileBetaHint } from "@/components/layout/mobile-beta-hint";
import { QgHint } from "@/components/layout/qg-hint";
import { ShortcutsHint } from "@/components/layout/shortcuts-hint";
import {
  VoiceCleanActivatedToast,
  VoiceCleanHint,
} from "@/components/voice/voice-clean-hint";
import { winningCornerHint } from "@/lib/corner-hints";
import { isDesktopApp } from "@/lib/desktop";
import { createHistoryLoadTracker } from "@/lib/history-load-tracker";
import {
  uniformJitterMs,
  bootstrapJitterMs,
  bootstrapRetryDelayMs,
} from "@/lib/reconnect-jitter";
import { useShareCursor } from "@/lib/screen-capture-cursor";
import {
  featureHintEligible,
  winningFeatureHint,
  shouldOfferBringFriendsHint,
  shouldOfferMusicFieldHint,
  shouldOfferMusicHint,
  shouldOfferCallDockHint,
  shouldOfferWatchPartyViewerHint,
  shouldOfferWatchNowHint,
  useFeatureHintsSpent,
} from "@/lib/feature-hints";
import { canActOnMemberClient } from "@/lib/role-hierarchy";
import {
  cloneVoiceOccupancy,
  moveMembersBit,
  moveOccupantSeat,
} from "@/lib/voice-occupant-dnd";
import {
  requestUpdatePrompt,
  useUpdatePromptShowing,
  useUpdateWaiting,
} from "@/lib/update-prompt-state";
import { isAutomatedBrowser, isCargosHintSeen } from "@/lib/cargos-hint";
import { shouldShowMobileBetaHint } from "@/lib/mobile-beta-hint";
import {
  dismissPartyNewcomerStrip,
  isNewcomerAccount,
  isPartyNewcomerStripDismissed,
  partyNewcomerStripVisible,
  partyPhoneLayoutOn,
  suppressAppInviteForNewcomer,
} from "@/lib/party-newcomer";
import {
  shouldOfferVoiceCleanNudge,
  voiceCleanNudgeDismissedPatch,
} from "@/lib/voice-clean";
import { isWhatsNewSeen, rememberWhatsNew } from "@/lib/whats-new";
import {
  hasUnseenWhatsNew,
  rememberWhatsNewFeed,
} from "@/lib/whats-new-feed";
import { ServerSettingsDialog } from "@/components/layout/server-settings-dialog";
import { CreateServerDialog } from "@/components/layout/create-server-dialog";
import {
  applyRemotePreferences,
  defaultLocalSettings,
  loadLocalSettings,
  saveLocalSettings,
  SettingsModal,
  type LocalSettings,
  type SettingsSectionId,
} from "@/components/layout/settings-modal";
import { ShortcutOverlay } from "@/components/layout/shortcut-overlay";
import { isApplePlatform } from "@/lib/composer-formatting";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import {
  channelIsUnread,
  navigableChannelIds,
  stepChannelId,
  stepUnreadChannelId,
  type ShortcutAction,
} from "@/lib/keyboard-shortcuts";
import { globalVoiceHotkeyAccelerators } from "@/lib/global-voice-hotkeys";
import { SanctionNoticeBar } from "@/components/layout/sanction-notice-bar";
import { SsoServerSuggestions } from "@/components/layout/sso-server-suggestions";
import { UserPanel } from "@/components/layout/user-panel";
import { ConnectionCallbackOverlay } from "@/components/connections/connection-callback";
import { VoiceAudioSinks } from "@/components/voice/voice-audio-sinks";
import type { AudienceModeHostControls } from "@/components/voice/audience-mode";
import { useVoiceConfig } from "@/hooks/use-voice-config";
import { VoiceChannelStage } from "@/components/voice/voice-channel-stage";
import { CallDockOutlet, CallDockProvider } from "@/components/voice/call-dock";
import { CreateWatchPartyDialog } from "@/components/watch-party/create-watch-party-dialog";
import {
  canOfferWatchPartyCreate,
  isWatchPartyChannelType,
  isWatchPartyChannelsEnabled,
} from "@/lib/watch-party-channels";
import { partyOwnsChannelChrome } from "@/lib/watch-party-chrome";
import {
  AUDIENCE_SEAT_GRACE_MS,
  audienceSeatAgeMs,
  nextAudienceSeatClock,
  shouldReleaseAudienceWatchSeat,
  type AudienceSeatClock,
} from "@/lib/watch-party-seat";
import { WatchPartyPanel } from "@/components/watch-party/watch-party-panel";
import { WatchPartyHistoryDialog } from "@/components/watch-party/watch-party-history-dialog";
import {
  watchPartyHistoryCandidates,
  type WatchPartyHistoryChannel,
} from "@/lib/watch-party-history-access";
import { useWatchPartyHistoryAvailability } from "@/lib/use-watch-party-history-availability";
import { useWatchParties } from "@/hooks/use-watch-parties";
import {
  claimWatchPartyHost as apiClaimWatchPartyHost,
  createServerWatchParty as apiCreateServerWatchParty,
  fetchChannelWatchParty as apiFetchChannelWatchParty,
  fetchServerWatchParties as apiFetchServerWatchParties,
  setWatchPartyCohost as apiSetWatchPartyCohost,
  setWatchPartyGuestAction,
  setWatchPartyStage,
  setWatchPartyState as apiSetWatchPartyState,
  updateWatchParty as apiUpdateWatchParty,
} from "@/lib/watch-parties-api";
import {
  WatchPartyGuestsOverlay,
  type GuestAction,
} from "@/components/watch-party/guests/watch-party-guests-overlay";
import { endWatchParty } from "@/lib/watch-party-end";
import {
  abandonWatchPartyDraft,
  decideDraftAbandon,
  startWatchParty,
} from "@/lib/watch-party-draft";
import { decideGoLiveMicPrompt } from "@/lib/watch-party-go-live";
import { resetWatchPartyStreamQualityForNewParty } from "@/lib/watch-party-stream-quality";
import { ScheduleSessionSheet } from "@/components/voice/schedule-session-sheet";
import { UpcomingSessionCard } from "@/components/voice/upcoming-session-card";
import { ChannelSessionToasts } from "@/components/voice/channel-session-toasts";
import {
  cancelChannelSession,
  createChannelSession,
  listUpcomingChannelSessionsForServer,
  setChannelSessionReminder,
  updateChannelSession,
} from "@/lib/channel-sessions-api";
import {
  emitChannelSessionReminderToast,
  isChannelSessionScheduleEnabled,
} from "@/lib/channel-session-schedule";
import { CallSplit, type CallSplitState } from "@/components/layout/call-split";
import {
  CALL_SPLIT_DEFAULT,
  loadCallSplit,
  saveCallSplit,
  effectiveOrientation,
  strongestStageShape,
  type CallSplitKind,
  type CallSplitPreference,
  type CallStageShape,
} from "@/lib/call-split";
import {
  channelSidebarIconsOnly,
  loadChannelSidebarPreference,
  saveChannelSidebarPreference,
  toggledChannelSidebarPreference,
  type ChannelSidebarPreference,
} from "@/lib/channel-sidebar-preference";
import { useMdUp } from "@/hooks/use-md-up";
import { useSmUp } from "@/hooks/use-sm-up";
import { supportsScreenShare } from "@/components/voice/capabilities";
import {
  formatBinding,
  supportsKeyBinding,
} from "@/components/voice/push-to-talk";
import { usePushToTalk } from "@/components/voice/use-push-to-talk";
import { useVoiceStateSync } from "@/components/voice/voice-state-sync";
import { VoiceStatusBar } from "@/components/voice/voice-status-bar";
import { MusicMiniPlayer } from "@/components/voice/music-mini-player";
import { MusicComposer } from "@/components/voice/music-composer";
import { useMusicDock } from "@/lib/music-store";
import {
  isCameraAtCap,
  isScreenShareAtCap,
  meshRoomLinkOf,
  videoLimitOf,
} from "@/lib/screen-share-roster";
import { CallRatingPrompt } from "@/components/voice/call-rating-prompt";
import { useCallRating } from "@/hooks/use-call-rating";
import { usePermissions } from "@/hooks/use-permissions";
import { ShareHandleButton } from "@/components/handle/share-handle-button";
import { BetaTag } from "@/components/ui/beta-tag";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { Seo } from "@/components/marketing/seo";
import {
  createChatController,
  THREAD_CHANNEL_FRAMES,
  type ChatMessage,
} from "@/hooks/use-chat";
import { createVoiceController } from "@/hooks/use-voice";
import {
  ApiError,
  blockUser,
  bulkDeleteMessages,
  createChannel,
  createThread,
  createVoiceSession,
  deleteChannel,
  fetchBlocks,
  fetchChannels,
  fetchServerThreads,
  setThreadMembership,
  fetchCommunityHomeUnread,
  fetchServerCommunityHomeConfig,
  fetchConversations,
  fetchIceServers,
  fetchMe,
  fetchPublicInvitePreview,
  fetchMembers,
  fetchRoles,
  listTimeouts,
  fetchMessages,
  fetchServers,
  fetchUnread,
  fetchVoiceBackend,
  hideConversation,
  joinCommunity as joinCommunityApi,
  joinInvite,
  leaveServer,
  lookupCommunityBySlug,
  lookupUserByHandle,
  markChannelRead,
  markCommunityHomeRead,
  memberDisplayName,
  moveChannel,
  moveMemberVoice,
  disconnectMemberVoice,
  lowerMemberVoiceHand,
  setMemberVoiceMuted,
  setVoiceAudienceMode,
  setVoiceAudienceSpeaker,
  kickMember,
  setAuthTokenProvider,
  unblockUser,
  updateChannel,
  updateMe,
  updatePreferences,
  type ServerMember,
  type ServerRole,
} from "@/lib/api";
import {
  linkFollowedAt,
  parseAppRoute,
  pickOpenableServer,
  signedOutRedirectPath,
  messageRoutePath,
} from "@/lib/app-route";
import {
  hasStashedConnectionCallback,
  stashConnectionCallbackFromWindow,
} from "@/lib/connection-callback";
import {
  addIntentFromSearch,
  CREATE_INTENT_PARAMS,
  createIntentFromSearch,
  INTENT_PARAM,
  peekCreateIntent,
  stashCreateIntent,
  stashInviteRef,
  stashWaitlistIntent,
  takeAddIntent,
  takeCreateIntent,
  takeHandleClaim,
  takeInviteRef,
  takeJoinIntent,
  peekJoinIntent,
  takeWaitlistIntent,
  takeWaitlistIntentWithSource,
  WAITLIST_SOURCE_PARAM,
  waitlistIntentFromSearch,
  waitlistSourceFor,
  type CreateIntent,
} from "@/lib/handle-intent";
import {
  ackWatchPartyApproval,
  fetchWatchPartyApprovals,
  loadWatchPartyWaitlist,
  setWatchPartyWaitlistOwner,
  shouldOfferWatchPartyTeaser,
  useWatchPartyWaitlist,
} from "@/lib/watch-party-waitlist";
import { WatchPartyWaitlistDialog } from "@/components/watch-party/waitlist/watch-party-waitlist-dialog";
import { startConfigRefresh } from "@/lib/config-refresh";
import {
  WatchPartyApprovedToasts,
  type WatchPartyApprovedCard,
} from "@/components/watch-party/waitlist/watch-party-approved-toasts";
import { sendFriendRequest } from "@/components/friends/friends-api";
import { onboardingPath, shouldRunOnboarding } from "@/lib/onboarding";
import { copyInvitePaste, setInviteCacheAccount } from "@/lib/invite-paste-copy";
import { track, trackFirstAction } from "@/lib/track";
import { firstRunDismissedPatch } from "@/lib/first-run";
import {
  favoritesForServer,
  writeFavoritesForServer,
} from "@/lib/channel-favorites";
import {
  addPinnedConversation,
  isPinnedConversation,
  PINNED_CONVERSATIONS_MAX,
  prunePinnedConversations,
  removePinnedConversation,
  visiblePinnedConversations,
} from "@/lib/pinned-conversations";
import { bindPreferenceSyncAccount, queuePreferenceSync } from "@/lib/preferences";
import {
  arrivalVariant,
  browserStorage,
  confettiSpent,
  hasArrived,
  rememberArrival,
  sessionStore,
  spendConfetti,
  type ArrivalSurface,
} from "@/lib/arrival";
import { acknowledgeAcquisition, peekAcquisition } from "@/lib/acquisition";
import { noteSignupCta, noteSignupReturn } from "@/lib/signup-assist";
import { reportSignupConversion } from "@/lib/google-ads";
import { ArrivalBanner } from "@/components/onboarding/arrival-banner";
import { PartyNewcomerStrip } from "@/components/onboarding/party-newcomer-strip";
import { ServerIcon } from "@/components/layout/server-identity";
import type { PublicInvitePreview } from "@pqp/shared";
import {
  translateMessage,
  useTranslation,
  type MessageKey,
} from "@/lib/i18n";
import { voiceModerationNotice } from "@/lib/voice-moderation-notice";
import {
  applyConversationMessage,
  conversationChannel,
  conversationSubtitle,
  conversationTitle,
  conversationUnreadTotals,
  sortConversations,
  touchConversation,
  unreadFromConversations,
  upsertConversation,
} from "@/lib/conversations";
import { findLastOwnEditableMessage } from "@/lib/edit-last-message";
import { findFirstUnreadMessageId } from "@/lib/unread-divider";
import {
  createChannelWriteQueue,
  createLiveReadAck,
} from "@/lib/live-read-ack";
import {
  HOME_SELECTION,
  selectionRoutePath,
  selectionServerId,
  type Selection,
} from "@/lib/selection";
import { useAttachmentsEnabled } from "@/hooks/use-attachments-enabled";
import { chatDropVerdict } from "@/lib/chat-file-drop";
import type { DroppedItems } from "@/lib/file-drop";
import { FileDropZone } from "@/components/ui/file-drop-zone";
import type { MentionCandidate } from "@/lib/mention-autocomplete";
import { usernameFromTag, rankBadges } from "@/lib/author-display";
import { devAuthToken, getAuthToken, isDevAuthBypassEnabled } from "@/lib/dev-auth";
import {
  channelListRetryDelayMs,
  createChannelListTickets,
  vanishedChannelFallback,
} from "@/lib/channel-list-refresh";
import {
  onConnectionCheckRequest,
  onSettingsRequest,
} from "@/lib/settings-request";
import {
  applyCommunityHomeRead,
  applyCommunityHomeSwitch,
  COMMUNITY_HOME_CHANNEL_ID,
  COMMUNITY_HOME_CONFIG_OFF,
  isCommunityHomeChannelId,
  isCommunityHomeEnabled,
  isCommunityHomeRowNew,
  loadCommunityHomeConfig,
  markCommunityHomeRowSeen,
  mergeServerUpdate,
  pickServerLandingTarget,
  shouldOfferCommunityHomePostToast,
} from "@/lib/community-home";
import { pickLivePartyChannel } from "@/lib/live-party-landing";
import { CommunityHomeFeed } from "@/components/community-home/community-home-feed";
import { CommunityHomePostHint } from "@/components/community-home/community-home-post-hint";
import {
  applyDesktopAuthStart,
  completeDesktopSecondFactor,
  desktopAuthEndedHandoff,
  desktopSignedOutPath,
  pickPreferredSecondFactor,
  redeemDesktopTicket,
  secondFactorNeedsPrepare,
  shouldRedeemDesktopTicket,
  type SecondFactorStrategy,
} from "@/lib/desktop-auth-flow";
import { getDesktop } from "@/lib/desktop";
import {
  describeActivity,
  getNotificationState,
  notifyChannelActivity,
  notifyStreamStarted,
  rememberActivityChannel,
  rememberServers,
  unreadByServer,
} from "@/lib/notifications";
import {
  applyPttHeldChange,
  resetPttHeld,
  setPttBeepEnabled,
  setSoundOutput,
} from "@/lib/sounds";
import { useMemberRosterRefresh } from "@/hooks/use-member-roster-refresh";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { useMemberSidebar } from "@/hooks/use-member-sidebar";
import { mergeMemberStatuses } from "@/lib/member-roster";
import { useChannelNotifications } from "@/hooks/use-notifications";
import { useCustomStatus } from "@/hooks/use-custom-status";
import { useUserStatus } from "@/hooks/use-status";
import { setDraftsAccount } from "@/lib/composer-drafts";
import { createRealtimeTransport, type RealtimeStatus } from "@/lib/realtime";
import { adoptAccentHuePreference } from "@/lib/accent";
import { adoptAppearancePreference, getAppearance } from "@/lib/appearance";
import { adoptContrastPreference } from "@/lib/contrast";
import { adoptChatDisplay } from "@/lib/chat-display";
import { adoptThemePreference, themeToAdopt } from "@/lib/theme";
import { isMeshForced } from "@/lib/voice-backend";
import type { VideoQuality } from "@/lib/video-quality";
import { cn } from "@/lib/utils";
import { shouldJoinMuted } from "@/lib/join-muted";
import { setInCall, setWatchingParty } from "@/lib/in-call-state";
import { useHlsHostAck } from "@/hooks/use-hls-host-ack";
import { useLiveHlsConfig } from "@/hooks/use-live-hls-config";
import { useWatchNow, useWatchNowFlag } from "@/hooks/use-watch-now";
import { useStreamAlertSettings } from "@/hooks/use-stream-alert-settings";
import { WatchNowBanner } from "@/components/watch-now/watch-now-banner";
import {
  dismissWatchNow,
  type WatchNowScope,
  type WatchNowStream,
} from "@/lib/watch-now";
import {
  preloadHlsEngine,
  setPartyFastStart,
  shouldPreloadHlsEngine,
} from "@/lib/party-fast-start";
import { cameraSyncFromConfig, setWatchCameraSync } from "@/lib/camera-sync";
import { setShareFastStartServer } from "@/lib/share-fast-start";
import {
  WatchChannelStage,
  watchAudienceCount,
} from "@/components/voice/watch-stage";
import {
  WatchStageOutlet,
  useVoiceJoinGuard,
  useWatchDock,
  type WatchDockSession,
} from "@/components/voice/watch-dock";
import { HlsHostAckSheet } from "@/components/voice/hls-host-ack-sheet";
import { ShareAudioPrompt } from "@/components/voice/share-audio-prompt";
import {
  ensureOsCanExcludeCallAudio,
  liveScreenCaptureEnvironment,
  needsShareAudioPrompt,
  offersShellSystemAudio,
  steersAtBrowserTab,
  type ScreenCaptureIntent,
} from "@/lib/screen-capture-audio";
import { ensureNativeShareAudio, prefetchNativeShareAudio } from "@/lib/native-share-audio";
import {
  ensureShareGameCaptureHintFlag,
  ensureShareGuardFlag,
  prefetchShareGuardFlag,
} from "@/lib/share-guard-flag";
import { ensureLinuxShellShareAudio } from "@/lib/linux-shell-share-audio";
import {
  hlsCaptureMaxFrameRate,
  screenCaptureMaxFrameRate,
  type ScreenFrameRate,
} from "@/lib/hls-capture-rate";
import {
  gateScreenShareStart,
  type ScreenShareStart,
} from "@/lib/screen-share-gate";
import { createShareRequestGuard } from "@/lib/share-request-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { effectiveRoleIds } from "@/lib/member-groups";
import { WatchPartyStage } from "@/components/watch-party/watch-party-stage";
import { WatchPartyActivityFeed } from "@/components/watch-party/watch-party-activity-feed";
import { feedAudienceCount } from "@/lib/watch-party-activity";
import { WatchPartyPeoplePanel } from "@/components/watch-party/watch-party-people-panel";
import { slowModeKey } from "@/components/watch-party/watch-party-options";
import { watchPartyPanelOwnsPane } from "@/lib/watch-party-pane";

export type TokenResolver = (options?: {
  forceRefresh?: boolean;
}) => Promise<string | null>;

/** Equal-width icon tiles in the chat header (pins, channel settings, call, roster). */
const HEADER_ACTION_TILE =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-paper-muted hover:bg-ink-3 hover:text-paper";

/**
 * A reconnect's message refetch (`transport.onReady`, `reconnected` branch)
 * is spread across this window instead of firing the instant `ready` lands —
 * same reasoning as the WS reconnect itself (`reconnect-jitter.ts`): every
 * open tab on the channel just reconnected in the same window, so an
 * unstaggered refetch re-concentrates the herd.
 *
 * Deliberately NOT skipped by a "fetched recently" freshness check: `GET
 * /api/channels/:id/messages` is this client's only way to learn about a
 * message sent while the socket was down — rejoining a channel
 * (`chat.resubscribe`) only re-subscribes to what is broadcast *after* that
 * point (`join-channel` in `server/src/ws/chat.ts` carries no history replay)
 * — so treating "fetched a few seconds ago" as proof nothing arrived since
 * would drop messages sent in that gap until some unrelated refresh caught
 * them. What IS safe to skip is a second, overlapping request for the SAME
 * channel: a pending timer or an in-flight fetch already covers whatever a
 * later reconnect event would ask for (tracked per channel, not with one
 * shared flag — a slow fetch for channel A must never block channel B's
 * refetch after a mid-outage switch). See
 * `scheduleReconnectMessagesRefetch` below.
 */
const RECONNECT_MESSAGES_JITTER_MAX_MS = 2_000;

/** The watch-now strip's inputs when nothing is open to attach it to. */
const WATCH_NOW_NO_SCOPE: WatchNowScope = { kind: "server", channels: [] };
const WATCH_NOW_ALWAYS = () => true;

/** A stable empty array, so "no favorites" is the same reference every
 * render instead of a fresh `[]` that defeats `ChannelList`'s `memo()`.
 * `ChannelList` only ever reads this prop. */
const EMPTY_FAVORITE_CHANNEL_IDS: string[] = [];

/** What a `server-removed` frame says, by reason. A map, so every key the
 * i18n check looks for is written out whole. */
const SERVER_REMOVED_COPY: Record<ServerRemoved["reason"], MessageKey> = {
  kicked: "chrome.serverRemoved.kicked",
  banned: "chrome.serverRemoved.banned",
  deleted: "chrome.serverRemoved.deleted",
};

interface AppProps {
  devBypass?: boolean;
}

export function App({ devBypass = false }: AppProps) {
  const { t } = useTranslation();
  useAppShellDocument();

  // One tooltip group for the whole shell, so hovering the second icon in a
  // control bar answers instantly instead of waiting its own delay again.
  //
  // Here rather than in `main.tsx` on purpose: every tooltipped control lives
  // inside this chunk, and the landing page is the one surface where a
  // visitor's first paint is measured. Putting the provider at the router root
  // would drag Radix's popper into the marketing bundle to serve nothing.
  if (devBypass) {
    return (
      <TooltipProvider>
        <MainAppContent resolveToken={() => Promise.resolve(devAuthToken())} />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <Seo
        title={t("app.seo.title")}
        description={t("app.seo.description")}
        path="/app"
        noIndex
      />
      <ClerkAppGate />
    </TooltipProvider>
  );
}

/**
 * The server a signed-out invite link opens, when the API can say.
 *
 * Only on `/app/invite/<code>`, only while signed out. `null` until it
 * answers and whenever it cannot (see `fetchPublicInvitePreview`: an API
 * without the public route answers 401 or 404, and both read as "no preview",
 * so this ships ahead of the server change and lights up when it lands).
 * `invite_gate_view` records whether the preview was there.
 */
function useSignedOutInvitePreview(
  pathname: string | null,
): PublicInvitePreview | null {
  const route = pathname ? parseAppRoute(pathname) : null;
  const code = route?.kind === "invite" ? route.code : null;
  const [preview, setPreview] = useState<{
    code: string;
    value: PublicInvitePreview | null;
  } | null>(null);
  useEffect(() => {
    if (!code) {
      return;
    }
    let cancelled = false;
    void fetchPublicInvitePreview(code).then((value) => {
      if (cancelled) {
        return;
      }
      setPreview({ code, value });
      track("invite_gate_view", { preview: value !== null });
    });
    return () => {
      cancelled = true;
    };
  }, [code]);
  return preview && preview.code === code ? preview.value : null;
}

function ClerkAppGate() {
  const { t } = useTranslation();
  const { isLoaded, isSignedIn } = useAuth();
  const { signIn, setActive } = useSignIn();
  const location = useLocation();
  stashConnectionCallbackFromWindow(location.pathname, location.search);
  /**
   * Come back to the URL they were trying to open, not to `/app`.
   *
   * This is the invite fix. Both buttons used to hand Clerk a literal "/app", so
   * somebody arriving on `/app/invite/<code>` without an account signed up and
   * landed on an empty hub with the code gone — the single journey that brings
   * new people to the product, dropping them at the exact moment it worked. See
   * `signedOutRedirectPath`, which also refuses to reflect back anything that is
   * not a route this build recognises.
   */
  const redirectUrl = signedOutRedirectPath(location.pathname);
  const invitePreview = useSignedOutInvitePreview(
    isLoaded && !isSignedIn ? location.pathname : null,
  );
  const desktop = getDesktop();
  const canDesktopAuth = typeof desktop?.startDesktopAuth === "function";
  const [waiting, setWaiting] = useState(false);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [mfa, setMfa] = useState<{
    strategy: SecondFactorStrategy;
    strategies: SecondFactorStrategy[];
  } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);
  const [inAppFallback, setInAppFallback] = useState(false);
  const signInRef = useRef(signIn);
  const setActiveRef = useRef(setActive);
  const lastTicketRef = useRef<string | null>(null);
  const queuedTicketRef = useRef<string | null>(null);
  signInRef.current = signIn;
  setActiveRef.current = setActive;

  const redeemTicket = useCallback(
    async (ticket: string) => {
      const currentSignIn = signInRef.current;
      const currentSetActive = setActiveRef.current;
      if (!currentSignIn || !currentSetActive) {
        queuedTicketRef.current = ticket;
        return;
      }
      if (!shouldRedeemDesktopTicket(lastTicketRef.current, ticket)) {
        return;
      }
      lastTicketRef.current = ticket;
      queuedTicketRef.current = null;
      void getDesktop()?.getPendingDesktopAuthTicket?.();
      setHandoffError(null);
      setMfa(null);
      setInAppFallback(false);
      try {
        const classified = await redeemDesktopTicket(currentSignIn, ticket);
        if (classified.kind === "complete") {
          await currentSetActive({ session: classified.sessionId });
          return;
        }
        if (classified.kind === "second_factor") {
          const strategy = pickPreferredSecondFactor(classified.strategies);
          if (secondFactorNeedsPrepare(strategy)) {
            await currentSignIn.prepareSecondFactor({ strategy });
          }
          setWaiting(false);
          setMfaCode("");
          setMfa({ strategies: classified.strategies, strategy });
          return;
        }
        setWaiting(false);
        setHandoffError(t("signedOut.waiting.error"));
        setInAppFallback(true);
      } catch {
        setWaiting(false);
        setHandoffError(t("signedOut.waiting.error"));
        setInAppFallback(true);
      }
    },
    [t],
  );

  const submitDesktopMfa = useCallback(async () => {
    const currentSignIn = signInRef.current;
    const currentSetActive = setActiveRef.current;
    if (!currentSignIn || !currentSetActive || !mfa) {
      return;
    }
    const code = mfaCode.trim();
    if (!code) {
      return;
    }
    setMfaBusy(true);
    setHandoffError(null);
    try {
      const classified = await completeDesktopSecondFactor(currentSignIn, {
        strategy: mfa.strategy,
        code,
      });
      if (classified.kind === "complete") {
        await currentSetActive({ session: classified.sessionId });
        return;
      }
      if (classified.kind === "second_factor") {
        setHandoffError(t("signedOut.waiting.mfa.error"));
        return;
      }
      setMfa(null);
      setHandoffError(t("signedOut.waiting.error"));
      setInAppFallback(true);
    } catch {
      setHandoffError(t("signedOut.waiting.mfa.error"));
    } finally {
      setMfaBusy(false);
    }
  }, [mfa, mfaCode, t]);

  const cancelDesktopMfa = useCallback(() => {
    setMfa(null);
    setMfaCode("");
    setInAppFallback(true);
  }, []);

  useEffect(() => {
    if (!signIn) {
      return;
    }
    if (queuedTicketRef.current) {
      void redeemTicket(queuedTicketRef.current);
    }
    if (!canDesktopAuth || !desktop) {
      return;
    }
    void desktop.getPendingDesktopAuthTicket?.().then((ticket) => {
      if (ticket) {
        void redeemTicket(ticket);
      }
    });
  }, [canDesktopAuth, desktop, redeemTicket, signIn]);

  useEffect(() => {
    if (!canDesktopAuth || !desktop) {
      return;
    }
    void desktop.getDesktopAuthStatus?.().then((status) => {
      if (status?.active) {
        setWaiting(true);
        setBrowserUrl(status.url);
      }
    });
    const offTicket = desktop.onDesktopAuthTicket?.((ticket) => {
      void redeemTicket(ticket);
    });
    const offEnded = desktop.onDesktopAuthEnded?.((reason) => {
      const ended = desktopAuthEndedHandoff(reason);
      setWaiting(ended.waiting);
      setBrowserUrl(null);
      if (ended.expired) {
        setHandoffError(t("signedOut.waiting.expired"));
      }
    });
    return () => {
      offTicket?.();
      offEnded?.();
    };
  }, [canDesktopAuth, desktop, redeemTicket, t]);

  const startDesktopAuth = useCallback(
    async (mode: "sign-in" | "sign-up") => {
      if (!desktop?.startDesktopAuth) {
        return;
      }
      setAuthMode(mode);
      setHandoffError(null);
      setCopied(false);
      setMfa(null);
      setMfaCode("");
      setInAppFallback(false);
      setWaiting(true);
      const result = await desktop.startDesktopAuth(mode);
      const view = applyDesktopAuthStart(result);
      setBrowserUrl(view.url || null);
      setWaiting(view.waiting);
      if (view.failed) {
        setHandoffError(t("signedOut.waiting.error"));
      }
    },
    [desktop, t],
  );

  const cancelDesktopAuth = useCallback(() => {
    void desktop?.cancelDesktopAuth?.();
    setWaiting(false);
    setBrowserUrl(null);
    setHandoffError(null);
    setMfa(null);
    setMfaCode("");
  }, [desktop]);

  if (!isLoaded) {
    return <AppLoadingShell label={t("app.loading.signingIn")} />;
  }

  if (!isSignedIn) {
    return (
      <div className="relative flex h-full flex-col items-start justify-end overflow-y-auto p-8 sm:p-12">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,var(--glow-accent),transparent_40%)]" />
        <div className="animate-rise relative z-10 max-w-lg">
          <Link
            to="/"
            className="mb-3 inline-flex items-center gap-2 text-xs uppercase tracking-[0.28em] text-signal"
          >
            pqp.gg
            <BetaTag />
          </Link>
          {mfa && canDesktopAuth ? (
            <>
              <h1 className="font-display text-5xl font-extrabold leading-[0.95] sm:text-6xl">
                {t("signedOut.waiting.mfa.title")}
              </h1>
              <p className="mt-4 max-w-sm text-paper-muted">
                {t("signedOut.waiting.mfa.body")}
              </p>
              {handoffError ? (
                <p className="mt-4 text-danger">{handoffError}</p>
              ) : null}
              <form
                className="mt-8 flex w-full max-w-sm flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitDesktopMfa();
                }}
              >
                <Input
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value)}
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder={t("signedOut.waiting.mfa.placeholder")}
                  disabled={mfaBusy}
                />
                <Button
                  className="w-full whitespace-normal"
                  type="submit"
                  disabled={mfaBusy}
                >
                  {t("signedOut.waiting.mfa.submit")}
                </Button>
                <SignInButton mode="modal" forceRedirectUrl={redirectUrl}>
                  <Button
                    className="w-full whitespace-normal"
                    variant="secondary"
                    type="button"
                  >
                    {t("signedOut.waiting.inApp")}
                  </Button>
                </SignInButton>
                <Button
                  className="w-full whitespace-normal"
                  variant="ghost"
                  type="button"
                  onClick={cancelDesktopMfa}
                >
                  {t("signedOut.waiting.cancel")}
                </Button>
              </form>
            </>
          ) : waiting && canDesktopAuth ? (
            <>
              <h1 className="font-display text-5xl font-extrabold leading-[0.95] sm:text-6xl">
                {t("signedOut.waiting.title")}
              </h1>
              <p className="mt-4 max-w-sm text-paper-muted">
                {t("signedOut.waiting.body")}
              </p>
              {handoffError ? (
                <p className="mt-4 text-danger">{handoffError}</p>
              ) : null}
              <div className="mt-8 flex w-full max-w-sm flex-col gap-3">
                <Button
                  className="w-full whitespace-normal"
                  variant="secondary"
                  onClick={() => {
                    void startDesktopAuth(authMode);
                  }}
                >
                  {t("signedOut.waiting.reopen")}
                </Button>
                {browserUrl ? (
                  <Button
                    className="w-full whitespace-normal"
                    variant="secondary"
                    onClick={() => {
                      void navigator.clipboard.writeText(browserUrl).then(() => {
                        setCopied(true);
                      });
                    }}
                  >
                    {copied
                      ? t("signedOut.waiting.copied")
                      : t("signedOut.waiting.copy")}
                  </Button>
                ) : null}
                <Button
                  className="w-full whitespace-normal"
                  variant="ghost"
                  onClick={cancelDesktopAuth}
                >
                  {t("signedOut.waiting.cancel")}
                </Button>
              </div>
            </>
          ) : (
            <>
              {invitePreview ? (
                <>
                  <p
                    data-invite-gate-preview=""
                    className="mb-4 inline-flex max-w-full items-center gap-3 rounded-full bg-surface-1/80 py-1.5 pl-1.5 pr-4 outline outline-1 -outline-offset-1 outline-border"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2 font-display text-xs font-bold text-text">
                      <ServerIcon
                        name={invitePreview.serverName}
                        iconUrl={invitePreview.iconUrl}
                      />
                    </span>
                    <span className="min-w-0 truncate text-xs uppercase tracking-[0.18em] text-accent">
                      {t("signedOut.invite.eyebrow")}
                    </span>
                    {invitePreview.memberCount > 0 && (
                      <span className="shrink-0 text-xs tabular-nums text-text-tertiary">
                        {t("onboarding.you.members", {
                          count: invitePreview.memberCount,
                        })}
                      </span>
                    )}
                  </p>
                  <h1 className="text-balance font-display text-5xl font-extrabold leading-[0.95] [overflow-wrap:anywhere] sm:text-6xl">
                    {t("signedOut.invite.title", {
                      server: invitePreview.serverName,
                    })}
                  </h1>
                  <p className="mt-4 max-w-sm text-pretty text-paper-muted">
                    {t("signedOut.invite.body")}
                  </p>
                </>
              ) : (
                <>
                  <h1 className="font-display text-5xl font-extrabold leading-[0.95] sm:text-6xl">
                    {t("signedOut.title")}
                  </h1>
                  <p className="mt-4 max-w-sm text-paper-muted">{t("signedOut.body")}</p>
                </>
              )}
              {handoffError ? (
                <p className="mt-4 text-danger">{handoffError}</p>
              ) : null}
              <div className="mt-8 flex flex-wrap gap-3">
                {canDesktopAuth ? (
                  <div className="flex w-full max-w-sm flex-col gap-3">
                    <Button
                      className="w-full whitespace-normal"
                      onClick={() => void startDesktopAuth("sign-up")}
                    >
                      {t("signedOut.createAccount")}
                    </Button>
                    <Button
                      className="w-full whitespace-normal"
                      variant="secondary"
                      onClick={() => void startDesktopAuth("sign-in")}
                    >
                      {t("nav.signIn")}
                    </Button>
                    {inAppFallback ? (
                      <SignInButton mode="modal" forceRedirectUrl={redirectUrl}>
                        <Button
                          className="w-full whitespace-normal"
                          variant="ghost"
                        >
                          {t("signedOut.waiting.inApp")}
                        </Button>
                      </SignInButton>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <SignUpButton mode="modal" forceRedirectUrl={redirectUrl}>
                      <Button onClick={() => noteSignupCta("gate", "")}>
                        {t("signedOut.createAccount")}
                      </Button>
                    </SignUpButton>
                    <SignInButton mode="modal" forceRedirectUrl={redirectUrl}>
                      <Button variant="secondary">
                        {invitePreview
                          ? t("signedOut.invite.haveAccount")
                          : t("nav.signIn")}
                      </Button>
                    </SignInButton>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return <ClerkMainApp />;
}

function ClerkMainApp() {
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  /**
   * The only place in the app that can say an account was *created*, as opposed
   * to signed in. Read here rather than deeper down because `MainAppContent` is
   * shared with the dev-auth-bypass path, which renders no `ClerkProvider` at
   * all and would throw on any Clerk hook. A bypass account passing through
   * `undefined` is also correct on its own terms: it is not a sign-up.
   */
  const { user: clerkUser } = useUser();
  const clerkAccount = useMemo(
    () =>
      clerkUser
        ? { id: clerkUser.id, createdAt: clerkUser.createdAt ?? null }
        : null,
    [clerkUser],
  );

  // Stable callback — Clerk's getToken identity changes often and must not
  // remount the app / tear down the WebSocket (that looked like a full refresh).
  const resolveToken = useCallback<TokenResolver>(
    (options) =>
      getAuthToken(() =>
        getTokenRef.current({ skipCache: options?.forceRefresh }),
      ),
    [],
  );

  return (
    <MainAppContent
      resolveToken={resolveToken}
      showUserButton
      clerkAccount={clerkAccount}
    />
  );
}

interface MainAppContentProps {
  resolveToken: TokenResolver;
  showUserButton?: boolean;
  /**
   * Identity and creation instant straight from Clerk, or null where there is
   * no Clerk (the dev auth bypass). Only the Google Ads sign-up conversion
   * reads it; everything else about the person comes from `/api/me`.
   */
  clerkAccount?: { id: string; createdAt: Date | null } | null;
}

interface ChannelPromptState {
  mode: "create" | "rename";
  type?: ChannelType;
  isPrivate?: boolean;
  channel?: Channel;
}

export interface UnreadState {
  count: number;
  mentions: number;
}

function MainAppContent({
  resolveToken,
  showUserButton = false,
  clerkAccount = null,
}: MainAppContentProps) {
  const { t, locale } = useTranslation();
  const [user, setUser] = useState<User | null>(null);
  // The voice note player remembers its speed per account.
  useEffect(() => {
    setVoiceNoteViewer(user?.id ?? null);
  }, [user?.id]);
  // For callbacks that must not change identity when the account loads.
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = user?.id ?? null;
  // Composer drafts are kept per account; a sign-out reads as no drafts.
  useEffect(() => {
    setDraftsAccount(user?.id ?? null);
  }, [user?.id]);
  const [servers, setServers] = useState<Server[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  /**
   * Starts on the conversation view rather than on a server, because at this
   * point there is no server to start on — bootstrap moves it to the first one
   * unless a deep link has already claimed the navigation.
   */
  const [selection, setSelection] = useState<Selection>(HOME_SELECTION);
  /**
   * Whether the Communities directory is covering the app.
   *
   * A mode rather than a place: no `/app/communities` route, deliberately,
   * because a directory URL is a public entry point and this feature is not
   * ready to have one. It is also no longer one of two home views — the
   * directory owns the viewport now and opens from the rail's compass, so it
   * is orthogonal to whatever selection is underneath it and comes back to
   * exactly that when closed.
   */
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [whatsNewUnread, setWhatsNewUnread] = useState(() =>
    hasUnseenWhatsNew(),
  );
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<DmSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [newDmOpen, setNewDmOpen] = useState(false);
  /** Whether any DM arrival card is currently up — see `effectiveCornerHint`. */
  const [dmToastActive, setDmToastActive] = useState(false);
  const [showCreateServer, setShowCreateServer] = useState(false);
  /**
   * Which step the create-server dialog opens on. `name` for every ordinary
   * opener; `import` (the Discord layout paste) when the person asked for it,
   * from the onboarding's third door, a `/vem` CTA or a `?import=discord`
   * campaign link. Reset on close so the next ordinary open is ordinary again.
   */
  const [createServerStart, setCreateServerStart] = useState<CreateIntent>({
    mode: "name",
    source: null,
  });
  /**
   * A create intent somebody arrived with (or the onboarding's third door)
   * that has not been shown yet. Held rather than acted on because onboarding
   * may still be on screen: the dialog opens the moment it is not (see the
   * effect beside the arrival intents).
   */
  const [pendingCreate, setPendingCreate] = useState<CreateIntent | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  /**
   * The good-news counterpart of `appError`, in the same slot.
   *
   * Exists because the two arrival intents (see the effect below) both succeed
   * silently otherwise: a handle is claimed and nothing says so, a friend
   * request is sent and nothing says to whom. Both are the reason the person
   * came, so both are worth one line. Transient app state — nothing persists it
   * and nothing reconstructs it, which is correct for a sentence about
   * something that just happened.
   */
  const [appNotice, setAppNotice] = useState<string | null>(null);
  /**
   * The server's "you have been alone for a while" notice, with the moment
   * it will hang up. One button answers it. Cleared by the answer, by the
   * hangup itself, and by leaving the room.
   */
  const [idleWarning, setIdleWarning] = useState<{
    voiceChannelId: string;
    disconnectAt: number;
  } | null>(null);
  // Set only by a successful handle claim, so the share offer appears at the
  // one moment it is a celebration rather than a request. Cleared with the
  // notice it rides on.
  const [claimedHandle, setClaimedHandle] = useState<string | null>(null);
  /**
   * The last refusal a timeout produced, shown against the composer it belongs
   * to. Transient app state rather than anything persisted: a timeout is
   * already reconstructible from `/api/me` and the members panel, and this only
   * has to answer "why did that not send".
   */
  const [sanctionNotice, setSanctionNotice] = useState<SanctionNotice | null>(
    null,
  );
  const [connection, setConnection] = useState<RealtimeStatus>("idle");
  // The connection check dialog; opened from the banner, the voice stage's
  // timeout, and voice settings (through the request bus).
  const [doctorOpen, setDoctorOpen] = useState(false);
  useEffect(() => onConnectionCheckRequest(() => setDoctorOpen(true)), []);
  /**
   * "Sign in again" for a session the server keeps refusing.
   *
   * Through the Clerk global rather than `useClerk()`: `ClerkProvider` is
   * not mounted under the dev auth bypass, so the hook would throw in local
   * development, and this handler has to exist in both modes. Clerk's own
   * sign-out clears the session on this device and lands on the homepage,
   * which reads as having left rather than as an error; the bypass has no
   * session to clear, so it simply reloads.
   */
  const signInAgain = useCallback(() => {
    const clerk = (
      window as unknown as {
        Clerk?: { signOut?: (options?: { redirectUrl?: string }) => Promise<void> };
      }
    ).Clerk;
    if (!isDevAuthBypassEnabled() && clerk?.signOut) {
      const home = desktopSignedOutPath();
      void clerk.signOut({ redirectUrl: home }).catch(() => {
        window.location.replace(home);
      });
      return;
    }
    window.location.reload();
  }, []);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // `party_newcomer_experience`: the one-line strip was closed on this
  // device. Read once; the write is `dismissPartyNewcomerStrip`.
  const [partyNewcomerStripClosed, setPartyNewcomerStripClosed] = useState(() =>
    isPartyNewcomerStripDismissed(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Non-null while a caller wants a specific section on open — the user
  // menu's "send feedback", and the Steam / Battle.net / Twitch callback.
  // The gear clears it so the dialog keeps its sticky last-visited section.
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId | null>(null);
  // Deep components ask for a section through `requestSettingsSection`
  // (the call stage's mic banner), rather than a prop through two wrappers.
  useEffect(
    () =>
      onSettingsRequest((section) => {
        setSettingsSection(section);
        setSettingsOpen(true);
      }),
    [],
  );
  /**
   * A convenience deep link from the operator dashboard's "fila de
   * denúncias" card: `?modAllReports=1` opens Settings straight on the
   * moderation section. Deliberately its own tiny effect rather than folded
   * into the arrival-intents handling further down — this is not an intent
   * that needs to survive a signed-out round trip through Clerk, just a
   * shortcut for an account that is already signed in. The section itself
   * gates on `GET /api/reports/all`, so this silently does nothing for
   * anyone who is not an instance moderator; there is nothing here worth
   * guarding twice.
   */
  const modAllReportsLinkHandled = useRef(false);
  useEffect(() => {
    if (modAllReportsLinkHandled.current) {
      return;
    }
    modAllReportsLinkHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    if (!params.get("modAllReports")) {
      return;
    }
    params.delete("modAllReports");
    const rest = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`,
    );
    setSettingsSection("moderation");
    setSettingsOpen(true);
  }, []);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
  const [inviteMode, setInviteMode] = useState<"create" | "join" | null>(null);
  const [inviteCodeFromUrl, setInviteCodeFromUrl] = useState<string | null>(null);
  /**
   * The refusal an auto-joined invite came back with, handed to the panel that
   * opens as the fallback. Without it the panel would open pre-filled and silent,
   * which reads as "nothing happened" rather than "that link is dead".
   */
  const [inviteErrorFromUrl, setInviteErrorFromUrl] = useState<string | null>(
    null,
  );
  /**
   * This session started on an invite link.
   *
   * Sticky for the life of the session, and it has to be: the wizard reads it to
   * decide whether to skip its "you have nowhere to go" step, and the obvious
   * source — is the URL an invite URL — stops being true almost immediately.
   * `refreshAfterJoin` moves the selection, `syncRoute` rewrites the address bar
   * to the channel, and the wizard is still on its first screen. Reading the
   * pathname there answered "no" every time and the dead step showed anyway.
   */
  const [arrivedOnInviteLink, setArrivedOnInviteLink] = useState(false);
  /**
   * The server this session just walked into from an invite link, if the banner
   * for it has not been shown on this device before.
   *
   * Session state and not just the localStorage record, because the two answer
   * different questions: the record says "this device has been welcomed here",
   * and this says "the welcome is on screen right now". Arming it only from a
   * completed join is what keeps the banner off servers the account has been in
   * for months but is opening on a new machine.
   */
  const [arrivalServerId, setArrivalServerId] = useState<string | null>(null);
  /**
   * Where the join behind the first-run wizard stands, for its "você" step:
   * the step names the room that is waiting ("{server} tá te esperando") and
   * its button says "Entrar em {server}". Unlike `arrivalServerId` this is
   * set whether or not this device has welcomed the account there before.
   */
  const [inviteJoin, setInviteJoin] = useState<
    "pending" | "failed" | { serverId: string } | null
  >(null);
  /**
   * The same two facts for a community's public link (`/c/<slug>`, which
   * reaches the app as `?join=<slug>`). That person came for one room, so the
   * first run takes the invite's shape: two screens, the room named on the
   * first, and no "create your own server" door. On 2026-09-26, 7 of the 93
   * accounts MoonKase's link created mid-show made a server of their own in
   * that step and were moved into it, away from the party they came for.
   * A failed join is not an invite that died, so it never borrows that copy:
   * `communityJoin === "failed"` hands the wizard a plain first screen.
   */
  const [arrivedOnCommunityLink, setArrivedOnCommunityLink] = useState(false);
  const [communityJoin, setCommunityJoin] = useState<
    "pending" | "failed" | { serverId: string } | null
  >(null);
  /**
   * Servers this account made in this session. The arrival banner says "your
   * room is ready, bring the crew" to their owner rather than "say oi", and
   * the empty channel offers the invite, while nobody else has come.
   */
  const [createdServerIds, setCreatedServerIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /**
   * The age gate was just answered and the app is loading behind it. The gate
   * stays on screen in its saving state until the wizard can take the same
   * panel over (`entrance={false}`), so the two read as one window with no
   * loading screen flashed between them.
   */
  const [gateHandoff, setGateHandoff] = useState(false);
  /** The wizard finished in this tab: the invitee's confetti fires on arrival. */
  const [justOnboarded, setJustOnboarded] = useState(false);
  const [qgHintReady, setQgHintReady] = useState(false);
  /** Whether the QG card WANTS the corner. `cornerHint` decides who gets it. */
  const [qgHintWanted, setQgHintWanted] = useState(false);
  /**
   * Captured once per mount so recording the impression cannot drop the
   * card mid-session (and cannot leave the slot empty while the next card
   * waits). A refresh reads storage again and the queue moves on.
   *
   * The card calls `onDismiss` when it is closed, which is a different
   * thing from its impression: it no longer wants the corner, and holding
   * it for a card nobody can see buries every tip behind it.
   */
  const [wantsMobileBeta, setWantsMobileBeta] = useState(() =>
    shouldShowMobileBetaHint(),
  );
  const [wantsWhatsNew, setWantsWhatsNew] = useState(
    () => !isAutomatedBrowser() && !isWhatsNewSeen(),
  );
  const [wantsComposerFormatHint] = useState(() =>
    featureHintEligible("composerFormat"),
  );
  const [wantsWatchPartyHint] = useState(() =>
    featureHintEligible("watchParty"),
  );
  const [wantsWatchNowHint] = useState(() => featureHintEligible("watchNow"));
  const [wantsBringFriendsHint] = useState(() =>
    featureHintEligible("bringFriends"),
  );
  const [wantsMusicHint] = useState(() => featureHintEligible("music"));
  const [wantsMusicFieldHint] = useState(() =>
    featureHintEligible("musicField"),
  );
  // Open + whether a track is on, which is what the music hint's live half
  // reads. The snapshot deliberately ignores position samples, so this does
  // not put the playhead on App's render path.
  const musicDock = useMusicDock();
  const [wantsCallDockHint] = useState(() => featureHintEligible("callDock"));
  // The cargos card decides for itself whether it was seen; the corner queue
  // has to know too, or the corner stays "taken" by a card that never draws
  // and every attached tip behind it (share, music) waits for good. Same for
  // a card that HAS drawn and was then dismissed, which is what the
  // `onDismiss` below is: on localhost `lib/hints.ts` remembers no dismissal
  // on purpose, so this card wanted the corner on every load and the in-call
  // tips could not be drawn once.
  const [wantsCargosHint, setWantsCargosHint] = useState(
    () => !isAutomatedBrowser() && !isCargosHintSeen(),
  );
  const [wantsChannelPinHint] = useState(() =>
    featureHintEligible("channelPin"),
  );
  const [wantsShortcutsHint, setWantsShortcutsHint] = useState(() =>
    featureHintEligible("shortcuts") && supportsKeyBinding(),
  );
  // Dismissing an attached hint writes to a set in `lib/feature-hints.ts`
  // that `winningFeatureHint` reads while this renders. Subscribing here is
  // what makes the next tip arrive on that click rather than on whatever
  // happens to re-render App next.
  useFeatureHintsSpent();
  const [shortcutsQuietReady, setShortcutsQuietReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShortcutsQuietReady(true), 1600);
    return () => window.clearTimeout(timer);
  }, []);
  const [membersOpen, setMembersOpen] = useState(false);
  const [serverSettingsSection, setServerSettingsSection] = useState<
    "roles" | undefined
  >(undefined);
  // The always-there roster down the right. Its own hook because the state is a
  // per-device preference plus a media query, and the button that flips it lives
  // in the channel header rather than in the panel.
  const memberSidebar = useMemberSidebar();

  // --- how the call and the transcript share the pane ---------------------
  // Two per-device preferences, neither synced, for the reason the roster's is
  // not: they are opinions about a monitor, not about a person. The rules and
  // the storage live in `lib/call-split.ts` and
  // `lib/channel-sidebar-preference.ts`; what is here is the state, and the
  // two toggles in the channel header that write it.
  const [callSplit, setCallSplit] =
    useState<CallSplitPreference>(CALL_SPLIT_DEFAULT);
  useEffect(() => {
    // Read after the first paint: a denied localStorage must not be able to
    // stop the app rendering, and an Electron window that restores its
    // geometry late still gets the same answer.
    setCallSplit(loadCallSplit());
  }, []);
  /**
   * The pane's shape, taken from whichever mounted stage is asking for the
   * most room rather than from whichever reported last.
   *
   * A watch party channel mounts three of them at once: the party panel, the
   * watch stage and the call stage. Each reports its own shape as it appears
   * and disappears, so under the old single setter the one going away
   * ("none", about itself) could flatten the pane while another was still
   * showing a picture, collapsing the split for no visible reason.
   * `strongestStageShape` is the rule; the ref is so a report from one source
   * does not have to know what the others last said.
   */
  const stageShapesRef = useRef<Record<string, CallStageShape>>({});
  const [stageShape, setStageShape] = useState<CallStageShape>("none");
  const reportStageShape = useCallback(
    (source: string, shape: CallStageShape) => {
      if (stageShapesRef.current[source] === shape) {
        return;
      }
      stageShapesRef.current = { ...stageShapesRef.current, [source]: shape };
      setStageShape(strongestStageShape(Object.values(stageShapesRef.current)));
    },
    [],
  );
  const handleStageShape = useCallback(
    (shape: CallStageShape) => reportStageShape("call-stage", shape),
    [reportStageShape],
  );
  const handleWatchStageShape = useCallback(
    (shape: CallStageShape) => reportStageShape("watch-stage", shape),
    [reportStageShape],
  );
  const handleWatchPartyShape = useCallback(
    (shape: CallStageShape) => reportStageShape("watch-party", shape),
    [reportStageShape],
  );
  /**
   * A voice-only call's bar is docked in the composer (`call-dock.tsx`). While
   * it is, the sidebar's call strip drops its camera and share row (the same
   * two buttons are on the dock) and the chat pane draws no header, since
   * there is nothing above the transcript for a header to sit under.
   */
  const [callDockOnScreen, setCallDockOnScreen] = useState(false);
  const [splitState, setSplitState] = useState<CallSplitState>({
    active: false,
    canSideBySide: false,
  });
  /**
   * THE WATCH PARTY'S ONE BAR (pass 2 of `docs/plans/WATCH_PARTY_UI.md`).
   * Two candidate elements, one handed out: the slot this file draws over
   * the bottom of the stage pane, and the span `HlsWatchPlayer` draws in
   * its own bottom bar for a seatless viewer. The player's wins while it
   * exists, so a viewer with a picture never gets two bars. See
   * `WatchPartyBarSlot`.
   */
  const [stageBarEl, setStageBarEl] = useState<HTMLDivElement | null>(null);
  const [playerBarEl, setPlayerBarEl] = useState<HTMLDivElement | null>(null);
  const watchPartyBarSlot = playerBarEl ?? stageBarEl;
  /** The host's status line over the top edge of the stage (pass 3). */
  const [statusSlotEl, setStatusSlotEl] = useState<HTMLDivElement | null>(null);
  /**
   * ONE PANEL WITH TABS (pass 4): which body the chat column shows while a
   * party is live, Chat or Pessoas. Back to Chat on every channel change.
   */
  const [watchPanelTab, setWatchPanelTab] = useState<"chat" | "people">("chat");
  useEffect(() => {
    setWatchPanelTab("chat");
  }, [selectedChannelId]);
  const handleSplitState = useCallback((next: CallSplitState) => {
    setSplitState((previous) =>
      previous.active === next.active &&
      previous.canSideBySide === next.canSideBySide
        ? previous
        : next,
    );
  }, []);
  const handleCallSplitChange = useCallback(
    (next: CallSplitPreference, persist: boolean) => {
      setCallSplit(next);
      if (persist) {
        // A drag writes once, when it lets go: a `setItem` per pointer move is
        // a synchronous disk write per frame.
        saveCallSplit(next);
      }
    },
    [],
  );
  const toggleSplitOrientation = useCallback((kind: CallSplitKind) => {
    setCallSplit((previous) => {
      const flipped =
        effectiveOrientation(previous, kind) === "side-by-side"
          ? "stacked"
          : "side-by-side";
      // A watch party keeps its own answer: flipping the film night's layout
      // must not rearrange tomorrow's work call, and the other way round.
      // The seated surface and the audience surface share that one answer
      // (see `isWatchPartySplit`): a person who flips it while watching
      // should not have it flip back the moment they take a seat.
      const next: CallSplitPreference =
        kind === "watch" || kind === "watch-audience"
          ? { ...previous, watchOrientation: flipped }
          : { ...previous, orientation: flipped };
      saveCallSplit(next);
      return next;
    });
  }, []);

  // The channel list as a strip of icons. `auto` follows the share until
  // somebody touches the toggle; after that it is theirs.
  const columnLayout = useMdUp();
  // Voz limpa nudge: the card only shows `sm` and up (docs/ONBOARDING.md —
  // below it the NOVO dot in Settings is the discoverability instead).
  const voiceCleanDesktopViewport = useSmUp();
  const [voiceCleanActivatedToast, setVoiceCleanActivatedToast] =
    useState(false);
  const [channelSidebar, setChannelSidebar] =
    useState<ChannelSidebarPreference>("auto");
  useEffect(() => {
    setChannelSidebar(loadChannelSidebarPreference());
  }, []);

  /**
   * Bumped on any `presence-update` or `presence-delta` frame. Status itself is a pull surface
   * (see `server/src/ws/status.ts`); the frame is only "somebody started
   * looking at a channel in here", which is the cheapest hint that presence
   * may have moved. The shared roster hook debounces it into one re-read so
   * both the sidebar and the transcript pips update from the same map.
   */
  const [memberRosterNudge, setMemberRosterNudge] = useState(0);
  /**
   * A burst of presence frames — a busy watch party's audience joining and
   * leaving the channel — used to bump `memberRosterNudge` once PER FRAME,
   * and every bump is a `setState` that re-renders this entire component.
   * `useMemberRosterRefresh` already debounces the read the nudge triggers,
   * but that debounce runs downstream of the re-render, not in front of it:
   * a hundred presence frames in a few seconds was a hundred full renders of
   * the whole app — sidebar, member list, the open channel's transcript —
   * before even one of them did anything. This coalesces same-window bumps
   * into one, leading-edge immediately and then at most once per
   * `PRESENCE_NUDGE_COALESCE_MS`, so a burst costs one render instead of
   * one per frame while a lone frame still lands right away.
   */
  const presenceNudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const presenceNudgePendingRef = useRef(false);
  const PRESENCE_NUDGE_COALESCE_MS = 250;
  const bumpMemberRosterNudge = useCallback(() => {
    if (presenceNudgeTimerRef.current !== null) {
      presenceNudgePendingRef.current = true;
      return;
    }
    setMemberRosterNudge((n) => n + 1);
    presenceNudgeTimerRef.current = setTimeout(() => {
      presenceNudgeTimerRef.current = null;
      if (presenceNudgePendingRef.current) {
        presenceNudgePendingRef.current = false;
        setMemberRosterNudge((n) => n + 1);
      }
    }, PRESENCE_NUDGE_COALESCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (presenceNudgeTimerRef.current !== null) {
        clearTimeout(presenceNudgeTimerRef.current);
      }
    },
    [],
  );
  // Bumped on `community-home-update` for the OPEN server only — Baú refetches
  // its posts rather than the client trying to patch one row from the frame,
  // since the frame carries no post id (see `communityHomeUpdateSchema`).
  const [communityHomeUpdateNudge, setCommunityHomeUpdateNudge] = useState(0);
  // A ticket for every fetch of the open server's channel list that the
  // `channels-update` refetch has to order itself against. Only the newest
  // ticket may write the list, so two quick frames (a create and a rename a
  // second apart) cannot land out of order, and a refetch from an earlier
  // visit to this server cannot land on top of the list the visit loaded
  // (`loadChannels` and `applyChannelRoute` take a ticket too).
  const [channelListTickets] = useState(createChannelListTickets);
  // The pending retry of a failed `channels-update` refetch, and the server
  // whose list stayed stale after every retry failed. That one is refetched
  // on the next socket reconnect rather than waiting for a navigation.
  const channelListRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const channelListStaleRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (channelListRetryTimerRef.current !== null) {
        clearTimeout(channelListRetryTimerRef.current);
      }
    },
    [],
  );
  const refreshChannelListRef = useRef<(serverId: string) => void>(() => {});
  /**
   * Servers a navigation is loading the channel list for, with how many. While
   * one is in flight `selectedChannelIdRef` may still name the channel of the
   * server the reader just left, so a refetch must not read it as deleted.
   */
  const channelLoadsRef = useRef(new Map<string, number>());
  const beginChannelLoad = (serverId: string) => {
    channelLoadsRef.current.set(
      serverId,
      (channelLoadsRef.current.get(serverId) ?? 0) + 1,
    );
  };
  const endChannelLoad = (serverId: string) => {
    const left = (channelLoadsRef.current.get(serverId) ?? 1) - 1;
    if (left <= 0) {
      channelLoadsRef.current.delete(serverId);
    } else {
      channelLoadsRef.current.set(serverId, left);
    }
  };
  // The instance's Baú flags, resolved once before the first landing so the
  // bootstrap can choose between Home and the first text channel. Off until
  // the API answers; a ref mirrors it for the callbacks that pick a landing.
  const [communityHomeConfig, setCommunityHomeConfig] = useState(
    COMMUNITY_HOME_CONFIG_OFF,
  );
  const communityHomeConfigRef = useRef(COMMUNITY_HOME_CONFIG_OFF);
  // "NEW" chip on the Baú row until it is opened once per server.
  const [communityHomeRowNew, setCommunityHomeRowNew] = useState(false);
  /** Unread Baú posts for the open server, for the sidebar row's badge. */
  const [communityHomeUnread, setCommunityHomeUnread] = useState(0);
  const communityHomeUnreadRef = useRef(0);
  const communityHomeUnreadServerRef = useRef<string | null>(null);
  const communityHomeUpdateNudgeRef = useRef(0);
  /** A successful unread read for `communityHomeUnreadServerRef`. */
  const communityHomeUnreadBaselineRef = useRef(false);
  /** Live corner card for a publish in the open server, not the author. */
  const [communityHomePostToast, setCommunityHomePostToast] = useState<{
    serverId: string;
    serverName: string;
  } | null>(null);
  const communityHomePostToastRef = useRef(communityHomePostToast);
  communityHomePostToastRef.current = communityHomePostToast;
  const communityHomeOn = useCallback(
    () =>
      isCommunityHomeEnabled({
        config: communityHomeConfigRef.current,
        allowLocalOverride: isDevAuthBypassEnabled(),
      }),
    [],
  );
  // One dialog for both subjects — the target says which. Null means closed.
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  // Stable identity for `MessageList`'s `onReportMessage`: an inline arrow
  // here was rebuilt on every render of this (huge) component, which read
  // as "this row's props changed" to `MessageRow`'s `memo()` for every row
  // on every unrelated re-render — see the row-callback cache in
  // message-list.tsx for the other half of this fix.
  const handleReportMessage = useCallback((message: ChatMessage) => {
    setReportTarget({
      kind: "message",
      messageId: message.id,
      subjectName: message.authorName,
    });
  }, []);
  const [pinsOpen, setPinsOpen] = useState(false);
  // Watch party scheduling: the one upcoming/live session for the selected
  // voice channel and every voice channel's sidebar hint, both derived from
  // one server-wide fetch: the card needs the selected channel's session,
  // the sidebar hint needs every other one, and a session can only change
  // through this app's own actions or the minute-tick job, so refetching the
  // whole server on channel-list load is simpler than N per-channel
  // requests and correct either way. Flag-gated at the one place each part
  // is read.
  const [sessionsByChannel, setSessionsByChannel] = useState<
    Record<string, ChannelSession>
  >({});
  const [scheduleSheetOpen, setScheduleSheetOpen] = useState(false);
  const [scheduleClock, setScheduleClock] = useState(() => new Date());
  const upcomingSession =
    selectedChannelId ? sessionsByChannel[selectedChannelId] ?? null : null;
  useEffect(() => {
    if (!isChannelSessionScheduleEnabled()) {
      return;
    }
    const timer = window.setInterval(() => setScheduleClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!isChannelSessionScheduleEnabled() || selection.kind !== "server") {
      setSessionsByChannel({});
      return;
    }
    const serverId = selectionServerId(selection);
    if (!serverId) {
      setSessionsByChannel({});
      return;
    }
    let cancelled = false;
    void listUpcomingChannelSessionsForServer(serverId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        const map: Record<string, ChannelSession> = {};
        for (const session of result.sessions) {
          map[session.channelId] = session;
        }
        setSessionsByChannel(map);
      })
      .catch(() => {
        if (!cancelled) {
          setSessionsByChannel({});
        }
      });
    return () => {
      cancelled = true;
    };
    // `channels.length` re-runs this after a session is created/edited/
    // cancelled elsewhere invalidates nothing here directly; those handlers
    // below patch `sessionsByChannel` in place instead of waiting on a refetch.
  }, [selection]);
  const handleScheduleSessionSubmit = async (input: {
    title: string;
    startsAt: string;
    description: string | null;
  }) => {
    if (!selectedChannelId) {
      return;
    }
    if (upcomingSession && upcomingSession.status === "scheduled") {
      const { session } = await updateChannelSession(upcomingSession.id, input);
      setSessionsByChannel((previous) => ({
        ...previous,
        [session.channelId]: session,
      }));
      return;
    }
    const { session } = await createChannelSession(selectedChannelId, input);
    setSessionsByChannel((previous) => ({
      ...previous,
      [session.channelId]: session,
    }));
  };
  const handleToggleSessionReminder = async (wants: boolean) => {
    if (!upcomingSession) {
      return;
    }
    await setChannelSessionReminder(upcomingSession.id, wants);
  };
  const handleCancelSession = async () => {
    if (!upcomingSession) {
      return;
    }
    await cancelChannelSession(upcomingSession.id);
    setSessionsByChannel((previous) => {
      const next = { ...previous };
      delete next[upcomingSession.channelId];
      return next;
    });
  };
  // The watch party EVENT (host, state machine, options), which is a
  // different object from the schedule above even though they are the same
  // database row: the schedule surface only ever sees `scheduled` and `live`,
  // this one also sees `draft`. `docs/WATCH_PARTY.md`.
  const watchParties = useWatchParties(
    selection.kind === "server" ? selectionServerId(selection) : null,
  );
  const [createWatchPartyOpen, setCreateWatchPartyOpen] = useState(false);
  /**
   * The watch party waitlist (`docs/WATCH_PARTY.md` §"The waitlist"). The
   * dialog, a `?intent=watch-party-waitlist` waiting for onboarding to finish,
   * and the "liberada" cards for servers the operator has since turned on.
   */
  const [waitlistDialogOpen, setWaitlistDialogOpen] = useState(false);
  const [pendingWaitlist, setPendingWaitlist] = useState(false);
  /**
   * The page whose button opened the dialog (`from=streamers`), sent with the
   * row so the operator can tell a streamer's request apart. Only for the
   * dialog the intent opens: closing it clears this, so the sidebar teaser
   * opened later sends no marker.
   */
  const [waitlistSource, setWaitlistSource] =
    useState<WatchPartyWaitlistSource | null>(null);
  const [waitlistApprovals, setWaitlistApprovals] = useState<
    WatchPartyApprovedCard[]
  >([]);
  /**
   * The draft THIS TAB opened and has not published yet, plus whether its
   * setup surface was ever actually on screen. See `watch-party-draft.ts`:
   * a draft this tab created and walked away from is an abandoned lock on the
   * whole server, and a draft it merely adopted (after F5, or from the
   * sidebar's pending card) is a party the host is deliberately holding open.
   * `seen` exists so the create's own await window, in which the draft is
   * already in the store and the channel is not selected yet, cannot read as
   * walking away from it.
   */
  const sessionDraftRef = useRef<{ partyId: string; seen: boolean } | null>(
    null,
  );
  // The socket handler is installed once; without a ref it would keep calling
  // the first render's `apply` and never update anything after a server
  // switch. Same pattern as `permsRef` above.
  const watchPartiesRef = useRef(watchParties);
  watchPartiesRef.current = watchParties;

  const [channelSettings, setChannelSettings] = useState<{
    channelId: string;
    section: ChannelSettingsSectionId;
    forceAdvanced: boolean;
  } | null>(null);
  // "Transmissões anteriores": past broadcasts for a watch-party channel.
  // Its own dialog and its own trigger next to the settings gear, because
  // START_WATCH_PARTY alone does not open `ChannelSettingsDialog` (that gear
  // is MANAGE_CHANNELS / MANAGE_ROLES only) and the two groups who should
  // reach this are the same OR the server route checks.
  const [watchPartyHistoryChannelId, setWatchPartyHistoryChannelId] =
    useState<string | null>(null);
  const [channelPrompt, setChannelPrompt] = useState<ChannelPromptState | null>(
    null,
  );
  const [pendingDeleteChannelId, setPendingDeleteChannelId] = useState<
    string | null
  >(null);
  /**
   * The channel whose "clear recent messages" dialog is open. Holds the name
   * as well as the id: the dialog says which channel it is about, and by the
   * time it is answered the list may have moved on.
   */
  const [purgeChannel, setPurgeChannel] = useState<{
    id: string;
    name: string;
    /** Seeded by `/clear <count>`; absent when opened from the channel menu. */
    initialCount?: number;
  } | null>(null);
  const [pendingLeaveServerId, setPendingLeaveServerId] = useState<
    string | null
  >(null);
  const [composerInsert, setComposerInsert] = useState<string | null>(null);
  const [droppedItems, setDroppedItems] = useState<DroppedItems | null>(null);
  const [localSettings, setLocalSettings] = useState<LocalSettings>(
    defaultLocalSettings,
  );
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  /**
   * The one friends snapshot, held here rather than by the friends view, for the
   * two reasons `use-friends.ts` argues: the request badge has to be drawn on the
   * app's front door — which the friends view cannot reach — and the shell is
   * where socket frames arrive, so it is the only place a `friend-activity` nudge
   * can be handed to.
   *
   * Declared HERE, below `bootstrapReady`, and that position is load-bearing: it
   * is the gate that stops the store's first read racing ahead of the effect that
   * installs the API's token provider. Moving this line above that state would
   * bring back a 401 on every cold boot.
   */
  const friends = useFriendsStore(bootstrapReady);
  const memberSidebarFriendIds = useMemo(
    () => new Set(friends.data.friends.map((friend) => friend.id)),
    [friends.data.friends],
  );
  /**
   * False on every deployment that has not turned the directory on, which is
   * all of them today. Nothing about Communities renders while it is false —
   * not the nav row, not the view, not the owner's opt-in section.
   *
   * Gated on `bootstrapReady` for exactly the reason the friends store above
   * is: the token provider is installed in an effect, and a config fetch that
   * beats it takes a 401 on every cold boot.
   */
  const communitiesEnabled = useCommunitiesEnabled(bootstrapReady);
  /**
   * Non-null while the 18+ gate is standing between this account and the app.
   *
   * Held here rather than read off `user` because it is a bootstrap outcome,
   * not a profile field: the rest of the bootstrap never ran, so there are no
   * servers, no conversations and no socket behind this screen to fall back to.
   */
  const [ageGate, setAgeGate] = useState<Exclude<AgeGateStatus, "passed"> | null>(
    null,
  );
  /**
   * Whether this account still has to be shown the first-run flow.
   *
   * Decided once, from the `/api/me` the bootstrap already makes, and never
   * re-derived from `user` afterwards — the flow itself writes profile updates
   * back into `user`, and re-reading the answer from a value the flow is
   * changing is how a dialog closes itself halfway through.
   */
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  /** The channel whose history request last failed; see `historyFailed`. */
  const [historyFailedChannelId, setHistoryFailedChannelId] = useState<
    string | null
  >(null);
  /** Orders overlapping history requests; see `createHistoryLoadTracker`. */
  const [historyLoads] = useState(createHistoryLoadTracker);
  const clearHistoryFailed = useCallback((channelId: string) => {
    setHistoryFailedChannelId((failed) =>
      failed === channelId ? null : failed,
    );
  }, []);
  const [unread, setUnread] = useState<Record<string, UnreadState>>({});
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [mentionableRoles, setMentionableRoles] = useState<
    Array<Pick<ServerRole, "id" | "name" | "mentionable" | "isEveryone">>
  >([]);
  const [serverMembers, setServerMembers] = useState<ServerMember[]>([]);
  const [serverRoles, setServerRoles] = useState<ServerRole[]>([]);
  const [forwardMessage, setForwardMessage] = useState<ChatMessage | null>(null);
  const unreadHoldRef = useRef(new Set<string>());
  const [unreadHeldIds, setUnreadHeldIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** Last-read cursor from before this visit, for the NEW rule. */
  const [unreadSince, setUnreadSince] = useState<string | null>(null);
  const [threadUnreadSince, setThreadUnreadSince] = useState<string | null>(
    null,
  );
  const unreadCursorByChannelRef = useRef<Record<string, string>>({});
  // Messages that arrive in the open channel are read once they are on
  // screen; see `live-read-ack.ts` for why this is not done on leave alone.
  // Every write to a channel's read cursor goes through this queue, in order:
  // the server keeps whichever write commits last, so an ack still in flight
  // must not land after a Mark unread or after the next open's read.
  const [readCursorQueue] = useState(createChannelWriteQueue);
  /**
   * The channel whose message list is at its live end (history loaded, pinned
   * to the bottom of the newest page), as `MessageList` reports it. Null while
   * no list is mounted, and reset the moment a channel starts loading: a
   * report from the list that was on screen before is about another channel,
   * and a message nobody has on screen has not been read.
   */
  const messageListLiveEndRef = useRef<string | null>(null);
  /**
   * The main transcript is mounted but not on screen: What's New hides the
   * whole chat pane, and on a phone the thread panel covers it. The list still
   * reports "at its live end" then (a hidden box reads as pinned), so this is
   * what stops a message nobody can see from being acked. Set below, where
   * `openThread` and the layout are known.
   */
  const transcriptObscuredRef = useRef(false);
  const [liveReadAck] = useState(() =>
    createLiveReadAck({
      queue: readCursorQueue,
      send: (channelId, lastReadAt) =>
        markChannelRead(channelId, lastReadAt, { forwardOnly: true }),
      isVisible: () => document.visibilityState === "visible",
      isAtLiveEnd: () =>
        !transcriptObscuredRef.current &&
        messageListLiveEndRef.current !== null &&
        messageListLiveEndRef.current === selectedChannelIdRef.current,
      isSelected: (channelId) => selectedChannelIdRef.current === channelId,
      isHeld: (channelId) => unreadHoldRef.current.has(channelId),
    }),
  );
  useEffect(() => {
    const onVisibility = () => liveReadAck.resume();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      liveReadAck.dispose();
    };
  }, [liveReadAck]);
  const handleMessageListLiveEnd = useCallback(
    (atLiveEnd: boolean, channelId: string | null) => {
      if (atLiveEnd && channelId) {
        messageListLiveEndRef.current = channelId;
        // Scrolled back down: what arrived while they were up is read now.
        liveReadAck.resume();
      } else if (messageListLiveEndRef.current === channelId) {
        // Only the list's own channel: a late unmount of the previous list
        // must not clear the report of the one on screen now.
        messageListLiveEndRef.current = null;
      }
    },
    [liveReadAck],
  );
  // Every way of leaving a channel acks what was seen there and ends the
  // visit. `openChannel` does it before it switches; this catches the rest
  // (Home, a closed conversation route, a deleted channel, a lost server).
  // A second flush of the same channel finds nothing left and sends nothing.
  const liveReadAckChannelRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = liveReadAckChannelRef.current;
    liveReadAckChannelRef.current = selectedChannelId;
    if (previous && previous !== selectedChannelId) {
      liveReadAck.flush(previous);
    }
  }, [selectedChannelId, liveReadAck]);
  const [editMessageId, setEditMessageId] = useState<string | null>(null);
  // Stable identity for `MessageList`'s `onEditMessageHandled`: an inline
  // arrow here defeated `MessageList`'s own `memo()` on every render of this
  // component, which is the single biggest thing that was left rebuilding
  // JSX for all ~250 rows on ticks that touched nothing this list reads.
  const clearEditMessageId = useCallback(() => setEditMessageId(null), []);
  /**
   * The selected server's roster as rank only — what the profile card needs to
   * know whether it may offer a timeout, and to whom. Filled from the same fetch
   * as `serverMembers`, so no surface pays a second request for it.
   */
  const [memberRoles, setMemberRoles] = useState<Map<string, MemberRole>>(
    () => new Map(),
  );
  /**
   * Who is currently timed out in the selected server — ids only, and only when
   * this account can manage it, so a plain member never makes the request. It is
   * what tells the profile card whether to offer "Time out" or "End timeout".
   */
  const [timedOutUserIds, setTimedOutUserIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [timeoutsEpoch, setTimeoutsEpoch] = useState(0);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(
    null,
  );
  /**
   * When this reader last sent a message, per channel, in this tab. A link to
   * a message (a search result) opens its channel first and only then asks
   * the list to jump, and that can take a while: the router applies the new
   * address in a transition, then the channel list and the history are
   * fetched. A send made after the link was followed is the newer request, so
   * the jump is dropped rather than scrolling the reader away from what they
   * just sent into a page that does not hold it.
   */
  const lastOwnSendAtRef = useRef(new Map<string, number>());
  const sentSince = useCallback(
    (channelId: string | null, since: number) =>
      channelId !== null &&
      (lastOwnSendAtRef.current.get(channelId) ?? 0) > since,
    [],
  );
  const [, setTick] = useState(0);

  const transport = useMemo(() => createRealtimeTransport(), []);
  const chat = useMemo(() => createChatController(transport), [transport]);
  // --- threads ---
  // A second controller on the same socket, bound to the server's secondary
  // "thread view" slot (`thread-join`), so the panel and the parent channel
  // are both live at once. Frames fan into both; each keeps only its own
  // channel's.
  const threadChat = useMemo(
    () => createChatController(transport, THREAD_CHANNEL_FRAMES),
    [transport],
  );
  const voice = useMemo(() => createVoiceController(transport), [transport]);
  // `useMemo` has no cleanup of its own, so a `transport` that ever changes
  // (or the future reconnect path this is future-proofing for) would leave
  // the OLD controller's `devicechange` listener firing forever, against a
  // `pipeline` it can never touch again. Both calls are idempotent, so this
  // is free the vast majority of the time `transport` never changes.
  //
  // BOTH, NOT JUST THE CLEANUP. React StrictMode replays this effect's
  // cleanup and setup once more on every mount; a setup phase that did
  // nothing would let that replay remove the listener the constructor
  // attached and never put it back, for the rest of the controller's life —
  // invisible here (StrictMode is dev-only), and everywhere else only ever
  // seen as recovery quietly not working. `attachDeviceWatcher()` re-running
  // is what makes the extra cleanup-then-setup a wash instead of a leak.
  useEffect(() => {
    voice.attachDeviceWatcher();
    return () => {
      voice.dispose();
    };
  }, [voice]);
  const [voiceState, setVoiceState] = useState(voice.getState());
  // In a call, the socket keeps a tighter watch on itself: a dead link under
  // a voice seat is found in about ten seconds instead of half a minute. Only
  // in a call, because the pings are paid for on the server by everybody.
  const inVoiceCall = voiceState.status !== "idle";
  useEffect(() => {
    transport.setCallActive(inVoiceCall);
  }, [transport, inVoiceCall]);
  // Leaving the room, or being moved out of it, ends the warning: the seat it
  // was about is gone.
  useEffect(() => {
    if (idleWarning && voiceState.voiceChannelId !== idleWarning.voiceChannelId) {
      setIdleWarning(null);
    }
  }, [idleWarning, voiceState.voiceChannelId]);
  /**
   * Somebody watching a live party without a seat is looking at a film. The
   * member column is the thing that eats the width the chat needs beside it,
   * and a viewer never needs the roster during a show, so it steps aside on
   * its own (not written: their preference is untouched, and the toggle
   * brings it straight back). The channel list is deliberately NOT folded
   * for this: the live party block lives in it.
   */
  const watchingAParty =
    selectedChannelId !== null &&
    watchParties.byChannel[selectedChannelId]?.state === "live" &&
    voiceState.channelLive[selectedChannelId]?.stream != null &&
    !(
      voiceState.voiceChannelId === selectedChannelId &&
      voiceState.status !== "idle"
    );
  /**
   * THE PRESENTER'S LIVE LAYOUT (2026-09-13, the live-layout pass of
   * `docs/plans/WATCH_PARTY_PRESENTER_UI.md`). Once the host's own share is
   * up in a live party, the roster column is put away the same way it is
   * for a viewer, and a chat the host had collapsed comes back: their job
   * is now the room, and the members list is not the room.
   */
  const presentingAParty =
    selectedChannelId !== null &&
    watchParties.byChannel[selectedChannelId]?.state === "live" &&
    voiceState.voiceChannelId === selectedChannelId &&
    voiceState.isSharingScreen;
  useEffect(() => {
    memberSidebar.suspend(watchingAParty || presentingAParty);
    // `memberSidebar.suspend` is a stable callback from the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchingAParty, presentingAParty]);
  const wasPresenting = useRef(false);
  useEffect(() => {
    const rose = presentingAParty && !wasPresenting.current;
    wasPresenting.current = presentingAParty;
    if (rose && callSplit.collapsed === "chat") {
      handleCallSplitChange({ ...callSplit, collapsed: "none" }, true);
    }
    // Only the rising edge matters; the split is read at that instant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentingAParty]);
  /**
   * "ATIVAR O MIC?" ONCE, AT GO-LIVE. The host always joins muted (see
   * `handleWatchPartyGoLive`), which used to leave a permanent red strip
   * saying so. One question at the moment it matters instead; the status
   * row keeps the quiet reminder afterwards.
   */
  const [micPromptPartyId, setMicPromptPartyId] = useState<string | null>(null);
  const [pendingVoiceMoves, setPendingVoiceMoves] = useState<string[]>([]);
  /**
   * Audio consent for a Windows desktop shell whose picker cannot ask yet.
   * Null is the ordinary case. The next desktop binary puts the box on the
   * picker and this stays null forever.
   */
  const [shareAudioPrompt, setShareAudioPrompt] = useState<{
    intent?: ScreenCaptureIntent;
    /** Asked on the Linux desktop app, where the fine print differs. */
    linux?: boolean;
  } | null>(null);
  /**
   * The cursor preference, in the opposite arrangement, and deliberately.
   *
   * It is remembered per person (`lib/screen-capture-cursor.ts`) because it
   * cannot hurt the room the way the line above can, and the person it exists
   * for shares a film every night. It is read from its own store rather than
   * held here, so changing it costs no prop through four components. This
   * effect is the mid-share half: a share already running follows the new
   * preference in place, no picker, no restart, no dropped picture. Today the
   * controller finds no engine that can honour it and returns having done
   * nothing; the wiring is what makes a live share follow the day one can.
   */
  const shareCursor = useShareCursor();
  useEffect(() => {
    void voice.applyShareCursor(shareCursor);
  }, [voice, shareCursor]);
  // --- voice state ---
  // Mirror this client's mute/deafen onto the wire so the roster can badge it
  // for everyone else. Lives outside the voice controller: it is display
  // state, and dropping every frame of it would change nothing about the call.
  useVoiceStateSync(transport, voiceState);

  /**
   * Whose screen share is currently arriving with sound.
   *
   * Read off the received stream rather than off what the presenter ticked,
   * which is the same question `collectScreenTiles` answers for the stage. The
   * sidebar needs it so that clicking a presenter under a voice channel offers
   * the second slider ("the film, not him") and clicking anybody else does not
   * offer a knob that moves nothing.
   */
  const screenAudioUserIds = useMemo(
    () =>
      voiceState.remotePeers
        .filter((peer) => peer.screenAudioStream != null && peer.userId)
        .map((peer) => peer.userId as string),
    [voiceState.remotePeers],
  );

  // "How was that call?" — armed while a call runs, fires once when one ends
  // that was long enough and had somebody else in it. See use-call-rating.ts
  // for the three gates and why the cooldown is written on show, not on answer.
  const { pending: ratableCall, dismiss: dismissCallRating } =
    useCallRating(voiceState);
  /**
   * channelId → the transport its voice room runs on, read off `voice-roster`
   * frames as they pass by. The members panel needs it to offer the SFU-only
   * server mute honestly; the voice controller deliberately does not keep it
   * per-channel, and this must not touch that file.
   */
  const [voiceRoomTransports, setVoiceRoomTransports] = useState<
    Record<string, VoiceRoomTransport>
  >({});

  /**
   * User status. The manual half comes back from `/api/me` with the rest of the
   * preferences, so it survives a reconnect and follows the account to the next
   * device; the idle half is measured in this tab and reported over the socket.
   *
   * `connected` is load-bearing, not decoration: the server scopes idle to the
   * socket that reported it, so a reconnect has to re-announce it or somebody
   * who was away when the link flapped comes back reading as online.
   */
  const status = useUserStatus({
    stored: user?.preferences?.status ?? null,
    sendIdle: useCallback(
      (idle: boolean) => transport.sendChat({ type: "set-idle", idle }),
      [transport],
    ),
    connected: connection === "online",
  });

  /**
   * The status hook, through a ref: the socket handler is installed once per
   * connection and must not be rebuilt each time the account changes it.
   */
  const statusRef = useRef(status);
  statusRef.current = status;

  /**
   * O recado, the line under the name. A separate hook from `useUserStatus`
   * even though the two controls share a popover, because they share nothing
   * else: the manual status is a preference resolved out of an in-memory
   * registry and never stored anywhere a member list joins to, while this is a
   * column on `users` that reaches everybody through `profile-update`.
   */
  const customStatus = useCustomStatus({
    stored: user?.customStatus ?? null,
    onUserUpdated: setUser,
  });

  const location = useLocation();
  const navigate = useNavigate();
  // Last path this component applied or emitted — guards the deep-link effect
  // against reacting to its own URL writes.
  const routeRef = useRef<string | null>(null);

  const resolveTokenRef = useRef(resolveToken);
  resolveTokenRef.current = resolveToken;
  // Stable, because the connection check restarts when its token getter changes.
  const doctorGetToken = useCallback(() => resolveTokenRef.current(), []);
  const selectedChannelIdRef = useRef<string | null>(null);
  selectedChannelIdRef.current = selectedChannelId;
  /**
   * The realtime handler is installed once at bootstrap and lives for the whole
   * session, so it cannot read the conversation list from a closure — by the
   * time an activity frame arrives that closure is arbitrarily old.
   */
  const conversationsRef = useRef<DmSummary[]>(conversations);
  conversationsRef.current = conversations;
  /**
   * The `lastMessageAt` a `channel-activity` frame gave a conversation row,
   * by channel. That value is this device's clock, not the server's, and a
   * row still holding it must not be ordered against a real message's time
   * (see `applyConversationMessage`).
   */
  const localConversationStampsRef = useRef(new Map<string, string>());
  /** Same reason: the handler files a message into its conversation's row. */
  const blockedUsersRef = useRef<BlockedUser[]>(blockedUsers);
  blockedUsersRef.current = blockedUsers;
  /**
   * The friends store, through a ref, for the same reason every other live
   * value the socket handler touches goes through one: the handler is installed
   * once per connection, and putting a value that changes on every friends
   * refresh into its dependency list would tear the socket down and rebuild it
   * each time somebody's status dot moved.
   */
  const friendsRef = useRef(friends);
  friendsRef.current = friends;
  /** The server the sidebar is showing, or null in the conversation view. */
  const selectedServerId = selectionServerId(selection);
  const selectedServerIdRef = useRef<string | null>(null);
  selectedServerIdRef.current = selectedServerId;
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  /**
   * Servers whose Baú switch may have moved while this app was not listening:
   * every server after a reconnect, and one whose re-read failed. Frames sent
   * while the socket was down are gone, so the switch is re-read from the
   * server the next time that server is opened (the selected one right after
   * the reconnect). One request per server per reconnect at most, never a
   * refetch of the whole server list.
   */
  const communityHomeUnverifiedRef = useRef(new Set<string>());
  /** The newest re-read issued per server; an older answer that lands last is dropped. */
  const communityHomeReadSeqRef = useRef(new Map<string, number>());
  const reconcileCommunityHomeSwitch = useCallback(
    (serverId: string) => {
      communityHomeUnverifiedRef.current.delete(serverId);
      if (!communityHomeOn()) {
        return;
      }
      const seqs = communityHomeReadSeqRef.current;
      const seq = (seqs.get(serverId) ?? 0) + 1;
      seqs.set(serverId, seq);
      const issuedAtVersion =
        serversRef.current.find((row) => row.id === serverId)
          ?.communityHomeVersion ?? 0;
      fetchServerCommunityHomeConfig(serverId).then(
        (config) => {
          if (seqs.get(serverId) !== seq) {
            return;
          }
          setServers((rows) =>
            applyCommunityHomeRead(rows, serverId, config, issuedAtVersion),
          );
        },
        () => {
          if (seqs.get(serverId) === seq) {
            communityHomeUnverifiedRef.current.add(serverId);
          }
        },
      );
    },
    [communityHomeOn],
  );
  const reconcileCommunityHomeSwitchRef = useRef(reconcileCommunityHomeSwitch);
  reconcileCommunityHomeSwitchRef.current = reconcileCommunityHomeSwitch;

  // One-time "you're responsible for what you stream" sheet, gating the
  // first watch-party / HLS broadcast start per user per server.
  const hlsHostAck = useHlsHostAck();
  const [pendingHlsHostAck, setHlsHostAck] = useState<{
    serverId: string;
    /**
     * The share this person asked for before the sheet, resumed on confirm.
     * NULL when the sheet was raised by the watch party setup surface, where
     * confirming starts nothing: the point of moving it there is that the
     * host reads it while nothing is being sent.
     */
    request: ScreenShareStart<ScreenCaptureIntent> | null;
  } | null>(null);
  // Whether this server may go out as HLS at all (the operator's per-server
  // allowlist). A server that cannot has no broadcast to acknowledge, so the
  // sheet is neither fetched nor shown there. Null is "not answered yet",
  // which asks the old way rather than skipping a disclosure by accident.
  const liveHlsConfig = useLiveHlsConfig(selectedServerId);
  // `party_fast_start` (runtime flag, per server): the selected server's
  // answer is what the watch player reads, and the player chunk is fetched
  // as soon as it is on, not when the first playlist URL arrives.
  const partyFastStartOn = liveHlsConfig?.fastStart === true;
  useEffect(() => {
    setPartyFastStart(partyFastStartOn);
  }, [partyFastStartOn]);
  // `watch_camera_sync` (runtime flag, per server, off by default): the same
  // door. Absent (an older API, or no answer yet) is the default, off.
  const watchCameraSyncOn = cameraSyncFromConfig(liveHlsConfig);
  useEffect(() => {
    setWatchCameraSync(watchCameraSyncOn);
  }, [watchCameraSyncOn]);
  // The player chunk is fetched only for somebody on, or entering, a watch
  // party channel (never for the rest of an enabled server's chat).
  const openChannelType =
    selection.kind === "server"
      ? channels.find((c) => c.id === selectedChannelId)?.type
      : undefined;
  const onPartyChannel =
    openChannelType !== undefined && isWatchPartyChannelType(openChannelType);
  useEffect(() => {
    if (shouldPreloadHlsEngine(partyFastStartOn, onPartyChannel)) {
      preloadHlsEngine();
    }
  }, [partyFastStartOn, onPartyChannel]);
  /**
   * Asked ONLY where the server has already said no. A server whose config
   * answered `enabled: true` (it runs watch parties) or has not answered yet
   * makes no waitlist request at all, so nothing here can reach a server
   * where a party can run.
   */
  // A different account gets an empty waitlist store (its rows are private).
  const waitlistOwnerId = user?.id ?? null;
  useEffect(() => {
    setWatchPartyWaitlistOwner(waitlistOwnerId);
  }, [waitlistOwnerId]);
  // Runtime flags reach an open tab: the live-hls config and the waitlist
  // answers are re-asked on focus and on a slow timer, so an operator's flip
  // (the teaser, the camera size, a server switched on) shows without a
  // reload. See `lib/config-refresh.ts`.
  useEffect(() => startConfigRefresh(), []);
  const watchPartyWaitlist = useWatchPartyWaitlist(
    selectedServerId,
    isWatchPartyChannelsEnabled() &&
      selectedServerId !== null &&
      liveHlsConfig?.enabled === false,
  );
  const liveHlsConfigRef = useRef(liveHlsConfig);
  liveHlsConfigRef.current = liveHlsConfig;
  const screenFrameRateRef = useRef(localSettings.screenFrameRate);
  screenFrameRateRef.current = localSettings.screenFrameRate;

  function shareMaxFrameRate(): 30 | 60 {
    const config = liveHlsConfigRef.current;
    return screenCaptureMaxFrameRate({
      preference: screenFrameRateRef.current,
      hlsLadderMax:
        config?.enabled === true
          ? hlsCaptureMaxFrameRate(config.ladder, true)
          : 60,
    });
  }

  const shareRequestGuardRef = useRef(createShareRequestGuard());
  useEffect(() => {
    const guard = shareRequestGuardRef.current;
    guard.invalidate();
    return () => {
      guard.invalidate();
    };
  }, [voiceState.voiceChannelId]);

  const startScreenShareGated = useCallback(
    (audio: boolean, intent?: ScreenCaptureIntent): Promise<boolean> => {
      const withFps = {
        ...intent,
        maxFrameRate: intent?.maxFrameRate ?? shareMaxFrameRate(),
      };
      // Every share start in this file goes through here: the sidebar
      // button, the call stage, the "share without sound" retry, and the DM
      // stage. `screen-share-gate.test.ts` scans this file to keep it so.
      //
      // RESOLVES TO WHETHER THE CAPTURE ITSELF SUCCEEDED (2026-09-14), not
      // merely whether the gate let the request through: a caller that
      // needs to know before acting further (the watch-party go-live mic
      // prompt) awaits this instead of arming something on the strength of
      // "the button was clicked". Most callers still fire and forget, which
      // is unaffected: nothing here changed for them.
      return gateScreenShareStart<ScreenCaptureIntent>({
        request: { audio, intent: withFps },
        serverId: selectedServerIdRef.current,
        hlsEnabled: liveHlsConfigRef.current?.enabled ?? null,
        checkNeedsAck: (serverId) => hlsHostAck.checkNeedsAck(serverId),
        start: (request) => voice.startScreenShare(request.audio, request.intent),
        ask: (serverId, request) => {
          setHlsHostAck({ serverId, request });
        },
      }).then(
        (decision) => decision === "started" && voice.getState().isSharingScreen,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hlsHostAck],
  );
  /**
   * Every "share screen" click lands here. Computer audio is decided in one
   * place, the same place Discord puts it: the picker, or a short prompt
   * when this shell's picker cannot ask yet. A hidden icon on the call bar
   * was how people missed the choice.
   */
  const requestScreenShare = useCallback(
    (intent?: ScreenCaptureIntent) => {
      const token = shareRequestGuardRef.current.tryBegin();
      if (token === null) {
        return;
      }
      void (async () => {
        try {
          // The call's server, not the one on screen: the per-server switch
          // for native Windows share audio follows where the share goes. A DM
          // call has none and gets the global answer.
          const [, nativeShareAudio, shareHighMotionGuard, , shareGameCaptureHint] =
            await Promise.all([
              ensureOsCanExcludeCallAudio(),
              ensureNativeShareAudio(voiceServerIdRef.current),
              ensureShareGuardFlag(voiceServerIdRef.current),
              ensureLinuxShellShareAudio(),
              ensureShareGameCaptureHintFlag(voiceServerIdRef.current),
            ]);
          if (!shareRequestGuardRef.current.isCurrent(token)) {
            return;
          }
          // Carried on the intent, so the answer for THIS share's server is
          // the one its capture is built with, however long a prompt or the
          // HLS disclosure holds it. Same for the share guard's flag.
          const shareIntent: ScreenCaptureIntent = {
            ...intent,
            nativeShareAudio,
            shareHighMotionGuard,
            shareGameCaptureHint,
          };
          const env = liveScreenCaptureEnvironment(shareIntent);
          // "Wants a tab" is only true where tabs exist. In the desktop shell a
          // watch party is a window or a screen, and the machine's sound (minus
          // this app's own output) is the only sound it can carry, so the audio
          // question has to be asked there as it is for any other share.
          const tabSteer = steersAtBrowserTab(env, shareIntent);
          if (needsShareAudioPrompt(env) && !tabSteer && !intent?.stream) {
            setShareAudioPrompt({
              intent: shareIntent,
              linux: env.shellLinuxShareAudio === true,
            });
            return;
          }
          const audio = tabSteer
            ? false
            : env.sharePickerOffersAudio && offersShellSystemAudio(env);
          startScreenShareGated(audio, shareIntent);
        } finally {
          shareRequestGuardRef.current.end(token);
        }
      })();
    },
    [startScreenShareGated],
  );
  const perms = usePermissions(selectedServerId);
  const permsRef = useRef(perms);
  permsRef.current = perms;
  /**
   * Every `watch_party` channel on the open server this viewer may see the
   * history of, that actually has a broadcast to show -- see the long
   * comment on `watchPartyHistoryCandidates`. Computed here, ahead of every
   * conditional early return below (bootstrap error, age gate, onboarding),
   * because it calls a hook and the Rules of Hooks do not bend for how deep
   * in the component that hook's answer is actually used.
   */
  const watchPartyHistoryCandidateChannels = watchPartyHistoryCandidates(
    channels,
    (channelId) =>
      perms.can(Permission.START_WATCH_PARTY, channelId) ||
      perms.can(Permission.MANAGE_CHANNELS, channelId),
  );
  const watchPartyHistoryChannelsRaw = useWatchPartyHistoryAvailability(
    watchPartyHistoryCandidateChannels,
  );
  // The hook deliberately filters fresh every render (see its own comment) —
  // correct for it, but a brand-new array on every render regardless of
  // content is exactly what defeats a memoized child's prop comparison.
  // Stabilized here, one layer up, by content rather than reference: this
  // list changes rarely (a broadcast confirming, a channel losing access),
  // so almost every render can hand the sidebar back the SAME array.
  const watchPartyHistoryChannelsKeyRef = useRef("");
  const watchPartyHistoryChannelsRef = useRef<
    readonly WatchPartyHistoryChannel[]
  >(watchPartyHistoryChannelsRaw);
  // JSON.stringify of the tuple list, not a joined string: `channel.name` is
  // user-controlled text and can itself contain the separator, so two
  // different channel lists could otherwise stringify to the same key (the
  // same class of bug Farol found in the typing-users cache — see
  // use-chat.ts).
  const watchPartyHistoryChannelsKey = JSON.stringify(
    watchPartyHistoryChannelsRaw.map((channel) => [channel.id, channel.name]),
  );
  if (watchPartyHistoryChannelsKey !== watchPartyHistoryChannelsKeyRef.current) {
    watchPartyHistoryChannelsKeyRef.current = watchPartyHistoryChannelsKey;
    watchPartyHistoryChannelsRef.current = watchPartyHistoryChannelsRaw;
  }
  const watchPartyHistoryChannels = watchPartyHistoryChannelsRef.current;
  /** Which server owns the active call — `channels` only holds the selected one. */
  const voiceServerIdRef = useRef<string | null>(null);
  // Windows desktop share sound: look up the call's per-server flag (and the
  // shell's self-test, when the flag is on) as soon as they are in the call,
  // so "share screen" never waits on the API. The ref is set before the join
  // resolves, and a DM call leaves it null (the global answer). A no-op in a
  // browser, which never has the shell's bridge.
  // Keyed on the seat's channel, not on having one: moving straight from a
  // call in one server to a call in another keeps a seat the whole way and
  // changes the server whose flag the next share reads.
  const voiceSeatChannelId = voiceState.voiceChannelId ?? null;
  useEffect(() => {
    if (voiceSeatChannelId) {
      prefetchNativeShareAudio(voiceServerIdRef.current);
      prefetchShareGuardFlag(voiceServerIdRef.current);
    }
  }, [voiceSeatChannelId]);
  /**
   * A conversation whose call was started "with video": the camera should come
   * on as soon as that join is connected. A ref plus an effect rather than an
   * option on `use-voice`'s join, so the controller keeps a single camera
   * on-switch (`toggleCamera`) and nothing else can ever open the lens.
   */
  const pendingVideoCallRef = useRef<string | null>(null);
  useEffect(() => {
    const pending = pendingVideoCallRef.current;
    if (!pending) {
      return;
    }
    if (voiceState.status === "idle") {
      // The join failed or was abandoned — a camera nobody asked to keep must
      // not survive to the next call.
      pendingVideoCallRef.current = null;
      return;
    }
    if (voiceState.status !== "connected") {
      return;
    }
    pendingVideoCallRef.current = null;
    if (voiceState.voiceChannelId === pending && !voiceState.isCameraOn) {
      void voice.toggleCamera();
    }
  }, [
    voiceState.status,
    voiceState.voiceChannelId,
    voiceState.isCameraOn,
    voice,
  ]);

  /**
   * Carry a saved video quality into the controller.
   *
   * `handleAudioSettingsLive` covers every *change*, but a choice made in a
   * previous session lives only in `localStorage` until something hands it
   * over, and the controller starts on auto. Cheap and idempotent: the setter
   * returns immediately when the value is already the current one.
   */
  useEffect(() => {
    void voice.setVideoQuality(localSettings.videoQuality);
  }, [localSettings.videoQuality, voice]);

  useEffect(() => {
    void voice.setCameraDevice(localSettings.cameraDeviceId);
  }, [localSettings.cameraDeviceId, voice]);

  /**
   * `chat.onChange` / `threadChat.onChange` call this on EVERY frame either
   * controller applies — a message, a reaction, an edit, a typing broadcast —
   * and it used to bump `tick` unconditionally, which re-renders this whole
   * component. A busy watch party fires `typing-broadcast` and
   * `message-broadcast` several times a second, and profiling one (the same
   * harness as the presence-nudge fix above) found this was the single
   * biggest remaining source of full-app re-renders: worse than presence,
   * because nothing downstream of it was throttled at all. Coalesced the
   * same way — leading edge fires immediately, so a deliberate one-off call
   * (selecting a channel, sending your own message) still reads as instant;
   * a burst inside `REFRESH_COALESCE_MS` collapses to one trailing render
   * instead of one per frame.
   *
   * 30ms, not the 250ms `bumpMemberRosterNudge` uses: this path also carries
   * the swap of YOUR OWN message from its optimistic `pending:<nonce>` row to
   * the server-confirmed one (`use-chat.ts`'s message-broadcast handler),
   * which changes that row's React key and forces a real remount — losing
   * any transient DOM state tied to the old node, an open context menu among
   * it. A 100ms window widened the gap between "server confirmed" and "the
   * DOM actually reflects it" enough to land inside a keyboard/mouse
   * interaction with that same row on a loaded CI runner (`element was
   * detached from the DOM, retrying` on `message-keyboard-accessibility` /
   * `message-quick-reactions`). 30ms still collapses a genuine same-tick
   * burst (several WS frames arriving together) without meaningfully
   * widening that pre-existing race.
   */
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshPendingRef = useRef(false);
  const REFRESH_COALESCE_MS = 30;
  const refresh = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      refreshPendingRef.current = true;
      return;
    }
    setTick((t) => t + 1);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      if (refreshPendingRef.current) {
        refreshPendingRef.current = false;
        setTick((t) => t + 1);
      }
    }, REFRESH_COALESCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    },
    [],
  );

  /**
   * `ChannelList` (the whole left sidebar: channels, voice occupancy, watch
   * party affordances) is wrapped in `memo()`, but nearly every one of these
   * was an inline arrow rebuilt on every render of `MainAppContent` — or a
   * plain `function handleX()` that was never itself a `useCallback` — so
   * the memo comparison failed on essentially every prop, every render,
   * which is the same "memoized child, unmemoized props" shape the message
   * list had (see message-list.tsx). `useStableCallback` gives each one a
   * permanent identity without re-auditing every handler's own dependency
   * list; see that hook's own comment for why that trade is safe here.
   *
   * Deliberately placed here, ahead of the `bootstrapError` /
   * `ageGate` / `!bootstrapReady` / `needsOnboarding` early returns further
   * down: a hook has to run on every render regardless of what this
   * component goes on to display, and closures over names declared later in
   * this function body (`handleThreadMembership`, `toggleChannelSidebar`,
   * etc.) are still safe here — they resolve those bindings when the
   * returned callback is actually CALLED, by which point the whole
   * function body has long since finished running, not when this line
   * itself executes.
   */
  const stableOnOpenThread = useStableCallback((thread: ThreadSummary) =>
    void openThreadFromSidebar(thread),
  );
  const stableOnLeaveThread = useStableCallback((thread: ThreadSummary) =>
    void handleThreadMembership(thread, false),
  );
  const stableOnMarkThreadRead = useStableCallback((thread: ThreadSummary) =>
    void clearUnread(thread.channelId),
  );
  const stableOnMobileClose = useStableCallback(() => setMobileNavOpen(false));
  const stableOnSelectChannel = useStableCallback((id: string) =>
    void selectChannel(id),
  );
  const stableOnJoinVoice = useStableCallback((channelId: string) =>
    handleJoinVoiceFromList(channelId),
  );
  const stableOnWatchLiveParty = useStableCallback((channelId: string) =>
    void handleWatchLiveParty(channelId),
  );
  const stableOnCreateWatchParty = useStableCallback(() =>
    setCreateWatchPartyOpen(true),
  );
  const stableOnOpenWatchPartyHistory = useStableCallback(
    (channelId: string) => setWatchPartyHistoryChannelId(channelId),
  );
  const stableCanMoveIn = useStableCallback((channelId: string) =>
    perms.can(moveMembersBit(), channelId),
  );
  const stableCanConnectIn = useStableCallback((channelId: string) =>
    perms.can(Permission.CONNECT, channelId),
  );
  const stableCanMuteIn = useStableCallback((channelId: string) =>
    perms.can(Permission.MUTE_MEMBERS, channelId),
  );
  const stableCanKickUser = useStableCallback((userId: string) =>
    canKickOccupant(userId),
  );
  const stableOnMoveVoiceOccupant = useStableCallback(
    (userId: string, channelId: string) =>
      void handleMoveVoiceOccupant(userId, channelId),
  );
  const stableOnDisconnectVoiceOccupant = useStableCallback((userId: string) =>
    void handleDisconnectVoiceOccupant(userId),
  );
  const stableOnServerMuteOccupant = useStableCallback(
    (userId: string, muted: boolean) =>
      void handleServerMuteOccupant(userId, muted),
  );
  const stableOnLowerOccupantHand = useStableCallback((userId: string) =>
    void handleLowerOccupantHand(userId),
  );
  const stableOnAudienceSpeaker = useStableCallback(
    (userId: string, allowed: boolean) => void handleAudienceSpeaker(userId, allowed),
  );
  const stableOnKickOccupant = useStableCallback(
    (userId: string, name: string) => void handleKickOccupant(userId, name),
  );
  const stableOnSetPeerVolume = useStableCallback(
    (userId: string, volume: number) => voice.setPeerVolume(userId, volume),
  );
  const stableOnSetScreenVolume = useStableCallback(
    (userId: string, volume: number) => voice.setScreenVolume(userId, volume),
  );
  const stableOnCreateChannel = useStableCallback(
    (type: ChannelType, isPrivate: boolean) =>
      setChannelPrompt({ mode: "create", type, isPrivate }),
  );
  const stableOnRenameChannel = useStableCallback((channel: Channel) =>
    setChannelPrompt({ mode: "rename", channel }),
  );
  const stableOnOpenChannelSettings = useStableCallback(
    (
      channel: Channel,
      section: ChannelSettingsSectionId,
      options?: { forceAdvanced?: boolean },
    ) =>
      setChannelSettings({
        channelId: channel.id,
        section,
        forceAdvanced: options?.forceAdvanced ?? false,
      }),
  );
  const stableOnDeleteChannel = useStableCallback((id: string) =>
    void handleDeleteChannel(id),
  );
  const stableOnPurgeChannel = useStableCallback(
    (channel: Pick<Channel, "id" | "name">) =>
      setPurgeChannel({ id: channel.id, name: channel.name }),
  );
  const stableOnMoveChannel = useStableCallback(
    (id: string, parentId: string | null, index: number) =>
      void handleMoveChannel(id, parentId, index),
  );
  const stableOnFavoriteChannelIdsChange = useStableCallback(
    (ids: string[]) => handleFavoriteChannelIdsChange(ids),
  );
  const stableOnInvite = useStableCallback(() => setInviteMode("create"));
  const stableOnOpenMembers = useStableCallback(() => setMembersOpen(true));
  const stableOnOpenServerSettings = useStableCallback(() =>
    setServerSettingsOpen(true),
  );
  const stableOnExpand = useStableCallback(() => toggleChannelSidebar());
  const stableOnSelectCommunityHome = useStableCallback(() => {
    if (selectedServerId) {
      setWhatsNewOpen(false);
      markCommunityHomeRowSeen(selectedServerId);
      setCommunityHomeRowNew(false);
      void selectChannel(COMMUNITY_HOME_CHANNEL_ID, selectedServerId);
    }
  });
  // `favoriteChannelIds` is memoized by hand rather than with `useMemo`: it
  // depends on `selectedServer`, declared further down this function (after
  // the `bootstrapError` / `ageGate` / `!bootstrapReady` / `needsOnboarding`
  // early returns), so a `useMemo` call here would read it before its
  // declaration. Declaring the REF here (which needs no dependency, so no
  // ordering problem) and doing the actual comparison down where that value
  // exists keeps this hook call unconditional while the memoization itself
  // still runs after everything it needs is in scope. Its key is the joined
  // list of ids themselves, which is exactly what the output is derived
  // from, so there is nothing it can miss.
  //
  // `channelListFooter` (`sidebarFooter()`'s output) was given the same
  // treatment once and it was wrong: that function also reads `voiceState`,
  // `musicInComposer`, `liveAttachedHint` and more, none of which were in
  // its cache key (`sidebarIconsOnly` alone), so the voice status bar, the
  // music mini player and the download hint banner all went stale the
  // moment any of THAT changed without `sidebarIconsOnly` also changing —
  // a call ending, a track changing, a hint appearing, none of it repainted
  // this footer. It showed up as a layout shift landing mid-interaction
  // elsewhere on the page (a stale "Get the app" banner appearing or
  // disappearing under a click it had no business being under), which is
  // what `e2e/user-status-menu.spec.ts` caught. `sidebarFooter()`'s two
  // other call sites were never touched and call it fresh every render —
  // this one now matches them instead of trying to cache a value with this
  // many true inputs by a key that named only one of them.
  const favoriteChannelIdsKeyRef = useRef("");
  const favoriteChannelIdsRef = useRef<string[]>(EMPTY_FAVORITE_CHANNEL_IDS);

  /**
   * `MemberSidebar` (the right-hand roster) is also wrapped in `memo()`, and
   * had the exact same shape of problem: every callback prop was an inline
   * arrow rebuilt on every render of this component, which — with a
   * hundred-member server — meant re-rendering the whole roster on every
   * unrelated tick. Same fix, same reasoning about closures resolving their
   * captured bindings at call time as the `ChannelList` block above.
   */
  const stableOnMemberNickname = useStableCallback(
    (userId: string, nickname: string | null) => {
      setServerMembers((prev) =>
        prev.map((row) => (row.id === userId ? { ...row, nickname } : row)),
      );
    },
  );
  const stableOnMention = useStableCallback((username: string) =>
    setComposerInsert(`@${username}`),
  );
  const stableOnBlockUser = useStableCallback((userId: string) =>
    void handleBlockUser(userId),
  );
  const stableOnUnblockUser = useStableCallback((userId: string) =>
    void handleUnblockUser(userId),
  );
  const stableOnReportUser = useStableCallback((member: ServerMember) =>
    setReportTarget({
      kind: "user",
      userId: member.id,
      subjectName: member.displayName,
      serverId: selectedServerId,
    }),
  );
  const stableOnOpenMembersPanel = useStableCallback(() =>
    setMembersOpen(true),
  );
  // A real `useMemo`, not the hand-rolled ref pattern above: `channels` is
  // declared well before this point (line ~1153), so there is no ordering
  // problem to work around.
  const memberSidebarVoiceChannels = useMemo(
    () =>
      channels
        .filter((c) => isVoiceRoomChannelType(c.type))
        .map((c) => ({ id: c.id, name: c.name })),
    [channels],
  );

  // Stable: the message list schedules the jump in a frame, and a fresh
  // identity every render would cancel and re-schedule it forever.
  const clearHighlight = useCallback(() => setHighlightMessageId(null), []);
  // Stable identities: the message list drives a permalink jump from an effect,
  // and a fresh callback every render would re-fire it.
  const jumpToMessage = useCallback(
    (messageId: string) => chat.jumpTo(messageId),
    [chat],
  );
  const jumpToPresent = useCallback(() => chat.resetToTail(), [chat]);
  const loadNewerHistory = useCallback(() => chat.loadNewer(), [chat]);

  // Every request pulls a fresh token from Clerk. Holding one in state meant
  // that after the ~1 minute token lifetime every action failed with 401.
  useEffect(() => {
    setAuthTokenProvider(resolveToken);
  }, [resolveToken]);

  // `null` until the config probe answers; unknown is not the same as off.
  // DECLARED AFTER the token provider effect above on purpose: effects run in
  // declaration order, and the probe's request goes out from its effect, so
  // above that line it left with no Authorization header, answered 401, and
  // put a console error on every boot (`theme-tokens.spec.ts` counts them).
  const isAttachmentsEnabled = useAttachmentsEnabled();

  useEffect(() => {
    setLocalSettings(loadLocalSettings());
  }, []);

  useEffect(() => {
    setSoundOutput({
      deviceId: localSettings.outputDeviceId,
      volume: localSettings.outputVolume,
    });
  }, [localSettings.outputDeviceId, localSettings.outputVolume]);

  useEffect(() => {
    setPttBeepEnabled(localSettings.pttBeep);
  }, [localSettings.pttBeep]);


  useEffect(() => {
    chat.onChange(refresh);
    threadChat.onChange(refresh);
    voice.onStateChange(setVoiceState);
    return () => {
      chat.dispose();
      threadChat.dispose();
    };
  }, [chat, threadChat, voice, refresh]);

  // A notification frame carries ids only, and it can name any server the user
  // belongs to rather than just the open one, so the whole list is remembered.
  useEffect(() => {
    rememberServers(servers);
  }, [servers]);

  const inPushToTalk =
    localSettings.inputMode === "push-to-talk" &&
    voiceState.status === "connected";

  const handlePushToTalk = useCallback(
    (held: boolean) => {
      // The hold-to-talk button never goes through the key hook. Same
      // transition helper, so a press from either side beeps once.
      applyPttHeldChange(held, (next) => voice.setPushToTalkActive(next));
    },
    [voice],
  );

  useEffect(() => {
    if (inPushToTalk) {
      return;
    }
    // Close the hold-to-talk button path without playing: the hook's
    // teardown already released a held key and reset the latch after that.
    voice.setPushToTalkActive(false);
    resetPttHeld();
  }, [inPushToTalk, voice]);

  // The key binding lives here rather than in the panel because the panel is
  // unmounted the moment you navigate to a text channel, and push-to-talk has
  // to keep working while you read the chat.
  const { windowFocused } = usePushToTalk({
    enabled: inPushToTalk,
    binding: localSettings.pushToTalkKey,
    releaseDelayMs: localSettings.pttReleaseDelayMs,
    global: localSettings.pttGlobal,
    onHeldChange: handlePushToTalk,
  });

  // Electron app menu: mute (and deafen on shells that ship the item).
  // The renderer table owns the same chords on the web; on desktop the
  // default mute/deafen chords stay with the menu so they do not toggle twice.
  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) {
      return;
    }
    const offMute = desktop.onToggleMute(() => {
      if (voice.getState().status === "connected") {
        voice.toggleMute();
      }
    });
    const offDeafen = desktop.onToggleDeafen?.(() => {
      if (voice.getState().status === "connected") {
        voice.toggleDeafen();
      }
    });
    return () => {
      offMute();
      offDeafen?.();
    };
  }, [voice]);

  // Electron: the tray menu. Commands come in, the state they act on goes out.
  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop?.onVoiceCommand) {
      return;
    }
    return desktop.onVoiceCommand((command) => {
      if (voice.getState().status !== "connected") {
        return;
      }
      if (command === "toggleMute") {
        voice.toggleMute();
      } else if (command === "toggleDeafen") {
        voice.toggleDeafen();
      } else if (command === "leave") {
        voice.leave();
      }
    });
  }, [voice]);

  const inCall = voiceState.status === "connected";
  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop?.setVoiceState) {
      return;
    }
    desktop.setVoiceState({
      inCall,
      muted: inCall && voiceState.isMuted,
      deafened: inCall && voiceState.isDeafened,
    });
  }, [inCall, voiceState.isMuted, voiceState.isDeafened]);

  const [shortcutOverlayOpen, setShortcutOverlayOpen] = useState(false);

  const clearUnread = useCallback(async (channelId: string): Promise<string | null> => {
    unreadHoldRef.current.delete(channelId);
    setUnreadHeldIds(new Set(unreadHoldRef.current));
    setUnread((prev) => {
      if (!prev[channelId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[channelId];
      return next;
    });
    try {
      // Queued behind any ack from the last visit, so that ack cannot land
      // after this and make its cursor the "previous" one we get back.
      const result = await readCursorQueue.run(channelId, () =>
        markChannelRead(channelId),
      );
      return result.previousLastReadAt ?? null;
    } catch {
      // A missed read receipt only means a stale badge; not worth surfacing.
      return null;
    }
  }, [readCursorQueue]);

  const loadUnread = useCallback(async (serverId: string) => {
    try {
      const { unread: rows } = await fetchUnread(serverId);
      setUnread((prev) => {
        const next = { ...prev };
        for (const row of rows) {
          const isOpen = row.channelId === selectedChannelIdRef.current;
          const held = unreadHoldRef.current.has(row.channelId);
          if (row.count > 0 && (!isOpen || held)) {
            next[row.channelId] = {
              count: row.count,
              mentions: row.mentions,
            };
          } else if (!held) {
            delete next[row.channelId];
          }
        }
        return next;
      });
    } catch {
      // Badges are cosmetic — never block the app on them.
    }
  }, []);

  /**
   * Pull the conversation list and fold its unread counts into the shared map.
   *
   * Tolerant of failure on purpose: this is the first feature to depend on
   * endpoints a deployed older API does not have, and an instance without them
   * should show no conversations rather than refuse to start.
   */
  const loadConversations = useCallback(
    async (
      { trustSnapshot = false }: { trustSnapshot?: boolean } = {},
    ): Promise<DmSummary[]> => {
      // Only a first load draws the skeleton. This also runs when somebody opens
      // a conversation with this account mid-session, and blanking the list the
      // reader is looking at to redraw the same rows is a flash for nothing.
      setConversationsLoading(conversationsRef.current.length === 0);
      try {
        const { conversations: list } = await fetchConversations();
        const sorted = sortConversations(list);
        setConversations(sorted);
        conversationsRef.current = sorted;
        setUnread((prev) => {
          const openId = selectedChannelIdRef.current;
          const seeded = unreadFromConversations(
            sorted,
            openId && unreadHoldRef.current.has(openId) ? null : openId,
          );
          if (!trustSnapshot) {
            // The live map is spread last so it wins: it has counted
            // everything that arrived since this snapshot was taken.
            return { ...seeded, ...prev };
          }
          // Blocking changes retroactively what counts as unread, so the local
          // counter is now wrong by however much that person had said and only
          // the server knows the new number.
          const next = { ...prev };
          for (const conversation of sorted) {
            delete next[conversation.channelId];
          }
          return { ...next, ...seeded };
        });
        return sorted;
      } catch {
        return conversationsRef.current;
      } finally {
        setConversationsLoading(false);
      }
    },
    [],
  );

  const loadBlocks = useCallback(async () => {
    try {
      const { blocked } = await fetchBlocks();
      setBlockedUsers(blocked);
    } catch {
      // An unavailable block list must not stop the app loading. It fails
      // closed in the only direction that matters: the server enforces every
      // block regardless of what this list says.
    }
  }, []);

  const loadConversationsRef = useRef(loadConversations);
  loadConversationsRef.current = loadConversations;

  /**
   * The people the open channel can name. A conversation is closed: everyone
   * who could be mentioned in one is already in it, so there is nobody to fetch
   * — and completing `@` against a server's roster inside a private
   * conversation would offer to ping people who cannot read it.
   */
  const conversationParticipants = useMemo(
    () =>
      selectedChannelId
        ? (conversations.find((one) => one.channelId === selectedChannelId)
            ?.participants ?? null)
        : null,
    [conversations, selectedChannelId],
  );

  // The composer completes `@` against this server's members, which is also the
  // only place a handle can be learned from without asking for it.
  useEffect(() => {
    if (conversationParticipants) {
      setMentionableRoles([]);
      setServerMembers([]);
      setServerRoles([]);
      return;
    }
    if (!selectedServerId) {
      setMentionableRoles([]);
      setServerMembers([]);
      setServerRoles([]);
      return;
    }
    setServerMembers([]);
    let cancelled = false;
    void Promise.all([
      fetchMembers(selectedServerId),
      fetchRoles(selectedServerId).catch(() => ({ roles: [] as ServerRole[] })),
    ])
      .then(([{ members }, { roles }]) => {
        if (!cancelled) {
          setServerMembers(members);
          setServerRoles(roles);
          setMemberRoles(
            new Map(members.map((member) => [member.id, member.role])),
          );
          setMentionableRoles(
            roles.map((role) => ({
              id: role.id,
              name: role.name,
              mentionable: role.mentionable,
              isEveryone: role.isEveryone,
            })),
          );
        }
      })
      .catch(() => {
        // Autocomplete degrades to typing the handle out; not worth an error.
      });
    return () => {
      cancelled = true;
    };
  }, [conversationParticipants, selectedServerId]);

  const applyRosterPayload = useCallback((incoming: ServerMember[]) => {
    setServerMembers((prev) => mergeMemberStatuses(prev, incoming));
  }, []);
  useMemberRosterRefresh(
    conversationParticipants ? null : selectedServerId,
    memberRosterNudge,
    applyRosterPayload,
    serverMembers.length,
  );

  /**
   * Read straight off the live roster rather than a copy of the first fetch.
   * A copy is what the member panel outgrew: somebody who joined after the page
   * loaded showed up there within seconds and could still not be completed
   * after `@` until a reload.
   */
  const mentionCandidates = useMemo((): MentionCandidate[] => {
    if (conversationParticipants) {
      return conversationParticipants;
    }
    const extra: MentionCandidate[] = [];
    const canMass = perms.can(Permission.MENTION_EVERYONE);
    if (canMass) {
      extra.push({
        id: "mention:everyone",
        username: "everyone",
        displayName: t("composer.mentionEveryone"),
        avatarUrl: null,
        mentionKind: "mass",
      });
      extra.push({
        id: "mention:here",
        username: "here",
        displayName: t("composer.mentionHere"),
        avatarUrl: null,
        mentionKind: "mass",
      });
    }
    for (const role of mentionableRoles) {
      if (role.isEveryone) {
        continue;
      }
      if (role.mentionable || canMass) {
        extra.push({
          id: `role:${role.id}`,
          username: role.name,
          displayName: role.name,
          avatarUrl: null,
          mentionKind: "role",
        });
      }
    }
    return [
      ...serverMembers.map((member) => ({
        ...member,
        mentionKind: "member" as const,
      })),
      ...extra,
    ];
  }, [
    conversationParticipants,
    serverMembers,
    mentionableRoles,
    perms,
    t,
  ]);

  const messageAuthors = useMemo(() => {
    const map = new Map<string, MessageAuthorInfo>();
    for (const member of serverMembers) {
      map.set(member.id, {
        rank: member.role,
        roleIds: member.roleIds,
        status: member.status ?? null,
        username: member.username ?? usernameFromTag(member.tag),
        isCharacter: member.isCharacter,
        handle: member.handle ?? null,
        customStatus: member.customStatus ?? null,
      });
    }
    for (const person of conversationParticipants ?? []) {
      if (map.has(person.id)) {
        continue;
      }
      map.set(person.id, {
        username: person.username,
        customStatus: person.customStatus ?? null,
      });
    }
    return map;
  }, [conversationParticipants, serverMembers]);

  const forwardTargets = useMemo((): ForwardTarget[] => {
    const currentId = selectedChannelId;
    const targets: ForwardTarget[] = [];
    for (const channel of channels) {
      if (channel.type === "text" && channel.id !== currentId) {
        targets.push({
          id: channel.id,
          label: channel.name,
          kind: "channel",
        });
      }
    }
    for (const conversation of conversations) {
      if (conversation.channelId !== currentId) {
        targets.push({
          id: conversation.channelId,
          label: conversationTitle(conversation.participants),
          kind: "conversation",
        });
      }
    }
    return targets;
  }, [channels, conversations, selectedChannelId]);

  /**
   * The selected server, but only when this account can manage it — the one
   * question every moderator affordance below starts from, resolved once so a
   * component cannot answer it differently.
   */
  const manageableServer = useMemo(() => {
    const server = servers.find((one) => one.id === selectedServerId);
    return server ? { id: server.id, role: server.role } : null;
  }, [servers, selectedServerId]);

  const moderationBits = useMemo(
    () => ({
      kick: perms.can(Permission.KICK_MEMBERS),
      ban: perms.can(Permission.BAN_MEMBERS),
      timeout: perms.can(Permission.MODERATE_MEMBERS),
      mute: perms.canAny(Permission.MUTE_MEMBERS),
      move: perms.canAny(Permission.MOVE_MEMBERS),
      nicknames: perms.can(Permission.MANAGE_NICKNAMES),
      manageRoles: perms.can(Permission.MANAGE_ROLES),
      canMuteIn: (channelId: string) =>
        perms.can(Permission.MUTE_MEMBERS, channelId),
      canMoveIn: (channelId: string) =>
        perms.can(Permission.MOVE_MEMBERS, channelId),
    }),
    [perms],
  );
  const canStaff =
    moderationBits.kick ||
    moderationBits.ban ||
    moderationBits.timeout ||
    moderationBits.mute ||
    moderationBits.move ||
    moderationBits.nicknames ||
    moderationBits.manageRoles;

  /**
   * Who the host may hand a co-host badge to.
   *
   * The server's own member list, which this component already holds for the
   * composer's `@` completion, so appointing a co-host costs no extra request.
   * `memberDisplayName` rather than the raw display name, because a nickname is
   * what the rest of this server calls that person and a picker that disagreed
   * with the member list would be a second name for the same face.
   */
  const cohostCandidates = useMemo(() => {
    // STAFF FIRST, THEN FRIENDS, THEN EVERYBODY (2026-09-13, Rafael). The
    // same ladder the member sidebar hoists by: cargos with `hoist`, highest
    // position first, a person landing on the first one they hold. Friends
    // take the tier after the last cargo. The rest carry no priority and
    // sort by name inside `WatchPartyCohosts`.
    const hoisted = [...serverRoles]
      .filter((role) => role.hoist && !role.isEveryone)
      .sort((a, b) => b.position - a.position);
    const adminRoleId =
      serverRoles.find((role) => role.systemKey === "admin")?.id ?? null;
    const ownerRoleId =
      serverRoles.find((role) => role.systemKey === "owner")?.id ?? null;
    const friendTier = hoisted.length;
    return serverMembers.map((member) => {
      const held = new Set(effectiveRoleIds(member, adminRoleId, ownerRoleId));
      const cargo = hoisted.findIndex((role) => held.has(role.id));
      const priority =
        member.role === "owner"
          ? 0
          : cargo >= 0
            ? cargo
            : memberSidebarFriendIds.has(member.id)
              ? friendTier
              : undefined;
      return {
        userId: member.id,
        displayName: memberDisplayName(member),
        avatarUrl: member.avatarUrl,
        isCharacter: member.isCharacter,
        priority,
      };
    });
  }, [serverMembers, serverRoles, memberSidebarFriendIds]);

  /**
   * What the profile card may do to somebody, in the server it was opened in.
   *
   * Null in a conversation — a DM has no moderators — and null when this
   * account holds none of the staff bits, which is why the bits are checked
   * here rather than inside the card.
   */
  // The party on the open channel, for the member card's co-host rung. The
  // card itself decides whether the viewer may promote this person.
  // The stream chat's badges, memoised on the party's host and co-hosts:
  // a fresh object here reaches every memo'd message row and re-renders the
  // whole list on every voice frame.
  const selectedParty = selectedChannelId
    ? (watchParties.byChannel[selectedChannelId] ?? null)
    : null;
  const selectedPartyHostId = selectedParty?.hostUserId ?? null;
  const selectedPartyCohostKey =
    selectedParty?.cohosts.map((cohost) => cohost.userId).join(",") ?? "";
  const streamBadges = useMemo(
    () =>
      selectedPartyHostId
        ? {
            hostUserId: selectedPartyHostId,
            cohostIds: new Set(
              selectedPartyCohostKey ? selectedPartyCohostKey.split(",") : [],
            ),
          }
        : null,
    [selectedPartyHostId, selectedPartyCohostKey],
  );
  const cardWatchParty = useMemo<ProfileWatchPartyContext | null>(() => {
    const party = selectedChannelId
      ? (watchParties.byChannel[selectedChannelId] ?? null)
      : null;
    if (!party) {
      return null;
    }
    return {
      party,
      onPromote: (userId) => handleWatchPartyCohost(userId, true),
      onDemote: (userId) => handleWatchPartyCohost(userId, false),
    };
    // `handleWatchPartyCohost` is a function declaration on this component
    // and reads its party at call time; listing it would rebuild on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannelId, watchParties.byChannel]);
  const cardModeration = useMemo<ProfileModerationContext | null>(
    () =>
      canStaff && manageableServer && selection.kind === "server"
        ? {
            serverId: manageableServer.id,
            actorRole: manageableServer.role ?? "member",
            actorRoleIds: serverMembers.find((row) => row.id === user?.id)
              ?.roleIds,
            memberRoles,
            memberRoleIds: new Map(
              serverMembers.map((row) => [row.id, row.roleIds ?? []]),
            ),
            roles: serverRoles,
            bits: moderationBits,
            timedOutUserIds,
            onModerated: () => setTimeoutsEpoch((n) => n + 1),
            onRolesChanged: () => {
              if (!selectedServerId) {
                return;
              }
              void fetchMembers(selectedServerId).then(({ members }) => {
                setServerMembers(members);
                setMemberRoles(
                  new Map(members.map((member) => [member.id, member.role])),
                );
              });
            },
          }
        : null,
    [
      canStaff,
      manageableServer,
      selection.kind,
      memberRoles,
      timedOutUserIds,
      moderationBits,
      serverMembers,
      serverRoles,
      user?.id,
      selectedServerId,
    ],
  );

  /**
   * Who is timed out here — read only for a manager, because only a manager is
   * allowed to ask and only a manager has anything to draw with the answer.
   * `timeoutsEpoch` is what a card bumps after issuing or lifting one, so the
   * menu it offers next matches what it just did.
   */
  useEffect(() => {
    if (!selectedServerId || !moderationBits.timeout) {
      setTimedOutUserIds(new Set());
      return;
    }
    let cancelled = false;
    void listTimeouts(selectedServerId)
      .then(({ timeouts }) => {
        if (!cancelled) {
          setTimedOutUserIds(new Set(timeouts.map((one) => one.userId)));
        }
      })
      .catch(() => {
        // The card falls back to offering "Time out", which the server treats
        // as a replacement of any existing row — so a failed read here costs a
        // label, never a wrong action.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedServerId, timeoutsEpoch, moderationBits.timeout]);

  /**
   * Open a channel by id, whatever kind it is.
   *
   * Takes no channel object and no server: everything below this line — the
   * join frame, history, the read receipt, the composer — is channel-scoped
   * already, and a conversation is a channel. Resolving which channel exists is
   * the caller's job, and asking for one that does not simply loads nothing.
   */
  const openChannel = useCallback(
    async (channelId: string) => {
      const leaving = selectedChannelIdRef.current;
      if (leaving && leaving !== channelId) {
        liveReadAck.flush(leaving);
      }
      setSelectedChannelId(channelId);
      selectedChannelIdRef.current = channelId;
      // Not at the live end until this channel's list says so, after its
      // history has loaded.
      messageListLiveEndRef.current = null;
      // The reply belongs to the conversation you were in, not the next one.
      setReplyTarget(null);
      // --- threads --- the panel belongs to the channel it was opened from.
      closeThreadPanelRef.current();
      setUnreadSince(null);
      setEditMessageId(null);
      setHistoryFailedChannelId(null);

      // Community Home is a client-only surface, not a channel the API knows.
      if (isCommunityHomeChannelId(channelId)) {
        setMessagesLoading(false);
        return;
      }

      const held = unreadHoldRef.current.has(channelId);
      setMessagesLoading(true);
      chat.joinChannel(channelId);
      const load = historyLoads.begin(channelId);

      try {
        const [page, previousLastReadAt] = await Promise.all([
          fetchMessages(channelId),
          held
            ? Promise.resolve(
                unreadCursorByChannelRef.current[channelId] ?? null,
              )
            : clearUnread(channelId),
        ]);
        if (selectedChannelIdRef.current !== channelId) {
          return;
        }
        // An older request can land after a newer one failed: what it loaded
        // is on screen, so the error no longer applies.
        clearHistoryFailed(channelId);
        if (!load.succeeded()) {
          // Leaving and coming back, or a retry beside a reconnect: a newer
          // page is already on screen, with whatever arrived since, and this
          // one would take those messages away again.
          return;
        }
        chat.setMessages(page.messages, page.hasMore);
        setUnreadSince(
          previousLastReadAt &&
            findFirstUnreadMessageId(
              page.messages,
              previousLastReadAt,
              userIdRef.current,
            )
            ? previousLastReadAt
            : null,
        );
        refresh();
      } catch {
        // Not the app banner: the raw server string ("database_unavailable")
        // is not copy, and the list below would still say the channel is
        // empty. The list shows the failure in place, with a retry.
        if (
          selectedChannelIdRef.current === channelId &&
          load.failureStands()
        ) {
          setHistoryFailedChannelId(channelId);
        }
      } finally {
        if (selectedChannelIdRef.current === channelId) {
          setMessagesLoading(false);
        }
      }
    },
    [chat, clearHistoryFailed, clearUnread, historyLoads, liveReadAck, refresh],
  );

  /**
   * Fetch the open channel's newest page again after a failed load.
   *
   * History only, not `openChannel`: that would also close the thread panel,
   * drop the reply target and re-mark the channel read, none of which failed.
   */
  const retryChannelHistory = useCallback(async () => {
    const channelId = selectedChannelIdRef.current;
    if (!channelId) {
      return;
    }
    setHistoryFailedChannelId(null);
    setMessagesLoading(true);
    // Loading again: the list reports the live end once the page is in.
    messageListLiveEndRef.current = null;
    const load = historyLoads.begin(channelId);
    try {
      const page = await fetchMessages(channelId);
      if (selectedChannelIdRef.current !== channelId) {
        return;
      }
      clearHistoryFailed(channelId);
      if (!load.succeeded()) {
        return;
      }
      chat.setMessages(page.messages, page.hasMore);
      refresh();
    } catch {
      if (
        selectedChannelIdRef.current === channelId &&
        load.failureStands()
      ) {
        setHistoryFailedChannelId(channelId);
      }
    } finally {
      if (selectedChannelIdRef.current === channelId) {
        setMessagesLoading(false);
      }
    }
  }, [chat, clearHistoryFailed, historyLoads, refresh]);
  const handleRetryHistory = useCallback(() => {
    void retryChannelHistory();
  }, [retryChannelHistory]);

  // ---------------------------------------------------------------- threads
  //
  // Panel state. The thread's summary and (when in hand) its origin message;
  // null means no panel. Refs mirror the pieces the once-installed realtime
  // handler needs, exactly the way `selectedChannelIdRef` already works.
  const [openThread, setOpenThread] = useState<{
    thread: ThreadSummary;
    origin: ChatMessage | null;
  } | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  /**
   * --- threads --- channelId -> the active threads under it, for the rows
   * the channel list nests under a channel. Its own read: see the route's
   * note on why it is not folded into the etagged channel list.
   *
   * IT IS A SNAPSHOT, NOT A SUBSCRIPTION, and the rows for channels other
   * than the one on screen are the stale half. `thread-update` is broadcast
   * to a channel's joined sockets and this client joins one channel at a
   * time, so a reply in a thread under some other channel reaches nobody
   * here. What refreshes the whole map is a server switch, a reconnect, and
   * the coalesced reload below; what stays live frame by frame is the
   * selected channel's rows, which is where a reader is looking.
   */
  const [threadsByChannel, setThreadsByChannel] = useState<
    Record<string, ThreadSummary[]>
  >({});
  /**
   * One read per server, rather than one per path that loads channels: the
   * channel list is reached from a boot, a switch, an invite and a route
   * restore, and a thread list that only some of those filled would be the
   * kind of gap nobody notices until a server looks threadless.
   *
   * `reloadServerThreads` is also the authority the live frame falls back to
   * (see the `thread-update` handler): re-asking is the only honest way to
   * learn that a thread this reader is in has become one of a channel's most
   * recent, because the cap means the client cannot know that on its own.
   *
   * A failed read RETRIES rather than standing as an empty answer. Clearing
   * the rows and then swallowing the error reported "this server has no
   * threads", which is a different statement from "I could not find out".
   */
  const threadsRequestRef = useRef(0);
  const reloadServerThreads = useCallback(async (serverId: string) => {
    const request = ++threadsRequestRef.current;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const { threads } = await fetchServerThreads(serverId);
        if (threadsRequestRef.current === request) {
          setThreadsByChannel(threads);
        }
        return;
      } catch {
        if (threadsRequestRef.current !== request) {
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * 2 ** attempt),
        );
      }
    }
    // Out of attempts. The rows stay as they were rather than being replaced
    // by an empty list, so a transient failure never invents an answer.
  }, []);

  /**
   * Re-ask for the server's thread list, at most once every few seconds. A
   * reply in a thread that is not on screen is the only signal the client
   * gets that its capped list may be out of date, and in a busy channel that
   * signal arrives far too often to act on each time.
   */
  const threadsReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const scheduleThreadsReload = useCallback(() => {
    if (threadsReloadTimerRef.current !== null) {
      return;
    }
    threadsReloadTimerRef.current = setTimeout(() => {
      threadsReloadTimerRef.current = null;
      const serverId = selectedServerIdRef.current;
      if (serverId) {
        void reloadServerThreads(serverId);
      }
    }, 5000);
  }, [reloadServerThreads]);
  useEffect(
    () => () => {
      if (threadsReloadTimerRef.current !== null) {
        clearTimeout(threadsReloadTimerRef.current);
      }
    },
    [],
  );

  const reloadServerThreadsRef = useRef(reloadServerThreads);
  reloadServerThreadsRef.current = reloadServerThreads;

  useEffect(() => {
    if (!selectedServerId) {
      threadsRequestRef.current += 1;
      setThreadsByChannel({});
      return;
    }
    void reloadServerThreads(selectedServerId);
    return () => {
      // Supersede any retry still in flight for the server being left.
      threadsRequestRef.current += 1;
    };
  }, [selectedServerId, reloadServerThreads]);
  /** The thread this reader last replied in from the panel, until its frame. */
  const ownThreadReplyRef = useRef<string | null>(null);
  const ownReplyReloadInFlightRef = useRef(false);
  const threadsByChannelRef = useRef<Record<string, ThreadSummary[]>>({});
  threadsByChannelRef.current = threadsByChannel;
  const [stashedThread, setStashedThread] = useState<{
    thread: ThreadSummary;
    origin: ChatMessage | null;
  } | null>(null);
  const openThreadChannelIdRef = useRef<string | null>(null);
  openThreadChannelIdRef.current = openThread?.thread.channelId ?? null;
  const openThreadRef = useRef<typeof openThread>(null);
  openThreadRef.current = openThread;
  // Anything that covers the chat pane while it stays mounted: What's New,
  // the Communities directory (an opaque full-screen overlay), and the thread
  // panel where it sits on top of the transcript instead of beside it.
  const transcriptObscured =
    whatsNewOpen ||
    (directoryOpen && communitiesEnabled) ||
    (openThread !== null && !columnLayout);
  transcriptObscuredRef.current = transcriptObscured;
  useEffect(() => {
    if (!transcriptObscured) {
      // Uncovered: what arrived meanwhile is on screen now.
      liveReadAck.resume();
    }
  }, [transcriptObscured, liveReadAck]);
  const memberSidebarOpenRef = useRef(false);
  memberSidebarOpenRef.current = memberSidebar.open;

  const closeThreadPanel = useCallback(() => {
    // Before the early return: a stashed thread belongs to the channel it was
    // stashed from, and a channel switch calls this precisely to end that.
    // Leaving it behind let the roster offer a thread from the server you
    // just left.
    setStashedThread(null);
    if (!openThreadChannelIdRef.current) {
      return;
    }
    // The read cursor moves on close, not per message: the panel was on
    // screen, so everything it showed is read, and this is what keeps the
    // chip's unread dot honest after the next reload.
    if (!unreadHoldRef.current.has(openThreadChannelIdRef.current)) {
      void clearUnread(openThreadChannelIdRef.current);
    }
    threadChat.leaveChannel();
    setOpenThread(null);
    setThreadUnreadSince(null);
  }, [clearUnread, threadChat]);

  /**
   * The switch's "Members" half: give the column to the roster but remember
   * what was in it. Everything `closeThreadPanel` does about read cursors
   * still applies, so this goes through it rather than around it.
   */
  const stashThreadForMembers = useCallback(() => {
    const current = openThreadRef.current;
    closeThreadPanel();
    if (current) {
      setStashedThread(current);
    }
    if (!memberSidebarOpenRef.current) {
      memberSidebar.toggle();
    }
  }, [closeThreadPanel, memberSidebar]);
  // openChannel is declared above this callback and must close the panel on
  // every channel switch, so it reaches it through a ref.
  const closeThreadPanelRef = useRef<() => void>(() => {});
  closeThreadPanelRef.current = closeThreadPanel;

  const openThreadPanel = useCallback(
    async (thread: ThreadSummary, origin: ChatMessage | null) => {
      setOpenThread({ thread, origin });
      setStashedThread(null);
      setThreadLoading(true);
      setThreadUnreadSince(null);
      threadChat.joinChannel(thread.channelId);
      const held = unreadHoldRef.current.has(thread.channelId);
      try {
        const [page, previousLastReadAt] = await Promise.all([
          fetchMessages(thread.channelId),
          held
            ? Promise.resolve(
                unreadCursorByChannelRef.current[thread.channelId] ?? null,
              )
            : clearUnread(thread.channelId),
        ]);
        if (openThreadChannelIdRef.current !== thread.channelId) {
          return;
        }
        threadChat.setMessages(page.messages, page.hasMore);
        setThreadUnreadSince(
          previousLastReadAt &&
            findFirstUnreadMessageId(
              page.messages,
              previousLastReadAt,
              userIdRef.current,
            )
            ? previousLastReadAt
            : null,
        );
        refresh();
      } catch {
        // The panel opens empty; live traffic and sending still work, and
        // closing and reopening retries the history read.
      } finally {
        if (openThreadChannelIdRef.current === thread.channelId) {
          setThreadLoading(false);
        }
      }
    },
    [clearUnread, refresh, threadChat],
  );

  /**
   * Open a thread from a surface that is not the chip: a sidebar row, or the
   * right column's switch. Selects the thread's parent channel first, because
   * neither surface is necessarily showing it.
   *
   * Tokened, because each click starts its own async chain: two quick clicks
   * could resolve out of order and leave the panel on the thread that was NOT
   * chosen last. A failure is reported rather than left as an unhandled
   * rejection with the panel half-open.
   */
  const threadOpenRef = useRef(0);
  const selectChannelRef = useRef<
    (channelId: string, serverId?: string) => Promise<void>
  >(async () => {});
  /**
   * Reads the parent channel's loaded page at CALL time, not at render time:
   * the page arrives during the channel switch this callback awaits, so a
   * snapshot taken before the await is the previous channel's.
   */
  const chatMessagesRef = useRef<() => ChatMessage[]>(() => []);
  chatMessagesRef.current = () => chat.getMessages();
  const openThreadFromSidebar = useCallback(
    async (thread: ThreadSummary, knownOrigin: ChatMessage | null = null) => {
      const request = ++threadOpenRef.current;
      try {
        if (thread.parentChannelId !== selectedChannelIdRef.current) {
          // Through a ref: selectChannel is declared below this callback and
          // reaching it directly would be a use-before-declaration, the same
          // shape closeThreadPanel is already threaded for.
          await selectChannelRef.current(
            thread.parentChannelId,
            selectedServerIdRef.current ?? undefined,
          );
          if (threadOpenRef.current !== request) {
            return;
          }
        }
        // Hand the panel the real origin message when the parent channel's
        // page has it, so its quote is that message — including a poll's
        // question or an upload — rather than nothing.
        const origin =
          knownOrigin ??
          chatMessagesRef
            .current()
            .find((one) => one.id === thread.rootMessageId) ??
          null;
        if (threadOpenRef.current !== request) {
          return;
        }
        await openThreadPanel(thread, origin);
      } catch (error) {
        if (threadOpenRef.current !== request) {
          return;
        }
        setAppError(
          error instanceof Error ? error.message : "Failed to open that thread",
        );
      }
    },
    [openThreadPanel],
  );

  const handleStartThread = useCallback(
    async (message: ChatMessage) => {
      try {
        const { thread } = await createThread(message.id);
        // The chip appears on the actor's own copy immediately; everyone
        // else's arrives on the `thread-update` broadcast.
        chat.applyThreadUpdate(message.id, thread);
        // Starting a thread joins it, and nothing else would list it: no
        // frame is owed to the starter's own sidebar until somebody replies.
        const serverId = selectedServerIdRef.current;
        if (serverId) {
          void reloadServerThreads(serverId);
        }
        await openThreadPanel(thread, message);
      } catch (error) {
        setAppError(
          error instanceof Error
            ? error.message
            : translateMessage("thread.error.start"),
        );
      }
    },
    [chat, openThreadPanel, reloadServerThreads],
  );

  /**
   * Join or leave a thread: the sidebar row's X and right-click menu, and the
   * panel header's toggle. A leave drops the row at once; a join waits for
   * the server, because only the server knows whether the thread makes the
   * per-channel cap. Either way the list is re-read afterwards, which also
   * discards a reload that was already in flight with the old answer (it
   * bumps the request token) and backfills a slot the leave freed.
   */
  const membershipQueueRef = useRef(new Map<string, Promise<void>>());
  const handleThreadMembership = useCallback(
    async (thread: ThreadSummary, joined: boolean) => {
      // A read already in flight carries the answer from before this change.
      threadsRequestRef.current += 1;
      if (!joined) {
        setThreadsByChannel((prev) => {
          const current = prev[thread.parentChannelId];
          if (!current) {
            return prev;
          }
          return {
            ...prev,
            [thread.parentChannelId]: current.filter(
              (one) => one.channelId !== thread.channelId,
            ),
          };
        });
      }
      // One thread's changes go out one at a time, in the order they were
      // asked for. Sent concurrently, a Leave then Join could reach the
      // server as Join then Leave, and the last write wins there.
      const previous =
        membershipQueueRef.current.get(thread.channelId) ?? Promise.resolve();
      const request = previous.then(() =>
        setThreadMembership(thread.channelId, joined),
      );
      const settled = request.then(
        () => undefined,
        () => undefined,
      );
      membershipQueueRef.current.set(thread.channelId, settled);
      void settled.then(() => {
        if (membershipQueueRef.current.get(thread.channelId) === settled) {
          membershipQueueRef.current.delete(thread.channelId);
        }
      });
      try {
        await request;
      } catch (error) {
        setAppError(
          error instanceof Error
            ? error.message
            : translateMessage("thread.error.membership"),
        );
      }
      const serverId = selectedServerIdRef.current;
      if (serverId) {
        void reloadServerThreads(serverId);
      }
    },
    [reloadServerThreads],
  );

  const handleMarkUnread = useCallback(
    (message: ChatMessage) => {
      const created = Date.parse(message.createdAt);
      if (!Number.isFinite(created)) {
        return;
      }
      const channelId = message.channelId;
      const lastReadAt = new Date(created - 1).toISOString();
      unreadHoldRef.current.add(channelId);
      unreadCursorByChannelRef.current[channelId] = lastReadAt;
      setUnreadHeldIds(new Set(unreadHoldRef.current));
      setUnread((prev) => ({
        ...prev,
        [channelId]: {
          count: Math.max(1, prev[channelId]?.count ?? 1),
          mentions: prev[channelId]?.mentions ?? 0,
        },
      }));
      if (selectedChannelIdRef.current === channelId) {
        setUnreadSince(lastReadAt);
      }
      if (openThreadChannelIdRef.current === channelId) {
        setThreadUnreadSince(lastReadAt);
      }
      // Queued, so a live ack already on the wire lands before the rewind.
      void readCursorQueue
        .run(channelId, () => markChannelRead(channelId, lastReadAt))
        .then(() => {
          if (selectedServerId) {
            void loadUnread(selectedServerId);
          }
        })
        .catch(() => {
          // Badge is best-effort.
        });
    },
    [loadUnread, readCursorQueue, selectedServerId],
  );

  const handleMarkRead = useCallback(() => {
    const channelId = selectedChannelIdRef.current;
    if (channelId) {
      clearUnread(channelId);
    }
  }, [clearUnread]);

  // The thread controller renders optimistic bubbles for the same account.
  useEffect(() => {
    threadChat.setCurrentUser(user);
  }, [threadChat, user]);

  useEffect(() => {
    let cancelled = false;
    // Spreads the cold bootstrap: a synchronized wave of tabs (a watch-party
    // F5 spike) must not fire its ~11 requests at the same instant, and a
    // transient failure (the DB breaker's 503) must not have every tab retry
    // in lockstep either. Both timers live here so the cleanup can clear them.
    let bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
    let autoRetryCount = 0;
    // How many times a transient bootstrap failure self-retries before giving
    // up and showing the manual error screen. The two failure shapes are not
    // the same problem and do not get the same budget (per Farol review): a
    // 503 `database_unavailable` means the breaker is open and WILL
    // recover, so it is worth riding out — at the 1s-base, 30s-cap backoff,
    // 8 retries spans a couple of minutes, long enough for a recovery cycle.
    // Status 0 (network error / timeout) has no such guarantee — it is just
    // as likely a genuinely unreachable API or a dead connection, and paying
    // the full 503 budget there left a truly offline user staring at the
    // loading shell for 3-4 minutes before any error appeared. It gets a
    // much shorter leash so that case surfaces quickly instead.
    const MAX_BOOTSTRAP_AUTO_RETRIES_OVERLOAD = 8;
    const MAX_BOOTSTRAP_AUTO_RETRIES_NETWORK = 3;
    // The reconnect handler's message refetch (onReady below) is jittered
    // and coalesced, PER CHANNEL: a shared "is anything pending" flag would
    // let a slow fetch for one channel silently swallow a needed refetch for
    // a different one after a mid-outage channel switch (Farol review, round
    // 2). `again` covers the other gap that review found: a second reconnect
    // landing while a fetch is already on the wire (a flap) can't be
    // answered by that in-flight request, whose snapshot may predate it, so
    // it is not simply dropped — one more refetch runs right after this one
    // finishes.
    const reconnectMessagesRefetchState = new Map<
      string,
      {
        timer: ReturnType<typeof setTimeout> | null;
        inFlight: boolean;
        again: boolean;
      }
    >();

    // The reconnect re-read of the Baú switch (onReady below). One slot: a
    // second reconnect replaces the pending re-read instead of stacking one.
    let communityHomeReconnectTimer: ReturnType<typeof setTimeout> | null =
      null;

    function getReconnectMessagesRefetchState(channelId: string) {
      let state = reconnectMessagesRefetchState.get(channelId);
      if (!state) {
        state = { timer: null, inFlight: false, again: false };
        reconnectMessagesRefetchState.set(channelId, state);
      }
      return state;
    }

    function scheduleReconnectMessagesRefetch(channelId: string) {
      // Guards the `.finally()` retry path too (below): a fetch that was
      // still in flight when this effect tore down must not schedule a
      // fresh timer after the fact — cleanup already ran and nothing will
      // ever clear that new one.
      if (cancelled) {
        return;
      }
      const state = getReconnectMessagesRefetchState(channelId);
      if (state.inFlight) {
        state.again = true;
        return;
      }
      if (state.timer !== null) {
        // Already queued for this channel — it will fetch a snapshot no
        // older than the moment it actually runs, which covers this event
        // too.
        return;
      }
      // Spread the refetch itself: every open tab on this channel just
      // reconnected within the same drain-jitter window (realtime.ts), so
      // firing the HTTP request the instant `ready` lands would
      // re-concentrate exactly the herd that window just spread out.
      state.timer = setTimeout(() => {
        state.timer = null;
        runReconnectMessagesRefetch(channelId, state);
      }, uniformJitterMs(0, RECONNECT_MESSAGES_JITTER_MAX_MS));
    }

    /**
     * Drops `channelId`'s entry, but ONLY if `state` is still the object the
     * map holds for it. `state` is a specific object this call's caller
     * owns, passed down from `scheduleReconnectMessagesRefetch` rather than
     * re-read from the map — so if that channel's slot has since moved on to
     * a newer cycle (a fresh entry created after this one was already
     * removed once), this stays a no-op instead of deleting state that
     * belongs to that newer cycle (Farol review).
     */
    function dropReconnectMessagesRefetchStateIfCurrent(
      channelId: string,
      state: unknown,
    ) {
      if (reconnectMessagesRefetchState.get(channelId) === state) {
        reconnectMessagesRefetchState.delete(channelId);
      }
    }

    function runReconnectMessagesRefetch(
      channelId: string,
      state: { inFlight: boolean; again: boolean },
    ) {
      if (cancelled || selectedChannelIdRef.current !== channelId) {
        // Nothing left for this channel's entry — drop it rather than keep a
        // tiny idle record for every channel a long session ever reconnected
        // on (Farol review: the map otherwise grows unbounded).
        dropReconnectMessagesRefetchStateIfCurrent(channelId, state);
        return;
      }
      state.inFlight = true;
      const load = historyLoads.quiet(channelId);
      void fetchMessages(channelId)
        .then((page) => {
          if (selectedChannelIdRef.current === channelId) {
            // Counted, so an open or retry that fails after this landed
            // cannot put the error back over the page it loaded.
            const current = load.succeeded();
            // A reconnect is also how a failed first load heals itself.
            clearHistoryFailed(channelId);
            if (current) {
              chat.setMessages(page.messages, page.hasMore);
              refresh();
            }
          }
        })
        .catch(() => {
          // A flap that lands while this is in flight already sets `again`
          // below regardless of outcome, so a failed fetch still gets
          // retried; otherwise the next reconnect will.
        })
        .finally(() => {
          state.inFlight = false;
          if (state.again) {
            state.again = false;
            scheduleReconnectMessagesRefetch(channelId);
          } else {
            // Fully idle: no timer, not in flight, nothing else queued.
            dropReconnectMessagesRefetchStateIfCurrent(channelId, state);
          }
        });
    }

    async function init() {
      setBootstrapReady(false);
      setBootstrapError(null);

      try {
        const me = await fetchMe();
        if (cancelled) {
          return;
        }
        setUser(me);
        chat.setCurrentUser(me);
        setInviteCacheAccount(me.id);

        // The gate, before anything else this function would do.
        //
        // It has to be a hard stop rather than an overlay: the server refuses
        // every other route for an account that has not passed, so carrying on
        // would fetch servers, channels and ICE credentials that all answer 403
        // and then open a WebSocket that is closed on us — a screen of errors
        // behind a dialog asking a question that explains none of them.
        //
        // An API that predates the gate sends no `ageGate` at all, which is
        // read as "this deployment does not have one" and passes through. Only
        // an explicit `pending` or `blocked` stops here.
        if (me.ageGate === "pending" || me.ageGate === "blocked") {
          setAgeGate(me.ageGate);
          return;
        }
        setAgeGate(null);

        // Only now, and in this order: you cannot ask somebody what they want
        // to be called while they are one answer away from being refused.
        setNeedsOnboarding(shouldRunOnboarding(me));

        // Settings the account carries win over this device's stored copy —
        // another device may have changed them since this browser last saw
        // them. Nothing is sent back: a tab that has been open for hours would
        // otherwise push its stale values over a newer choice made elsewhere.
        // Persisted locally so the next cold start renders them without a wait.
        bindPreferenceSyncAccount(me.id);
        if (me.preferences?.appearance) {
          adoptAppearancePreference(me.preferences.appearance);
        }
        const nextTheme = themeToAdopt(
          me.preferences?.theme,
          getAppearance(),
        );
        if (nextTheme) {
          adoptThemePreference(nextTheme);
        }
        if (me.preferences?.contrast) {
          adoptContrastPreference(me.preferences.contrast);
        }
        if (me.preferences?.accentHue !== undefined) {
          adoptAccentHuePreference(me.preferences.accentHue);
        }
        if (me.preferences?.chatDisplay) {
          adoptChatDisplay(me.preferences.chatDisplay);
        }
        const merged = applyRemotePreferences(
          loadLocalSettings(),
          me.preferences,
        );
        setLocalSettings(merged);
        saveLocalSettings(merged);

        try {
          const { iceServers } = await fetchIceServers();
          if (!cancelled && iceServers.length > 0) {
            voice.setIceServers(iceServers);
          }
        } catch {
          // STUN / VITE_TURN fallbacks still apply
        }

        // Declare whether this build can run the SFU media path. This is a
        // capability, not a transport choice: the server states the room's
        // transport in `welcome` on every join, and the controller obeys it.
        //
        // The backend fetch is therefore best-effort — it only supplies the
        // fallback for a server too old to state the transport. When it failed
        // this tab used to be pinned to mesh for its whole life, which on an SFU
        // deployment meant sitting in calls nobody could hear.
        if (!cancelled && !isMeshForced()) {
          let legacyTransport: VoiceRoomTransport = "mesh";
          try {
            const { backend } = await fetchVoiceBackend();
            legacyTransport = backend === "livekit" ? "livekit" : "mesh";
          } catch {
            // Older server without /api/voice/backend, or a blip.
          }
          if (!cancelled) {
            voice.setSessionProvider(
              (voiceChannelId, peerId) =>
                createVoiceSession(voiceChannelId, peerId),
              legacyTransport,
            );
          }
        }

        const [{ servers: serverList }, homeConfig] = await Promise.all([
          fetchServers(),
          loadCommunityHomeConfig(),
        ]);
        if (cancelled) {
          return;
        }
        communityHomeConfigRef.current = homeConfig;
        setCommunityHomeConfig(homeConfig);
        setServers(serverList);

        // Conversations and blocks are loaded whatever the first view is: the
        // Home badge counts across the whole account, and the block list drives
        // what is hidden inside server channels too.
        void loadConversations();
        void loadBlocks();

        let initialChannelId: string | null = null;
        const first = serverList[0];
        // A URL that already names a server or channel owns the first
        // navigation. Without this the bootstrap opens the first text channel
        // anyway and `syncRoute` rewrites the address bar, so a shared
        // `/message/<id>` link is thrown away before the deep-link effect
        // below ever reads it — permalinks worked only in a tab that was
        // already running. The same race hits `/app/server/<id>` (no channel):
        // bootstrap's `onReady` openChannel(initial) can overwrite the deep
        // link's landing (Home, or first text) and leave "Pick a channel".
        const deepLink = parseAppRoute(window.location.pathname);
        const deepLinksServer = deepLink?.kind === "channel";
        const deepLinksChannel =
          deepLink?.kind === "channel" && deepLink.channelId !== null;
        // A conversation link owns the navigation outright: opening a server
        // first would move the sidebar, then the deep-link effect would move it
        // back, and the trip through a server is a fetch nobody asked for.
        const deepLinksConversation = deepLink?.kind === "conversation";

        if (first && !deepLinksConversation && !deepLinksServer) {
          setSelection({ kind: "server", serverId: first.id });
          setChannelsLoading(true);
          try {
            const { channels: channelList } = await fetchChannels(first.id);
            if (cancelled) {
              return;
            }
            setChannels(channelList);
            const land = deepLinksChannel
              ? null
              : pickServerLandingTarget(
                  channelList,
                  communityHomeOn() && first.communityHomeEnabled === true,
                  first.isCommunity === true,
                );
            initialChannelId = land?.id ?? null;
            void loadUnread(first.id);
          } finally {
            if (!cancelled) {
              setChannelsLoading(false);
            }
          }
        }

        if (cancelled) {
          return;
        }

        setBootstrapReady(true);

        transport.onMessage((message) => {
          if (message.type === "watch-party-waitlist-approved") {
            setWaitlistApprovals((current) =>
              current.some((card) => card.serverId === message.serverId)
                ? current
                : [
                    ...current,
                    { serverId: message.serverId, serverName: message.serverName },
                  ],
            );
            return;
          }
          if (message.type === "stream-started") {
            // The server already chose who hears about it; the window decides
            // whether the OS does. Somebody looking at that very server in a
            // window that is in front already sees the stream (the strip, and
            // the share on the sidebar's roster); anyone else, in the app or
            // not, is who this is for.
            notifyStreamStarted(message, {
              windowFocused:
                document.visibilityState === "visible" && document.hasFocus(),
              openServerId: selectedServerIdRef.current,
            });
            return;
          }
          if (message.type === "channel-session-reminder") {
            emitChannelSessionReminderToast({
              sessionId: message.sessionId,
              channelId: message.channelId,
              title: message.title,
              startsAt: message.startsAt,
              kind: message.kind,
            });
            return;
          }
          if (message.type === "channel-activity") {
            const activity = message as {
              channelId: string;
              mention: boolean;
              /** Null for a conversation, which belongs to no server. */
              serverId?: string | null;
              /** Absent from an API that predates conversations. */
              kind?: ChannelKind;
              /** Conversation-only, and absent when previews are off. */
              preview?: string;
              authorName?: string;
              authorId?: string;
            };
            // Where this came from, taken from the frame rather than looked up.
            // The directory is only ever fed the SELECTED server's channel
            // list, so without this every frame from any other server — and
            // every frame from a thread, which is in no channel list at all —
            // described to nulls: the server's own mute was skipped, the banner
            // could not name where it came from, and the rail had no icon to
            // mark. Placing the channel first is what makes the three lines
            // below able to answer.
            rememberActivityChannel(
              activity.channelId,
              activity.serverId ?? null,
              activity.kind ?? "server",
            );
            if (activity.kind && activity.kind !== "server") {
              // This device's clock: the frame carries no message time. Kept
              // so the next broadcast is not ordered against it.
              const now = new Date().toISOString();
              if (
                conversationsRef.current.some(
                  (one) => one.channelId === activity.channelId,
                )
              ) {
                localConversationStampsRef.current.set(activity.channelId, now);
                setConversations((prev) =>
                  touchConversation(
                    prev,
                    activity.channelId,
                    now,
                    // A frame with a preview is always plain text from
                    // somebody else — this account never receives its own
                    // activity, and an attachment/GIF-only message carries
                    // no preview at all (falls back to the count, same as
                    // the toast). `undefined` here leaves the row's existing
                    // preview alone rather than blanking it.
                    activity.preview && activity.authorId
                      ? {
                          authorId: activity.authorId,
                          authorName: activity.authorName ?? "",
                          preview: activity.preview,
                          isAttachment: false,
                          isGif: false,
                        }
                      : undefined,
                  ),
                );
              } else {
                // Somebody opened a conversation with this account while it was
                // running. There is no row to bump — the list has to be fetched
                // before the message has anywhere to appear at all.
                void loadConversationsRef.current();
              }
            }
            // --- threads --- activity in the thread the panel is showing is
            // already on the reader's screen; a badge or a notification would
            // announce what they are looking at. Any other thread's activity
            // falls through to the generic path below, which files it under
            // the thread's own channel id — the sidebar knows no such id, so
            // the parent channel's badge stays quiet by construction and the
            // chip's dot reads it from the same map.
            if (activity.channelId === openThreadChannelIdRef.current) {
              return;
            }
            // Fired from the live frame rather than from a diff of `unread`,
            // because that map also fills in bulk from `loadUnread` when a
            // server is first opened — announcing that would buzz once per
            // channel with a backlog. Runs before the early return below so a
            // hidden tab still hears about the channel it left open.
            notifyChannelActivity(
              describeActivity(
                activity.channelId,
                { count: 1, mentions: activity.mention ? 1 : 0 },
                {
                  preview: activity.preview,
                  authorName: activity.authorName,
                  authorId: activity.authorId,
                },
              ),
              {
                selectedChannelId: selectedChannelIdRef.current,
                documentVisible: document.visibilityState === "visible",
                windowFocused: document.hasFocus(),
                immersive: document.documentElement.hasAttribute(
                  "data-immersive-stage",
                ),
              },
            );
            if (activity.channelId === selectedChannelIdRef.current) {
              return;
            }
            setUnread((prev) => {
              const current = prev[activity.channelId] ?? {
                count: 0,
                mentions: 0,
              };
              return {
                ...prev,
                [activity.channelId]: {
                  count: current.count + 1,
                  mentions: current.mentions + (activity.mention ? 1 : 0),
                },
              };
            });
            return;
          }

          // Somebody heard a voice note: the listener's own other sockets (so
          // the dot goes everywhere) and the author's (for "ouviu"). The store
          // is global because the player is; no controller owns it.
          if (isVoiceNoteListenedFrame(message)) {
            applyVoiceNoteListened(message);
            return;
          }

          // Somebody started or stopped looking at a channel. The chat
          // controller wants it for the header count; the shared roster
          // treats it as the cheapest available hint that presence has
          // moved (status is not on this frame). Neither is the frame's
          // owner, so it is nudged here and still falls through.
          // Both presence frames, or the nudge would stop firing for every
          // client that negotiated deltas and the member roster would go
          // stale for exactly the builds the optimisation is aimed at.
          if (
            message.type === "presence-update" ||
            message.type === "presence-delta"
          ) {
            bumpMemberRosterNudge();
          }

          if (
            message.type === "message-broadcast" ||
            message.type === "message-update" ||
            message.type === "message-delete" ||
            message.type === "reaction-broadcast" ||
            message.type === "message-deleted" ||
            message.type === "message-bulk-delete" ||
            message.type === "presence-update" ||
            message.type === "presence-delta" ||
            message.type === "typing-broadcast" ||
            message.type === "poll-update" ||
            message.type === "message-rejected"
          ) {
            // Somebody else's message landed in the channel on screen. It is
            // read once the reader can see it (tab visible, list at its live
            // end), so the next visit's NEW rule does not sit above it; the
            // ack decides that, not this. The server sends no
            // `channel-activity` for the open channel, which is why this keys
            // on the broadcast.
            if (
              message.type === "message-broadcast" &&
              message.message.channelId === selectedChannelIdRef.current &&
              message.message.authorId !== userIdRef.current
            ) {
              liveReadAck.note(
                message.message.channelId,
                message.message.createdAt,
              );
            }
            // A message this account sent, or one in the conversation it has
            // open, arrives here in full and never as `channel-activity`, so
            // the row is moved from the broadcast itself. The list leaves out
            // what a blocked author said; so does this.
            if (
              message.type === "message-broadcast" &&
              conversationsRef.current.some(
                (one) => one.channelId === message.message.channelId,
              ) &&
              !blockedUsersRef.current.some(
                (blocked) => blocked.id === message.message.authorId,
              )
            ) {
              const broadcast = message.message;
              const localStampedAt =
                localConversationStampsRef.current.get(broadcast.channelId) ??
                null;
              setConversations((prev) =>
                applyConversationMessage(prev, broadcast, {
                  previewsOn: getNotificationState().previewInApp,
                  localStampedAt,
                }),
              );
            }
            chat.handleServerMessage(message);
            // --- threads --- both controllers hear every chat frame and each
            // keeps only its own channel's, so one frame can never render in
            // both views.
            threadChat.handleServerMessage(message);
            return;
          }

          // Your friendships changed. Content-free by design, so the store's
          // one job is to re-read — and because the store lives up here rather
          // than inside the friends view, the badge on the front door moves
          // whether or not that view has ever been opened. This frame is the
          // whole answer to "B is looking at a channel; what do they see?".
          if (message.type === "friend-activity") {
            friendsRef.current.applyNudge(message.kind);
            return;
          }

          // A kick, a ban or a delete took this server away while the tab was
          // open. The server already refuses every read and send that
          // follows; without this the rail, the channels and a member list
          // with us still in it stayed up until a reload. Dropped the same
          // way leaving does, then said once, in the error slot: the drop
          // clears that slot, so the sentence goes in after it.
          if (message.type === "server-removed") {
            const gone = serversRef.current.find(
              (row) => row.id === message.serverId,
            );
            if (!gone) {
              return;
            }
            // The owner's own delete: the settings dialog drops it too, and
            // telling them what they just did is noise.
            const quiet = message.reason === "deleted" && gone.role === "owner";
            if (message.serverId === selectedServerIdRef.current) {
              setServerSettingsOpen(false);
              setServerSettingsSection(undefined);
            }
            void dropServerRef.current(message.serverId).then(() => {
              if (quiet) {
                return;
              }
              // An older good-news line (a "you joined" one, say) must not
              // sit beside the news that the server is gone.
              setAppNotice(null);
              setAppError(
                translateMessage(SERVER_REMOVED_COPY[message.reason], {
                  server: gone.name,
                }),
              );
            });
            return;
          }

          // Another tab or device of this account changed its status. Without
          // this the user panel here read the old choice until a reload.
          if (message.type === "own-status") {
            statusRef.current.adoptRemote(message.status);
            return;
          }

          // Somebody played a voice note: the listener's other devices clear
          // the dot, and the author of a small conversation's note sees an
          // "ouviu". Not applied yet (the client PR for listens does), but it
          // is a chat frame and must not fall through to the voice handler.
          if (message.type === "voice-note-listened") {
            return;
          }

          if (message.type === "permissions-update") {
            if (message.serverId !== selectedServerIdRef.current) {
              return;
            }
            permsRef.current.refresh(message.version);
            bumpMemberRosterNudge();
            // A real ticket: this batch reads the list later than any fetch
            // already out, so it may write over them, and a `channels-update`
            // refetch that starts after it (and lands first) is not
            // overwritten by it when it lands second.
            const listTicket = channelListTickets.take();
            void Promise.all([
              fetchChannels(message.serverId),
              fetchRoles(message.serverId).then(
                (res) => res,
                () => null,
              ),
              fetchMembers(message.serverId).then(
                (res) => res,
                () => null,
              ),
            ])
              .then(([{ channels: fetched }, rolesRes, membersRes]) => {
                if (selectedServerIdRef.current !== message.serverId) {
                  return;
                }
                const listIsCurrent = channelListTickets.isLatest(listTicket);
                const list = channelListTickets.withCreated(
                  message.serverId,
                  fetched,
                  listTicket,
                );
                if (listIsCurrent) {
                  channelListTickets.wrote(listTicket);
                  setChannels(list);
                }
                if (rolesRes) {
                  setServerRoles(rolesRes.roles);
                  setMentionableRoles(
                    rolesRes.roles.map((role) => ({
                      id: role.id,
                      name: role.name,
                      mentionable: role.mentionable,
                      isEveryone: role.isEveryone,
                    })),
                  );
                }
                if (membersRes) {
                  setServerMembers(membersRes.members);
                  setMemberRoles(
                    new Map(
                      membersRes.members.map((member) => [member.id, member.role]),
                    ),
                  );
                }
                const current = selectedChannelIdRef.current;
                if (
                  listIsCurrent &&
                  !channelLoadsRef.current.has(message.serverId) &&
                  current &&
                  !list.some((channel) => channel.id === current)
                ) {
                  const next =
                    list.find((channel) => channel.type === "text") ?? list[0];
                  if (next) {
                    setSelectedChannelId(next.id);
                    selectedChannelIdRef.current = next.id;
                  }
                }
              })
              .catch(() => {
                // A `channels-update` refetch this batch overtook was silenced
                // by its ticket: start it again, or the change stays missing
                // until the next navigation.
                if (
                  channelListTickets.owesUpdate(message.serverId, listTicket) &&
                  selectedServerIdRef.current === message.serverId
                ) {
                  refreshChannelListRef.current(message.serverId);
                }
              });
            return;
          }

          // A channel this person can see on the open server was created,
          // renamed, edited, moved or deleted. `refreshChannelList` refetches
          // and orders the refetch against every other list fetch. A member
          // in DMs or on another server loads the list fresh when they get
          // here.
          if (message.type === "channels-update") {
            if (message.serverId !== selectedServerIdRef.current) {
              return;
            }
            refreshChannelListRef.current(message.serverId);
            return;
          }

          // Baú changed on the open server — a publish, pin, unpublish or
          // delete. Likes and new comments do not fan out. The frame carries
          // only the serverId, so the client refetches; a member sitting in
          // DMs or another server is not "in" this one and is left alone.
          //
          // When the owner flips the server's Baú switch the frame also
          // carries the new value and its version. It is written onto that
          // server wherever the member is looking, so the row, the landing
          // and the feed agree with the owner without a reload. Only a higher
          // version than the row holds is applied, so a late or duplicated
          // frame cannot undo a newer flip.
          if (message.type === "community-home-update") {
            const { enabled, version } = message;
            if (typeof enabled === "boolean" && typeof version === "number") {
              setServers((rows) =>
                applyCommunityHomeSwitch(rows, message.serverId, {
                  enabled,
                  version,
                }),
              );
            } else if (typeof enabled === "boolean") {
              // A flip from an API instance without versions (mid rolling
              // deploy): its order is unknown, so ask for the persisted value.
              reconcileCommunityHomeSwitchRef.current(message.serverId);
            }
            if (message.serverId === selectedServerIdRef.current) {
              setCommunityHomeUpdateNudge((n) => n + 1);
            }
            return;
          }

          // Somebody's name or picture changed, anywhere on the instance.
          //
          // Not addressed to a channel, so it is handled here rather than in
          // the chat controller alone: an avatar is drawn in places the
          // controller knows nothing about. Three of them are repainted from
          // one frame — the transcript, the conversation sidebar, and the
          // account's own header when the change was made in another tab.
          //
          // The moderation *panel* is not, deliberately: it fetches its own
          // roster when opened and is closed the overwhelming majority of the
          // time. The shared member roster (sidebar + transcript pips) is the
          // opposite case — it is on screen all the time at desktop widths —
          // so name and avatar are patched in place rather than refetching a
          // hundred rows for one person.
          if (message.type === "profile-update") {
            chat.applyProfileUpdate(message);
            threadChat.applyProfileUpdate(message);
            // Recado is merged only when the frame carries the key. An older
            // API during a rolling deploy omits it, and that is not a clear.
            // Explicit null is "they cleared it" and has to land as null.
            // applyProfileUpdate above rewrites names on loaded messages;
            // messages do not carry a recado, so that path does not touch it.
            setServerMembers((prev) =>
              prev.some((one) => one.id === message.userId)
                ? prev.map((one) =>
                    one.id === message.userId
                      ? withProfileUpdate(one, message)
                      : one,
                  )
                : prev,
            );
            setConversations((prev) =>
              prev.map((conversation) =>
                conversation.participants.some(
                  (person) => person.id === message.userId,
                )
                  ? {
                      ...conversation,
                      participants: conversation.participants.map((person) =>
                        person.id === message.userId
                          ? withProfileUpdate(person, message)
                          : person,
                      ),
                    }
                  : conversation,
              ),
            );
            setUser((prev) =>
              prev && prev.id === message.userId
                ? withProfileUpdate(prev, message)
                : prev,
            );
            return;
          }

          // --- threads --- the chip refresh: reply count and freshness for
          // an origin message in whatever channel the main view is showing.
          if (message.type === "thread-update") {
            chat.applyThreadUpdate(message.messageId, message.thread);
            // A thread not listed could be a stranger's, or one
            // of this reader's own that the per-channel cap had pushed out and
            // this reply has just brought back. Only the server can tell the
            // two apart, because only it knows who is in what, so ask it —
            // coalesced, since a busy channel produces these constantly.
            // Beside the state updater rather than inside it: an updater is
            // not a place to start work.
            //
            // That includes the thread open right now. Opening is not joining,
            // so an open thread is no more "mine" than any other: this reader
            // may have left it a moment ago, and their own reply is what
            // brings it back, which only the server can see.
            //
            // Right away, not coalesced, when this is the frame for a reply
            // this reader just sent from the panel: that reply is what (re)joins
            // the thread, and the row appearing five seconds later reads as
            // broken. Waiting for the frame, rather than asking on send, is
            // what guarantees the message is written before the question.
            if (
              !(threadsByChannelRef.current[message.thread.parentChannelId] ?? [])
                .some((one) => one.channelId === message.thread.channelId)
            ) {
              // One immediate read at a time: several replies sent before
              // the first read lands fall back to the coalesced reload
              // instead of each starting a full read of their own.
              const serverId = selectedServerIdRef.current;
              if (
                ownThreadReplyRef.current === message.thread.channelId &&
                serverId &&
                !ownReplyReloadInFlightRef.current
              ) {
                ownThreadReplyRef.current = null;
                ownReplyReloadInFlightRef.current = true;
                void reloadServerThreadsRef
                  .current(serverId)
                  .finally(() => {
                    ownReplyReloadInFlightRef.current = false;
                  });
              } else {
                scheduleThreadsReload();
              }
            }
            // The sidebar row moves to the top of its channel on every reply,
            // which is the whole point of listing the active ones.
            //
            // A thread NOT already listed is left alone here: the list is
            // only the threads this reader is in, and the server decided that.
            // Adding every thread that gets a reply would undo the filter one
            // frame at a time.
            setThreadsByChannel((prev) => {
              const parent = message.thread.parentChannelId;
              const current = prev[parent] ?? [];
              const listed = current.some(
                (one) => one.channelId === message.thread.channelId,
              );
              if (!listed) {
                return prev;
              }
              const rest = current.filter(
                (one) => one.channelId !== message.thread.channelId,
              );
              return {
                ...prev,
                [parent]: message.thread.archived
                  ? rest
                  : [message.thread, ...rest].slice(
                      0,
                      SIDEBAR_THREADS_PER_CHANNEL,
                    ),
              };
            });
            // The open panel's header shows the same numbers.
            setOpenThread((prev) =>
              prev && prev.thread.channelId === message.thread.channelId
                ? { ...prev, thread: message.thread }
                : prev,
            );
            return;
          }

          // A refused send. Without this the frame fell through to the voice
          // handler, which is not where a chat refusal belongs, and the person
          // was left with a failed message and no reason for it.
          if (message.type === "sanction-notice") {
            setSanctionNotice(message);
            return;
          }

          // --- voice moderation ---
          // A moderator acted on THIS client's voice session. Handled here,
          // not in the voice controller: what follows is app behaviour
          // (leave, or rejoin somewhere else), and the frame carries the
          // whole English sentence, kept as the fallback. Guarded to the room we are actually in —
          // a stale or forged frame about some other channel does nothing.
          if (message.type === "voice-moderation") {
            const current = voice.getState();
            if (current.voiceChannelId !== message.voiceChannelId) {
              return;
            }
            // The notice is written here in the person's language; the
            // frame's English `message` is only the fallback.
            setAppError(
              voiceModerationNotice(
                message,
                channelsRef.current.find(
                  (one) => one.id === message.movedToChannelId,
                )?.name,
                translateMessage,
              ),
            );
            if (message.action === "disconnected") {
              setIdleWarning(null);
            }
            if (message.action === "moved" && message.movedToChannelId) {
              // Follow the move with an ordinary join: the server re-runs
              // every admission check (access, timeout, transport, room-full),
              // so this can never take us anywhere we could not have gone
              // ourselves. Consent is being in this server's voice at all —
              // see the schema note on `voiceModerationMessageSchema`.
              void voice.join(message.movedToChannelId);
            } else if (message.action === "disconnected") {
              // The server already dropped our peer; this stops the mic and
              // resets the UI so we do not sit "connected" in an empty room.
              voice.leave();
            }
            // "muted"/"unmuted": the roster's `serverMuted` flag does the
            // enforcing (see `serverMutedPeerIds` in `use-voice`); the banner
            // above is the explanation.
            return;
          }

          // Alone in the room and about to be hung up. App behaviour, like
          // the moderation frame above: the banner lives beside the other
          // banners, and the answer is one client frame. Guarded to the room
          // we are in for the same reason.
          if (message.type === "voice-idle-warning") {
            if (voice.getState().voiceChannelId !== message.voiceChannelId) {
              return;
            }
            setIdleWarning({
              voiceChannelId: message.voiceChannelId,
              disconnectAt: message.disconnectAt,
            });
            return;
          }

          // The server itself took the warning back: somebody else joined,
          // a live watch party started, or our own "still here" (or any
          // other self-initiated frame) reached it and reset the clock.
          // This, not the click that sent `voice-still-here`, is what
          // clears the banner — see the schema note on
          // `voiceIdleWarningCancelledMessageSchema` for why the
          // confirmation has to come from the server rather than being
          // assumed the moment the button is pressed.
          if (message.type === "voice-idle-warning-cancelled") {
            setIdleWarning((current) =>
              current?.voiceChannelId === message.voiceChannelId ? null : current,
            );
            return;
          }

          // The watch party event object changed. Handled here and NOT passed
          // on: `voice.handleSignaling` types its input as a voice frame, and
          // this one is a chat frame that happens to be routed per socket.
          if (message.type === "watch-party-update") {
            watchPartiesRef.current.apply(message.channelId, message.party);
            return;
          }

          // --- voice state ---
          // Record each room's transport as rosters pass through (the frame
          // still falls through to the controller). Powers the members
          // panel's honest SFU-only mute affordance.
          if (message.type === "voice-roster" && message.transport) {
            const { voiceChannelId, transport: roomTransport } = message;
            setVoiceRoomTransports((prev) =>
              prev[voiceChannelId] === roomTransport
                ? prev
                : { ...prev, [voiceChannelId]: roomTransport },
            );
          }

          voice.handleSignaling(message);
        });

        transport.onStatusChange((status) => {
          setConnection(status);
          if (status === "online") {
            setAppError(null);
          }
        });

        // Connectivity already has a dedicated strip driven by status; routing
        // it here too would paint the same sentence twice.
        transport.onError((message) => {
          if (transport.getStatus() === "online") {
            setAppError(message);
          }
        });

        transport.onClose(() => {
          // Keep media. A Fly restart closes /ws with 1001; ICE and LiveKit do
          // not need that socket once they are up. Resume reattaches the peer.
          voice.notifyDisconnected();
        });

        transport.onAuthUnavailable(() => {
          voice.notifyAuthLost();
        });

        transport.onReady((reconnected) => {
          if (cancelled) {
            return;
          }
          const channelId = selectedChannelIdRef.current;
          if (!reconnected) {
            if (initialChannelId) {
              void openChannel(initialChannelId);
            }
            // Messages saved before a reload or a quit go out on the first
            // ready socket; the reconnect path does the same via resubscribe.
            chat.flushOutbox();
            return;
          }
          // Re-subscribe and re-sync: messages sent while we were offline were
          // never delivered, so the local list is stale.
          chat.resubscribe();
          // --- threads --- the secondary slot re-announces itself the same
          // way; the panel's window is refreshed by its next open.
          threadChat.resubscribe();
          // --- threads --- the sidebar rows are a read, not a subscription
          // (see the note on threadsByChannel), so frames missed while the
          // socket was down are simply gone. Re-ask.
          if (selectedServerIdRef.current) {
            void reloadServerThreadsRef.current(selectedServerIdRef.current);
          }
          // A `channels-update` refetch that failed through every retry left
          // this server's list stale. Only then: an unconditional refetch on
          // every reconnect would add a read per tab to a reconnect storm.
          const staleServerId = channelListStaleRef.current;
          if (staleServerId && staleServerId === selectedServerIdRef.current) {
            refreshChannelListRef.current(staleServerId);
          }
          // A Baú switch flipped while the socket was down never arrives as
          // a frame. Every server is re-read when next opened; the one on
          // screen now, after the same jitter as the message refetch.
          for (const row of serversRef.current) {
            communityHomeUnverifiedRef.current.add(row.id);
          }
          const reconnectServerId = selectedServerIdRef.current;
          if (communityHomeReconnectTimer !== null) {
            clearTimeout(communityHomeReconnectTimer);
            communityHomeReconnectTimer = null;
          }
          if (reconnectServerId) {
            communityHomeReconnectTimer = setTimeout(() => {
              communityHomeReconnectTimer = null;
              if (
                !cancelled &&
                selectedServerIdRef.current === reconnectServerId &&
                communityHomeUnverifiedRef.current.has(reconnectServerId)
              ) {
                reconcileCommunityHomeSwitchRef.current(reconnectServerId);
              }
            }, uniformJitterMs(0, RECONNECT_MESSAGES_JITTER_MAX_MS));
          }
          // Join with resumePeerId before any other voice frames.
          const rejoin = voice.notifyReconnected();
          if (channelId) {
            scheduleReconnectMessagesRefetch(channelId);
          }
          return rejoin;
        });

        transport.connect(() => resolveTokenRef.current());
      } catch (error) {
        if (cancelled) {
          return;
        }
        // A transient overload — the DB breaker's `503 database_unavailable`,
        // or a network error / timeout (`ApiError` status 0) — self-retries
        // with jittered backoff instead of dumping every tab onto the manual
        // error screen at once (from which 300 people all click Retry). A 503
        // carrying `Retry-After` backs off harder than a bare network drop:
        // `bootstrapRetryDelayMs` honors it as a floor. The loading shell stays
        // up meanwhile (bootstrapReady false, bootstrapError null).
        const isOverload = error instanceof ApiError && error.status === 503;
        const isNetworkError = error instanceof ApiError && error.status === 0;
        const transient = isOverload || isNetworkError;
        const retryBudget = isOverload
          ? MAX_BOOTSTRAP_AUTO_RETRIES_OVERLOAD
          : MAX_BOOTSTRAP_AUTO_RETRIES_NETWORK;
        if (transient && autoRetryCount < retryBudget) {
          const retryAfterMs =
            error instanceof ApiError ? error.retryAfterMs : null;
          const delay = bootstrapRetryDelayMs(autoRetryCount, retryAfterMs);
          autoRetryCount += 1;
          bootstrapTimer = setTimeout(() => {
            bootstrapTimer = null;
            if (!cancelled) {
              void init();
            }
          }, delay);
          return;
        }
        setBootstrapError(
          error instanceof Error
            ? error.message
            : // `translateMessage`, not the `t` from render: this effect is
              // pinned to `bootstrapAttempt` and would otherwise close over the
              // English `t` from first paint, long before the catalogue lands.
              translateMessage("bootstrapError.fallback"),
        );
      }
    }

    // The automatic first load (bootstrapAttempt === 0) is spread across a few
    // seconds so a synchronized F5 wave does not land its bootstrap requests in
    // one instant. A deliberate user retry (bootstrapAttempt > 0, the error
    // screen's button) is never delayed — it must feel instant.
    if (bootstrapAttempt === 0) {
      bootstrapTimer = setTimeout(() => {
        bootstrapTimer = null;
        if (!cancelled) {
          void init();
        }
      }, bootstrapJitterMs());
    } else {
      void init();
    }

    return () => {
      cancelled = true;
      if (bootstrapTimer !== null) {
        clearTimeout(bootstrapTimer);
      }
      for (const state of reconnectMessagesRefetchState.values()) {
        if (state.timer !== null) {
          clearTimeout(state.timer);
        }
      }
      if (communityHomeReconnectTimer !== null) {
        clearTimeout(communityHomeReconnectTimer);
      }
      voice.leave();
      transport.disconnect();
    };
    // Only re-bootstrap on explicit retry — unstable Clerk token fn must not remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapAttempt]);

  /**
   * Mirror the current selection into the URL so links are shareable and
   * `pqp://server/<id>/channel/<id>` round-trips. Records the path first so the
   * deep-link effect ignores navigations we caused ourselves.
   *
   * Takes the whole selection rather than a server id. It used to return early
   * when that id was null, which was the right answer while "no server" meant
   * "nothing to link to" — a conversation has a URL, and bailing out here left
   * it unaddressable and unshareable.
   */
  const syncRoute = useCallback(
    (target: Selection, channelId: string | null) => {
      // Steam / Battle.net / Twitch just bounced here with the proof in the
      // query string. Rewriting to a channel URL would drop it before the
      // overlay POSTs. The overlay navigates to `/app` when it is done.
      if (connectionProviderFromPath(window.location.pathname)) {
        return;
      }
      const path = selectionRoutePath(target, channelId);
      if (routeRef.current === path) {
        return;
      }
      routeRef.current = path;
      navigate(path, { replace: true });
    },
    [navigate],
  );

  /**
   * Where "stop watching" goes: the server's first ordinary text channel.
   *
   * A watch party room is never in the sidebar, so leaving it has to land
   * somewhere real rather than on "Escolha um canal". Undefined on a server
   * with no text channel at all, in which case the control is not offered:
   * a button that goes nowhere is worse than no button.
   */
  const firstTextChannelId = useMemo(
    () => channels.find((one) => one.type === "text")?.id,
    [channels],
  );

  /**
   * THE STREAM FOLLOWS THE VIEWER OUT OF THE CHANNEL.
   *
   * A seatless viewer who wants to read the chat in another channel used to
   * have to choose: the watch stage is mounted by the selected channel, so
   * clicking anything else destroyed hls.js and coming back cost a fresh
   * attach, a fresh ladder negotiation and the buffering that goes with it.
   * `watch-dock.tsx` mounts the surface once, at the root of this component,
   * and MOVES it between the channel pane and a corner box. The candidate is
   * "the voice room that is open right now"; a stream is not required to latch
   * it, because the stage itself is what asks the API whether one is running.
   */
  const watchDockCandidate = useMemo<WatchDockSession | null>(() => {
    if (selection.kind !== "server" || !selectedChannelId) {
      return null;
    }
    const channel = channels.find((one) => one.id === selectedChannelId);
    if (
      !channel ||
      channel.kind !== "server" ||
      !isVoiceRoomChannelType(channel.type)
    ) {
      return null;
    }
    const server = servers.find((one) => one.id === channel.serverId);
    return {
      channelId: channel.id,
      channelName: channel.name,
      serverId: channel.serverId,
      serverName: server?.name ?? null,
      serverIconUrl: server?.iconUrl ?? null,
      isWatchParty:
        isWatchPartyChannelType(channel.type) && isWatchPartyChannelsEnabled(),
    };
  }, [channels, selectedChannelId, selection.kind, servers]);
  const watchDock = useWatchDock({
    selectedChannelId,
    candidate: watchDockCandidate,
    channelLive: voiceState.channelLive,
    inCallChannelId:
      voiceState.status === "idle" ? null : voiceState.voiceChannelId,
  });
  /**
   * The confirm in front of a join that would cost the docked stream, and the
   * rule that the stream is only given up once the seat is real. `seated` is
   * read from the controller rather than from `voiceState`, because this is
   * asked the moment the join settles and a render has not happened yet.
   */
  const joinGuard = useVoiceJoinGuard({
    dockedChannelId: watchDock.dockedChannelId,
    seated: (channelId) => {
      const current = voice.getState();
      return current.voiceChannelId === channelId && current.status !== "idle";
    },
    onSeated: watchDock.dismiss,
  });

  const selectChannel = useCallback(
    async (channelId: string, serverIdOverride?: string) => {
      // The override matters when a server was only just chosen: `selection` is
      // still the previous one this render, and the URL has to name the server
      // whose channel is being opened rather than the one being left.
      const nextSelection = serverIdOverride
        ? { kind: "server" as const, serverId: serverIdOverride }
        : selection;
      // Home is not a real channel id in the address bar — keep `/app/server/<id>`.
      syncRoute(
        nextSelection,
        isCommunityHomeChannelId(channelId) ? null : channelId,
      );
      // Voice deliberately survives navigating away: leaving a call because you
      // clicked another channel is not how a chat app should behave.
      await openChannel(channelId);
    },
    [openChannel, selection, syncRoute],
  );
  selectChannelRef.current = selectChannel;

  /**
   * Refetch the open server's channel list after a `channels-update` frame.
   * The frame names no channel, so the whole list is refetched; the server
   * filters it per viewer, and only the people who can see the change get
   * the frame at all. A member in DMs or on another server loads the list
   * fresh when they get here.
   *
   * A failure retries on a backoff (`channelListRetryDelayMs`) while this is
   * still the newest ticket and the server is still open. When the schedule
   * is spent the server is marked stale and refetched on the next reconnect.
   *
   * Only ever for the open server. A late caller asking for a server the
   * person has already left must not take a ticket or cancel a pending
   * retry: either would stop the open server's own refresh, and nothing
   * would start it again.
   */
  function refreshChannelList(serverId: string, failedTries = 0) {
    if (selectedServerIdRef.current !== serverId) {
      return;
    }
    if (channelListRetryTimerRef.current !== null) {
      clearTimeout(channelListRetryTimerRef.current);
      channelListRetryTimerRef.current = null;
    }
    const ticket = channelListTickets.take();
    channelListTickets.updateStarted(serverId, ticket);
    const current = () =>
      channelListTickets.isLatest(ticket) &&
      selectedServerIdRef.current === serverId;
    void fetchChannels(serverId).then(
      ({ channels: fetched }) => {
        if (!current()) {
          return;
        }
        channelListTickets.wrote(ticket);
        // Started before a channel this reader just created: keep it, or
        // the fallback below would take them off the channel they made.
        const list = channelListTickets.withCreated(serverId, fetched, ticket);
        if (channelListStaleRef.current === serverId) {
          channelListStaleRef.current = null;
        }
        setChannels(list);
        // Deleted under the person reading it: open another channel the same
        // way a click would, so the transcript and the composer follow, not
        // just the highlighted row.
        // Not while a navigation is loading this server: the selection is
        // then still the previous server's channel (or a DM), which this
        // list never had. That load picks the landing itself.
        const fallback = channelLoadsRef.current.has(serverId)
          ? { vanished: false as const }
          : vanishedChannelFallback(list, selectedChannelIdRef.current);
        if (fallback.vanished) {
          if (fallback.nextId) {
            void selectChannelRef.current(fallback.nextId, serverId);
          } else {
            setSelectedChannelId(null);
            selectedChannelIdRef.current = null;
          }
        }
      },
      () => {
        if (!current()) {
          return;
        }
        const delay = channelListRetryDelayMs(failedTries + 1);
        if (delay === null) {
          channelListStaleRef.current = serverId;
          return;
        }
        channelListRetryTimerRef.current = setTimeout(() => {
          channelListRetryTimerRef.current = null;
          if (current()) {
            refreshChannelList(serverId, failedTries + 1);
          }
        }, delay);
      },
    );
  }
  refreshChannelListRef.current = (serverId) => refreshChannelList(serverId);

  /** Open one conversation, switching the sidebar to the home view with it. */
  const selectConversation = useCallback(
    async (channelId: string) => {
      setSelection(HOME_SELECTION);
      syncRoute(HOME_SELECTION, channelId);
      await openChannel(channelId);
    },
    [openChannel, syncRoute],
  );

  const handleShortcut = useCallback(
    (action: ShortcutAction) => {
      switch (action) {
        case "toggleOverlay":
          setShortcutOverlayOpen((open) => !open);
          return;
        case "toggleMute":
          if (voice.getState().status === "connected") {
            voice.toggleMute();
          }
          return;
        case "toggleDeafen":
          if (voice.getState().status === "connected") {
            voice.toggleDeafen();
          }
          return;
        case "openUserSettings":
          setShortcutOverlayOpen(false);
          setSettingsSection(null);
          setSettingsOpen(true);
          return;
        case "openNewDm":
          setShortcutOverlayOpen(false);
          setNewDmOpen(true);
          return;
        case "previousChannel":
        case "nextChannel":
        case "previousUnreadChannel":
        case "nextUnreadChannel": {
          const direction =
            action === "previousChannel" || action === "previousUnreadChannel"
              ? -1
              : 1;
          const inServer = selection.kind === "server";
          const ids = inServer
            ? navigableChannelIds(channels)
            : conversations.map((conversation) => conversation.channelId);
          const next =
            action === "previousUnreadChannel" || action === "nextUnreadChannel"
              ? stepUnreadChannelId(
                  ids,
                  selectedChannelId,
                  (id) => channelIsUnread(unread, id),
                  direction,
                )
              : stepChannelId(ids, selectedChannelId, direction);
          if (!next) {
            return;
          }
          if (inServer) {
            void selectChannel(next);
          } else {
            void selectConversation(next);
          }
        }
      }
    },
    [
      channels,
      conversations,
      selectChannel,
      selectConversation,
      selectedChannelId,
      selection.kind,
      unread,
      voice,
    ],
  );

  const shortcutBindings = useKeyboardShortcuts({
    overrides: localSettings.shortcuts,
    isMac: isApplePlatform(),
    onAction: handleShortcut,
  });

  /**
   * Electron: global mute/deafen hotkeys, so they still work when the app
   * window is not focused (alt-tabbed into a game, say).
   *
   * ARBITRATION, so this never fires twice for one press. The main process
   * (see `syncGlobalVoiceHotkeys` in `electron/main.js`) holds the global
   * accelerator only while the window is unfocused, exactly like push-to-talk
   * above: while focused it lets go, and whichever in-window path already
   * owns the chord handles it instead: the app menu's fixed
   * Cmd/Ctrl+Shift+M/D for the default binding (`desktopOwnsDefault` in
   * `use-keyboard-shortcuts.ts` skips the renderer's own listener for
   * exactly that chord), or the renderer's key listener for a remap. So a
   * given press is live on at most one of "global" and "in-window" at a
   * time, never both.
   *
   * GATED TO CALLS ONLY. Registering a global accelerator swallows it
   * system-wide, so the shell is asked to hold Cmd/Ctrl+Shift+M only while
   * `inCall`, and told to let go (both `null`) the moment it is not: on
   * leave, on disconnect, on unmount. Nobody who is not even in a voice
   * channel should lose that chord to another application.
   *
   * Both bound actions land on the same `pqp:voice-command` /
   * `onVoiceCommand` handler the tray menu already uses, so there is one
   * place in the renderer that acts on a global mute/deafen toggle.
   */
  const toggleMuteBinding = shortcutBindings.toggleMute;
  const toggleDeafenBinding = shortcutBindings.toggleDeafen;
  useEffect(() => {
    const desktop = getDesktop();
    const bind = desktop?.bindGlobalVoiceHotkeys?.bind(desktop);
    if (!bind) {
      return;
    }
    if (!inCall) {
      void bind({ toggleMute: null, toggleDeafen: null });
      return;
    }
    void bind(
      globalVoiceHotkeyAccelerators({
        toggleMute: toggleMuteBinding,
        toggleDeafen: toggleDeafenBinding,
      }),
    );
    return () => {
      void bind({ toggleMute: null, toggleDeafen: null });
    };
  }, [inCall, toggleMuteBinding, toggleDeafenBinding]);

  const handleForwardPick = useCallback(
    async (target: ForwardTarget) => {
      const message = forwardMessage;
      setForwardMessage(null);
      if (!message) {
        return;
      }
      const excerpt = buildReplyExcerpt(message.body) || "…";
      const quote = t("chat.forward.quote", {
        name: message.authorName,
        excerpt,
      });
      const link = `${window.location.origin}${messageRoutePath(
        selectedServerId,
        message.channelId,
        message.id,
      )}`;
      const draft = `${quote}\n${link}`;
      if (target.kind === "channel") {
        await selectChannel(target.id);
      } else {
        await selectConversation(target.id);
      }
      setComposerInsert(draft);
    },
    [forwardMessage, selectChannel, selectConversation, selectedServerId, t],
  );

  /** Leave the conversation view open with nothing selected in it. */
  const selectHome = useCallback(() => {
    setSelection(HOME_SELECTION);
    setSelectedChannelId(null);
    selectedChannelIdRef.current = null;
    syncRoute(HOME_SELECTION, null);
    void loadConversations();
  }, [loadConversations, syncRoute]);

  const loadChannels = useCallback(
    async (
      serverId: string,
      /**
       * Pick the landing from what this server has on right now rather than
       * from its layout: `refreshAfterJoin` passes the watch parties it
       * fetched, so a join during a show opens the show.
       */
      liveParties?: readonly WatchParty[],
    ) => {
      setChannelsLoading(true);
      beginChannelLoad(serverId);
      if (communityHomeUnverifiedRef.current.has(serverId)) {
        reconcileCommunityHomeSwitchRef.current(serverId);
      }
      const ticket = channelListTickets.take();
      try {
        const { channels: list } = await fetchChannels(serverId);
        setAppError(null);
        setChannels(list);
        channelListTickets.wrote(ticket);
        // A `channels-update` arrived while this was in flight, and its
        // refetch may have landed first: this list could be the older one.
        // Refetched only while this server is still the open one (see
        // `refreshChannelList`).
        if (
          !channelListTickets.isLatest(ticket) &&
          selectedServerIdRef.current === serverId
        ) {
          refreshChannelListRef.current(serverId);
        }
        void loadUnread(serverId);
        const server = serversRef.current.find((row) => row.id === serverId);
        const liveParty = liveParties
          ? pickLivePartyChannel(liveParties, list)
          : null;
        const land = liveParty
          ? { id: liveParty }
          : pickServerLandingTarget(
              list,
              communityHomeOn() && server?.communityHomeEnabled === true,
              server?.isCommunity === true,
            );
        if (land) {
          await selectChannel(land.id, serverId);
        } else {
          setSelectedChannelId(null);
          selectedChannelIdRef.current = null;
          syncRoute({ kind: "server", serverId }, null);
        }
      } catch (error) {
        const gone = error instanceof ApiError && error.status === 404;
        // This load's ticket silenced a `channels-update` refetch that was in
        // flight or waiting to retry, and now it failed too: start that
        // refetch again, or the change stays missing until a navigation.
        if (!gone && channelListTickets.owesUpdate(serverId, ticket)) {
          refreshChannelListRef.current(serverId);
        }
        setAppError(
          gone
            ? translateMessage("chrome.serverUnavailable")
            : error instanceof Error
              ? error.message
              : "Failed to load channels",
        );
      } finally {
        endChannelLoad(serverId);
        setChannelsLoading(false);
      }
    },
    [channelListTickets, communityHomeOn, loadUnread, selectChannel, syncRoute],
  );

  /**
   * A refusal from the API is thrown back to the dialog, which shows it under
   * the field and stays open. The page banner would sit behind the modal
   * overlay, where nobody reads it. Only what fails after the dialog closed
   * still goes to the banner.
   */
  async function handleChannelPromptConfirm(
    name: string,
    isPrivate?: boolean,
    topic?: string,
  ) {
    if (!channelPrompt) {
      return;
    }

    if (channelPrompt.mode === "create") {
      if (!selectedServerId || !channelPrompt.type) {
        throw new Error("Select a server before creating a channel");
      }
      const { channel } = await createChannel(
        selectedServerId,
        name,
        channelPrompt.type,
        isPrivate ?? channelPrompt.isPrivate ?? false,
        topic || undefined,
      );
      const next = [...channels, channel].sort(
        (a, b) => a.position - b.position,
      );
      channelListTickets.created(channel);
      setChannels(next);
      setAppError(null);
      setChannelPrompt(null);
      // A category is a grouping header, not a place to be — selecting it
      // would try to open a message pane for something that can never have
      // one.
      if (channel.type !== "category") {
        try {
          await selectChannel(channel.id);
        } catch (error) {
          setAppError(
            error instanceof Error ? error.message : "Channel action failed",
          );
          return;
        }
        if (channel.isPrivate) {
          setChannelSettings({
            channelId: channel.id,
            section: "permissions",
            forceAdvanced: false,
          });
        }
      }
      return;
    }

    if (channelPrompt.channel) {
      const { channel } = await updateChannel(channelPrompt.channel.id, {
        name,
      });
      setChannels((prev) =>
        prev.map((c) => (c.id === channel.id ? channel : c)),
      );
      setChannelPrompt(null);
      setAppError(null);
    }
  }

  async function handleDeleteChannel(channelId: string) {
    setPendingDeleteChannelId(channelId);
  }

  /**
   * The message list's multi-select, already confirmed there.
   *
   * The rows leave every open client through the `message-bulk-delete` frame,
   * this one included, so there is nothing to splice here, only a refusal to
   * surface. A silent failure would look exactly like a successful purge until
   * the next reload put a hundred messages back.
   */
  async function handleBulkDeleteSelected(messageIds: string[]) {
    try {
      await chat.bulkDeleteMessages(messageIds);
    } catch (error) {
      setAppError(
        error instanceof Error ? error.message : "Failed to delete messages",
      );
    }
  }

  /**
   * The channel menu's "clear recent messages", already confirmed in its own
   * dialog. Acts on whichever channel the menu was opened on, which is not
   * necessarily the open one.
   */
  async function handleBulkDeleteRecent(channelId: string, count: number) {
    try {
      await bulkDeleteMessages(channelId, { count });
    } catch (error) {
      setAppError(
        error instanceof Error ? error.message : "Failed to delete messages",
      );
    }
  }

  async function confirmDeleteChannel() {
    const channelId = pendingDeleteChannelId;
    if (!channelId) {
      return;
    }
    setPendingDeleteChannelId(null);
    try {
      await deleteChannel(channelId);
      channelListTickets.forget(channelId);
      // The server SETs NULL any channel's parent_id that pointed at what was
      // just deleted (a category going away uncategorizes its children rather
      // than taking them with it) — mirrored here, or those children keep a
      // parentId that resolves to nothing in this array and silently stop
      // rendering anywhere at all, in the top-level list or the category.
      const next = channels
        .filter((c) => c.id !== channelId)
        .map((c) =>
          c.parentId === channelId ? { ...c, parentId: null } : c,
        );
      setChannels(next);
      if (voiceState.voiceChannelId === channelId) {
        voice.leave();
      }
      if (selectedChannelId === channelId) {
        const fallback =
          next.find((c) => c.type === "text") ??
          next.find((c) => c.type !== "category");
        if (fallback) {
          await selectChannel(fallback.id);
        } else {
          setSelectedChannelId(null);
          selectedChannelIdRef.current = null;
        }
      }
    } catch (error) {
      setAppError(
        error instanceof Error ? error.message : "Failed to delete channel",
      );
    }
  }

  /**
   * Replaces the whole channel list from the response rather than splicing
   * locally — reordering touches every sibling in both the group a channel
   * joined and the one it left, and re-deriving that client-side is exactly
   * the kind of drift the delete-category fix above just caught. The server
   * already did the work; trust its answer.
   */
  async function handleMoveChannel(
    channelId: string,
    parentId: string | null,
    index: number,
  ) {
    try {
      const { channels: next } = await moveChannel(channelId, parentId, index);
      setChannels(next);
    } catch (error) {
      setAppError(
        error instanceof Error ? error.message : "Failed to move channel",
      );
    }
  }

  function handleFavoriteChannelIdsChange(ids: string[]) {
    if (!selectedServerId || !user) {
      return;
    }
    const next = writeFavoritesForServer(
      user.preferences?.favoriteChannels,
      selectedServerId,
      ids,
    );
    setUser((previous) =>
      previous
        ? {
            ...previous,
            preferences: { ...previous.preferences, favoriteChannels: next },
          }
        : previous,
    );
    queuePreferenceSync({ favoriteChannels: next }, { immediate: true });
  }

  const handlePinnedConversationsChange = useCallback((ids: string[]) => {
    setUser((previous) =>
      previous
        ? {
            ...previous,
            preferences: { ...previous.preferences, pinnedConversations: ids },
          }
        : previous,
    );
    queuePreferenceSync({ pinnedConversations: ids }, { immediate: true });
  }, []);

  function handleTogglePinnedConversation(channelId: string) {
    const stored = user?.preferences?.pinnedConversations;
    const current = conversationsLoading
      ? [...(stored ?? [])]
      : prunePinnedConversations(stored, conversations);
    if (isPinnedConversation(current, channelId)) {
      handlePinnedConversationsChange(
        removePinnedConversation(current, channelId),
      );
      return;
    }
    const next = addPinnedConversation(current, channelId);
    if (next.length === current.length) {
      setClaimedHandle(null);
      setAppNotice(
        t("chrome.pinConversationFull", { count: PINNED_CONVERSATIONS_MAX }),
      );
      return;
    }
    handlePinnedConversationsChange(next);
  }

  const closeWhatsNew = useCallback(() => setWhatsNewOpen(false), []);

  function handleOpenWhatsNew() {
    setDirectoryOpen(false);
    setWhatsNewOpen(true);
    rememberWhatsNewFeed();
    setWhatsNewUnread(false);
    rememberWhatsNew();
    setWantsWhatsNew(false);
    setMobileNavOpen(false);
  }

  const dropServer = useCallback(
    async (serverId: string) => {
      const nextServers = servers.filter((s) => s.id !== serverId);
      setServers(nextServers);
      // Hang up only if the call belongs to the server being dropped. `channels`
      // holds the *selected* server's channels, which is often a different one.
      if (voiceState.voiceChannelId && voiceServerIdRef.current === serverId) {
        voiceServerIdRef.current = null;
        voice.leave();
      }
      if (selectedServerId === serverId) {
        const next = nextServers[0];
        if (next) {
          setSelection({ kind: "server", serverId: next.id });
          await loadChannels(next.id);
        } else {
          setChannels([]);
          // The URL still names the server that just went away. Landing on the
          // conversations is both a valid place to be and the only one left.
          selectHome();
        }
      }
      setAppError(null);
    },
    [
      loadChannels,
      selectHome,
      selectedServerId,
      servers,
      voice,
      voiceState.voiceChannelId,
    ],
  );

  const dropServerRef = useRef(dropServer);
  dropServerRef.current = dropServer;

  async function handleLeaveServer(serverId: string) {
    setPendingLeaveServerId(serverId);
  }

  async function confirmLeaveServer() {
    const serverId = pendingLeaveServerId;
    if (!serverId) {
      return;
    }
    setPendingLeaveServerId(null);
    try {
      await leaveServer(serverId);
      await dropServer(serverId);
    } catch (error) {
      setAppError(
        error instanceof Error ? error.message : t("chrome.leaveFailed"),
      );
    }
  }

  /**
   * "Show this community on my profile", flipped from its own context menu.
   *
   * Written through to the server and then patched into the local list, rather
   * than refetched: `GET /api/servers` is the app's boot read and re-running it
   * to learn one boolean would repaint the whole rail. The switch is the
   * member's own and cannot fail for a permission reason, so the only failure
   * worth surfacing is the network one.
   */
  async function handleToggleProfileVisibility(
    serverId: string,
    showOnProfile: boolean,
  ) {
    try {
      await setProfileVisibility(serverId, showOnProfile);
      setServers((prev) =>
        prev.map((one) =>
          one.id === serverId ? { ...one, showOnProfile } : one,
        ),
      );
    } catch (error) {
      setAppError(
        error instanceof Error
          ? error.message
          : "Failed to update profile visibility",
      );
    }
  }

  /**
   * ICE is already fetched at session start. Refresh it in the background on
   * join so TURN credentials can rotate, but do not make the click wait on
   * another HTTP round-trip before the join cue and getUserMedia run.
   */
  function refreshIceServers() {
    void fetchIceServers()
      .then(({ iceServers }) => {
        if (iceServers.length > 0) {
          voice.setIceServers(iceServers);
        }
      })
      .catch(() => {
        // Keep previously fetched / default ICE servers
      });
  }

  /**
   * The server a call is about to be in, for everything that is decided per
   * server before the media connects. `share_fast_start_quality` is read the
   * moment the SFU's join response lands, so its answer is asked for here,
   * before the token request, rather than once the seat exists; a server
   * already asked about in the last ten minutes answers from the cache.
   */
  function noteCallServer(serverId: string | null) {
    voiceServerIdRef.current = serverId;
    setShareFastStartServer(serverId);
    prefetchShareGuardFlag(serverId);
  }

  async function handleJoinVoice(
    channelId: string,
    joinOptions?: { startMuted?: boolean },
  ) {
    noteCallServer(selectedServerId);
    refreshIceServers();
    // The funnel's "first thing a new account did": inert unless the wizard
    // finished in this tab, and once.
    trackFirstAction("arrival_first_voice");

    const current = voice.getState();
    const inCall = current.status !== "idle";
    const switching =
      inCall &&
      current.voiceChannelId !== null &&
      current.voiceChannelId !== channelId;
    if (switching && current.self && pendingVoiceMoves.includes(current.self.userId)) {
      return;
    }

    // A crowd is joined muted regardless of the preference; see join-muted.ts.
    // Already in a call: never pass startMuted, unless the caller forced it
    // (watch party go-live always mutes, mute-on-join setting or not).
    const occupantsAlreadyInRoom = current.occupancy[channelId]?.length ?? 0;
    const startMuted =
      joinOptions?.startMuted !== undefined
        ? joinOptions.startMuted
        : inCall
          ? undefined
          : shouldJoinMuted(
              localSettings.muteOnJoin,
              occupantsAlreadyInRoom,
            );
    await voice.join(channelId, {
      inputDeviceId: localSettings.inputDeviceId,
      inputVolume: localSettings.inputVolume,
      ...(startMuted !== undefined ? { startMuted } : {}),
      inputMode: localSettings.inputMode,
      vadThreshold: localSettings.vadThreshold,
      processing: localSettings.micProcessing,
    });
  }

  // ---------------------------------------------------- the watch party event

  /**
   * THE STREAMING NOTICE, RAISED WHERE IT CAN STILL CHANGE THE DECISION.
   *
   * It used to be raised by the share start, which in a watch party meant it
   * landed after "Ir ao vivo": the party was already live, the room had
   * already been told, and only then did the host read a notice about being
   * responsible for what they broadcast. That is the one moment the notice
   * exists for, and it arrived too late to inform anything.
   *
   * So it is raised here instead: the first time a host opens a draft setup
   * surface on a server that can go out as HLS. Nothing is being sent at that
   * point (that is the whole meaning of `draft`), so the host can read it,
   * and change their mind, at no cost to anybody.
   *
   * The share-start gate is untouched. Outside a watch party a share IS the
   * broadcast, so raising it there is still before anything goes out; and by
   * the time a watch party host presses Ir ao vivo the server already has
   * their ack, so `gateScreenShareStart` starts directly and nobody sees the
   * sheet twice.
   *
   * `askedRef` is per server and per session: `checkNeedsAck` is a request,
   * and re-firing it on every render of an open setup surface would be a poll.
   */
  const hlsHostAckAskedRef = useRef<string | null>(null);
  useEffect(() => {
    const serverId = selectedServerId;
    const party = selectedChannelId
      ? watchParties.byChannel[selectedChannelId]
      : undefined;
    const settingUp =
      party?.state === "draft" &&
      (party.viewerRole === "host" || party.viewerRole === "cohost");
    if (!serverId || !settingUp) {
      return;
    }
    // Only an explicit `false` means this server has no broadcast to
    // acknowledge. Null is "not answered yet" and waits rather than skipping
    // a disclosure by accident, which is the same rule the share gate uses.
    if (liveHlsConfig?.enabled === false) {
      return;
    }
    if (hlsHostAckAskedRef.current === serverId) {
      return;
    }
    hlsHostAckAskedRef.current = serverId;
    // NO `cancelled` FLAG AND NO CLEANUP, DELIBERATELY, AND THE OBVIOUS
    // VERSION OF THIS WAS BROKEN BY EXACTLY THAT.
    //
    // The effect's deps include the party map, which changes the moment the
    // draft is created: the optimistic write, then the server's broadcast. So
    // the effect tore down while `checkNeedsAck` was still in flight, its
    // cleanup set `cancelled`, the answer ("yes, they need to see it") was
    // thrown away, and the re-run hit the `askedRef` guard and never asked
    // again. The notice simply never appeared. `needs=true cancelled=true` in
    // the console was the whole story.
    //
    // A re-render is not a reason to discard the answer. The only thing worth
    // guarding is having navigated to a DIFFERENT server while the request was
    // out, which the ref below answers without fighting the render cycle.
    void hlsHostAck
      .checkNeedsAck(serverId)
      .then((needs) => {
        if (needs && selectedServerIdRef.current === serverId) {
          setHlsHostAck({ serverId, request: null });
        }
      })
      .catch(() => {
        // `checkNeedsAck` already fails open. Nothing to add.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServerId, selectedChannelId, watchParties.byChannel, liveHlsConfig]);

  /**
   * Seats die with the show. Watching is HLS; a leftover LiveKit
   * participant is leave-voice chrome after Encerrar. The host path
   * always `voice.leave()`s itself; this is the backstop for audience
   * seats when the stream dies, and for anybody still seated once the
   * party is over (including a mic that was handed out mid-show).
   */
  // When the current seat was taken, so the backstop below can tell a
  // `channel-live` that is merely late from a stream that ended. The rule is
  // `nextAudienceSeatClock`, where it can be tested: taking the stage is a new
  // seat even in a room this tab was already sitting in.
  const seatTakenAtRef = useRef<AudienceSeatClock | null>(null);
  const [seatGraceTick, setSeatGraceTick] = useState(0);
  useEffect(() => {
    seatTakenAtRef.current = nextAudienceSeatClock(seatTakenAtRef.current, {
      channelId: voiceState.voiceChannelId,
      isAudienceSeat: voiceState.isAudienceSeat,
      voiceStatus: voiceState.status,
      now: Date.now(),
    });
  }, [
    voiceState.isAudienceSeat,
    voiceState.status,
    voiceState.voiceChannelId,
  ]);
  useEffect(() => {
    const channelId = voiceState.voiceChannelId;
    if (!channelId || voiceState.status === "idle") {
      return;
    }
    const seated = channels.find((channel) => channel.id === channelId);
    const party = watchParties.byChannel[channelId];
    const partyState =
      party?.state === "draft" ||
      party?.state === "live" ||
      party?.state === "ended" ||
      party?.state === "cancelled"
        ? party.state
        : undefined;
    const live = voiceState.channelLive[channelId];
    const seatAgeMs = audienceSeatAgeMs(
      seatTakenAtRef.current,
      channelId,
      Date.now(),
    );
    if (
      !shouldReleaseAudienceWatchSeat({
        channelType: seated?.type,
        isAudienceSeat: voiceState.isAudienceSeat,
        isSharingScreen: voiceState.isSharingScreen,
        voiceStatus: voiceState.status,
        partyState,
        hasLiveStream: live?.stream != null,
        streamEnded: live?.streamEnded === true,
        seatAgeMs,
      })
    ) {
      // A seat inside its grace is not judged yet. Nothing else re-runs this
      // when the grace ends, so look again then with whatever has arrived.
      if (seatAgeMs !== null && seatAgeMs < AUDIENCE_SEAT_GRACE_MS) {
        const handle = window.setTimeout(
          () => setSeatGraceTick((tick) => tick + 1),
          AUDIENCE_SEAT_GRACE_MS - seatAgeMs + 50,
        );
        return () => window.clearTimeout(handle);
      }
      return;
    }
    voice.leave();
  }, [
    channels,
    seatGraceTick,
    voice,
    voiceState.channelLive,
    voiceState.isAudienceSeat,
    voiceState.isSharingScreen,
    voiceState.status,
    voiceState.voiceChannelId,
    watchParties.byChannel,
  ]);

  /**
   * A DRAFT THIS TAB MADE AND WALKED AWAY FROM IS CANCELLED (2026-09-18).
   *
   * A draft is visible only to its host and the create endpoint refuses
   * EVERYBODY while one is open, so an abandoned one is a server-wide lock
   * that nobody can see, open or end. Leaving its channel is the moment the
   * host stopped setting it up, and that is what this cancels.
   *
   * IT NEVER TOUCHES A DRAFT THIS TAB ONLY ADOPTED. `sessionDraftRef` is
   * armed by `handleCreateWatchParty` alone, so the party a host reloaded
   * into, or came back to from the sidebar's pending card, is theirs to hold
   * open for as long as they like — clicking through the server while a party
   * waits is the normal thing to do with one. `seen` is what keeps the
   * create's own await window from reading as walking away. Everything else
   * (scheduled, live, somebody else's) is refused by
   * `shouldAbandonWatchPartyDraft`; see `lib/watch-party-draft.ts`.
   */
  useEffect(() => {
    const watched = sessionDraftRef.current;
    const decision = decideDraftAbandon({
      watched,
      parties: Object.values(watchParties.byChannel),
      selectedChannelId,
    });
    if (decision.action === "wait") {
      return;
    }
    if (decision.action === "seen") {
      if (watched) {
        watched.seen = true;
      }
      return;
    }
    sessionDraftRef.current = null;
    if (decision.action === "abandon") {
      void abandonWatchPartyDraft(decision.party, {
        cancel: (partyId) => apiSetWatchPartyState(partyId, "cancelled"),
        forget: (channelId) => watchParties.apply(channelId, null),
      });
    }
  }, [selectedChannelId, watchParties.apply, watchParties.byChannel]);

  /**
   * A function rather than a `const` because these handlers are declared
   * above `selectedChannel`, and every one of them reads the party at the
   * moment it runs rather than at the moment it was defined.
   */
  function currentWatchParty(): WatchParty | null {
    return selectedChannelId
      ? (watchParties.byChannel[selectedChannelId] ?? null)
      : null;
  }

  /**
   * Start a party from the sidebar's one control.
   *
   * No channel is picked, named, or created by hand: the server finds or makes
   * the hidden room and opens the draft in it, and the client then selects
   * that room so the host lands straight on the setup surface. That is the
   * whole journey the old "make a watch_party channel, then find it in a
   * section, then press create" flow was hiding.
   *
   * CREATE AT MOST ONE, AND NEVER A SECOND OF THE HOST'S OWN (2026-09-18).
   * This used to POST unconditionally, which is how one channel collected six
   * `channel_sessions` rows in seventy minutes: a host who reloaded, opened a
   * second tab, or pressed the button again because the first click looked
   * inert asked for another party, and the one they already had is invisible
   * to everybody else while it locks the server's only party slot. The
   * decision now lives in `startWatchParty` (`lib/watch-party-draft.ts`) so it
   * is testable without mounting this component, the same split
   * `endWatchParty` uses; this is only the wiring.
   */
  async function handleCreateWatchParty(input: {
    name: string;
    startsAt: string | null;
  }) {
    const serverId = selectedServerId;
    if (!serverId) {
      return;
    }
    const result = await startWatchParty(
      { name: input.name, startsAt: input.startsAt },
      {
        serverId,
        known: Object.values(watchParties.byChannel),
        create: (id, body) => apiCreateServerWatchParty(id, body),
        reload: (id) =>
          apiFetchServerWatchParties(id).then((answer) => answer.parties),
        busyMessage: t("watchParty.create.busy"),
        busyNamedMessage: (name) => t("watchParty.create.busyNamed", { name }),
      },
    );
    if (result.kind === "attached") {
      // Their own draft or scheduled party. Nothing was created; put it back
      // in the store in case the 409 recovery is what found it, and open it.
      watchParties.put(result.party);
      await selectChannel(result.party.channelId);
      return;
    }
    const { party, channel } = result;
    if (party) {
      // The broadcast is on its way, but a draft reaches only the host and
      // co-hosts and this client is the host: applying the answer now is what
      // makes the setup surface appear on the same click.
      watchParties.put(party);
      // B7 (2026-09-12 postmortem): a stale 1080p opt-in from a PREVIOUS
      // party must not silently reapply to this one. Scoped to this account
      // (`watch-party-stream-quality.ts`), so it never touches another
      // account sharing the same browser.
      resetWatchPartyStreamQualityForNewParty(user?.id ?? null);
    }
    // The room may have just been created, so it has to go into the channel
    // list before it can be selected, even though the sidebar will not draw
    // it. Selecting a channel the client cannot resolve is a blank pane on
    // the very click that starts the party.
    if (!channels.some((existing) => existing.id === channel.id)) {
      setChannels(
        [...channels, channel].sort((a, b) => a.position - b.position),
      );
    }
    await selectChannel(channel.id);
    if (party && party.state === "draft") {
      sessionDraftRef.current = { partyId: party.id, seen: false };
    }
  }

  /**
   * Wait for the room to actually be connected before publishing.
   *
   * `voice.join` resolves when the join has been sent, not when the media
   * session is up, and `startScreenShare` refuses on anything but
   * `connected`. Without this the very first watch party a host runs goes
   * live with no picture and no error, which is precisely the failure this
   * whole surface exists to stop.
   */
  async function waitForVoiceConnected(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (voice.getState().status === "connected") {
        return true;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
    return false;
  }

  /**
   * THE GO-LIVE SHARE'S LAST STEP, WHEREVER IT LANDS (Farol, 2026-09-14).
   * `startScreenShareGated` has two ways to resolve `"started"`: at once, or
   * after the disclosure sheet a host's FIRST ever HLS-capable share raises
   * (`HlsHostAckSheet`). The immediate route used to be the only one that
   * ever reached the mic prompt; a go-live share stalled behind the sheet
   * resolved to `wentOut === false` on the spot (the gate only reports
   * "asked", not the eventual outcome) and nothing downstream ever
   * finished the handoff once the host confirmed and the capture actually
   * started. Both routes call this now, so the prompt arms exactly once,
   * only on a share that genuinely went out, regardless of which one got
   * there.
   *
   * TAKES `partyId` AND `channelId` RATHER THAN RE-READING
   * `currentWatchParty()` (Farol, 2026-09-14, round two). The disclosure
   * sheet can sit open for as long as a host takes to read it, and the
   * selected channel is free to change in that window; resolving "the
   * party" at completion time would arm the prompt for whatever party
   * happens to be on screen when the sheet is confirmed, not the one that
   * actually asked for the share. Both callers pass the ids they captured
   * when the share was FIRST requested.
   *
   * LOOKS THE PARTY UP FRESH AND BAILS QUIETLY IF IT IS GONE (Farol,
   * 2026-09-14, round three). Carrying the id past the disclosure sheet
   * fixed "the wrong party" — it does not fix "no party at all": the sheet
   * can sit open long enough for the party to end on its own (the host
   * closes it from another tab, the five-minute grace sweep times it out).
   * A `MediaStream` publishing into a room that has moved on is not this
   * function's problem to solve; not asking a now-nonexistent party's
   * absent audience to hear an unmuted mic is. `decideGoLiveMicPrompt`
   * (`lib/watch-party-go-live.ts`) is the actual decision, pure and unit
   * tested; this is only the wiring — the fresh lookup and the one thing a
   * pure function cannot do, showing the dialog.
   */
  function finishWatchPartyGoLiveShare(
    partyId: string,
    channelId: string,
    wentOut: boolean,
  ) {
    const decision = decideGoLiveMicPrompt({
      wentOut,
      requestedPartyId: partyId,
      // `current`, NOT `byChannel`: this runs after the go-live's awaits, and
      // the closure it was called from holds the render from BEFORE that
      // go-live's own `put`, where the party is still a draft. Read that way
      // every immediate go-live was "party-gone" and the mic prompt never
      // armed (production rehearsal C, 2026-09-25).
      party: watchParties.current(channelId),
      isMuted: voice.getState().isMuted,
    });
    if (!decision.arm) {
      if (decision.reason === "party-gone") {
        console.warn(
          "[watch-party] go-live mic handoff skipped: party no longer live",
          { partyId, channelId },
        );
      }
      return;
    }
    setMicPromptPartyId(partyId);
  }

  /**
   * Ir ao vivo. One press, three things, in this order and no other:
   *
   * 1. the party's state changes, so the room's sidebar gets the block;
   * 2. the host takes a seat in the voice room, because a presenter is a
   *    participant;
   * 3. the capture they already approved goes on the stage.
   *
   * The state change goes first on purpose. If the share fails (they cancel,
   * the OS refuses), the party is live with nothing on screen, and the panel
   * says so in words to everyone. The other order would leave a picture going
   * out from a party the room has never been told about.
   */
  async function handleWatchPartyGoLive(
    stream: MediaStream | null,
    lowLatency: boolean,
  ) {
    const party = currentWatchParty();
    if (!party) {
      return;
    }
    try {
      // The host's standing "Baixa latência (beta)" preference only reaches
      // the server at THIS moment: `goLive` is the one write
      // `requestedHlsModeForChannel` ever reads, so a party going live again
      // always states its own request rather than inheriting whatever the
      // last one asked for. `lowLatency` is a PARAMETER, not re-read from
      // `currentWatchParty()` here: this function's own await below means
      // whatever runs after it can be reached with a different channel
      // selected (Farol review, third round), and `currentWatchParty()`
      // answers for the SELECTED channel, not necessarily the party this
      // press was for. The caller (`watch-party-panel.tsx`) already has the
      // right `party.options.lowLatency` in its own props at the moment of
      // the click, which is the only copy of this value that is ever
      // correct for this specific go-live.
      const answer = await apiSetWatchPartyState(party.id, "live", lowLatency);
      if (answer.party) {
        watchParties.put(answer.party);
      }
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      setAppError(
        error instanceof Error ? error.message : "Could not go live",
      );
      return;
    }
    if (voice.getState().voiceChannelId !== party.channelId) {
      // Always muted: Ir ao vivo should not blast the host's mic into the
      // party, whatever mute-on-join is set to.
      await handleJoinVoice(party.channelId, { startMuted: true });
    }
    if (!stream) {
      return;
    }
    if (!(await waitForVoiceConnected())) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    // `false` is the system-audio opt-in, not "has an audio track". Tab audio
    // still rides on the already-captured stream; passing track count here
    // used to look like an opt-in to whole-computer sound. `preferBrowserTab`
    // matches the setup picker so a retry without a handed stream stays on
    // the echo-safe path.
    //
    // THE MIC PROMPT WAITS FOR THE SHARE TO ACTUALLY LAND (Farol, 2026-09-14).
    // This used to arm the moment the share was ASKED for, so a host who
    // cancelled the picker or had the OS refuse the capture still got "Ativar
    // o mic?" for a broadcast that never started. `finishWatchPartyGoLiveShare`
    // is also what the disclosure-sheet route below calls once IT knows the
    // outcome, so the two routes end in the same transition; `party` rides
    // on the intent so that route still has both ids after the sheet closes.
    const wentOut = await startScreenShareGated(false, {
      preferBrowserTab: true,
      watchParty: true,
      stream,
      party: { id: party.id, channelId: party.channelId },
    });
    finishWatchPartyGoLiveShare(party.id, party.channelId, wentOut);
  }

  /**
   * The bell on the scheduled screen. A party IS a channel session, so this
   * is the same row the session card toggles; the store is patched so the
   * button reads right on the next render without a refetch.
   */
  async function handleWatchPartyReminder(wants: boolean) {
    const party = currentWatchParty();
    if (!party) {
      return;
    }
    await setChannelSessionReminder(party.id, wants);
    // Patch, do not put: the party may have gone live or been renamed while
    // the request was out, and the snapshot captured above would undo that.
    watchParties.patch(party.id, { reminding: wants });
  }

  /**
   * A live party with nothing on screen, and the host pressing the button
   * that puts something there. Same road as going live minus the state
   * change: join the room if needed, wait for it, open the picker through
   * the gate every share uses.
   */
  async function handleWatchPartyShareScreen() {
    const party = currentWatchParty();
    if (!party) {
      return;
    }
    try {
      if (voice.getState().voiceChannelId !== party.channelId) {
        await handleJoinVoice(party.channelId);
      }
      if (!(await waitForVoiceConnected())) {
        return;
      }
    } catch (error) {
      setAppError(
        error instanceof Error ? error.message : "Could not share the screen",
      );
      return;
    }
    // The room can change under those awaits. A host who moved to another
    // channel or another call meanwhile gets no picker for a party they are
    // no longer in; the share would land in whatever room is current.
    if (
      voice.getState().voiceChannelId !== party.channelId ||
      selectedChannelIdRef.current !== party.channelId
    ) {
      return;
    }
    startScreenShareGated(false, { preferBrowserTab: true, watchParty: true });
  }

  async function handleWatchPartyStopShare() {
    await voice.stopScreenShare();
  }

  /** Trocar: the old share comes down first, then the picker. */
  async function handleWatchPartyReplaceShare() {
    await voice.stopScreenShare();
    await handleWatchPartyShareScreen();
  }

  /**
   * Encerrar. The decision itself lives in `endWatchParty`
   * (`lib/watch-party-end.ts`, B8 of the 2026-09-12 postmortem) so it is
   * testable without mounting this component; this is only the wiring.
   */
  async function handleWatchPartyEnd() {
    const party = currentWatchParty();
    if (!party) {
      return;
    }
    await endWatchParty(party, {
      setEnded: (partyId) => apiSetWatchPartyState(partyId, "ended"),
      applyParty: (channelId, next) => watchParties.apply(channelId, next),
      refresh: watchParties.refresh,
      fetchCurrentParty: (channelId) =>
        apiFetchChannelWatchParty(channelId).then((answer) => answer.party),
      reportError: (message) => setAppError(message),
      isSharingScreen: () => voice.getState().isSharingScreen,
      stopScreenShare: () => voice.stopScreenShare(),
      currentVoiceChannelId: () => voice.getState().voiceChannelId,
      leaveVoice: () => voice.leave(),
      fallbackErrorMessage: t("watchParty.live.endFailed"),
    });
  }

  /**
   * The host calling it off by hand. Same path the abandon effect takes, and
   * for the same reason it swallows the failure: every way a cancel can fail
   * (a sweep got there first, it already moved, the tab is offline) has the
   * one right answer, which is to stop showing a party the host has already
   * finished with. It used to throw straight out of the click handler.
   */
  async function handleWatchPartyDiscard() {
    const party = currentWatchParty();
    if (!party) {
      return;
    }
    sessionDraftRef.current = null;
    await abandonWatchPartyDraft(party, {
      cancel: (partyId) => apiSetWatchPartyState(partyId, "cancelled"),
      forget: (channelId) => watchParties.apply(channelId, null),
    });
  }

  async function handleWatchPartyOptions(options: Partial<WatchPartyOptions>) {
    const party = currentWatchParty();
    if (!party) {
      return;
    }
    // Optimistic: a select that snaps back while the request is in flight
    // reads as a broken control.
    watchParties.put({ ...party, options: { ...party.options, ...options } });
    const answer = await apiUpdateWatchParty(party.id, { options });
    if (answer.party) {
      watchParties.put(answer.party);
    }
  }

  async function handleWatchPartyRename(name: string) {
    const party = currentWatchParty();
    if (!party) {
      return;
    }
    const answer = await apiUpdateWatchParty(party.id, { name });
    if (answer.party) {
      watchParties.put(answer.party);
    }
  }

  /**
   * Give a draft a time, or take it away. The server does the state move
   * (`draft -> scheduled` on a time, `scheduled -> draft` on null), so this
   * is the same PATCH as a rename with a different field. The setup card's
   * "Quando" row is the only caller; the create dialog still sets a time at
   * creation the way it always did.
   */
  async function handleWatchPartySchedule(startsAt: string | null) {
    const party = currentWatchParty();
    if (!party) {
      return;
    }
    const answer = await apiUpdateWatchParty(party.id, { startsAt });
    // A rejected PATCH already throws (`apiFetch`); a 200 that somehow
    // carries no party is the same failure in a different shape, and both
    // have to reach the caller the same way. The setup card's Salvar button
    // is what awaits this (Farol, 2026-09-14) and shows its own inline
    // error, so this function does not also swallow the rejection into a
    // global toast: one place says what went wrong, next to the control
    // that asked.
    if (!answer.party) {
      throw new Error("Could not save the time");
    }
    watchParties.put(answer.party);
  }

  /**
   * Take a seat in a watch party's room WITHOUT a microphone.
   *
   * The default for anybody who is not running the show. `audienceOnly` opens
   * no `getUserMedia` at all, so there is no prompt, no device and no "entrou
   * sem microfone" banner: nothing was asked for, so nothing was refused.
   * `voice.takeTheMicrophone()` is the deliberate second act.
   */
  function handleWatchPartyJoinAsAudience(channelId: string) {
    // Same rule as any other seat: a docked stream from another room is lost
    // by taking one, so it is asked about before it happens.
    guardVoiceJoin(channelId, () => joinWatchPartyAsAudience(channelId));
  }

  async function joinWatchPartyAsAudience(channelId: string) {
    noteCallServer(selectedServerId);
    await voice.join(channelId, {
      inputDeviceId: localSettings.inputDeviceId,
      inputVolume: localSettings.inputVolume,
      inputMode: localSettings.inputMode,
      vadThreshold: localSettings.vadThreshold,
      processing: localSettings.micProcessing,
      audienceOnly: true,
    });
  }

  async function handleWatchPartyStage(
    action: "invite" | "remove" | "raise" | "lower",
    userId?: string,
  ) {
    const party = currentWatchParty();
    if (!party) {
      return;
    }
    const answer = await setWatchPartyStage(
      party.id,
      action === "invite" || action === "remove"
        ? { action, userId: userId! }
        : { action },
    );
    if (answer.party) {
      watchParties.put(answer.party);
    }
  }

  /**
   * CONVIDADOS: every guest action but `join`, which has its own flow right
   * below (`handleWatchPartyGuestGoOnAir`) because going on air is not just a
   * route call — it stops the player and opens the room first (§3.4).
   */
  /**
   * `channelId` is optional and, when given, wins over the currently
   * selected channel — the go-on-air/go-off-air flows below capture it
   * BEFORE their own awaits (a mic prompt, a room join) specifically so a
   * channel switch mid-flight sends the action to the party that was
   * actually joined, not whatever the user has since navigated to.
   */
  async function handleWatchPartyGuestAction(
    action: GuestAction,
    channelId?: string,
  ) {
    const party = channelId
      ? (watchParties.byChannel[channelId] ?? null)
      : currentWatchParty();
    if (!party) {
      return;
    }
    const answer = await setWatchPartyGuestAction(party.id, action);
    if (answer.party) {
      watchParties.put(answer.party);
    }
  }

  /**
   * `Entrar no ar`. THE SERVER SAYS YES FIRST, THEN THE ROOM. `mayGoOnAir`
   * (both the client's read of it and `join-voice-room`'s own check) only
   * lets an ACCEPTED guest in — `accepted_at IS NOT NULL` — and the guest
   * `join` HTTP action is the one write that sets it, inside the transaction
   * that also enforces `WATCH_PARTY_MAX_GUESTS`. Calling `voice.join` before
   * that action lands asks the room to seat somebody the server does not yet
   * consider a guest, which it correctly refuses
   * (`voice.watchPartySeatRefused`) — every real join through this path used
   * to fail invisibly on the very race it was written to handle (the
   * invitation confirmed a beat after the room was asked for). So: the HTTP
   * `join` first, which is also where the invitation-expired/cap-full errors
   * surface with nobody's microphone open yet; only once the server has
   * actually accepted this browser does it ask for the room.
   *
   * ROLLED BACK ON EITHER FAILURE. A `join` action that throws never reaches
   * `voice.join` at all — nothing to roll back. A `voice.join` that fails
   * AFTER the server accepted this guest (mic/camera refused, a room error)
   * leaves the row `accepted_at`-set with nobody connected to it, so that
   * path calls the guest `leave` action to undo it, best-effort, before the
   * original error is re-thrown to the caller (the invite dialog keeps
   * itself open on a failure it is told about). A `leave` that ALSO fails
   * here is not silently dropped: the guest's own next disconnect and the
   * ordinary voice-seat reconciliation still clear a row nobody is holding,
   * so this is a UX rollback, not the only backstop.
   */
  async function handleWatchPartyGuestGoOnAir(channelId: string) {
    await handleWatchPartyGuestAction({ action: "join" }, channelId);
    try {
      noteCallServer(selectedServerId);
      await voice.join(channelId, {
        inputDeviceId: localSettings.inputDeviceId,
        inputVolume: localSettings.inputVolume,
        inputMode: localSettings.inputMode,
        vadThreshold: localSettings.vadThreshold,
        processing: localSettings.micProcessing,
      });
    } catch (err) {
      try {
        await handleWatchPartyGuestAction({ action: "leave" }, channelId);
      } catch (rollbackErr) {
        console.error(
          "[watch-party] could not roll back an accepted guest slot after voice.join failed:",
          rollbackErr,
        );
      }
      throw err;
    }
  }

  /**
   * `Sair do ar`. Tell the party first, then leave — same order `onLeaveSeat`
   * uses elsewhere — but `voice.leave()` runs in `finally`: a rejected
   * `leave` action (a timeout, a dropped connection) must not strand the
   * guest connected and transmitting just because the server never heard
   * about it. The server-side row is cleaned up independently by the
   * client's own eventual disconnect and the orphan sweep either way.
   */
  async function handleWatchPartyGuestGoOffAir(channelId: string) {
    try {
      await handleWatchPartyGuestAction({ action: "leave" }, channelId);
    } finally {
      voice.leave();
    }
  }

  const presentingPartyId =
    currentWatchParty()?.channelId === voiceState.voiceChannelId &&
    voiceState.isSharingScreen
      ? currentWatchParty()?.id
      : null;
  const presentingPartyGuests = presentingPartyId
    ? currentWatchParty()?.options.guests
    : undefined;
  const presentingPartyOnAirKey = presentingPartyId
    ? (currentWatchParty()?.guests.onAir.map((p) => p.userId).join(",") ?? "")
    : "";
  /**
   * CONVIDADOS §5.2: tell `use-voice.ts`'s mixer what to carry, whenever a
   * party's `guests` or `guests.onAir` changes for the channel THIS BROWSER
   * IS PRESENTING. A no-op for anyone else — every other tab, every ordinary
   * voice channel, gets `setWatchPartyGuests("off", [])`, which is what the
   * mixer already treats as "carry nothing".
   */
  useEffect(() => {
    if (!presentingPartyId || presentingPartyGuests === undefined) {
      voice.setWatchPartyGuests("off", []);
      return;
    }
    const onAirUserIds = presentingPartyOnAirKey
      ? presentingPartyOnAirKey.split(",")
      : [];
    voice.setWatchPartyGuests(presentingPartyGuests, onAirUserIds);
  }, [presentingPartyId, presentingPartyGuests, presentingPartyOnAirKey, voice]);

  /**
   * Promote or demote a co-host.
   *
   * THE CALLER `setWatchPartyCohost` NEVER HAD. The route, the table and this
   * client wrapper all shipped and nothing ever invoked them, so the co-host
   * role was unreachable and the takeover with it: Assumir renders for
   * `role === "cohost"` and there was no way to become one.
   * `docs/WATCH_PARTY.md` has the full account of what that does and does not
   * fix, and the short version is that it does not save the picture.
   *
   * The answer is applied even though `watch-party-update` is also coming: the
   * broadcast is resolved per recipient and the round trip is what the button
   * is already waiting on, so applying it here is what makes the row move on
   * the same press rather than a frame later.
   */
  async function handleWatchPartyCohost(userId: string, cohost: boolean) {
    const party = currentWatchParty();
    if (!party) {
      return;
    }
    const answer = await apiSetWatchPartyCohost(party.id, userId, cohost);
    if (answer.party) {
      watchParties.put(answer.party);
    }
  }

  async function handleWatchPartyClaimHost() {
    const party = currentWatchParty();
    if (!party) {
      return;
    }
    const answer = await apiClaimWatchPartyHost(party.id);
    if (answer.party) {
      watchParties.put(answer.party);
    }
  }

  /**
   * The sidebar's live block, and the one-click entry Rafael could not get.
   *
   * Selecting the channel IS watching: `WatchChannelStage` mounts on the
   * selected channel and plays the HLS stream without a seat, without a
   * microphone prompt and without a second click. Joining the call is a
   * separate button on the stage.
   */
  async function handleWatchLiveParty(channelId: string) {
    // THE ROOM MAY BE ONE THIS CLIENT HAS NEVER HEARD OF. It is created on
    // demand by whoever starts the party and it is never listed, so a viewer
    // who loaded the app before the party existed has no such channel in
    // `channels` and selecting it lands on "Escolha um canal". One refetch
    // fixes it for everybody arriving mid-party, which is most of an
    // audience.
    if (!channels.some((existing) => existing.id === channelId)) {
      const serverId = selectedServerId;
      if (serverId) {
        try {
          const { channels: list } = await fetchChannels(serverId);
          setChannels(list);
        } catch {
          // Nothing to add: the select below will simply do nothing, which is
          // the same as the click not having landed.
        }
      }
    }
    await selectChannel(channelId);
  }

  /**
   * A SEAT COSTS THE FILM, SO ASK FIRST.
   *
   * Joining a voice room is joining THAT room: the docked stream belongs to
   * another one and the mini player goes with it. Somebody halfway through a
   * watch party should not lose it to a click on a channel row they meant as
   * navigation. Only asked while a stream is actually docked and playing
   * (`dockedChannelId`), and never for the room being watched, where the
   * stage takes the picture back anyway. Everything else keeps today's
   * behaviour: no dialog, no extra click.
   */
  function guardVoiceJoin(
    channelId: string,
    run: () => Promise<void> | void,
  ) {
    joinGuard.guard(channelId, run);
  }

  /**
   * The mini player's way home.
   *
   * Same server: an ordinary channel select, which is all the stage needs to
   * take the picture back (the surface is never remounted, so there is nothing
   * to reload). Another server: the route applier, because the channel is not
   * in `channels` any more and switching the rail is its job, not this one's.
   */
  function returnToWatchChannel() {
    const session = watchDock.session;
    if (!session) {
      return;
    }
    if (
      session.serverId &&
      !(selection.kind === "server" && selection.serverId === session.serverId)
    ) {
      void applyChannelRoute(session.serverId, session.channelId);
      return;
    }
    void selectChannel(session.channelId, session.serverId ?? undefined);
  }

  /** Sidebar: open the channel and join, unless already in it. */
  function handleJoinVoiceFromList(channelId: string) {
    void selectChannel(channelId);
    const listed = channels.find((channel) => channel.id === channelId);
    if (listed && isWatchPartyChannelType(listed.type)) {
      // Watching is select + HLS. Seating is host go-live / the party bar.
      return;
    }
    if (
      voiceState.voiceChannelId === channelId &&
      voiceState.status !== "idle"
    ) {
      return;
    }
    guardVoiceJoin(channelId, () => handleJoinVoice(channelId));
  }

  /**
   * The watch-now strip's one button. `docs/plans/WATCH_NOW.md` §"The button".
   *
   * A watch party is watched by OPENING it, which takes no seat. A share in a
   * voice channel is opened and joined as an audience seat: no microphone and
   * no permission prompt (an invited stranger's first sentence in the app
   * should not be a browser dialog), the camera off as it always starts.
   * Already seated, the button is a way back and joins nothing. Nobody is ever
   * joined without this tap.
   */
  function handleWatchNowWatch(stream: WatchNowStream) {
    setWatchNowFailure(null);
    watchNowSawJoin.current = false;
    if (stream.kind === "party") {
      void handleWatchLiveParty(stream.channelId);
      return;
    }
    if (stream.kind === "call") {
      if (stream.inRoom) {
        // Already seated: a way back to the conversation, never a rejoin
        // (which would rebuild the mesh under everybody in the call).
        void selectConversation(stream.channelId);
        return;
      }
      setWatchNowJoining(stream.channelId);
      void handleConversationCall(stream.channelId, false, false, true);
      return;
    }
    void selectChannel(stream.channelId);
    if (stream.inRoom) {
      return;
    }
    setWatchNowJoining(stream.channelId);
    guardVoiceJoin(stream.channelId, () =>
      joinWatchPartyAsAudience(stream.channelId),
    );
  }

  function voiceModerationError(err: unknown, fallback: string): string {
    return err instanceof ApiError ? err.message : fallback;
  }

  async function handleMoveVoiceOccupant(userId: string, channelId: string) {
    if (!selectedServerId || pendingVoiceMoves.includes(userId)) {
      return;
    }
    const snapshot = cloneVoiceOccupancy(voice.getState().occupancy);
    const { next } = moveOccupantSeat(snapshot, userId, channelId);
    voice.replaceOccupancy(next);
    setPendingVoiceMoves((ids) =>
      ids.includes(userId) ? ids : [...ids, userId],
    );
    try {
      await moveMemberVoice(selectedServerId, userId, channelId);
    } catch (err) {
      voice.replaceOccupancy(snapshot);
      setAppError(voiceModerationError(err, t("member.moveFailed")));
    } finally {
      setPendingVoiceMoves((ids) => ids.filter((id) => id !== userId));
    }
  }

  async function handleDisconnectVoiceOccupant(userId: string) {
    if (!selectedServerId) {
      return;
    }
    try {
      await disconnectMemberVoice(selectedServerId, userId);
    } catch (err) {
      setAppError(voiceModerationError(err, t("member.disconnectFailed")));
    }
  }

  async function handleServerMuteOccupant(userId: string, muted: boolean) {
    if (!selectedServerId) {
      return;
    }
    try {
      await setMemberVoiceMuted(selectedServerId, userId, muted);
    } catch (err) {
      setAppError(voiceModerationError(err, t("member.muteFailed")));
    }
  }

  /**
   * Lower somebody else's hand: "you're up". Behind
   * `Permission.MUTE_MEMBERS` in that channel, the same bit the other voice
   * moderation actions use, and the server checks it again.
   */
  // --- audience mode ("Modo plateia", docs/plans/AUDIENCE_MODE.md) ---
  // The operator's flag for the open server, the request in flight, and what
  // the media server did with the host's last change (who is still audible),
  // which the strip shows until the room's own state says otherwise.
  const voiceConfig = useVoiceConfig(selectedServerId);
  const [audienceBusy, setAudienceBusy] = useState(false);
  // Tied to the call and the session it answered for, so a warning from one
  // call is never drawn over the next one.
  const [audienceEnforcement, setAudienceEnforcement] = useState<{
    channelId: string;
    since: number | null;
    enforcement: VoiceAudienceEnforcement;
  } | null>(null);

  async function handleToggleAudienceMode() {
    const channelId = voice.getState().voiceChannelId;
    if (!channelId || audienceBusy) {
      return;
    }
    setAudienceBusy(true);
    try {
      const answer = await setVoiceAudienceMode(
        channelId,
        voice.getState().audience === null,
      );
      setAudienceEnforcement({
        channelId,
        since: answer.audience?.since ?? null,
        enforcement: answer.enforcement,
      });
    } catch (err) {
      setAppError(voiceModerationError(err, t("voice.audience.failed")));
    } finally {
      setAudienceBusy(false);
    }
  }

  async function handleAudienceSpeaker(userId: string, allowed: boolean) {
    const channelId = voice.getState().voiceChannelId;
    if (!channelId || audienceBusy) {
      return;
    }
    setAudienceBusy(true);
    try {
      const answer = await setVoiceAudienceSpeaker(channelId, userId, allowed);
      setAudienceEnforcement({
        channelId,
        since: answer.audience?.since ?? null,
        enforcement: answer.enforcement,
      });
    } catch (err) {
      setAppError(voiceModerationError(err, t("voice.audience.speakerFailed")));
    } finally {
      setAudienceBusy(false);
    }
  }

  /**
   * The host's half of audience mode for the call in this voice channel, or
   * null for anybody who does not run the stage (`MUTE_MEMBERS` or
   * `MANAGE_CHANNELS` here; the server checks the same bits). Never in a
   * watch party or a conversation call.
   */
  function audienceHostFor(channel: { id: string; type: string }): AudienceModeHostControls | null {
    if (
      channel.type !== "voice" ||
      voiceState.voiceChannelId !== channel.id ||
      !(
        perms.can(Permission.MUTE_MEMBERS, channel.id) ||
        perms.can(Permission.MANAGE_CHANNELS, channel.id)
      )
    ) {
      return null;
    }
    return {
      available: voiceConfig.audienceMode === true,
      busy: audienceBusy,
      onToggle: () => void handleToggleAudienceMode(),
      onAllow: (userId) => void handleAudienceSpeaker(userId, true),
      onSilence: (userId) => void handleAudienceSpeaker(userId, false),
      enforcement:
        voiceState.audience &&
        audienceEnforcement?.channelId === channel.id &&
        audienceEnforcement.since === voiceState.audience.since
          ? audienceEnforcement.enforcement
          : null,
    };
  }

  async function handleLowerOccupantHand(userId: string) {
    if (!selectedServerId) {
      return;
    }
    try {
      await lowerMemberVoiceHand(selectedServerId, userId);
    } catch (err) {
      setAppError(voiceModerationError(err, t("member.muteFailed")));
    }
  }

  async function handleKickOccupant(userId: string, name: string) {
    if (!selectedServerId) {
      return;
    }
    if (!window.confirm(t("profile.mod.kick.title", { name }))) {
      return;
    }
    try {
      await kickMember(selectedServerId, userId);
    } catch (err) {
      setAppError(voiceModerationError(err, t("member.removeFailed")));
    }
  }

  function canKickOccupant(userId: string): boolean {
    if (!moderationBits.kick || !user) {
      return false;
    }
    const actor = serverMembers.find((row) => row.id === user.id);
    const target = serverMembers.find((row) => row.id === userId);
    if (!target) {
      return false;
    }
    if (!actor) {
      return (
        (selectedServer?.role === "owner" ||
          selectedServer?.role === "admin") &&
        target.role === "member"
      );
    }
    return canActOnMemberClient(
      actor,
      target,
      serverRoles.map((entry) => ({
        id: entry.id,
        position: entry.position,
        permissions: entry.permissions,
        systemKey: entry.systemKey,
      })),
      user.id,
      userId,
    );
  }

  // --- conversation calls ---------------------------------------------------

  /**
   * Enter a conversation's call. `ring: true` is a fresh call (the absent
   * participants get an incoming-call surface); `ring: false` joins one that
   * is already live, or answers one that is ringing us — in both of those the
   * server has nobody new to tell. Always navigates there first so the call
   * stage is on screen while it connects.
   *
   * `withVideo` arms the camera for this join: the voice controller only
   * captures video through its own `toggleCamera`, and only once connected, so
   * "start a video call" is recorded here and the effect below flips the
   * camera on the moment the join reports connected. Deliberately not a change
   * to `use-voice` — the camera still has exactly one on-switch.
   */
  async function handleConversationCall(
    channelId: string,
    ring: boolean,
    withVideo = false,
    /**
     * Join to WATCH a share (the watch-now strip): an audience seat, so no
     * microphone is opened and nothing is asked of the person. Pressing the
     * mic later is how they start talking, as on any audience seat.
     */
    watchOnly = false,
  ) {
    voiceServerIdRef.current = null;
    pendingVideoCallRef.current = withVideo ? channelId : null;
    void selectConversation(channelId);
    refreshIceServers();
    const options = {
      inputDeviceId: localSettings.inputDeviceId,
      inputVolume: localSettings.inputVolume,
      startMuted: localSettings.muteOnJoin,
      inputMode: localSettings.inputMode,
      vadThreshold: localSettings.vadThreshold,
      processing: localSettings.micProcessing,
      ...(watchOnly ? { audienceOnly: true } : {}),
    };
    if (ring) {
      await voice.joinConversationCall(channelId, options);
    } else {
      await voice.acceptIncomingCall(channelId, options);
    }
  }

  /** The sidebar phone button: join a live call, otherwise start ringing. */
  function handleStartConversationCall(channelId: string) {
    const state = voice.getState();
    // Already in THIS call: the phone is a way back to the conversation, not a
    // rejoin. Joining a room you are in is not an error — the server drops the
    // socket's old peer and admits the new one — but it tears down the mesh and
    // builds it again, which everybody else in the call hears. The profile
    // card's phone made this reachable in one click, so it is guarded here,
    // where the channel id is known, rather than in the card.
    if (state.voiceChannelId === channelId && state.status !== "idle") {
      void selectConversation(channelId);
      return;
    }
    const live = (state.occupancy[channelId] ?? []).length > 0;
    void handleConversationCall(channelId, !live);
  }

  function handleAudioSettingsLive(next: LocalSettings) {
    const prevDeviceId = localSettings.inputDeviceId;
    setLocalSettings(next);
    saveLocalSettings(next);
    voice.setInputVolume(next.inputVolume);
    // Applied whatever the call status: the mode is what a later join starts
    // in, and switching it mid-call only flips `track.enabled`, so there is no
    // reason to defer it and no risk of interrupting anything.
    voice.setInputMode(next.inputMode);
    voice.setVadThreshold(next.vadThreshold);
    if (
      next.inputDeviceId !== prevDeviceId &&
      voice.getState().status !== "idle"
    ) {
      void voice.setInputDevice(next.inputDeviceId);
    }
    // Re-captures the track and swaps it into the live senders. Cheap to call
    // unconditionally — it returns immediately when nothing changed.
    void voice.setMicProcessing(next.micProcessing);
    // Never re-captures: it re-shapes a camera that is already open and moves
    // the encoder's ceiling. Safe mid-call by construction, and a no-op when
    // the camera is off, where the next `toggleCamera` reads the new value.
    void voice.setVideoQuality(next.videoQuality);
    if (next.screenFrameRate !== localSettings.screenFrameRate) {
      screenFrameRateRef.current = next.screenFrameRate;
      void voice.applyScreenFrameRate(shareMaxFrameRate());
    }
  }

  /**
   * The in-call quality menu, writing to the same place the Settings dialog
   * writes to.
   *
   * There is one stored value (`LocalSettings.videoQuality`) and one live
   * setter, so the two surfaces cannot drift: the menu on the call and the
   * select in Settings are both views of this state, and either one moving
   * re-renders the other with the new choice already selected. The controller
   * is reached through the same `setVideoQuality` path Settings uses, which
   * re-shapes the track already on the wire rather than re-capturing, so the
   * camera does not blink when somebody changes this mid-call.
   */
  function handleVideoQualityChange(quality: VideoQuality) {
    const next = { ...localSettings, videoQuality: quality };
    setLocalSettings(next);
    saveLocalSettings(next);
    void voice.setVideoQuality(quality);
  }

  function handleScreenFrameRateChange(rate: ScreenFrameRate) {
    const next = { ...localSettings, screenFrameRate: rate };
    setLocalSettings(next);
    saveLocalSettings(next);
    screenFrameRateRef.current = rate;
    void voice.applyScreenFrameRate(shareMaxFrameRate());
  }

  /**
   * Open a server this account just joined (or made).
   *
   * A JOIN DURING A SHOW OPENS THE SHOW. Every join path ends here: the
   * community link's `?join=`, an invite link, the directory card, the
   * wizard's typed invite. When a watch party is live in the server, the
   * person lands on it instead of the Overview or `#general`. On 2026-09-26
   * every newcomer who reached MoonKase's party went through the Overview
   * first and spent a median 45 s finding it; see `lib/live-party-landing.ts`.
   * The party list is asked for beside the server list and a failure reads
   * as "nothing live", so this can only ever fall back to the old landing,
   * never cost the join.
   */
  const refreshAfterJoin = useCallback(
    async (serverId: string) => {
      const [{ servers: serverList }, liveParties] = await Promise.all([
        fetchServers(),
        // Capped: the party only picks the landing, so a slow answer must
        // never hold up a join that already succeeded.
        isWatchPartyChannelsEnabled()
          ? Promise.race([
              apiFetchServerWatchParties(serverId).then(
                (answer) => answer.parties,
                () => [] as WatchParty[],
              ),
              new Promise<WatchParty[]>((resolve) =>
                window.setTimeout(() => resolve([]), 3_000),
              ),
            ])
          : Promise.resolve([] as WatchParty[]),
      ]);
      setServers(serverList);
      setSelection({ kind: "server", serverId });
      await loadChannels(serverId, liveParties);
    },
    [loadChannels],
  );

  /**
   * Apply a `/app/server/<id>[/channel/<id>]` target: switch server, load its
   * channels, and open the requested channel (falling back to the first text
   * channel when the id is missing or no longer visible to this user).
   */
  const applyChannelRoute = useCallback(
    async (
      serverId: string,
      channelId: string | null,
      messageId: string | null = null,
      linkedAt: number = Date.now(),
    ) => {
      const known = serversRef.current.map((server) => server.id);
      const openable = pickOpenableServer(serverId, known);
      const targetServerId = openable?.serverId ?? serverId;
      const usedFallback = openable?.usedFallback === true;
      const targetChannelId = usedFallback ? null : channelId;
      const targetMessageId = usedFallback ? null : messageId;

      setChannelsLoading(true);
      beginChannelLoad(targetServerId);
      const ticket = channelListTickets.take();
      try {
        const { channels: list } = await fetchChannels(targetServerId);
        setSelection({ kind: "server", serverId: targetServerId });
        setAppError(null);
        setChannels(list);
        channelListTickets.wrote(ticket);
        // Same as in `loadChannels`: a nudge landed mid-flight.
        if (!channelListTickets.isLatest(ticket)) {
          refreshChannelListRef.current(targetServerId);
        }
        void loadUnread(targetServerId);
        const requested = targetChannelId
          ? list.find((c) => c.id === targetChannelId)
          : undefined;
        if (targetChannelId && !requested) {
          setAppError("That channel no longer exists or is private.");
        }
        if (requested) {
          await selectChannel(requested.id, targetServerId);
          if (targetMessageId && !sentSince(requested.id, linkedAt)) {
            setHighlightMessageId(targetMessageId);
          }
        } else {
          const targetServer = serversRef.current.find(
            (row) => row.id === targetServerId,
          );
          const land = pickServerLandingTarget(
            list,
            communityHomeOn() && targetServer?.communityHomeEnabled === true,
            targetServer?.isCommunity === true,
          );
          if (land) {
            await selectChannel(land.id, targetServerId);
          } else {
            setSelectedChannelId(null);
            selectedChannelIdRef.current = null;
          }
        }
      } catch (error) {
        const gone = error instanceof ApiError && error.status === 404;
        // Same as in `loadChannels`: a failed load must not strand a nudge
        // refetch its ticket silenced.
        if (!gone && channelListTickets.owesUpdate(targetServerId, ticket)) {
          refreshChannelListRef.current(targetServerId);
        }
        setAppError(
          gone
            ? translateMessage("chrome.serverUnavailable")
            : error instanceof Error
              ? error.message
              : translateMessage("chrome.serverUnavailable"),
        );
      } finally {
        endChannelLoad(targetServerId);
        setChannelsLoading(false);
      }
    },
    [
      channelListTickets,
      communityHomeOn,
      loadUnread,
      selectChannel,
      sentSince,
    ],
  );

  /**
   * Apply a `/app/dm[/<channelId>]` target.
   *
   * The list is refetched first rather than trusted from state, because this is
   * also the path a shared link takes into a cold tab: the conversation is not
   * in memory yet, and an id that is not in the fetched list is one this
   * account is not part of — which is a dead link, not a channel to try opening.
   */
  const applyConversationRoute = useCallback(
    async (
      channelId: string | null,
      messageId: string | null = null,
      linkedAt: number = Date.now(),
    ) => {
      setSelection(HOME_SELECTION);
      const list = await loadConversations();
      if (!channelId) {
        setSelectedChannelId(null);
        selectedChannelIdRef.current = null;
        return;
      }
      if (!list.some((one) => one.channelId === channelId)) {
        setSelectedChannelId(null);
        selectedChannelIdRef.current = null;
        setAppError("That conversation is not available.");
        return;
      }
      await selectConversation(channelId);
      if (messageId && !sentSince(channelId, linkedAt)) {
        setHighlightMessageId(messageId);
      }
    },
    [loadConversations, selectConversation, sentSince],
  );

  /**
   * The first-run checklist is answered — hidden by hand, or finished.
   *
   * Optimistic and unawaited, for the same reason `finish()` in the wizard is:
   * the card must go on the click, and a failed write costs one repeat of a
   * dismissible card rather than a dialog that looks frozen. The local `user` is
   * patched first so `shouldShowFirstRun` goes false immediately — that is also
   * what makes this safe to call from the stamp-on-complete effect, which stops
   * asking as soon as the preference is present.
   */
  const settleFirstRun = useCallback(() => {
    const patch = firstRunDismissedPatch();
    setUser((previous) =>
      previous
        ? { ...previous, preferences: { ...previous.preferences, ...patch } }
        : previous,
    );
    void updatePreferences(patch).catch(() => {
      // Nothing to recover. The next bootstrap re-reads the truth, and the worst
      // case is the card offered once more.
    });
  }, []);

  // Two switches gate the live Baú feed: the instance flag and this
  // server's own opt-in. A community still opens Overview without them
  // (identity header, empty feed). A private hall still needs both.
  // Computed here, above every early return, because the "New" chip below is
  // a hook.
  const communityHomeFeatureOn = isCommunityHomeEnabled({
    config: communityHomeConfig,
    allowLocalOverride: isDevAuthBypassEnabled(),
  });
  const communityHomeFeedLive =
    communityHomeFeatureOn &&
    servers.find((s) => s.id === selectedServerId)?.communityHomeEnabled ===
      true;
  const selectedIsCommunity =
    servers.find((s) => s.id === selectedServerId)?.isCommunity === true;
  const communityHomeEnabled = communityHomeFeedLive;
  const communityHomeOpen =
    selection.kind === "server" &&
    isCommunityHomeChannelId(selectedChannelId) &&
    (communityHomeFeedLive || selectedIsCommunity);
  useEffect(() => {
    if (!communityHomeEnabled || !selectedServerId) {
      setCommunityHomeRowNew(false);
      return;
    }
    if (communityHomeOpen) {
      markCommunityHomeRowSeen(selectedServerId);
      setCommunityHomeRowNew(false);
      return;
    }
    setCommunityHomeRowNew(isCommunityHomeRowNew(selectedServerId));
  }, [communityHomeEnabled, communityHomeOpen, selectedServerId]);

  /**
   * The Baú badge for the open server, and the live corner card.
   *
   * Looking at the feed IS reading it: the count goes to zero and the read
   * mark is stamped on the API, so it stays zero on the next device. Looking
   * elsewhere refetches the count. `communityHomeUpdateNudge` is in the deps
   * so a post published while this tab is open lands in whichever of the two
   * halves applies, rather than waiting for a navigation.
   *
   * The toast only fires when that refetch is caused by a WS nudge AND the
   * unread count went up: own posts never count, so the author does not get
   * a card for their own publish, and pin/delete/unpublish stay quiet.
   */
  const dismissCommunityHomePostToast = useCallback(() => {
    setCommunityHomePostToast(null);
  }, []);
  const openCommunityHomePostToast = useCallback(() => {
    const current = communityHomePostToastRef.current;
    setCommunityHomePostToast(null);
    if (current && current.serverId === selectedServerIdRef.current) {
      void selectChannel(COMMUNITY_HOME_CHANNEL_ID, current.serverId);
    }
  }, [selectChannel]);
  useEffect(() => {
    const fromNudge =
      communityHomeUpdateNudge !== communityHomeUpdateNudgeRef.current;
    communityHomeUpdateNudgeRef.current = communityHomeUpdateNudge;

    if (!communityHomeEnabled || !selectedServerId) {
      setCommunityHomeUnread(0);
      communityHomeUnreadRef.current = 0;
      communityHomeUnreadServerRef.current = null;
      communityHomeUnreadBaselineRef.current = false;
      setCommunityHomePostToast(null);
      return;
    }
    if (communityHomeUnreadServerRef.current !== selectedServerId) {
      communityHomeUnreadServerRef.current = selectedServerId;
      communityHomeUnreadRef.current = 0;
      communityHomeUnreadBaselineRef.current = false;
      setCommunityHomePostToast((current) =>
        current?.serverId === selectedServerId ? current : null,
      );
    }
    if (communityHomeOpen) {
      setCommunityHomeUnread(0);
      communityHomeUnreadRef.current = 0;
      // Do not treat "opened the feed" as a successful unread read. A failed
      // stamp leaving baseline=true and count=0 would toast the backlog the
      // next time a nudge compared against that zero.
      communityHomeUnreadBaselineRef.current = false;
      setCommunityHomePostToast(null);
      const serverId = selectedServerId;
      let cancelled = false;
      void markCommunityHomeRead(serverId)
        .then(() => {
          if (cancelled || communityHomeUnreadServerRef.current !== serverId) {
            return;
          }
          communityHomeUnreadBaselineRef.current = true;
          communityHomeUnreadRef.current = 0;
        })
        .catch(() => {
          // Leave the baseline unset so a later nudge cannot toast against 0.
        });
      return () => {
        cancelled = true;
      };
    }
    const previous = communityHomeUnreadRef.current;
    const hadBaseline = communityHomeUnreadBaselineRef.current;
    let cancelled = false;
    void fetchCommunityHomeUnread(selectedServerId)
      .then(({ count }) => {
        if (!cancelled) {
          setCommunityHomeUnread(count);
          communityHomeUnreadRef.current = count;
          communityHomeUnreadBaselineRef.current = true;
          if (
            shouldOfferCommunityHomePostToast({
              lookingAtFeed: false,
              hasUnreadBaseline: hadBaseline,
              fromNudge,
              unreadBefore: previous,
              unreadAfter: count,
            })
          ) {
            const name =
              serversRef.current.find((row) => row.id === selectedServerId)
                ?.name ?? "";
            setCommunityHomePostToast({
              serverId: selectedServerId,
              serverName: name,
            });
          }
        }
      })
      .catch(() => {
        // Flag off, or a blip: no badge is better than a wrong one.
        // Leave the baseline unset so a later nudge cannot toast against 0.
      });
    return () => {
      cancelled = true;
    };
  }, [
    communityHomeEnabled,
    communityHomeOpen,
    selectedServerId,
    communityHomeUpdateNudge,
  ]);

  /**
   * The Baú intro card is put away. Same optimistic shape as `settleFirstRun`:
   * the local `user` is patched first so the card goes on the click.
   */
  const settleCommunityHomeIntro = useCallback(() => {
    const patch = { communityHomeIntroDismissedAt: new Date().toISOString() };
    setUser((previous) =>
      previous
        ? { ...previous, preferences: { ...previous.preferences, ...patch } }
        : previous,
    );
    void updatePreferences(patch).catch(() => {
      // Worst case the card is offered once more on the next bootstrap.
    });
  }, []);

  /**
   * The Voz limpa nudge is put away — same shape as `settleCommunityHomeIntro`,
   * and it is what both "Ativar" and "Depois" call: either one is an answer,
   * so neither should leave the card able to come back.
   */
  const settleVoiceCleanNudge = useCallback(() => {
    const patch = voiceCleanNudgeDismissedPatch();
    setUser((previous) =>
      previous
        ? { ...previous, preferences: { ...previous.preferences, ...patch } }
        : previous,
    );
    void updatePreferences(patch).catch(() => {
      // Worst case the card is offered once more on the next qualifying call.
    });
  }, []);

  /**
   * "Ativar" on the Voz limpa nudge: the same live-apply path Settings uses
   * for the noise-suppression select, so a call already in progress hears
   * the switch the same way it would from the modal. A plain function, not a
   * `useCallback` — it calls `handleAudioSettingsLive`, itself redefined every
   * render, and closes over `localSettings` directly rather than chasing that
   * identity through a dependency array.
   */
  async function activateVoiceClean() {
    // Dismissing the card is "the nudge was answered" and happens either
    // way, immediately — same as "Depois". The toast is a different claim
    // ("it is ON"), so it waits for confirmation below, and is not shown at
    // all when the confirmation says the request fell back.
    settleVoiceCleanNudge();
    const next: LocalSettings = {
      ...localSettings,
      micProcessing: {
        ...localSettings.micProcessing,
        noiseSuppression: "advanced",
      },
    };
    setLocalSettings(next);
    saveLocalSettings(next);
    // NOT `handleAudioSettingsLive`: it fires `voice.setMicProcessing`
    // without awaiting it, and `setMicProcessing` no-ops on a processing
    // value that already matches `audioOptions.processing` — so calling it a
    // second time ourselves, to await it, would see its own first call's
    // synchronous update and return immediately without ever waiting for the
    // real pipeline swap. One call, awaited here, is what lets this function
    // tell a real switch from a fallback: `createMicPipeline`'s "browser
    // cannot run RNNoise" path (used whether or not a call is live — it is a
    // no-op pipeline swap when idle, same as every other processing change)
    // stamps this exact notice, so seeing it right after the call settles
    // means the request did not actually turn Voz limpa on, and the toast
    // must not say it did — the notice banner on the call stage already says
    // why.
    await voice.setMicProcessing(next.micProcessing);
    if (voice.getState().notice !== t("voice.notice.noiseSuppressionUnsupported")) {
      setVoiceCleanActivatedToast(true);
    }
  }

  useEffect(() => {
    if (!voiceCleanActivatedToast) {
      return;
    }
    const timer = setTimeout(() => setVoiceCleanActivatedToast(false), 3000);
    return () => clearTimeout(timer);
  }, [voiceCleanActivatedToast]);

  /**
   * Walk in, rather than asking whether they meant to.
   *
   * WHAT THIS REPLACES. `/app/invite/<code>` used to open the join dialog with
   * the code already typed into it — a form asking somebody to confirm the link
   * they had just clicked, with a Cancel button next to it that threw away the
   * only reason they were there. For a brand-new account it was worse still: the
   * wizard ran first, its last step offered an empty "or use an invite" field
   * while the app was already holding the code, and the dialog was waiting
   * underneath to ask a third time.
   *
   * Clicking an invite link is not an ambiguous gesture, and joining a server is
   * reversible — you can leave. So the click is taken at face value: join, open
   * the channel, and say where they landed. The dialog is now only what a *typed*
   * code and a *dead link* get.
   *
   * Idempotent by the server's own design: `redeemInvite` upserts the membership
   * and only counts a use on a real join, so re-opening a link you have already
   * used costs nothing and does not burn the invite. That is what makes it safe
   * to do this on a plain page load.
   */
  const acceptInviteFromLink = useCallback(
    async (code: string) => {
      setInviteErrorFromUrl(null);
      const storage = browserStorage();
      // The link's `?ref=` tag, or the one stashed at boot before a sign-in
      // redirect dropped the query. Attribution only.
      const ref = takeInviteRef(storage, code, window.location.search);
      setInviteJoin("pending");
      try {
        const result = await joinInvite(code, ref);
        setInviteJoin({ serverId: result.serverId });
        // Only welcome them somewhere this device has not welcomed them before.
        // Invite links get re-clicked weeks later, and the join succeeds again.
        if (!hasArrived(storage, result.serverId)) {
          rememberArrival(storage, result.serverId);
          setArrivalServerId(result.serverId);
        }
        await refreshAfterJoin(result.serverId);
      } catch (error) {
        // Expired, revoked, used up, banned, or mistyped. Fall back to the panel
        // with the code and the reason, so there is somewhere to go from here —
        // ask for a fresh link, or paste a different one.
        // Put the tag back for the panel's retry: it was taken before the
        // server confirmed anything.
        stashInviteRef(storage, code, ref);
        setInviteJoin("failed");
        setInviteCodeFromUrl(code);
        setInviteErrorFromUrl(
          error instanceof ApiError
            ? error.message
            : t("invite.join.failed"),
        );
        setInviteMode("join");
      }
    },
    [refreshAfterJoin, t],
  );

  // Deep links (`pqp://…` via Electron) and shareable web URLs both land here.
  useEffect(() => {
    if (!bootstrapReady) {
      return;
    }
    const path = location.pathname;
    if (routeRef.current === path) {
      return;
    }
    const target = parseAppRoute(path);
    if (!target) {
      return;
    }
    routeRef.current = path;

    if (target.kind === "invite") {
      setArrivedOnInviteLink(true);
      void acceptInviteFromLink(target.code);
      return;
    }
    if (target.kind === "connection-callback") {
      return;
    }
    const linkedAt = linkFollowedAt(location.state);
    if (target.kind === "conversation") {
      void applyConversationRoute(
        target.channelId,
        target.messageId,
        linkedAt,
      );
      return;
    }
    void applyChannelRoute(
      target.serverId,
      target.channelId,
      target.messageId,
      linkedAt,
    );
    // applyChannelRoute reads current state; re-running only on path/readiness
    // changes is intentional — selection changes write the URL via syncRoute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapReady, location.pathname]);

  /**
   * "Somebody just made an account", told to Google Ads once.
   *
   * WHY HERE. The same three conditions the arrival intents below wait for are
   * the ones that make this a real sign-up: the account exists, it has cleared
   * the 18+ gate, and it has a working token. Reporting any earlier would count
   * accounts that the gate is about to refuse, which is a conversion an
   * advertiser would be bidding to buy more of.
   *
   * WHY NOT AT SIGN-IN, WHICH IS THE OBVIOUS WRONG ANSWER. This effect runs on
   * every load for every signed-in person, including somebody who joined in
   * March. What makes it fire for a sign-up and only a sign-up is
   * `reportSignupConversion`: Clerk's `createdAt` has to be inside a half-hour
   * window and this browser must not already have reported that account id. The
   * argument for that pair, and for what it deliberately gets wrong, is in
   * `lib/google-ads.ts`.
   *
   * NO REF GUARD, UNLIKE THE EFFECT BELOW. It would be the weaker guard of the
   * two: a ref covers StrictMode's double invocation and nothing else, while
   * the stored note covers that *and* reloads, remounts and navigating back
   * into `/app`. The note is written before the event is sent, so the second
   * StrictMode pass reads it back and stops.
   *
   * Inert on a self-hosted build, where no Google tag was injected and
   * `window.gtag` does not exist, and under the dev auth bypass, where there is
   * no Clerk account to have been created.
   */
  useEffect(() => {
    if (!bootstrapReady || !clerkAccount) {
      return;
    }
    reportSignupConversion({
      accountCreatedAt: clerkAccount.createdAt,
      userId: clerkAccount.id,
      storage: browserStorage(),
      gtag: window.gtag,
    });
  }, [bootstrapReady, clerkAccount]);

  /**
   * Open Create community for somebody who asked for it, once the app is
   * ready and onboarding is not in front of it: on the Discord paste step for
   * "I already have a Discord server", on the name field for `?create=new`.
   * Fed by the arrival intents below (a `/vem` CTA, a `?import=` campaign
   * link) and by the onboarding's third door; all of them only set
   * `pendingCreate`.
   */
  useEffect(() => {
    if (!bootstrapReady || needsOnboarding || !pendingCreate) {
      return;
    }
    // Shown now, so spend the stash the arrival effect put back.
    takeCreateIntent(browserStorage());
    setCreateServerStart(pendingCreate);
    setShowCreateServer(true);
    setPendingCreate(null);
  }, [bootstrapReady, needsOnboarding, pendingCreate]);

  /**
   * `?intent=watch-party-waitlist` (the public `/watch-party` page's button):
   * the waitlist dialog, once the account exists and onboarding is done, on
   * whatever server is open. Only while the deployment runs the campaign: a
   * build that cannot turn a server on must not collect a request for one.
   */
  useEffect(() => {
    if (!bootstrapReady || needsOnboarding || !pendingWaitlist) {
      return;
    }
    setPendingWaitlist(false);
    // No cleanup cancelling this: clearing `pendingWaitlist` above re-runs
    // the effect, and a cancel there threw away the very answer it waited on.
    // The stash is spent only once the answer is in, so a failed read leaves
    // it for the next load instead of losing what the person came for.
    void loadWatchPartyWaitlist(selectedServerId)
      .then((answer) => {
        takeWaitlistIntent(browserStorage());
        if (answer.campaign) {
          setWaitlistDialogOpen(true);
        }
      })
      .catch(() => {
        // Still stashed: a reload within the hour tries again.
      });
  }, [bootstrapReady, needsOnboarding, pendingWaitlist, selectedServerId]);

  /**
   * "Watch party liberada!" for anybody who was offline when the operator
   * pressed Ativar. Read once per load; the live frame covers the rest.
   */
  useEffect(() => {
    if (!bootstrapReady) {
      return;
    }
    let cancelled = false;
    void fetchWatchPartyApprovals()
      .then(({ approvals }) => {
        if (!cancelled && approvals.length > 0) {
          setWaitlistApprovals((current) => {
            const known = new Set(current.map((card) => card.serverId));
            return [
              ...current,
              ...approvals
                .filter((approval) => !known.has(approval.serverId))
                .map((approval) => ({
                  serverId: approval.serverId,
                  serverName: approval.serverName,
                })),
            ];
          });
        }
      })
      .catch(() => {
        // A missed card is shown on the next load; not worth a banner.
      });
    return () => {
      cancelled = true;
    };
  }, [bootstrapReady]);

  /**
   * The three intentions somebody arrived with, acted on exactly once.
   *
   * WHAT THIS FINISHES. `pqp.gg/garanta`, `pqp.gg/@rafa` and
   * `pqp.gg/c/valorant` all end in a sign-up, and all three carry something the
   * sign-up cannot: a name somebody chose, a person somebody meant to add, and
   * a room somebody meant to walk into. None is expressible as a path the way an
   * invite code is (see `signedOutRedirectPath`), so they travel as a query
   * parameter with a `localStorage` stash behind it — `lib/handle-intent.ts` has
   * the argument for the belt and the braces.
   *
   * WHY HERE AND NOT EARLIER. `bootstrapReady` is the first moment the account
   * exists, has cleared the 18+ gate, and has a working token — all three are
   * required. A claim written before the gate would squat a name for an account
   * that may never be let in, and a friend request sent before it would be a
   * refused account contacting a person.
   *
   * WHY IT CANNOT REPEAT. The stash is consumed on read, and the query string is
   * wiped from the address bar the moment it is read — otherwise a reload would
   * re-send the friend request, and a refresh a month later would spend the
   * handle rename cooldown on a name the person had already changed away from.
   * The ref is the third belt: React 19 StrictMode runs this effect twice in
   * development, and without it the second run would race the first.
   */
  const arrivalIntentsHandled = useRef(false);
  useEffect(() => {
    if (!bootstrapReady || arrivalIntentsHandled.current) {
      return;
    }
    arrivalIntentsHandled.current = true;

    const storage = browserStorage();
    const params = new URLSearchParams(location.search);
    // Both stashes are consumed unconditionally, even when the URL also carries
    // the value: leaving one behind is how an intent fires on a later visit.
    const stashedClaim = takeHandleClaim(storage);
    const stashedAdd = takeAddIntent(storage);
    const stashedJoin = takeJoinIntent(storage);
    const stashedCreate = takeCreateIntent(storage);
    const stashedWaitlist = takeWaitlistIntentWithSource(storage);
    // Consumed in the same breath as the intents and for the same reason: a
    // stash that outlives the request it causes is a request that repeats.
    // Read, not consumed: cleared only once the server has answered (below),
    // so a failed request is sent again on the next load.
    const stashedAcquisition = peekAcquisition(storage);
    // How long the round trip through Clerk took, when this browser started it.
    // ONE record does both jobs: PR 909's `pqp:signup-cta` tap stamp feeds the
    // `signup_return` event AND the duration sent with the acquisition, so
    // there is a single key, a single account-created-after-the-tap check and a
    // single cross-tab lock. `null` unless this tap caused this sign-up.
    const signupSeconds = noteSignupReturn(storage);
    const acquisition =
      stashedAcquisition || signupSeconds !== null
        ? {
            ...(stashedAcquisition ?? {}),
            ...(signupSeconds !== null ? { signupSeconds } : {}),
          }
        : null;
    const claim = normalizeHandle(params.get("claim") ?? "") || stashedClaim;
    const add = addIntentFromSearch(location.search) ?? stashedAdd;
    const join = joinIntentFromSearch(location.search) ?? stashedJoin;
    const create = createIntentFromSearch(location.search) ?? stashedCreate;
    const waitlistIntent =
      waitlistIntentFromSearch(location.search) || stashedWaitlist !== null;
    if (waitlistIntent) {
      const source = waitlistSourceFor(location.search, stashedWaitlist);
      setPendingWaitlist(true);
      setWaitlistSource(source);
      // Kept until the dialog opens, like the create intent above.
      stashWaitlistIntent(storage, Date.now(), source);
    }
    /**
     * Create community, for somebody who came to make one (a `/vem` CTA, a
     * `?import=discord` link). The import also tells the onboarding to skip
     * its "create or join?" step, which this person already answered. The
     * name field waits for no onboarding at all: that step IS a name field,
     * and a second one behind it would ask twice.
     */
    if (create && (create.mode === "import" || !needsOnboarding)) {
      setPendingCreate(create);
      // Kept in storage until the dialog actually opens, so a reload during
      // onboarding (the param is already gone from the URL) still gets there.
      stashCreateIntent(storage, create);
    }

    if (
      params.has("claim") ||
      params.has("add") ||
      params.has("join") ||
      waitlistIntentFromSearch(location.search) ||
      CREATE_INTENT_PARAMS.some((name) => params.has(name))
    ) {
      params.delete("claim");
      params.delete("add");
      params.delete("join");
      if (waitlistIntentFromSearch(location.search)) {
        params.delete(INTENT_PARAM);
        params.delete(WAITLIST_SOURCE_PARAM);
      }
      for (const name of CREATE_INTENT_PARAMS) {
        params.delete(name);
      }
      const rest = params.toString();
      navigate(`${location.pathname}${rest ? `?${rest}` : ""}`, {
        replace: true,
      });
    }

    /**
     * Which link brought this account here, told to the server once.
     *
     * Fire-and-forget, and deliberately not awaited inside the chain below:
     * nothing the person sees depends on it, and a failure costs one count in
     * an operator report, not a feature. The server writes it only onto an
     * account that has none and is less than a day old, so a returning member
     * who clicked a campaign link is never re-attributed (lib/acquisition.ts).
     */
    if (acquisition) {
      void updateMe({ acquisition })
        .then(() => acknowledgeAcquisition(storage, true))
        .catch((error: unknown) => {
          // A refusal for good (a 4xx) is cleared so it cannot loop; a
          // transient failure keeps the stash for the next load. Not worth a
          // banner either way.
          if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
            acknowledgeAcquisition(storage, false);
          }
        });
    } else {
      // Nothing to send: only tidy an expired entry away.
      acknowledgeAcquisition(storage, false);
    }

    void (async () => {
      if (claim && validateHandle(claim) === null) {
        try {
          const updated = await updateMe({ handle: claim });
          setUser(updated);
          chat.setCurrentUser(updated);
          setAppNotice(
            t("handle.claimed.notice", {
              url: publicProfileDisplayUrl(updated.handle ?? claim),
            }),
          );
          setClaimedHandle(updated.handle ?? claim);
        } catch (error) {
          // The most likely reason by far is that somebody else took it in the
          // seconds between the availability check and the sign-up, which is
          // exactly the race the unique index exists to decide. Say so and move
          // on — the account is fine, it just has no handle yet.
          setAppNotice(null);
          setAppError(
            t("handle.claim.failed", {
              reason:
                error instanceof ApiError
                  ? error.message
                  : t("friends.requestFailed"),
            }),
          );
        }
      }

      if (add) {
        try {
          const { user: target } = await lookupUserByHandle(add);
          const result = await sendFriendRequest(target.id);
          setAppNotice(
            t(
              result.state === "accepted"
                ? "handle.add.accepted"
                : "handle.add.sent",
              { name: target.displayName },
            ),
          );
          await friendsRef.current.refresh();
        } catch {
          // Deleted account, a block in either direction, a rate limit. The
          // server's refusals here are deliberately indistinguishable (see the
          // route), so this says one thing for all of them.
          setAppError(t("handle.add.failed"));
        }
      }

      /**
       * The community somebody came here to walk into.
       *
       * TWO REQUESTS, NOT ONE, and the split is the point: the public page
       * never had an id to give (see `publicCommunitySchema`), so the slug is
       * resolved behind auth and then the ORDINARY join is posted against the
       * id — the same call the directory card makes, with the same ban check,
       * the same audit entry and the same idempotency. There is deliberately no
       * join-by-slug route; a second door into the same room is a second door
       * to remember to lock.
       *
       * LANDS THEM IN THE ROOM, which is the whole reason this exists. Being
       * dropped at an empty hub after asking to enter a specific community is
       * the exact failure `signedOutRedirectPath` was written to fix for
       * invites.
       *
       * THE ARRIVAL BANNER IS ARMED for a real join and not for a re-entry, the
       * same rule the directory card follows: opening a community you were
       * already in is not an arrival.
       */
      if (join) {
        setArrivedOnCommunityLink(true);
        setCommunityJoin("pending");
        try {
          const { community } = await lookupCommunityBySlug(join);
          const result = await joinCommunityApi(community.id, "community_address");
          setCommunityJoin({ serverId: community.id });
          if (result.joinedNow) {
            const storage = browserStorage();
            if (!hasArrived(storage, community.id)) {
              rememberArrival(storage, community.id);
              setArrivalServerId(community.id);
            }
          }
          setAppNotice(
            t(result.joinedNow ? "handle.join.done" : "handle.join.already", {
              name: result.serverName,
            }),
          );
          await refreshAfterJoin(community.id);
        } catch {
          // Unknown slug, unlisted, suspended, banned, or the deployment has
          // communities off. The server answers all of them identically on
          // purpose — see rule 3 in services/communities.ts — so this says one
          // thing for all of them.
          setAppError(t("handle.join.failed"));
          setCommunityJoin("failed");
        }
      }
    })();
    // Runs once, on the transition into a ready app. `user`, `t` and the
    // callbacks it closes over are all stable by then, and adding them would
    // re-arm an effect whose whole contract is that it fires exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapReady]);

  function openInviteForServer(serverId: string) {
    setSelection({ kind: "server", serverId });
    void loadChannels(serverId);
    setInviteMode("create");
  }

  function openMembersForServer(serverId: string) {
    setSelection({ kind: "server", serverId });
    void loadChannels(serverId);
    setMembersOpen(true);
  }

  const handleBlockUser = useCallback(
    async (userId: string) => {
      try {
        await blockUser(userId);
        await loadBlocks();
        // A blocked author's messages stop counting towards unread on the
        // server, so the conversation's badge is now wrong by however much they
        // had said. Refetching is what settles it — the row itself stays, since
        // blocking somebody does not erase what was already said to you.
        await loadConversations({ trustSnapshot: true });
        // A BLOCK ALSO ENDED A FRIENDSHIP, if there was one: the schema's
        // trigger deletes the pair's row the moment the block lands, in both
        // directions and including a pending request. Nothing tells us that
        // happened, so every surface drawing the friends list — the badge, the
        // list itself, any open profile card — kept showing a friendship the
        // database no longer has. Re-reading here is what makes the trigger's
        // effect visible everywhere at once.
        await friendsRef.current.refresh();
      } catch (error) {
        setAppError(
          error instanceof Error ? error.message : "Failed to block that person",
        );
      }
    },
    [loadBlocks, loadConversations],
  );

  const handleUnblockUser = useCallback(
    async (userId: string) => {
      try {
        await unblockUser(userId);
        await loadBlocks();
      } catch (error) {
        setAppError(
          error instanceof Error ? error.message : "Failed to unblock",
        );
      }
    },
    [loadBlocks],
  );

  /**
   * Settings' block (the block-by-name form in Privacidade). The block request
   * throws back so the row can say it failed; once the server agreed, the same
   * refreshes as `handleBlockUser` run, so the DM list, unread counts, hidden
   * messages and the friends list (a block ends a friendship) catch up now
   * rather than on the next reload. A failed refresh is not a failed block.
   */
  const handleSettingsBlock = useCallback(
    async (userId: string) => {
      await blockUser(userId);
      await Promise.allSettled([
        loadBlocks(),
        loadConversations({ trustSnapshot: true }),
        friendsRef.current.refresh(),
      ]);
    },
    [loadBlocks, loadConversations],
  );

  /**
   * Settings' unblock. Unlike `handleUnblockUser`, a failure is thrown back so
   * the Privacidade row can say it (the app's banner sits behind the dialog).
   * Only the unblock request can fail it: the row is dropped locally once the
   * server agreed, and the list refresh after it settles on its own, so a
   * failed refresh never reads as a failed unblock or invites a retry.
   */
  const handleSettingsUnblock = useCallback(
    async (userId: string) => {
      await unblockUser(userId);
      setBlockedUsers((current) => current.filter((one) => one.id !== userId));
      void loadBlocks().catch(() => undefined);
    },
    [loadBlocks],
  );

  const handleHideConversation = useCallback(
    async (channelId: string) => {
      try {
        await hideConversation(channelId);
      } catch (error) {
        setAppError(
          error instanceof Error ? error.message : "Failed to close that",
        );
        return;
      }
      const remaining = conversationsRef.current.filter(
        (one) => one.channelId !== channelId,
      );
      setConversations(remaining);
      conversationsRef.current = remaining;
      if (isPinnedConversation(user?.preferences?.pinnedConversations, channelId)) {
        handlePinnedConversationsChange(
          prunePinnedConversations(
            removePinnedConversation(
              user?.preferences?.pinnedConversations,
              channelId,
            ),
            remaining,
          ),
        );
      }
      if (selectedChannelIdRef.current === channelId) {
        selectHome();
      }
    },
    [handlePinnedConversationsChange, selectHome, user],
  );

  const blockedUserIds = useMemo(
    () => new Set(blockedUsers.map((blocked) => blocked.id)),
    [blockedUsers],
  );

  // --- watch now: the strip that says a stream is live ----------------------
  // `docs/plans/WATCH_NOW.md`. Everything it shows is read from what this
  // client already holds (rosters, `channel-live`, the watch party map): no
  // request, no frame, no write per viewer. Off, `useWatchNow` answers an
  // empty list and the banner draws nothing.
  const watchNowFlag = useWatchNowFlag(
    selection.kind === "server" ? selectedServerId : null,
  );
  const watchNowScope = useMemo<WatchNowScope | null>(() => {
    if (selection.kind === "server" && selectedServerId) {
      return {
        kind: "server",
        // A switch leaves the old server's list in place for a beat.
        channels: channels.filter(
          (channel) => channel.serverId === selectedServerId,
        ),
      };
    }
    if (selection.kind === "dm" && selectedChannelId) {
      return { kind: "conversation", channelId: selectedChannelId };
    }
    return null;
  }, [selection.kind, selectedServerId, selectedChannelId, channels]);
  const watchNowStreams = useWatchNow({
    enabled: watchNowFlag && watchNowScope !== null,
    viewerId: user?.id ?? null,
    scope: watchNowScope ?? WATCH_NOW_NO_SCOPE,
    occupancy: voiceState.occupancy,
    parties: watchParties.byChannel,
    channelLive: voiceState.channelLive,
    blocked: blockedUserIds,
    // CONNECT is the one gate the roster's own audience (VIEW) does not
    // cover: a button that can only fail is worse than none. A conversation
    // has no roles to lack. Read from THIS render's permissions, not through
    // `stableCanConnectIn`: that one is refreshed after the render, so the
    // render in which a newcomer's permissions arrive would still be asked
    // with the empty ones, and the streams are only recomputed when
    // `permissionsKey` changes (which is exactly that render).
    canConnect:
      watchNowScope?.kind === "conversation"
        ? WATCH_NOW_ALWAYS
        : (channelId: string) => perms.can(Permission.CONNECT, channelId),
    seatedChannelId:
      voiceState.status !== "idle" ? voiceState.voiceChannelId : null,
    connected: connection === "online",
    openChannelId: selectedChannelId,
    permissionsKey: perms.can,
  });
  // "Avisar quando alguém transmitir": asked when a server's menu opens, so a
  // deployment with the flag off pays nothing for it.
  const streamAlerts = useStreamAlertSettings();
  // The open server's `stream_start_notifications` answer arrives with the
  // config this client already asks for; when it is on, fetch what the menu
  // needs (the default for a person who never chose) before it is opened.
  const streamAlertsOn = liveHlsConfig?.streamStartNotifications === true;
  const ensureStreamAlerts = streamAlerts.ensure;
  useEffect(() => {
    if (streamAlertsOn && selectedServerId) {
      ensureStreamAlerts(selectedServerId);
    }
  }, [streamAlertsOn, selectedServerId, ensureStreamAlerts]);
  /** The join in flight from the strip, and why the last one failed. */
  const [watchNowJoining, setWatchNowJoining] = useState<string | null>(null);
  const [watchNowFailure, setWatchNowFailure] = useState<string | null>(null);
  const watchNowSawJoin = useRef(false);
  useEffect(() => {
    if (!watchNowJoining) {
      return;
    }
    if (voiceState.status !== "idle") {
      watchNowSawJoin.current = true;
    }
    if (
      voiceState.status === "connected" &&
      voiceState.voiceChannelId === watchNowJoining
    ) {
      setWatchNowJoining(null);
      setWatchNowFailure(null);
      return;
    }
    // Only a join that STARTED and came back counts: an error left over from
    // an earlier call must not read as this tap's answer.
    if (
      voiceState.status === "idle" &&
      voiceState.error &&
      watchNowSawJoin.current
    ) {
      // The join came back refused (a full room, a locked channel): say so
      // under the strip, in the words the voice layer already chose.
      setWatchNowFailure(voiceState.error);
      setWatchNowJoining(null);
    }
  }, [
    watchNowJoining,
    voiceState.status,
    voiceState.voiceChannelId,
    voiceState.error,
  ]);
  useEffect(() => {
    if (!watchNowFailure) {
      return;
    }
    const timer = window.setTimeout(() => setWatchNowFailure(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [watchNowFailure]);
  useEffect(() => {
    if (!watchNowJoining) {
      return;
    }
    // A join the guard parked behind a confirmation, or one that never
    // answered, must not leave the button saying "Entrando" for good.
    const timer = window.setTimeout(() => setWatchNowJoining(null), 15_000);
    return () => window.clearTimeout(timer);
  }, [watchNowJoining]);

  // --- threads ---
  // Channel ids with unread activity, as a set for the chips. Thread unreads
  // live in the same `unread` map as everything else, keyed by the thread's
  // own channel id — an id the sidebar never lists, which is precisely how a
  // busy thread never inflates its parent channel's badge. A chip checks only
  // its own thread's id here, so ordinary channel ids riding along are inert.
  const unreadThreadIds = useMemo(
    () => new Set(Object.keys(unread)),
    [unread],
  );

  /**
   * Jump to the channel the current call is in.
   *
   * Routed through `applyChannelRoute` whenever that channel is in another
   * server — or when the sidebar is on conversations, where there is no server
   * at all — because `channels` only ever holds the selected server's, and
   * opening an id that is not in it would leave the pane with nothing to draw.
   */
  const openVoiceChannel = useCallback(async () => {
    const channelId = voiceState.voiceChannelId;
    if (!channelId) {
      return;
    }
    // A conversation call: its home is the DM view, not any server.
    if (conversationsRef.current.some((one) => one.channelId === channelId)) {
      await selectConversation(channelId);
      return;
    }
    const serverId = voiceServerIdRef.current;
    if (serverId && serverId !== selectedServerId) {
      await applyChannelRoute(serverId, channelId);
      return;
    }
    await selectChannel(channelId, serverId ?? undefined);
  }, [
    applyChannelRoute,
    selectChannel,
    selectConversation,
    selectedServerId,
    voiceState.voiceChannelId,
  ]);

  /**
   * Everything the notification path needs to name a channel, conversations
   * included. Built here rather than in a sidebar because a sidebar unmounts
   * when the other one is shown, and the badge has to outlive that.
   */
  const notificationChannels = useMemo(
    () => [
      ...channels.map((channel) => ({
        id: channel.id,
        serverId: channel.serverId,
        name: channel.name,
        kind: channel.kind,
      })),
      ...conversations.map((conversation) => ({
        id: conversation.channelId,
        serverId: null,
        name: conversationTitle(conversation.participants),
        kind: conversation.kind,
      })),
    ],
    [channels, conversations],
  );
  useChannelNotifications({ channels: notificationChannels, unread });

  /**
   * Unread per server icon.
   *
   * The rail used to be able to indicate only the server already selected,
   * because the selected server's channels are the only ones the app fetches a
   * list for. That left every notification about any other server with nothing
   * to look at when you followed it back into the app. The activity frame has
   * been carrying its `serverId` all along; `rememberActivityChannel` files it,
   * and this is what reads it back.
   */
  const serverUnread = useMemo(() => {
    const placedBy = new Map<string, string | null>();
    for (const channel of notificationChannels) {
      placedBy.set(channel.id, channel.serverId);
    }
    return unreadByServer(unread, placedBy);
  }, [notificationChannels, unread]);

  const conversationUnread = conversationUnreadTotals(conversations, unread);

  const pinnedConversations = useMemo(
    () =>
      visiblePinnedConversations(
        conversations,
        user?.preferences?.pinnedConversations,
      ),
    [conversations, user?.preferences?.pinnedConversations],
  );
  const pinnedChannelIds = useMemo(
    () => new Set(pinnedConversations.map((one) => one.channelId)),
    [pinnedConversations],
  );
  const selectedPinnedId =
    !whatsNewOpen &&
    selection.kind === "dm" &&
    selectedChannelId &&
    pinnedChannelIds.has(selectedChannelId)
      ? selectedChannelId
      : null;

  /**
   * Conversations with somebody in their voice room right now, for the phone
   * affordance in the DM sidebar. Occupancy frames for a conversation only
   * ever reach its participants (the server resolves the audience through the
   * conversation branch of `channelVisibleSql`), so this set can never name a
   * call the viewer is not entitled to know about.
   */
  const activeConversationCallIds = useMemo(() => {
    const ids = new Set<string>();
    for (const conversation of conversations) {
      if ((voiceState.occupancy[conversation.channelId]?.length ?? 0) > 0) {
        ids.add(conversation.channelId);
      }
    }
    return ids;
  }, [conversations, voiceState.occupancy]);

  const updatePromptShowing = useUpdatePromptShowing();
  // The durable half: a build is precached and has not been taken. The rail
  // keeps a way back to the notice for as long as this is true, so a snooze,
  // a stray Escape or a three-hour call cannot strand somebody on an old
  // bundle with no button to press.
  const updateWaiting = useUpdateWaiting();
  // Let the update card (mounted outside App) know when a reload would end a call.
  useEffect(() => {
    setInCall(voiceState.status !== "idle");
    return () => setInCall(false);
  }, [voiceState.status]);
  // The same for a viewer looking at a live party: no seat, but not somebody an
  // automatic update may reload (`lib/update-policy.ts`).
  useEffect(() => {
    setWatchingParty(watchingAParty);
    return () => setWatchingParty(false);
  }, [watchingAParty]);

  const handleQgHintWantedChange = useCallback((wanted: boolean) => {
    setQgHintReady(true);
    setQgHintWanted(wanted);
  }, []);

  useEffect(() => {
    const conversation =
      selection.kind === "dm" && selectedChannelId
        ? conversations.find((one) => one.channelId === selectedChannelId)
        : undefined;
    const channel = conversation
      ? conversationChannel(conversation)
      : selection.kind === "server"
        ? channels.find((c) => c.id === selectedChannelId)
        : undefined;
    chat.setSlowMode({
      // A voice channel's chat is slowed like any other: the composer has to
      // hold the same way, or the wait is a rejection the sender never saw
      // coming.
      seconds:
        channel?.kind === "server" &&
        (channel.type === "text" || isVoiceRoomChannelType(channel.type))
          ? (channel.slowmodeSeconds ?? 0)
          : 0,
      // Same pair the server exempts: whoever can clear the flood and
      // whoever set the interval both work the room.
      bypass:
        perms.can(Permission.MANAGE_MESSAGES, selectedChannelId) ||
        perms.can(Permission.MANAGE_CHANNELS, selectedChannelId),
    });
  }, [
    chat,
    perms.can,
    selection.kind,
    selectedChannelId,
    conversations,
    channels,
  ]);

  useEffect(() => {
    threadChat.setSlowMode({
      seconds: 0,
      bypass:
        perms.can(
          Permission.MANAGE_MESSAGES,
          openThread?.thread.channelId ?? selectedChannelId,
        ) ||
        perms.can(
          Permission.MANAGE_CHANNELS,
          openThread?.thread.channelId ?? selectedChannelId,
        ),
    });
  }, [threadChat, perms.can, openThread?.thread.channelId, selectedChannelId]);

  /**
   * The invitee's one burst of confetti: on the arrival banner, the first time
   * the room they were invited to is on screen after the wizard. Latched into
   * state (and spent in session storage) so the banner re-rendering, or moving
   * between the channel pane and the community home, does not fire it again.
   * The organizer had theirs on the wizard's "Sala pronta" step.
   */
  const [celebrateArrivalFor, setCelebrateArrivalFor] = useState<string | null>(
    null,
  );
  const userIdForConfetti = user?.id ?? null;
  useEffect(() => {
    if (
      !justOnboarded ||
      !userIdForConfetti ||
      !arrivalServerId ||
      createdServerIds.has(arrivalServerId)
    ) {
      return;
    }
    const store = sessionStore();
    if (confettiSpent(store, userIdForConfetti)) {
      return;
    }
    spendConfetti(store, userIdForConfetti);
    setCelebrateArrivalFor(arrivalServerId);
  }, [justOnboarded, userIdForConfetti, arrivalServerId, createdServerIds]);
  // Released on its own clock, so nothing re-running the arming effect (a
  // profile echo replacing `user`) can cancel the reset and leave the burst
  // armed for every later remount of the banner.
  useEffect(() => {
    if (!celebrateArrivalFor) {
      return;
    }
    const timer = window.setTimeout(() => setCelebrateArrivalFor(null), 3000);
    return () => window.clearTimeout(timer);
  }, [celebrateArrivalFor]);

  if (bootstrapError) {
    return (
      <AppBootstrapError
        message={bootstrapError}
        onRetry={() => {
          setBootstrapError(null);
          // A retry is not a gate answer being saved: loading must look like
          // loading, not a locked gate saying "Salvando…".
          setGateHandoff(false);
          setBootstrapAttempt((n) => n + 1);
        }}
      />
    );
  }

  /**
   * Which first run this is, decided from what the person arrived with. Read
   * from the address bar as well as from state because the gate paints before
   * the bootstrap that would set `arrivedOnInviteLink`, and the dots on the
   * gate have to agree with the dots on the wizard.
   */
  const firstRunPath = onboardingPath({
    // A community's link is an invite in every way the first run cares
    // about: the person already has a room. Three places again (the state
    // after the arrival effect spent the intent, the URL, the stash). A join
    // that FAILED gave them no room, so it gets the ordinary first run.
    invite:
      arrivedOnInviteLink ||
      parseAppRoute(location.pathname)?.kind === "invite" ||
      (communityJoin !== "failed" &&
        (arrivedOnCommunityLink ||
          joinIntentFromSearch(location.search) !== null ||
          peekJoinIntent(browserStorage()) !== null)),
    // Three places, because each is the only one that knows at some moment:
    // the URL (a `/vem` CTA is a client-side navigation, so the boot-time
    // stash never saw it), the stash (a sign-in redirect dropped the query),
    // and state (after the arrival effect has spent both).
    importing:
      pendingCreate?.mode === "import" ||
      createIntentFromSearch(location.search)?.mode === "import" ||
      peekCreateIntent(browserStorage())?.mode === "import",
  });

  // The gate, and then the gate again in its saving state while the app loads
  // behind it after a pass: same element in the same place, so the panel
  // stays put until the wizard takes it over.
  if (ageGate || (gateHandoff && !(bootstrapReady && user))) {
    return (
      <AgeGateDialog
        status={ageGate ?? "pending"}
        stepsTotal={firstRunPath === "cold" ? 4 : 2}
        path={firstRunPath}
        handingOff={gateHandoff}
        // Passing re-runs the whole bootstrap from the top, which is exactly
        // what is wanted: everything it would have loaded is still unloaded.
        onPassed={() => {
          setGateHandoff(true);
          setAgeGate(null);
          setBootstrapAttempt((n) => n + 1);
        }}
        // Another tab already answered. Re-read rather than guess which way.
        onStale={() => {
          setAgeGate(null);
          setBootstrapAttempt((n) => n + 1);
        }}
      />
    );
  }

  if (!bootstrapReady) {
    return <AppLoadingShell label={t("app.loading.servers")} />;
  }

  /**
   * First run, after the gate and after the bootstrap.
   *
   * After the gate because onboarding a person who is about to be refused is
   * cruel and pointless. After the bootstrap because step 3 creates or joins a
   * server, and `refreshAfterJoin` needs the same loaded state every other
   * join path in the app needs.
   */
  if (needsOnboarding && user) {
    const roomJoin =
      inviteJoin ?? (communityJoin === "failed" ? null : communityJoin);
    const joinedServer =
      roomJoin && typeof roomJoin === "object"
        ? servers.find((server) => server.id === roomJoin.serverId)
        : undefined;
    return (
      <OnboardingFlow
        user={user}
        path={firstRunPath}
        entrance={!gateHandoff}
        arrival={
          firstRunPath !== "invite"
            ? null
            : inviteJoin === "failed"
              ? "failed"
              : joinedServer
                ? {
                    serverId: joinedServer.id,
                    name: joinedServer.name,
                    iconUrl: joinedServer.iconUrl ?? null,
                  }
                : inviteJoin === null && communityJoin === "failed"
                  ? null
                  : "pending"
        }
        // Keep an intent that is already waiting: a `?import=<code>` link
        // carries the template to pre-fill, and the door must not wipe it.
        onImportDiscord={() =>
          setPendingCreate((current) =>
            current?.mode === "import" ? current : { mode: "import", source: null },
          )
        }
        onUserUpdated={(updated) => {
          setUser(updated);
          chat.setCurrentUser(updated);
        }}
        onServerCreated={async (serverId) => {
          setCreatedServerIds((prev) => new Set(prev).add(serverId));
          setArrivalServerId(serverId);
          await refreshAfterJoin(serverId);
          // Only once the room is open: a marker written before a failed load
          // would suppress the banner on the reload that recovers it.
          rememberArrival(browserStorage(), serverId);
        }}
        onServerJoined={async (serverId) => {
          const storage = browserStorage();
          const firstVisit = !hasArrived(storage, serverId);
          if (firstVisit) {
            setArrivalServerId(serverId);
          }
          await refreshAfterJoin(serverId);
          if (firstVisit) {
            rememberArrival(storage, serverId);
          }
        }}
        onDone={() => {
          setNeedsOnboarding(false);
          setJustOnboarded(true);
          setGateHandoff(false);
        }}
      />
    );
  }

  const activeConversation =
    selection.kind === "dm" && selectedChannelId
      ? (conversations.find((one) => one.channelId === selectedChannelId) ??
        null)
      : null;
  /**
   * The open channel, whichever kind it is. A conversation is dressed as the
   * channel row it actually is so the whole pane below — header, list,
   * composer, attachments — keeps working on it unchanged.
   */
  const selectedChannel = activeConversation
    ? conversationChannel(activeConversation)
    : selection.kind === "server"
      ? channels.find((c) => c.id === selectedChannelId)
      : undefined;
  const selectedServer = servers.find((s) => s.id === selectedServerId);
  /** The open channel is a watch party that is on air right now. */
  const selectedPartyLive =
    selectedChannel?.kind === "server" &&
    watchParties.byChannel[selectedChannel.id]?.state === "live";

  /** True while the open server is one this account made and is alone in. */
  const ownerAloneHere =
    selectedServerId !== null &&
    createdServerIds.has(selectedServerId) &&
    serverMembers.length <= 1;

  function copyOwnerInvite(serverId: string): Promise<void> {
    return copyInvitePaste({
      serverId,
      locale,
      inviteRef: "onboarding",
    }).then(() => undefined);
  }

  /**
   * The arrival banner for whatever is on screen, or nothing. One builder for
   * the two places it mounts (the channel pane and the community home), so
   * the rule deciding what it says lives in `arrivalVariant` and nowhere else.
   */
  function renderArrivalBanner(
    surface: ArrivalSurface,
    channelName: string | null,
    inCall: boolean,
  ) {
    // A live stream is the welcome: its strip says where to go, and "say oi in
    // #general" over it is two instructions for one screen. Same call the
    // party surface makes (see `ArrivalSurface`). The Baú home keeps its own.
    if (surface !== "home" && watchNowStreams.length > 0) {
      return null;
    }
    if (
      !arrivalServerId ||
      arrivalServerId !== selectedServerId ||
      !selectedServer
    ) {
      return null;
    }
    const createdHere = createdServerIds.has(arrivalServerId);
    const variant = arrivalVariant({
      createdHere,
      // The list resets to empty on a server switch and the owner is always
      // in it, so empty means "not loaded yet".
      memberCount: serverMembers.length === 0 ? null : serverMembers.length,
      surface,
      inCall,
    });
    if (!variant) {
      return null;
    }
    const serverId = arrivalServerId;
    return (
      <ArrivalBanner
        variant={variant}
        serverName={selectedServer.name}
        channelName={channelName}
        celebrate={celebrateArrivalFor === serverId}
        onCopyInvite={
          variant === "owner" ? () => copyOwnerInvite(serverId) : undefined
        }
        onDismiss={() => setArrivalServerId(null)}
      />
    );
  }
  /**
   * A watch party room arranges its panes like a stream; a call does not.
   *
   * And a watch party room is two different stages depending on who is
   * looking at it. `"watch"` is the seated surface (`VoiceChannelStage`):
   * the host, a co-host, anyone invited up, or an audience member who took a
   * seat — the shared, proportional split a call already uses. `"watch-audience"`
   * is everybody else: a seatless viewer watching the HLS picture
   * (`WatchChannelStage`), the "party has not started" card and the "it
   * ended" card `WatchPartyPanel` draws in the same spot — all three are the
   * same pane, so they get the same Twitch-style default, chat pinned to
   * about 340px rather than a third of an ultrawide. See `watchAudienceSide`
   * in `lib/call-split.ts`.
   */
  const inSelectedWatchPartyCall =
    selectedChannel?.kind === "server" &&
    voiceState.voiceChannelId === selectedChannel.id &&
    voiceState.status !== "idle";
  const splitKind: CallSplitKind =
    selectedChannel?.kind === "server" &&
    isWatchPartyChannelType(selectedChannel.type) &&
    isWatchPartyChannelsEnabled()
      ? inSelectedWatchPartyCall
        ? "watch"
        : "watch-audience"
      : "call";
  /** Either watch-party pane kind — the one distinction most of the chrome
   * around the split actually cares about is "is this a watch party room at
   * all", not which of its two surfaces is currently up. */
  const isWatchPartySplit =
    splitKind === "watch" || splitKind === "watch-audience";
  /**
   * `party_newcomer_experience` (`lib/party-newcomer.ts`), the runtime flag
   * answered per server on `GET /api/live-hls/config?serverId=`. Off, and on
   * any server the operator has not switched on, every value below is false
   * and nothing on screen differs from before.
   */
  const partyNewcomerFacts = {
    flagOn: liveHlsConfig?.newcomerExperience,
    partyLive: Boolean(selectedPartyLive),
    audience: splitKind === "watch-audience",
    // `justOnboarded` because the wizard does not patch the local `user`
    // (`finish()` in `onboarding-flow.tsx`): in the very session a sign-up
    // finishes, `onboardedAt` is on the server and not yet in this state, and
    // that session is exactly the one this is for. A reload reads it back.
    newcomer:
      justOnboarded || isNewcomerAccount(user?.preferences?.onboardedAt),
    dismissed: partyNewcomerStripClosed,
  };
  const partyPhoneLayout = partyPhoneLayoutOn(partyNewcomerFacts);
  const partyNewcomerStrip = partyNewcomerStripVisible(partyNewcomerFacts);
  const hideDownloadHintForNewcomer =
    suppressAppInviteForNewcomer(partyNewcomerFacts);
  /**
   * THE PARTY BAR IS THE CHANNEL HEADER WHILE A PARTY IS LIVE (2026-09-18,
   * `docs/plans/WATCH_PARTY_UI.md` pass 1). Eight regions were counted on
   * the host's screen and four of them were bars; the first two said the
   * channel's name and then the party's name, one under the other. So the
   * header below is not drawn while `WatchPartyPanel` draws its live bar,
   * and what the header owned that the bar has no words for (the phone nav
   * button, pins, past broadcasts, channel settings, members) rides into
   * the bar through `headerLeading` / `headerTrailing`. Same condition as
   * `watchPartySurface`'s "live" branch, so the two can never both be up
   * or both be missing.
   *
   * `partyOwnsChannelChrome` is that condition, asked once: `CallStage`'s
   * `watchPartyChrome` below reads the same answer, because a second copy of
   * this question is what left an opaque call control bar — red hang-up and
   * all — painted over the party bar on 2026-09-18. See the module doc.
   */
  const partyOwnsHeader = (() => {
    if (
      !selectedChannel ||
      selectedChannel.kind !== "server" ||
      !isWatchPartyChannelType(selectedChannel.type) ||
      !isWatchPartyChannelsEnabled() ||
      !user
    ) {
      return false;
    }
    return partyOwnsChannelChrome({
      state: watchParties.byChannel[selectedChannel.id]?.state ?? null,
      hasStream: voiceState.channelLive[selectedChannel.id]?.stream != null,
    });
  })();
  /**
   * THE PANE HAS ONE OWNER (2026-09-18). `WatchPartyPanel`'s own surface and
   * the seatless `WatchChannelStage` both mount into the stage slot, and they
   * used to ask disjoint questions: the panel asked what this party IS to
   * this person, the stage asked only whether a playlist exists and whether
   * this person is out of the call. On a channel that still had a stream
   * going out, both said yes — so a host who pressed Criar watch party got
   * the audience picture drawn over their own private setup surface. This is
   * the one answer both of them now read; see `lib/watch-party-pane.ts`.
   */
  const watchPartyOwnsPane = (() => {
    if (
      !selectedChannel ||
      selectedChannel.kind !== "server" ||
      !isWatchPartyChannelType(selectedChannel.type) ||
      !isWatchPartyChannelsEnabled() ||
      !user
    ) {
      return false;
    }
    return watchPartyPanelOwnsPane({
      state: watchParties.byChannel[selectedChannel.id]?.state ?? null,
      hasStream: voiceState.channelLive[selectedChannel.id]?.stream != null,
      inCall:
        voiceState.voiceChannelId === selectedChannel.id &&
        voiceState.status !== "idle",
      canStart: perms.can(Permission.START_WATCH_PARTY, selectedChannel.id),
    });
  })();
  // Baú gating is computed above the early returns (it owns a hook); see
  // `communityHomeEnabled` / `communityHomeOpen` near `settleCommunityHomeIntro`.
  const meMember = serverMembers.find((member) => member.id === user?.id);
  const meVip = rankBadges(meMember?.roleIds, serverRoles).vipBadge;
  const canManageChannels = perms.can(Permission.MANAGE_CHANNELS);
  const canManageRoles = perms.can(Permission.MANAGE_ROLES);
  // Same OR the server checks (`requireWatchPartyHistoryAccess` in
  // `server/src/api/index.ts`): whoever may go live or whoever administers
  // the channel, per-channel overwrites included.
  const canViewWatchPartyHistory =
    selectedChannel?.kind === "server" &&
    isWatchPartyChannelType(selectedChannel.type) &&
    (perms.can(Permission.START_WATCH_PARTY, selectedChannel.id) ||
      perms.can(Permission.MANAGE_CHANNELS, selectedChannel.id));
  const canManageServer = perms.can(Permission.MANAGE_SERVER);
  const canManageWebhooks = perms.can(Permission.MANAGE_WEBHOOKS);
  const canManageMessages = perms.can(Permission.MANAGE_MESSAGES);
  const canManageNicknames = perms.can(Permission.MANAGE_NICKNAMES);
  /**
   * One corner card. QG first (the house), then the phone-app invite,
   * then Novidades on the rail, then cargos, then the quiet shortcuts
   * card. Attached feature hints (format bar, Watch party) sit next to
   * their control and yield while a campaign owns the corner.
   */
  const viewingThisCall = Boolean(
    voiceState.voiceChannelId &&
      (voiceState.voiceChannelId === selectedChannelId ||
        voiceState.voiceChannelId === activeConversation?.channelId),
  );
  const musicInComposer =
    voiceState.status === "connected" && viewingThisCall;
  const voiceIsDmCall = Boolean(
    voiceState.voiceChannelId &&
      conversations.some((one) => one.channelId === voiceState.voiceChannelId),
  );
  const voiceRoomSize = voiceState.voiceChannelId
    ? (voiceState.occupancy[voiceState.voiceChannelId] ?? []).length
    : 0;
  const voiceServerId = voiceIsDmCall ? null : voiceServerIdRef.current;
  const canCreateInviteForVoice =
    voiceServerId !== null &&
    voiceServerId === selectedServerId &&
    perms.can(Permission.CREATE_INVITE);
  /**
   * Whose first minutes these are, for the one-time hint under the watch-now
   * strip: they arrived in this very server in this session (an invite, a
   * community link), or their account finished first-run in the last day.
   * Somebody who has seen a hundred of these strips does not need it
   * explained.
   */
  const watchNowNewcomer =
    (arrivalServerId !== null && arrivalServerId === selectedServerId) ||
    justOnboarded ||
    isNewcomerAccount(user?.preferences?.onboardedAt);
  const attachedFeatureHint = winningFeatureHint({
    // Under the watch-now strip, once ever, for somebody who just arrived.
    watchNow: shouldOfferWatchNowHint({
      seen: !wantsWatchNowHint,
      automated: false,
      bannerVisible: watchNowStreams.length > 0,
      newcomer: watchNowNewcomer,
    }),
    // Rendered by `CallControls` in the dock's hint slot; dismissed by
    // Entendi or by pressing any control in the dock.
    callDock: shouldOfferCallDockHint({
      seen: !wantsCallDockHint,
      automated: false,
      dockVisible: callDockOnScreen,
      connected: voiceState.status === "connected",
    }),
    watchParty:
      wantsWatchPartyHint &&
      voiceState.status === "connected" &&
      voiceState.canStream &&
      supportsScreenShare(),
    bringFriends: shouldOfferBringFriendsHint({
      seen: !wantsBringFriendsHint,
      automated: false,
      presenting: voiceState.status === "connected" && voiceState.isSharingScreen,
      inServer: voiceServerId !== null,
      canInvite: canCreateInviteForVoice,
      roomSize: voiceRoomSize,
    }),
    // Before `music` in the order: they have the panel open and are looking
    // at the field, which beats a card pointing at the tile they just used.
    musicField: shouldOfferMusicFieldHint({
      seen: !wantsMusicFieldHint,
      automated: false,
      filaOpen: musicDock.open,
      canAdd: voiceState.canSpeak,
    }),
    music: shouldOfferMusicHint({
      seen: !wantsMusicHint,
      automated: false,
      connected: voiceState.status === "connected",
      canSpeak: voiceState.canSpeak,
      playing: musicDock.on,
      filaOpen: musicDock.open,
    }),
    composerFormat:
      wantsComposerFormatHint &&
      selectedChannel?.type === "text" &&
      !communityHomeOpen,
    channelPin:
      wantsChannelPinHint &&
      selection.kind === "server" &&
      Boolean(selectedServerId),
  });
  const voiceChannel =
    voiceState.voiceChannelId
      ? channels.find((c) => c.id === voiceState.voiceChannelId) ?? null
      : null;
  // Hoisted above `sidebarIconsOnly`'s original spot (near the channel-list
  // toggle further down) so the Voz limpa eligibility below can read it: the
  // nudge is rendered only in the wide sidebar footer (`!compact` in
  // `sidebarFooter`), so a compact rail must not be able to hold the corner
  // queue's `voiceClean` slot for a card nothing mounts.
  //
  // `sidebarIconsOnly` is provably `!compact`'s complement for every render
  // that can reach `VoiceCleanHint`: `sidebarFooter` has exactly three call
  // sites, and `sidebarFooter(sidebarIconsOnly)` on `ChannelList` is the
  // only one that can ever pass `compact={true}` — the other two
  // (`DmList`, `WhatsNewView`) call `sidebarFooter()` with no argument, so
  // their `compact` is always `false` regardless of `sidebarIconsOnly`.
  // Those three call sites are also why the footer carries no music embed:
  // two of them can be mounted at once (the sidebar stays mounted under
  // Novidades), and two embeds is two iframes playing the same track.
  // Gating `wantsVoiceCleanHint` on `!sidebarIconsOnly` is therefore never
  // looser than the render guard for any of the three: it can only be
  // *stricter* than necessary on the two branches where compact never
  // applies, never looser than the one branch where it does.
  const watchingAShare =
    voiceState.status === "connected" &&
    voiceState.screenSharePeerIds.some(
      (peerId) => peerId !== voiceState.peerId,
    );
  const sidebarIconsOnly = channelSidebarIconsOnly(channelSidebar, {
    // A party's stream alone does NOT fold the list: the live party block
    // lives in it, and it is the way back to the show for everybody else.
    watchingAShare,
    columnLayout,
  });
  const wantsVoiceCleanHint =
    !sidebarIconsOnly &&
    shouldOfferVoiceCleanNudge({
      dismissed: Boolean(user?.preferences?.voiceCleanNudgeDismissedAt),
      automated: isAutomatedBrowser(),
      inCall: voiceState.status === "connected",
      micOn: !voiceState.isMuted,
      presentingWatchParty:
        voiceChannel?.type === "watch_party" && voiceState.isSharingScreen,
      isDesktopViewport: voiceCleanDesktopViewport,
    });
  /** A live party, or the watch-now strip: no campaign card takes the corner. */
  const campaignsYield =
    Boolean(selectedPartyLive) || watchNowStreams.length > 0;
  const cornerHint = winningCornerHint({
    update: updatePromptShowing,
    communityHomePost: Boolean(
      communityHomePostToast &&
        communityHomePostToast.serverId === selectedServerId,
    ),
    // NO CAMPAIGN CARDS OVER A LIVE PARTY. QG, the phone app, What's new,
    // cargos and shortcuts all wait until the person is not watching a film.
    // The phone-app card is the sharp one, being a way out of the page: 8 of
    // the 51 phone sessions MoonKase's link created mid-show on 2026-09-26
    // went to /android instead of the party. Holding only that one would hand
    // the corner to the next card in line, so the whole tail yields. The
    // update notice, a Baú post and the voice nudge are not campaigns.
    //
    // THE WATCH-NOW STRIP IS THE SAME CASE. While it is on screen a stream is
    // live in this server and the strip is the one thing the newcomer is
    // being asked to do; a corner card beside it is a second request, and the
    // first thing a stranger is told must not be "join the QG" (2026-10-04,
    // Filminho). It also keeps its own one-time hint, an attached card, from
    // yielding to a campaign for the whole film.
    qg: qgHintWanted && !campaignsYield,
    voiceClean: wantsVoiceCleanHint,
    mobileBeta: wantsMobileBeta && !campaignsYield,
    whatsNew: wantsWhatsNew && !campaignsYield,
    cargos:
      wantsCargosHint &&
      qgHintReady &&
      !campaignsYield &&
      Boolean(canManageRoles && selectedServerId),
    shortcuts:
      wantsShortcutsHint &&
      shortcutsQuietReady &&
      !campaignsYield &&
      attachedFeatureHint === null,
  });
  // A DM arrival card and the bottom-right onboarding queue would collide on
  // a phone, so a toast up wins the corner for its duration — same yield the
  // update prompt already gets. The card records no impression while it
  // yields (`docs/ONBOARDING.md` §Adding a card, rule 3): `enabled` goes
  // false below, which every corner card already treats as "never rendered".
  const effectiveCornerHint = dmToastActive ? null : cornerHint;
  const liveAttachedHint =
    effectiveCornerHint === null || effectiveCornerHint === "shortcuts"
      ? attachedFeatureHint
      : null;
  /** The conversation the active call lives in, when it is a DM call. */
  const voiceConversation = voiceState.voiceChannelId
    ? (conversations.find(
        (one) => one.channelId === voiceState.voiceChannelId,
      ) ?? null)
    : null;
  // Perms are only trusted once the snapshot has landed (`serverBits` is never
  // zero for a real member), and only for server channels: a conversation has
  // no roles to lack.
  const canSendHere =
    !selectedChannel ||
    selectedChannel.kind !== "server" ||
    perms.serverBits === 0n ||
    perms.can(Permission.SEND_MESSAGES, selectedChannel.id);
  const chatDrop = chatDropVerdict({
    attachmentsEnabled: isAttachmentsEnabled,
    channelType: selectedChannel?.type ?? "",
    streamChat: isWatchPartySplit,
    canSend: canSendHere,
  });

  /**
   * Who the member sidebar would list, and therefore whether it exists here.
   *
   * A GROUP conversation gets one — three to ten people whose names are not all
   * in the header is exactly the case a participant list answers, and it is what
   * Discord shows too. A 1:1 does NOT: its "member list" is a single row naming
   * the person whose name is already the title of the window, which is chrome
   * pretending to be information.
   */
  const memberSidebarParticipants =
    activeConversation?.kind === "group"
      ? activeConversation.participants
      : null;
  const memberSidebarAvailable =
    !!selectedChannel &&
    (selection.kind === "server"
      ? selectedServerId !== null
      : memberSidebarParticipants !== null);

  // SOMEBODY ELSE is presenting in the call we are in. The one moment the
  // 16rem of channel names is worth less than the pixels it costs.
  //
  // Deliberately not "a screen is being shared", which would include our own.
  // The presenter is looking at the thing they are sharing, not at pqp, and
  // they are the person most likely to be running the room from the voice
  // seats in that very list — where the per-person volume control lives.
  // Taking the list away from the one person using it, at the moment they
  // start using it, is not a saving. The viewer, who has no reason to touch
  // the channel list while watching, is who this is for.
  //
  // (`watchingAShare` / `sidebarIconsOnly` themselves moved above the Voz
  // limpa eligibility block — same values, computed once.)
  // A plain function, not a `useCallback`: it is read below the early returns
  // that this component is full of, and nothing takes it as a dependency.
  const toggleChannelSidebar = () => {
    setChannelSidebar((previous) => {
      const iconsNow = channelSidebarIconsOnly(previous, {
        watchingAShare,
        columnLayout,
      });
      // Whichever way it is now, the click makes the opposite explicit, so the
      // share stops moving it from here on.
      const next = toggledChannelSidebarPreference(iconsNow);
      saveChannelSidebarPreference(next);
      return next;
    });
  };

  /**
   * The bottom of whichever sidebar is showing. Shared rather than duplicated:
   * an ongoing call and the mute button must not vanish because the reader
   * switched to their conversations.
   *
   * `compact` is the icons-only strip: 72px, so the call bar keeps the two
   * controls that cannot wait (which call, and the way out) and the user panel
   * stacks. Nothing is dropped that has no second home.
   */
  /**
   * NO CALL STRIP FOR A LIVE WATCH PARTY (2026-09-13, presenter-UI plan
   * §6.3). Section 10 of the setup plan retired the generic strip for a
   * watch party and the in-pane one obeyed; this one kept rendering on
   * `voiceState.status` alone, so a presenter had a red "Sair da call" in
   * the sidebar one click from Encerrar, plus a third Compartilhar tela
   * and a camera the stream never carries. The party bar and the dock say
   * everything this strip said, in the party's words. Keyed on the room
   * the person is SEATED in, not the channel they are looking at: leaving
   * the channel must not bring the strip back for a seat that is still a
   * party seat.
   */
  const seatedInLiveParty =
    voiceState.status !== "idle" &&
    voiceState.voiceChannelId !== null &&
    watchParties.byChannel[voiceState.voiceChannelId]?.state === "live";
  const sidebarFooter = (compact = false) => (
    <>
      {/* Chrome only. The embed is mounted once, below, because this
          function has three call sites and two of them can be on screen at
          the same time: the sidebar stays mounted under Novidades while
          Novidades renders its own footer. */}
      <MusicMiniPlayer
        voiceState={voiceState}
        compact={compact}
        chrome={!musicInComposer}
        embed={false}
      />
      {voiceState.status !== "idle" && !seatedInLiveParty && (
        <VoiceStatusBar
          channelName={
            voiceChannel?.name ??
            (voiceConversation
              ? conversationTitle(voiceConversation.participants)
              : t("voice.channelFallback"))
          }
          channelType={
            voiceChannel?.kind === "server" && voiceChannel.type === "text"
              ? "text"
              : "voice"
          }
          status={voiceState.status}
          isMuted={voiceState.isMuted}
          inputMode={voiceState.inputMode}
          isTransmitting={voiceState.isTransmitting}
          listenOnly={!voiceState.canSpeak}
          audienceLocked={voiceState.speakReason === "audience"}
          peerQualities={voiceState.remotePeers.flatMap((peer) =>
            peer.quality ? [peer.quality] : [],
          )}
          canStream={voiceState.canStream}
          isCameraOn={voiceState.isCameraOn}
          isSharingScreen={voiceState.isSharingScreen}
          cameraCappedOut={
            isCameraAtCap(
              voiceState.cameraPeerIds,
              voiceState.peerId,
              voiceState.roomTransport,
              voiceState.canPromoteTransport,
              meshRoomLinkOf(voiceState),
            ) && !voiceState.isCameraOn
          }
          shareCappedOut={
            isScreenShareAtCap(
              voiceState.screenSharePeerIds,
              voiceState.peerId,
              voiceState.roomTransport,
              voiceState.canPromoteTransport,
              meshRoomLinkOf(voiceState),
            ) && !voiceState.isSharingScreen
          }
          cameraLimit={videoLimitOf(voiceState, "cameras")}
          shareLimit={videoLimitOf(voiceState, "screens")}
          onToggleCamera={() => void voice.toggleCamera()}
          onToggleScreenShare={() => {
            if (voiceState.isSharingScreen) {
              void voice.stopScreenShare();
              return;
            }
            requestScreenShare();
          }}
          onOpen={() => void openVoiceChannel()}
          shareHintEnabled={
            liveAttachedHint === "watchParty" &&
            !(
              viewingThisCall &&
              voiceState.canSpeak &&
              !isDesktopApp() &&
              supportsScreenShare()
            )
          }
          bringFriendsHintEnabled={
            liveAttachedHint === "bringFriends" && !viewingThisCall
          }
          onLeave={() => voice.leave()}
          compact={compact}
          hideActions={callDockOnScreen}
        />
      )}
      {/* Anchored above the user bar, never inside the icons-only rail:
          `layout="inline"` clamps to the parent width, and 72px has no room
          for either the card or the toast. */}
      {!compact && (
        <>
          <VoiceCleanHint
            enabled={cornerHint === "voiceClean"}
            onActivate={activateVoiceClean}
            onDismiss={settleVoiceCleanNudge}
          />
          <VoiceCleanActivatedToast show={voiceCleanActivatedToast} />
        </>
      )}
      <UserPanel
        compact={compact}
        hideDownloadHint={hideDownloadHintForNewcomer}
        displayName={user?.displayName ?? "User"}
        tag={user?.tag ?? null}
        handle={user?.handle ?? null}
        avatarUrl={user?.avatarUrl ?? null}
        isMuted={voiceState.isMuted}
        serverMuted={voiceState.self?.serverMuted === true}
        isDeafened={voiceState.isDeafened}
        inVoice={voiceState.status !== "idle"}
        canSpeak={voiceState.canSpeak}
        speakReason={voiceState.speakReason}
        showUserButton={showUserButton}
        manualStatus={status.manual}
        effectiveStatus={status.effective}
        statusSaving={status.saving}
        statusError={status.error}
        onSetStatus={status.setManual}
        customStatus={customStatus.value}
        customStatusSaving={customStatus.saving}
        customStatusError={customStatus.error}
        onSetCustomStatus={customStatus.save}
        onClearCustomStatusError={customStatus.clearError}
        onToggleMute={() => voice.toggleMute()}
        onToggleDeafen={() => voice.toggleDeafen()}
        onOpenSettings={() => {
          setSettingsSection(null);
          setSettingsOpen(true);
        }}
        onOpenFeedback={() => {
          setSettingsSection("feedback");
          setSettingsOpen(true);
        }}
        onOpenHelp={() => {
          setSettingsSection("help");
          setSettingsOpen(true);
        }}
        onOpenProfile={() => {
          setSettingsSection("profile");
          setSettingsOpen(true);
        }}
      />
    </>
  );

  const chatPane = selectedChannel ? (
    <FileDropZone
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      // The whole conversation is the drop target, not the textarea: dragging a
      // screenshot onto the messages is what people actually do, and a target
      // the size of one input is a target you miss.
      mode={chatDrop.mode}
      onDrop={setDroppedItems}
      acceptLabel={t("chrome.dropToAttach")}
      refuseLabel={
        chatDrop.mode === "refuse"
          ? chatDrop.reason === "attachmentsOff"
            ? t("chrome.dropAttachmentsOff")
            : t("chrome.dropCannotSend")
          : undefined
      }
    >
      {!partyOwnsHeader && (
      <header className="flex h-14 shrink-0 items-center border-b border-ink-4/60 px-3 sm:px-4">
        <button
          type="button"
          className="mr-2 rounded-md p-1.5 hover:bg-ink-3 md:hidden"
          aria-label={t("chrome.openNav")}
          onClick={() => setMobileNavOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </button>
        {/* The channel list's own fold control lives in ITS header now,
            beside settings, members and invite (see `channelSidebarToggle`
            on `ChannelList`). */}
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate font-display text-base font-bold">
            {selectedChannel.imageUrl ? (
              <ChannelIcon channel={selectedChannel} className="h-4 w-4" />
            ) : (
              selectedChannel.isPrivate && (
                <Lock className="h-3.5 w-3.5 shrink-0 text-warning" />
              )
            )}
            {/* `#` names a channel inside a server. A conversation's title is a
                person, and hashing it renames them. Skipped once the channel
                has its own image/emoji — `ChannelIcon` above already carries
                that identity, and stacking `#` in front of it doubles up. */}
            {!selectedChannel.imageUrl &&
            selectedChannel.kind === "server" &&
            selectedChannel.type === "text" &&
            !selectedChannel.isPrivate
              ? "#"
              : ""}
            {selectedChannel.name}
          </p>
          {/* A watch party channel with a party on it has its own count on
              the bar ("N assistindo"); a second one here, of the seated
              room, says a different number about the same show. */}
          {!(isWatchPartySplit && watchParties.byChannel[selectedChannel.id]) && (
            <p className="truncate text-[11px] text-paper-muted">
              {activeConversation
                ? conversationSubtitle(activeConversation)
                : selectedChannel.topic
                  ? selectedChannel.topic
                  : `${selectedChannel.isPrivate ? t("chrome.privatePrefix") : ""}${t("chrome.peopleHere", { count: chat.getPresence().length })}`}
            </p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
          {/* The call entry points live here, always visible — the sidebar's
              hover affordance does not exist on touch, and a call you cannot
              start from your phone is a call that does not happen. */}
          {selectedChannel.kind === "server" &&
            isVoiceRoomChannelType(selectedChannel.type) &&
            // NOT IN A WATCH PARTY ROOM. The party's own bar carries the one
            // join, and this header button was one of THREE offers of the
            // same expensive action a viewer counted on one screen with a
            // party running, two of them in the primary fill. A seat costs a
            // LiveKit participant and forwarded streams; watching costs a
            // socket. See `WatchStage`'s `onJoin` for the arithmetic.
            !(
              isWatchPartyChannelType(selectedChannel.type) &&
              isWatchPartyChannelsEnabled()
            ) &&
            !(
              voiceState.voiceChannelId === selectedChannel.id &&
              voiceState.status !== "idle"
            ) && (
              <Tooltip label={t("voice.joinNamed", { name: selectedChannel.name })}>
                <button
                  type="button"
                  aria-label={t("voice.join")}
                  className="flex shrink-0 items-center gap-1.5 rounded-md bg-success/90 px-2.5 py-1.5 text-xs font-semibold text-ink hover:bg-success"
                  onClick={() =>
                    guardVoiceJoin(selectedChannel.id, () =>
                      handleJoinVoice(selectedChannel.id),
                    )
                  }
                >
                  <Phone className="h-3.5 w-3.5" />
                  {t("voice.join")}
                </button>
              </Tooltip>
            )}
          {activeConversation &&
            user &&
            (() => {
              const callChannelId = activeConversation.channelId;
              const inThisCall =
                voiceState.voiceChannelId === callChannelId &&
                voiceState.status !== "idle";
              if (inThisCall) {
                // The stage below the header already carries every control.
                return null;
              }
              const liveCount =
                voiceState.occupancy[callChannelId]?.length ?? 0;
              if (liveCount > 0) {
                return (
                  <button
                    type="button"
                    className="flex shrink-0 items-center gap-1.5 rounded-md bg-success/90 px-2.5 py-1.5 text-xs font-semibold text-ink hover:bg-success"
                    onClick={() =>
                      void handleConversationCall(callChannelId, false)
                    }
                  >
                    <Phone className="h-3.5 w-3.5" />
                    {t("call.header.joinCount", { count: liveCount })}
                  </button>
                );
              }
              return (
                <>
                  <Tooltip label={t("call.startVoice")}>
                    <button
                      type="button"
                      className={HEADER_ACTION_TILE}
                      onClick={() =>
                        void handleConversationCall(callChannelId, true)
                      }
                    >
                      <Phone className="h-4 w-4" />
                    </button>
                  </Tooltip>
                  <Tooltip label={t("call.startVideo")}>
                    <button
                      type="button"
                      className={HEADER_ACTION_TILE}
                      onClick={() =>
                        void handleConversationCall(callChannelId, true, true)
                      }
                    >
                      <Video className="h-4 w-4" />
                    </button>
                  </Tooltip>
                </>
              );
            })()}
          {/* The side-by-side / stacked switch moved into the chat pane's
              own header (2026-09-13), beside the hide controls it belongs
              with. */}
          {isChannelSessionScheduleEnabled() &&
            canManageChannels &&
            selectedChannel.kind === "server" &&
            selectedChannel.type === "voice" && (
            <Tooltip label={t("watchPartySchedule.header.schedule")}>
              <button
                type="button"
                className={HEADER_ACTION_TILE}
                data-schedule-session-button
                aria-label={t("watchPartySchedule.header.schedule")}
                onClick={() => setScheduleSheetOpen(true)}
              >
                <CalendarClock className="h-4 w-4" />
              </button>
            </Tooltip>
          )}
          <Tooltip label={t("chrome.pins")}>
            <button
              type="button"
              className={HEADER_ACTION_TILE}
              onClick={() => setPinsOpen(true)}
            >
              <Pin className="h-4 w-4" />
            </button>
          </Tooltip>
          {canViewWatchPartyHistory && selectedChannel.kind === "server" && (
            <Tooltip label={t("chrome.watchPartyHistory")}>
              <button
                type="button"
                className={HEADER_ACTION_TILE}
                data-channel-header-watch-party-history=""
                aria-label={t("chrome.watchPartyHistory")}
                onClick={() =>
                  setWatchPartyHistoryChannelId(selectedChannel.id)
                }
              >
                <History className="h-4 w-4" />
              </button>
            </Tooltip>
          )}
          {(canManageChannels || canManageRoles) &&
            selectedChannel.kind === "server" && (
            <Tooltip label={t("chrome.channelSettings")}>
              <button
                type="button"
                className={HEADER_ACTION_TILE}
                data-channel-header-settings=""
                aria-label={t("chrome.channelSettings")}
                onClick={() =>
                  setChannelSettings({
                    channelId: selectedChannel.id,
                    section: canManageChannels ? "overview" : "permissions",
                    forceAdvanced: false,
                  })
                }
              >
                <Settings className="h-4 w-4" />
              </button>
            </Tooltip>
          )}
          {/* The roster toggle, last in the row — the same position and the
              same icon Discord puts it in, because that is where the muscle
              memory of everybody arriving from Discord already points. Shown at
              every width: below the column breakpoint it opens the list as a
              drawer rather than not at all. */}
          {memberSidebarAvailable && (
            <Tooltip label={t("memberList.toggle")}>
              <button
                type="button"
                aria-pressed={memberSidebar.open && !openThread}
                data-member-sidebar-toggle=""
                className={cn(
                  HEADER_ACTION_TILE,
                  memberSidebar.open && !openThread && "text-paper",
                )}
                onClick={() => {
                  // A thread occupies the same right column as the roster. The
                  // button still means "show me the people": close the thread
                  // first, and open the list if it was already hidden.
                  if (openThread) {
                    closeThreadPanel();
                    if (!memberSidebar.open) {
                      memberSidebar.toggle();
                    }
                    return;
                  }
                  memberSidebar.toggle();
                }}
              >
                <Users className="h-4 w-4" />
              </button>
            </Tooltip>
          )}
        </div>
      </header>
      )}
      {/* Straight under the header, above everything a message could push
          around: an invited stranger's first screen otherwise says "Start the
          thread" over a markdown cheatsheet and nothing else. */}
      {isChannelSessionScheduleEnabled() &&
        selectedChannel.kind === "server" &&
        selectedChannel.type === "voice" &&
        upcomingSession && (
          <UpcomingSessionCard
            session={upcomingSession}
            now={scheduleClock}
            canManage={canManageChannels}
            onToggleReminder={handleToggleSessionReminder}
            onCancel={handleCancelSession}
            onEdit={
              canManageChannels ? () => setScheduleSheetOpen(true) : undefined
            }
          />
        )}
      {/* A stream is live somewhere the person is not looking: the one strip
          that answers "cadê o filme?". Above the arrival strip, which yields
          to it (a live stream is the welcome). Mounted whether or not there
          is one, so its exit can play. */}
      <WatchNowBanner
        streams={watchNowStreams}
        onWatch={handleWatchNowWatch}
        onDismiss={(stream) => dismissWatchNow(stream.key)}
        joiningChannelId={watchNowJoining}
        failure={watchNowFailure}
        hintAllowed={watchNowNewcomer}
      />
      {renderArrivalBanner(
        // A live party first, whatever kind of room it is running in.
        selectedPartyLive
          ? "party"
          : selectedChannel.kind === "server" && selectedChannel.type === "text"
            ? "text"
            : selectedChannel.kind === "server" &&
                selectedChannel.type === "voice"
              ? "voice"
              : "other",
        selectedChannel.kind === "server" && selectedChannel.type === "text"
          ? selectedChannel.name
          : null,
        selectedChannel.kind === "server" &&
          voiceState.voiceChannelId === selectedChannel.id &&
          voiceState.status !== "idle",
      )}
      {/* The call and the transcript, and the divider between them. The stage
          goes in `stage` and everything that used to follow it goes in the
          children, so the DOM order is the same three slots whichever way the
          two are arranged: nothing on the stage is ever unmounted by a layout
          change, which is what keeps an SFU camera delivered
          (`lib/remote-video-delivery.ts`). With no call, or a call collapsed to
          the slim bar, `CallSplit` draws no divider and sizes nothing. */}
      {/* THE PARTY'S CHROME, ABOVE THE SPLIT AND OUTSIDE BOTH PANES.
          The bar with the party's name, the options drawer and the host's
          transmission readout. It lives here rather than in the stage slot
          because collapsing the video must not take Encerrar with it: a host
          who hides the picture to read the chat still has to be able to end
          their own party. */}
      {selectedChannel.kind === "server" &&
        isWatchPartyChannelType(selectedChannel.type) &&
        isWatchPartyChannelsEnabled() &&
        user && (
          <WatchPartyPanel
            party={watchParties.byChannel[selectedChannel.id] ?? null}
            channelId={selectedChannel.id}
            channelName={selectedChannel.name}
            canStart={perms.can(
              Permission.START_WATCH_PARTY,
              selectedChannel.id,
            )}
            inCall={
              voiceState.voiceChannelId === selectedChannel.id &&
              voiceState.status !== "idle"
            }
            hasStream={
              voiceState.channelLive[selectedChannel.id]?.stream != null
            }
            isPresenting={
              voiceState.voiceChannelId === selectedChannel.id &&
              voiceState.isSharingScreen
            }
            sharePublishRecovering={
              voiceState.voiceChannelId === selectedChannel.id &&
              voiceState.sharePublishRecovering
            }
            someoneIsSharing={(
              voiceState.occupancy[selectedChannel.id] ?? []
            ).some((peer) => peer.sharingScreen)}
            audienceCount={watchAudienceCount(
              voiceState.channelLive[selectedChannel.id],
              voiceState.occupancy[selectedChannel.id],
            )}
            showViewerHint={shouldOfferWatchPartyViewerHint({
              // The newcomer strip already says what this is; two
              // explanations at once cost the picture its height.
              seen: partyNewcomerStrip,
              automated: false,
              watching:
                watchParties.byChannel[selectedChannel.id]?.state === "live" &&
                voiceState.channelLive[selectedChannel.id]?.stream != null &&
                !(
                  voiceState.voiceChannelId === selectedChannel.id &&
                  voiceState.status !== "idle"
                ),
            })}
            onCreate={() => setCreateWatchPartyOpen(true)}
            onGoLive={handleWatchPartyGoLive}
            onShareScreen={handleWatchPartyShareScreen}
            onStopShare={handleWatchPartyStopShare}
            onLeaveSeat={() => voice.leave()}
            onReplaceShare={handleWatchPartyReplaceShare}
            onEnd={handleWatchPartyEnd}
            onDiscard={handleWatchPartyDiscard}
            onOptionsChange={handleWatchPartyOptions}
            onRename={handleWatchPartyRename}
            onSchedule={handleWatchPartySchedule}
            onClaimHost={handleWatchPartyClaimHost}
            onToggleReminder={handleWatchPartyReminder}
            cohostCandidates={cohostCandidates}
            onPromoteCohost={(userId) =>
              handleWatchPartyCohost(userId, true)
            }
            onDemoteCohost={(userId) =>
              handleWatchPartyCohost(userId, false)
            }
            onJoinCall={() =>
              handleWatchPartyJoinAsAudience(selectedChannel.id)
            }
            onWatchAsAudience={() =>
              handleWatchPartyJoinAsAudience(selectedChannel.id)
            }
            onTakeTheMicrophone={() => void voice.takeTheMicrophone()}
            onStageAction={handleWatchPartyStage}
            currentUserId={user.id}
            canSpeak={voiceState.canSpeak}
            micState={
              voiceState.voiceChannelId === selectedChannel.id &&
              voiceState.status === "connected"
                ? voiceState.isMuted
                  ? "muted"
                  : voiceState.isSharingMic
                    ? "everyone"
                    : "room"
                : "off"
            }
            micInStream={voiceState.micInStream}
            onMicInStreamChange={(on) => voice.setMicInStream(on)}
            voiceTrackMode={voiceState.voiceTrackMode}
            onVoiceTrackModeChange={(mode) => voice.setVoiceTrackMode(mode)}
            voiceTrackAvailable={liveHlsConfig?.voiceTrack === true}
            lowLatencyAvailable={
              liveHlsConfig ? liveHlsConfig.lowLatency?.available === true : null
            }
            onMicGainChange={(value) => voice.setStreamMicGain(value)}
            onDisplayGainChange={(value) => voice.setStreamDisplayGain(value)}
            micLevelDb={voice.micLevelDb}
            outputLevelDb={voice.outputLevelDb}
            onToggleMute={() => voice.toggleMute()}
            isAudienceSeat={voiceState.isAudienceSeat}
            hlsMaxFrameRate={shareMaxFrameRate()}
            liveStream={
              voiceState.channelLive[selectedChannel.id]?.stream ?? null
            }
            videoQuality={localSettings.videoQuality}
            roomViewers={
              (voiceState.occupancy[selectedChannel.id] ?? []).length
            }
            transport={voiceState.roomTransport}
            cameraOn={voiceState.isCameraOn}
            onToggleCamera={() => void voice.toggleCamera()}
            slot="chrome"
            barSlot={watchPartyBarSlot}
            statusSlot={statusSlotEl}
            headerLeading={
              partyOwnsHeader ? (
                <button
                  type="button"
                  className="mr-2 rounded-md p-1.5 hover:bg-ink-3 md:hidden"
                  aria-label={t("chrome.openNav")}
                  onClick={() => setMobileNavOpen(true)}
                >
                  <Menu className="h-5 w-5" />
                </button>
              ) : undefined
            }
            headerTrailing={
              partyOwnsHeader ? (
                <ActionMenu
                  items={
                    [
                      {
                        id: "pins",
                        label: t("chrome.pins"),
                        icon: Pin,
                        onSelect: () => setPinsOpen(true),
                      },
                      canViewWatchPartyHistory
                        ? {
                            id: "history",
                            label: t("chrome.watchPartyHistory"),
                            icon: History,
                            onSelect: () =>
                              setWatchPartyHistoryChannelId(
                                selectedChannel.id,
                              ),
                          }
                        : null,
                      canManageChannels || canManageRoles
                        ? {
                            id: "settings",
                            label: t("chrome.channelSettings"),
                            icon: Settings,
                            onSelect: () =>
                              setChannelSettings({
                                channelId: selectedChannel.id,
                                section: canManageChannels
                                  ? "overview"
                                  : "permissions",
                                forceAdvanced: false,
                              }),
                          }
                        : null,
                      memberSidebarAvailable
                        ? {
                            id: "members",
                            label: t("memberList.toggle"),
                            icon: Users,
                            checked: memberSidebar.open && !openThread,
                            onSelect: () => {
                              if (openThread) {
                                closeThreadPanel();
                                if (!memberSidebar.open) {
                                  memberSidebar.toggle();
                                }
                                return;
                              }
                              memberSidebar.toggle();
                            },
                          }
                        : null,
                    ].filter(Boolean) as ContextMenuItemDef[]
                  }
                  align="end"
                >
                  <button
                    type="button"
                    className={HEADER_ACTION_TILE}
                    aria-label={t("chrome.moreActions")}
                    title={t("chrome.moreActions")}
                    data-channel-header-more=""
                  >
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </button>
                </ActionMenu>
              ) : undefined
            }
          />
        )}
      {/* CONVIDADOS (docs/plans/WATCH_PARTY_GUESTS.md). One mount line: every
          new control lives in `guests/watch-party-guests-overlay.tsx`, which
          is mounted here rather than threaded through `watch-party-panel.tsx`
          (frozen ahead of PR 538's rewrite). */}
      {selectedChannel.kind === "server" &&
        isWatchPartyChannelType(selectedChannel.type) &&
        isWatchPartyChannelsEnabled() &&
        user && (
          <WatchPartyGuestsOverlay
            party={watchParties.byChannel[selectedChannel.id] ?? null}
            currentUserId={user.id}
            inRoom={
              voiceState.voiceChannelId === selectedChannel.id &&
              voiceState.status === "connected"
            }
            micOn={!voiceState.isMuted}
            cameraOn={voiceState.isCameraOn}
            onToggleMic={() => voice.toggleMute()}
            onToggleCamera={() => void voice.toggleCamera()}
            // THE PROMISE GOES THROUGH UNCAUGHT. The overlay's own callers
            // decide how to react to a failure now: `decline` rolls its
            // dialog back open, everything else logs through its own
            // `fireGuestAction` wrapper. Catching and swallowing it here,
            // as this used to, is exactly what made a failed decline
            // indistinguishable from a successful one three lines up the
            // call stack.
            onGuestAction={(action) =>
              handleWatchPartyGuestAction(action, selectedChannel.id)
            }
            onGoOnAir={() => handleWatchPartyGuestGoOnAir(selectedChannel.id)}
            onGoOffAir={() => handleWatchPartyGuestGoOffAir(selectedChannel.id)}
            barSlot={watchPartyBarSlot}
            onOpenPeople={() => setWatchPanelTab("people")}
            className="pointer-events-none absolute inset-x-0 top-2 z-20 flex flex-col items-end gap-2 px-3 [&>*]:pointer-events-auto"
          />
        )}
      {/* WHAT IS THIS, for an account that arrived a moment ago
          (`party_newcomer_experience`). Under the party bar and above the
          split, so it costs one line of height and sits where the eye is
          already looking; nothing when the flag is off. */}
      {partyNewcomerStrip && (
        <PartyNewcomerStrip
          hostName={
            watchParties.byChannel[selectedChannel.id]?.hostDisplayName ?? ""
          }
          chatBeside={
            splitState.canSideBySide &&
            effectiveOrientation(callSplit, splitKind) === "side-by-side"
          }
          onDismiss={() => {
            dismissPartyNewcomerStrip();
            setPartyNewcomerStripClosed(true);
          }}
        />
      )}
      <CallDockProvider
        viewingChannelId={selectedChannel.id}
        onOccupiedChange={setCallDockOnScreen}
      >
      <CallSplit
        shape={stageShape}
        kind={splitKind}
        phoneChatFloor={partyPhoneLayout}
        preference={callSplit}
        onPreferenceChange={handleCallSplitChange}
        onSplitStateChange={handleSplitState}
        // No header while the call is docked in the composer: the header
        // exists to sit between a stage and the transcript, and there is
        // no stage above the transcript then.
        chatHeader={callDockOnScreen ? undefined : {
          title: t("chat.paneTitle"),
          tabs: partyOwnsHeader
            ? {
                items: [
                  { id: "chat", label: t("chat.paneTitle") },
                  {
                    id: "people",
                    label: t("watchParty.panel.people"),
                    // One person can be in both queues (a legacy hand and
                    // a guests request); the panel lists them once, so the
                    // badge counts them once too.
                    count: (() => {
                      const party = watchParties.byChannel[selectedChannel.id];
                      if (!party) return 0;
                      const requests = party.guests?.requests ?? [];
                      const ids = new Set(requests.map((p) => p.userId));
                      const extraHands = party.stage.hands.filter(
                        (p) => !ids.has(p.userId),
                      ).length;
                      const hiddenRequests = Math.max(
                        0,
                        (party.guests?.requestCount ?? 0) - requests.length,
                      );
                      return requests.length + extraHands + hiddenRequests;
                    })(),
                  },
                ],
                active: watchPanelTab,
                onSelect: (id) =>
                  setWatchPanelTab(id === "people" ? "people" : "chat"),
              }
            : undefined,
          meta:
            splitKind === "watch"
              ? t("watchParty.live.viewers", {
                  count: watchAudienceCount(
                    voiceState.channelLive[selectedChannel.id],
                    voiceState.occupancy[selectedChannel.id],
                  ),
                })
              : undefined,
          badge: (() => {
            const seconds =
              splitKind === "watch"
                ? (watchParties.byChannel[selectedChannel.id]?.options
                    .slowModeSeconds ?? 0)
                : 0;
            return seconds > 0
              ? t("watchParty.summary.slow", { value: t(slowModeKey(seconds)) })
              : undefined;
          })(),
          orientation: {
            sideBySide:
              effectiveOrientation(callSplit, splitKind) === "side-by-side",
            canToggle: splitState.canSideBySide,
            onToggle: () => toggleSplitOrientation(splitKind),
          },
        }}
        stage={
          <>
      {/* The conversation's call surface: invisible until a call exists, a
          join banner while others talk, the full stage once we are in. */}
      {/* Watch mode without a seat: the channel's HLS stream, for someone
          who opened a live room and did not press Entrar. Nothing at all
          for a quiet room, and nothing once they are in the call (the stage
          above takes over). */}
      {/* The watch party EVENT: the empty stage with its create button, the
          host's private setup surface, the scheduled card, and the live bar.
          It never draws the picture (`WatchChannelStage` below does), but it
          IS what speaks when a party is live and no picture has started, which
          is the case that used to render nothing at all. */}
      {selectedChannel.kind === "server" &&
        isWatchPartyChannelType(selectedChannel.type) &&
        isWatchPartyChannelsEnabled() &&
        user && (
          <WatchPartyPanel
            party={watchParties.byChannel[selectedChannel.id] ?? null}
            channelId={selectedChannel.id}
            channelName={selectedChannel.name}
            canStart={perms.can(
              Permission.START_WATCH_PARTY,
              selectedChannel.id,
            )}
            inCall={
              voiceState.voiceChannelId === selectedChannel.id &&
              voiceState.status !== "idle"
            }
            hasStream={
              voiceState.channelLive[selectedChannel.id]?.stream != null
            }
            isPresenting={
              voiceState.voiceChannelId === selectedChannel.id &&
              voiceState.isSharingScreen
            }
            sharePublishRecovering={
              voiceState.voiceChannelId === selectedChannel.id &&
              voiceState.sharePublishRecovering
            }
            someoneIsSharing={(
              voiceState.occupancy[selectedChannel.id] ?? []
            ).some((peer) => peer.sharingScreen)}
            audienceCount={watchAudienceCount(
              voiceState.channelLive[selectedChannel.id],
              voiceState.occupancy[selectedChannel.id],
            )}
            showViewerHint={shouldOfferWatchPartyViewerHint({
              // The newcomer strip already says what this is; two
              // explanations at once cost the picture its height.
              seen: partyNewcomerStrip,
              automated: false,
              watching:
                watchParties.byChannel[selectedChannel.id]?.state === "live" &&
                voiceState.channelLive[selectedChannel.id]?.stream != null &&
                !(
                  voiceState.voiceChannelId === selectedChannel.id &&
                  voiceState.status !== "idle"
                ),
            })}
            onCreate={() => setCreateWatchPartyOpen(true)}
            onGoLive={handleWatchPartyGoLive}
            onShareScreen={handleWatchPartyShareScreen}
            onStopShare={handleWatchPartyStopShare}
            onLeaveSeat={() => voice.leave()}
            onReplaceShare={handleWatchPartyReplaceShare}
            onEnd={handleWatchPartyEnd}
            onDiscard={handleWatchPartyDiscard}
            onOptionsChange={handleWatchPartyOptions}
            onRename={handleWatchPartyRename}
            onSchedule={handleWatchPartySchedule}
            onClaimHost={handleWatchPartyClaimHost}
            onToggleReminder={handleWatchPartyReminder}
            cohostCandidates={cohostCandidates}
            onPromoteCohost={(userId) =>
              handleWatchPartyCohost(userId, true)
            }
            onDemoteCohost={(userId) =>
              handleWatchPartyCohost(userId, false)
            }
            onJoinCall={() =>
              handleWatchPartyJoinAsAudience(selectedChannel.id)
            }
            onWatchAsAudience={() =>
              handleWatchPartyJoinAsAudience(selectedChannel.id)
            }
            onTakeTheMicrophone={() => void voice.takeTheMicrophone()}
            onStageAction={handleWatchPartyStage}
            currentUserId={user.id}
            canSpeak={voiceState.canSpeak}
            micState={
              voiceState.voiceChannelId === selectedChannel.id &&
              voiceState.status === "connected"
                ? voiceState.isMuted
                  ? "muted"
                  : voiceState.isSharingMic
                    ? "everyone"
                    : "room"
                : "off"
            }
            micInStream={voiceState.micInStream}
            onMicInStreamChange={(on) => voice.setMicInStream(on)}
            voiceTrackMode={voiceState.voiceTrackMode}
            onVoiceTrackModeChange={(mode) => voice.setVoiceTrackMode(mode)}
            voiceTrackAvailable={liveHlsConfig?.voiceTrack === true}
            lowLatencyAvailable={
              liveHlsConfig ? liveHlsConfig.lowLatency?.available === true : null
            }
            onMicGainChange={(value) => voice.setStreamMicGain(value)}
            onDisplayGainChange={(value) => voice.setStreamDisplayGain(value)}
            micLevelDb={voice.micLevelDb}
            outputLevelDb={voice.outputLevelDb}
            onToggleMute={() => voice.toggleMute()}
            isAudienceSeat={voiceState.isAudienceSeat}
            hlsMaxFrameRate={shareMaxFrameRate()}
            liveStream={
              voiceState.channelLive[selectedChannel.id]?.stream ?? null
            }
            videoQuality={localSettings.videoQuality}
            roomViewers={
              (voiceState.occupancy[selectedChannel.id] ?? []).length
            }
            transport={voiceState.roomTransport}
            cameraOn={voiceState.isCameraOn}
            onToggleCamera={() => void voice.toggleCamera()}
            slot="surface"
            /* The pane owns this surface's height, exactly as it owns
               `WatchChannelStage`'s and `VoiceChannelStage`'s below. This
               component was the only one of the three that never got told,
               which is why hiding the chat left a band of empty pane under
               the setup surface. */
            fill={splitState.active}
            onShapeChange={handleWatchPartyShape}
          />
        )}
      {/* THE BAR'S HOME ON THE STAGE PANE, while a party is live. The
          party panel (chrome slot, above the split) and the guests overlay
          portal their controls here. Empty, it draws nothing. */}
      {partyOwnsHeader &&
        (stageShape === "expanded" || stageShape === "fullscreen") && (
          <>
            <WatchPartyBarSlot placement="status" onElement={setStatusSlotEl} />
            <WatchPartyBarSlot placement="stage" onElement={setStageBarEl} />
          </>
        )}
      {/* THE STAGE IS NOT MOUNTED HERE ANY MORE, only addressed. The watch
          surface lives at the root of this component so that clicking another
          channel cannot unmount it (and destroy hls.js with it); this is the
          hole it is teleported into while its own channel is the open one.
          `display: contents`, so the pane measures exactly what it did
          before. See `watch-dock.tsx`. */}
      {watchDock.placement === "stage" && user && (
        <WatchStageOutlet host={watchDock.host} home={watchDock.dockRef} />
      )}
      {selectedChannel.kind === "server" &&
        isVoiceRoomChannelType(selectedChannel.type) &&
        user && (
          <VoiceChannelStage
            fill={splitState.active}
            onShapeChange={handleStageShape}
            // Section 10 of docs/plans/WATCH_PARTY_SETUP_UX.md: in a channel
            // with a party on it, the party bar is the only bar. Mute, the
            // hand, Sair do palco, the share and Encerrar all live there in
            // the party's words; the strip's camera and cursor do not apply
            // to a stream that never carries them.
            //
            // THE SAME ANSWER `partyOwnsHeader` GOT, not a second reading of
            // the store. Asking `state === "live"` here while the bar was
            // drawn for `live` OR `scheduled && hasStream` left both bars up
            // at once, the call one on top, and a host pressed its hang-up
            // by aiming at the party's controls (`lib/watch-party-chrome.ts`).
            watchPartyChrome={splitKind === "watch" && partyOwnsHeader}
            // The channel's own type, not `watchParties.byChannel[...]?.state`:
            // that store's own fetch/socket can still be catching up the
            // instant a seat lands, and `VoiceChannelStage` never mounts
            // `CallStage` before the seat does. See `CallStage.isWatchPartyChannel`.
            isWatchPartyChannel={isWatchPartySplit}
            presenterStage={(stream) => (
              /* ONE STAGE (pass 3 of `docs/plans/WATCH_PARTY_UI.md`): what
                 the audience sees once the transcode is up, the host's own
                 capture until then, the reconnecting pill over either. The
                 room's activity is in the chat column (pass 4). */
              <div className="flex h-full min-h-0 w-full flex-col">
                <WatchPartyStage
                  state={
                    voiceState.voiceChannelId === selectedChannel.id &&
                    voiceState.sharePublishRecovering
                      ? "reconnecting"
                      : voiceState.channelLive[selectedChannel.id]?.stream
                        ? "live"
                        : stream
                          ? "preparing"
                          : "holding"
                  }
                  hostSide
                  captureStream={stream}
                  liveStream={
                    voiceState.channelLive[selectedChannel.id]?.stream ?? null
                  }
                  className="min-h-0 flex-1"
                />
              </div>
            )}
            channelId={selectedChannel.id}
            channelName={selectedChannel.name}
            serverName={selectedServer?.name ?? null}
            serverIconUrl={selectedServer?.iconUrl ?? null}
            currentUser={{
              id: user.id,
              displayName: user.displayName,
              avatarUrl: user.avatarUrl,
            }}
            voiceState={voiceState}
            videoQuality={localSettings.videoQuality}
            screenFrameRate={localSettings.screenFrameRate}
            onLeave={() => voice.leave()}
            onToggleMute={() => voice.toggleMute()}
            onDismissMicFallbackNotice={() => voice.dismissMicFallbackNotice()}
            onToggleCamera={() => void voice.toggleCamera()}
            onVideoQualityChange={handleVideoQualityChange}
            onScreenFrameRateChange={handleScreenFrameRateChange}
            onStartScreenShare={requestScreenShare}
            onShareWithoutSound={() => {
              startScreenShareGated(false);
            }}
            onStopScreenShare={() => void voice.stopScreenShare()}
            onFocusScreenShare={(peerId) => voice.focusScreenShare(peerId)}
            inputMode={voiceState.inputMode}
            pushToTalkKeyLabel={
              supportsKeyBinding()
                ? formatBinding(localSettings.pushToTalkKey)
                : null
            }
            windowFocused={windowFocused}
            onPushToTalk={handlePushToTalk}
            onSetPeerVolume={(userId, volume) =>
              voice.setPeerVolume(userId, volume)
            }
            onSetScreenVolume={(userId, volume) =>
              voice.setScreenVolume(userId, volume)
            }
            onDismissShare={(peerId) => voice.dismissShare(peerId)}
            onWatchShare={(peerId) => voice.watchShare(peerId)}
            onRetryPeer={(peerId) => {
              void voice.retryPeer(peerId);
            }}
            onToggleRaisedHand={() => voice.toggleRaisedHand()}
            canLowerHands={perms.can(
              Permission.MUTE_MEMBERS,
              selectedChannel.id,
            )}
            onLowerHand={(userId) => void handleLowerOccupantHand(userId)}
            audienceHost={audienceHostFor(selectedChannel)}
            compactPeers={localSettings.compactPeers}
          />
        )}
      {activeConversation && user && (
        <DmCallStage
          fill={splitState.active}
          onShapeChange={handleStageShape}
          conversation={activeConversation}
          currentUser={{
            id: user.id,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
          }}
          voiceState={voiceState}
          videoQuality={localSettings.videoQuality}
          screenFrameRate={localSettings.screenFrameRate}
          onJoinCall={() =>
            void handleConversationCall(activeConversation.channelId, false)
          }
          onLeave={() => voice.leave()}
          onToggleMute={() => voice.toggleMute()}
          onDismissMicFallbackNotice={() => voice.dismissMicFallbackNotice()}
          onToggleCamera={() => void voice.toggleCamera()}
          onVideoQualityChange={handleVideoQualityChange}
          onScreenFrameRateChange={handleScreenFrameRateChange}
          onStartScreenShare={requestScreenShare}
          onShareWithoutSound={() => {
            startScreenShareGated(false);
          }}
          onStopScreenShare={() => void voice.stopScreenShare()}
          onFocusScreenShare={(peerId) => voice.focusScreenShare(peerId)}
          onToggleRaisedHand={() => voice.toggleRaisedHand()}
          compactPeers={localSettings.compactPeers}
        />
      )}
          </>
        }
      >
      {/* PESSOAS (pass 4): the same column, a different body. The composer
          below stays on every tab. */}
      {partyOwnsHeader &&
      watchPanelTab === "people" &&
      watchParties.byChannel[selectedChannel.id] &&
      user ? (
        <WatchPartyPeoplePanel
          party={watchParties.byChannel[selectedChannel.id]!}
          runsTheParty={
            watchParties.byChannel[selectedChannel.id]!.viewerRole === "host" ||
            watchParties.byChannel[selectedChannel.id]!.viewerRole === "cohost"
          }
          roster={voiceState.occupancy[selectedChannel.id] ?? []}
          audienceCount={watchAudienceCount(
            voiceState.channelLive[selectedChannel.id],
            voiceState.occupancy[selectedChannel.id],
          )}
          max={WATCH_PARTY_MAX_GUESTS}
          candidates={cohostCandidates}
          onAccept={(userId) =>
            void handleWatchPartyGuestAction(
              { action: "accept", userId },
              selectedChannel.id,
            )
          }
          onDecline={(userId) =>
            void handleWatchPartyGuestAction(
              { action: "decline", userId },
              selectedChannel.id,
            )
          }
          onRemove={(userId) =>
            void handleWatchPartyGuestAction(
              { action: "remove", userId },
              selectedChannel.id,
            )
          }
          onInvite={(userId) =>
            void handleWatchPartyGuestAction(
              { action: "invite", userId },
              selectedChannel.id,
            )
          }
          onStageAction={handleWatchPartyStage}
        />
      ) : (
      <MessageList
        onCopyOwnerInvite={
          ownerAloneHere && selectedServerId && selectedChannel.kind === "server"
            ? () => copyOwnerInvite(selectedServerId)
            : undefined
        }
        messages={chat.getMessages()}
        participants={activeConversation?.participants}
        currentUserId={user?.id ?? null}
        currentUsername={user?.username ?? null}
        serverId={selectedServerId}
        channelId={selectedChannel.id}
        variant={isWatchPartySplit ? "stream" : "default"}
        streamBadges={isWatchPartySplit ? streamBadges : null}
        isLoading={messagesLoading}
        historyFailed={historyFailedChannelId === selectedChannel.id}
        onRetryHistory={handleRetryHistory}
        hasMore={chat.hasMoreHistory()}
        hasNewer={chat.hasNewerHistory()}
        isLoadingOlder={chat.isLoadingOlder()}
        isLoadingNewer={chat.isLoadingNewer()}
        typingUsers={chat.getTypingUsers()}
        canModerate={canManageMessages}
        blockedAuthorIds={blockedUserIds}
        highlightMessageId={highlightMessageId}
        onHighlightHandled={clearHighlight}
        onReplyTo={setReplyTarget}
        onToggleReaction={chat.toggleReaction}
        onVotePoll={chat.votePoll}
        onClosePoll={chat.closePoll}
        onLoadOlder={chat.loadOlder}
        onLoadNewer={loadNewerHistory}
        onJumpToMessage={jumpToMessage}
        onJumpToPresent={jumpToPresent}
        onEditMessage={chat.editMessage}
        onDeleteMessage={chat.deleteMessage}
        // Server channels only: a conversation has no moderators, and the
        // endpoint refuses one. Offering the mode there would be a menu entry
        // whose confirm ends in a 404.
        onBulkDelete={
          selectedChannel.kind === "server" && canManageMessages
            ? handleBulkDeleteSelected
            : undefined
        }
        onPinMessage={chat.pinMessage}
        onUnpinMessage={chat.unpinMessage}
        onReportMessage={handleReportMessage}
        onRetryMessage={chat.retryMessage}
        onDiscardMessage={chat.discardMessage}
        showLinkEmbeds={localSettings.showLinkEmbeds}
        // --- threads --- offered only inside a server: a conversation already
        // is the scoped side-conversation a thread would create. Both
        // handlers are already stable `useCallback`s (see their own
        // definitions); the ternary below only ever resolves to one of two
        // stable values — the handler or `undefined` — so it does not
        // reintroduce the fresh-closure-per-render problem a wrapper arrow
        // function here would.
        onStartThread={
          selectedChannel.kind === "server" && selectedChannel.type === "text"
            ? handleStartThread
            : undefined
        }
        onOpenThread={
          selectedChannel.kind === "server" ? openThreadPanel : undefined
        }
        unreadThreadIds={unreadThreadIds}
        activeThreadId={openThread?.thread.channelId ?? null}
        authors={messageAuthors}
        roles={serverRoles}
        unreadHeld={unreadHeldIds.has(selectedChannel.id)}
        unreadSince={unreadSince}
        editMessageId={editMessageId}
        onEditMessageHandled={clearEditMessageId}
        onForward={setForwardMessage}
        onMarkUnread={handleMarkUnread}
        onMarkRead={handleMarkRead}
        onLiveEndChange={handleMessageListLiveEnd}
      />
      )}
      {/* THE ROOM'S ACTIVITY, IN THE CHAT COLUMN (pass 4): joins, hands with
          a Chamar beside them, reaction bursts, as a strip above the
          composer that folds to one line. Host and co-hosts only; it is a
          moderation surface. */}
      {partyOwnsHeader &&
        watchPanelTab === "chat" &&
        (watchParties.byChannel[selectedChannel.id]?.viewerRole === "host" ||
          watchParties.byChannel[selectedChannel.id]?.viewerRole === "cohost") && (
          <WatchPartyActivityFeed
            collapsible
            className="shrink-0"
            channelId={selectedChannel.id}
            audienceCount={feedAudienceCount(
              voiceState.channelLive[selectedChannel.id],
              voiceState.occupancy[selectedChannel.id],
            )}
            hands={watchParties.byChannel[selectedChannel.id]?.stage.hands ?? []}
            onInvite={(userId) => void handleWatchPartyStage("invite", userId)}
          />
        )}
      {/* Against the composer it explains, not floating in a corner: the frame
          names the channel the refused action happened in, so a notice from
          another room would be answering a question nobody asked here. */}
      {sanctionNotice && sanctionNotice.channelId === selectedChannel.id && (
        <SanctionNoticeBar
          notice={sanctionNotice}
          onDismiss={() => setSanctionNotice(null)}
        />
      )}
      <MessageComposer
        variant={isWatchPartySplit ? "stream" : "default"}
        // Remount per channel: the draft is component state, so without this a
        // half-typed message follows you into the next channel, one Enter away
        // from the wrong audience.
        key={selectedChannel.id}
        voiceNotesServerId={
          selectedChannel.kind === "server" ? selectedServerId : null
        }
        onSend={(body, attachments) => {
          if (unreadHoldRef.current.has(selectedChannel.id)) {
            clearUnread(selectedChannel.id);
          }
          lastOwnSendAtRef.current.set(selectedChannel.id, Date.now());
          chat.sendMessage(body, replyTarget, attachments);
          trackFirstAction("arrival_first_message");
          setReplyTarget(null);
        }}
        onTyping={() => chat.notifyTyping()}
        insertText={composerInsert}
        onInsertConsumed={() => setComposerInsert(null)}
        channelId={selectedChannel.id}
        droppedItems={droppedItems}
        onDroppedItemsConsumed={() => setDroppedItems(null)}
        replyTarget={replyTarget}
        onCancelReply={() => setReplyTarget(null)}
        mentionCandidates={mentionCandidates}
        onEditLastOwn={() => {
          const last = findLastOwnEditableMessage(
            chat.getMessages(),
            user?.id ?? null,
          );
          if (!last) {
            return false;
          }
          setEditMessageId(last.id);
          return true;
        }}
        slashContext={{
          updateDisplayName: async (name: string) => {
            const updated = await updateMe({ displayName: name });
            setUser(updated);
            chat.setCurrentUser(updated);
          },
          openInvite: (mode: "create" | "join") => setInviteMode(mode),
          joinByCode: async (code: string) => {
            const result = await joinInvite(code);
            await refreshAfterJoin(result.serverId);
          },
          setMuted: (muted: boolean) => voice.setMuted(muted),
          isInVoice: voiceState.status === "connected",
          isMuted: voiceState.isMuted,
          sendChance: (request) => chat.sendChance(request),
          sendPoll: (request) => chat.sendPoll(request),
          // Same gate and same dialog as the channel menu's "clear recent
          // messages": /clear is a shortcut into it, not a second path.
          canPurgeMessages: Boolean(
            selectedChannel &&
              selectedChannel.kind === "server" &&
              (selectedChannel.type === "text" ||
                isWatchPartyChannelType(selectedChannel.type)) &&
              perms.can(Permission.MANAGE_MESSAGES, selectedChannel.id),
          ),
          openPurgeDialog: (count) => {
            if (selectedChannel) {
              setPurgeChannel({
                id: selectedChannel.id,
                name: selectedChannel.name,
                initialCount: count,
              });
            }
          },
        }}
        disabled={!selectedChannelId || messagesLoading}
        slowModeUntil={chat.getSlowModeHeldUntil() || null}
        placeholder={t("composer.placeholder", { name: selectedChannel.name })}
        // The voice-only call bar, when this channel is the one we are in.
        // Keyed by channel so the composer of any other channel stays plain.
        dock={<CallDockOutlet channelId={selectedChannel.id} />}
        music={
          musicInComposer ? <MusicComposer voiceState={voiceState} /> : undefined
        }
      />
      </CallSplit>
      </CallDockProvider>
    </FileDropZone>
  ) : null;

  // The second half of the hand-rolled memoization declared near the top of
  // this function (see the comment there): plain code, not a hook, so it is
  // fine for it to run down here — after the early returns, where
  // `selectedServer` actually exists.
  {
    const favoriteChannelIdsRaw = selectedServer
      ? favoritesForServer(user?.preferences?.favoriteChannels, selectedServer.id)
      : EMPTY_FAVORITE_CHANNEL_IDS;
    const favoriteChannelIdsKey = favoriteChannelIdsRaw.join(",");
    if (favoriteChannelIdsKey !== favoriteChannelIdsKeyRef.current) {
      favoriteChannelIdsKeyRef.current = favoriteChannelIdsKey;
      favoriteChannelIdsRef.current = favoriteChannelIdsRaw;
    }
  }
  const favoriteChannelIds = favoriteChannelIdsRef.current;

  return (
    // The friends snapshot, published to everything that draws a relationship:
    // the view, every profile card, and the two badges. Outside the popover
    // provider because the card is one of its consumers.
    <FriendsContext.Provider value={friends}>
    <BringFriendsServerProvider
      serverId={voiceServerId}
      canCreateInvite={canCreateInviteForVoice}
    >
    <FeatureHintProvider
      winner={attachedFeatureHint}
      /* Standing aside for a corner card, not a gate turning off: the
         attached card hides and spends nothing. */
      yielding={liveAttachedHint === null && attachedFeatureHint !== null}
    >
    {/* One provider for the whole app: the profile card is opened from the
        transcript, the members panel and the conversation list, and every one of
        them wants the same block list, the same "open this DM" navigation and
        the same report dialog that already live up here. */}
    <ProfilePopoverProvider
      currentUserId={user?.id ?? null}
      blockedUserIds={blockedUserIds}
      moderation={cardModeration}
      watchParty={cardWatchParty}
      onOpenConversation={(conversation) => {
        setConversations((prev) => upsertConversation(prev, conversation));
        void selectConversation(conversation.channelId);
      }}
      // The card's phone. The conversation has just been created or reused by
      // the card itself, so all that is left is what the DM list's own phone
      // does: put the row in the sidebar, then join the call already running in
      // it or start ringing. One path, one set of rules about who may be rung.
      onStartCall={(conversation) => {
        setConversations((prev) => upsertConversation(prev, conversation));
        handleStartConversationCall(conversation.channelId);
      }}
      // The depoimento composer's DM fork lands here: the conversation has just
      // been selected above, and the composer remounts per channel, so its
      // insert effect picks this up on mount with the text already in it.
      onComposeDraft={(text) => setComposerInsert(text)}
      onMention={(username) => setComposerInsert(`@${username}`)}
      roles={serverRoles}
      onBlockUser={(userId) => void handleBlockUser(userId)}
      onUnblockUser={(userId) => void handleUnblockUser(userId)}
      onReportUser={(subject) =>
        setReportTarget({
          kind: "user",
          userId: subject.id,
          subjectName: subject.displayName,
          // Reported from inside a server, so that server's moderators are the
          // ones who see it; from a conversation it goes to the instance.
          serverId: selectedServerId,
        })
      }
    >
    {/* `app-shell`, not `overflow-hidden`: see index.css. A hidden box is
        still a scroll container that script can move, and it was moved. */}
    <div className="app-shell animate-fade-in relative flex h-full">
      {/* Mounted at the root so remote audio keeps playing when you navigate
          away from the voice channel. */}
      <VoiceAudioSinks
        peers={voiceState.remotePeers}
        peerVolumes={voiceState.peerVolumes}
        screenVolumes={voiceState.screenVolumes}
        isDeafened={voiceState.isDeafened}
        outputDeviceId={localSettings.outputDeviceId}
        outputVolume={localSettings.outputVolume}
        audibleScreenPeerIds={voiceState.audibleScreenPeerIds}
        serverMutedPeerIds={voiceState.serverMutedPeerIds}
        speakLockedPeerIds={voiceState.speakLockedPeerIds}
      />

      {/* At the root and over everything, because the directory is a mode
          rather than a pane: it covers the rail it was opened from, and closing
          it puts the app back exactly where it was. Gated on
          `communitiesEnabled` as well as on the flag above, so a config that
          went off between renders cannot leave the directory on screen. */}
      {directoryOpen && communitiesEnabled && (
        <CommunitiesView
          onClose={() => setDirectoryOpen(false)}
          onCreateCommunity={() => {
            setDirectoryOpen(false);
            setShowCreateServer(true);
          }}
          onEnterCommunity={async (serverId, joinedNow) => {
            // The same welcome an invite link gets, and for the same reason:
            // the room you just walked into is a cold transcript with nothing
            // on it naming where you are. Only on a real join, and only once
            // per device — re-opening a community you are already in is not an
            // arrival.
            if (joinedNow) {
              const storage = browserStorage();
              if (!hasArrived(storage, serverId)) {
                rememberArrival(storage, serverId);
                setArrivalServerId(serverId);
              }
            }
            setDirectoryOpen(false);
            await refreshAfterJoin(serverId);
          }}
          onReport={(community) =>
            setReportTarget({
              kind: "community",
              serverId: community.id,
              subjectName: community.name,
            })
          }
        />
      )}

      <ConnectionDoctorDialog
        open={doctorOpen}
        onClose={() => setDoctorOpen(false)}
        transport={transport}
        getToken={doctorGetToken}
        onSignInAgain={signInAgain}
        appVersion="web"
      />

      {/* A voice note keeps playing across channels; this is its control
          while its own card is off screen. */}
      <VoiceNoteMiniPlayer />

      {/* Also at the root: a DM finds you wherever you are in the app. */}
      <DmToasts
        conversations={conversations}
        selectedChannelId={selectedChannelId}
        onOpen={(channelId) => void selectConversation(channelId)}
        onActiveChange={setDmToastActive}
      />

      {isChannelSessionScheduleEnabled() && (
        <>
          {/* Also at the root: a session reminder finds you wherever you are. */}
          <ChannelSessionToasts
            onOpen={(channelId) => setSelectedChannelId(channelId)}
          />
          <ScheduleSessionSheet
            open={scheduleSheetOpen}
            existing={
              upcomingSession && upcomingSession.status === "scheduled"
                ? upcomingSession
                : null
            }
            onClose={() => setScheduleSheetOpen(false)}
            onSubmit={handleScheduleSessionSubmit}
          />
        </>
      )}

      {/* No longer gated on standing in a watch party channel: the control
          is in the sidebar and there may be no such channel yet. The name in
          the copy is the server's, because that is the room being opened. */}
      {selection.kind === "server" && (
        <CreateWatchPartyDialog
          open={createWatchPartyOpen}
          onClose={() => setCreateWatchPartyOpen(false)}
          onSubmit={handleCreateWatchParty}
        />
      )}

      {/* The waitlist: at the root, because the public page's intent opens it
          wherever the person lands, including with no server open. */}
      <WatchPartyWaitlistDialog
        open={waitlistDialogOpen}
        onClose={() => {
          setWaitlistDialogOpen(false);
          setWaitlistSource(null);
        }}
        source={waitlistSource}
        servers={servers.map((server) => ({ id: server.id, name: server.name }))}
        initialServerId={selectedServerId}
      />
      <WatchPartyApprovedToasts
        cards={waitlistApprovals}
        onOpen={(serverId) => {
          setWaitlistApprovals((current) =>
            current.filter((card) => card.serverId !== serverId),
          );
          // A full load, not a selection: the server's live-hls answer is
          // cached for the page's lifetime and still says no.
          void ackWatchPartyApproval(serverId)
            .catch(() => {})
            .finally(() => {
              window.location.assign(`/app/server/${serverId}`);
            });
        }}
        onDismiss={(serverId) => {
          setWaitlistApprovals((current) =>
            current.filter((card) => card.serverId !== serverId),
          );
          void ackWatchPartyApproval(serverId).catch(() => {});
        }}
      />

      {/* Also at the root: a call rings you wherever you are in the app. */}
      <IncomingCallOverlay
        calls={voiceState.incomingCalls}
        onAccept={(conversationId) =>
          void handleConversationCall(conversationId, false)
        }
        onDecline={(conversationId) =>
          voice.declineIncomingCall(conversationId)
        }
        onDismiss={(conversationId) =>
          voice.dismissIncomingCall(conversationId)
        }
      />

      {mobileNavOpen && (
        <button
          type="button"
          className="fixed inset-0 z-20 bg-ink/70 md:hidden"
          aria-label={t("chrome.closeNav")}
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <ServerRail
        streamAlertInfo={streamAlerts.byServer}
        onServerMenuOpen={streamAlerts.ensure}
        liveServerIds={watchParties.liveServerIds}
        phoneHidden={partyPhoneLayout}
        mobileNavOpen={mobileNavOpen}
        servers={servers}
        selectedServerId={whatsNewOpen ? null : selectedServerId}
        serverUnread={serverUnread}
        homeSelected={
          selection.kind === "dm" && !whatsNewOpen && selectedPinnedId === null
        }
        homeUnread={conversationUnread}
        // Requests AND depoimentos waiting to be answered — see `waitingOnYou`
        // for why the two are one number on this badge and not two.
        friendRequestCount={waitingOnYou({
          friendRequests: friends.data.incoming.length,
          pendingDepoimentos: friends.pendingDepoimentos.length,
        })}
        communitiesSelected={directoryOpen}
        // Absent entirely with the flag off, which is what makes the compass
        // not exist rather than exist-and-refuse.
        onOpenCommunities={
          communitiesEnabled
            ? () => {
                setWhatsNewOpen(false);
                setDirectoryOpen(true);
              }
            : undefined
        }
        whatsNewSelected={whatsNewOpen}
        whatsNewUnread={whatsNewUnread}
        onOpenWhatsNew={handleOpenWhatsNew}
        updateWaiting={updateWaiting}
        onOpenUpdate={() => requestUpdatePrompt()}
        pinnedConversations={pinnedConversations}
        pinnedUnread={unread}
        selectedPinnedId={selectedPinnedId}
        onSelectPinned={(channelId) => {
          setWhatsNewOpen(false);
          void selectConversation(channelId);
          setMobileNavOpen(false);
        }}
        onUnpinConversation={handleTogglePinnedConversation}
        onSelectHome={() => {
          setWhatsNewOpen(false);
          selectHome();
          setMobileNavOpen(true);
        }}
        onSelectServer={(id) => {
          setWhatsNewOpen(false);
          setSelection({ kind: "server", serverId: id });
          void loadChannels(id);
          setMobileNavOpen(true);
        }}
        onCreateServer={() => setShowCreateServer(true)}
        onJoinServer={() => setInviteMode("join")}
        onInvite={openInviteForServer}
        onOpenMembers={openMembersForServer}
        onOpenSettings={(id) => {
          setWhatsNewOpen(false);
          setSelection({ kind: "server", serverId: id });
          setServerSettingsOpen(true);
        }}
        onLeaveServer={(id) => void handleLeaveServer(id)}
        onToggleProfileVisibility={(id, showOnProfile) =>
          void handleToggleProfileVisibility(id, showOnProfile)
        }
      />

      {/* THE ONE EMBED. Mounted here, outside every branch, because it must
          never unmount while somebody is listening: unmounting the iframe is
          what stops the sound. The footers below draw the radio and the
          queue, and carry no player of their own. */}
      <MusicMiniPlayer voiceState={voiceState} chrome={false} />

      {/* Stay mounted under Novidades so a half-typed message is still there
          when Escape puts the app back. `hidden` takes it out of layout. */}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          whatsNewOpen && "hidden",
        )}
      >
      {selection.kind === "dm" ? (
        <DmList
          conversations={conversations}
          selectedChannelId={selectedChannelId}
          unread={unread}
          isLoading={conversationsLoading}
          blockedUserIds={blockedUserIds}
          viewerId={user?.id ?? null}
          mobileOpen={mobileNavOpen}
          onMobileClose={() => setMobileNavOpen(false)}
          onSelectConversation={(id) => void selectConversation(id)}
          onStartConversation={() => setNewDmOpen(true)}
          // Home-with-nothing-selected IS the Friends view, so "open friends"
          // is just deselecting the conversation.
          friendsSelected={!selectedChannelId}
          friendRequestCount={friends.data.incoming.length}
          hasFriends={friends.data.friends.length > 0}
          onOpenFriends={selectHome}
          onHideConversation={(id) => void handleHideConversation(id)}
          pinnedChannelIds={pinnedChannelIds}
          onTogglePin={handleTogglePinnedConversation}
          onBlockUser={(person) => void handleBlockUser(person.id)}
          onUnblockUser={(id) => void handleUnblockUser(id)}
          onStartCall={handleStartConversationCall}
          activeCallChannelIds={activeConversationCallIds}
          footer={sidebarFooter()}
        />
      ) : (
        <ChannelList
          channelSidebarToggle={
            columnLayout
              ? { iconsOnly: sidebarIconsOnly, onToggle: toggleChannelSidebar }
              : undefined
          }
          server={selectedServer ?? null}
          threadsByChannel={threadsByChannel}
          unreadThreadIds={unreadThreadIds}
          onOpenThread={stableOnOpenThread}
          onLeaveThread={stableOnLeaveThread}
          onMarkThreadRead={stableOnMarkThreadRead}
          channels={channels}
          selectedChannelId={selectedChannelId}
          canManage={canManageChannels}
          canManageRoles={canManageRoles}
          canManageMessages={canManageMessages}
          isLoading={channelsLoading}
          voiceOccupancy={voiceState.occupancy}
          channelLive={voiceState.channelLive}
          channelMusic={voiceState.channelMusic}
          speakingPeerIds={voiceState.speakingPeerIds}
          activeVoiceChannelId={voiceState.voiceChannelId}
          unread={unread}
          upcomingSessionStartsAtByChannel={
            isChannelSessionScheduleEnabled()
              ? Object.fromEntries(
                  Object.values(sessionsByChannel)
                    .filter((s) => s.status === "scheduled" || s.status === "live")
                    .map((s) => [s.channelId, s.startsAt]),
                )
              : undefined
          }
          mobileOpen={mobileNavOpen}
          onMobileClose={stableOnMobileClose}
          onSelectChannel={stableOnSelectChannel}
          onJoinVoice={stableOnJoinVoice}
          liveParties={watchParties.live}
          recoveringChannelId={
            voiceState.sharePublishRecovering
              ? voiceState.voiceChannelId
              : null
          }
          pendingParty={
            Object.values(watchParties.byChannel).find(
              (party) =>
                party.serverId === selectedServerId &&
                (party.state === "draft" || party.state === "scheduled") &&
                (party.viewerRole === "host" || party.viewerRole === "cohost"),
            ) ?? null
          }
          onWatchLiveParty={stableOnWatchLiveParty}
          canStartWatchParty={canOfferWatchPartyCreate({
            // The rollout gate, not a capability check. See
            // `canOfferWatchPartyCreate`: the bit alone is on thousands of
            // roles, so the control also asks whether the OPEN server can
            // actually run one. `liveHlsConfig` is the same per-server answer
            // the screen-share disclosure already fetches above, cached for
            // the page, so this costs no extra request.
            hlsEnabled: liveHlsConfig?.enabled ?? null,
            hasPermission: perms.can(Permission.START_WATCH_PARTY),
          })}
          onCreateWatchParty={stableOnCreateWatchParty}
          watchPartyTeaser={
            shouldOfferWatchPartyTeaser({
              hlsEnabled: liveHlsConfig?.enabled ?? null,
              state: watchPartyWaitlist,
            })
              ? {
                  onList: watchPartyWaitlist?.entry?.status === "waiting",
                  onOpen: () => setWaitlistDialogOpen(true),
                }
              : null
          }
          watchPartyHistoryChannels={watchPartyHistoryChannels}
          onOpenWatchPartyHistory={stableOnOpenWatchPartyHistory}
          currentUserId={user?.id ?? null}
          pendingMoveUserIds={pendingVoiceMoves}
          peerVolumes={voiceState.peerVolumes}
          screenVolumes={voiceState.screenVolumes}
          screenAudioUserIds={screenAudioUserIds}
          canMoveIn={stableCanMoveIn}
          canConnectIn={stableCanConnectIn}
          canMuteIn={stableCanMuteIn}
          canKickUser={stableCanKickUser}
          onMoveVoiceOccupant={stableOnMoveVoiceOccupant}
          onDisconnectVoiceOccupant={stableOnDisconnectVoiceOccupant}
          onServerMuteOccupant={stableOnServerMuteOccupant}
          onLowerOccupantHand={stableOnLowerOccupantHand}
          audienceSpeakerUserIds={
            voiceState.audience &&
            voiceState.voiceChannelId &&
            (perms.can(Permission.MUTE_MEMBERS, voiceState.voiceChannelId) ||
              perms.can(Permission.MANAGE_CHANNELS, voiceState.voiceChannelId))
              ? voiceState.audience.speakerUserIds
              : null
          }
          onAudienceSpeaker={stableOnAudienceSpeaker}
          onKickOccupant={stableOnKickOccupant}
          onSetPeerVolume={stableOnSetPeerVolume}
          onSetScreenVolume={stableOnSetScreenVolume}
          onCreateChannel={stableOnCreateChannel}
          onRenameChannel={stableOnRenameChannel}
          onOpenChannelSettings={stableOnOpenChannelSettings}
          onDeleteChannel={stableOnDeleteChannel}
          onPurgeChannel={stableOnPurgeChannel}
          onMoveChannel={stableOnMoveChannel}
          favoriteChannelIds={favoriteChannelIds}
          onFavoriteChannelIdsChange={stableOnFavoriteChannelIdsChange}
          onInvite={stableOnInvite}
          onOpenMembers={stableOnOpenMembers}
          onOpenServerSettings={stableOnOpenServerSettings}
          iconsOnly={sidebarIconsOnly}
          onExpand={stableOnExpand}
          footer={sidebarFooter(sidebarIconsOnly)}
          communityHomeEnabled={communityHomeEnabled}
          communityHomeShowNew={communityHomeRowNew}
          communityHomeUnread={communityHomeUnread}
          communityHomeSelected={communityHomeOpen}
          members={serverMembers}
          onSelectCommunityHome={stableOnSelectCommunityHome}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-transparent">
        {isDevAuthBypassEnabled() && (
          <div className="border-b border-warning/30 bg-warning/10 px-3 py-1 text-center text-xs text-warning">
            {t("chrome.devBypass")}
          </div>
        )}

        <ConnectionBanner
          status={connection}
          refusedRepeatedly={transport.getUnauthorizedStreak() >= 2}
          onRetry={() => transport.retryNow()}
          onCheck={() => setDoctorOpen(true)}
          onSignInAgain={signInAgain}
        />

        {appError && (
          <div className="flex items-start gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
            <span className="flex-1">{appError}</span>
            <button
              type="button"
              className="shrink-0 text-xs underline underline-offset-2"
              onClick={() => setAppError(null)}
            >
              {t("connection.dismiss")}
            </button>
          </div>
        )}

        {idleWarning && (
          <div className="flex items-start gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
            <span className="flex-1">
              {t("voice.idle.warning", {
                count: Math.max(
                  1,
                  Math.round((idleWarning.disconnectAt - Date.now()) / 60_000),
                ),
              })}
            </span>
            <button
              type="button"
              className="shrink-0 text-xs underline underline-offset-2"
              onClick={() => {
                // Send and wait: the banner clears on the server's
                // `voice-idle-warning-cancelled` confirmation, not on this
                // click. A socket that is closed or mid-reconnect can drop
                // this frame; clearing here regardless would tell the
                // person they are safe while the server still counts down
                // to the original deadline. Pressing again if nothing
                // happens is harmless — the server treats a repeat
                // `voice-still-here` exactly like the first one.
                transport.sendVoice({ type: "voice-still-here" });
              }}
            >
              {t("voice.idle.stillHere")}
            </button>
          </div>
        )}

        {/* Same slot, same shape, opposite tone — see `appNotice`. */}
        {appNotice && (
          <div className="flex items-start gap-3 border-b border-success/40 bg-success/10 px-4 py-2 text-sm text-success">
            <span className="flex-1">{appNotice}</span>
            {claimedHandle && <ShareHandleButton handle={claimedHandle} />}
            <button
              type="button"
              className="shrink-0 text-xs underline underline-offset-2"
              onClick={() => {
                setAppNotice(null);
                setClaimedHandle(null);
              }}
            >
              {t("connection.dismiss")}
            </button>
          </div>
        )}

        {/* Home with nothing selected is the Friends view — who is online,
            and the requests waiting on you. The generic empty state below now
            only serves the server-side selections. */}
        {selection.kind === "dm" && !selectedChannel && !channelsLoading && (
          <FriendsView
            currentUserId={user?.id ?? null}
            onOpenNav={() => setMobileNavOpen(true)}
            onOpenConversation={(conversation) => {
              setConversations((prev) => upsertConversation(prev, conversation));
              void selectConversation(conversation.channelId);
            }}
            firstRun={
              user
                ? {
                    user,
                    serverCount: servers.length,
                    onCreateServer: () => setShowCreateServer(true),
                    onJoinServer: () => setInviteMode("join"),
                    onImportDiscord: () =>
                      setPendingCreate({ mode: "import", source: null }),
                    // The avatar picker's only home is the profile section of
                    // settings, three clicks in and behind a gear nothing points
                    // at. The card is the first thing in the product that does.
                    onPickAvatar: () => {
                      setSettingsSection("profile");
                      setSettingsOpen(true);
                    },
                    onSettled: settleFirstRun,
                  }
                : undefined
            }
            extras={
              // A freshly federated account lands here with no servers at all;
              // the SSO suggestions used to live in the old empty state and
              // must keep meeting that person.
              servers.length === 0 ? (
                <SsoServerSuggestions
                  refreshKey={servers.length}
                  onJoined={(serverId) => refreshAfterJoin(serverId)}
                />
              ) : undefined
            }
          />
        )}

        {selection.kind !== "dm" &&
          !selectedChannel &&
          !communityHomeOpen &&
          !channelsLoading && (
          <div className="flex flex-1 flex-col items-start justify-center gap-4 p-8">
            <button
              type="button"
              className="rounded-md p-2 hover:bg-ink-3 md:hidden"
              aria-label={t("empty.openNav")}
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu className="h-6 w-6" />
            </button>
            <p className="font-display text-3xl font-bold">
              {servers.length === 0
                ? t("empty.noServers.title")
                : t("empty.pickChannel.title")}
            </p>
            <p className="max-w-sm text-paper-muted">
              {servers.length === 0
                ? t("empty.noServers.body")
                : t("empty.pickChannel.body")}
            </p>
            {/* The DM-view copy of this panel lives inside FriendsView's
                `extras` now — that is where a freshly federated account with
                no servers actually lands. */}
            <SsoServerSuggestions
              refreshKey={servers.length}
              onJoined={(serverId) => refreshAfterJoin(serverId)}
            />
            {servers.length === 0 && (
              <div className="flex gap-2">
                <Button onClick={() => setShowCreateServer(true)}>
                  {t("empty.createServer")}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setInviteMode("join")}
                >
                  {t("empty.joinInvite")}
                </Button>
              </div>
            )}
          </div>
        )}

        {communityHomeOpen && selectedServer && user && (
          <CommunityHomeFeed
            banner={renderArrivalBanner(
              "home",
              channels.find((channel) => channel.type === "text")?.name ?? null,
              false,
            )}
            serverId={selectedServer.id}
            serverName={selectedServer.name}
            server={selectedServer}
            feedAvailable={communityHomeFeedLive}
            homeFeatureOn={communityHomeFeatureOn}
            me={{
              id: user.id,
              displayName: user.displayName,
              username: user.username ?? null,
              tag: user.tag ?? null,
              avatarUrl: user.avatarUrl ?? null,
              customStatus: user.customStatus ?? null,
            }}
            canManageServer={canManageServer}
            isOwner={selectedServer.role === "owner"}
            isVip={meVip}
            vipEnabled={communityHomeConfig.vipEnabled}
            mediaEnabled={communityHomeConfig.mediaEnabled}
            introDismissed={Boolean(
              user.preferences?.communityHomeIntroDismissedAt,
            )}
            onDismissIntro={settleCommunityHomeIntro}
            onOpenNav={() => setMobileNavOpen(true)}
            onOpenServerSettings={() => setServerSettingsOpen(true)}
            onServerUpdated={(server) => {
              setServers((prev) =>
                prev.map((current) =>
                  current.id === server.id
                    ? mergeServerUpdate(current, server)
                    : current,
                ),
              );
            }}
            refreshSignal={communityHomeUpdateNudge}
            channels={channels}
            onOpenChannel={(channelId) => void openChannel(channelId)}
          />
        )}

        {!selectedChannel && channelsLoading && !communityHomeOpen && (
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex h-14 shrink-0 items-center border-b border-ink-4/60 px-4">
              <div className="h-5 w-36 animate-pulse rounded-md bg-ink-4/50" />
            </header>
            <MessageList
              messages={[]}
              currentUserId={null}
              isLoading
              onToggleReaction={() => {}}
            />
          </div>
        )}

        {selectedChannel?.type === "text" && chatPane}

        {selectedChannel &&
          isVoiceRoomChannelType(selectedChannel.type) &&
          chatPane}
      </main>
      </div>
      {whatsNewOpen && (
        <WhatsNewView
          mobileOpen={mobileNavOpen}
          onMobileClose={() => setMobileNavOpen(false)}
          onMobileOpen={() => setMobileNavOpen(true)}
          onClose={closeWhatsNew}
          footer={sidebarFooter()}
        />
      )}

      {/* A SIBLING OF `<main>`, not a child of the chat pane. The root is the
          app's flex row (rail | channels | chat), so slotting the roster here
          makes it a real column: the transcript reflows to the width that is
          left instead of having 15rem of itself covered up. It is also why the
          voice channel's own two-pane layout needs no change — that lives
          inside `<main>` and simply gets a narrower box. A thread takes this
          same slot: overlaying it on the transcript while the roster stayed
          put is what crushed #avisos on the QG. Stay mounted under Novidades
          so a half-typed thread reply survives. `contents` keeps the aside as
          the flex item when the feed is closed. */}
      {openThread && (
      <div className={whatsNewOpen ? "hidden" : "contents"}>
        <ThreadPanel
          thread={openThread.thread}
          origin={openThread.origin}
          controller={threadChat}
          currentUser={user}
          serverId={selectedServerId}
          // The breadcrumb and the mobile back bar name where this hangs off.
          parentChannelName={
            channels.find((c) => c.id === openThread.thread.parentChannelId)
              ?.name ?? null
          }
          onShowMembers={memberSidebarAvailable ? stashThreadForMembers : null}
          canModerate={canManageMessages}
          canSend={
            perms.serverBits === 0n ||
            perms.can(Permission.SEND_MESSAGES, openThread.thread.parentChannelId)
          }
          blockedAuthorIds={blockedUserIds}
          mentionCandidates={mentionCandidates}
          isLoading={threadLoading}
          showLinkEmbeds={localSettings.showLinkEmbeds}
          // Listed in the sidebar is what "in it" looks like to this reader.
          // A thread past the per-channel cap reads as not joined, and Join
          // is idempotent, so the worst case is a no-op tap.
          joined={(threadsByChannel[openThread.thread.parentChannelId] ?? []).some(
            (one) => one.channelId === openThread.thread.channelId,
          )}
          onToggleJoined={(joined) =>
            void handleThreadMembership(openThread.thread, joined)
          }
          onClose={closeThreadPanel}
          onReportMessage={(message) =>
            setReportTarget({
              kind: "message",
              messageId: message.id,
              subjectName: message.authorName,
            })
          }
          authors={messageAuthors}
          roles={serverRoles}
          unreadHeld={unreadHeldIds.has(openThread.thread.channelId)}
          unreadSince={threadUnreadSince}
          onForward={setForwardMessage}
          onMarkUnread={handleMarkUnread}
          onMarkRead={() => clearUnread(openThread.thread.channelId)}
          onSent={() => {
            ownThreadReplyRef.current = openThread.thread.channelId;
            if (unreadHoldRef.current.has(openThread.thread.channelId)) {
              clearUnread(openThread.thread.channelId);
            }
          }}
          slashContext={{
            updateDisplayName: async (name: string) => {
              const updated = await updateMe({ displayName: name });
              setUser(updated);
              chat.setCurrentUser(updated);
            },
            openInvite: (mode: "create" | "join") => setInviteMode(mode),
            joinByCode: async (code: string) => {
              const result = await joinInvite(code);
              await refreshAfterJoin(result.serverId);
            },
            setMuted: (muted: boolean) => voice.setMuted(muted),
            isInVoice: voiceState.status === "connected",
            isMuted: voiceState.isMuted,
          }}
        />
      </div>
      )}
      {memberSidebarAvailable && !openThread && !whatsNewOpen && (
        <MemberSidebar
          onSelectThread={
            stashedThread
              ? () =>
                  void openThreadFromSidebar(
                    stashedThread.thread,
                    // The panel already had this; re-deriving it would lose
                    // the quote for an origin that has scrolled off.
                    stashedThread.origin,
                  )
              : null
          }
          open={memberSidebar.open}
          wide={memberSidebar.wide}
          onClose={memberSidebar.close}
          serverId={
            selection.kind === "server" ? selectedServerId : null
          }
          participants={memberSidebarParticipants}
          self={
            memberSidebarParticipants && user
              ? {
                  id: user.id,
                  displayName: user.displayName,
                  username: user.username,
                  tag: user.tag,
                  avatarUrl: user.avatarUrl,
                  customStatus: user.customStatus ?? null,
                }
              : null
          }
          currentUserId={user?.id ?? null}
          role={selectedServer?.role ?? "member"}
          canManageNicknames={canManageNicknames}
          showManageRoster={canStaff}
          blockedUserIds={blockedUserIds}
          members={serverMembers}
          onMemberNickname={stableOnMemberNickname}
          onMention={stableOnMention}
          onBlockUser={stableOnBlockUser}
          onUnblockUser={stableOnUnblockUser}
          onReportUser={stableOnReportUser}
          onOpenMembersPanel={stableOnOpenMembersPanel}
          // The same context the profile card gets, so the row's menu and the
          // card cannot disagree about what this account may do to somebody.
          moderation={cardModeration}
          voiceOccupancy={voiceState.occupancy}
          voiceChannels={memberSidebarVoiceChannels}
          roles={serverRoles}
          friendIds={memberSidebarFriendIds}
        />
      )}

      {bootstrapReady &&
        (connectionProviderFromPath(location.pathname) ||
          hasStashedConnectionCallback()) && (
        <ConnectionCallbackOverlay
          onFinished={() => {
            setSettingsSection("connections");
            setSettingsOpen(true);
          }}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        requestedSection={settingsSection}
        user={user}
        localSettings={localSettings}
        voiceAnalyser={voice.getAnalyser()}
        blockedUsers={blockedUsers}
        onClose={() => setSettingsOpen(false)}
        onShowShortcutOverlay={() => setShortcutOverlayOpen(true)}
        onLocalSave={setLocalSettings}
        onUserUpdated={(updated) => {
          setUser(updated);
          chat.setCurrentUser(updated);
        }}
        onUnblockUser={handleSettingsUnblock}
        onBlockUser={handleSettingsBlock}
        onAudioSettingsLive={handleAudioSettingsLive}
        feedbackVoice={{
          inCall: voiceState.status === "connected",
          transport: voiceState.roomTransport,
          watchParty:
            voiceState.voiceChannelId != null &&
            voiceState.channelLive[voiceState.voiceChannelId]?.stream != null,
        }}
      />

      <ServerSettingsDialog
        open={serverSettingsOpen}
        server={selectedServer ?? null}
        currentUserId={user?.id ?? null}
        canManageRoles={canManageRoles}
        canManageServer={canManageServer}
        canManageWebhooks={canManageWebhooks}
        canModerateQueue={
          moderationBits.kick ||
          moderationBits.ban ||
          moderationBits.timeout
        }
        canManageMessages={canManageMessages}
        requestedSection={serverSettingsSection}
        onClose={() => {
          setServerSettingsOpen(false);
          setServerSettingsSection(undefined);
        }}
        communityHomeFeatureOn={communityHomeFeatureOn}
        onRenamed={(server) => {
          setServers((prev) =>
            prev.map((current) =>
              current.id === server.id
                ? // Settings writes update the server row, not this viewer's
                  // membership row. Keep its role and profile opt-out, and
                  // the newer copy of the Baú switch.
                  mergeServerUpdate(current, server)
                : current,
            ),
          );
          // Baú turned off while it was open: stay on Overview for a
          // community (the identity header is the homepage). A private hall
          // steps back to a real channel.
          if (
            server.id === selectedServerId &&
            !server.communityHomeEnabled &&
            !server.isCommunity &&
            isCommunityHomeChannelId(selectedChannelId)
          ) {
            const fallback = pickServerLandingTarget(channels, false, false);
            if (fallback) {
              void selectChannel(fallback.id, server.id);
            }
          }
        }}
        onOwnershipTransferred={() => {
          void fetchServers().then(({ servers: list }) => setServers(list));
        }}
        onDeleted={(serverId) => {
          setServerSettingsOpen(false);
          setServerSettingsSection(undefined);
          void dropServer(serverId);
        }}
      />

      <CreateServerDialog
        open={showCreateServer}
        startMode={createServerStart.mode}
        startSource={createServerStart.source}
        onClose={() => {
          setShowCreateServer(false);
          setCreateServerStart({ mode: "name", source: null });
        }}
        onCreated={async ({ server, channels: newChannels }) => {
          // Their own room, empty but for them: the owner banner and the
          // owner's empty channel say "bring the crew" until somebody comes.
          setCreatedServerIds((prev) => new Set(prev).add(server.id));
          rememberArrival(browserStorage(), server.id);
          setArrivalServerId(server.id);
          setServers((prev) => [...prev, server]);
          setSelection({ kind: "server", serverId: server.id });
          setChannels(newChannels);
          setAppError(null);
          const general = newChannels.find((c) => c.type === "text");
          const land = pickServerLandingTarget(
            newChannels,
            communityHomeOn() && server.communityHomeEnabled === true,
            server.isCommunity === true,
          );
          if (land) {
            await selectChannel(land.id, server.id);
          } else if (general) {
            await selectChannel(general.id, server.id);
          }
        }}
      />

      <InvitePanel
        open={inviteMode !== null}
        mode={inviteMode ?? "join"}
        serverId={selectedServerId}
        serverName={selectedServer?.name ?? null}
        canManage={canManageServer}
        canCreateInvite={
          perms.can(Permission.CREATE_INVITE)
        }
        initialCode={inviteCodeFromUrl}
        initialError={inviteErrorFromUrl}
        onClose={() => {
          setInviteMode(null);
          setInviteCodeFromUrl(null);
          setInviteErrorFromUrl(null);
        }}
        onJoined={(serverId) => {
          setInviteCodeFromUrl(null);
          setInviteErrorFromUrl(null);
          // A code typed in by hand earns the same welcome as one clicked, for
          // the same reason: the room is just as cold either way.
          const storage = browserStorage();
          if (!hasArrived(storage, serverId)) {
            rememberArrival(storage, serverId);
            setArrivalServerId(serverId);
          }
          void refreshAfterJoin(serverId);
        }}
      />

      <MembersPanel
        open={membersOpen}
        serverId={selectedServerId}
        serverName={selectedServer?.name ?? null}
        role={selectedServer?.role ?? "member"}
        bits={moderationBits}
        roles={serverRoles}
        currentUserId={user?.id ?? null}
        blockedUserIds={blockedUserIds}
        onClose={() => setMembersOpen(false)}
        onMention={(username) => {
          setComposerInsert(`@${username}`);
          setMembersOpen(false);
        }}
        onBlockUser={(userId) => void handleBlockUser(userId)}
        onUnblockUser={(userId) => void handleUnblockUser(userId)}
        onReportUser={(member) =>
          setReportTarget({
            kind: "user",
            userId: member.id,
            subjectName: member.displayName,
            // Reported from inside a server, so that server's moderators are
            // the ones who see it.
            serverId: selectedServerId,
          })
        }
        // --- voice moderation ---
        voiceOccupancy={voiceState.occupancy}
        voiceRoomTransports={voiceRoomTransports}
        voiceChannels={channels
          .filter((c) => isVoiceRoomChannelType(c.type))
          .map((c) => ({ id: c.id, name: c.name }))}
      />

      <ReportDialog
        target={reportTarget}
        onClose={() => setReportTarget(null)}
      />

      <ForwardDialog
        open={forwardMessage !== null}
        targets={forwardTargets}
        onPick={(target) => void handleForwardPick(target)}
        onClose={() => setForwardMessage(null)}
      />

      <NewDmDialog
        open={newDmOpen}
        currentUserId={user?.id ?? null}
        onClose={() => setNewDmOpen(false)}
        onCreated={(conversation) => {
          setConversations((prev) => upsertConversation(prev, conversation));
          void selectConversation(conversation.channelId);
        }}
      />

      <ChannelSettingsDialog
        open={channelSettings !== null}
        channel={
          channelSettings
            ? (channels.find((c) => c.id === channelSettings.channelId) ?? null)
            : null
        }
        requestedSection={channelSettings?.section ?? "overview"}
        forceAdvanced={channelSettings?.forceAdvanced ?? false}
        serverId={selectedServerId}
        roles={serverRoles}
        canManageChannels={canManageChannels}
        canManageRoles={canManageRoles}
        onClose={() => setChannelSettings(null)}
        onChannelUpdated={(updated) => {
          setChannels((prev) =>
            prev.map((c) => (c.id === updated.id ? updated : c)),
          );
        }}
      />

      {watchPartyHistoryChannelId && (
        <WatchPartyHistoryDialog
          open
          channelId={watchPartyHistoryChannelId}
          onClose={() => setWatchPartyHistoryChannelId(null)}
        />
      )}

      <PinnedMessagesPanel
        open={pinsOpen}
        channelId={selectedChannel?.id ?? null}
        channelName={selectedChannel?.name ?? null}
        // Mirrors MessageList's own gate: a server channel needs manage
        // permission, a conversation has no moderators so any participant may
        // unpin — the same split `requirePinAccess` enforces server-side.
        canUnpin={selectedServerId ? canManageMessages : true}
        onClose={() => setPinsOpen(false)}
        onJumpToMessage={(messageId) => void jumpToMessage(messageId)}
      />

      <BulkPurgeDialog
        open={purgeChannel !== null}
        channelName={purgeChannel?.name ?? ""}
        initialCount={purgeChannel?.initialCount}
        onConfirm={(count) => {
          if (purgeChannel) {
            void handleBulkDeleteRecent(purgeChannel.id, count);
          }
        }}
        onClose={() => setPurgeChannel(null)}
      />

      <ShareAudioPrompt
        open={shareAudioPrompt !== null}
        linux={shareAudioPrompt?.linux === true}
        onConfirm={(shareAudio) => {
          const intent = shareAudioPrompt?.intent;
          setShareAudioPrompt(null);
          startScreenShareGated(shareAudio, intent);
        }}
        onClose={() => setShareAudioPrompt(null)}
      />

      <HlsHostAckSheet
        open={pendingHlsHostAck !== null}
        confirmLabel={
          pendingHlsHostAck?.request === null
            ? t("voice.hostAck.confirmSetup")
            : undefined
        }
        onConfirm={() => {
          const pending = pendingHlsHostAck;
          if (!pending) {
            return;
          }
          void hlsHostAck.confirm(pending.serverId);
          if (!pending.request) {
            // Raised by the watch party setup surface. Nothing was waiting on
            // it; the host goes back to setting the party up, having read the
            // notice before a single frame could leave the machine.
            return;
          }
          // Same audio choice and capture intent the person asked for
          // before the sheet, through the same gate (now acknowledged).
          //
          // ONLY A GO-LIVE SHARE FINISHES THE HANDOFF, AND FOR THE PARTY IT
          // WAS ACTUALLY FOR (Farol, 2026-09-14, three rounds). `intent.stream`
          // is the signal handed only by `handleWatchPartyGoLive` (an
          // already-approved preview capture); every other caller through
          // this same gate — the ordinary call share button, a mid-show
          // reshare — has none, and must never pop the watch-party mic
          // prompt on THEIR confirm. `intent.party` travels with it rather
          // than reading `currentWatchParty()` here, because the sheet can
          // sit open for as long as the host takes to read it, the selected
          // channel is free to change in that window, and
          // `finishWatchPartyGoLiveShare` itself re-checks the party is
          // still there and still live before arming anything.
          const goLiveParty = pending.request.intent?.stream
            ? pending.request.intent.party
            : undefined;
          void startScreenShareGated(
            pending.request.audio,
            pending.request.intent,
          ).then((wentOut) => {
            if (goLiveParty) {
              finishWatchPartyGoLiveShare(
                goLiveParty.id,
                goLiveParty.channelId,
                wentOut,
              );
            }
          });
        }}
        onClose={() => setHlsHostAck(null)}
      />

      <ConfirmDialog
        open={micPromptPartyId !== null}
        title={t("watchParty.live.micPromptTitle")}
        description={t("watchParty.live.micPromptBody")}
        confirmLabel={t("watchParty.live.micPromptConfirm")}
        destructive={false}
        onConfirm={() => {
          if (voice.getState().isMuted) {
            voice.toggleMute();
          }
          setMicPromptPartyId(null);
        }}
        onClose={() => setMicPromptPartyId(null)}
      />
      <ConfirmDialog
        open={pendingDeleteChannelId !== null}
        title={t("chrome.deleteChannel")}
        description={t("chrome.deleteChannelConfirm")}
        confirmLabel={t("chrome.deleteChannel")}
        onConfirm={() => void confirmDeleteChannel()}
        onClose={() => setPendingDeleteChannelId(null)}
      />
      <ConfirmDialog
        open={pendingLeaveServerId !== null}
        title={t("chrome.leaveCommunity")}
        description={t("chrome.leaveServer")}
        confirmLabel={t("chrome.leaveCommunity")}
        onConfirm={() => void confirmLeaveServer()}
        onClose={() => setPendingLeaveServerId(null)}
      />

      <PromptDialog
        open={channelPrompt !== null}
        title={
          channelPrompt?.mode === "rename"
            ? channelPrompt.channel?.type === "category"
              ? t("chrome.renameCategory")
              : t("chrome.renameChannel")
            : channelPrompt?.type === "category"
              ? t("chrome.createCategory")
              : channelPrompt?.type === "watch_party"
                ? t("chrome.createWatchParty")
                : channelPrompt?.type === "voice"
                  ? t("chrome.createVoiceChannel")
                  : t("chrome.createTextChannel")
        }
        placeholder={t("chrome.channelNamePlaceholder")}
        secondaryPlaceholder={
          channelPrompt?.mode === "create" &&
          channelPrompt.type === "watch_party"
            ? t("chrome.watchPartyTopicPlaceholder")
            : undefined
        }
        confirmLabel={channelPrompt?.mode === "rename" ? t("chrome.rename") : t("chrome.create")}
        initialValue={
          channelPrompt?.mode === "rename"
            ? (channelPrompt.channel?.name ?? "")
            : ""
        }
        checkboxLabel={
          channelPrompt?.mode === "create" && channelPrompt.type !== "category"
            ? t("chrome.privateChannel")
            : undefined
        }
        checkboxDefault={channelPrompt?.isPrivate ?? false}
        onClose={() => setChannelPrompt(null)}
        onConfirm={(name, isPrivate, topic) =>
          handleChannelPromptConfirm(name, isPrivate, topic)
        }
      />

      <CargosHint
        enabled={effectiveCornerHint === "cargos"}
        onDismiss={() => setWantsCargosHint(false)}
        onOpenRoles={() => {
          setServerSettingsSection("roles");
          setServerSettingsOpen(true);
        }}
      />
      <CommunityHomePostHint
        enabled={effectiveCornerHint === "communityHomePost"}
        serverName={communityHomePostToast?.serverName ?? ""}
        onOpen={openCommunityHomePostToast}
        onDismiss={dismissCommunityHomePostToast}
      />
      <ShortcutsHint
        enabled={effectiveCornerHint === "shortcuts"}
        shortcutLabel={formatBinding(shortcutBindings.toggleOverlay)}
        onDismiss={() => setWantsShortcutsHint(false)}
      />
      <WhatsNewPrompt
        enabled={effectiveCornerHint === "whatsNew"}
        onOpen={handleOpenWhatsNew}
        onDismiss={() => setWantsWhatsNew(false)}
      />
      <MobileBetaHint
        enabled={effectiveCornerHint === "mobileBeta"}
        onDismiss={() => setWantsMobileBeta(false)}
      />
      <QgHint
        enabled={effectiveCornerHint === "qg"}
        onWantedChange={handleQgHintWantedChange}
        onJoined={(result) => {
          if (result.joinedNow) {
            const storage = browserStorage();
            if (!hasArrived(storage, result.serverId)) {
              rememberArrival(storage, result.serverId);
              setArrivalServerId(result.serverId);
            }
          }
          setAppNotice(
            t(
              result.joinedNow ? "handle.join.done" : "handle.join.already",
              { name: result.serverName },
            ),
          );
          void refreshAfterJoin(result.serverId);
        }}
        onFailed={() => setAppError(t("qgHint.failed"))}
      />

      {/* The dock the watch surface falls back to whenever no channel pane is
          holding it. An empty anchor: the surface's own box is `fixed`, so
          this contributes nothing to the layout. */}
      <div
        ref={watchDock.dockRef}
        data-testid="watch-dock-root"
        className="contents"
      />
      {user && watchDock.session && watchDock.placement !== "gone"
        ? createPortal(
            <WatchChannelStage
              docked={watchDock.placement === "dock"}
              fill={splitState.active}
              onShapeChange={handleWatchStageShape}
              channelId={watchDock.session.channelId}
              channelName={watchDock.session.channelName}
              serverName={watchDock.session.serverName}
              serverIconUrl={watchDock.session.serverIconUrl}
              voiceState={voiceState}
              isWatchParty={watchDock.session.isWatchParty}
              /* The party's own surface is filling this pane: stand down
                 rather than draw the audience picture over it. Only ever
                 true for the SELECTED channel, which is the only one this
                 mount is ever in a pane for. */
              partyOwnsPane={
                watchDock.session.channelId === selectedChannelId &&
                watchPartyOwnsPane
              }
              meUserId={user?.id ?? null}
              /* The party bar owns the join in a watch party room; a plain
                 voice channel with a share going out has no bar, so there
                 this is still the only way in. One control, not three. */
              onJoin={
                watchDock.session.isWatchParty
                  ? undefined
                  : () => {
                      const channelId = watchDock.session?.channelId;
                      if (channelId) {
                        guardVoiceJoin(channelId, () =>
                          handleJoinVoice(channelId),
                        );
                      }
                    }
              }
              /* STOPPING WATCHING IS LEAVING THE ROOM, and only this component
                 knows where to go instead. Watching starts by itself when the
                 channel is opened, which is right; what was missing is any way
                 to stop, so a person could not tell whether they were
                 watching, in the call, both or neither, and could not end any
                 of it. The first text channel is where the server's
                 conversation lives, so it is where "not watching any more"
                 lands. */
              onLeaveParty={
                firstTextChannelId
                  ? () => {
                      const channelId = watchDock.session?.channelId;
                      if (channelId && voiceState.voiceChannelId === channelId) {
                        voice.leave();
                      }
                      // Parar de assistir means exactly that: without this the
                      // stream would follow them into the text channel they
                      // are being sent to, which is the opposite of the ask.
                      watchDock.dismiss();
                      void selectChannel(firstTextChannelId);
                    }
                  : undefined
              }
              onReturn={returnToWatchChannel}
              onDismiss={watchDock.dismiss}
              /* A seatless viewer's bar lives on the player (pass 2). Only
                 for a watch party session: a plain voice channel with an
                 ad-hoc share has no party controls to place. */
              onBarSlot={
                watchDock.session.isWatchParty ? setPlayerBarEl : undefined
              }
              onSetWatchingLive={(channelId, watching) =>
                voice.setWatchingLive(channelId, watching)
              }
              onSeedChannelLive={(channelId, live) =>
                voice.seedChannelLive(channelId, live)
              }
            />,
            watchDock.host,
          )
        : null}

      {/* The mini player is NOT taken down on the press. A join that is
          refused, times out or is raced by a leave would otherwise cost the
          person both the call and the film they answered a question to keep.
          `useVoiceJoinGuard` closes this dialog first, runs the join, and
          dismisses the dock only once the seat is real. */}
      <ConfirmDialog
        open={joinGuard.pendingChannelId !== null}
        title={t("voice.watch.mini.joinConfirm.title")}
        description={t("voice.watch.mini.joinConfirm.body")}
        confirmLabel={t("voice.watch.mini.joinConfirm.confirm")}
        destructive={false}
        onConfirm={joinGuard.confirm}
        onClose={joinGuard.cancel}
      />

      {ratableCall && (
        // Bottom-left, clear of the channel dialogs and of the voice panel the
        // person has just left. Fixed rather than in flow so it cannot push the
        // chat around at the exact moment somebody is scrolling back through
        // what they missed.
        <div className="fixed bottom-4 left-4 z-40 w-[19rem] max-w-[calc(100vw-2rem)]">
          <CallRatingPrompt call={ratableCall} onDone={dismissCallRating} />
        </div>
      )}

      {/* Last dialog so the map stacks above Settings (and Esc hits this layer). */}
      <ShortcutOverlay
        open={shortcutOverlayOpen}
        bindings={shortcutBindings}
        pushToTalkKey={localSettings.pushToTalkKey}
        pushToTalkOn={localSettings.inputMode === "push-to-talk"}
        onClose={() => setShortcutOverlayOpen(false)}
      />

    </div>
    </ProfilePopoverProvider>
    </FeatureHintProvider>
    </BringFriendsServerProvider>
    </FriendsContext.Provider>
  );
}

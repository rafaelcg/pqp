import { SignInButton, SignUpButton, useAuth, useUser } from "@clerk/clerk-react";
import { FileText, Lock, Menu, Phone, Pin, Shield, Users, Video, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  connectionProviderFromPath,
  joinIntentFromSearch,
  normalizeHandle,
  Permission,
  publicProfileDisplayUrl,
  validateHandle,
  buildReplyExcerpt,
} from "@pqp/shared";
import type {
  AgeGateStatus,
  BlockedUser,
  Channel,
  ChannelKind,
  DmSummary,
  MemberRole,
  ProfileUpdate,
  SanctionNotice,
  Server,
  ThreadSummary,
  User,
  VoiceRoomTransport,
} from "@pqp/shared";
import { MessageComposer } from "@/components/chat/message-composer";
import { MessageList, type MessageAuthorInfo } from "@/components/chat/message-list";
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
import { ChannelMembersPanel } from "@/components/layout/channel-members-panel";
import { WebhooksPanel } from "@/components/layout/webhooks-panel";
import { ChannelMetaDialog } from "@/components/layout/channel-meta-dialog";
import { DmCallStage } from "@/components/dm/dm-call-stage";
import { IncomingCallOverlay } from "@/components/dm/incoming-call-overlay";
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
import { ProfilePopoverProvider } from "@/components/user/user-profile-popover";
import type { ProfileModerationContext } from "@/components/user/profile-relations";
import { PinnedMessagesPanel } from "@/components/chat/pinned-messages-panel";
import { ServerRail } from "@/components/layout/server-rail";
import { AgeGateDialog } from "@/components/user/age-gate-dialog";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { NewDmDialog } from "@/components/user/new-dm-dialog";
import { CargosHint } from "@/components/layout/cargos-hint";
import { QgHint } from "@/components/layout/qg-hint";
import { winningCornerHint } from "@/lib/corner-hints";
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
import { SanctionNoticeBar } from "@/components/layout/sanction-notice-bar";
import { SsoServerSuggestions } from "@/components/layout/sso-server-suggestions";
import { UserPanel } from "@/components/layout/user-panel";
import { ConnectionCallbackOverlay } from "@/components/connections/connection-callback";
import { VoiceAudioSinks } from "@/components/voice/voice-audio-sinks";
import { VoiceChannelStage } from "@/components/voice/voice-channel-stage";
import {
  formatBinding,
  supportsKeyBinding,
} from "@/components/voice/push-to-talk";
import { usePushToTalk } from "@/components/voice/use-push-to-talk";
import { useVoiceStateSync } from "@/components/voice/voice-state-sync";
import { VoiceStatusBar } from "@/components/voice/voice-status-bar";
import { CallRatingPrompt } from "@/components/voice/call-rating-prompt";
import { useCallRating } from "@/hooks/use-call-rating";
import { usePermissions } from "@/hooks/use-permissions";
import { ShareHandleButton } from "@/components/handle/share-handle-button";
import { BetaTag } from "@/components/ui/beta-tag";
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
  createChannel,
  createThread,
  createVoiceSession,
  deleteChannel,
  fetchBlocks,
  fetchChannels,
  fetchConversations,
  fetchIceServers,
  fetchMe,
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
  moveChannel,
  setAuthTokenProvider,
  unblockUser,
  updateChannel,
  updateMe,
  updatePreferences,
  type ServerMember,
  type ServerRole,
} from "@/lib/api";
import {
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
  takeAddIntent,
  takeHandleClaim,
  takeJoinIntent,
} from "@/lib/handle-intent";
import { sendFriendRequest } from "@/components/friends/friends-api";
import { shouldRunOnboarding } from "@/lib/onboarding";
import { firstRunDismissedPatch } from "@/lib/first-run";
import { browserStorage, hasArrived, rememberArrival } from "@/lib/arrival";
import { takeAcquisition } from "@/lib/acquisition";
import { reportSignupConversion } from "@/lib/google-ads";
import { ArrivalBanner } from "@/components/onboarding/arrival-banner";
import { translateMessage, useTranslation } from "@/lib/i18n";
import {
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
  HOME_SELECTION,
  selectionRoutePath,
  selectionServerId,
  type Selection,
} from "@/lib/selection";
import {
  filesFromDataTransfer,
  isFileDrag,
  loadAttachmentConfig,
} from "@/lib/attachments";
import type { MentionCandidate } from "@/lib/mention-autocomplete";
import { usernameFromTag } from "@/lib/author-display";
import { devAuthToken, getAuthToken, isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { getDesktop } from "@/lib/desktop";
import {
  describeActivity,
  notifyChannelActivity,
  rememberActivityChannel,
  rememberServers,
  unreadByServer,
} from "@/lib/notifications";
import { setSoundOutput } from "@/lib/sounds";
import { useMemberSidebar } from "@/hooks/use-member-sidebar";
import { useChannelNotifications } from "@/hooks/use-notifications";
import { useUserStatus } from "@/hooks/use-status";
import { createRealtimeTransport, type RealtimeStatus } from "@/lib/realtime";
import { adoptAccentHuePreference } from "@/lib/accent";
import { adoptAppearancePreference, getAppearance } from "@/lib/appearance";
import { adoptContrastPreference } from "@/lib/contrast";
import { adoptThemePreference, themeToAdopt } from "@/lib/theme";
import { isMeshForced } from "@/lib/voice-backend";
import type { VideoQuality } from "@/lib/video-quality";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type TokenResolver = (options?: {
  forceRefresh?: boolean;
}) => Promise<string | null>;

/** Equal-width icon tiles in the chat header (pins, topic, call, roster). */
const HEADER_ACTION_TILE =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-paper-muted hover:bg-ink-3 hover:text-paper";

interface AppProps {
  devBypass?: boolean;
}

export function App({ devBypass = false }: AppProps) {
  const { t } = useTranslation();

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

function ClerkAppGate() {
  const { t } = useTranslation();
  const { isLoaded, isSignedIn } = useAuth();
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

  if (!isLoaded) {
    return <AppLoadingShell label={t("app.loading.signingIn")} />;
  }

  if (!isSignedIn) {
    return (
      <div className="relative flex h-full flex-col items-start justify-end overflow-hidden p-8 sm:p-12">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,var(--glow-accent),transparent_40%)]" />
        <div className="animate-rise relative z-10 max-w-lg">
          <Link
            to="/"
            className="mb-3 inline-flex items-center gap-2 text-xs uppercase tracking-[0.28em] text-signal"
          >
            pqp.gg
            <BetaTag />
          </Link>
          <h1 className="font-display text-5xl font-extrabold leading-[0.95] sm:text-6xl">
            {t("signedOut.title")}
          </h1>
          <p className="mt-4 max-w-sm text-paper-muted">{t("signedOut.body")}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <SignUpButton mode="modal" forceRedirectUrl={redirectUrl}>
              <Button>{t("signedOut.createAccount")}</Button>
            </SignUpButton>
            <SignInButton mode="modal" forceRedirectUrl={redirectUrl}>
              <Button variant="secondary">{t("nav.signIn")}</Button>
            </SignInButton>
          </div>
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
  type?: "text" | "voice" | "category";
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
  const { t } = useTranslation();
  const [user, setUser] = useState<User | null>(null);
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
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<DmSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [showCreateServer, setShowCreateServer] = useState(false);
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Non-null while a caller wants a specific section on open — the user
  // menu's "send feedback", and the Steam / Battle.net / Twitch callback.
  // The gear clears it so the dialog keeps its sticky last-visited section.
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId | null>(null);
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
  const [qgHintReady, setQgHintReady] = useState(false);
  const [qgHintShowing, setQgHintShowing] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [serverSettingsSection, setServerSettingsSection] = useState<
    "roles" | undefined
  >(undefined);
  // The always-there roster down the right. Its own hook because the state is a
  // per-device preference plus a media query, and the button that flips it lives
  // in the channel header rather than in the panel.
  const memberSidebar = useMemberSidebar();
  /**
   * Two live signals the member sidebar cannot receive on its own.
   *
   * `memberRosterNudge` is bumped on any `presence-update` frame: status itself
   * is a pull surface by design (see `server/src/ws/status.ts`), but "somebody
   * just started looking at a channel in here" is a frame this client already
   * gets for nothing, and it is the same event as "somebody just came online"
   * almost every time. The sidebar debounces it into one re-read, which turns a
   * 15-second worst case into about a second for the case people actually watch.
   *
   * `lastProfileUpdate` carries a rename or a new avatar straight into the
   * roster. A fresh object per frame is what makes the sidebar's effect fire
   * even when the same person changes the same field twice.
   */
  const [memberRosterNudge, setMemberRosterNudge] = useState(0);
  const [lastProfileUpdate, setLastProfileUpdate] =
    useState<ProfileUpdate | null>(null);
  // One dialog for both subjects — the target says which. Null means closed.
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [channelMembersChannel, setChannelMembersChannel] =
    useState<Channel | null>(null);
  const [webhooksChannel, setWebhooksChannel] = useState<Channel | null>(null);
  const [channelPrompt, setChannelPrompt] = useState<ChannelPromptState | null>(
    null,
  );
  const [channelMetaChannel, setChannelMetaChannel] = useState<Channel | null>(
    null,
  );
  const [composerInsert, setComposerInsert] = useState<string | null>(null);
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [isAttachmentsEnabled, setIsAttachmentsEnabled] = useState(false);
  /**
   * `dragenter` / `dragleave` fire for every element the pointer crosses, so a
   * boolean alone flickers off the moment the drag passes over a message. Only
   * the count returning to zero means the drag has actually left the pane.
   */
  const dragDepth = useRef(0);
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
  const [unread, setUnread] = useState<Record<string, UnreadState>>({});
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [mentionMembers, setMentionMembers] = useState<MentionCandidate[]>([]);
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
  const [editMessageId, setEditMessageId] = useState<string | null>(null);
  /**
   * The selected server's roster as rank only — what the profile card needs to
   * know whether it may offer a timeout, and to whom. Filled from the same fetch
   * as `mentionMembers`, so no surface pays a second request for it.
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
  const [voiceState, setVoiceState] = useState(voice.getState());
  /**
   * The standing opt-in to sending this machine's whole sound with a share.
   *
   * SESSION STATE ON PURPOSE, not a stored preference. Sending system audio is
   * what re-broadcast everyone's voices back into the call (the 23 Aug 2026
   * echo report; see `lib/screen-capture-audio.ts`), and the failure is silent
   * from the presenter's side. A preference remembered across reloads is a
   * preference somebody set once for one game and then forgot, and the next
   * time it costs the whole room. Re-arming is one press, in the call, next to
   * the button it changes.
   */
  const [shareSystemAudio, setShareSystemAudio] = useState(false);
  // --- voice state ---
  // Mirror this client's mute/deafen onto the wire so the roster can badge it
  // for everyone else. Lives outside the voice controller: it is display
  // state, and dropping every frame of it would change nothing about the call.
  useVoiceStateSync(transport, voiceState);

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

  const location = useLocation();
  const navigate = useNavigate();
  // Last path this component applied or emitted — guards the deep-link effect
  // against reacting to its own URL writes.
  const routeRef = useRef<string | null>(null);

  const resolveTokenRef = useRef(resolveToken);
  resolveTokenRef.current = resolveToken;
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
  const perms = usePermissions(selectedServerId);
  const permsRef = useRef(perms);
  permsRef.current = perms;
  /** Which server owns the active call — `channels` only holds the selected one. */
  const voiceServerIdRef = useRef<string | null>(null);
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

  const refresh = useCallback(() => setTick((t) => t + 1), []);
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

  useEffect(() => {
    setLocalSettings(loadLocalSettings());
  }, []);

  useEffect(() => {
    setSoundOutput({
      deviceId: localSettings.outputDeviceId,
      volume: localSettings.outputVolume,
    });
  }, [localSettings.outputDeviceId, localSettings.outputVolume]);

  // Asked here as well as in the composer so the pane does not offer a drop
  // target on a deployment that has nowhere to put the bytes. The probe itself
  // is memoised, so this is the same answer rather than a second request.
  useEffect(() => {
    let active = true;
    void loadAttachmentConfig().then((config) => {
      if (active) {
        setIsAttachmentsEnabled(config.enabled);
      }
    });
    return () => {
      active = false;
    };
  }, []);

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
    (held: boolean) => voice.setPushToTalkActive(held),
    [voice],
  );

  // The key binding lives here rather than in the panel because the panel is
  // unmounted the moment you navigate to a text channel, and push-to-talk has
  // to keep working while you read the chat.
  const { windowFocused } = usePushToTalk({
    enabled: inPushToTalk,
    binding: localSettings.pushToTalkKey,
    onHeldChange: handlePushToTalk,
  });

  // Electron: Cmd/Ctrl+Shift+M → toggle mute when connected to voice.
  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) {
      return;
    }
    return desktop.onToggleMute(() => {
      if (voice.getState().status === "connected") {
        voice.toggleMute();
      }
    });
  }, [voice]);

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
      const result = await markChannelRead(channelId);
      return result.previousLastReadAt ?? null;
    } catch {
      // A missed read receipt only means a stale badge; not worth surfacing.
      return null;
    }
  }, []);

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
      setMentionMembers([...conversationParticipants]);
      setMentionableRoles([]);
      setServerMembers([]);
      setServerRoles([]);
      return;
    }
    if (!selectedServerId) {
      setMentionMembers([]);
      setMentionableRoles([]);
      setServerMembers([]);
      setServerRoles([]);
      return;
    }
    let cancelled = false;
    void Promise.all([
      fetchMembers(selectedServerId),
      fetchRoles(selectedServerId).catch(() => ({ roles: [] as ServerRole[] })),
    ])
      .then(([{ members }, { roles }]) => {
        if (!cancelled) {
          setMentionMembers(members);
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

  const mentionCandidates = useMemo(() => {
    if (conversationParticipants) {
      return mentionMembers;
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
      ...mentionMembers.map((member) => ({
        ...member,
        mentionKind: "member" as const,
      })),
      ...extra,
    ];
  }, [
    conversationParticipants,
    mentionMembers,
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
      });
    }
    for (const person of conversationParticipants ?? []) {
      if (map.has(person.id)) {
        continue;
      }
      map.set(person.id, {
        username: person.username,
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
      mute: perms.can(Permission.MUTE_MEMBERS),
      nicknames: perms.can(Permission.MANAGE_NICKNAMES),
      manageRoles: perms.can(Permission.MANAGE_ROLES),
    }),
    [perms],
  );
  const canStaff =
    moderationBits.kick ||
    moderationBits.ban ||
    moderationBits.timeout ||
    moderationBits.mute ||
    moderationBits.nicknames ||
    moderationBits.manageRoles;

  /**
   * What the profile card may do to somebody, in the server it was opened in.
   *
   * Null in a conversation — a DM has no moderators — and null when this
   * account holds none of the staff bits, which is why the bits are checked
   * here rather than inside the card.
   */
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
      setSelectedChannelId(channelId);
      selectedChannelIdRef.current = channelId;
      // The reply belongs to the conversation you were in, not the next one.
      setReplyTarget(null);
      // --- threads --- the panel belongs to the channel it was opened from.
      closeThreadPanelRef.current();
      setUnreadSince(null);
      setEditMessageId(null);
      const held = unreadHoldRef.current.has(channelId);
      setMessagesLoading(true);
      chat.joinChannel(channelId);

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
        chat.setMessages(page.messages, page.hasMore);
        setUnreadSince(
          previousLastReadAt &&
            findFirstUnreadMessageId(page.messages, previousLastReadAt)
            ? previousLastReadAt
            : null,
        );
        refresh();
      } catch (error) {
        setAppError(
          error instanceof Error ? error.message : "Failed to load messages",
        );
      } finally {
        if (selectedChannelIdRef.current === channelId) {
          setMessagesLoading(false);
        }
      }
    },
    [chat, clearUnread, refresh],
  );

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
  const openThreadChannelIdRef = useRef<string | null>(null);
  openThreadChannelIdRef.current = openThread?.thread.channelId ?? null;

  const closeThreadPanel = useCallback(() => {
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
  // openChannel is declared above this callback and must close the panel on
  // every channel switch, so it reaches it through a ref.
  const closeThreadPanelRef = useRef<() => void>(() => {});
  closeThreadPanelRef.current = closeThreadPanel;

  const openThreadPanel = useCallback(
    async (thread: ThreadSummary, origin: ChatMessage | null) => {
      setOpenThread({ thread, origin });
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
            findFirstUnreadMessageId(page.messages, previousLastReadAt)
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

  const handleStartThread = useCallback(
    async (message: ChatMessage) => {
      try {
        const { thread } = await createThread(message.id);
        // The chip appears on the actor's own copy immediately; everyone
        // else's arrives on the `thread-update` broadcast.
        chat.applyThreadUpdate(message.id, thread);
        await openThreadPanel(thread, message);
      } catch (error) {
        setAppError(
          error instanceof Error
            ? error.message
            : translateMessage("thread.error.start"),
        );
      }
    },
    [chat, openThreadPanel],
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
      void markChannelRead(channelId, lastReadAt)
        .then(() => {
          if (selectedServerId) {
            void loadUnread(selectedServerId);
          }
        })
        .catch(() => {
          // Badge is best-effort.
        });
    },
    [loadUnread, selectedServerId],
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

        const { servers: serverList } = await fetchServers();
        if (cancelled) {
          return;
        }
        setServers(serverList);

        // Conversations and blocks are loaded whatever the first view is: the
        // Home badge counts across the whole account, and the block list drives
        // what is hidden inside server channels too.
        void loadConversations();
        void loadBlocks();

        let initialChannelId: string | null = null;
        const first = serverList[0];
        // A URL that already names a channel owns the first navigation. Without
        // this the bootstrap opens the first text channel anyway and `syncRoute`
        // rewrites the address bar, so a shared `/message/<id>` link is thrown
        // away before the deep-link effect below ever reads it — permalinks
        // worked only in a tab that was already running.
        const deepLink = parseAppRoute(window.location.pathname);
        const deepLinksChannel =
          deepLink?.kind === "channel" && deepLink.channelId !== null;
        // A conversation link owns the navigation outright: opening a server
        // first would move the sidebar, then the deep-link effect would move it
        // back, and the trip through a server is a fetch nobody asked for.
        const deepLinksConversation = deepLink?.kind === "conversation";

        if (first && !deepLinksConversation) {
          setSelection({ kind: "server", serverId: first.id });
          setChannelsLoading(true);
          try {
            const { channels: channelList } = await fetchChannels(first.id);
            if (cancelled) {
              return;
            }
            setChannels(channelList);
            initialChannelId = deepLinksChannel
              ? null
              : (channelList.find((c) => c.type === "text")?.id ?? null);
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
          if (message.type === "channel-activity") {
            const activity = message as {
              channelId: string;
              mention: boolean;
              /** Null for a conversation, which belongs to no server. */
              serverId?: string | null;
              /** Absent from an API that predates conversations. */
              kind?: ChannelKind;
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
              const now = new Date().toISOString();
              if (
                conversationsRef.current.some(
                  (one) => one.channelId === activity.channelId,
                )
              ) {
                setConversations((prev) =>
                  touchConversation(prev, activity.channelId, now),
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
              describeActivity(activity.channelId, {
                count: 1,
                mentions: activity.mention ? 1 : 0,
              }),
              {
                selectedChannelId: selectedChannelIdRef.current,
                documentVisible: document.visibilityState === "visible",
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

          // Somebody started or stopped looking at a channel. The chat
          // controller wants it for the header count; the member sidebar wants
          // it as the cheapest available hint that presence has moved. Neither
          // is the frame's owner, so it is nudged here and still falls through.
          if (message.type === "presence-update") {
            setMemberRosterNudge((n) => n + 1);
          }

          if (
            message.type === "message-broadcast" ||
            message.type === "message-update" ||
            message.type === "message-delete" ||
            message.type === "reaction-broadcast" ||
            message.type === "message-deleted" ||
            message.type === "presence-update" ||
            message.type === "typing-broadcast" ||
            message.type === "poll-update"
          ) {
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

          if (message.type === "permissions-update") {
            if (message.serverId !== selectedServerIdRef.current) {
              return;
            }
            permsRef.current.refresh(message.version);
            setMemberRosterNudge((n) => n + 1);
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
              .then(([{ channels: list }, rolesRes, membersRes]) => {
                if (selectedServerIdRef.current !== message.serverId) {
                  return;
                }
                setChannels(list);
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
                  setMentionMembers(membersRes.members);
                  setMemberRoles(
                    new Map(
                      membersRes.members.map((member) => [member.id, member.role]),
                    ),
                  );
                }
                const current = selectedChannelIdRef.current;
                if (current && !list.some((channel) => channel.id === current)) {
                  const next =
                    list.find((channel) => channel.type === "text") ?? list[0];
                  if (next) {
                    setSelectedChannelId(next.id);
                    selectedChannelIdRef.current = next.id;
                  }
                }
              })
              .catch(() => {
                // Next navigation will refetch.
              });
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
          // time. The member SIDEBAR is the opposite case — it is open all the
          // time at desktop widths — so the frame is parked here and it patches
          // itself from it rather than refetching a hundred rows for one name.
          if (message.type === "profile-update") {
            chat.applyProfileUpdate(message);
            threadChat.applyProfileUpdate(message);
            setLastProfileUpdate(message);
            setConversations((prev) =>
              prev.map((conversation) =>
                conversation.participants.some(
                  (person) => person.id === message.userId,
                )
                  ? {
                      ...conversation,
                      participants: conversation.participants.map((person) =>
                        person.id === message.userId
                          ? {
                              ...person,
                              displayName: message.displayName,
                              username: message.username,
                              tag: message.tag,
                              avatarUrl: message.avatarUrl,
                            }
                          : person,
                      ),
                    }
                  : conversation,
              ),
            );
            setUser((prev) =>
              prev && prev.id === message.userId
                ? {
                    ...prev,
                    displayName: message.displayName,
                    username: message.username,
                    tag: message.tag,
                    avatarUrl: message.avatarUrl,
                  }
                : prev,
            );
            return;
          }

          // --- threads --- the chip refresh: reply count and freshness for
          // an origin message in whatever channel the main view is showing.
          if (message.type === "thread-update") {
            chat.applyThreadUpdate(message.messageId, message.thread);
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
          // whole sentence to show. Guarded to the room we are actually in —
          // a stale or forged frame about some other channel does nothing.
          if (message.type === "voice-moderation") {
            const current = voice.getState();
            if (current.voiceChannelId !== message.voiceChannelId) {
              return;
            }
            setAppError(message.message);
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
            // "muted"/"unmuted": informational — the banner above is all.
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
          // The server dropped our voice peer with the socket. Keep the mic and
          // the intended room so the call resumes on reconnect instead of
          // kicking the user out (they just see "connecting" briefly).
          voice.notifyDisconnected();
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
            return;
          }
          // Re-subscribe and re-sync: messages sent while we were offline were
          // never delivered, so the local list is stale.
          chat.resubscribe();
          // --- threads --- the secondary slot re-announces itself the same
          // way; the panel's window is refreshed by its next open.
          threadChat.resubscribe();
          // The server drops a voice peer as soon as its socket closes, so the
          // call has to be re-entered before the UI matches reality again.
          void voice.notifyReconnected();
          if (channelId) {
            void fetchMessages(channelId)
              .then((page) => {
                if (selectedChannelIdRef.current === channelId) {
                  chat.setMessages(page.messages, page.hasMore);
                  refresh();
                }
              })
              .catch(() => {
                // Next reconnect will retry.
              });
          }
        });

        transport.connect(() => resolveTokenRef.current());
      } catch (error) {
        if (cancelled) {
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

    void init();

    return () => {
      cancelled = true;
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

  const selectChannel = useCallback(
    async (channelId: string, serverIdOverride?: string) => {
      // The override matters when a server was only just chosen: `selection` is
      // still the previous one this render, and the URL has to name the server
      // whose channel is being opened rather than the one being left.
      syncRoute(
        serverIdOverride
          ? { kind: "server", serverId: serverIdOverride }
          : selection,
        channelId,
      );
      // Voice deliberately survives navigating away: leaving a call because you
      // clicked another channel is not how a chat app should behave.
      await openChannel(channelId);
    },
    [openChannel, selection, syncRoute],
  );

  /** Open one conversation, switching the sidebar to the home view with it. */
  const selectConversation = useCallback(
    async (channelId: string) => {
      setSelection(HOME_SELECTION);
      syncRoute(HOME_SELECTION, channelId);
      await openChannel(channelId);
    },
    [openChannel, syncRoute],
  );

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
    async (serverId: string) => {
      setChannelsLoading(true);
      try {
        const { channels: list } = await fetchChannels(serverId);
        setAppError(null);
        setChannels(list);
        void loadUnread(serverId);
        const general =
          list.find((c) => c.type === "text") ??
          list.find((c) => c.type !== "category");
        if (general) {
          await selectChannel(general.id, serverId);
        } else {
          setSelectedChannelId(null);
          selectedChannelIdRef.current = null;
          syncRoute({ kind: "server", serverId }, null);
        }
      } catch (error) {
        setAppError(
          error instanceof ApiError && error.status === 404
            ? translateMessage("chrome.serverUnavailable")
            : error instanceof Error
              ? error.message
              : "Failed to load channels",
        );
      } finally {
        setChannelsLoading(false);
      }
    },
    [loadUnread, selectChannel, syncRoute],
  );

  async function handleChannelPromptConfirm(name: string, isPrivate?: boolean) {
    if (!channelPrompt) {
      return;
    }

    try {
      if (channelPrompt.mode === "create") {
        if (!selectedServerId || !channelPrompt.type) {
          setAppError("Select a server before creating a channel");
          return;
        }
        const { channel } = await createChannel(
          selectedServerId,
          name,
          channelPrompt.type,
          isPrivate ?? channelPrompt.isPrivate ?? false,
        );
        const next = [...channels, channel].sort(
          (a, b) => a.position - b.position,
        );
        setChannels(next);
        setAppError(null);
        setChannelPrompt(null);
        // A category is a grouping header, not a place to be — selecting it
        // would try to open a message pane for something that can never have
        // one.
        if (channel.type !== "category") {
          await selectChannel(channel.id);
          if (channel.isPrivate) {
            setChannelMembersChannel(channel);
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
    } catch (error) {
      setAppError(
        error instanceof Error ? error.message : "Channel action failed",
      );
    }
  }

  async function handleTogglePrivate(channel: Channel) {
    try {
      const { channel: updated } = await updateChannel(channel.id, {
        isPrivate: !channel.isPrivate,
      });
      setChannels((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      if (updated.isPrivate) {
        setChannelMembersChannel(updated);
      }
      setAppError(null);
    } catch (error) {
      setAppError(
        error instanceof Error ? error.message : "Failed to update channel",
      );
    }
  }

  async function handleDeleteChannel(channelId: string) {
    if (!window.confirm(t("chrome.deleteChannelConfirm"))) {
      return;
    }
    try {
      await deleteChannel(channelId);
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

  async function handleLeaveServer(serverId: string) {
    if (!window.confirm(t("chrome.leaveServer"))) {
      return;
    }
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

  async function handleJoinVoice(channelId: string) {
    voiceServerIdRef.current = selectedServerId;
    refreshIceServers();

    await voice.join(channelId, {
      inputDeviceId: localSettings.inputDeviceId,
      inputVolume: localSettings.inputVolume,
      startMuted: localSettings.muteOnJoin,
      inputMode: localSettings.inputMode,
      processing: localSettings.micProcessing,
    });
  }

  /** Sidebar double-click: open the channel and join, unless already in it. */
  function handleJoinVoiceFromList(channelId: string) {
    void selectChannel(channelId);
    if (
      voiceState.voiceChannelId === channelId &&
      voiceState.status !== "idle"
    ) {
      return;
    }
    void handleJoinVoice(channelId);
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
      processing: localSettings.micProcessing,
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

  const refreshAfterJoin = useCallback(
    async (serverId: string) => {
      const { servers: serverList } = await fetchServers();
      setServers(serverList);
      setSelection({ kind: "server", serverId });
      await loadChannels(serverId);
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
    ) => {
      const known = serversRef.current.map((server) => server.id);
      const openable = pickOpenableServer(serverId, known);
      const targetServerId = openable?.serverId ?? serverId;
      const usedFallback = openable?.usedFallback === true;
      const targetChannelId = usedFallback ? null : channelId;
      const targetMessageId = usedFallback ? null : messageId;

      setChannelsLoading(true);
      try {
        const { channels: list } = await fetchChannels(targetServerId);
        setSelection({ kind: "server", serverId: targetServerId });
        setAppError(null);
        setChannels(list);
        void loadUnread(targetServerId);
        const requested = targetChannelId
          ? list.find((c) => c.id === targetChannelId)
          : undefined;
        if (targetChannelId && !requested) {
          setAppError("That channel no longer exists or is private.");
        }
        const target =
          requested ??
          list.find((c) => c.type === "text") ??
          list.find((c) => c.type !== "category");
        if (target) {
          await selectChannel(target.id, targetServerId);
          if (targetMessageId && target.id === targetChannelId) {
            setHighlightMessageId(targetMessageId);
          }
        } else {
          setSelectedChannelId(null);
          selectedChannelIdRef.current = null;
        }
      } catch (error) {
        setAppError(
          error instanceof ApiError && error.status === 404
            ? translateMessage("chrome.serverUnavailable")
            : error instanceof Error
              ? error.message
              : translateMessage("chrome.serverUnavailable"),
        );
      } finally {
        setChannelsLoading(false);
      }
    },
    [loadUnread, selectChannel],
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
    async (channelId: string | null, messageId: string | null = null) => {
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
      if (messageId) {
        setHighlightMessageId(messageId);
      }
    },
    [loadConversations, selectConversation],
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
      try {
        const result = await joinInvite(code);
        const storage = browserStorage();
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
    if (target.kind === "conversation") {
      void applyConversationRoute(target.channelId, target.messageId);
      return;
    }
    void applyChannelRoute(
      target.serverId,
      target.channelId,
      target.messageId,
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
    // Consumed in the same breath as the intents and for the same reason: a
    // stash that outlives the request it causes is a request that repeats.
    const acquisition = takeAcquisition(storage);
    const claim = normalizeHandle(params.get("claim") ?? "") || stashedClaim;
    const add = addIntentFromSearch(location.search) ?? stashedAdd;
    const join = joinIntentFromSearch(location.search) ?? stashedJoin;

    if (params.has("claim") || params.has("add") || params.has("join")) {
      params.delete("claim");
      params.delete("add");
      params.delete("join");
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
      void updateMe({ acquisition }).catch(() => {
        // A lost attribution. Not worth a banner.
      });
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
        try {
          const { community } = await lookupCommunityBySlug(join);
          const result = await joinCommunityApi(community.id);
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
      if (selectedChannelIdRef.current === channelId) {
        selectHome();
      }
    },
    [selectHome],
  );

  const blockedUserIds = useMemo(
    () => new Set(blockedUsers.map((blocked) => blocked.id)),
    [blockedUsers],
  );

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

  const handleQgHintShowingChange = useCallback((showing: boolean) => {
    setQgHintReady(true);
    setQgHintShowing(showing);
  }, []);

  if (bootstrapError) {
    return (
      <AppBootstrapError
        message={bootstrapError}
        onRetry={() => {
          setBootstrapError(null);
          setBootstrapAttempt((n) => n + 1);
        }}
      />
    );
  }

  if (ageGate) {
    return (
      <AgeGateDialog
        status={ageGate}
        // Passing re-runs the whole bootstrap from the top, which is exactly
        // what is wanted: everything it would have loaded is still unloaded.
        onPassed={() => {
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
   * cruel and pointless. After the bootstrap because the last step creates or
   * joins a server, and `refreshAfterJoin` needs the same loaded state every
   * other join path in the app needs.
   */
  if (needsOnboarding && user) {
    return (
      <OnboardingFlow
        user={user}
        pendingInvite={arrivedOnInviteLink}
        onUserUpdated={(updated) => {
          setUser(updated);
          chat.setCurrentUser(updated);
        }}
        onServerReady={(serverId) => refreshAfterJoin(serverId)}
        onDone={() => setNeedsOnboarding(false)}
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
  const canManageChannels = perms.can(Permission.MANAGE_CHANNELS);
  const canManageRoles = perms.can(Permission.MANAGE_ROLES);
  const canManageServer = perms.can(Permission.MANAGE_SERVER);
  const canManageMessages = perms.can(Permission.MANAGE_MESSAGES);
  const canManageNicknames = perms.can(Permission.MANAGE_NICKNAMES);
  /**
   * One corner card. The dice/polls note (`whatsNew`) is the same slot when
   * that PR lands; it goes in the middle of this list so it does not stack
   * on the QG or on cargos.
   */
  const cornerHint = winningCornerHint({
    qg: qgHintShowing,
    cargos: qgHintReady && Boolean(canManageRoles && selectedServerId),
  });

  const voiceChannel =
    voiceState.voiceChannelId
      ? channels.find((c) => c.id === voiceState.voiceChannelId) ?? null
      : null;
  /** The conversation the active call lives in, when it is a DM call. */
  const voiceConversation = voiceState.voiceChannelId
    ? (conversations.find(
        (one) => one.channelId === voiceState.voiceChannelId,
      ) ?? null)
    : null;
  const canDropFiles = isAttachmentsEnabled && selectedChannel?.type === "text";

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

  /**
   * The bottom of whichever sidebar is showing. Shared rather than duplicated:
   * an ongoing call and the mute button must not vanish because the reader
   * switched to their conversations.
   */
  const sidebarFooter = (
    <>
      {voiceState.status !== "idle" && (
        <VoiceStatusBar
          channelName={
            voiceChannel?.name ??
            (voiceConversation
              ? conversationTitle(voiceConversation.participants)
              : t("voice.channelFallback"))
          }
          status={voiceState.status}
          peerCount={voiceState.remotePeers.length}
          isMuted={voiceState.isMuted}
          inputMode={voiceState.inputMode}
          isTransmitting={voiceState.isTransmitting}
          usingSfu={voiceState.usingSfu}
          isPresenting={voiceState.screenSharePeerIds.length > 0}
          onOpen={() => void openVoiceChannel()}
          onLeave={() => voice.leave()}
        />
      )}
      <UserPanel
        displayName={user?.displayName ?? "User"}
        tag={user?.tag ?? null}
        handle={user?.handle ?? null}
        avatarUrl={user?.avatarUrl ?? null}
        isMuted={voiceState.isMuted}
        isDeafened={voiceState.isDeafened}
        inVoice={voiceState.status !== "idle"}
        showUserButton={showUserButton}
        manualStatus={status.manual}
        effectiveStatus={status.effective}
        statusSaving={status.saving}
        statusError={status.error}
        onSetStatus={status.setManual}
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
      />
    </>
  );

  const chatPane = selectedChannel ? (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      // The whole conversation is the drop target, not the textarea: dragging a
      // screenshot onto the messages is what people actually do, and a target
      // the size of one input is a target you miss.
      onDragEnter={(event) => {
        if (!canDropFiles || !isFileDrag(event.dataTransfer)) {
          return;
        }
        dragDepth.current += 1;
        setIsDraggingFiles(true);
      }}
      onDragOver={(event) => {
        if (canDropFiles && isFileDrag(event.dataTransfer)) {
          // Without this the browser navigates to the file instead of dropping.
          event.preventDefault();
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) {
          setIsDraggingFiles(false);
        }
      }}
      onDrop={(event) => {
        dragDepth.current = 0;
        setIsDraggingFiles(false);
        if (!canDropFiles) {
          return;
        }
        const files = filesFromDataTransfer(event.dataTransfer);
        if (files.length === 0) {
          return;
        }
        event.preventDefault();
        setDroppedFiles(files);
      }}
    >
      {isDraggingFiles && (
        // Inert, so the drop lands on the pane below rather than on the overlay.
        <div className="pointer-events-none absolute inset-0 z-30 m-2 flex items-center justify-center rounded-lg border-2 border-dashed border-signal bg-ink/85">
          <p className="font-display text-lg font-bold text-signal">
            {t("chrome.dropToAttach")}
          </p>
        </div>
      )}
      <header className="flex h-14 shrink-0 items-center border-b border-ink-4/60 px-3 sm:px-4">
        <button
          type="button"
          className="mr-2 rounded-md p-1.5 hover:bg-ink-3 md:hidden"
          aria-label={t("chrome.openNav")}
          onClick={() => setMobileNavOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </button>
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
          <p className="truncate text-[11px] text-paper-muted">
            {activeConversation
              ? conversationSubtitle(activeConversation)
              : selectedChannel.topic
                ? selectedChannel.topic
                : `${selectedChannel.isPrivate ? t("chrome.privatePrefix") : ""}${t("chrome.peopleHere", { count: chat.getPresence().length })}`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
          {/* The call entry points live here, always visible — the sidebar's
              hover affordance does not exist on touch, and a call you cannot
              start from your phone is a call that does not happen. */}
          {selectedChannel.kind === "server" &&
            selectedChannel.type === "voice" &&
            !(
              voiceState.voiceChannelId === selectedChannel.id &&
              voiceState.status !== "idle"
            ) && (
              <Tooltip label={t("voice.joinNamed", { name: selectedChannel.name })}>
                <button
                  type="button"
                  aria-label={t("voice.join")}
                  className="flex shrink-0 items-center gap-1.5 rounded-md bg-success/90 px-2.5 py-1.5 text-xs font-semibold text-ink hover:bg-success"
                  onClick={() => void handleJoinVoice(selectedChannel.id)}
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
          <Tooltip label={t("chrome.pins")}>
            <button
              type="button"
              className={HEADER_ACTION_TILE}
              onClick={() => setPinsOpen(true)}
            >
              <Pin className="h-4 w-4" />
            </button>
          </Tooltip>
          {canManageChannels && (
            <Tooltip label={t("chrome.topic")}>
              <button
                type="button"
                className={HEADER_ACTION_TILE}
                onClick={() => setChannelMetaChannel(selectedChannel)}
              >
                <FileText className="h-4 w-4" />
              </button>
            </Tooltip>
          )}
          {(canManageRoles || (canManageChannels && selectedChannel.isPrivate)) &&
            selectedChannel.kind === "server" && (
            <Tooltip
              label={
                selectedChannel.isPrivate
                  ? t("chrome.access")
                  : t("channelPerms.title")
              }
            >
              <button
                type="button"
                className={HEADER_ACTION_TILE}
                onClick={() => setChannelMembersChannel(selectedChannel)}
              >
                {selectedChannel.isPrivate ? (
                  <Lock className="h-4 w-4" />
                ) : (
                  <Shield className="h-4 w-4" />
                )}
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
      {/* Straight under the header, above everything a message could push
          around: an invited stranger's first screen otherwise says "Start the
          thread" over a markdown cheatsheet and nothing else. */}
      {arrivalServerId &&
        arrivalServerId === selectedServerId &&
        selectedServer && (
          <ArrivalBanner
            serverName={selectedServer.name}
            channelName={
              selectedChannel.kind === "server" &&
              selectedChannel.type === "text"
                ? selectedChannel.name
                : null
            }
            onDismiss={() => setArrivalServerId(null)}
          />
        )}
      {/* The conversation's call surface: invisible until a call exists, a
          join banner while others talk, the full stage once we are in. */}
      {selectedChannel.kind === "server" &&
        selectedChannel.type === "voice" &&
        user && (
          <VoiceChannelStage
            channelId={selectedChannel.id}
            channelName={selectedChannel.name}
            currentUser={{
              id: user.id,
              displayName: user.displayName,
              avatarUrl: user.avatarUrl,
            }}
            voiceState={voiceState}
            videoQuality={localSettings.videoQuality}
            onLeave={() => voice.leave()}
            onToggleMute={() => voice.toggleMute()}
            onToggleCamera={() => void voice.toggleCamera()}
            onVideoQualityChange={handleVideoQualityChange}
            onStartScreenShare={() =>
              void voice.startScreenShare(shareSystemAudio)
            }
            onStopScreenShare={() => void voice.stopScreenShare()}
            shareSystemAudio={shareSystemAudio}
            onShareSystemAudioChange={setShareSystemAudio}
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
            onRetryPeer={(peerId) => {
              void voice.retryPeer(peerId);
            }}
            compactPeers={localSettings.compactPeers}
          />
        )}
      {activeConversation && user && (
        <DmCallStage
          conversation={activeConversation}
          currentUser={{
            id: user.id,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
          }}
          voiceState={voiceState}
          videoQuality={localSettings.videoQuality}
          onJoinCall={() =>
            void handleConversationCall(activeConversation.channelId, false)
          }
          onLeave={() => voice.leave()}
          onToggleMute={() => voice.toggleMute()}
          onToggleCamera={() => void voice.toggleCamera()}
          onVideoQualityChange={handleVideoQualityChange}
          onStartScreenShare={() => void voice.startScreenShare(shareSystemAudio)}
          onStopScreenShare={() => void voice.stopScreenShare()}
          shareSystemAudio={shareSystemAudio}
          onShareSystemAudioChange={setShareSystemAudio}
          onFocusScreenShare={(peerId) => voice.focusScreenShare(peerId)}
          compactPeers={localSettings.compactPeers}
        />
      )}
      <MessageList
        messages={chat.getMessages()}
        currentUserId={user?.id ?? null}
        currentUsername={user?.username ?? null}
        serverId={selectedServerId}
        channelId={selectedChannel.id}
        isLoading={messagesLoading}
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
        onToggleReaction={(messageId, emoji) =>
          chat.toggleReaction(messageId, emoji)
        }
        onVotePoll={(messageId, optionId) => chat.votePoll(messageId, optionId)}
        onClosePoll={(messageId) => chat.closePoll(messageId)}
        onLoadOlder={() => chat.loadOlder()}
        onLoadNewer={loadNewerHistory}
        onJumpToMessage={jumpToMessage}
        onJumpToPresent={jumpToPresent}
        onEditMessage={(messageId, body) => chat.editMessage(messageId, body)}
        onDeleteMessage={(messageId) => chat.deleteMessage(messageId)}
        onPinMessage={(messageId) => chat.pinMessage(messageId)}
        onUnpinMessage={(messageId) => chat.unpinMessage(messageId)}
        onReportMessage={(message) =>
          setReportTarget({
            kind: "message",
            messageId: message.id,
            subjectName: message.authorName,
          })
        }
        onRetryMessage={(nonce) => chat.retryMessage(nonce)}
        onDiscardMessage={(nonce) => chat.discardMessage(nonce)}
        showLinkEmbeds={localSettings.showLinkEmbeds}
        // --- threads --- offered only inside a server: a conversation already
        // is the scoped side-conversation a thread would create.
        onStartThread={
          selectedChannel.kind === "server" && selectedChannel.type === "text"
            ? (message) => void handleStartThread(message)
            : undefined
        }
        onOpenThread={
          selectedChannel.kind === "server"
            ? (thread, message) => void openThreadPanel(thread, message)
            : undefined
        }
        unreadThreadIds={unreadThreadIds}
        activeThreadId={openThread?.thread.channelId ?? null}
        authors={messageAuthors}
        roles={serverRoles}
        unreadHeld={unreadHeldIds.has(selectedChannel.id)}
        unreadSince={unreadSince}
        editMessageId={editMessageId}
        onEditMessageHandled={() => setEditMessageId(null)}
        onForward={setForwardMessage}
        onMarkUnread={handleMarkUnread}
        onMarkRead={handleMarkRead}
      />
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
        // Remount per channel: the draft is component state, so without this a
        // half-typed message follows you into the next channel, one Enter away
        // from the wrong audience.
        key={selectedChannel.id}
        onSend={(body, attachments) => {
          if (unreadHoldRef.current.has(selectedChannel.id)) {
            clearUnread(selectedChannel.id);
          }
          chat.sendMessage(body, replyTarget, attachments);
          setReplyTarget(null);
        }}
        onTyping={() => chat.notifyTyping()}
        insertText={composerInsert}
        onInsertConsumed={() => setComposerInsert(null)}
        channelId={selectedChannel.id}
        droppedFiles={droppedFiles}
        onDroppedFilesConsumed={() => setDroppedFiles(null)}
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
        }}
        disabled={!selectedChannelId || messagesLoading}
        placeholder={t("composer.placeholder", { name: selectedChannel.name })}
      />
    </div>
  ) : null;

  return (
    // The friends snapshot, published to everything that draws a relationship:
    // the view, every profile card, and the two badges. Outside the popover
    // provider because the card is one of its consumers.
    <FriendsContext.Provider value={friends}>
    {/* One provider for the whole app: the profile card is opened from the
        transcript, the members panel and the conversation list, and every one of
        them wants the same block list, the same "open this DM" navigation and
        the same report dialog that already live up here. */}
    <ProfilePopoverProvider
      currentUserId={user?.id ?? null}
      blockedUserIds={blockedUserIds}
      moderation={cardModeration}
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
    <div className="animate-fade-in relative flex h-full overflow-hidden">
      {/* Mounted at the root so remote audio keeps playing when you navigate
          away from the voice channel. */}
      <VoiceAudioSinks
        peers={voiceState.remotePeers}
        peerVolumes={voiceState.peerVolumes}
        isDeafened={voiceState.isDeafened}
        outputDeviceId={localSettings.outputDeviceId}
        outputVolume={localSettings.outputVolume}
        audibleScreenPeerIds={voiceState.audibleScreenPeerIds}
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


      {/* One corner card per ship. Same shape as the old Android beta prompt:
          no backdrop, does not steal the composer. Decides for itself whether
          this pack has already been seen. */}
      <WhatsNewPrompt />

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
        servers={servers}
        selectedServerId={selectedServerId}
        serverUnread={serverUnread}
        homeSelected={selection.kind === "dm"}
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
          communitiesEnabled ? () => setDirectoryOpen(true) : undefined
        }
        onSelectHome={() => {
          selectHome();
          setMobileNavOpen(true);
        }}
        onSelectServer={(id) => {
          setSelection({ kind: "server", serverId: id });
          void loadChannels(id);
          setMobileNavOpen(true);
        }}
        onCreateServer={() => setShowCreateServer(true)}
        onJoinServer={() => setInviteMode("join")}
        onInvite={openInviteForServer}
        onOpenMembers={openMembersForServer}
        onOpenSettings={(id) => {
          setSelection({ kind: "server", serverId: id });
          setServerSettingsOpen(true);
        }}
        onLeaveServer={(id) => void handleLeaveServer(id)}
        onToggleProfileVisibility={(id, showOnProfile) =>
          void handleToggleProfileVisibility(id, showOnProfile)
        }
      />

      {selection.kind === "dm" ? (
        <DmList
          conversations={conversations}
          selectedChannelId={selectedChannelId}
          unread={unread}
          isLoading={conversationsLoading}
          blockedUserIds={blockedUserIds}
          mobileOpen={mobileNavOpen}
          onMobileClose={() => setMobileNavOpen(false)}
          onSelectConversation={(id) => void selectConversation(id)}
          onStartConversation={() => setNewDmOpen(true)}
          // Home-with-nothing-selected IS the Friends view, so "open friends"
          // is just deselecting the conversation.
          friendsSelected={!selectedChannelId}
          friendRequestCount={friends.data.incoming.length}
          onOpenFriends={selectHome}
          onHideConversation={(id) => void handleHideConversation(id)}
          onBlockUser={(person) => void handleBlockUser(person.id)}
          onUnblockUser={(id) => void handleUnblockUser(id)}
          onStartCall={handleStartConversationCall}
          activeCallChannelIds={activeConversationCallIds}
          footer={sidebarFooter}
        />
      ) : (
        <ChannelList
          server={selectedServer ?? null}
          channels={channels}
          selectedChannelId={selectedChannelId}
          canManage={canManageChannels}
          canManageRoles={canManageRoles}
          isLoading={channelsLoading}
          voiceOccupancy={voiceState.occupancy}
          speakingPeerIds={voiceState.speakingPeerIds}
          activeVoiceChannelId={voiceState.voiceChannelId}
          unread={unread}
          mobileOpen={mobileNavOpen}
          onMobileClose={() => setMobileNavOpen(false)}
          onSelectChannel={(id) => void selectChannel(id)}
          onJoinVoice={handleJoinVoiceFromList}
          onCreateChannel={(type, isPrivate) =>
            setChannelPrompt({ mode: "create", type, isPrivate })
          }
          onRenameChannel={(channel) =>
            setChannelPrompt({ mode: "rename", channel })
          }
          onEditChannelMeta={setChannelMetaChannel}
          onDeleteChannel={(id) => void handleDeleteChannel(id)}
          onMoveChannel={(id, parentId, index) =>
            void handleMoveChannel(id, parentId, index)
          }
          onTogglePrivate={(ch) => void handleTogglePrivate(ch)}
          onManageChannelMembers={setChannelMembersChannel}
          onManageWebhooks={setWebhooksChannel}
          onInvite={() => setInviteMode("create")}
          onOpenMembers={() => setMembersOpen(true)}
          onOpenServerSettings={() => setServerSettingsOpen(true)}
          footer={sidebarFooter}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-transparent">
        {isDevAuthBypassEnabled() && (
          <div className="border-b border-warning/30 bg-warning/10 px-3 py-1 text-center text-xs text-warning">
            {t("chrome.devBypass")}
          </div>
        )}

        {(connection === "reconnecting" || connection === "unauthorized") && (
          <div
            className="flex items-center justify-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-xs text-warning"
            role="status"
          >
            <WifiOff className="h-3.5 w-3.5" />
            {connection === "unauthorized"
              ? t("connection.unauthorized")
              : t("connection.reconnecting")}
          </div>
        )}

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

        {selection.kind !== "dm" && !selectedChannel && !channelsLoading && (
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

        {!selectedChannel && channelsLoading && (
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

        {selectedChannel?.type === "voice" && chatPane}
      </main>

      {/* A SIBLING OF `<main>`, not a child of the chat pane. The root is the
          app's flex row (rail | channels | chat), so slotting the roster here
          makes it a real column: the transcript reflows to the width that is
          left instead of having 15rem of itself covered up. It is also why the
          voice channel's own two-pane layout needs no change — that lives
          inside `<main>` and simply gets a narrower box. A thread takes this
          same slot: overlaying it on the transcript while the roster stayed
          put is what crushed #avisos on the QG. */}
      {openThread && (
        <ThreadPanel
          thread={openThread.thread}
          origin={openThread.origin}
          controller={threadChat}
          currentUser={user}
          serverId={selectedServerId}
          canModerate={canManageMessages}
          blockedAuthorIds={blockedUserIds}
          mentionCandidates={mentionCandidates}
          isLoading={threadLoading}
          showLinkEmbeds={localSettings.showLinkEmbeds}
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
      )}
      {memberSidebarAvailable && !openThread && (
        <MemberSidebar
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
                }
              : null
          }
          currentUserId={user?.id ?? null}
          role={selectedServer?.role ?? "member"}
          canManageNicknames={canManageNicknames}
          showManageRoster={canStaff}
          blockedUserIds={blockedUserIds}
          refreshNudge={memberRosterNudge}
          profileUpdate={lastProfileUpdate}
          onMention={(username) => setComposerInsert(`@${username}`)}
          onBlockUser={(userId) => void handleBlockUser(userId)}
          onUnblockUser={(userId) => void handleUnblockUser(userId)}
          onReportUser={(member) =>
            setReportTarget({
              kind: "user",
              userId: member.id,
              subjectName: member.displayName,
              serverId: selectedServerId,
            })
          }
          onOpenMembersPanel={() => setMembersOpen(true)}
          voiceOccupancy={voiceState.occupancy}
          voiceChannels={channels
            .filter((c) => c.type === "voice")
            .map((c) => ({ id: c.id, name: c.name }))}
          roles={serverRoles}
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
        onLocalSave={setLocalSettings}
        onUserUpdated={(updated) => {
          setUser(updated);
          chat.setCurrentUser(updated);
        }}
        onUnblockUser={(userId) => void handleUnblockUser(userId)}
        onAudioSettingsLive={handleAudioSettingsLive}
      />

      <ServerSettingsDialog
        open={serverSettingsOpen}
        server={selectedServer ?? null}
        currentUserId={user?.id ?? null}
        canManageRoles={canManageRoles}
        canManageServer={canManageServer}
        canModerateQueue={
          moderationBits.kick ||
          moderationBits.ban ||
          moderationBits.timeout
        }
        requestedSection={serverSettingsSection}
        onClose={() => {
          setServerSettingsOpen(false);
          setServerSettingsSection(undefined);
        }}
        onRenamed={(server) =>
          setServers((prev) =>
            prev.map((s) => (s.id === server.id ? { ...s, ...server } : s)),
          )
        }
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
        onClose={() => setShowCreateServer(false)}
        onCreated={async ({ server, channels: newChannels }) => {
          setServers((prev) => [...prev, server]);
          setSelection({ kind: "server", serverId: server.id });
          setChannels(newChannels);
          setAppError(null);
          const general = newChannels.find((c) => c.type === "text");
          if (general) {
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
          .filter((c) => c.type === "voice")
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

      <ChannelMembersPanel
        open={channelMembersChannel !== null}
        channelId={channelMembersChannel?.id ?? null}
        channelName={channelMembersChannel?.name ?? null}
        channelType={channelMembersChannel?.type ?? "text"}
        isPrivate={channelMembersChannel?.isPrivate ?? false}
        serverId={selectedServerId}
        roles={serverRoles}
        canManageRoles={canManageRoles}
        canManageAccess={canManageChannels}
        onClose={() => setChannelMembersChannel(null)}
      />

      <WebhooksPanel
        open={webhooksChannel !== null}
        channelId={webhooksChannel?.id ?? null}
        channelName={webhooksChannel?.name ?? null}
        onClose={() => setWebhooksChannel(null)}
      />

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

      <PromptDialog
        open={channelPrompt !== null}
        title={
          channelPrompt?.mode === "rename"
            ? channelPrompt.channel?.type === "category"
              ? t("chrome.renameCategory")
              : t("chrome.renameChannel")
            : channelPrompt?.type === "category"
              ? t("chrome.createCategory")
              : channelPrompt?.type === "voice"
                ? t("chrome.createVoiceChannel")
                : t("chrome.createTextChannel")
        }
        placeholder={t("chrome.channelNamePlaceholder")}
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
        onConfirm={(name, isPrivate) =>
          handleChannelPromptConfirm(name, isPrivate)
        }
      />

      <CargosHint
        enabled={cornerHint === "cargos"}
        onOpenRoles={() => {
          setServerSettingsSection("roles");
          setServerSettingsOpen(true);
        }}
      />
      <QgHint
        onShowingChange={handleQgHintShowingChange}
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

      {ratableCall && (
        // Bottom-left, clear of the channel dialogs and of the voice panel the
        // person has just left. Fixed rather than in flow so it cannot push the
        // chat around at the exact moment somebody is scrolling back through
        // what they missed.
        <div className="fixed bottom-4 left-4 z-40 w-[19rem] max-w-[calc(100vw-2rem)]">
          <CallRatingPrompt call={ratableCall} onDone={dismissCallRating} />
        </div>
      )}

      <ChannelMetaDialog
        open={channelMetaChannel !== null}
        channel={channelMetaChannel}
        onClose={() => setChannelMetaChannel(null)}
        onSave={async (updates) => {
          if (!channelMetaChannel) {
            return;
          }
          const { channel } = await updateChannel(
            channelMetaChannel.id,
            updates,
          );
          setChannels((prev) =>
            prev.map((c) => (c.id === channel.id ? channel : c)),
          );
          setChannelMetaChannel(null);
        }}
      />
    </div>
    </ProfilePopoverProvider>
    </FriendsContext.Provider>
  );
}

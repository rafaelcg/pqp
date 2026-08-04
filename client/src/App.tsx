import { SignInButton, SignUpButton, useAuth } from "@clerk/clerk-react";
import { Lock, Menu, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type {
  BlockedUser,
  Channel,
  ChannelKind,
  DmSummary,
  Server,
  User,
} from "@pqp/shared";
import { MessageComposer } from "@/components/chat/message-composer";
import { MessageList } from "@/components/chat/message-list";
import {
  AppBootstrapError,
  AppLoadingShell,
} from "@/components/layout/app-loading-shell";
import { ChannelList } from "@/components/layout/channel-list";
import { ChannelMembersPanel } from "@/components/layout/channel-members-panel";
import { WebhooksPanel } from "@/components/layout/webhooks-panel";
import { ChannelMetaDialog } from "@/components/layout/channel-meta-dialog";
import { DmList } from "@/components/layout/dm-list";
import { InvitePanel } from "@/components/layout/invite-panel";
import { MembersPanel } from "@/components/layout/members-panel";
import { PinnedMessagesPanel } from "@/components/chat/pinned-messages-panel";
import { ServerRail } from "@/components/layout/server-rail";
import { NewDmDialog } from "@/components/user/new-dm-dialog";
import { ServerSettingsDialog } from "@/components/layout/server-settings-dialog";
import {
  applyRemotePreferences,
  defaultLocalSettings,
  loadLocalSettings,
  saveLocalSettings,
  SettingsModal,
  type LocalSettings,
} from "@/components/layout/settings-modal";
import { UserPanel } from "@/components/layout/user-panel";
import { ScreenShareView } from "@/components/voice/screen-share-view";
import { VoiceAudioSinks } from "@/components/voice/voice-audio-sinks";
import { VoicePanel } from "@/components/voice/voice-panel";
import { VoiceStatusBar } from "@/components/voice/voice-status-bar";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { Seo } from "@/components/marketing/seo";
import { createChatController, type ChatMessage } from "@/hooks/use-chat";
import { createVoiceController } from "@/hooks/use-voice";
import {
  blockUser,
  createChannel,
  createServer,
  createVoiceSession,
  deleteChannel,
  fetchBlocks,
  fetchChannels,
  fetchConversations,
  fetchIceServers,
  fetchMe,
  fetchMembers,
  fetchMessages,
  fetchServers,
  fetchUnread,
  fetchVoiceBackend,
  hideConversation,
  joinInvite,
  leaveServer,
  markChannelRead,
  moveChannel,
  setAuthTokenProvider,
  unblockUser,
  updateChannel,
  updateMe,
} from "@/lib/api";
import { parseAppRoute } from "@/lib/app-route";
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
import { DEV_AUTH_TOKEN, getAuthToken, isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { getDesktop } from "@/lib/desktop";
import {
  describeActivity,
  notifyChannelActivity,
  rememberServers,
} from "@/lib/notifications";
import { useChannelNotifications } from "@/hooks/use-notifications";
import { createRealtimeTransport, type RealtimeStatus } from "@/lib/realtime";
import { adoptThemePreference } from "@/lib/theme";
import { isMeshForced } from "@/lib/voice-backend";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type TokenResolver = (options?: {
  forceRefresh?: boolean;
}) => Promise<string | null>;

interface AppProps {
  devBypass?: boolean;
}

export function App({ devBypass = false }: AppProps) {
  if (devBypass) {
    return (
      <MainAppContent resolveToken={() => Promise.resolve(DEV_AUTH_TOKEN)} />
    );
  }

  return (
    <>
      <Seo
        title="App — pqp"
        description="Open pqp — servers, text, and voice."
        path="/app"
        noIndex
      />
      <ClerkAppGate />
    </>
  );
}

function ClerkAppGate() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return <AppLoadingShell label="Signing in…" />;
  }

  if (!isSignedIn) {
    return (
      <div className="relative flex h-full flex-col items-start justify-end overflow-hidden p-8 sm:p-12">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,var(--glow-accent),transparent_40%)]" />
        <div className="animate-rise relative z-10 max-w-lg">
          <Link
            to="/"
            className="mb-3 inline-block text-xs uppercase tracking-[0.28em] text-signal"
          >
            pqp.gg
          </Link>
          <h1 className="font-display text-5xl font-extrabold leading-[0.95] sm:text-6xl">
            Sign in to talk.
          </h1>
          <p className="mt-4 max-w-sm text-paper-muted">
            Create an account or sign in to open your servers.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <SignUpButton mode="modal" forceRedirectUrl="/app">
              <Button>Create account</Button>
            </SignUpButton>
            <SignInButton mode="modal" forceRedirectUrl="/app">
              <Button variant="secondary">Sign in</Button>
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

  // Stable callback — Clerk's getToken identity changes often and must not
  // remount the app / tear down the WebSocket (that looked like a full refresh).
  const resolveToken = useCallback<TokenResolver>(
    (options) =>
      getAuthToken(() =>
        getTokenRef.current({ skipCache: options?.forceRefresh }),
      ),
    [],
  );

  return <MainAppContent resolveToken={resolveToken} showUserButton />;
}

interface MainAppContentProps {
  resolveToken: TokenResolver;
  showUserButton?: boolean;
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
}: MainAppContentProps) {
  const [user, setUser] = useState<User | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  /**
   * Starts on the conversation view rather than on a server, because at this
   * point there is no server to start on — bootstrap moves it to the first one
   * unless a deep link has already claimed the navigation.
   */
  const [selection, setSelection] = useState<Selection>(HOME_SELECTION);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<DmSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [newServerName, setNewServerName] = useState("");
  const [creatingServer, setCreatingServer] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [connection, setConnection] = useState<RealtimeStatus>("idle");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
  const [inviteMode, setInviteMode] = useState<"create" | "join" | null>(null);
  const [inviteCodeFromUrl, setInviteCodeFromUrl] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
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
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [unread, setUnread] = useState<Record<string, UnreadState>>({});
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<
    MentionCandidate[]
  >([]);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(
    null,
  );
  const [, setTick] = useState(0);

  const transport = useMemo(() => createRealtimeTransport(), []);
  const chat = useMemo(() => createChatController(transport), [transport]);
  const voice = useMemo(() => createVoiceController(transport), [transport]);
  const [voiceState, setVoiceState] = useState(voice.getState());

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
  /** The server the sidebar is showing, or null in the conversation view. */
  const selectedServerId = selectionServerId(selection);
  /** Which server owns the active call — `channels` only holds the selected one. */
  const voiceServerIdRef = useRef<string | null>(null);

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
    voice.onStateChange(setVoiceState);
    return () => {
      chat.dispose();
    };
  }, [chat, voice, refresh]);

  // A notification frame carries ids only, and it can name any server the user
  // belongs to rather than just the open one, so the whole list is remembered.
  useEffect(() => {
    rememberServers(servers);
  }, [servers]);

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

  const clearUnread = useCallback((channelId: string) => {
    setUnread((prev) => {
      if (!prev[channelId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[channelId];
      return next;
    });
    void markChannelRead(channelId).catch(() => {
      // A missed read receipt only means a stale badge; not worth surfacing.
    });
  }, []);

  const loadUnread = useCallback(async (serverId: string) => {
    try {
      const { unread: rows } = await fetchUnread(serverId);
      setUnread((prev) => {
        const next = { ...prev };
        for (const row of rows) {
          if (row.count > 0 && row.channelId !== selectedChannelIdRef.current) {
            next[row.channelId] = {
              count: row.count,
              mentions: row.mentions,
            };
          } else {
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
          const seeded = unreadFromConversations(
            sorted,
            selectedChannelIdRef.current,
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
      setMentionCandidates([...conversationParticipants]);
      return;
    }
    if (!selectedServerId) {
      setMentionCandidates([]);
      return;
    }
    let cancelled = false;
    void fetchMembers(selectedServerId)
      .then(({ members }) => {
        if (!cancelled) {
          setMentionCandidates(members);
        }
      })
      .catch(() => {
        // Autocomplete degrades to typing the handle out; not worth an error.
      });
    return () => {
      cancelled = true;
    };
  }, [conversationParticipants, selectedServerId]);

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
      clearUnread(channelId);
      setMessagesLoading(true);
      chat.joinChannel(channelId);

      try {
        const page = await fetchMessages(channelId);
        if (selectedChannelIdRef.current !== channelId) {
          return;
        }
        chat.setMessages(page.messages, page.hasMore);
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

        // Settings the account carries win over this device's stored copy —
        // another device may have changed them since this browser last saw
        // them. Nothing is sent back: a tab that has been open for hours would
        // otherwise push its stale values over a newer choice made elsewhere.
        // Persisted locally so the next cold start renders them without a wait.
        if (me.preferences?.theme) {
          adoptThemePreference(me.preferences.theme);
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

        // Route voice media through the SFU when the server offers one.
        // Anything else (or a failure here) leaves the mesh path in place.
        try {
          const { backend } = isMeshForced()
            ? { backend: "mesh" as const }
            : await fetchVoiceBackend();
          if (!cancelled && backend === "livekit") {
            voice.setSessionProvider((voiceChannelId, peerId) =>
              createVoiceSession(voiceChannelId, peerId),
            );
          }
        } catch {
          // Older server without /api/voice/backend — mesh it is.
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
              /** Absent from an API that predates conversations. */
              kind?: ChannelKind;
            };
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

          if (
            message.type === "message-broadcast" ||
            message.type === "message-update" ||
            message.type === "message-delete" ||
            message.type === "reaction-broadcast" ||
            message.type === "message-deleted" ||
            message.type === "presence-update" ||
            message.type === "typing-broadcast"
          ) {
            chat.handleServerMessage(message);
            return;
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
            : "Failed to load servers from the API",
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
          error instanceof Error ? error.message : "Failed to load channels",
        );
      } finally {
        setChannelsLoading(false);
      }
    },
    [loadUnread, selectChannel, syncRoute],
  );

  async function handleCreateServer() {
    const name = newServerName.trim();
    if (!name || creatingServer) {
      return;
    }
    setCreatingServer(true);
    try {
      const { server, channels: newChannels } = await createServer(name);
      setServers((prev) => [...prev, server]);
      setSelection({ kind: "server", serverId: server.id });
      setChannels(newChannels);
      setNewServerName("");
      setShowCreateServer(false);
      setAppError(null);
      const general = newChannels.find((c) => c.type === "text");
      if (general) {
        await selectChannel(general.id, server.id);
      }
    } catch (error) {
      setAppError(
        error instanceof Error ? error.message : "Failed to create server",
      );
    } finally {
      setCreatingServer(false);
    }
  }

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
    if (!window.confirm("Delete this channel? Messages cannot be recovered.")) {
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
    if (!window.confirm("Leave this server?")) {
      return;
    }
    try {
      await leaveServer(serverId);
      await dropServer(serverId);
    } catch (error) {
      setAppError(
        error instanceof Error ? error.message : "Failed to leave server",
      );
    }
  }

  async function handleJoinVoice(channelId: string) {
    voiceServerIdRef.current = selectedServerId;
    try {
      const { iceServers } = await fetchIceServers();
      if (iceServers.length > 0) {
        voice.setIceServers(iceServers);
      }
    } catch {
      // Keep previously fetched / default ICE servers
    }

    await voice.join(channelId, {
      inputDeviceId: localSettings.inputDeviceId,
      inputVolume: localSettings.inputVolume,
      startMuted: localSettings.muteOnJoin,
    });
  }

  function handleAudioSettingsLive(next: LocalSettings) {
    const prevDeviceId = localSettings.inputDeviceId;
    setLocalSettings(next);
    saveLocalSettings(next);
    voice.setInputVolume(next.inputVolume);
    if (
      next.inputDeviceId !== prevDeviceId &&
      voice.getState().status !== "idle"
    ) {
      void voice.setInputDevice(next.inputDeviceId);
    }
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
      setSelection({ kind: "server", serverId });
      setChannelsLoading(true);
      try {
        const { channels: list } = await fetchChannels(serverId);
        setChannels(list);
        void loadUnread(serverId);
        const requested = channelId
          ? list.find((c) => c.id === channelId)
          : undefined;
        if (channelId && !requested) {
          setAppError("That channel no longer exists or is private.");
        }
        const target =
          requested ??
          list.find((c) => c.type === "text") ??
          list.find((c) => c.type !== "category");
        if (target) {
          await selectChannel(target.id, serverId);
          // Only after the newest page is in hand: the list flashes the row if
          // it is there and pulls history around it if it is not.
          if (messageId && target.id === channelId) {
            setHighlightMessageId(messageId);
          }
        } else {
          setSelectedChannelId(null);
          selectedChannelIdRef.current = null;
        }
      } catch (error) {
        setAppError(
          error instanceof Error
            ? error.message
            : "That link points to a server you cannot open.",
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
      setInviteCodeFromUrl(target.code);
      setInviteMode("join");
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
    const serverId = voiceServerIdRef.current;
    if (serverId && serverId !== selectedServerId) {
      await applyChannelRoute(serverId, channelId);
      return;
    }
    await selectChannel(channelId, serverId ?? undefined);
  }, [
    applyChannelRoute,
    selectChannel,
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

  const conversationUnread = conversationUnreadTotals(conversations, unread);

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

  if (!bootstrapReady) {
    return <AppLoadingShell label="Loading servers…" />;
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
  const canManage =
    selectedServer?.role === "owner" || selectedServer?.role === "admin";
  const voiceChannel =
    voiceState.voiceChannelId
      ? channels.find((c) => c.id === voiceState.voiceChannelId) ?? null
      : null;
  const isViewingVoiceChannel =
    selectedChannel?.type === "voice" &&
    selectedChannel.id === voiceState.voiceChannelId;

  const canDropFiles = isAttachmentsEnabled && selectedChannel?.type === "text";

  /**
   * The bottom of whichever sidebar is showing. Shared rather than duplicated:
   * an ongoing call and the mute button must not vanish because the reader
   * switched to their conversations.
   */
  const sidebarFooter = (
    <>
      {voiceState.status !== "idle" && !isViewingVoiceChannel && (
        <VoiceStatusBar
          channelName={voiceChannel?.name ?? "Voice"}
          status={voiceState.status}
          peerCount={voiceState.remotePeers.length}
          isMuted={voiceState.isMuted}
          isDeafened={voiceState.isDeafened}
          usingSfu={voiceState.usingSfu}
          onOpen={() => void openVoiceChannel()}
          onToggleMute={() => voice.toggleMute()}
          onToggleDeafen={() => voice.toggleDeafen()}
          onLeave={() => voice.leave()}
        />
      )}
      <UserPanel
        displayName={user?.displayName ?? "User"}
        tag={user?.tag ?? null}
        avatarUrl={user?.avatarUrl ?? null}
        isMuted={voiceState.isMuted}
        inVoice={voiceState.status === "connected"}
        showUserButton={showUserButton}
        onToggleMute={() => voice.toggleMute()}
        onOpenSettings={() => setSettingsOpen(true)}
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
            Drop to attach
          </p>
        </div>
      )}
      <header className="flex h-14 shrink-0 items-center border-b border-ink-4/60 px-3 sm:px-4">
        <button
          type="button"
          className="mr-2 rounded-md p-1.5 hover:bg-ink-3 md:hidden"
          aria-label="Open navigation"
          onClick={() => setMobileNavOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate font-display text-base font-bold">
            {selectedChannel.isPrivate && (
              <Lock className="h-3.5 w-3.5 shrink-0 text-warning" />
            )}
            {/* `#` names a channel inside a server. A conversation's title is a
                person, and hashing it renames them. */}
            {selectedChannel.kind === "server" &&
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
                : `${selectedChannel.isPrivate ? "Private · " : ""}${chat.getPresence().length} here`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs text-signal hover:bg-ink-3"
            onClick={() => setPinsOpen(true)}
          >
            Pins
          </button>
          {canManage && (
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs text-signal hover:bg-ink-3"
              onClick={() => setChannelMetaChannel(selectedChannel)}
            >
              Topic
            </button>
          )}
          {canManage && selectedChannel.isPrivate && (
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs text-signal hover:bg-ink-3"
              onClick={() => setChannelMembersChannel(selectedChannel)}
            >
              Access
            </button>
          )}
        </div>
      </header>
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
        canModerate={!!canManage}
        blockedAuthorIds={blockedUserIds}
        highlightMessageId={highlightMessageId}
        onHighlightHandled={clearHighlight}
        onReplyTo={setReplyTarget}
        onToggleReaction={(messageId, emoji) =>
          chat.toggleReaction(messageId, emoji)
        }
        onLoadOlder={() => chat.loadOlder()}
        onLoadNewer={loadNewerHistory}
        onJumpToMessage={jumpToMessage}
        onJumpToPresent={jumpToPresent}
        onEditMessage={(messageId, body) => chat.editMessage(messageId, body)}
        onDeleteMessage={(messageId) => chat.deleteMessage(messageId)}
        onPinMessage={(messageId) => chat.pinMessage(messageId)}
        onUnpinMessage={(messageId) => chat.unpinMessage(messageId)}
        onRetryMessage={(nonce) => chat.retryMessage(nonce)}
        onDiscardMessage={(nonce) => chat.discardMessage(nonce)}
        showLinkEmbeds={localSettings.showLinkEmbeds}
      />
      <MessageComposer
        // Remount per channel: the draft is component state, so without this a
        // half-typed message follows you into the next channel, one Enter away
        // from the wrong audience.
        key={selectedChannel.id}
        onSend={(body, attachments) => {
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
        disabled={!selectedChannelId || messagesLoading}
        placeholder={`Message ${selectedChannel.name}`}
      />
    </div>
  ) : null;

  return (
    <div className="animate-fade-in relative flex h-full overflow-hidden">
      {/* Mounted at the root so remote audio keeps playing when you navigate
          away from the voice channel. */}
      <VoiceAudioSinks
        peers={voiceState.remotePeers}
        peerVolumes={voiceState.peerVolumes}
        isDeafened={voiceState.isDeafened}
        outputDeviceId={localSettings.outputDeviceId}
        outputVolume={localSettings.outputVolume}
      />

      {mobileNavOpen && (
        <button
          type="button"
          className="fixed inset-0 z-20 bg-ink/70 md:hidden"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <ServerRail
        servers={servers}
        selectedServerId={selectedServerId}
        unread={unread}
        channels={channels}
        homeSelected={selection.kind === "dm"}
        homeUnread={conversationUnread}
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
          onHideConversation={(id) => void handleHideConversation(id)}
          onBlockUser={(person) => void handleBlockUser(person.id)}
          onUnblockUser={(id) => void handleUnblockUser(id)}
          footer={sidebarFooter}
        />
      ) : (
        <ChannelList
          server={selectedServer ?? null}
          channels={channels}
          selectedChannelId={selectedChannelId}
          canManage={!!canManage}
          isLoading={channelsLoading}
          voiceOccupancy={voiceState.occupancy}
          speakingPeerIds={voiceState.speakingPeerIds}
          activeVoiceChannelId={voiceState.voiceChannelId}
          unread={unread}
          mobileOpen={mobileNavOpen}
          onMobileClose={() => setMobileNavOpen(false)}
          onSelectChannel={(id) => void selectChannel(id)}
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
            Dev auth bypass
          </div>
        )}

        {(connection === "reconnecting" || connection === "unauthorized") && (
          <div
            className="flex items-center justify-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-xs text-warning"
            role="status"
          >
            <WifiOff className="h-3.5 w-3.5" />
            {connection === "unauthorized"
              ? "Session expired — reconnecting…"
              : "Connection lost — reconnecting…"}
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
              Dismiss
            </button>
          </div>
        )}

        {showCreateServer && (
          <div className="border-b border-ink-4/60 bg-ink-2 p-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={newServerName}
                onChange={(e) => setNewServerName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleCreateServer();
                  }
                }}
                placeholder="Server name"
                autoFocus
              />
              <div className="flex gap-2">
                <Button
                  onClick={() => void handleCreateServer()}
                  disabled={!newServerName.trim() || creatingServer}
                >
                  {creatingServer ? "Creating…" : "Create"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setShowCreateServer(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}

        {!selectedChannel && !channelsLoading && (
          <div className="flex flex-1 flex-col items-start justify-center gap-4 p-8">
            <button
              type="button"
              className="rounded-md p-2 hover:bg-ink-3 md:hidden"
              aria-label="Open navigation"
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu className="h-6 w-6" />
            </button>
            <p className="font-display text-3xl font-bold">
              {selection.kind === "dm"
                ? "No conversation open"
                : servers.length === 0
                  ? "No servers yet"
                  : "Pick a channel"}
            </p>
            <p className="max-w-sm text-paper-muted">
              {selection.kind === "dm"
                ? "Pick someone from the list, or message anyone by handle."
                : servers.length === 0
                  ? "Create a server or join with an invite code."
                  : "Open the sidebar and choose text or voice."}
            </p>
            {selection.kind === "dm" ? (
              <Button onClick={() => setNewDmOpen(true)}>New message</Button>
            ) : (
              servers.length === 0 && (
                <div className="flex gap-2">
                  <Button onClick={() => setShowCreateServer(true)}>
                    Create server
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setInviteMode("join")}
                  >
                    Join invite
                  </Button>
                </div>
              )
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

        {selectedChannel?.type === "voice" && (
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <div className="h-[38%] min-h-[160px] shrink-0 lg:h-auto lg:w-[min(100%,20rem)]">
              <VoicePanel
                channelName={selectedChannel.name}
                status={
                  voiceState.voiceChannelId === selectedChannel.id
                    ? voiceState.status
                    : "idle"
                }
                remotePeers={
                  voiceState.voiceChannelId === selectedChannel.id
                    ? voiceState.remotePeers
                    : []
                }
                self={
                  voiceState.voiceChannelId === selectedChannel.id
                    ? voiceState.self
                    : null
                }
                localPeerId={voiceState.peerId}
                speakingPeerIds={voiceState.speakingPeerIds}
                isMuted={voiceState.isMuted}
                isDeafened={voiceState.isDeafened}
                peerVolumes={voiceState.peerVolumes}
                error={voiceState.error}
                compactPeers={localSettings.compactPeers}
                usingSfu={voiceState.usingSfu}
                isSharingScreen={voiceState.isSharingScreen}
                screenSharePeerId={
                  voiceState.voiceChannelId === selectedChannel.id
                    ? voiceState.screenSharePeerId
                    : null
                }
                onJoin={() => void handleJoinVoice(selectedChannel.id)}
                onLeave={() => voice.leave()}
                onToggleMute={() => voice.toggleMute()}
                onToggleDeafen={() => voice.toggleDeafen()}
                onSetPeerVolume={(userId, volume) =>
                  voice.setPeerVolume(userId, volume)
                }
                onRetryPeer={(peerId) => {
                  void voice.retryPeer(peerId);
                }}
                onStartScreenShare={() => void voice.startScreenShare()}
                onStopScreenShare={() => void voice.stopScreenShare()}
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              {voiceState.voiceChannelId === selectedChannel.id &&
                voiceState.screenSharePeerId && (
                  <ScreenShareView
                    stream={
                      voiceState.screenSharePeerId === voiceState.peerId
                        ? voiceState.localScreenStream
                        : (voiceState.remotePeers.find(
                            (p) => p.peerId === voiceState.screenSharePeerId,
                          )?.screenStream ?? null)
                    }
                    presenterName={
                      voiceState.remotePeers.find(
                        (p) => p.peerId === voiceState.screenSharePeerId,
                      )?.displayName ?? "Someone"
                    }
                    isSelf={voiceState.screenSharePeerId === voiceState.peerId}
                    onStopSharing={() => void voice.stopScreenShare()}
                  />
                )}
              {chatPane}
            </div>
          </div>
        )}
      </main>

      <SettingsModal
        open={settingsOpen}
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
        onClose={() => setServerSettingsOpen(false)}
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
          void dropServer(serverId);
        }}
      />

      <InvitePanel
        open={inviteMode !== null}
        mode={inviteMode ?? "join"}
        serverId={selectedServerId}
        serverName={selectedServer?.name ?? null}
        canManage={!!canManage}
        initialCode={inviteCodeFromUrl}
        onClose={() => {
          setInviteMode(null);
          setInviteCodeFromUrl(null);
        }}
        onJoined={(serverId) => {
          setInviteCodeFromUrl(null);
          void refreshAfterJoin(serverId);
        }}
      />

      <MembersPanel
        open={membersOpen}
        serverId={selectedServerId}
        serverName={selectedServer?.name ?? null}
        role={selectedServer?.role ?? "member"}
        currentUserId={user?.id ?? null}
        blockedUserIds={blockedUserIds}
        onClose={() => setMembersOpen(false)}
        onMention={(username) => {
          setComposerInsert(`@${username}`);
          setMembersOpen(false);
        }}
        onBlockUser={(userId) => void handleBlockUser(userId)}
        onUnblockUser={(userId) => void handleUnblockUser(userId)}
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
        serverId={selectedServerId}
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
        canUnpin={selectedServerId ? !!canManage : true}
        onClose={() => setPinsOpen(false)}
        onJumpToMessage={(messageId) => void jumpToMessage(messageId)}
      />

      <PromptDialog
        open={channelPrompt !== null}
        title={
          channelPrompt?.mode === "rename"
            ? channelPrompt.channel?.type === "category"
              ? "Rename category"
              : "Rename channel"
            : channelPrompt?.type === "category"
              ? "Create category"
              : `Create ${channelPrompt?.type ?? "text"} channel`
        }
        placeholder="channel-name"
        confirmLabel={channelPrompt?.mode === "rename" ? "Rename" : "Create"}
        initialValue={
          channelPrompt?.mode === "rename"
            ? (channelPrompt.channel?.name ?? "")
            : ""
        }
        checkboxLabel={
          channelPrompt?.mode === "create" && channelPrompt.type !== "category"
            ? "Private channel"
            : undefined
        }
        checkboxDefault={channelPrompt?.isPrivate ?? false}
        onClose={() => setChannelPrompt(null)}
        onConfirm={(name, isPrivate) =>
          handleChannelPromptConfirm(name, isPrivate)
        }
      />

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
  );
}

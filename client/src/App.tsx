import { SignInButton, SignUpButton, useAuth } from "@clerk/clerk-react";
import { Lock, Menu, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { Channel, Server, User } from "@pqp/shared";
import { MessageComposer } from "@/components/chat/message-composer";
import { MessageList } from "@/components/chat/message-list";
import {
  AppBootstrapError,
  AppLoadingShell,
} from "@/components/layout/app-loading-shell";
import { ChannelList } from "@/components/layout/channel-list";
import { ChannelMembersPanel } from "@/components/layout/channel-members-panel";
import { ChannelMetaDialog } from "@/components/layout/channel-meta-dialog";
import { InvitePanel } from "@/components/layout/invite-panel";
import { MembersPanel } from "@/components/layout/members-panel";
import { ServerRail } from "@/components/layout/server-rail";
import { ServerSettingsDialog } from "@/components/layout/server-settings-dialog";
import {
  defaultLocalSettings,
  loadLocalSettings,
  saveLocalSettings,
  SettingsModal,
  type LocalSettings,
} from "@/components/layout/settings-modal";
import { UserPanel } from "@/components/layout/user-panel";
import { VoiceAudioSinks } from "@/components/voice/voice-audio-sinks";
import { VoicePanel } from "@/components/voice/voice-panel";
import { VoiceStatusBar } from "@/components/voice/voice-status-bar";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { Seo } from "@/components/marketing/seo";
import { createChatController } from "@/hooks/use-chat";
import { createVoiceController } from "@/hooks/use-voice";
import {
  createChannel,
  createServer,
  createVoiceSession,
  deleteChannel,
  fetchChannels,
  fetchIceServers,
  fetchMe,
  fetchMessages,
  fetchServers,
  fetchUnread,
  fetchVoiceBackend,
  joinInvite,
  leaveServer,
  markChannelRead,
  setAuthTokenProvider,
  updateChannel,
  updateMe,
} from "@/lib/api";
import { channelRoutePath, parseAppRoute } from "@/lib/app-route";
import { DEV_AUTH_TOKEN, getAuthToken, isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { getDesktop } from "@/lib/desktop";
import { createRealtimeTransport, type RealtimeStatus } from "@/lib/realtime";
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
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,oklch(0.35_0.12_125/0.25),transparent_40%)]" />
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
  type?: "text" | "voice";
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
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
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
  const [channelMembersChannel, setChannelMembersChannel] =
    useState<Channel | null>(null);
  const [channelPrompt, setChannelPrompt] = useState<ChannelPromptState | null>(
    null,
  );
  const [channelMetaChannel, setChannelMetaChannel] = useState<Channel | null>(
    null,
  );
  const [composerInsert, setComposerInsert] = useState<string | null>(null);
  const [localSettings, setLocalSettings] = useState<LocalSettings>(
    defaultLocalSettings,
  );
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [unread, setUnread] = useState<Record<string, UnreadState>>({});
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
  /** Which server owns the active call — `channels` only holds the selected one. */
  const voiceServerIdRef = useRef<string | null>(null);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Every request pulls a fresh token from Clerk. Holding one in state meant
  // that after the ~1 minute token lifetime every action failed with 401.
  useEffect(() => {
    setAuthTokenProvider(resolveToken);
  }, [resolveToken]);

  useEffect(() => {
    setLocalSettings(loadLocalSettings());
  }, []);

  useEffect(() => {
    chat.onChange(refresh);
    voice.onStateChange(setVoiceState);
    return () => {
      chat.dispose();
    };
  }, [chat, voice, refresh]);

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

  const openChannel = useCallback(
    async (channelId: string, channelList: Channel[], serverId?: string) => {
      const channel = channelList.find((c) => c.id === channelId);
      if (!channel) {
        return;
      }

      setSelectedChannelId(channelId);
      selectedChannelIdRef.current = channelId;
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
      void serverId;
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

        let initialChannels: Channel[] = [];
        let initialChannelId: string | null = null;
        const first = serverList[0];

        if (first) {
          setSelectedServerId(first.id);
          setChannelsLoading(true);
          try {
            const { channels: channelList } = await fetchChannels(first.id);
            if (cancelled) {
              return;
            }
            initialChannels = channelList;
            setChannels(channelList);
            initialChannelId =
              channelList.find((c) => c.type === "text")?.id ?? null;
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
            };
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
              void openChannel(initialChannelId, initialChannels, first?.id);
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
   */
  const syncRoute = useCallback(
    (serverId: string | null, channelId: string | null) => {
      if (!serverId) {
        return;
      }
      const path = channelRoutePath(serverId, channelId);
      if (routeRef.current === path) {
        return;
      }
      routeRef.current = path;
      navigate(path, { replace: true });
    },
    [navigate],
  );

  const selectChannel = useCallback(
    async (
      channelId: string,
      channelList = channels,
      serverIdOverride?: string,
    ) => {
      syncRoute(serverIdOverride ?? selectedServerId, channelId);
      // Voice deliberately survives navigating away: leaving a call because you
      // clicked another channel is not how a chat app should behave.
      await openChannel(channelId, channelList, serverIdOverride);
    },
    [channels, openChannel, selectedServerId, syncRoute],
  );

  const loadChannels = useCallback(
    async (serverId: string) => {
      setChannelsLoading(true);
      try {
        const { channels: list } = await fetchChannels(serverId);
        setChannels(list);
        void loadUnread(serverId);
        const general = list.find((c) => c.type === "text") ?? list[0];
        if (general) {
          await selectChannel(general.id, list, serverId);
        } else {
          setSelectedChannelId(null);
          selectedChannelIdRef.current = null;
          syncRoute(serverId, null);
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
      setSelectedServerId(server.id);
      setChannels(newChannels);
      setNewServerName("");
      setShowCreateServer(false);
      setAppError(null);
      const general = newChannels.find((c) => c.type === "text");
      if (general) {
        await selectChannel(general.id, newChannels, server.id);
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
        await selectChannel(channel.id, next);
        if (channel.isPrivate) {
          setChannelMembersChannel(channel);
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
      const next = channels.filter((c) => c.id !== channelId);
      setChannels(next);
      if (voiceState.voiceChannelId === channelId) {
        voice.leave();
      }
      if (selectedChannelId === channelId) {
        const fallback = next.find((c) => c.type === "text") ?? next[0];
        if (fallback) {
          await selectChannel(fallback.id, next);
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
          setSelectedServerId(next.id);
          await loadChannels(next.id);
        } else {
          setSelectedServerId(null);
          setChannels([]);
          setSelectedChannelId(null);
          selectedChannelIdRef.current = null;
        }
      }
      setAppError(null);
    },
    [loadChannels, selectedServerId, servers, voice, voiceState.voiceChannelId],
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
      setSelectedServerId(serverId);
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
    async (serverId: string, channelId: string | null) => {
      setSelectedServerId(serverId);
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
          requested ?? list.find((c) => c.type === "text") ?? list[0];
        if (target) {
          await selectChannel(target.id, list, serverId);
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
    void applyChannelRoute(target.serverId, target.channelId);
    // applyChannelRoute reads current state; re-running only on path/readiness
    // changes is intentional — selection changes write the URL via syncRoute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapReady, location.pathname]);

  function openInviteForServer(serverId: string) {
    setSelectedServerId(serverId);
    void loadChannels(serverId);
    setInviteMode("create");
  }

  function openMembersForServer(serverId: string) {
    setSelectedServerId(serverId);
    void loadChannels(serverId);
    setMembersOpen(true);
  }

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

  const selectedChannel = channels.find((c) => c.id === selectedChannelId);
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

  const chatPane = selectedChannel ? (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
            {selectedChannel.type === "text" && !selectedChannel.isPrivate
              ? "#"
              : ""}
            {selectedChannel.name}
          </p>
          <p className="truncate text-[11px] text-paper-muted">
            {selectedChannel.topic
              ? selectedChannel.topic
              : `${selectedChannel.isPrivate ? "Private · " : ""}${chat.getPresence().length} here`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
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
        channelId={selectedChannel.id}
        isLoading={messagesLoading}
        hasMore={chat.hasMoreHistory()}
        isLoadingOlder={chat.isLoadingOlder()}
        typingUsers={chat.getTypingUsers()}
        canModerate={!!canManage}
        onToggleReaction={(messageId, emoji) =>
          chat.toggleReaction(messageId, emoji)
        }
        onLoadOlder={() => chat.loadOlder()}
        onEditMessage={(messageId, body) => chat.editMessage(messageId, body)}
        onDeleteMessage={(messageId) => chat.deleteMessage(messageId)}
        onRetryMessage={(nonce) => chat.retryMessage(nonce)}
        onDiscardMessage={(nonce) => chat.discardMessage(nonce)}
      />
      <MessageComposer
        onSend={(body) => chat.sendMessage(body)}
        onTyping={() => chat.notifyTyping()}
        insertText={composerInsert}
        onInsertConsumed={() => setComposerInsert(null)}
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
        onSelectServer={(id) => {
          setSelectedServerId(id);
          void loadChannels(id);
          setMobileNavOpen(true);
        }}
        onCreateServer={() => setShowCreateServer(true)}
        onJoinServer={() => setInviteMode("join")}
        onInvite={openInviteForServer}
        onOpenMembers={openMembersForServer}
        onOpenSettings={(id) => {
          setSelectedServerId(id);
          setServerSettingsOpen(true);
        }}
        onLeaveServer={(id) => void handleLeaveServer(id)}
      />

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
        onTogglePrivate={(ch) => void handleTogglePrivate(ch)}
        onManageChannelMembers={setChannelMembersChannel}
        onInvite={() => setInviteMode("create")}
        onOpenMembers={() => setMembersOpen(true)}
        onOpenServerSettings={() => setServerSettingsOpen(true)}
        footer={
          <>
            {voiceState.status !== "idle" && !isViewingVoiceChannel && (
              <VoiceStatusBar
                channelName={voiceChannel?.name ?? "Voice"}
                status={voiceState.status}
                peerCount={voiceState.remotePeers.length}
                isMuted={voiceState.isMuted}
                isDeafened={voiceState.isDeafened}
                usingSfu={voiceState.usingSfu}
                onOpen={() => {
                  if (voiceState.voiceChannelId) {
                    void selectChannel(voiceState.voiceChannelId);
                  }
                }}
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
        }
      />

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
              {servers.length === 0 ? "No servers yet" : "Pick a channel"}
            </p>
            <p className="max-w-sm text-paper-muted">
              {servers.length === 0
                ? "Create a server or join with an invite code."
                : "Open the sidebar and choose text or voice."}
            </p>
            {servers.length === 0 && (
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
              />
            </div>
            {chatPane}
          </div>
        )}
      </main>

      <SettingsModal
        open={settingsOpen}
        user={user}
        localSettings={localSettings}
        voiceAnalyser={voice.getAnalyser()}
        onClose={() => setSettingsOpen(false)}
        onLocalSave={setLocalSettings}
        onUserUpdated={(updated) => {
          setUser(updated);
          chat.setCurrentUser(updated);
        }}
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
        onClose={() => setMembersOpen(false)}
        onMention={(username) => {
          setComposerInsert(`@${username}`);
          setMembersOpen(false);
        }}
      />

      <ChannelMembersPanel
        open={channelMembersChannel !== null}
        channelId={channelMembersChannel?.id ?? null}
        channelName={channelMembersChannel?.name ?? null}
        serverId={selectedServerId}
        onClose={() => setChannelMembersChannel(null)}
      />

      <PromptDialog
        open={channelPrompt !== null}
        title={
          channelPrompt?.mode === "rename"
            ? "Rename channel"
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
          channelPrompt?.mode === "create" ? "Private channel" : undefined
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

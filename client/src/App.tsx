import {
  SignInButton,
  SignUpButton,
  useAuth,
} from "@clerk/clerk-react";
import { Lock, Menu } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
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
import {
  defaultLocalSettings,
  loadLocalSettings,
  saveLocalSettings,
  SettingsModal,
  type LocalSettings,
} from "@/components/layout/settings-modal";
import { UserPanel } from "@/components/layout/user-panel";
import { VoicePanel } from "@/components/voice/voice-panel";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { Seo } from "@/components/marketing/seo";
import { createChatController } from "@/hooks/use-chat";
import { createVoiceController } from "@/hooks/use-voice";
import {
  createChannel,
  createServer,
  deleteChannel,
  fetchChannels,
  fetchIceServers,
  fetchMe,
  fetchMessages,
  fetchServers,
  joinInvite,
  leaveServer,
  updateChannel,
  updateMe,
} from "@/lib/api";
import {
  DEV_AUTH_TOKEN,
  getAuthToken,
  isDevAuthBypassEnabled,
} from "@/lib/dev-auth";
import { getDesktop } from "@/lib/desktop";
import { createRealtimeTransport } from "@/lib/realtime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  const resolveToken = useCallback(
    () => getAuthToken(() => getTokenRef.current()),
    [],
  );

  return <MainAppContent resolveToken={resolveToken} showUserButton />;
}

interface MainAppContentProps {
  resolveToken: () => Promise<string | null>;
  showUserButton?: boolean;
}

interface ChannelPromptState {
  mode: "create" | "rename";
  type?: "text" | "voice";
  isPrivate?: boolean;
  channel?: Channel;
}

function MainAppContent({
  resolveToken,
  showUserButton = false,
}: MainAppContentProps) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    null,
  );
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [newServerName, setNewServerName] = useState("");
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteMode, setInviteMode] = useState<"create" | "join" | null>(null);
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
  const [, setTick] = useState(0);

  const transport = useMemo(() => createRealtimeTransport(), []);
  const chat = useMemo(() => createChatController(transport), [transport]);
  const voice = useMemo(() => createVoiceController(transport), [transport]);
  const [voiceState, setVoiceState] = useState(voice.getState());

  const resolveTokenRef = useRef(resolveToken);
  resolveTokenRef.current = resolveToken;
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    setLocalSettings(loadLocalSettings());
  }, []);

  useEffect(() => {
    chat.onChange(refresh);
    voice.onStateChange(setVoiceState);
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

  useEffect(() => {
    let cancelled = false;
    const transport = transportRef.current;
    const chat = chatRef.current;
    const voice = voiceRef.current;

    async function bootstrapChannel(channelId: string, authToken: string) {
      setMessagesLoading(true);
      chat.joinChannel(channelId);
      try {
        const { messages } = await fetchMessages(authToken, channelId);
        if (cancelled) {
          return;
        }
        chat.setMessages(messages);
        refresh();
      } finally {
        if (!cancelled) {
          setMessagesLoading(false);
        }
      }
    }

    async function init() {
      setBootstrapReady(false);
      setBootstrapError(null);

      try {
        const authToken = await resolveTokenRef.current();
        if (!authToken || cancelled) {
          return;
        }
        setToken(authToken);

        const me = await fetchMe(authToken);
        if (cancelled) {
          return;
        }
        setUser(me);
        chat.setCurrentUserId(me.id);

        try {
          const { iceServers } = await fetchIceServers(authToken);
          if (!cancelled && iceServers.length > 0) {
            voice.setIceServers(iceServers);
          }
        } catch {
          // STUN / VITE_TURN fallbacks still apply
        }

        const { servers: serverList } = await fetchServers(authToken);
        if (cancelled) {
          return;
        }
        setServers(serverList);

        let initialChannelId: string | null = null;

        if (serverList.length > 0) {
          const first = serverList[0]!;
          setSelectedServerId(first.id);
          setChannelsLoading(true);
          try {
            const { channels: channelList } = await fetchChannels(
              authToken,
              first.id,
            );
            if (cancelled) {
              return;
            }
            setChannels(channelList);
            const general = channelList.find((c) => c.type === "text");
            if (general) {
              initialChannelId = general.id;
              setSelectedChannelId(general.id);
              setMessagesLoading(true);
            }
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
          if (
            message.type === "message-broadcast" ||
            message.type === "reaction-broadcast" ||
            message.type === "presence-update"
          ) {
            chat.handleServerMessage(message);
            return;
          }
          voice.handleSignaling(message);
        });

        transport.onError((message) => setRealtimeError(message));

        transport.onReady(() => {
          setRealtimeError(null);
          if (initialChannelId) {
            void bootstrapChannel(initialChannelId, authToken);
          }
        });

        transport.connect(authToken);
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
      transport.disconnect();
      voice.leave();
    };
    // Only re-bootstrap on explicit retry — unstable Clerk token fn must not remount.
  }, [bootstrapAttempt, refresh]);

  async function loadChannels(serverId: string) {
    const authToken = token ?? (await resolveToken());
    if (!authToken) {
      return;
    }
    setChannelsLoading(true);
    try {
      const { channels: list } = await fetchChannels(authToken, serverId);
      setChannels(list);
      const general = list.find((c) => c.type === "text") ?? list[0];
      if (general) {
        await selectChannel(general.id, list);
      } else {
        setSelectedChannelId(null);
      }
    } finally {
      setChannelsLoading(false);
    }
  }

  async function selectChannel(channelId: string, channelList = channels) {
    const channel = channelList.find((c) => c.id === channelId);
    if (!channel) {
      return;
    }

    if (
      voiceState.voiceChannelId &&
      voiceState.voiceChannelId !== channelId
    ) {
      voice.leave();
    }

    setSelectedChannelId(channelId);
    setMessagesLoading(true);

    const authToken = token ?? (await resolveToken());
    if (!authToken) {
      setMessagesLoading(false);
      return;
    }

    chat.joinChannel(channelId);
    try {
      const { messages } = await fetchMessages(authToken, channelId);
      chat.setMessages(messages);
      refresh();
    } finally {
      setMessagesLoading(false);
    }
  }

  async function handleCreateServer() {
    const authToken = token ?? (await resolveToken());
    if (!authToken || !newServerName.trim()) {
      return;
    }
    try {
      const { server, channels: newChannels } = await createServer(
        authToken,
        newServerName.trim(),
      );
      setServers((prev) => [...prev, server]);
      setSelectedServerId(server.id);
      setChannels(newChannels);
      setNewServerName("");
      setShowCreateServer(false);
      setRealtimeError(null);
      const general = newChannels.find((c) => c.type === "text");
      if (general) {
        setSelectedChannelId(general.id);
        setMessagesLoading(true);
        chat.joinChannel(general.id);
        try {
          const { messages } = await fetchMessages(authToken, general.id);
          chat.setMessages(messages);
          refresh();
        } finally {
          setMessagesLoading(false);
        }
      }
    } catch (error) {
      setRealtimeError(
        error instanceof Error ? error.message : "Failed to create server",
      );
    }
  }

  function requestCreateChannel(type: "text" | "voice", isPrivate: boolean) {
    setChannelPrompt({ mode: "create", type, isPrivate });
  }

  function requestRenameChannel(channel: Channel) {
    setChannelPrompt({ mode: "rename", channel });
  }

  async function handleChannelPromptConfirm(name: string, isPrivate?: boolean) {
    const authToken = token ?? (await resolveToken());
    if (!authToken || !channelPrompt) {
      return;
    }

    try {
      if (channelPrompt.mode === "create") {
        if (!selectedServerId || !channelPrompt.type) {
          setRealtimeError("Select a server before creating a channel");
          return;
        }
        const { channel } = await createChannel(
          authToken,
          selectedServerId,
          name,
          channelPrompt.type,
          isPrivate ?? channelPrompt.isPrivate ?? false,
        );
        const next = [...channels, channel].sort(
          (a, b) => a.position - b.position,
        );
        setChannels(next);
        setRealtimeError(null);
        setChannelPrompt(null);
        await selectChannel(channel.id, next);
        if (channel.isPrivate) {
          setChannelMembersChannel(channel);
        }
        return;
      }

      if (channelPrompt.channel) {
        const { channel } = await updateChannel(
          authToken,
          channelPrompt.channel.id,
          { name },
        );
        setChannels((prev) =>
          prev.map((c) => (c.id === channel.id ? channel : c)),
        );
        setChannelPrompt(null);
        setRealtimeError(null);
      }
    } catch (error) {
      setRealtimeError(
        error instanceof Error ? error.message : "Channel action failed",
      );
    }
  }

  async function handleTogglePrivate(channel: Channel) {
    const authToken = token ?? (await resolveToken());
    if (!authToken) {
      return;
    }
    try {
      const { channel: updated } = await updateChannel(authToken, channel.id, {
        isPrivate: !channel.isPrivate,
      });
      setChannels((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      );
      if (updated.isPrivate) {
        setChannelMembersChannel(updated);
      }
      setRealtimeError(null);
    } catch (error) {
      setRealtimeError(
        error instanceof Error ? error.message : "Failed to update channel",
      );
    }
  }

  async function handleDeleteChannel(channelId: string) {
    const authToken = token ?? (await resolveToken());
    if (!authToken) {
      return;
    }
    if (!window.confirm("Delete this channel?")) {
      return;
    }
    try {
      await deleteChannel(authToken, channelId);
      const next = channels.filter((c) => c.id !== channelId);
      setChannels(next);
      if (selectedChannelId === channelId) {
        const fallback = next[0];
        if (fallback) {
          await selectChannel(fallback.id, next);
        } else {
          setSelectedChannelId(null);
        }
      }
    } catch (error) {
      setRealtimeError(
        error instanceof Error ? error.message : "Failed to delete channel",
      );
    }
  }

  async function handleLeaveServer(serverId: string) {
    const authToken = token ?? (await resolveToken());
    if (!authToken) {
      return;
    }
    if (!window.confirm("Leave this server?")) {
      return;
    }
    try {
      await leaveServer(authToken, serverId);
      const nextServers = servers.filter((s) => s.id !== serverId);
      setServers(nextServers);
      if (selectedServerId === serverId) {
        const next = nextServers[0];
        if (next) {
          setSelectedServerId(next.id);
          await loadChannels(next.id);
        } else {
          setSelectedServerId(null);
          setChannels([]);
          setSelectedChannelId(null);
        }
      }
      setRealtimeError(null);
    } catch (error) {
      setRealtimeError(
        error instanceof Error ? error.message : "Failed to leave server",
      );
    }
  }

  async function handleJoinVoice(channelId: string) {
    const authToken = token ?? (await resolveToken());
    if (authToken) {
      try {
        const { iceServers } = await fetchIceServers(authToken);
        if (iceServers.length > 0) {
          voice.setIceServers(iceServers);
        }
      } catch {
        // Keep previously fetched / default ICE servers
      }
    }

    await voice.join(channelId, {
      inputDeviceId: localSettings.inputDeviceId,
      inputVolume: localSettings.inputVolume,
    });
    if (localSettings.muteOnJoin) {
      const started = Date.now();
      const interval = setInterval(() => {
        const state = voice.getState();
        if (state.status === "connected") {
          if (!state.isMuted) {
            voice.toggleMute();
          }
          clearInterval(interval);
        }
        if (Date.now() - started > 15_000) {
          clearInterval(interval);
        }
      }, 200);
    }
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

  async function refreshAfterJoin(serverId: string) {
    const authToken = token ?? (await resolveToken());
    if (!authToken) {
      return;
    }
    const { servers: serverList } = await fetchServers(authToken);
    setServers(serverList);
    setSelectedServerId(serverId);
    await loadChannels(serverId);
  }

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

  const chatPane = selectedChannel ? (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center border-b border-ink-4/60 px-3 sm:px-4">
        <button
          type="button"
          className="mr-2 rounded-md p-1.5 hover:bg-ink-3 md:hidden"
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
          <p className="text-[11px] text-paper-muted">
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
        channelId={selectedChannel.id}
        isLoading={messagesLoading}
        onToggleReaction={(messageId, emoji) =>
          chat.toggleReaction(messageId, emoji)
        }
      />
      <MessageComposer
        onSend={(body) => chat.sendMessage(body)}
        insertText={composerInsert}
        onInsertConsumed={() => setComposerInsert(null)}
        slashContext={{
          updateDisplayName: async (name: string) => {
            const authToken = token ?? (await resolveToken());
            if (!authToken) {
              throw new Error("Not signed in");
            }
            const updated = await updateMe(authToken, { displayName: name });
            setUser(updated);
          },
          openInvite: (mode: "create" | "join") => setInviteMode(mode),
          joinByCode: async (code: string) => {
            const authToken = token ?? (await resolveToken());
            if (!authToken) {
              throw new Error("Not signed in");
            }
            const result = await joinInvite(authToken, code);
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
        onSelectServer={(id) => {
          setSelectedServerId(id);
          void loadChannels(id);
          setMobileNavOpen(true);
        }}
        onCreateServer={() => setShowCreateServer(true)}
        onJoinServer={() => setInviteMode("join")}
        onInvite={openInviteForServer}
        onOpenMembers={openMembersForServer}
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
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
        onSelectChannel={(id) => void selectChannel(id)}
        onCreateChannel={requestCreateChannel}
        onRenameChannel={requestRenameChannel}
        onEditChannelMeta={setChannelMetaChannel}
        onDeleteChannel={(id) => void handleDeleteChannel(id)}
        onTogglePrivate={(ch) => void handleTogglePrivate(ch)}
        onManageChannelMembers={setChannelMembersChannel}
        onInvite={() => setInviteMode("create")}
        onOpenMembers={() => setMembersOpen(true)}
        footer={
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
        }
      />

      <main className="flex min-w-0 flex-1 flex-col bg-transparent">
        {isDevAuthBypassEnabled() && (
          <div className="border-b border-warning/30 bg-warning/10 px-3 py-1 text-center text-xs text-warning">
            Dev auth bypass
          </div>
        )}

        {realtimeError && (
          <div className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
            {realtimeError}
          </div>
        )}

        {showCreateServer && (
          <div className="border-b border-ink-4/60 bg-ink-2 p-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={newServerName}
                onChange={(e) => setNewServerName(e.target.value)}
                placeholder="Server name"
                autoFocus
              />
              <div className="flex gap-2">
                <Button onClick={() => void handleCreateServer()}>
                  Create
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
                status={voiceState.status}
                remotePeers={voiceState.remotePeers}
                self={voiceState.self}
                localPeerId={voiceState.peerId}
                speakingPeerIds={voiceState.speakingPeerIds}
                isMuted={voiceState.isMuted}
                error={voiceState.error}
                compactPeers={localSettings.compactPeers}
                outputDeviceId={localSettings.outputDeviceId}
                outputVolume={localSettings.outputVolume}
                onJoin={() => void handleJoinVoice(selectedChannel.id)}
                onLeave={() => voice.leave()}
                onToggleMute={() => voice.toggleMute()}
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
        token={token}
        localSettings={localSettings}
        voiceAnalyser={voice.getAnalyser()}
        onClose={() => setSettingsOpen(false)}
        onLocalSave={setLocalSettings}
        onUserUpdated={setUser}
        onAudioSettingsLive={handleAudioSettingsLive}
      />

      <InvitePanel
        open={inviteMode !== null}
        mode={inviteMode ?? "join"}
        serverId={selectedServerId}
        serverName={selectedServer?.name ?? null}
        token={token}
        canManage={!!canManage}
        onClose={() => setInviteMode(null)}
        onJoined={(serverId) => void refreshAfterJoin(serverId)}
      />

      <MembersPanel
        open={membersOpen}
        serverId={selectedServerId}
        serverName={selectedServer?.name ?? null}
        token={token}
        isOwner={selectedServer?.role === "owner"}
        currentUserId={user?.id ?? null}
        onClose={() => setMembersOpen(false)}
        onMention={(displayName) => {
          setComposerInsert(`@${displayName}`);
          setMembersOpen(false);
        }}
      />

      <ChannelMembersPanel
        open={channelMembersChannel !== null}
        channelId={channelMembersChannel?.id ?? null}
        channelName={channelMembersChannel?.name ?? null}
        serverId={selectedServerId}
        token={token}
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
        onConfirm={(name, isPrivate) => {
          void handleChannelPromptConfirm(name, isPrivate);
        }}
      />

      <ChannelMetaDialog
        open={channelMetaChannel !== null}
        channel={channelMetaChannel}
        onClose={() => setChannelMetaChannel(null)}
        onSave={async (updates) => {
          const authToken = token ?? (await resolveToken());
          if (!authToken || !channelMetaChannel) {
            return;
          }
          const { channel } = await updateChannel(
            authToken,
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

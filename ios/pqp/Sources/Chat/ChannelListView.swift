import SwiftUI

struct ChannelListView: View {
    @Environment(SessionStore.self) private var session
    /// For a host landing on their party's channel; see `landOnHostStage`.
    @Environment(VoiceModel.self) private var voice
    @Environment(\.dismiss) private var dismiss
    /// Foregrounding is one of the two moments `scheduleAvailabilityRetry`
    /// tries again promptly rather than waiting out whatever backoff delay
    /// was already in progress -- see the `.onChange` below.
    @Environment(\.scenePhase) private var scenePhase
    let server: Server

    /// Set only when the app is restoring where the user left off: this list is
    /// built and the channel is pushed on top of it, so the back button lands
    /// somewhere real instead of on an empty stack.
    let initialChannel: Channel?

    init(server: Server, initialChannel: Channel? = nil) {
        self.server = server
        self.initialChannel = initialChannel
        _current = State(initialValue: server)
    }

    @State private var channels: [Channel] = []
    @State private var unread: [String: UnreadEntry] = [:]
    @State private var isLoading = true
    @State private var error: String?
    /// The Baú's instance flags. Nil until asked; off on any failure. The row
    /// needs this AND the server's own switch, so a deployment without the
    /// feature (production until PR #176) draws nothing and loses nothing.
    @State private var communityHome: CommunityHomeConfig?
    /// Posts in the Baú this account has not opened it for. Read with the
    /// channel counts and cleared the same way: coming back from the Baú
    /// re-reads it, after `CommunityHomeView` has told the server it was
    /// read.
    @State private var bauUnread = 0
    /**
     Channels with a picture on them right now, from `channel-live`.

     Not seeded over REST, and not a gap. The server restates every live
     channel to everybody who may see it on the audience keyframe clock
     (`ROSTER_AUDIENCE_KEYFRAME_MS`, 30 s) for as long as the broadcast runs,
     so a list opened mid-party gains its pill within half a minute and a
     party that starts while somebody is looking at the list gains it at once.
     The catch-up burst that would answer instantly is sent at socket auth,
     which happened long before this screen existed, so asking for it is not
     an option this view has.
     */
    @State private var liveChannels: Set<String> = []
    /// Viewers watching without a seat, by channel id -- the other half of
    /// `channel-live`'s payload, read alongside `liveChannels` above.
    /// `WatchPartySidebarSlot`'s only use for it: a cheap viewer count on
    /// the live card that costs no request of its own.
    @State private var watchingByChannel: [String: Int] = [:]
    /// Every party this account may see in THIS server -- live, plus any
    /// draft/scheduled one it hosts or co-hosts -- from
    /// `GET /api/servers/:serverId/watch-parties` and kept current by
    /// `watch-party-update` frames. See `resolveServerWatchPartyListState`.
    ///
    /// `nil` MEANS UNKNOWN, NOT "FETCHED, FOUND NONE" -- see that function's
    /// own doc on its `parties` parameter. A failed fetch or refetch leaves
    /// this exactly as it was rather than clearing it (`load()`,
    /// `reconcileChannelsAndParties()`): the only way this is genuinely
    /// `nil` is before the very first successful read.
    @State private var serverWatchParties: [WatchPartyPayload]?
    /// Whether this server may broadcast at all (`GET /api/live-hls/config`).
    /// Off on any failure, matching `WatchPartyHostGate`'s own reasoning: a
    /// self-host with nothing configured must not draw a Create row that
    /// cannot go anywhere.
    @State private var liveHlsConfig: LiveHlsConfigPayload = .off
    /// This account's own resolved permission bitfields for this server --
    /// `GET /api/servers/:serverId/permissions`. Nil until the first answer
    /// lands; `canHostWatchParty` reads that as "not yet knowable", which is
    /// what `PermissionsSnapshot.can` returning `false` by way of `?? false`
    /// gives it for free -- see that property's own doc.
    @State private var watchPartyPermissions: PermissionsSnapshot?
    /// The in-flight retry loop for `liveHlsConfig`/`watchPartyPermissions`,
    /// if either is currently missing a clean answer. See
    /// `scheduleAvailabilityRetry`.
    @State private var availabilityRetryTask: Task<Void, Never>?
    /// The debounced reconcile for a `watch-party-update` naming a channel
    /// not yet in `channels`. See `scheduleUnmatchedWatchPartyReconcile`.
    @State private var unmatchedWatchPartyReconcileTask: Task<Void, Never>?
    @State private var creatingWatchParty = false
    @State private var watchPartyCreateError: String?
    @State private var showingCreateWatchParty = false
    @State private var watchPartyDraftName = ""
    private var showsBau: Bool { (communityHome?.enabled ?? false) && current.communityHomeEnabled }
    @State private var showingInvites = false
    @State private var showingSearch = false
    @State private var showingMembers = false
    @State private var showingNewChannel = false
    @State private var newChannelName = ""
    @State private var newChannelIsVoice = false
    @State private var renaming: Channel?
    @State private var renameText = ""
    @State private var confirmingLeave = false
    @State private var showingSettings = false
    @State private var webhooksFor: Channel?
    @State private var memberPickerFor: Channel?
    @State private var threadsFor: Channel?
    @State private var current: Server
    @State private var handlerKey = UUID().uuidString
    /// Only ever driven by a restored launch — taps push through plain
    /// `NavigationLink`s, which do not need a binding.
    @State private var openedChannel: Channel?
    @State private var hasSeededInitialChannel = false

    /**
     A WATCH PARTY IS NOT A VOICE ROW, AND THIS IS WHERE THAT IS ENFORCED.

     One filter, applied once, exactly as `channel-list.tsx` does it on the
     web. Four separate filters (loose voice, category children, the section
     that lists them) could disagree, and the way they disagree is a party
     appearing twice or, as shipped in build 21, not at all: it fell into
     `looseVoice` and was drawn as an ordinary speaker row.
     */
    private var parties: [Channel] {
        channels.filter(\.isWatchParty).sorted { $0.position < $1.position }
    }
    private var listed: [Channel] { channels.filter { !$0.isWatchParty } }

    /**
     Whether the "Create watch party" row belongs on this server at all --
     `START_WATCH_PARTY`, server-wide (no channel to check an override
     against: the row may be about to make the channel), AND the server's
     own broadcast switch. Exactly `canOfferWatchPartyCreate`'s own two
     inputs on the web (`client/src/lib/watch-party-channels.ts`) -- see
     `resolveServerWatchPartyListState`'s `canHost` doc for the precise
     mirroring, and `PermissionBits.swift` for why an owner or an
     ADMINISTRATOR role needs no special case here.
     */
    private var canHostWatchParty: Bool {
        liveHlsConfig.enabled
            && (watchPartyPermissions?.can(PermissionBit.startWatchParty) ?? false)
    }

    private var watchPartyListState: ServerWatchPartyListState {
        resolveServerWatchPartyListState(parties: serverWatchParties, canHost: canHostWatchParty)
    }

    private var categories: [Channel] {
        listed.filter(\.isCategory).sorted { $0.position < $1.position }
    }
    /// Channels with no category, which the sidebar shows above the grouped
    /// ones — matching the web client's layout.
    private var looseText: [Channel] { listed.filter { $0.isText && $0.parentId == nil } }
    private var looseVoice: [Channel] { listed.filter { $0.isVoice && $0.parentId == nil } }

    private func children(of category: Channel) -> [Channel] {
        listed
            .filter { $0.parentId == category.id && !$0.isCategory }
            .sorted { $0.position < $1.position }
    }

    private var textChannels: [Channel] { looseText }
    private var voiceChannels: [Channel] { looseVoice }

    /// Split out of `body` in three parts because the single chain was
    /// past what the type checker would finish on CI's runners.
    private var channelScroll: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            if isLoading && channels.isEmpty {
                ProgressView().tint(Palette.signal)
            } else if let error {
                EmptyState(
                    icon: "exclamationmark.triangle",
                    title: "Could not load channels",
                    message: LocalizedStringKey(error),
                    actionTitle: "Try again",
                    action: { Task { await load() } }
                )
            } else {
                ScrollView {
                    // Full-bleed, so it sits outside the list's own gutter.
                    // Absent — which is every server that has not uploaded one —
                    // leaves the large navigation title doing the naming, exactly
                    // as before.
                    if let banner = Avatar.resolve(current.bannerUrl) {
                        CommunityBanner(url: banner, name: current.name)
                    }

                    LazyVStack(alignment: .leading, spacing: 8) {
                        // ABOVE EVERYTHING, which is where the web's own
                        // `LivePartyBlock` puts it: a party is an event, and
                        // on the one evening it matters it is the reason the
                        // app is open. NOT a row under a heading any more
                        // (build 21's "watch party shows as a regular voice
                        // channel" bug, and its build-22 fix, a `ForEach`
                        // under a static "Watch party" label whenever ANY
                        // watch_party channel existed): a member with no
                        // party running and no permission to start one saw
                        // an idle row that opened onto a "Nobody is
                        // streaming yet" card, which is neither of the two
                        // things a party in the list is supposed to mean.
                        // `resolveServerWatchPartyListState` decides between
                        // a live card, this account's own pending card, a
                        // single Create row, or nothing at all -- see that
                        // function's doc, and `WatchPartySidebarSlot`'s.
                        WatchPartySidebarSlot(
                            state: watchPartyListState,
                            watching: watchingByChannel,
                            isCreating: creatingWatchParty,
                            onOpen: { party in openWatchPartyCard(party) },
                            onCreate: {
                                watchPartyDraftName = ""
                                showingCreateWatchParty = true
                            }
                        )
                        .padding(.bottom, watchPartyListState == .none ? 0 : 4)

                        // Above TEXT, where the web sidebar puts it. Not a
                        // channel and not drawn as one: the row carries its own
                        // hint so nobody opens it expecting to type.
                        if showsBau, let config = communityHome {
                            NavigationLink {
                                CommunityHomeView(server: current, config: config)
                            } label: {
                                BauRow(unread: bauUnread)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("channels.bau")
                            .padding(.top, 4)
                        }

                        if !textChannels.isEmpty {
                            SectionLabel(text: String(localized: "Text"))
                                .padding(.horizontal, 4)
                                .padding(.top, 4)
                            ForEach(textChannels) { channel in
                                NavigationLink {
                                    chat(for: channel)
                                } label: {
                                    ChannelRow(channel: channel, unread: unread[channel.id])
                                }
                                .buttonStyle(.plain)
                                .contextMenu { channelActions(for: channel) }
                            }
                        }

                        ForEach(categories) { category in
                            SectionLabel(text: category.name)
                                .padding(.horizontal, 4)
                                .padding(.top, 12)
                                .contextMenu { channelActions(for: category) }
                            ForEach(children(of: category)) { channel in
                                NavigationLink {
                                    chat(for: channel)
                                } label: {
                                    ChannelRow(channel: channel, unread: unread[channel.id])
                                }
                                .buttonStyle(.plain)
                                .contextMenu { channelActions(for: channel) }
                            }
                        }

                        if !voiceChannels.isEmpty {
                            SectionLabel(text: String(localized: "Voice"))
                                .padding(.horizontal, 4)
                                .padding(.top, 12)
                            ForEach(voiceChannels) { channel in
                                NavigationLink { chat(for: channel) } label: {
                                    ChannelRow(channel: channel, unread: unread[channel.id])
                                }
                                .buttonStyle(.plain)
                                .contextMenu { channelActions(for: channel) }
                            }
                        }
                    }
                    .padding(.horizontal, Metrics.hPadding)
                    .padding(.top, 8)
                }
                .refreshable { await load() }
            }
        }
    }

    private var navigatedList: some View {
        channelScroll
        .navigationTitle(current.name)
        // The banner already says the name, in type twice the size. Leaving the
        // large title on would print it twice, one under the other.
        .navigationBarTitleDisplayMode(current.bannerUrl == nil ? .large : .inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { showingSearch = true } label: {
                        Label("Search messages", systemImage: "magnifyingglass")
                    }
                    Button { showingMembers = true } label: {
                        Label("Members", systemImage: "person.2")
                    }
                    Button { showingInvites = true } label: {
                        Label("Invite people", systemImage: "person.badge.plus")
                    }
                    if isManager {
                        Button { showingNewChannel = true } label: {
                            Label("New channel", systemImage: "plus.square")
                        }
                        Button { showingSettings = true } label: {
                            Label("Community settings", systemImage: "gearshape")
                        }
                    }
                    Divider()
                    // Leaving is offered to everyone except the owner, who has
                    // to transfer or delete instead — the server refuses the
                    // last-owner case and there is no sense offering it.
                    if server.role != "owner" {
                        Button(role: .destructive) { confirmingLeave = true } label: {
                            Label("Leave community", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .tint(Palette.signal)
            }
        }
        .navigationDestination(item: $openedChannel) { channel in chat(for: channel) }
        // Deferred by one appearance on purpose. A `navigationDestination` can
        // only serve a push once the view carrying it is *in* the stack, and on
        // a restored launch this view is itself being pushed in the same
        // update — set the binding any earlier and SwiftUI drops it, leaving
        // the app parked on the channel list. Guarded so swiping back from the
        // channel does not immediately push it again.
        .onAppear {
            guard let initialChannel, !hasSeededInitialChannel else { return }
            hasSeededInitialChannel = true
            var transaction = Transaction()
            // The restored screen is where the app starts; sliding it in would
            // stage a navigation the user did not make.
            transaction.disablesAnimations = true
            withTransaction(transaction) { openedChannel = initialChannel }
        }
        .sheet(isPresented: $showingInvites) { InviteView(server: server) }
        .sheet(isPresented: $showingSearch) { SearchView(server: server) }
        .sheet(isPresented: $showingMembers) { MembersView(server: current) }
        .sheet(isPresented: $showingSettings) {
            ServerSettingsView(
                server: current,
                onChanged: { current = $0 },
                onDeleted: { dismiss() }
            )
        }
        .sheet(item: $webhooksFor) { channel in WebhooksView(channel: channel) }
        .sheet(item: $memberPickerFor) { channel in
            ChannelMembersView(channel: channel, server: current)
        }
        .sheet(item: $threadsFor) { channel in ThreadListView(channel: channel) }
    }

    var body: some View {
        navigatedList
        .alert("New channel", isPresented: $showingNewChannel) {
            TextField("Channel name", text: $newChannelName)
            Button("Cancel", role: .cancel) { newChannelName = "" }
            Button("Create text") { Task { await createChannel(type: "text") } }
            Button("Create voice") { Task { await createChannel(type: "voice") } }
            Button("Create category") { Task { await createChannel(type: "category") } }
        }
        .alert("Rename channel", isPresented: Binding(
            get: { renaming != nil },
            set: { if !$0 { renaming = nil } }
        )) {
            TextField("Name", text: $renameText)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Rename") { Task { await commitRename() } }
        }
        .alert("Leave \(server.name)?", isPresented: $confirmingLeave) {
            Button("Cancel", role: .cancel) {}
            Button("Leave", role: .destructive) {
                Task {
                    try? await session.api.leaveServer(id: server.id)
                    dismiss()
                }
            }
        } message: {
            Text("You'll need a new invite to get back in.")
        }
        // Name-only, like the web's own first step (`CreateWatchPartyDialog`):
        // everything else a host might want (slow mode, who talks, what is
        // on screen) is decided on the setup card once they have joined the
        // room and can actually see a preview, not in a form ahead of it.
        // No `startsAt` -- this build, like the existing channel-scoped
        // `WatchPartyHostControls.createDialog`, always creates an immediate
        // `draft`, never a `scheduled` party.
        .alert("Name your watch party", isPresented: $showingCreateWatchParty) {
            TextField("Saturday session", text: $watchPartyDraftName)
                .accessibilityIdentifier("channels.watchPartyCreateName")
            Button("Cancel", role: .cancel) { watchPartyDraftName = "" }
            Button("Create") { Task { await createWatchParty() } }
                .disabled(watchPartyDraftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("channels.watchPartyCreateSubmit")
        }
        .alert(
            "Watch party",
            isPresented: Binding(
                get: { watchPartyCreateError != nil },
                set: { if !$0 { watchPartyCreateError = nil } }
            )
        ) {
            Button("Got it") { watchPartyCreateError = nil }
        } message: {
            Text(watchPartyCreateError ?? "")
        }
        .task {
            // Subscribed BEFORE the first fetch (Farol finding): a
            // `watch-party-update` or `channel-live` frame that lands in the
            // gap between the snapshot and the subscription must not be
            // lost. The dictionary write below is synchronous, so there is
            // no `await` between it and `load()` starting for anything to
            // land in.
            session.eventHandlers[handlerKey] = { event in
                switch event {
                case .activity(let channelId, let serverId, let mention)
                    where serverId == server.id:
                    let existing = unread[channelId]
                    unread[channelId] = UnreadEntry(
                        channelId: channelId,
                        count: (existing?.count ?? 0) + 1,
                        mentions: (existing?.mentions ?? 0) + (mention ? 1 : 0)
                    )
                // Somebody changed a role or a channel's access. The frame says
                // nothing about what changed, and it does not need to: the
                // channel list endpoint resolves VIEW_CHANNEL in the database,
                // so re-reading it *is* the answer. Without this a channel you
                // have just been shut out of stays in this list until the app is
                // relaunched, and a channel you have just been let into does not
                // appear at all.
                case .permissionsUpdate(let serverId, _) where serverId == server.id:
                    Task { await reloadAfterPermissionsChange() }
                // A publish in the Baú. Content-free, so the count is asked
                // for rather than bumped: a deletion sends the same frame and
                // would have to move it the other way.
                case .communityHomeUpdate(let serverId) where serverId == server.id:
                    Task { await refreshBauUnread() }
                // A broadcast started or stopped in a channel this account may
                // see. `stream == nil` is a stop, and it has to remove the
                // pill: a badge that survives the end of the show sends people
                // into an empty room. `watching` rides the same frame, and is
                // the live card's own count -- dropped along with the pill on
                // a stop, so a stale number never outlives the badge it sits
                // beside.
                case .channelLive(let channelId, let stream, let watching):
                    if stream == nil {
                        liveChannels.remove(channelId)
                        watchingByChannel.removeValue(forKey: channelId)
                    } else {
                        liveChannels.insert(channelId)
                        watchingByChannel[channelId] = watching
                    }
                // This server's watch-party slot. `party` itself does not
                // carry a `serverId` this build decodes (`WatchPartyPayload`'s
                // deliberately trimmed field set), so this checks the frame's
                // channel against the list already known for THIS server --
                // the same guard `permissionsUpdate` and `.activity` above
                // make with the id the frame actually carries.
                //
                // A CHANNEL NOT YET LOADED IS RECONCILED, NOT DISCARDED
                // (Farol finding). Build 22's first cut of this dropped the
                // frame outright here -- most often this server's very first
                // party, whose hidden room this device has never seen --
                // which left the slot stale until a manual pull-to-refresh
                // even though the server had just said something changed.
                // `scheduleUnmatchedWatchPartyReconcile` refetches both
                // `channels` and the party list instead, debounced so a
                // burst of frames for the same unknown channel costs one
                // round trip, not one per frame.
                case .watchPartyUpdate(let channelId, let party):
                    if channels.contains(where: { $0.id == channelId }) {
                        applyMatchedWatchPartyUpdate(channelId: channelId, party: party)
                    } else {
                        scheduleUnmatchedWatchPartyReconcile()
                    }
                // A fresh socket after a reconnect knows nothing about what
                // happened while it was down -- the identical argument
                // `WatchPartyHostController.apply`'s own `.ready` case makes
                // for the one party it tracks, applied here to the two
                // fail-closed-and-silent reads behind the Create row: a
                // config or permission change in that gap deserves a prompt
                // look now that the connection is back, not a wait for
                // whatever backoff delay a previous retry happened to be on.
                case .ready:
                    scheduleAvailabilityRetry(immediate: true)
                default:
                    return
                }
            }
            await load()
        }
        .onDisappear {
            session.eventHandlers.removeValue(forKey: handlerKey)
            availabilityRetryTask?.cancel()
            unmatchedWatchPartyReconcileTask?.cancel()
        }
        // The other moment `scheduleAvailabilityRetry` tries again promptly:
        // returning to the foreground is as much a reason to expect a fresh
        // answer as a socket reconnect is, and a phone that was asleep for
        // an hour is not a phone that should still be waiting out a 30s
        // backoff delay from before it locked.
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            scheduleAvailabilityRetry(immediate: true)
        }
        // Coming back from a chat re-reads the counts: the chat marked itself
        // read on the server, and this is what clears its badge locally.
        .onAppear { Task { await refreshUnread() } }
    }

    /// A channel's chat screen. Only text channels are recorded as the last
    /// reading destination: restoring a voice room would otherwise make launch
    /// look like consent to join its media.
    private func chat(for channel: Channel) -> some View {
        // `server` carries this account's rank, which is what lets the message
        // menu and the profile sheet offer moderation from where the offence is
        // rather than from a members screen two taps away.
        ChatView(
            channelId: channel.id,
            title: "#\(channel.name)",
            canStartThreads: channel.isText,
            server: server,
            slowmodeSeconds: channel.slowmodeSeconds,
            voiceChannel: channel.isVoice ? channel : nil
        )
        .onAppear {
            if channel.isText {
                LastVisited.record(channelId: channel.id, serverId: server.id)
            }
        }
    }

    private func refreshUnread() async {
        guard !channels.isEmpty else { return }
        if let entries = try? await session.api.unread(serverId: server.id) {
            unread = Dictionary(uniqueKeysWithValues: entries.map { ($0.channelId, $0) })
        }
        await refreshBauUnread()
    }

    /// Only asked while the row is drawn: the route 404s when the instance
    /// flag is off, and a server that does not show a Baú has no badge to
    /// keep. A failure leaves the last count rather than zeroing it.
    private func refreshBauUnread() async {
        guard showsBau else { return }
        if let count = try? await session.api.communityHomeUnread(serverId: server.id) {
            bauUnread = count
        }
    }

    private var isManager: Bool { server.role == "owner" || server.role == "admin" }

    private func createChannel(type: String) async {
        // The server only accepts letters, numbers, - and _; spaces are the
        // obvious thing a person types, so they become hyphens rather than a
        // validation error.
        let name = newChannelName
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: " ", with: "-")
        newChannelName = ""
        guard !name.isEmpty else { return }
        do {
            let channel = try await session.api.createChannel(
                serverId: server.id, name: name, type: type, isPrivate: false
            )
            channels.append(channel)
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Opens the channel a live or pending watch-party card names.
    ///
    /// For the audience, a plain push, same as any other row in this list:
    /// `ChatView` and `WatchStageView` mount the picture with no seat. For
    /// this party's host or a co-host, the same channel, with the call
    /// screen brought back if they already hold a seat there; see
    /// `watchPartyCardTap` and `landOnHostStage`.
    /// Looked up in `parties` rather than the full `channels` list: a
    /// `WatchPartyPayload.channelId` always names a `watch_party` channel,
    /// and searching the narrower, already-filtered list is what that type
    /// is for.
    private func openWatchPartyCard(_ party: WatchPartyPayload) {
        guard let channel = parties.first(where: { $0.id == party.channelId }) else { return }
        switch watchPartyCardTap(for: party) {
        case .watch:
            openedChannel = channel
        case .host:
            landOnHostStage(channel)
        }
    }

    /**
     Put a host on the setup surface: open the channel, where the stage above
     the transcript draws their card (`WatchPartyStageHostView`: the setup
     card with Go live, or a live party they are not in the room for).

     NO SEAT. This used to join the room and present the call screen, because
     the setup card only existed there; a seat asked for the microphone and
     published it, and a watch party is a broadcast, not a call. Going live is
     the moment a seat is taken now (`WatchPartyHostController.goLive`).

     Two cases still touch the session. A host already seated in this room
     (a live party whose call was tucked away) gets the call screen back,
     which is where their End and share controls are. And a failed session
     for this room is left, so the stage's card shows instead of the old
     error: a tap on this card is somebody asking to try again.
     */
    private func landOnHostStage(_ channel: Channel) {
        openedChannel = channel
        guard voice.channelId == channel.id else { return }
        if case .failed = voice.status {
            Task { await voice.leave() }
        } else if voice.isLive {
            voice.isCollapsed = false
        }
    }

    /**
     "Create watch party" from the channel list, with no `watch_party`
     channel picked ahead of time -- this may be the very first party this
     server has ever run, so it cannot depend on one already being in
     `channels`. Mirrors the web's `handleCreateWatchParty`: always the
     server-scoped route (`createServerWatchParty`), which finds or makes
     the server's one hidden room and opens an immediate `draft` in it.

     THE SERVER STAYS THE REAL GATE, EVEN THOUGH `canHostWatchParty` READS
     THE REAL BIT. `PermissionsSnapshot` can be a request behind the truth
     (a role just changed, the fetch failed and left a stale answer) --
     this call is what the server actually checks the bit against at the
     moment it matters, so a client reading gone stale sees a refusal here,
     never an unauthorised party.

     On success the returned channel is appended to `channels` (it may be
     brand new to this client) and the host lands on that channel, whose
     stage draws the setup card with Go live (`landOnHostStage`). No seat is
     taken until they press it.
     */
    private func createWatchParty() async {
        let name = watchPartyDraftName.trimmingCharacters(in: .whitespacesAndNewlines)
        watchPartyDraftName = ""
        guard !name.isEmpty, !creatingWatchParty else { return }
        creatingWatchParty = true
        defer { creatingWatchParty = false }
        do {
            let response = try await session.api.createServerWatchParty(serverId: server.id, name: name)
            if let channel = response.channel,
               !channels.contains(where: { $0.id == channel.id }) {
                channels.append(channel)
            }
            if let party = response.party {
                applyMatchedWatchPartyUpdate(channelId: party.channelId, party: party)
            }
            if let channel = response.channel {
                landOnHostStage(channel)
            }
        } catch {
            watchPartyCreateError = (error as? APIError)?.errorDescription ?? error.localizedDescription
            // AN UNCERTAIN OUTCOME IS NOT A REFUSAL (Farol finding). This
            // POST can commit on the server and still throw here on a lost
            // response, and the `watch-party-update` it broadcasts can itself
            // be the "unknown channel" frame above if the room was brand new
            // -- so without this, a host could be left staring at the Create
            // row for a party that already exists, and their very next tap
            // would just 409. Reconciling both lists before they retry is
            // what makes that tap land on the setup card instead.
            await reconcileChannelsAndParties()
        }
    }

    /// Moves a channel into a category, or back out to the top level.
    private func move(_ channel: Channel, to parentId: String?) async {
        do {
            try await session.api.moveChannel(id: channel.id, parentId: parentId, index: 0)
            await load()
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func commitRename() async {
        guard let target = renaming else { return }
        let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        renaming = nil
        guard !name.isEmpty else { return }
        if let updated = try? await session.api.renameChannel(id: target.id, name: name),
           let index = channels.firstIndex(where: { $0.id == updated.id }) {
            channels[index] = updated
        }
    }

    private func deleteChannel(_ channel: Channel) async {
        do {
            try await session.api.deleteChannel(id: channel.id)
            channels.removeAll { $0.id == channel.id }
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    @ViewBuilder
    private func channelActions(for channel: Channel) -> some View {
        // Threads are readable by anyone who can read the channel — their
        // visibility IS the channel's — so this sits above the manager block.
        if channel.isText {
            Button { threadsFor = channel } label: {
                Label("Threads", systemImage: "bubble.left.and.text.bubble.right")
            }
        }
        if isManager {
            Button {
                renameText = channel.name
                renaming = channel
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            if channel.isText {
                Button { webhooksFor = channel } label: {
                    Label("Webhooks", systemImage: "link")
                }
            }
            if channel.isPrivate {
                Button { memberPickerFor = channel } label: {
                    Label("Who can see this", systemImage: "person.2.badge.key")
                }
            }
            if !channel.isCategory && !categories.isEmpty {
                Menu {
                    if channel.parentId != nil {
                        Button("Top level") { Task { await move(channel, to: nil) } }
                    }
                    ForEach(categories.filter { $0.id != channel.parentId }) { category in
                        Button(category.name) { Task { await move(channel, to: category.id) } }
                    }
                } label: {
                    Label("Move to…", systemImage: "folder")
                }
            }
            Button(role: .destructive) {
                Task { await deleteChannel(channel) }
            } label: {
                Label("Delete channel", systemImage: "trash")
            }
        }
    }

    private func load() async {
        // Draw the last known list first, so opening a server you were just in
        // is instant. The fetch below still runs; on an unchanged server it
        // comes back 304 and this list is already correct.
        if channels.isEmpty, let cached = await session.api.cachedChannels(serverId: server.id) {
            channels = cached
        }
        isLoading = true
        error = nil
        // Memoised on the client, so this is one round trip per session, not
        // per open. Asked before the channels so the row is there when they are.
        if communityHome == nil {
            communityHome = await session.api.communityHomeConfig()
        }
        // A previous load's retry loop (a pull-to-refresh while one was
        // mid-backoff, say) must not keep running alongside this fresh one.
        availabilityRetryTask?.cancel()
        availabilityRetryTask = nil

        // ALL FOUR RUN CONCURRENTLY (Farol finding). `liveHlsConfig` used to
        // be awaited on its own, ahead of `channels`, so its full round trip
        // sat in front of the channel list even though the two have nothing
        // to do with each other. `configTask` and `permissionsTask` are read
        // as Optional -- a failure is silence, not a throw -- because those
        // two gate only the Create row, never the list itself; `channelsTask`
        // stays throwing, surfaced below exactly as before through the
        // full-screen error state.
        async let configTask: LiveHlsConfigPayload? = try? session.api.fetchLiveHlsConfigOrThrow(serverId: server.id)
        async let permissionsTask: PermissionsSnapshot? = try? session.api.fetchMemberPermissions(serverId: server.id)
        async let channelsTask = session.api.channels(serverId: server.id)
        async let partiesTask: [WatchPartyPayload]? = try? session.api.fetchServerWatchParties(serverId: server.id)

        let config = await configTask
        let permissions = await permissionsTask
        if let config { liveHlsConfig = config }
        if let permissions { watchPartyPermissions = permissions }

        do {
            channels = try await channelsTask
            // Unread is a separate call and failing it must not blank the
            // channel list — badges are a nicety, the list is the screen.
            if let entries = try? await session.api.unread(serverId: server.id) {
                unread = Dictionary(uniqueKeysWithValues: entries.map { ($0.channelId, $0) })
            }
            await refreshBauUnread()
            // KEEP THE LAST KNOWN ARRAY ON A FAILED FETCH (Farol finding).
            // This used to fall back to `[]` on any failure, which could
            // drop a live card a manager was mid-broadcast on, or silently
            // open the Create row on top of a party this screen simply
            // failed to re-read. See `resolveServerWatchPartyListState`'s
            // `parties` doc: `nil` means "never fetched cleanly", and this
            // is the one place that promise has to hold.
            if let parties = await partiesTask {
                serverWatchParties = parties
            }
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false

        // Either fail-closed-and-silent read missing its answer keeps the
        // Create row correctly off for now, but silently -- nothing else
        // ever asks again unless something arms a retry.
        if config == nil || permissions == nil {
            scheduleAvailabilityRetry()
        }
    }

    /**
     One attempt at both reads behind the Create row -- `liveHlsConfig` and
     `watchPartyPermissions` -- run concurrently. Returns whether BOTH
     landed clean, which is what `scheduleAvailabilityRetry` uses to know
     when to stop.

     Uses `fetchLiveHlsConfigOrThrow` rather than the ordinary
     `liveHlsConfig(serverId:)` on purpose: that convenience method already
     fails closed to `.off` on any error, which is exactly right for most
     callers but indistinguishable here from "the server genuinely said
     off" -- and this function's only job is telling those two apart so it
     knows whether to keep trying.
     */
    @discardableResult
    private func refreshWatchPartyAvailability() async -> Bool {
        async let configResult: LiveHlsConfigPayload? = try? session.api.fetchLiveHlsConfigOrThrow(serverId: server.id)
        async let permissionsResult: PermissionsSnapshot? = try? session.api.fetchMemberPermissions(serverId: server.id)
        let config = await configResult
        let permissions = await permissionsResult
        if let config { liveHlsConfig = config }
        if let permissions { watchPartyPermissions = permissions }
        return config != nil && permissions != nil
    }

    /**
     Drives `refreshWatchPartyAvailability` until both land clean or the
     backoff budget runs out -- `WatchPartyFetchBackoff`, the same capped
     exponential backoff `WatchPartyHostController`'s own party-fetch retry
     already uses (roughly a minute, six attempts, 1s doubling to 30s).

     - Parameter immediate: `true` to try once right away, before the first
       delay -- for a moment that is ITSELF a reason to expect a different
       answer now (a socket reconnect, the app returning to the foreground).
       `load()`'s own call leaves this `false`: it just tried once as part
       of its normal fetch, and only needs the delayed retries after that.

     Cancels any retry already in flight before starting, so a foreground
     while a previous retry is mid-backoff runs one loop, not two.
     */
    private func scheduleAvailabilityRetry(immediate: Bool = false) {
        availabilityRetryTask?.cancel()
        availabilityRetryTask = Task {
            if immediate, await refreshWatchPartyAvailability() {
                return
            }
            guard !Task.isCancelled else { return }
            var backoff = WatchPartyFetchBackoff()
            while !Task.isCancelled {
                guard let delay = backoff.next() else { return }
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled else { return }
                if await refreshWatchPartyAvailability() { return }
            }
        }
    }

    /// Applies one `watch-party-update` frame for a channel already known
    /// to this server's `channels` list. NEVER SECOND-GUESSES THE FRAME,
    /// mirroring `applyWatchPartyFrame` in the web's `use-watch-parties.ts`:
    /// a frame this specific about one channel is a better answer than
    /// anything derived locally. `serverWatchParties` starting `nil`
    /// (never fetched cleanly) is upgraded to a real array right here --
    /// this one frame is authoritative for this one channel regardless of
    /// whether the initial GET ever landed.
    private func applyMatchedWatchPartyUpdate(channelId: String, party: WatchPartyPayload?) {
        var parties = serverWatchParties ?? []
        parties.removeAll { $0.channelId == channelId }
        if let party, !party.isTerminal {
            parties.append(party)
        }
        serverWatchParties = parties
    }

    /**
     Refetches `channels` and `serverWatchParties` together and applies
     whichever lands. Two Farol findings share this fix, both "the server
     may already know something this screen does not":

     1. A `watch-party-update` names a channel this screen has not loaded --
        most often this server's very first party, created while the list
        was already open. Reached (debounced) from
        `scheduleUnmatchedWatchPartyReconcile`.
     2. `createWatchParty`'s POST can commit on the server and still fail
        locally (a lost response): reconciling immediately here is what
        stops an already-created party from being invisible behind a
        Create row that would just 409 on the very next tap.
     */
    private func reconcileChannelsAndParties() async {
        async let freshChannels: [Channel]? = try? session.api.channels(serverId: server.id)
        async let freshParties: [WatchPartyPayload]? = try? session.api.fetchServerWatchParties(serverId: server.id)
        if let freshChannels = await freshChannels {
            channels = freshChannels
            // A channel that is gone must not keep a badge behind in the dictionary.
            let visible = Set(freshChannels.map(\.id))
            unread = unread.filter { visible.contains($0.key) }
        }
        if let freshParties = await freshParties {
            serverWatchParties = freshParties
        }
    }

    /// Debounced: a burst of `watch-party-update` frames for the same
    /// not-yet-loaded channel (a party created and going live within the
    /// same second, say) fires one reconcile, not one per frame.
    private func scheduleUnmatchedWatchPartyReconcile() {
        unmatchedWatchPartyReconcileTask?.cancel()
        unmatchedWatchPartyReconcileTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await reconcileChannelsAndParties()
        }
    }

    /// Re-read the list after a permissions change, quietly.
    ///
    /// Deliberately not `load()`: that sets `isLoading`, which throws a spinner
    /// over a list somebody is reading because an admin renamed a role. A
    /// failure is also swallowed rather than shown, because the list on screen
    /// is still the last thing the server actually said, and replacing it with
    /// an error would be a worse answer than a slightly stale one. The next
    /// `permissions-update` or a pull-to-refresh tries again.
    ///
    /// Also the reload that keeps `canHostWatchParty` honest: the frame that
    /// calls this means this account's OWN bits may just have changed (a
    /// role edit, a channel overwrite), which is exactly the moment a stale
    /// `watchPartyPermissions` would show -- or hide -- the Create row for
    /// a beat after the truth changed.
    private func reloadAfterPermissionsChange() async {
        guard let fresh = try? await session.api.channels(serverId: server.id) else { return }
        channels = fresh
        // A channel that is gone must not keep a badge behind in the dictionary.
        let visible = Set(fresh.map(\.id))
        unread = unread.filter { visible.contains($0.key) }
        if let permissions = try? await session.api.fetchMemberPermissions(serverId: server.id) {
            watchPartyPermissions = permissions
        }
    }
}

/// A community's banner, with its name over it.
///
/// THE SCRIM IS NOT DECORATION. The image is whatever the owner uploaded — a
/// white photograph is as likely as a dark one — and white display type on an
/// unknown picture is unreadable roughly half the time. The gradient is opaque
/// enough at the bottom edge to carry text against anything, and clears away
/// entirely at the top so the picture is still the thing you see.
///
/// 120pt: tall enough to read as a banner rather than a stripe, short enough
/// that the first channel is still above the fold on the smallest screen this
/// app supports.
private struct CommunityBanner: View {
    let url: URL
    let name: String

    var body: some View {
        // FRAMED AND CLIPPED BEFORE THE SCRIM AND THE NAME GO ON. A
        // `scaledToFill` image grows the stack it is in, not only itself, so a
        // wide banner laid out as a sibling of the name would push the name
        // far below the 120pt window and clipping would then remove it. The two
        // things drawn on top are overlays, which measure against the strip.
        ZStack {
            // Under the image rather than instead of it, so a slow load shows a
            // band of the app's own colour and not a white hole.
            Palette.surface

            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Color.clear
            }
        }
        .frame(height: 120)
        .frame(maxWidth: .infinity)
        .clipped()
        .overlay {
            LinearGradient(
                colors: [
                    Palette.ink.opacity(0),
                    Palette.ink.opacity(0.55),
                    Palette.ink.opacity(0.88),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        .overlay(alignment: .bottomLeading) {
            Text(name)
                .font(Typography.display(24))
                .foregroundStyle(Palette.paper)
                .lineLimit(2)
                .shadow(color: .black.opacity(0.45), radius: 6, y: 1)
                .padding(.horizontal, Metrics.hPadding)
                .padding(.bottom, 12)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name)
    }
}

/// The Baú's row. Same surface as a channel row, so it sits in the list, with
/// a second line: the one thing a person needs to know before tapping is that
/// this is not a place to type.
struct BauRow: View {
    /// Posts not yet seen. Never a mention: the Baú has no @, so the badge is
    /// the quiet one.
    var unread: Int = 0

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "archivebox")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Palette.paperMuted)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text("Baú")
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                Text("Posts that stay. Not chat.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .lineLimit(1)
            }

            Spacer()

            if unread > 0 {
                UnreadBadge(count: unread)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
    }
}

struct ChannelRow: View {
    let channel: Channel
    let unread: UnreadEntry?
    var isDisabled: Bool = false
    /// Something is being broadcast in this channel right now. Draws the one
    /// badge that tells somebody scrolling a list that the show has started.
    var isLive: Bool = false

    /**
     The glyph, and the reason a watch party gets its own.

     The clapperboard is what the web sidebar draws (`ChannelIcon`), so the
     two clients name the same thing the same way. Build 21 asked only
     `isVoice`, which is true for a watch party, so it drew the speaker: the
     type shipped with a player, a stream and no way to tell it apart from the
     voice channel above it.
     */
    private var glyph: String {
        if channel.isWatchParty { return "movieclapper.fill" }
        return channel.isVoice ? "speaker.wave.2.fill" : "number"
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: glyph)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(isDisabled ? Palette.paperMuted.opacity(0.5) : Palette.paperMuted)
                .frame(width: 20)

            Text(channel.name)
                .font(Typography.bodyMedium)
                .foregroundStyle(isDisabled ? Palette.paperMuted : Palette.paper)
                .lineLimit(1)

            if channel.isPrivate {
                Image(systemName: "lock.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.paperMuted)
            }

            // Red, and not the signal colour: the signal green means "the call
            // you are in" everywhere else in this app, and this means
            // "something is being broadcast", which is a different sentence.
            // No pulse. A list of rows is not the place for a moving object.
            if isLive {
                Text("LIVE")
                    .font(Typography.label)
                    .tracking(0.8)
                    .foregroundStyle(Palette.paper)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Palette.danger, in: RoundedRectangle(cornerRadius: 4))
                    .accessibilityIdentifier("channels.live")
            }

            Spacer()

            if isDisabled {
                Text("SOON")
                    .font(Typography.label)
                    .tracking(1)
                    .foregroundStyle(Palette.paperMuted)
            } else if let unread, unread.count > 0 {
                UnreadBadge(count: unread.count, isMention: unread.mentions > 0)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
        .opacity(isDisabled ? 0.65 : 1)
    }
}

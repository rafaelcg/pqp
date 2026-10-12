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

    /// A new-post push was tapped: open the Baú once the list knows whether
    /// this server has one (see `openBauIfAsked`).
    let opensBau: Bool
    /// Set when a Baú post link brought us here: push the Baú on top of this
    /// list, scrolled to the post it names.
    let initialBau: BauFocus?
    /// Set when a forum link or a push for a post brought us here: push the
    /// forum on top of this list, and the post on top of the forum.
    let initialForum: ForumFocus?

    init(
        server: Server,
        initialChannel: Channel? = nil,
        opensBau: Bool = false,
        initialBau: BauFocus? = nil,
        initialForum: ForumFocus? = nil
    ) {
        self.server = server
        self.initialChannel = initialChannel
        self.opensBau = opensBau
        self.initialBau = initialBau
        self.initialForum = initialForum
        _current = State(initialValue: server)
        _collapsed = State(initialValue: CollapsedSections().load(serverId: server.id))
        _layoutConfig = State(initialValue: ChannelLayoutMemory().load(serverId: server.id))
        _stories = State(initialValue: StoryStripModel(scope: .server(id: server.id, name: server.name)))
    }

    /// This server's stories: the strip at the top of the list, and the
    /// composer the menu opens. Draws nothing with the flag off.
    @State private var stories: StoryStripModel

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Sections folded on this device: `text`, `voice` or a category id.
    @State private var collapsed: Set<String>
    /// The header has scrolled under the navigation bar, which now shows the
    /// compact name and activity line.
    @State private var headerCollapsed = false
    /// `GET …/home/latest`. Nil until the first answer; `.unsupported` on an
    /// API without the route, which keeps today's row and `/home/unread`.
    @State private var bauLatest: CommunityHomeLatestAnswer?
    @State private var composingBau = false
    /// Bumped by every `refreshBau`; an answer for an older number is dropped.
    @State private var bauRequest = 0

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
    @State private var showingBau = false
    @State private var hasOpenedBauFromPush = false
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
    /// Which list to draw, from `GET …/channel-layout`: the mixed one only
    /// when the server says `mixed`. Seeded from the last answer this device
    /// saw (`ChannelLayoutMemory`), re-read on load, on every
    /// `channels-update` and when the app comes back to the foreground.
    @State private var layoutConfig: ChannelLayoutConfig
    /// Keeps the quiet refreshes of the list from overlapping.
    @State private var refreshGate = ChannelRefreshGate()
    /// Organizar canais is open.
    @State private var organizing = false
    /// A refused or stale move, said once in an alert.
    @State private var layoutNotice: String?
    /// The category "+" picked a type: the name alert is open for it.
    @State private var newChannelTarget: NewChannelTarget?
    @State private var newChannelTargetName = ""
    @State private var showingNewCategory = false
    @State private var newCategoryName = ""
    @State private var renaming: Channel?
    @State private var renameText = ""
    @State private var confirmingLeave = false
    @State private var showingSettings = false
    @State private var webhooksFor: Channel?
    @State private var memberPickerFor: Channel?
    @State private var threadsFor: Channel?
    @State private var current: Server
    @State private var handlerKey = UUID().uuidString
    /// Only ever driven by a restored launch, taps push through plain
    /// `NavigationLink`s, which do not need a binding.
    @State private var openedChannel: Channel?
    @State private var hasSeededInitialChannel = false
    @State private var openedBau: BauFocus?
    @State private var hasSeededInitialBau = false
    @State private var openedForum: ForumFocus?
    @State private var hasSeededInitialForum = false

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
    /// ones, matching the web client's layout. A forum sits with the text
    /// channels, as on the web.
    private var looseText: [Channel] {
        listed.filter { ($0.isText || $0.isForum) && $0.parentId == nil }
    }
    private var looseVoice: [Channel] { listed.filter { $0.isVoice && $0.parentId == nil } }

    private func children(of category: Channel) -> [Channel] {
        Self.children(of: category, in: listed)
    }

    /// Only types this build can open (a chat or a forum): a type it does not
    /// know is hidden, not drawn as a row that goes nowhere.
    static func children(of category: Channel, in listed: [Channel]) -> [Channel] {
        listed
            .filter { $0.parentId == category.id && $0.isListed }
            .sorted { $0.position < $1.position }
    }

    private var textChannels: [Channel] { looseText }
    private var voiceChannels: [Channel] { looseVoice }

    // MARK: - Live state the rows read

    private func isMuted(_ channel: Channel) -> Bool {
        ChannelMute.isMuted(channelId: channel.id, serverId: server.id, preferences: session.preferences)
    }

    private func mark(for channel: Channel) -> ChannelUnreadMark {
        ChannelUnreadMark.resolve(unread: unread[channel.id], isMuted: isMuted(channel))
    }

    private func summary(of members: [Channel]) -> ChannelSectionSummary {
        ChannelSectionSummary.make(channels: members, unread: unread, isMuted: isMuted)
    }

    /// The call this phone is in, when it is in this list.
    private func isCurrentCall(_ channel: Channel) -> Bool {
        channel.isVoice && voice.isLive && voice.channelId == channel.id
    }

    /// Who is talking in this phone's own call. Nobody else's: the roster does
    /// not carry speaking, see `VoiceOccupancyStore`.
    private var speakingPeerIds: Set<String> {
        Set(voice.peers.filter(\.isSpeaking).map(\.peerId))
    }

    private var activity: ServerActivity {
        let voiceIds = channels.filter(\.isVoice).map(\.id)
        var live = Set(liveChannels.intersection(Set(channels.map(\.id))))
        if case .live(let party) = watchPartyListState { live.insert(party.channelId) }
        return ServerActivity(inCall: session.voiceOccupancy.headcount(in: voiceIds), live: live.count)
    }

    private var bauMode: BauPreviewMode {
        BauPreviewMode.resolve(
            answer: bauLatest,
            legacyUnread: bauUnread,
            canPost: CommunityHomeComposeGate.canPost(config: communityHome ?? .off, permissions: watchPartyPermissions)
        )
    }

    private func toggleSection(_ key: String) {
        withAnimation(.channelList(reduceMotion: reduceMotion)) {
            collapsed = CollapsedSections().toggle(key, serverId: server.id)
        }
    }

    /// Split out of `body` in parts because the single chain was past what
    /// the type checker would finish on CI's runners.
    private var channelScroll: some View {
        GeometryReader { outer in
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
                    channelList(topInset: outer.safeAreaInsets.top)
                }
            }
        }
    }

    private func channelList(topInset: CGFloat) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                // Under the transparent navigation bar, so the back and menu
                // buttons float on the banner. Scrolled away, the bar shows
                // the compact copy (`headerCollapsed`).
                ServerHeader(
                    name: current.name,
                    bannerURL: Avatar.resolve(current.bannerUrl),
                    activity: activity,
                    topInset: topInset
                )
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.frame(in: .named(ServerHeader.coordinateSpace)).maxY
                } action: { bottom in
                    let tucked = bottom < topInset + 8
                    guard tucked != headerCollapsed else { return }
                    withAnimation(.channelList(reduceMotion: reduceMotion)) { headerCollapsed = tucked }
                }

                LazyVStack(alignment: .leading, spacing: 0) {
                    topCards
                    sections
                }
                .padding(.horizontal, Metrics.hPadding)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
        }
        .coordinateSpace(name: ServerHeader.coordinateSpace)
        .ignoresSafeArea(edges: .top)
        .pullToRefresh { await load() }
    }

    /// The live watch party, then the Baú: the two things on this list that
    /// are not channels.
    @ViewBuilder
    private var topCards: some View {
        // Above the watch party and the Baú: stories are what people are up
        // to right now, and the strip scrolls away with the list.
        StoryStripView(model: stories, server: current)
            .padding(.bottom, stories.showsStrip || !stories.notices.isEmpty ? 10 : 0)
        // ABOVE EVERYTHING, where the web's `LivePartyBlock` sits: a party is
        // an event, and on the evening it matters it is the reason the app is
        // open. `resolveServerWatchPartyListState` decides between a live
        // card, this account's own pending card, or nothing here (the Create
        // row lives at the end of the voice rooms).
        WatchPartySidebarSlot(
            state: watchPartyListState,
            watching: watchingByChannel,
            onOpen: { party in openWatchPartyCard(party) }
        )
        .padding(.bottom, watchPartyHasCard ? 8 : 0)

        if showsBau, let config = communityHome {
            Group {
                if case .empty(canPost: true) = bauMode {
                    // Its own button inside: not wrapped in the link.
                    BauPreview(mode: bauMode, onCompose: { composingBau = true })
                } else {
                    NavigationLink {
                        CommunityHomeView(
                            server: current,
                            config: config,
                            chatDestination: { AnyView(chat(for: $0)) }
                        )
                    } label: {
                        BauPreview(mode: bauMode)
                    }
                    .buttonStyle(ChannelRowButtonStyle())
                    .accessibilityIdentifier("channels.bau")
                }
            }
            .padding(.bottom, 8)
        }
    }

    private var watchPartyHasCard: Bool {
        switch watchPartyListState {
        case .live, .pending: true
        case .none, .canHost: false
        }
    }

    private var showsCreateWatchParty: Bool { watchPartyListState == .canHost }

    @ViewBuilder
    private var sections: some View {
        if isMixed {
            mixedSections
        } else {
            legacySections
        }
    }

    // MARK: - Mixed list (categories are the only headers)

    private var isMixed: Bool { layoutConfig.mixed }

    /// Reorder, create in a category, Criar categoria: MANAGE_CHANNELS
    /// server-wide, the same permission `PATCH /move` and the PUT check.
    /// The role covers owner and admin before the bits have loaded.
    private var canManageChannels: Bool {
        isManager || (watchPartyPermissions?.can(PermissionBit.manageChannels) ?? false)
    }

    /// The mixed list from these channels: categories and every type this
    /// build can open. Watch parties never become rows (`listed`), and a type
    /// this build does not know is left out, which the PUT allows: the server
    /// keeps whatever a client did not send exactly where it was.
    private func mixedLayout(of channels: [Channel]) -> SidebarLayout<Channel> {
        ChannelLayoutRules.build(
            channels.filter { !$0.isWatchParty && ($0.isCategory || $0.isListed) },
            mixed: true
        )
    }

    private var sidebarLayout: SidebarLayout<Channel> { mixedLayout(of: channels) }

    /// Loose channels on top with no header, then each category in the
    /// server's order, every type mixed. An empty category is drawn only for
    /// someone who can put a channel in it.
    @ViewBuilder
    private var mixedSections: some View {
        let layout = sidebarLayout
        ForEach(layout.loose) { channel in
            channelEntry(channel)
        }
        ForEach(layout.categories, id: \.category.id) { entry in
            if canManageChannels || !entry.children.isEmpty {
                mixedCategory(entry)
            }
        }
        if showsCreateWatchParty {
            createWatchPartyRow.padding(.top, 8)
        }
        if canManageChannels {
            CreateCategoryRow {
                newCategoryName = ""
                showingNewCategory = true
            }
            .padding(.top, 8)
        }
    }

    @ViewBuilder
    private func mixedCategory(_ entry: SidebarCategory<Channel>) -> some View {
        let category = entry.category
        let isCollapsed = collapsed.contains(category.id)
        HStack(spacing: 0) {
            ChannelSectionHeader(
                title: category.name,
                isCollapsed: isCollapsed,
                summary: summary(of: entry.children),
                onToggle: { toggleSection(category.id) }
            )
            if canManageChannels {
                Menu {
                    createMenu(in: category)
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Palette.paperMuted)
                        .frame(width: 36, height: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(Text("Create channel in \(category.name)"))
                .accessibilityIdentifier("channels.categoryCreate.\(category.name)")
            }
        }
        .padding(.top, 10)
        .contextMenu { channelActions(for: category) }

        // Folding never hides where you are: the call this phone is in stays
        // on screen under its folded category.
        ForEach(isCollapsed ? entry.children.filter { isCurrentCall($0) } : entry.children) { channel in
            channelEntry(channel)
        }
    }

    @ViewBuilder
    private func createMenu(in category: Channel) -> some View {
        Button {
            startNewChannel(in: category, type: "text", isPrivate: false)
        } label: {
            Label("Text channel", systemImage: "number")
        }
        Button {
            startNewChannel(in: category, type: "voice", isPrivate: false)
        } label: {
            Label("Voice channel", systemImage: "speaker.wave.2")
        }
        Button {
            startNewChannel(in: category, type: "text", isPrivate: true)
        } label: {
            Label("Private channel", systemImage: "lock")
        }
    }

    private func startNewChannel(in category: Channel, type: String, isPrivate: Bool) {
        newChannelTargetName = ""
        newChannelTarget = NewChannelTarget(parentId: category.id, type: type, isPrivate: isPrivate)
    }

    @ViewBuilder
    private var legacySections: some View {
        if !textChannels.isEmpty {
            channelSection(key: CollapsedSections.textKey, title: String(localized: "Text"), members: textChannels)
        }

        ForEach(categories) { category in
            channelSection(key: category.id, title: category.name, members: children(of: category), category: category)
        }

        if !voiceChannels.isEmpty {
            channelSection(
                key: CollapsedSections.voiceKey,
                title: String(localized: "Voice"),
                members: voiceChannels,
                showsCreate: showsCreateWatchParty
            )
        } else if showsCreateWatchParty {
            createWatchPartyRow.padding(.top, 8)
        }
    }

    private var createWatchPartyRow: some View {
        CreateWatchPartyRow(isCreating: creatingWatchParty) {
            watchPartyDraftName = ""
            showingCreateWatchParty = true
        }
    }

    @ViewBuilder
    private func channelSection(
        key: String,
        title: String,
        members: [Channel],
        showsCreate: Bool = false,
        category: Channel? = nil
    ) -> some View {
        let isCollapsed = collapsed.contains(key)
        let header = ChannelSectionHeader(
            title: title,
            isCollapsed: isCollapsed,
            summary: summary(of: members),
            onToggle: { toggleSection(key) }
        )
        .padding(.top, 10)

        if let category {
            header.contextMenu { channelActions(for: category) }
        } else {
            header
        }

        if !isCollapsed {
            ForEach(members) { channel in
                channelEntry(channel)
            }
            if showsCreate {
                createWatchPartyRow
            }
        }
    }

    /// One channel, and for a voice room the people inside it.
    @ViewBuilder
    private func channelEntry(_ channel: Channel) -> some View {
        let people = channel.isVoice ? session.voiceOccupancy.participants(in: channel.id) : []
        let inCall = isCurrentCall(channel)
        VStack(alignment: .leading, spacing: 0) {
            NavigationLink {
                destination(for: channel)
            } label: {
                ChannelRow(
                    channel: channel,
                    mark: mark(for: channel),
                    isMuted: isMuted(channel),
                    isLive: liveChannels.contains(channel.id),
                    isCurrentCall: inCall,
                    occupantCount: people.count
                )
            }
            .buttonStyle(ChannelRowButtonStyle())
            .contextMenu { channelActions(for: channel) }

            if !people.isEmpty {
                VoiceOccupantList(
                    participants: people,
                    selfUserId: session.currentUser?.id,
                    speakingPeerIds: inCall ? speakingPeerIds : []
                )
                .transition(.opacity)
            }
        }
        .animation(.channelList(reduceMotion: reduceMotion), value: people.isEmpty)
    }

    private var navigatedList: some View {
        channelScroll
        // Kept for the back button of every screen pushed from here; the bar
        // itself draws `ServerCompactTitle` once the header has scrolled away.
        .navigationTitle(current.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(headerCollapsed ? .visible : .hidden, for: .navigationBar)
        .toolbarBackground(Palette.ink, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                ServerCompactTitle(name: current.name, activity: activity)
                    .opacity(headerCollapsed ? 1 : 0)
                    .accessibilityHidden(!headerCollapsed)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingSearch = true } label: {
                    Image(systemName: "magnifyingglass")
                }
                .tint(Palette.paper)
                .accessibilityLabel(Text("Search messages"))
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if stories.strip.enabled && stories.strip.canPost {
                        Button { stories.composing = true } label: {
                            Label("New story", systemImage: "plus.circle")
                        }
                    }
                    Button { showingMembers = true } label: {
                        Label("Members", systemImage: "person.2")
                    }
                    Button { showingInvites = true } label: {
                        Label("Invite people", systemImage: "person.badge.plus")
                    }
                    if isMixed && canManageChannels {
                        Button { organizing = true } label: {
                            Label("Organize channels", systemImage: "arrow.up.arrow.down")
                        }
                        .accessibilityIdentifier("channels.organize")
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
                    // to transfer or delete instead, the server refuses the
                    // last-owner case and there is no sense offering it.
                    if server.role != "owner" {
                        Button(role: .destructive) { confirmingLeave = true } label: {
                            Label("Leave community", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .tint(Palette.paper)
                .accessibilityIdentifier("channels.menu")
            }
        }
        .sheet(isPresented: $composingBau) {
            CommunityHomeComposeView(
                server: current,
                config: communityHome ?? .off,
                api: session.api,
                channels: channels
            ) {
                composingBau = false
                Task { await refreshBau() }
            }
        }
        .navigationDestination(item: $openedChannel) { channel in destination(for: channel) }
        .navigationDestination(item: $openedForum) { focus in
            if let forum = channels.first(where: { $0.id == focus.forumId && $0.isForum }) {
                ForumHomeView(forum: forum, server: current, initialPostId: focus.postId)
            }
        }
        // A forum link: once the list knows the forum (cached or fetched).
        .onChange(of: channels) { _, _ in openForumIfAsked() }
        .navigationDestination(isPresented: $showingBau) {
            if let config = communityHome {
                CommunityHomeView(server: current, config: config, chatDestination: { AnyView(chat(for: $0)) })
            }
        }
        .navigationDestination(item: $openedBau) { focus in
            CommunityHomeView(server: current, config: communityHome ?? .off, focusPostId: focus.postId, chatDestination: { AnyView(chat(for: $0)) })
        }
        // Deferred by one appearance on purpose. A `navigationDestination` can
        // only serve a push once the view carrying it is *in* the stack, and on
        // a restored launch this view is itself being pushed in the same
        // update, set the binding any earlier and SwiftUI drops it, leaving
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
        // A Baú link: the same one-appearance delay as above, and the flag is
        // asked first (memoised, so usually free) because a server whose Baú
        // is off must land on its channel list rather than on a screen that
        // can only 404.
        .task {
            guard let initialBau, !hasSeededInitialBau else { return }
            hasSeededInitialBau = true
            // `communityHomeConfig()` answers "off" on any failure and only
            // remembers a real answer, so a dead network at launch would
            // drop the link. Ask a few times before settling for the list.
            for delay in [0.0, 1.5, 4.0] {
                if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
                guard !Task.isCancelled else { return }
                let config = await session.api.communityHomeConfig()
                guard !Task.isCancelled else { return }
                if config.enabled {
                    if communityHome == nil { communityHome = config }
                    guard current.communityHomeEnabled else { return }
                    openedBau = initialBau
                    return
                }
            }
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

    /// The mixed list's sheets and alerts. Split out of `body` for the same
    /// type-checker reason as `channelScroll`.
    private var withLayoutChrome: some View {
        navigatedList
        .sheet(isPresented: $organizing) { organizer }
        .alert(layoutNotice ?? "", isPresented: Binding(
            get: { layoutNotice != nil },
            set: { if !$0 { layoutNotice = nil } }
        )) {
            Button("Got it") { layoutNotice = nil }
        }
        .alert("New channel", isPresented: Binding(
            get: { newChannelTarget != nil },
            set: { if !$0 { newChannelTarget = nil } }
        )) {
            TextField("Channel name", text: $newChannelTargetName)
            Button("Cancel", role: .cancel) { newChannelTarget = nil }
            Button("Create") {
                let target = newChannelTarget
                let name = newChannelTargetName
                newChannelTarget = nil
                guard let target else { return }
                Task { await createChannel(in: target, name: name) }
            }
        }
        .alert("Create category", isPresented: $showingNewCategory) {
            TextField("Voice rooms", text: $newCategoryName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let name = newCategoryName
                Task { await createCategoryFromList(name) }
            }
            .disabled(CategoryName.normalized(newCategoryName) == nil)
        }
    }

    var body: some View {
        withLayoutChrome
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
                case .activity(let channelId, let serverId, let mention, _)
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
                    Task { await refreshBau() }
                // The list changed (somebody created, moved, renamed or
                // reordered). Re-read it and which list to draw: the mixed
                // one may have just been switched on for this server.
                case .channelsUpdate(let serverId) where serverId == server.id:
                    Task { await refreshChannelList() }
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
        .task { await stories.start(session: session) }
        .onDisappear {
            stories.stop()
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
            // A `channels-update` sent while the socket was asleep is gone.
            Task { await refreshChannelList() }
        }
        // Coming back from a chat re-reads the counts: the chat marked itself
        // read on the server, and this is what clears its badge locally.
        .onAppear { Task { await refreshUnread() } }
    }

    /// Where a row goes: a forum's list, or a chat.
    @ViewBuilder
    private func destination(for channel: Channel) -> some View {
        if channel.isForum {
            ForumHomeView(forum: channel, server: current)
        } else {
            chat(for: channel)
        }
    }

    /// The forum a link named, pushed once, without a slide (the same rule as
    /// a restored channel). A forum this account cannot see, or one that is
    /// gone, leaves the list where it is.
    private func openForumIfAsked() {
        guard let initialForum, !hasSeededInitialForum,
              channels.contains(where: { $0.id == initialForum.forumId && $0.isForum })
        else { return }
        hasSeededInitialForum = true
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { openedForum = initialForum }
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
        await refreshBau()
    }

    /// The push for a new post lands here with `opensBau`. Once, and only if
    /// this server's Baú is actually on: a tap that outlived the owner's switch
    /// stays on the channel list instead of opening a screen that cannot load.
    /// The push has no animation of its own, same as a restored channel.
    private func openBauIfAsked() {
        guard opensBau, !hasOpenedBauFromPush, showsBau else { return }
        hasOpenedBauFromPush = true
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { showingBau = true }
    }

    /// Only asked while the Baú is drawn: every `/home` route 404s when the
    /// instance flag is off. `/home/latest` answers the count too, so it
    /// replaces `/home/unread` here; an API without it (a 404) falls back to
    /// `/home/unread` and today's row. A failure leaves what was showing.
    private func refreshBau() async {
        guard showsBau else { return }
        // Load, pull-to-refresh, coming back and a `community-home-update` can
        // all be in flight at once; only the newest request may write, or a
        // slow older answer would put back a card the reader already saw.
        bauRequest += 1
        let request = bauRequest
        do {
            let answer = try await session.api.communityHomeLatest(
                serverId: server.id, lang: BauShare.cardLanguage()
            )
            guard request == bauRequest else { return }
            if case .ok(let latest) = answer { bauUnread = latest.unread }
            withAnimation(.channelList(reduceMotion: reduceMotion)) { bauLatest = answer }
            if answer == .unsupported { await refreshLegacyBauUnread() }
        } catch {
            guard request == bauRequest else { return }
            if bauLatest == .unsupported { await refreshLegacyBauUnread() }
        }
    }

    private func refreshLegacyBauUnread() async {
        let request = bauRequest
        if let count = try? await session.api.communityHomeUnread(serverId: server.id),
           request == bauRequest {
            bauUnread = count
        }
    }

    private var isManager: Bool { server.role == "owner" || server.role == "admin" }

    private func createChannel(type: String) async {
        // The server only accepts letters, numbers, - and _; spaces are the
        // obvious thing a person types, so they become hyphens rather than a
        // validation error.
        // A category is a label, so it keeps its spaces ("Salas de voz").
        let trimmed = newChannelName.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = type == "category" ? trimmed : trimmed.replacingOccurrences(of: " ", with: "-")
        newChannelName = ""
        guard !name.isEmpty else { return }
        // In the mixed list a channel made from the server menu goes to the
        // end of the first category, where people look, rather than to a
        // headerless loose area above it. The old list keeps it loose.
        let parentId = isMixed ? sidebarLayout.categories.first?.category.id : nil
        do {
            let channel = try await session.api.createChannel(
                serverId: server.id, name: name, type: type, isPrivate: false, parentId: parentId
            )
            channels.append(channel)
        } catch {
            if let shown = error.userFacingMessage { self.error = shown }
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
            if let shown = error.userFacingMessage { watchPartyCreateError = shown }
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
            if let shown = error.userFacingMessage { self.error = shown }
        }
    }

    // MARK: - Mixed list: reading and saving the order

    private enum LayoutAnswer {
        case config(ChannelLayoutConfig)
        /// 404: a server older than the mixed list. Draw the old one.
        case legacy
        /// Any other failure: keep drawing whatever was drawn.
        case unknown
    }

    private func fetchLayoutAnswer() async -> LayoutAnswer {
        do {
            if let config = try await session.api.channelLayoutConfig(serverId: server.id) {
                return .config(config)
            }
            return .legacy
        } catch {
            return .unknown
        }
    }

    private func adopt(_ answer: LayoutAnswer) {
        let next: ChannelLayoutConfig
        switch answer {
        case .config(let config): next = config
        case .legacy: next = .legacy
        case .unknown: return
        }
        adoptLayout(next)
    }

    private func adoptLayout(_ next: ChannelLayoutConfig) {
        guard next != layoutConfig else { return }
        withAnimation(.channelList(reduceMotion: reduceMotion)) { layoutConfig = next }
        ChannelLayoutMemory().save(next, serverId: server.id)
    }

    /// Quietly re-read the list and which list to draw, after a
    /// `channels-update` or a return to the foreground. No spinner and no
    /// error state: the list on screen is still the last thing the server
    /// said, which is a better answer than a failure.
    private func refreshChannelList() async {
        // One at a time; a burst of frames collapses into one follow-up read.
        await refreshGate.run { _ = await readChannelList() }
    }

    /// True when the list itself was read.
    private func readChannelList() async -> Bool {
        async let fresh: [Channel]? = try? session.api.channels(serverId: server.id)
        async let answer = fetchLayoutAnswer()
        let layout = await answer
        let channels = await fresh
        withAnimation(.channelList(reduceMotion: reduceMotion)) {
            if let channels { self.channels = channels }
            adopt(layout)
        }
        if let channels {
            let visible = Set(channels.map(\.id))
            unread = unread.filter { visible.contains($0.key) }
        }
        return channels != nil
    }

    /// Sends a whole order (Organizar canais, or one quick move from a row's
    /// menu), drawn at once and put back if the server refuses it. A 409
    /// because the list moved adopts the server's list and version.
    private func saveLayout(_ next: SidebarLayout<Channel>, baseVersion: Int) async -> ChannelLayoutSaveOutcome {
        let payload = ChannelLayoutRules.payload(next, baseVersion: baseVersion)
        let before = channels
        withAnimation(.channelList(reduceMotion: reduceMotion)) {
            channels = ChannelLayoutRules.apply(next, to: channels)
        }
        do {
            switch try await session.api.applyChannelLayout(serverId: server.id, payload: payload) {
            case .saved(let fresh, let version):
                // Null read-back: saved, keep the order drawn above.
                if let fresh { channels = fresh }
                adoptLayout(ChannelLayoutConfig(mixed: true, version: version))
                return .saved
            case .stale(let fresh, let version):
                withAnimation(.channelList(reduceMotion: reduceMotion)) { channels = fresh }
                adoptLayout(ChannelLayoutConfig(mixed: true, version: version))
                return .stale(mixedLayout(of: fresh), version: version)
            case .off:
                rollbackOrder(before)
                adoptLayout(.legacy)
                return .off
            case .invalid(let message):
                rollbackOrder(before)
                return .failed(message)
            }
        } catch {
            await reconcileAfterUnknownSave(before)
            return .failed(error.userFacingMessage ?? String(localized: "Couldn't move it. Try again."))
        }
    }

    /// Puts back only the order that was staged, on top of whatever list is
    /// drawn now: a channel a refresh or a create added meanwhile stays.
    private func rollbackOrder(_ before: [Channel]) {
        withAnimation(.channelList(reduceMotion: reduceMotion)) {
            channels = ChannelLayoutRules.apply(mixedLayout(of: before), to: channels)
        }
    }

    /// The PUT neither said yes nor no (the connection dropped): the server
    /// may have kept the order. Read the truth instead of guessing, and take
    /// the staged order back only when that read fails too.
    private func reconcileAfterUnknownSave(_ before: [Channel]) async {
        // Through the same gate as every other refresh, so an older read in
        // flight cannot land on top of this one. When the gate was busy, its
        // follow-up read is the answer and nothing is rolled back here.
        var read = false
        let ran = await refreshGate.run { read = await readChannelList() }
        if ran && !read { rollbackOrder(before) }
    }

    /// "Move to…" from a row's menu in the mixed list: the end of that
    /// category, or the end of the loose area. One PUT, like the organizer.
    private func moveInMixedList(_ channel: Channel, to parentId: String?) async {
        let layout = sidebarLayout
        let end = parentId.flatMap { id in
            layout.categories.first { $0.category.id == id }?.children.count
        } ?? layout.loose.count
        guard let next = ChannelLayoutRules.move(
            layout, id: channel.id, to: LayoutTarget(parentId: parentId, index: end)
        ) else { return }
        switch await saveLayout(next, baseVersion: layoutConfig.version) {
        case .saved, .off:
            break
        case .stale:
            layoutNotice = String(localized: "Couldn't move it. The list changed, try again.")
        case .failed(let message):
            layoutNotice = message
        }
    }

    /// The list version right after one of this screen's own writes, for the
    /// organizer's next PUT. Nil when it could not be read.
    private func freshLayoutVersion() async -> Int? {
        guard let config = try? await session.api.channelLayoutConfig(serverId: server.id) else { return nil }
        return config.version
    }

    private func createCategory(named name: String) async throws -> Channel {
        let category = try await session.api.createChannel(
            serverId: server.id, name: name, type: "category", isPrivate: false
        )
        withAnimation(.channelList(reduceMotion: reduceMotion)) {
            if !channels.contains(where: { $0.id == category.id }) { channels.append(category) }
        }
        return category
    }

    private func createCategoryFromList(_ raw: String) async {
        guard let name = CategoryName.normalized(raw) else { return }
        do {
            _ = try await createCategory(named: name)
        } catch {
            if let shown = error.userFacingMessage { layoutNotice = shown }
        }
    }

    private func renameCategory(_ category: Channel, to name: String) async throws -> Channel {
        let updated = try await session.api.renameChannel(id: category.id, name: name)
        if let index = channels.firstIndex(where: { $0.id == updated.id }) {
            channels[index] = updated
        }
        return updated
    }

    /// A channel made from a category's "+": in that category, and the
    /// category unfolds so the new row is seen. A private one opens "who can
    /// see this" straight away, because nobody else can until it is set.
    private func createChannel(in target: NewChannelTarget, name raw: String) async {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: " ", with: "-")
        guard !name.isEmpty else { return }
        do {
            let channel = try await session.api.createChannel(
                serverId: server.id, name: name, type: target.type,
                isPrivate: target.isPrivate, parentId: target.parentId
            )
            withAnimation(.channelList(reduceMotion: reduceMotion)) {
                if !channels.contains(where: { $0.id == channel.id }) { channels.append(channel) }
                if let parentId = target.parentId, collapsed.contains(parentId) {
                    collapsed = CollapsedSections().toggle(parentId, serverId: server.id)
                }
            }
            if target.isPrivate { memberPickerFor = channel }
        } catch {
            if let shown = error.userFacingMessage { layoutNotice = shown }
        }
    }

    private var organizer: some View {
        ChannelOrganizerView(
            layout: sidebarLayout,
            baseVersion: layoutConfig.version,
            save: { layout, version in await saveLayout(layout, baseVersion: version) },
            createCategory: { name in
                let category = try await createCategory(named: name)
                return (category, await freshLayoutVersion())
            },
            renameCategory: { category, name in
                let updated = try await renameCategory(category, to: name)
                return (updated, await freshLayoutVersion())
            }
        )
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
            if let shown = error.userFacingMessage { self.error = shown }
        }
    }

    @ViewBuilder
    private func channelActions(for channel: Channel) -> some View {
        // Threads are readable by anyone who can read the channel, their
        // visibility IS the channel's, so this sits above the manager block.
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
            if channel.isCategory && isMixed && canManageChannels {
                Button { organizing = true } label: {
                    Label("Organize channels", systemImage: "arrow.up.arrow.down")
                }
            }
            if !channel.isCategory && !categories.isEmpty && isMixed {
                Menu {
                    if channel.parentId != nil {
                        Button("Remove from category") { Task { await moveInMixedList(channel, to: nil) } }
                    }
                    ForEach(categories.filter { $0.id != channel.parentId }) { category in
                        Button(category.name) { Task { await moveInMixedList(channel, to: category.id) } }
                    }
                } label: {
                    Label("Move to…", systemImage: "folder")
                }
            } else if !channel.isCategory && !categories.isEmpty {
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
        openBauIfAsked()
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
        async let layoutTask = fetchLayoutAnswer()

        let config = await configTask
        let permissions = await permissionsTask
        if let config { liveHlsConfig = config }
        if let permissions { watchPartyPermissions = permissions }
        adopt(await layoutTask)

        do {
            channels = try await channelsTask
            // Unread is a separate call and failing it must not blank the
            // channel list, badges are a nicety, the list is the screen.
            if let entries = try? await session.api.unread(serverId: server.id) {
                unread = Dictionary(uniqueKeysWithValues: entries.map { ($0.channelId, $0) })
            }
            await refreshBau()
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
            if let shown = error.userFacingMessage { self.error = shown }
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

/// What a category's "+" asked for: the type, and where it goes.
struct NewChannelTarget: Equatable {
    let parentId: String?
    let type: String
    let isPrivate: Bool
}

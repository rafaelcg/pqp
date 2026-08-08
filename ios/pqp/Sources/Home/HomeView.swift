import SwiftUI

/// The signed-in shell.
///
/// One stack, one hub. There is no tab bar: the two things a chat app is made
/// of — the servers you are in and the people you talk to — are both on the hub
/// at once, so switching between them is a glance rather than a mode. Everything
/// else (you, friends) is a push off the hub, which is what keeps it out of the
/// way once you are reading a channel: a phone screen inside a conversation
/// should be the conversation.
///
/// Launch does not necessarily land here. `LastVisited` remembers the last
/// channel or DM and this stack opens onto it, validated against what the
/// server still says exists — see `restoreLastVisited`.
struct HomeView: View {
    @Environment(SessionStore.self) private var session
    @State private var model = HomeModel()

    /// The restored destination, seeded once at launch. `navigationDestination`
    /// rather than a bound path so every plain `NavigationLink` in the tree
    /// keeps working unchanged — a typed path would have made this the only
    /// legal way to push anything, anywhere.
    ///
    /// A conversation is pushed through the hub's own binding rather than a
    /// second one here: two `navigationDestination(item:)` for the same type in
    /// one stack is one destination too many, and which of them wins is not
    /// something to find out in production.
    @State private var restoredChannel: RestoredChannel?
    @State private var openedConversation: DmSummary?
    @State private var hasAttemptedRestore = false

    /// Server and channel as ONE value.
    ///
    /// They were two `@State`s once, and the channel silently arrived as nil:
    /// the destination closure SwiftUI runs on a push is the one it captured
    /// before the update, so only the state driving the push is reliably fresh.
    /// A single item cannot be half-applied.
    struct RestoredChannel: Hashable {
        let server: Server
        let channel: Channel
    }

    var body: some View {
        NavigationStack {
            HubView(model: model, openedConversation: $openedConversation)
                .navigationDestination(item: $restoredChannel) { restored in
                    ChannelListView(server: restored.server, initialChannel: restored.channel)
                }
        }
        .tint(Palette.signal)
        .task {
            await model.load(session: session)
            await restoreLastVisited()
        }
    }

    /// Reopens where the user left off, or does nothing.
    ///
    /// Every restore is validated against the lists that were just fetched: a
    /// server you were removed from, a channel someone deleted, a DM that is no
    /// longer yours. A stale pointer is dropped rather than pushed, because the
    /// failure mode of guessing is landing on a screen that can only show an
    /// error — worse than the hub, which is the fallback.
    private func restoreLastVisited() async {
        guard !hasAttemptedRestore else { return }
        hasAttemptedRestore = true
        guard let target = LastVisited.load() else { return }

        switch target.kind {
        case .conversation:
            guard let conversation = model.conversations
                .first(where: { $0.channelId == target.channelId })
            else {
                LastVisited.clear()
                return
            }
            push { openedConversation = conversation }

        case .channel:
            guard let serverId = target.serverId,
                  let server = model.servers.first(where: { $0.id == serverId }),
                  let channels = try? await session.api.channels(serverId: serverId),
                  let channel = channels.first(where: { $0.id == target.channelId && $0.isText })
            else {
                LastVisited.clear()
                return
            }
            push {
                restoredChannel = RestoredChannel(server: server, channel: channel)
            }
        }
    }

    /// Seeds the stack without animating. The restored screen is where the app
    /// *starts*; sliding it in would stage a navigation the user did not make.
    private func push(_ body: () -> Void) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction, body)
    }
}

@MainActor
@Observable
final class HomeModel {
    var servers: [Server] = []
    var conversations: [DmSummary] = []
    var isLoading = true
    var error: String?
    /// Friend requests waiting on this account — the badge on the Friends
    /// entry point. Only incoming ones count: a badge is a call to action, and
    /// there is nothing to do about a request you sent. There is no friend WS
    /// frame on the server, so this moves on refresh, not live.
    var pendingFriendRequests = 0
    /// Whether the first load has happened. The hub re-reads on every appear so
    /// coming back from a thread clears its badge; without this, launch would
    /// fetch everything twice before the first frame.
    private(set) var hasLoadedOnce = false

    private var session: SessionStore?
    private let handlerKey = "home-" + UUID().uuidString

    func load(session: SessionStore) async {
        self.session = session
        // Keeps the conversation list honest while the user is elsewhere:
        // activity in a DM (serverId is nil on those frames) bumps the row
        // immediately instead of waiting for a pull-to-refresh.
        session.eventHandlers[handlerKey] = { [weak self] event in
            guard let self,
                  case .activity(let channelId, let serverId, let mention) = event,
                  serverId == nil else { return }
            guard let index = self.conversations.firstIndex(where: { $0.channelId == channelId })
            else {
                // A conversation this list has never seen — someone opened a
                // brand-new DM to us. Only the server knows who is in it.
                Task { await self.refresh() }
                return
            }
            let old = self.conversations[index]
            self.conversations[index] = DmSummary(
                channelId: old.channelId,
                kind: old.kind,
                participants: old.participants,
                lastMessageAt: Date(),
                unread: DmUnread(
                    count: old.unread.count + 1,
                    mentions: old.unread.mentions + (mention ? 1 : 0)
                )
            )
            // Freshest first, the way the server orders the list.
            self.conversations.sort {
                ($0.lastMessageAt ?? .distantPast) > ($1.lastMessageAt ?? .distantPast)
            }
        }
        await refresh()
    }

    func refresh() async {
        guard let session else { return }
        isLoading = true
        error = nil
        do {
            // Both lists are the hub, side by side — fetching them together
            // means it never assembles in two visible stages.
            async let servers = session.api.servers()
            async let conversations = session.api.conversations()
            self.servers = try await servers
            self.conversations = try await conversations
            // A separate, non-fatal read: the badge is a nicety and must not
            // be able to blank the two lists that are the screen.
            pendingFriendRequests = FriendsDigest.pendingActionCount(
                (try? await session.api.friends()) ?? FriendsResponse()
            )
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
        hasLoadedOnce = true
    }

    func createServer(named name: String) async {
        guard let session else { return }
        do {
            let server = try await session.api.createServer(name: name)
            servers.append(server)
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// The hub: servers across the top, conversations below, you at the bottom.
///
/// The server rail is horizontal on purpose. Servers are picked by recognition
/// — a shape and a colour you already know — while conversations are read, so
/// they get the vertical space where names and timestamps are legible. That
/// division is what lets both fit above the fold instead of one pushing the
/// other onto a second screen.
struct HubView: View {
    @Environment(SessionStore.self) private var session
    @Bindable var model: HomeModel
    /// Owned by `HomeView` so a restored DM and a freshly created one push
    /// through the same, single destination.
    @Binding var openedConversation: DmSummary?

    @State private var showingCreateServer = false
    @State private var newServerName = ""
    @State private var showingNewConversation = false

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            if model.isLoading && model.servers.isEmpty && model.conversations.isEmpty {
                ProgressView().tint(Palette.signal)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if let error = model.error {
                            errorNote(error)
                        }
                        serverSection
                        conversationSection
                    }
                    .padding(.top, 6)
                    .padding(.bottom, 24)
                }
                .refreshable { await model.refresh() }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { profileDock }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { wordmark }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        showingNewConversation = true
                    } label: {
                        Label("New message", systemImage: "square.and.pencil")
                    }
                    Button {
                        showingCreateServer = true
                    } label: {
                        Label("New server", systemImage: "plus.square.on.square")
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .tint(Palette.signal)
                .accessibilityIdentifier("hub.new")
                .accessibilityLabel("New")
            }
        }
        // Coming back from a channel or a thread re-reads the lists — the
        // screen behind marked itself read server-side and this is what clears
        // the badge here.
        .onAppear {
            guard model.hasLoadedOnce else { return }
            Task { await model.refresh() }
        }
        .alert("New server", isPresented: $showingCreateServer) {
            TextField("Server name", text: $newServerName)
            Button("Cancel", role: .cancel) { newServerName = "" }
            Button("Create") {
                let name = newServerName.trimmingCharacters(in: .whitespacesAndNewlines)
                newServerName = ""
                guard !name.isEmpty else { return }
                Task { await model.createServer(named: name) }
            }
        }
        .sheet(isPresented: $showingNewConversation) {
            NewConversationView { conversation in
                // Refresh so the new thread is in the list behind the sheet,
                // then open it — otherwise dismissing lands on a list that does
                // not yet contain the conversation just created.
                Task { await model.refresh() }
                openedConversation = conversation
            }
        }
        .navigationDestination(item: $openedConversation) { conversation in
            chat(for: conversation)
        }
    }

    // MARK: - Chrome

    private var wordmark: some View {
        HStack(spacing: 7) {
            SpeechMark(size: 17)
            Text("pqp")
                .font(Typography.display(19))
                .foregroundStyle(Palette.paper)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("pqp")
    }

    private func errorNote(_ error: String) -> some View {
        Text(error)
            .font(Typography.callout)
            .foregroundStyle(Palette.danger)
            .padding(.horizontal, Metrics.hPadding)
    }

    /// You, docked. Present on the hub and nowhere else — a profile chip that
    /// followed you into a channel would be a tab bar wearing a hat.
    ///
    /// Two floating capsules rather than one full-width bar, for exactly that
    /// reason: an edge-to-edge strip pinned to the bottom of a phone reads as
    /// navigation chrome no matter what is in it. It still goes in as a safe
    /// area inset, so the list can be scrolled clear of it instead of ending
    /// underneath it.
    private var profileDock: some View {
        HStack(spacing: 10) {
            NavigationLink {
                ProfileView()
            } label: {
                HStack(spacing: 9) {
                    Avatar(
                        name: session.currentUser?.displayName ?? "?",
                        seed: session.currentUser?.id ?? "anon",
                        size: 30,
                        url: session.currentUser?.avatarUrl
                    )
                    .overlay(alignment: .bottomTrailing) {
                        StatusDot(status: connectionDotStatus, size: 10)
                            .offset(x: 2, y: 2)
                    }

                    VStack(alignment: .leading, spacing: 1) {
                        Text(session.currentUser?.displayName ?? String(localized: "You"))
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paper)
                            .lineLimit(1)
                        Text(dockSubtitle)
                            .font(Typography.label)
                            .foregroundStyle(Palette.paperMuted)
                            .lineLimit(1)
                    }
                    .padding(.trailing, 4)
                }
                .padding(6)
                .background(Capsule().fill(Palette.surfaceRaised))
                .overlay(Capsule().strokeBorder(Palette.border, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("hub.profile")
            .accessibilityLabel("You, profile and settings")

            Spacer(minLength: 8)

            NavigationLink {
                FriendsView()
            } label: {
                Image(systemName: "person.2.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.paper)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Palette.surfaceRaised))
                    .overlay(Circle().strokeBorder(Palette.border, lineWidth: 1))
                    .overlay(alignment: .topTrailing) {
                        if model.pendingFriendRequests > 0 {
                            Circle()
                                .fill(Palette.signal)
                                .frame(width: 10, height: 10)
                                .overlay(Circle().strokeBorder(Palette.ink, lineWidth: 1.5))
                                .offset(x: -1, y: 1)
                        }
                    }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("hub.friends")
            .accessibilityLabel(
                model.pendingFriendRequests > 0
                    ? Text("Friends, \(model.pendingFriendRequests) requests waiting")
                    : Text("Friends")
            )
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.top, 10)
        .padding(.bottom, 6)
        // A fade rather than a hard edge, so a long conversation list passes
        // under the pills instead of colliding with them.
        .background {
            LinearGradient(
                colors: [Palette.ink.opacity(0), Palette.ink, Palette.ink],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .bottom)
        }
        .animation(Motion.standard, value: model.pendingFriendRequests)
    }

    /// The dock says "you"; when the socket is down it says that instead,
    /// because a chat app that hides its own disconnection just looks broken.
    private var dockSubtitle: String {
        switch session.realtimeStatus {
        case .online: session.currentUser?.tag ?? String(localized: "Connected")
        default: RealtimeStatusText.label(session.realtimeStatus)
        }
    }

    private var connectionDotStatus: String {
        switch session.realtimeStatus {
        case .online: "online"
        case .connecting, .reconnecting: "idle"
        case .unauthorized, .idle: "offline"
        }
    }

    // MARK: - Servers

    @ViewBuilder
    private var serverSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: String(localized: "Servers"))
                .padding(.horizontal, Metrics.hPadding)

            if model.servers.isEmpty {
                Button { showingCreateServer = true } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "plus.circle")
                            .font(.system(size: 20, weight: .light))
                            .foregroundStyle(Palette.signal)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Create a server")
                                .font(Typography.bodyMedium)
                                .foregroundStyle(Palette.paper)
                            Text("Or join one with an invite code.")
                                .font(Typography.caption)
                                .foregroundStyle(Palette.paperMuted)
                        }
                        Spacer()
                    }
                    .padding(14)
                    .pqpSurface()
                }
                .buttonStyle(.plain)
                .padding(.horizontal, Metrics.hPadding)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(Array(model.servers.enumerated()), id: \.element.id) { index, server in
                            NavigationLink {
                                ChannelListView(server: server)
                            } label: {
                                ServerTile(server: server)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("hub.server.\(server.id)")
                            // Staggered entrance so the rail assembles rather
                            // than snapping in as one block.
                            .animation(
                                Motion.standard.delay(Motion.stagger(index)),
                                value: model.servers.count
                            )
                        }

                        Button { showingCreateServer = true } label: {
                            AddServerTile()
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("hub.addServer")
                        .accessibilityLabel("Create a server")
                    }
                    .padding(.horizontal, Metrics.hPadding)
                }
                .accessibilityIdentifier("hub.serverRail")
            }
        }
    }

    // MARK: - Conversations

    @ViewBuilder
    private var conversationSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                SectionLabel(text: String(localized: "Direct messages"))
                Spacer()
                Button { showingNewConversation = true } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 14, weight: .semibold))
                }
                .tint(Palette.signal)
                .accessibilityIdentifier("hub.newConversation")
                .accessibilityLabel("New message")
            }
            .padding(.horizontal, Metrics.hPadding)

            if model.conversations.isEmpty {
                Button { showingNewConversation = true } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "envelope")
                            .font(.system(size: 20, weight: .light))
                            .foregroundStyle(Palette.paperMuted)
                        Text("Start a conversation")
                            .font(Typography.bodyMedium)
                            .foregroundStyle(Palette.paper)
                        Spacer()
                    }
                    .padding(14)
                    .pqpSurface()
                }
                .buttonStyle(.plain)
                .padding(.horizontal, Metrics.hPadding)
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(model.conversations) { conversation in
                        NavigationLink {
                            chat(for: conversation)
                        } label: {
                            ConversationRow(conversation: conversation)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("hub.conversation.\(conversation.channelId)")
                    }
                }
                .padding(.horizontal, Metrics.hPadding)
            }
        }
    }

    /// One place builds a conversation's chat screen, so "opened a DM" and
    /// "remember this DM" cannot drift apart.
    private func chat(for conversation: DmSummary) -> some View {
        ChatView(
            channelId: conversation.channelId,
            title: conversation.title,
            conversation: conversation
        )
        .onAppear { LastVisited.record(conversationId: conversation.channelId) }
    }
}

/// A server in the rail: the mark, then the name under it.
///
/// The name is not decoration. Monograms collide (two servers starting with the
/// same letter are the same shape), and a rail you have to hover to read is a
/// desktop pattern that a phone cannot support.
struct ServerTile: View {
    let server: Server

    var body: some View {
        VStack(spacing: 7) {
            Avatar(name: server.name, seed: server.id, size: 58)

            Text(server.name)
                .font(Typography.caption)
                .foregroundStyle(Palette.paperSubtle)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(width: 74)
        }
        .frame(width: 74)
    }
}

struct AddServerTile: View {
    var body: some View {
        VStack(spacing: 7) {
            Image(systemName: "plus")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Palette.signal)
                .frame(width: 58, height: 58)
                .background(Circle().fill(Palette.surface))
                .overlay(
                    Circle().strokeBorder(
                        Palette.border,
                        style: StrokeStyle(lineWidth: 1, dash: [4, 4])
                    )
                )

            Text("New")
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
                .frame(width: 74)
        }
        .frame(width: 74)
    }
}

struct ConversationRow: View {
    let conversation: DmSummary

    var body: some View {
        HStack(spacing: 14) {
            Avatar(
                name: conversation.participants.first?.displayName ?? "?",
                seed: conversation.channelId,
                size: 46,
                url: conversation.kind == "dm" ? conversation.participants.first?.avatarUrl : nil
            )

            VStack(alignment: .leading, spacing: 3) {
                Text(conversation.title)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                if let last = conversation.lastMessageAt {
                    Text(last, format: .relative(presentation: .named))
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                }
            }

            Spacer()

            if conversation.unread.count > 0 {
                UnreadBadge(count: conversation.unread.count,
                            isMention: conversation.unread.mentions > 0)
            }
        }
        .padding(14)
        .pqpSurface()
    }
}

struct UnreadBadge: View {
    let count: Int
    var isMention: Bool = false

    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(Palette.inkDeep)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(
                Capsule().fill(isMention ? Palette.signal : Palette.paperMuted)
            )
    }
}

struct ProfileView: View {
    @Environment(SessionStore.self) private var session
    @State private var showingSettings = false
    @State private var manualStatus = "online"

    /// Only the two assertable states plus the default. `idle` is absent on
    /// purpose — it is a fact the device reports, not an opinion to pick.
    private let statusChoices: [(value: String, label: LocalizedStringKey, dot: String)] = [
        ("online", "Online", "online"),
        ("dnd", "Do not disturb", "dnd"),
        ("invisible", "Invisible", "offline"),
    ]

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            VStack(spacing: 20) {
                if let user = session.currentUser {
                    Avatar(name: user.displayName, seed: user.id, size: 84, url: user.avatarUrl)
                        .padding(.top, 24)

                    VStack(spacing: 4) {
                        Text(user.displayName)
                            .font(Typography.title(22))
                            .foregroundStyle(Palette.paper)
                        if let tag = user.tag {
                            Text(tag)
                                .font(Typography.mono)
                                .foregroundStyle(Palette.paperMuted)
                        }
                    }

                    HStack(spacing: 10) {
                        statusMenu
                        ConnectionPill(status: session.realtimeStatus)
                    }
                }

                Spacer()

                VStack(spacing: 10) {
                    Button("Settings") { showingSettings = true }
                        .buttonStyle(PrimaryButtonStyle())
                    Button("Sign out") {
                        Task { await session.signOut() }
                    }
                    .buttonStyle(SecondaryButtonStyle())
                }
                .padding(.horizontal, Metrics.hPadding)
                .padding(.bottom, 20)
            }
        }
        .navigationTitle("You")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingSettings) { AccountSettingsView() }
        .task {
            manualStatus = (try? await session.api.preferences())?.status ?? "online"
        }
    }

    private var statusMenu: some View {
        Menu {
            ForEach(statusChoices, id: \.value) { choice in
                Button {
                    let previous = manualStatus
                    manualStatus = choice.value
                    Task {
                        do {
                            _ = try await session.api.setStatus(choice.value)
                        } catch {
                            // The server is the record; a failed set must not
                            // leave the menu claiming a status nobody else sees.
                            manualStatus = previous
                        }
                    }
                } label: {
                    Label(choice.label, systemImage: manualStatus == choice.value ? "checkmark" : "circle")
                }
            }
        } label: {
            HStack(spacing: 6) {
                StatusDot(status: statusChoices.first { $0.value == manualStatus }?.dot)
                Text(statusChoices.first { $0.value == manualStatus }?.label ?? "Online")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9))
                    .foregroundStyle(Palette.paperMuted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Capsule().fill(Palette.surface))
        }
    }
}

/// How connection state is worded, in one place: the hub dock and the profile
/// pill are the same fact shown at two sizes, and they must not disagree.
enum RealtimeStatusText {
    static func label(_ status: RealtimeStatus) -> String {
        switch status {
        case .online: String(localized: "Connected")
        case .connecting: String(localized: "Connecting…")
        case .reconnecting: String(localized: "Reconnecting…")
        case .unauthorized: String(localized: "Signed out")
        case .idle: String(localized: "Offline")
        }
    }

    static func color(_ status: RealtimeStatus) -> Color {
        switch status {
        case .online: Palette.success
        case .connecting, .reconnecting: Palette.warning
        case .unauthorized, .idle: Palette.paperMuted
        }
    }
}

/// Connection state, shown as a fact rather than an alert. A chat app that
/// hides its own disconnection just looks broken.
struct ConnectionPill: View {
    let status: RealtimeStatus

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(RealtimeStatusText.color(status)).frame(width: 7, height: 7)
            Text(RealtimeStatusText.label(status))
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Capsule().fill(Palette.surface))
        .animation(Motion.standard, value: status)
    }
}

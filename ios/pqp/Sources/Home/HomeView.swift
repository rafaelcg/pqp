import SwiftUI

/// The signed-in shell.
///
/// Deliberately a `NavigationStack` per tab rather than the web app's
/// three-pane layout. A phone has room for one thing at a time, and porting the
/// desktop rail would spend a third of a 390pt screen on navigation chrome.
struct HomeView: View {
    @Environment(SessionStore.self) private var session
    @State private var model = HomeModel()

    var body: some View {
        TabView {
            NavigationStack {
                ServerListView(model: model)
            }
            .tabItem { Label("Servers", systemImage: "bubble.left.and.bubble.right.fill") }

            NavigationStack {
                ConversationListView(model: model)
            }
            .tabItem { Label("Messages", systemImage: "envelope.fill") }

            NavigationStack {
                ProfileView()
            }
            .tabItem { Label("You", systemImage: "person.fill") }
        }
        .tint(Palette.signal)
        .task { await model.load(session: session) }
    }
}

@MainActor
@Observable
final class HomeModel {
    var servers: [Server] = []
    var conversations: [DmSummary] = []
    var isLoading = true
    var error: String?

    private var session: SessionStore?
    private let handlerKey = "home-" + UUID().uuidString

    func load(session: SessionStore) async {
        self.session = session
        // Keeps the Messages tab honest while it is not on screen: activity in
        // a DM (serverId is nil on those frames) bumps the row immediately
        // instead of waiting for a pull-to-refresh.
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
            // Both lists feed the two main tabs; fetching them together means
            // switching tabs never shows a second loading state.
            async let servers = session.api.servers()
            async let conversations = session.api.conversations()
            self.servers = try await servers
            self.conversations = try await conversations
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
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

struct ServerListView: View {
    @Environment(SessionStore.self) private var session
    @Bindable var model: HomeModel
    @State private var showingCreate = false
    @State private var newServerName = ""

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            if model.isLoading && model.servers.isEmpty {
                ProgressView().tint(Palette.signal)
            } else if model.servers.isEmpty {
                EmptyState(
                    icon: "bubble.left.and.bubble.right",
                    title: "No servers yet",
                    message: "Create one for your group, or join with an invite code.",
                    actionTitle: "Create a server",
                    action: { showingCreate = true }
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(Array(model.servers.enumerated()), id: \.element.id) { index, server in
                            NavigationLink {
                                ChannelListView(server: server)
                            } label: {
                                ServerRow(server: server)
                            }
                            .buttonStyle(.plain)
                            .transition(.opacity)
                            // Staggered entrance so the list assembles rather
                            // than snapping in as one block.
                            .animation(
                                Motion.standard.delay(Motion.stagger(index)),
                                value: model.servers.count
                            )
                        }
                    }
                    .padding(.horizontal, Metrics.hPadding)
                    .padding(.top, 8)
                }
                .refreshable { await model.refresh() }
            }
        }
        .navigationTitle("Servers")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingCreate = true } label: {
                    Image(systemName: "plus")
                }
                .tint(Palette.signal)
            }
        }
        .alert("New server", isPresented: $showingCreate) {
            TextField("Server name", text: $newServerName)
            Button("Cancel", role: .cancel) { newServerName = "" }
            Button("Create") {
                let name = newServerName.trimmingCharacters(in: .whitespacesAndNewlines)
                newServerName = ""
                guard !name.isEmpty else { return }
                Task { await model.createServer(named: name) }
            }
        }
    }
}

struct ServerRow: View {
    let server: Server

    var body: some View {
        HStack(spacing: 14) {
            Avatar(name: server.name, seed: server.id, size: 46)

            VStack(alignment: .leading, spacing: 3) {
                Text(server.name)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                if let role = server.role {
                    Text(role.uppercased())
                        .font(Typography.label)
                        .tracking(1)
                        .foregroundStyle(Palette.paperMuted)
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.paperMuted)
        }
        .padding(14)
        .pqpSurface()
    }
}

struct ConversationListView: View {
    @Bindable var model: HomeModel
    @State private var showingNew = false
    @State private var openedConversation: DmSummary?

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            if model.conversations.isEmpty {
                EmptyState(
                    icon: "envelope",
                    title: "No conversations",
                    message: "Direct messages you start will show up here.",
                    actionTitle: "New message",
                    action: { showingNew = true }
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(model.conversations) { conversation in
                            NavigationLink {
                                ChatView(
                                    channelId: conversation.channelId,
                                    title: conversation.title
                                )
                            } label: {
                                ConversationRow(conversation: conversation)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, Metrics.hPadding)
                    .padding(.top, 8)
                }
                .refreshable { await model.refresh() }
            }
        }
        // Coming back from a thread re-reads the list — the thread marked
        // itself read server-side and this clears its badge here.
        .onAppear { Task { await model.refresh() } }
        .navigationTitle("Messages")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingNew = true } label: { Image(systemName: "square.and.pencil") }
                    .tint(Palette.signal)
            }
        }
        .sheet(isPresented: $showingNew) {
            NewConversationView { conversation in
                // Refresh so the new thread is in the list behind the sheet,
                // then open it — otherwise dismissing lands on a list that does
                // not yet contain the conversation just created.
                Task { await model.refresh() }
                openedConversation = conversation
            }
        }
        .navigationDestination(item: $openedConversation) { conversation in
            ChatView(channelId: conversation.channelId, title: conversation.title)
        }
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

/// Connection state, shown as a fact rather than an alert. A chat app that
/// hides its own disconnection just looks broken.
struct ConnectionPill: View {
    let status: RealtimeStatus

    private var label: String {
        switch status {
        case .online: String(localized: "Connected")
        case .connecting: String(localized: "Connecting…")
        case .reconnecting: String(localized: "Reconnecting…")
        case .unauthorized: String(localized: "Signed out")
        case .idle: String(localized: "Offline")
        }
    }

    private var color: Color {
        switch status {
        case .online: Palette.success
        case .connecting, .reconnecting: Palette.warning
        case .unauthorized, .idle: Palette.paperMuted
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label)
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Capsule().fill(Palette.surface))
        .animation(Motion.standard, value: status)
    }
}

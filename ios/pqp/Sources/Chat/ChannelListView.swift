import SwiftUI

struct ChannelListView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
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

    private var categories: [Channel] {
        channels.filter(\.isCategory).sorted { $0.position < $1.position }
    }
    /// Channels with no category, which the sidebar shows above the grouped
    /// ones — matching the web client's layout.
    private var looseText: [Channel] { channels.filter { $0.isText && $0.parentId == nil } }
    private var looseVoice: [Channel] { channels.filter { $0.isVoice && $0.parentId == nil } }

    private func children(of category: Channel) -> [Channel] {
        channels
            .filter { $0.parentId == category.id && !$0.isCategory }
            .sorted { $0.position < $1.position }
    }

    private var textChannels: [Channel] { looseText }
    private var voiceChannels: [Channel] { looseVoice }

    var body: some View {
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
                        // Above TEXT, where the web sidebar puts it. Not a
                        // channel and not drawn as one: the row carries its own
                        // hint so nobody opens it expecting to type.
                        if showsBau, let config = communityHome {
                            NavigationLink {
                                CommunityHomeView(server: current, config: config)
                            } label: {
                                BauRow()
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
                                if channel.isVoice {
                                    NavigationLink { VoiceView(channel: channel) } label: {
                                        ChannelRow(channel: channel, unread: nil)
                                    }
                                    .buttonStyle(.plain)
                                    .contextMenu { channelActions(for: channel) }
                                } else {
                                    NavigationLink {
                                        chat(for: channel)
                                    } label: {
                                        ChannelRow(channel: channel, unread: unread[channel.id])
                                    }
                                    .buttonStyle(.plain)
                                    .contextMenu { channelActions(for: channel) }
                                }
                            }
                        }

                        if !voiceChannels.isEmpty {
                            SectionLabel(text: String(localized: "Voice"))
                                .padding(.horizontal, 4)
                                .padding(.top, 12)
                            ForEach(voiceChannels) { channel in
                                NavigationLink {
                                    VoiceView(channel: channel)
                                } label: {
                                    ChannelRow(channel: channel, unread: nil)
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
        .task {
            await load()
            // Live badge updates. `channel-activity` is broadcast to every
            // member; without this the badge only moves on pull-to-refresh,
            // which makes unread counts look broken next to the web client.
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
                default:
                    return
                }
            }
        }
        .onDisappear { session.eventHandlers.removeValue(forKey: handlerKey) }
        // Coming back from a chat re-reads the counts: the chat marked itself
        // read on the server, and this is what clears its badge locally.
        .onAppear { Task { await refreshUnread() } }
    }

    /// A text channel's chat screen, plus the note that this is now where the
    /// app was last reading. Recorded from the shell rather than from inside
    /// `ChatView`, so "where am I" stays a navigation fact — and so a voice
    /// channel is never recorded, since restoring one would join a call on
    /// launch.
    private func chat(for channel: Channel) -> some View {
        // `server` carries this account's rank, which is what lets the message
        // menu and the profile sheet offer moderation from where the offence is
        // rather than from a members screen two taps away.
        ChatView(
            channelId: channel.id,
            title: "#\(channel.name)",
            canStartThreads: true,
            server: server
        )
        .onAppear { LastVisited.record(channelId: channel.id, serverId: server.id) }
    }

    private func refreshUnread() async {
        guard !channels.isEmpty else { return }
        if let entries = try? await session.api.unread(serverId: server.id) {
            unread = Dictionary(uniqueKeysWithValues: entries.map { ($0.channelId, $0) })
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
        do {
            channels = try await session.api.channels(serverId: server.id)
            // Unread is a separate call and failing it must not blank the
            // channel list — badges are a nicety, the list is the screen.
            if let entries = try? await session.api.unread(serverId: server.id) {
                unread = Dictionary(uniqueKeysWithValues: entries.map { ($0.channelId, $0) })
            }
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }

    /// Re-read the list after a permissions change, quietly.
    ///
    /// Deliberately not `load()`: that sets `isLoading`, which throws a spinner
    /// over a list somebody is reading because an admin renamed a role. A
    /// failure is also swallowed rather than shown, because the list on screen
    /// is still the last thing the server actually said, and replacing it with
    /// an error would be a worse answer than a slightly stale one. The next
    /// `permissions-update` or a pull-to-refresh tries again.
    private func reloadAfterPermissionsChange() async {
        guard let fresh = try? await session.api.channels(serverId: server.id) else { return }
        channels = fresh
        // A channel that is gone must not keep a badge behind in the dictionary.
        let visible = Set(fresh.map(\.id))
        unread = unread.filter { visible.contains($0.key) }
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

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: channel.isVoice ? "speaker.wave.2.fill" : "number")
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

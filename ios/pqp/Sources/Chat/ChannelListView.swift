import SwiftUI

struct ChannelListView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let server: Server

    init(server: Server) {
        self.server = server
        _current = State(initialValue: server)
    }

    @State private var channels: [Channel] = []
    @State private var unread: [String: UnreadEntry] = [:]
    @State private var isLoading = true
    @State private var error: String?
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
    @State private var current: Server

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
                    message: error,
                    actionTitle: "Try again",
                    action: { Task { await load() } }
                )
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        if !textChannels.isEmpty {
                            SectionLabel(text: "Text")
                                .padding(.horizontal, 4)
                                .padding(.top, 4)
                            ForEach(textChannels) { channel in
                                NavigationLink {
                                    ChatView(channelId: channel.id, title: "#\(channel.name)")
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
                                        ChatView(channelId: channel.id, title: "#\(channel.name)")
                                    } label: {
                                        ChannelRow(channel: channel, unread: unread[channel.id])
                                    }
                                    .buttonStyle(.plain)
                                    .contextMenu { channelActions(for: channel) }
                                }
                            }
                        }

                        if !voiceChannels.isEmpty {
                            SectionLabel(text: "Voice")
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
        .navigationBarTitleDisplayMode(.large)
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
                            Label("Server settings", systemImage: "gearshape")
                        }
                    }
                    Divider()
                    // Leaving is offered to everyone except the owner, who has
                    // to transfer or delete instead — the server refuses the
                    // last-owner case and there is no sense offering it.
                    if server.role != "owner" {
                        Button(role: .destructive) { confirmingLeave = true } label: {
                            Label("Leave server", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .tint(Palette.signal)
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
        .task { await load() }
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
        isLoading = true
        error = nil
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

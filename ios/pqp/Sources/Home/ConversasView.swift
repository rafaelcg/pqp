import SwiftUI

/// The Conversas tab: every conversation, WhatsApp-style.
///
/// Drawn only with `conversations_home_phone_tabs` on (see `HomeView.tabs`).
/// Search and the Tudo / Não lidas / Grupos chips run over the list already in
/// memory, so they cost no request. Fixadas is the same `pinnedConversations`
/// preference the web rail pins write. Friends lives in the header, with the
/// lime dot when somebody is waiting on you, because friends exist to be
/// talked to and that frees the third tab for Tu.
struct ConversasView: View {
    @Environment(SessionStore.self) private var session
    @Bindable var model: HomeModel
    @Binding var openedConversation: DmSummary?

    @State private var query = ""
    @State private var filter: ConversationFilter = .all
    @State private var showingNew = false
    @State private var showingFriends = false
    @State private var addingFriend = false
    /// The friend a "Say hi" on the empty screen is opening a conversation with.
    @State private var opening: String?

    private var visible: [DmSummary] {
        ConversationList.filter(model.conversations, query: query, filter: filter)
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Palette.ink.ignoresSafeArea()

            if model.isLoading && model.conversations.isEmpty && !model.hasLoadedOnce {
                ProgressView().tint(Palette.signal)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.conversations.isEmpty {
                ScrollView {
                    ConversationsEmptyHero(
                        friends: model.friends,
                        shareURL: shareURL,
                        opening: opening,
                        onAddFriend: { addingFriend = true },
                        onSayHi: { friend in Task { await sayHi(to: friend) } }
                    )
                    .padding(.top, 12)
                }
                .refreshable { await model.refresh() }
            } else {
                list
                newConversationButton
                    .padding(.trailing, Metrics.hPadding)
                    .padding(.bottom, 14)
            }
        }
        .navigationTitle("Chats")
        .navigationBarTitleDisplayMode(.large)
        .searchable(
            text: $query,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: Text("Find a conversation or someone")
        )
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingFriends = true } label: {
                    Image(systemName: "person.2")
                        .overlay(alignment: .topTrailing) {
                            if model.waitingOnYou > 0 {
                                Circle()
                                    .fill(Palette.signal)
                                    .frame(width: 9, height: 9)
                                    .overlay(Circle().strokeBorder(Palette.ink, lineWidth: 1.5))
                                    .offset(x: 4, y: -3)
                            }
                        }
                }
                .tint(Palette.paper)
                .accessibilityIdentifier("conversas.friends")
                .accessibilityLabel(
                    model.waitingOnYou > 0
                        ? Text("Friends, \(model.waitingOnYou) waiting on you")
                        : Text("Friends")
                )
            }
        }
        .sheet(isPresented: $showingNew) {
            NovaConversaView(
                friends: model.friends,
                recent: recentPeople,
                onOpened: { conversation in
                    Task { await model.refresh() }
                    openedConversation = conversation
                },
                onAddFriend: { addingFriend = true }
            )
        }
        .navigationDestination(item: $openedConversation) { conversation in
            ConversationChat(conversation: conversation)
        }
        .navigationDestination(isPresented: $showingFriends) {
            FriendsView()
        }
        .navigationDestination(isPresented: $addingFriend) {
            FriendsView(opensAddImmediately: true)
        }
        // Coming back from a conversation re-reads the list: the screen behind
        // marked itself read server-side, and this is what clears its count.
        .onAppear {
            guard model.hasLoadedOnce else { return }
            Task { await model.refresh() }
        }
    }

    // MARK: - The list

    private var list: some View {
        let split = ConversationList.splitPinned(visible, pinnedIds: model.pinnedConversationIds)
        return List {
            chips
                .listRowInsets(EdgeInsets(top: 4, leading: Metrics.hPadding, bottom: 6, trailing: Metrics.hPadding))
                .listRowBackground(Palette.ink)
                .listRowSeparator(.hidden)

            if let error = model.error {
                Text(error)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.danger)
                    .listRowBackground(Palette.ink)
                    .listRowSeparator(.hidden)
            }

            if visible.isEmpty {
                emptyFilter
                    .listRowBackground(Palette.ink)
                    .listRowSeparator(.hidden)
            }

            if !split.pinned.isEmpty {
                Section {
                    ForEach(split.pinned) { row($0) }
                } header: {
                    SectionLabel(text: String(localized: "Pinned"))
                }
            }
            if !split.recent.isEmpty {
                Section {
                    ForEach(split.recent) { row($0) }
                } header: {
                    if !split.pinned.isEmpty {
                        SectionLabel(text: String(localized: "Recent"))
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Palette.ink)
        // Room for the Nova conversa button over the last row.
        .contentMargins(.bottom, 84, for: .scrollContent)
        .refreshable { await model.refresh() }
        .animation(Motion.standard, value: visible.map(\.channelId))
    }

    private func row(_ conversation: DmSummary) -> some View {
        let pinned = model.isPinned(conversation)
        return Button {
            openedConversation = conversation
        } label: {
            ConversationRowV2(
                conversation: conversation,
                viewerId: session.currentUser?.id,
                presence: model.presence(for: conversation),
                typing: model.typingNames(in: conversation.channelId),
                isPinned: pinned
            )
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: Metrics.hPadding, bottom: 0, trailing: Metrics.hPadding))
        .listRowBackground(Palette.ink)
        .listRowSeparator(.hidden)
        .accessibilityIdentifier("conversas.row.\(conversation.channelId)")
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                Task { await model.togglePin(conversation) }
            } label: {
                Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin")
            }
            .tint(Palette.signalDim)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                Task { await model.close(conversation) }
            } label: {
                Label("Close conversation", systemImage: "xmark")
            }
        }
        .contextMenu {
            Button {
                Task { await model.togglePin(conversation) }
            } label: {
                Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin")
            }
            Button(role: .destructive) {
                Task { await model.close(conversation) }
            } label: {
                Label("Close conversation", systemImage: "xmark")
            }
        }
    }

    private var chips: some View {
        HStack(spacing: 8) {
            chip(.all, title: "All", count: 0)
            chip(.unread, title: "Unread chats", count: model.waitingConversations)
            chip(.groups, title: "Groups", count: 0)
            Spacer(minLength: 0)
        }
    }

    private func chip(_ value: ConversationFilter, title: LocalizedStringKey, count: Int) -> some View {
        let selected = filter == value
        return Button {
            withAnimation(Motion.standard) { filter = value }
        } label: {
            HStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(selected ? Palette.signal : Palette.paperSubtle)
                if count > 0 {
                    ConversationCountBadge(count: count, compact: true)
                }
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 7)
            .background(
                Capsule().fill(selected ? Palette.signal.opacity(0.16) : Palette.surfaceRaised)
            )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("conversas.filter.\(value.rawValue)")
    }

    @ViewBuilder
    private var emptyFilter: some View {
        VStack(spacing: 12) {
            if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                Text("No conversation with “\(query)”.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
                Button("Look for someone else") { showingNew = true }
                    .font(Typography.callout.weight(.semibold))
                    .tint(Palette.signal)
            } else if filter == .unread {
                Text("All caught up.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
            } else if filter == .groups {
                Text("No groups yet. Pick two or more people in New conversation.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
    }

    private var newConversationButton: some View {
        Button { showingNew = true } label: {
            HStack(spacing: 8) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 17, weight: .semibold))
                Text("New conversation")
                    .font(.system(size: 16, weight: .semibold))
            }
            .foregroundStyle(Palette.inkDeep)
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .background(Capsule().fill(Palette.signal))
            .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("conversas.new")
    }

    // MARK: - Helpers

    /// People from recent 1:1s who are not friends, for Nova conversa's
    /// Recentes: somebody you talked to last week is somebody you may want
    /// to talk to again, friend or not.
    private var recentPeople: [PublicUser] {
        let friendIds = Set(model.friends.map(\.id))
        var seen = Set<String>()
        var people: [PublicUser] = []
        for conversation in model.conversations where conversation.kind == "dm" {
            guard let person = conversation.participants.first,
                  !friendIds.contains(person.id),
                  seen.insert(person.id).inserted
            else { continue }
            people.append(person)
            if people.count == 5 { break }
        }
        return people
    }

    /// What "Bring someone to pqp" shares: your public page when you have a
    /// handle, the front door otherwise.
    private var shareURL: URL {
        if let handle = session.currentUser?.handle, !handle.isEmpty,
           let url = URL(string: "https://pqp.gg/@\(handle)") {
            return url
        }
        return URL(string: "https://pqp.gg")!
    }

    private func sayHi(to friend: Friend) async {
        opening = friend.id
        defer { opening = nil }
        do {
            let conversation = try await session.api.openConversation(userIds: [friend.id])
            await model.refresh()
            openedConversation = conversation
        } catch {
            model.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

// MARK: - The row

/// A conversation, WhatsApp anatomy: avatar with the friend's presence, name,
/// time (lime while unread), the preview or "digitando…", and the count or the
/// pin.
struct ConversationRowV2: View {
    let conversation: DmSummary
    let viewerId: String?
    /// The other person's status, for a friend in a 1:1 only.
    var presence: String?
    /// Names typing here right now.
    var typing: [String] = []
    var isPinned: Bool = false

    private var isUnread: Bool { conversation.unread.count > 0 }

    var body: some View {
        HStack(spacing: 13) {
            ConversationAvatar(conversation: conversation, presence: presence, size: 52)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(conversation.title)
                        .font(.system(size: 16, weight: isUnread ? .bold : .semibold))
                        .foregroundStyle(Palette.paper)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if let last = conversation.lastMessageAt {
                        Text(verbatim: ConversationTime.label(for: last))
                            .font(.system(size: 12, weight: isUnread ? .semibold : .regular))
                            .foregroundStyle(isUnread ? Palette.signal : Palette.paperMuted)
                            .monospacedDigit()
                    }
                }
                HStack(alignment: .center, spacing: 8) {
                    secondLine
                    Spacer(minLength: 4)
                    if isUnread {
                        ConversationCountBadge(count: conversation.unread.count)
                    } else if isPinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(Palette.paperMuted)
                            .rotationEffect(.degrees(45))
                            .accessibilityLabel("Pinned")
                    }
                }
            }
        }
        .padding(.vertical, 9)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var secondLine: some View {
        if let typist = typing.first {
            Group {
                if conversation.kind == "group" {
                    Text("\(typist) is typing…")
                } else {
                    Text("typing…")
                }
            }
            .font(.system(size: 14).italic())
            .foregroundStyle(Palette.signal)
            .lineLimit(1)
            .transition(.opacity)
        } else if let line = MessagePreviewText.line(for: conversation, viewerId: viewerId) {
            Text(verbatim: line)
                .font(.system(size: 14))
                .foregroundStyle(isUnread ? Palette.paperSubtle : Palette.paperMuted)
                .lineLimit(1)
        } else if conversation.kind == "group" {
            Text("\(conversation.participants.count + 1) people")
                .font(.system(size: 14))
                .foregroundStyle(Palette.paperMuted)
                .lineLimit(1)
        }
    }
}

/// One face for a 1:1 (with the friend's presence dot), two overlapping faces
/// for a group.
struct ConversationAvatar: View {
    let conversation: DmSummary
    var presence: String?
    var size: CGFloat = 52

    var body: some View {
        if conversation.kind == "group", conversation.participants.count > 1 {
            let small = size * 0.72
            ZStack(alignment: .topLeading) {
                face(conversation.participants[0], size: small)
                face(conversation.participants[1], size: small)
                    .overlay(Circle().strokeBorder(Palette.ink, lineWidth: 2.5).padding(-1.5))
                    .offset(x: size - small, y: size - small)
            }
            .frame(width: size, height: size, alignment: .topLeading)
        } else {
            let person = conversation.participants.first
            face(person, size: size)
                .overlay(alignment: .bottomTrailing) {
                    if let presence {
                        StatusDot(status: presence, size: size * 0.26)
                            .overlay(Circle().strokeBorder(Palette.ink, lineWidth: 2).padding(-1))
                            .accessibilityLabel(Text(verbatim: presence))
                    }
                }
        }
    }

    private func face(_ person: PublicUser?, size: CGFloat) -> some View {
        Avatar(
            name: person?.displayName ?? "?",
            seed: person?.id ?? conversation.channelId,
            size: size,
            url: person?.avatarUrl
        )
    }
}

/// The red count on a row and in the chips. Digits centred, 99+ past 99
/// (the server stops counting at 100).
struct ConversationCountBadge: View {
    let count: Int
    var compact = false

    var body: some View {
        Text(verbatim: count > 99 ? "99+" : "\(count)")
            .font(.system(size: compact ? 11 : 12, weight: .bold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .padding(.horizontal, compact ? 5 : 6)
            .frame(minWidth: compact ? 18 : 21, minHeight: compact ? 18 : 21)
            .background(Capsule().fill(Palette.danger))
    }
}

// MARK: - Empty

/// An empty list is the biggest drop-off for conversations, so it points at
/// people: add a friend, bring somebody to pqp, or say hi to a friend you
/// already have.
struct ConversationsEmptyHero: View {
    let friends: [Friend]
    let shareURL: URL
    let opening: String?
    let onAddFriend: () -> Void
    let onSayHi: (Friend) -> Void

    var body: some View {
        VStack(spacing: 14) {
            faces
                .padding(.bottom, 4)

            Text("Your conversations live here")
                .font(Typography.title(22))
                .foregroundStyle(Palette.paper)
                .multilineTextAlignment(.center)

            Text("Say hi to someone and the conversation stays in this list, always one tap away.")
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)

            Button(action: onAddFriend) {
                Label("Add friend", systemImage: "person.badge.plus")
            }
            .buttonStyle(PrimaryButtonStyle())
            .padding(.top, 6)
            .accessibilityIdentifier("conversas.empty.addFriend")

            ShareLink(item: shareURL) {
                Label("Bring someone to pqp", systemImage: "link")
            }
            .buttonStyle(SecondaryButtonStyle())
            .accessibilityIdentifier("conversas.empty.invite")

            if !friends.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    SectionLabel(text: String(localized: "Friends"))
                    ForEach(friends.prefix(5)) { friend in
                        HStack(spacing: 12) {
                            Avatar(name: friend.displayName, seed: friend.id, size: 40, url: friend.avatarUrl)
                                .overlay(alignment: .bottomTrailing) {
                                    StatusDot(status: friend.status, size: 11)
                                }
                            VStack(alignment: .leading, spacing: 1) {
                                Text(friend.displayName)
                                    .font(Typography.bodyMedium)
                                    .foregroundStyle(Palette.paper)
                                    .lineLimit(1)
                                if let tag = friend.tag {
                                    Text(verbatim: tag)
                                        .font(Typography.caption)
                                        .foregroundStyle(Palette.paperMuted)
                                        .lineLimit(1)
                                }
                            }
                            Spacer(minLength: 0)
                            Button {
                                onSayHi(friend)
                            } label: {
                                if opening == friend.id {
                                    ProgressView().tint(Palette.signal)
                                } else {
                                    Text("Say hi")
                                        .font(Typography.caption)
                                        .foregroundStyle(Palette.paper)
                                }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(Capsule().fill(Palette.surfaceRaised))
                            .buttonStyle(.plain)
                            .disabled(opening != nil)
                        }
                    }
                }
                .padding(14)
                .pqpSurface()
                .padding(.top, 8)
            }
        }
        .padding(.horizontal, 24)
    }

    private var faces: some View {
        let shown = Array(friends.prefix(3))
        return HStack(spacing: -14) {
            if shown.isEmpty {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: 30, weight: .medium))
                    .foregroundStyle(Palette.signal)
                    .frame(width: 64, height: 64)
                    .background(Circle().fill(Palette.surfaceRaised))
            } else {
                ForEach(shown) { friend in
                    Avatar(name: friend.displayName, seed: friend.id, size: 56, url: friend.avatarUrl)
                        .overlay(Circle().strokeBorder(Palette.ink, lineWidth: 3).padding(-1.5))
                }
            }
        }
        .accessibilityHidden(true)
    }
}

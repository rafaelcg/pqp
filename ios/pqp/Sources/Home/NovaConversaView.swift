import SwiftUI

/// Nova conversa: people first, typing only when you need it.
///
/// Drawn with `conversations_home` on (the old search-only sheet is
/// `NewConversationView`). Friends online now, then the rest of your friends,
/// then people from recent 1:1s, before anything is typed. Tapping a name
/// opens the conversation straight away; "Create group" turns the rows into
/// ticks, and the button at the bottom makes the group. The search still
/// takes a full `name#0000`, for somebody who is not on any of these lists.
struct NovaConversaView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss

    /// Online first (`FriendsDigest.onlineFirst`).
    let friends: [Friend]
    var recent: [PublicUser] = []
    let onOpened: (DmSummary) -> Void
    /// Nil hides the Add friend row (nowhere to send it).
    var onAddFriend: (() -> Void)?

    @State private var query = ""
    @State private var results: [PublicUser] = []
    @State private var searching = false
    @State private var searchTask: Task<Void, Never>?
    @State private var picking = false
    @State private var selected: [PublicUser] = []
    @State private var opening: String?
    @State private var error: String?

    /// The server's cap on a group conversation, the viewer excluded.
    static let maxPeople = 9

    private var online: [Friend] { friends.filter { $0.status != "offline" } }
    private var offline: [Friend] { friends.filter { $0.status == "offline" } }

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces) }

    private var looksLikeTag: Bool {
        trimmedQuery.contains("#") && trimmedQuery.split(separator: "#").count == 2
    }

    /// Everybody already on this sheet that matches what was typed.
    private var localMatches: [PublicUser] {
        let people = friends.map(\.asPublicUser) + recent
        return people.filter { person in
            let needle = ConversationList.fold(trimmedQuery)
            return ConversationList.fold(person.displayName).contains(needle)
                || (person.username.map { ConversationList.fold($0).contains(needle) } ?? false)
                || (person.tag.map { ConversationList.fold($0).contains(needle) } ?? false)
        }
    }

    /// Search results from across pqp, minus the ones already listed above.
    private var remoteOnly: [PublicUser] {
        let shown = Set(localMatches.map(\.id))
        return results.filter { !shown.contains($0.id) && $0.id != session.currentUser?.id }
    }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                Palette.ink.ignoresSafeArea()

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        if let error {
                            Text(error)
                                .font(Typography.callout)
                                .foregroundStyle(Palette.danger)
                                .padding(.vertical, 6)
                        }
                        if trimmedQuery.isEmpty {
                            actions
                            section("Online now", people: online.map(\.asPublicUser), status: statusById)
                            section("Friends", people: offline.map(\.asPublicUser), status: statusById)
                            section("Recent", people: recent, status: [:])
                            if friends.isEmpty && recent.isEmpty {
                                Text("No friends here yet. Search for someone by name or name#0000 above.")
                                    .font(Typography.callout)
                                    .foregroundStyle(Palette.paperMuted)
                                    .padding(.top, 18)
                            }
                        } else {
                            section("Friends", people: localMatches, status: statusById)
                            if searching {
                                ProgressView().tint(Palette.signal)
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 16)
                            } else if !remoteOnly.isEmpty {
                                section("On pqp", people: remoteOnly, status: [:])
                            } else if localMatches.isEmpty && trimmedQuery.count >= 2 {
                                Text(looksLikeTag
                                     ? String(localized: "No one with that tag.")
                                     : String(localized: "No matches. Try their full handle, like name#1234."))
                                    .font(Typography.callout)
                                    .foregroundStyle(Palette.paperMuted)
                                    .padding(.top, 18)
                            }
                        }
                    }
                    .padding(.horizontal, Metrics.hPadding)
                    .padding(.bottom, picking ? 96 : 24)
                }

                if picking {
                    groupButton
                        .padding(.horizontal, Metrics.hPadding)
                        .padding(.bottom, 12)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(Motion.standard, value: picking)
            .navigationTitle("New conversation")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: Text("Search by name or name#0000")
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .onChange(of: query) { _, value in scheduleSearch(value) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .tint(Palette.paperMuted)
                        .accessibilityLabel("Close")
                }
            }
        }
        .presentationDragIndicator(.visible)
    }

    private var statusById: [String: String] {
        Dictionary(friends.map { ($0.id, $0.status) }, uniquingKeysWith: { first, _ in first })
    }

    // MARK: - Pieces

    @ViewBuilder
    private var actions: some View {
        Button {
            withAnimation(Motion.standard) {
                picking.toggle()
                if !picking { selected = [] }
            }
        } label: {
            actionRow(
                systemImage: "person.2.fill",
                title: picking ? String(localized: "Pick people") : String(localized: "Create group"),
                subtitle: String(localized: "up to \(Self.maxPeople) people"),
                highlighted: true
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("nova.group")

        if let onAddFriend {
            Button {
                dismiss()
                onAddFriend()
            } label: {
                actionRow(systemImage: "person.badge.plus", title: String(localized: "Add friend"), subtitle: nil, highlighted: false)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("nova.addFriend")
        }
    }

    private func actionRow(systemImage: String, title: String, subtitle: String?, highlighted: Bool) -> some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(highlighted ? Palette.signal : Palette.paper)
                .frame(width: 48, height: 48)
                .background(Circle().fill(highlighted ? Palette.signal.opacity(0.14) : Palette.surfaceRaised))
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: title)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                if let subtitle {
                    Text(verbatim: subtitle)
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func section(_ title: LocalizedStringKey, people: [PublicUser], status: [String: String]) -> some View {
        if !people.isEmpty {
            Text(title)
                .font(Typography.label)
                .tracking(1.2)
                .textCase(.uppercase)
                .foregroundStyle(Palette.paperMuted)
                .padding(.top, 16)
                .padding(.bottom, 4)
            ForEach(people) { person in
                Button {
                    tap(person)
                } label: {
                    personRow(person, status: status[person.id])
                }
                .buttonStyle(.plain)
                .disabled(opening != nil)
                .accessibilityIdentifier("nova.person.\(person.id)")
            }
        }
    }

    private func personRow(_ person: PublicUser, status: String?) -> some View {
        let isSelected = selected.contains { $0.id == person.id }
        return HStack(spacing: 14) {
            Avatar(name: person.displayName, seed: person.id, size: 48, url: person.avatarUrl)
                .overlay(alignment: .bottomTrailing) {
                    if let status {
                        StatusDot(status: status, size: 13)
                            .overlay(Circle().strokeBorder(Palette.ink, lineWidth: 2).padding(-1))
                    }
                }
            VStack(alignment: .leading, spacing: 1) {
                Text(person.displayName)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                if let tag = person.tag {
                    Text(verbatim: tag)
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if opening == person.id {
                ProgressView().tint(Palette.signal)
            } else if picking {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22))
                    .foregroundStyle(isSelected ? Palette.signal : Palette.border)
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    private var groupButton: some View {
        Button {
            Task { await open(selected) }
        } label: {
            Text(selected.count <= 1
                 ? String(localized: "Open conversation")
                 : String(localized: "Create group (\(selected.count))"))
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(selected.isEmpty || opening != nil)
        .accessibilityIdentifier("nova.openSelected")
    }

    // MARK: - Actions

    private func tap(_ person: PublicUser) {
        error = nil
        guard picking else {
            Task { await open([person]) }
            return
        }
        if let index = selected.firstIndex(where: { $0.id == person.id }) {
            selected.remove(at: index)
        } else if selected.count < Self.maxPeople {
            selected.append(person)
        } else {
            error = String(localized: "A group conversation tops out at nine people.")
        }
    }

    private func open(_ people: [PublicUser]) async {
        guard !people.isEmpty else { return }
        opening = people.first?.id
        defer { opening = nil }
        do {
            let conversation = try await session.api.openConversation(userIds: people.map(\.id))
            onOpened(conversation)
            dismiss()
        } catch {
            // Usually a privacy setting or a block; the server's sentence is
            // better than anything invented here.
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Debounced, like the old sheet: user search is the tightest-budgeted
    /// route on the server.
    private func scheduleSearch(_ value: String) {
        searchTask?.cancel()
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else {
            results = []
            searching = false
            return
        }
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            searching = true
            defer { searching = false }
            do {
                if trimmed.contains("#"), trimmed.split(separator: "#").count == 2 {
                    results = [try await session.api.lookupUser(tag: trimmed)]
                } else {
                    results = try await session.api.searchUsers(query: trimmed)
                }
            } catch APIError.notFound {
                results = []
            } catch {
                guard !Task.isCancelled else { return }
                results = []
            }
        }
    }
}

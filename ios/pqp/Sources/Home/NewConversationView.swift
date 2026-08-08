import SwiftUI

/// Start a direct message.
///
/// Two ways in, mirroring the server's two lookup paths: a prefix search over
/// handles, and an exact `name#1234` lookup. The exact form matters because
/// prefix search is deliberately rate-limited and enumerable-by-design-only up
/// to a point — if you already know someone's full tag you should not have to
/// go fishing for it.
struct NewConversationView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let onOpened: (DmSummary) -> Void

    @State private var query = ""
    @State private var results: [PublicUser] = []
    @State private var searching = false
    @State private var opening: String?
    @State private var error: String?
    @State private var searchTask: Task<Void, Never>?
    /// Picking more than one person opens a group conversation. The server caps
    /// it at nine, so the button says so rather than failing at ten.
    @State private var selected: [PublicUser] = []
    /// Offered before anything is typed. A friend is the person you are most
    /// likely to be messaging, and the server already lets a friend through a
    /// `server_members` DM privacy setting — so these are the names least
    /// likely to end in a refusal.
    @State private var friends: [Friend] = []
    @State private var hasLoadedFriends = false

    private var looksLikeTag: Bool {
        query.contains("#") && query.split(separator: "#").count == 2
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                VStack(spacing: 12) {
                    searchField

                    if let error {
                        Text(error)
                            .font(Typography.callout)
                            .foregroundStyle(Palette.danger)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, Metrics.hPadding)
                    }

                    if searching {
                        ProgressView().tint(Palette.signal).padding(.top, 20)
                    } else if query.isEmpty && !suggestions.isEmpty {
                        SectionLabel(text: String(localized: "Friends"))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, Metrics.hPadding)
                    } else if query.isEmpty && hasLoadedFriends {
                        // The hole this fills: with no friends and no query, every
                        // other branch here was false, so a brand-new account
                        // opened this sheet onto a search field above a void — no
                        // copy, no hint that a full `name#1234` is what the field
                        // wants, and nothing saying why the list was empty.
                        Text("No friends yet. Search a full handle like name#1234, or add someone from Friends first.")
                            .font(Typography.callout)
                            .foregroundStyle(Palette.paperMuted)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                            .padding(.top, 20)
                    } else if results.isEmpty && !query.isEmpty {
                        Text(looksLikeTag
                             ? String(localized: "No one with that tag.")
                             : String(localized: "No matches. Try their full handle, like name#1234."))
                            .font(Typography.callout)
                            .foregroundStyle(Palette.paperMuted)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                            .padding(.top, 20)
                    }

                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(query.isEmpty ? suggestions : results) { user in
                                Button {
                                    toggle(user)
                                } label: {
                                    UserRow(
                                        user: user,
                                        isBusy: opening == user.id,
                                        isSelected: selected.contains { $0.id == user.id }
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, Metrics.hPadding)
                    }

                    if !selected.isEmpty {
                        Button(startLabel) { Task { await openSelected() } }
                            .buttonStyle(PrimaryButtonStyle())
                            .padding(.horizontal, Metrics.hPadding)
                            .padding(.bottom, 10)
                    }

                    Spacer(minLength: 0)
                }
                .padding(.top, 8)
            }
            .navigationTitle("New message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }.tint(Palette.paperMuted)
                }
            }
            // Failing this leaves the search box, which is the whole screen —
            // so it is deliberately not surfaced as an error. The flag is what
            // keeps the "no friends yet" line from flashing up before the read
            // has come back, which would say something false for a moment to
            // everybody who does have friends.
            .task {
                friends = (try? await session.api.friends())?.friends ?? []
                hasLoadedFriends = true
            }
        }
    }

    /// Friends, online first, as the pre-search list. Anyone already picked
    /// stays in the list so the checkmark has somewhere to live.
    private var suggestions: [PublicUser] {
        FriendsDigest.onlineFirst(friends).map(\.asPublicUser)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Palette.paperMuted)
            TextField("Search by handle", text: $query)
                .textFieldStyle(.plain)
                .foregroundStyle(Palette.paper)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .onChange(of: query) { _, value in scheduleSearch(value) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .pqpSurface(cornerRadius: 20)
        .padding(.horizontal, Metrics.hPadding)
    }

    /// Debounced. User search is the tightest-budgeted endpoint on the server —
    /// it answers questions about people you have no relationship with — so a
    /// request per keystroke would be rate-limited within a word.
    private func scheduleSearch(_ value: String) {
        searchTask?.cancel()
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else {
            results = []
            error = nil
            return
        }
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await search(trimmed)
        }
    }

    private func search(_ term: String) async {
        searching = true
        error = nil
        do {
            if looksLikeTag {
                let user = try await session.api.lookupUser(tag: term)
                results = [user]
            } else {
                results = try await session.api.searchUsers(query: term)
            }
        } catch let apiError as APIError {
            // A tag that matches nobody is a 404, which is an answer rather
            // than a failure — showing it as an error would be wrong.
            if case .notFound = apiError {
                results = []
            } else {
                error = apiError.errorDescription
            }
        } catch {
            self.error = error.localizedDescription
        }
        searching = false
    }

    private var startLabel: String {
        selected.count == 1
            ? String(localized: "Message \(selected[0].displayName)")
            : String(localized: "Start group with \(selected.count)")
    }

    private func toggle(_ user: PublicUser) {
        if let index = selected.firstIndex(where: { $0.id == user.id }) {
            selected.remove(at: index)
        } else if selected.count < 9 {
            selected.append(user)
        } else {
            error = String(localized: "A group conversation tops out at nine people.")
        }
    }

    private func openSelected() async {
        guard !selected.isEmpty else { return }
        opening = selected.first?.id
        defer { opening = nil }
        do {
            let conversation = try await session.api.openConversation(
                userIds: selected.map(\.id)
            )
            onOpened(conversation)
            dismiss()
        } catch {
            // The refusal here is usually a privacy setting or a block, and the
            // server's own wording is better than anything invented locally.
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

private struct UserRow: View {
    let user: PublicUser
    let isBusy: Bool
    var isSelected: Bool = false

    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: user.displayName, seed: user.id, size: 40, url: user.avatarUrl)
            VStack(alignment: .leading, spacing: 2) {
                Text(user.displayName)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                if let tag = user.tag {
                    Text(tag)
                        .font(Typography.mono)
                        .foregroundStyle(Palette.paperMuted)
                }
            }
            Spacer()
            if isBusy {
                ProgressView().tint(Palette.signal)
            } else if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Palette.signal)
            }
        }
        .padding(12)
        .pqpSurface()
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .strokeBorder(isSelected ? Palette.signal : .clear, lineWidth: 1.5)
        )
    }
}

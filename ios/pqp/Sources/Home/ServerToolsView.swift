import SwiftUI

/// Invite people to a server.
///
/// Invites are manager-only server-side, so a member sees the refusal rather
/// than a broken screen — the API is the authority and the UI does not
/// second-guess it.
struct InviteView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let server: Server

    @State private var invites: [Invite] = []
    @State private var loading = true
    @State private var creating = false
    @State private var error: String?
    @State private var copied: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                VStack(spacing: 12) {
                    if loading {
                        ProgressView().tint(Palette.signal).padding(.top, 40)
                    } else if let error {
                        EmptyState(
                            icon: "exclamationmark.triangle",
                            title: "Can't manage invites",
                            message: LocalizedStringKey(error)
                        )
                    } else if invites.isEmpty {
                        EmptyState(
                            icon: "person.badge.plus",
                            title: "No invites yet",
                            message: "Create one and share the code with whoever you want in.",
                            actionTitle: "Create invite",
                            action: { Task { await create() } }
                        )
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 10) {
                                ForEach(invites) { invite in
                                    InviteRow(invite: invite, copied: copied == invite.code) {
                                        UIPasteboard.general.string = invite.code
                                        copied = invite.code
                                    }
                                }
                            }
                            .padding(.horizontal, Metrics.hPadding)
                            .padding(.top, 8)
                        }

                        Button(creating ? "Creating…" : "Create another") {
                            Task { await create() }
                        }
                        .buttonStyle(SecondaryButtonStyle())
                        .disabled(creating)
                        .padding(.horizontal, Metrics.hPadding)
                        .padding(.bottom, 12)
                    }
                }
            }
            .navigationTitle("Invite to \(server.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }.tint(Palette.paperMuted)
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        loading = true
        do {
            invites = try await session.api.invites(serverId: server.id)
            error = nil
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        loading = false
    }

    private func create() async {
        creating = true
        do {
            let invite = try await session.api.createInvite(serverId: server.id)
            invites.insert(invite, at: 0)
            error = nil
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        creating = false
    }
}

private struct InviteRow: View {
    let invite: Invite
    let copied: Bool
    let onCopy: () -> Void

    private var usage: String {
        guard let maxUses = invite.maxUses else { return "\(invite.uses) uses" }
        return "\(invite.uses)/\(maxUses) uses"
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(invite.code)
                    .font(Typography.mono)
                    .foregroundStyle(Palette.paper)
                HStack(spacing: 6) {
                    Text(usage)
                    if let expiry = invite.expiresAt {
                        Text("· expires \(expiry, format: .relative(presentation: .named))")
                    }
                }
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
            }
            Spacer()
            Button(copied ? "Copied" : "Copy", action: onCopy)
                .font(Typography.caption)
                .foregroundStyle(Palette.signal)
        }
        .padding(14)
        .pqpSurface()
    }
}

/// Messages someone pinned in this channel.
struct PinnedMessagesView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let channelId: String

    @State private var messages: [Message] = []
    @State private var loading = true

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                if loading {
                    ProgressView().tint(Palette.signal)
                } else if messages.isEmpty {
                    EmptyState(
                        icon: "pin",
                        title: "Nothing pinned",
                        message: "Long-press a message and pin it to keep it here."
                    )
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 6) {
                            ForEach(messages) { message in
                                MessageRow(message: message, isGrouped: false)
                            }
                        }
                        .padding(.horizontal, Metrics.hPadding)
                        .padding(.top, 8)
                    }
                }
            }
            .navigationTitle("Pinned")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }.tint(Palette.paperMuted)
                }
            }
            .task {
                messages = (try? await session.api.pinnedMessages(channelId: channelId)) ?? []
                loading = false
            }
        }
    }
}

/// Message search across a server.
struct SearchView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let server: Server

    @State private var query = ""
    @State private var results: [SearchResult] = []
    @State private var searching = false
    @State private var searched = false
    @State private var error: String?
    @State private var task: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                VStack(spacing: 12) {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(Palette.paperMuted)
                        TextField("Search messages", text: $query)
                            .textFieldStyle(.plain)
                            .foregroundStyle(Palette.paper)
                            .submitLabel(.search)
                            .onChange(of: query) { _, value in schedule(value) }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .pqpSurface(cornerRadius: 20)
                    .padding(.horizontal, Metrics.hPadding)

                    if searching {
                        ProgressView().tint(Palette.signal).padding(.top, 20)
                    } else if let error {
                        Text(error)
                            .font(Typography.callout)
                            .foregroundStyle(Palette.danger)
                    } else if searched && results.isEmpty {
                        Text("No messages match that.")
                            .font(Typography.callout)
                            .foregroundStyle(Palette.paperMuted)
                            .padding(.top, 20)
                    }

                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(results) { result in
                                SearchResultRow(result: result)
                            }
                        }
                        .padding(.horizontal, Metrics.hPadding)
                    }

                    Spacer(minLength: 0)
                }
                .padding(.top, 8)
            }
            .navigationTitle("Search \(server.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }.tint(Palette.paperMuted)
                }
            }
        }
    }

    /// Debounced for the same reason as user search: one query ranks every
    /// visible message in the server, and the budget is per-second.
    private func schedule(_ value: String) {
        task?.cancel()
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else {
            results = []
            searched = false
            return
        }
        task = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await run(trimmed)
        }
    }

    private func run(_ term: String) async {
        searching = true
        error = nil
        do {
            results = try await session.api.searchMessages(serverId: server.id, query: term).results
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        searched = true
        searching = false
    }
}

private struct SearchResultRow: View {
    let result: SearchResult

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text("#\(result.channelName)")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.signal)
                Text(result.authorName)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                Spacer()
                Text(result.createdAt, format: .dateTime.day().month())
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            }

            // The server marks matches with control characters rather than
            // markup; they are turned into styling here and never rendered.
            result.runs.reduce(Text("")) { partial, run in
                partial + Text(run.text)
                    .foregroundColor(run.isMatch ? Palette.signal : Palette.paper)
                    .fontWeight(run.isMatch ? .semibold : .regular)
            }
            .font(Typography.callout)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .pqpSurface()
    }
}

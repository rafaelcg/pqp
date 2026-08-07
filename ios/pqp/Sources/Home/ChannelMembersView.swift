import SwiftUI

/// Who can see a private channel.
///
/// Only meaningful for private channels — a public one is visible to the whole
/// server and has no allowlist, which is why this is offered nowhere else.
struct ChannelMembersView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let channel: Channel
    let server: Server

    @State private var allowed: [PublicUser] = []
    @State private var candidates: [ServerMember] = []
    @State private var loading = true
    @State private var error: String?

    private var allowedIds: Set<String> { Set(allowed.map(\.id)) }

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                if loading {
                    ProgressView().tint(Palette.signal)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            if let error {
                                Text(error)
                                    .font(Typography.callout)
                                    .foregroundStyle(Palette.danger)
                            }

                            SectionLabel(text: "Can see this channel")
                                .padding(.horizontal, 4)
                            if allowed.isEmpty {
                                Text("Only people with a role that grants access.")
                                    .font(Typography.callout)
                                    .foregroundStyle(Palette.paperMuted)
                                    .padding(.horizontal, 4)
                            }
                            ForEach(allowed) { user in
                                row(name: user.displayName, seed: user.id, action: "Remove") {
                                    Task { await remove(user.id) }
                                }
                            }

                            SectionLabel(text: "Add from server")
                                .padding(.horizontal, 4)
                                .padding(.top, 10)
                            ForEach(candidates.filter { !allowedIds.contains($0.id) }) { member in
                                row(name: member.displayName, seed: member.id, action: "Add") {
                                    Task { await add(member.id) }
                                }
                            }
                        }
                        .padding(.horizontal, Metrics.hPadding)
                        .padding(.top, 8)
                    }
                }
            }
            .navigationTitle("#\(channel.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }.tint(Palette.paperMuted)
                }
            }
            .task { await load() }
        }
    }

    private func row(
        name: String,
        seed: String,
        action: String,
        perform: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 12) {
            Avatar(name: name, seed: seed, size: 36)
            Text(name).font(Typography.bodyMedium).foregroundStyle(Palette.paper)
            Spacer()
            Button(action, action: perform)
                .font(Typography.caption)
                .foregroundStyle(action == "Remove" ? Palette.danger : Palette.signal)
        }
        .padding(12)
        .pqpSurface()
    }

    private func load() async {
        loading = true
        allowed = (try? await session.api.channelMembers(channelId: channel.id)) ?? []
        candidates = (try? await session.api.members(serverId: server.id)) ?? []
        loading = false
    }

    private func add(_ userId: String) async {
        do {
            try await session.api.addChannelMember(channelId: channel.id, userId: userId)
            await load()
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func remove(_ userId: String) async {
        do {
            try await session.api.removeChannelMember(channelId: channel.id, userId: userId)
            allowed.removeAll { $0.id == userId }
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

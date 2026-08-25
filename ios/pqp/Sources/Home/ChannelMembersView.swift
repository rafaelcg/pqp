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

                            SectionLabel(text: String(localized: "Can see this channel"))
                                .padding(.horizontal, 4)
                            if allowed.isEmpty {
                                Text("Only people with a role that grants access.")
                                    .font(Typography.callout)
                                    .foregroundStyle(Palette.paperMuted)
                                    .padding(.horizontal, 4)
                            }
                            ForEach(allowed) { user in
                                row(name: user.displayName, seed: user.id,
                                    avatarUrl: user.avatarUrl, removes: true) {
                                    Task { await remove(user.id) }
                                }
                            }

                            SectionLabel(text: String(localized: "Add from the community"))
                                .padding(.horizontal, 4)
                                .padding(.top, 10)
                            ForEach(candidates.filter { !allowedIds.contains($0.id) }) { member in
                                row(name: member.displayName, seed: member.id,
                                    avatarUrl: member.avatarUrl, removes: false) {
                                    Task { await add(member.id) }
                                }
                            }
                        }
                        .padding(.horizontal, Metrics.hPadding)
                        .padding(.top, 8)
                    }
                }
            }
            .navigationTitle(Text(verbatim: "#\(channel.name)"))
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
        avatarUrl: String? = nil,
        removes: Bool,
        perform: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 12) {
            Avatar(name: name, seed: seed, size: 36, url: avatarUrl)
            Text(name).font(Typography.bodyMedium).foregroundStyle(Palette.paper)
            Spacer()
            // Resolved here rather than passed in as copy: a localised title
            // cannot also be the flag that picks the tint, which is what
            // comparing it against "Remove" quietly relied on.
            Button(removes ? String(localized: "Remove") : String(localized: "Add"),
                   action: perform)
                .font(Typography.caption)
                .foregroundStyle(removes ? Palette.danger : Palette.signal)
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

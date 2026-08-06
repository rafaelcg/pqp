import SwiftUI

/// Members, with moderation for anyone who can moderate.
///
/// Every destructive action is offered only where the server would allow it —
/// an owner cannot be kicked, you cannot act on yourself, and a plain member
/// sees a roster with no actions at all. The server enforces all of this
/// anyway; the UI matching it is about not offering something that will fail.
struct MembersView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let server: Server

    @State private var members: [ServerMember] = []
    @State private var bans: [ServerBan] = []
    @State private var loading = true
    @State private var error: String?
    @State private var showingBans = false

    private var canModerate: Bool { server.role == "owner" || server.role == "admin" }
    private var isOwner: Bool { server.role == "owner" }

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                if loading {
                    ProgressView().tint(Palette.signal)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            if let error {
                                Text(error)
                                    .font(Typography.callout)
                                    .foregroundStyle(Palette.danger)
                                    .padding(.bottom, 4)
                            }
                            ForEach(members) { member in
                                MemberRow(member: member)
                                    .contextMenu { actions(for: member) }
                            }
                        }
                        .padding(.horizontal, Metrics.hPadding)
                        .padding(.top, 8)
                    }
                }
            }
            .navigationTitle("Members")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }.tint(Palette.paperMuted)
                }
                if canModerate {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Bans") { showingBans = true }.tint(Palette.signal)
                    }
                }
            }
            .sheet(isPresented: $showingBans) {
                BanListView(server: server)
            }
            .task { await load() }
        }
    }

    @ViewBuilder
    private func actions(for member: ServerMember) -> some View {
        // Acting on yourself, or on the owner, is always refused server-side.
        if canModerate, member.id != session.currentUser?.id, member.role != "owner" {
            if isOwner {
                Button {
                    Task { await setRole(member, to: member.role == "admin" ? "member" : "admin") }
                } label: {
                    Label(
                        member.role == "admin" ? "Demote to member" : "Promote to admin",
                        systemImage: member.role == "admin" ? "arrow.down.circle" : "arrow.up.circle"
                    )
                }
            }

            Button(role: .destructive) {
                Task { await remove(member, ban: false) }
            } label: {
                Label("Kick", systemImage: "person.fill.xmark")
            }

            Button(role: .destructive) {
                Task { await remove(member, ban: true) }
            } label: {
                Label("Ban", systemImage: "hand.raised.fill")
            }
        }
    }

    private func load() async {
        loading = true
        members = (try? await session.api.members(serverId: server.id)) ?? []
        loading = false
    }

    private func setRole(_ member: ServerMember, to role: String) async {
        do {
            try await session.api.setMemberRole(serverId: server.id, userId: member.id, role: role)
            await load()
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func remove(_ member: ServerMember, ban: Bool) async {
        do {
            try await session.api.removeMember(serverId: server.id, userId: member.id, ban: ban)
            members.removeAll { $0.id == member.id }
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

private struct MemberRow: View {
    let member: ServerMember

    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: member.displayName, seed: member.id, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(member.displayName)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                if let tag = member.tag {
                    Text(tag).font(Typography.mono).foregroundStyle(Palette.paperMuted)
                }
            }
            Spacer()
            if member.role != "member" {
                Text(member.role.uppercased())
                    .font(Typography.label)
                    .tracking(1)
                    .foregroundStyle(member.role == "owner" ? Palette.signal : Palette.paperMuted)
            }
        }
        .padding(12)
        .pqpSurface()
    }
}

struct BanListView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let server: Server

    @State private var bans: [ServerBan] = []
    @State private var loading = true

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()
                if loading {
                    ProgressView().tint(Palette.signal)
                } else if bans.isEmpty {
                    EmptyState(
                        icon: "hand.raised",
                        title: "Nobody is banned",
                        message: "Banned people can't rejoin, even with a valid invite."
                    )
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(bans) { ban in
                                HStack(spacing: 12) {
                                    Avatar(name: ban.displayName ?? "?", seed: ban.userId, size: 40)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(ban.displayName ?? "Unknown")
                                            .font(Typography.bodyMedium)
                                            .foregroundStyle(Palette.paper)
                                        if let reason = ban.reason {
                                            Text(reason)
                                                .font(Typography.caption)
                                                .foregroundStyle(Palette.paperMuted)
                                                .lineLimit(2)
                                        }
                                    }
                                    Spacer()
                                    Button("Unban") {
                                        Task {
                                            try? await session.api.unban(
                                                serverId: server.id, userId: ban.userId
                                            )
                                            await load()
                                        }
                                    }
                                    .font(Typography.caption)
                                    .foregroundStyle(Palette.signal)
                                }
                                .padding(12)
                                .pqpSurface()
                            }
                        }
                        .padding(.horizontal, Metrics.hPadding)
                        .padding(.top, 8)
                    }
                }
            }
            .navigationTitle("Bans")
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
        bans = (try? await session.api.bans(serverId: server.id)) ?? []
        loading = false
    }
}

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
    @State private var timeouts: [String: MemberTimeout] = [:]
    @State private var loading = true
    @State private var error: String?
    @State private var showingBans = false
    @State private var reportTarget: ReportTarget?
    @State private var profileSubject: ProfileSubject?

    /// The same ladder the web offers; any value in range is legal, these are
    /// just the rungs worth a menu row.
    private let timeoutPresets: [(minutes: Int, label: LocalizedStringKey)] = [
        (5, "5 minutes"),
        (60, "1 hour"),
        (60 * 24, "1 day"),
        (60 * 24 * 7, "1 week"),
    ]

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
                                // Tap opens the person, long-press is still the
                                // moderation menu. The roster was previously a
                                // list you could only *look* at unless you were
                                // a moderator, which is where "how do I add
                                // someone to my friends" dead-ended.
                                Button {
                                    profileSubject = ProfileSubject(member: member)
                                } label: {
                                    MemberRow(member: member, isTimedOut: timeouts[member.id] != nil)
                                }
                                .buttonStyle(.plain)
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
            .sheet(item: $reportTarget) { target in
                ReportSheet(target: target)
            }
            .sheet(item: $profileSubject) { subject in
                // No `onOpenConversation`: this sheet sits on a modal with no
                // navigation stack of its own to push a chat onto. The profile
                // dismisses itself either way, and the DM is one tap away in
                // the Messages tab — offering a push that silently did nothing
                // would be worse than not offering it here.
                UserProfileSheet(subject: subject)
            }
            .task { await load() }
        }
    }

    @ViewBuilder
    private func actions(for member: ServerMember) -> some View {
        // Reporting is for everyone — it is how a plain member reaches the
        // moderators at all.
        if member.id != session.currentUser?.id {
            Button {
                reportTarget = .user(id: member.id, displayName: member.displayName, serverId: server.id)
            } label: {
                Label("Report", systemImage: "flag")
            }
        }

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

            // Timeout is the middle rung: below it a deleted message, above it
            // the kick/ban pair. Lift is offered when one is running.
            if timeouts[member.id] != nil {
                Button {
                    Task { await lift(member) }
                } label: {
                    Label("Lift timeout", systemImage: "clock.arrow.circlepath")
                }
            } else {
                Menu {
                    ForEach(timeoutPresets, id: \.minutes) { preset in
                        Button(preset.label) {
                            Task { await timeout(member, minutes: preset.minutes) }
                        }
                    }
                } label: {
                    Label("Timeout…", systemImage: "clock.badge.exclamationmark")
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
        if canModerate, let active = try? await session.api.activeTimeouts(serverId: server.id) {
            timeouts = Dictionary(uniqueKeysWithValues: active.map { ($0.userId, $0) })
        }
        loading = false
    }

    private func timeout(_ member: ServerMember, minutes: Int) async {
        do {
            try await session.api.issueTimeout(
                serverId: server.id, userId: member.id, minutes: minutes, reason: nil
            )
            await load()
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func lift(_ member: ServerMember) async {
        do {
            try await session.api.liftTimeout(serverId: server.id, userId: member.id)
            await load()
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
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

/// The status dot, everywhere one appears. One view so "which colour is idle"
/// has exactly one answer.
struct StatusDot: View {
    let status: String?
    var size: CGFloat = 9

    private var color: Color {
        switch status {
        case "online": Palette.success
        case "idle": Palette.warning
        case "dnd": Palette.danger
        default: Palette.border
        }
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .overlay(Circle().strokeBorder(Palette.inkDeep, lineWidth: 1.5))
    }
}

private struct MemberRow: View {
    let member: ServerMember
    var isTimedOut = false

    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: member.displayName, seed: member.id, size: 40, url: member.avatarUrl)
                .overlay(alignment: .bottomTrailing) {
                    StatusDot(status: member.status)
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(member.displayName)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                if let tag = member.tag {
                    Text(tag).font(Typography.mono).foregroundStyle(Palette.paperMuted)
                }
            }
            Spacer()
            if isTimedOut {
                Image(systemName: "clock.badge.exclamationmark")
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.warning)
                    .accessibilityLabel("Timed out")
            }
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

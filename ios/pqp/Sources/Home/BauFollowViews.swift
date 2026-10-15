import SwiftUI

// SEGUIR, the screens. The rules and the wire live in `Core/BauFollow.swift`.
//
// Three places, as on the web:
//  - the Baú's toolbar: a Seguir / Seguindo button while the source is
//    followable, and for whoever manages the server a menu with the follower
//    list and the owner's "Permitir seguir" switch;
//  - the sheet that sets a follow up (server, channel, an optional role to
//    mention) and lists what the viewer already follows of this Baú;
//  - a destination channel's own list, from the channel's menu.

// MARK: - Entry point on the Baú screen

extension View {
    /// Adds Seguir to a Baú screen's toolbar. Asks the server whether this Baú
    /// is followable (the per-source flag `bau_follow`, the owner's switch) and
    /// draws nothing until it says yes; a failed read is "not followable", a
    /// button that cannot be trusted being better absent.
    func bauFollowEntry(server: Server) -> some View {
        modifier(BauFollowEntry(server: server))
    }
}

private struct BauFollowEntry: ViewModifier {
    @Environment(SessionStore.self) private var session
    let server: Server

    @State private var state: BauFollowState?
    @State private var permissions: PermissionsSnapshot?
    @State private var followers: BauFollowers?
    @State private var showingFollow = false
    @State private var showingFollowers = false

    private var canManageServer: Bool {
        permissions?.can(PermissionBit.manageServer) ?? false
    }

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if BauFollowRules.buttonVisible(state) {
                        let following = !(state?.mine.isEmpty ?? true)
                        Button { showingFollow = true } label: {
                            Image(systemName: following ? "bell.fill" : "bell.badge")
                        }
                        .tint(Palette.signal)
                        .accessibilityLabel(Text(following ? "Following this Baú" : "Follow this Baú"))
                        .accessibilityHint(Text("Follow this Baú into a channel of another server"))
                        .accessibilityIdentifier("bau.follow")
                    }
                    if BauFollowRules.followersMenuVisible(canManageServer: canManageServer, followers: followers) {
                        Menu {
                            Button { showingFollowers = true } label: {
                                Label("Followers", systemImage: "person.2")
                            }
                            .accessibilityIdentifier("bau.follow.followers")
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                        .tint(Palette.paperMuted)
                        .accessibilityLabel(Text("More"))
                        .accessibilityIdentifier("bau.follow.menu")
                    }
                }
            }
            .sheet(isPresented: $showingFollow) {
                BauFollowSheet(server: server) { Task { await refresh() } }
            }
            .sheet(isPresented: $showingFollowers) {
                BauFollowersSheet(server: server) { Task { await refresh() } }
            }
            .task(id: server.id) { await refresh() }
    }

    private func refresh() async {
        async let read: BauFollowState? = try? await session.api.bauFollowState(serverId: server.id)
        async let allowed: PermissionsSnapshot? = permissions == nil
            ? try? await session.api.fetchMemberPermissions(serverId: server.id) : permissions
        state = await read
        permissions = await allowed
        if canManageServer {
            followers = try? await session.api.bauFollowers(serverId: server.id)
        } else {
            followers = nil
        }
    }
}

// MARK: - The sheet that sets a follow up

@MainActor
@Observable
final class BauFollowSheetModel {
    enum Load: Equatable { case loading, ready, failed, off }

    let serverId: String
    private(set) var load: Load = .loading
    private(set) var picker: BauFollowPicker?
    private(set) var mine: [BauFollow] = []
    private(set) var isSubmitting = false
    private(set) var busyRowId: String?
    private(set) var notice: String?
    private(set) var error: String?
    /// The header re-reads its own state after every change, including a
    /// failed one: a lost response can hide a change that did commit.
    private let onChanged: @MainActor () -> Void

    init(serverId: String, onChanged: @escaping @MainActor () -> Void) {
        self.serverId = serverId
        self.onChanged = onChanged
    }

    /// A model whose lists are already there, for tests of what it offers.
    init(serverId: String, picker: BauFollowPicker?, mine: [BauFollow], load: Load = .ready) {
        self.serverId = serverId
        self.picker = picker
        self.mine = mine
        self.load = load
        onChanged = {}
    }

    func start(session: SessionStore) async {
        notice = nil
        error = nil
        async let state: BauFollowState? = try? await session.api.bauFollowState(serverId: serverId)
        await reload(session: session)
        if let fresh = await state { mine = fresh.mine }
    }

    /// The servers the viewer may follow into. A 404 is "this Baú no longer
    /// accepts follows" (the owner switched it off): said as such, and the
    /// header drops its button.
    func reload(session: SessionStore) async {
        do {
            let result = try await session.api.bauFollowDestinations(serverId: serverId)
            if var current = picker {
                current.replace(destinations: result.servers, maxPerServer: result.maxPerServer)
                picker = current
            } else {
                picker = BauFollowPicker(destinations: result.servers, maxPerServer: result.maxPerServer)
            }
            load = .ready
        } catch {
            if case .notFound = error as? APIError {
                load = .off
                onChanged()
            } else if picker == nil {
                load = .failed
            }
        }
    }

    func select(server id: String) {
        picker?.selectServer(id)
        notice = nil
        error = nil
    }

    func select(channel id: String) {
        picker?.selectChannel(id)
        notice = nil
        error = nil
    }

    func select(role id: String) { picker?.selectRole(id) }

    func submit(session: SessionStore) async {
        guard let picker, picker.canSubmit, !isSubmitting, busyRowId == nil else { return }
        isSubmitting = true
        notice = nil
        error = nil
        defer { isSubmitting = false }
        do {
            let follow = try await session.api.createBauFollow(
                serverId: serverId,
                channelId: picker.selectedChannelId,
                rolePingId: picker.selectedRoleId.isEmpty ? nil : picker.selectedRoleId
            )
            notice = String(localized: "Done. New posts will arrive in #\(follow.targetChannelName) of \(follow.targetServerName).")
        } catch {
            self.error = BauFollowFailure.from(error).message
        }
        // Either way: a lost response can hide a change that did commit.
        onChanged()
        await refresh(session: session)
    }

    func unfollow(_ follow: BauFollow, session: SessionStore) async {
        guard busyRowId == nil, !isSubmitting else { return }
        busyRowId = follow.id
        error = nil
        notice = nil
        defer { busyRowId = nil }
        do {
            try await session.api.deleteBauFollow(id: follow.id)
            mine.removeAll { $0.id == follow.id }
        } catch {
            self.error = String(localized: "That did not work. Try again.")
        }
        onChanged()
        await refresh(session: session)
    }

    func resume(_ follow: BauFollow, session: SessionStore) async {
        guard busyRowId == nil, !isSubmitting else { return }
        busyRowId = follow.id
        error = nil
        notice = nil
        defer { busyRowId = nil }
        do {
            let updated = try await session.api.resumeBauFollow(id: follow.id)
            if let index = mine.firstIndex(where: { $0.id == follow.id }) { mine[index] = updated }
        } catch {
            self.error = String(localized: "That did not work. Try again.")
        }
        onChanged()
        await refresh(session: session)
    }

    private func refresh(session: SessionStore) async {
        async let state: BauFollowState? = try? await session.api.bauFollowState(serverId: serverId)
        await reload(session: session)
        if let fresh = await state { mine = fresh.mine }
    }
}

struct BauFollowSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let server: Server
    @State private var model: BauFollowSheetModel

    init(server: Server, onChanged: @escaping @MainActor () -> Void) {
        self.server = server
        _model = State(initialValue: BauFollowSheetModel(serverId: server.id, onChanged: onChanged))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("New free posts arrive as a card in the channel you pick, signed by this community. Members-only posts never go out.")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.paperMuted)
                }

                if !model.mine.isEmpty {
                    Section("What you already follow here") {
                        ForEach(model.mine) { follow in
                            BauFollowRow(
                                follow: follow,
                                title: follow.targetServerName,
                                subtitle: "# \(follow.targetChannelName)",
                                iconName: follow.targetServerName,
                                iconUrl: nil,
                                busy: model.busyRowId != nil,
                                onUnfollow: { Task { await model.unfollow(follow, session: session) } },
                                onResume: { Task { await model.resume(follow, session: session) } }
                            )
                        }
                    }
                }

                switch model.load {
                case .loading:
                    Section { HStack { Spacer(); ProgressView().tint(Palette.signal); Spacer() } }
                case .failed:
                    Section {
                        Text("Could not load your servers. Try again.")
                            .foregroundStyle(Palette.danger)
                            .accessibilityIdentifier("bau.follow.loadFailed")
                        Button("Try again") { Task { await model.reload(session: session) } }
                    }
                case .off:
                    Section {
                        Text("This Baú no longer accepts follows.")
                            .foregroundStyle(Palette.paperMuted)
                            .accessibilityIdentifier("bau.follow.off")
                    }
                case .ready:
                    if let picker = model.picker { destinationSections(picker) }
                }

                if let notice = model.notice {
                    Section {
                        Text(notice)
                            .foregroundStyle(Palette.success)
                            .accessibilityIdentifier("bau.follow.notice")
                            .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
                    }
                }
                if let error = model.error {
                    Section {
                        Text(error)
                            .foregroundStyle(Palette.danger)
                            .accessibilityIdentifier("bau.follow.error")
                    }
                }
            }
            .animation(reduceMotion ? nil : Motion.standard, value: model.notice)
            .animation(reduceMotion ? nil : Motion.standard, value: model.mine)
            .scrollContentBackground(.hidden)
            .background(Palette.ink)
            .navigationTitle("Follow this Baú")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }
                        .tint(Palette.paperMuted)
                        .accessibilityIdentifier("bau.follow.close")
                }
            }
            .task { await model.start(session: session) }
        }
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("bau.follow.sheet")
    }

    @ViewBuilder
    private func destinationSections(_ picker: BauFollowPicker) -> some View {
        if picker.destinations.isEmpty {
            Section {
                Text("To follow a Baú you need to manage webhooks or channels in a server of yours.")
                    .foregroundStyle(Palette.paperMuted)
                    .accessibilityIdentifier("bau.follow.empty")
            }
        } else {
            Section {
                Picker("Server", selection: Binding(
                    get: { picker.destination?.serverId ?? "" },
                    set: { model.select(server: $0) }
                )) {
                    ForEach(picker.destinations) { destination in
                        Text(verbatim: destination.serverName).tag(destination.serverId)
                    }
                }
                .accessibilityIdentifier("bau.follow.server")

                if picker.isFull, let destination = picker.destination {
                    Text("\(destination.serverName) already follows \(picker.maxPerServer) Baús, the most a server can.")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.warning)
                        .accessibilityIdentifier("bau.follow.full")
                } else if picker.freeChannels.isEmpty {
                    Text("Every channel of this server already follows this Baú.")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.paperMuted)
                        .accessibilityIdentifier("bau.follow.allFollowed")
                } else {
                    Picker("Channel", selection: Binding(
                        get: { picker.selectedChannelId },
                        set: { model.select(channel: $0) }
                    )) {
                        ForEach(picker.freeChannels) { channel in
                            Text(verbatim: "# \(channel.name)").tag(channel.id)
                        }
                    }
                    .accessibilityIdentifier("bau.follow.channel")

                    if !picker.roles.isEmpty {
                        Picker("Mention a role on each post", selection: Binding(
                            get: { picker.selectedRoleId },
                            set: { model.select(role: $0) }
                        )) {
                            Text("Mention nobody").tag("")
                            ForEach(picker.roles) { role in
                                Text(verbatim: "@\(role.name)").tag(role.id)
                            }
                        }
                        .accessibilityIdentifier("bau.follow.role")
                    }
                }
            }

            Section {
                Button {
                    Task { await model.submit(session: session) }
                } label: {
                    HStack {
                        Spacer()
                        if model.isSubmitting {
                            ProgressView().tint(Palette.inkDeep)
                        } else {
                            Text("Follow").font(Typography.bodyMedium)
                        }
                        Spacer()
                    }
                    .frame(minHeight: 44)
                    .foregroundStyle(Palette.inkDeep)
                }
                .listRowBackground(picker.canSubmit ? Palette.signal : Palette.signal.opacity(0.35))
                .disabled(!picker.canSubmit || model.isSubmitting)
                .accessibilityIdentifier("bau.follow.submit")
            }
        }
    }
}

/// One follow, with Retomar when it paused itself and Deixar de seguir.
struct BauFollowRow: View {
    let follow: BauFollow
    let title: String
    let subtitle: String
    let iconName: String
    let iconUrl: String?
    let busy: Bool
    let onUnfollow: () -> Void
    let onResume: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                ServerIconTile(name: iconName, iconUrl: iconUrl, size: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: title)
                        .font(Typography.bodyMedium)
                        .foregroundStyle(Palette.paper)
                    if !subtitle.isEmpty {
                        Text(verbatim: subtitle)
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                    }
                    if let role = follow.rolePingName {
                        Text("Mentions \(role)")
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                    }
                }
                Spacer(minLength: 0)
                if follow.isPaused {
                    Text("Paused")
                        .font(Typography.label)
                        .foregroundStyle(Palette.inkDeep)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Palette.warning))
                        .accessibilityIdentifier("bau.follow.paused")
                }
            }
            if follow.isPaused {
                Text(follow.isBanned
                    ? "Paused because this server banned the Baú's account. Unban it to resume, or unfollow."
                    : "Paused because whoever set it up lost permission to manage this channel. Resuming makes you the one it answers to.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.warning)
            }
            HStack(spacing: 16) {
                if follow.isPaused {
                    Button("Resume following", action: onResume)
                        .tint(Palette.signal)
                        .accessibilityIdentifier("bau.follow.resume")
                }
                Button("Unfollow", role: .destructive, action: onUnfollow)
                    .accessibilityIdentifier("bau.follow.unfollow")
            }
            .buttonStyle(.borderless)
            .font(Typography.callout)
            .frame(minHeight: 44, alignment: .leading)
            .disabled(busy)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bau.follow.row")
    }
}

// MARK: - The source's staff: followers, and the owner's switch

@MainActor
@Observable
final class BauFollowersModel {
    let serverId: String
    private(set) var data: BauFollowers?
    private(set) var loadFailed = false
    private(set) var busyKey: String?
    private(set) var error: String?
    private(set) var shown = BauFollowRules.followersPage
    private let onChanged: @MainActor () -> Void

    init(serverId: String, onChanged: @escaping @MainActor () -> Void) {
        self.serverId = serverId
        self.onChanged = onChanged
    }

    var visibleFollowers: [BauFollower] { Array((data?.followers ?? []).prefix(shown)) }
    var hasMore: Bool { (data?.followers.count ?? 0) > shown }
    func showMore() { shown += BauFollowRules.followersPage }

    func load(session: SessionStore) async {
        loadFailed = false
        do {
            data = try await session.api.bauFollowers(serverId: serverId)
        } catch {
            if data == nil { loadFailed = true }
        }
    }

    func setAllowed(_ allowed: Bool, session: SessionStore) async {
        guard busyKey == nil else { return }
        busyKey = "allowed"
        error = nil
        defer { busyKey = nil }
        do {
            data = try await session.api.setBauFollowAllowed(serverId: serverId, allowed: allowed)
        } catch {
            self.error = String(localized: "That did not work. Try again.")
            // The switch snaps back to what the server holds.
            await load(session: session)
        }
        onChanged()
    }

    /// Reflect the change at once, then reconcile: a read that fails after the
    /// change must not leave a removed server on show.
    func remove(_ follower: BauFollower, block: Bool, session: SessionStore) async {
        guard busyKey == nil, let current = data else { return }
        busyKey = follower.id
        error = nil
        defer { busyKey = nil }
        do {
            try await session.api.removeBauFollower(serverId: serverId, followId: follower.id, block: block)
            data = block
                ? BauFollowRules.blocking(follower, from: current)
                : BauFollowRules.removing(follower, from: current)
            onChanged()
            await load(session: session)
        } catch {
            self.error = String(localized: "That did not work. Try again.")
            // A lost answer can hide a change that did commit: show what is true.
            await load(session: session)
        }
    }

    func unblock(_ block: BauFollowBlock, session: SessionStore) async {
        guard busyKey == nil, let current = data else { return }
        busyKey = block.id
        error = nil
        defer { busyKey = nil }
        do {
            try await session.api.unblockBauFollower(serverId: serverId, blockedServerId: block.serverId)
            data = BauFollowRules.unblocking(block, from: current)
            onChanged()
            await load(session: session)
        } catch {
            self.error = String(localized: "That did not work. Try again.")
            // A lost answer can hide a change that did commit: show what is true.
            await load(session: session)
        }
    }
}

struct BauFollowersSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let server: Server
    @State private var model: BauFollowersModel
    @State private var confirmBlock: BauFollower?

    init(server: Server, onChanged: @escaping @MainActor () -> Void) {
        self.server = server
        _model = State(initialValue: BauFollowersModel(serverId: server.id, onChanged: onChanged))
    }

    var body: some View {
        NavigationStack {
            Form {
                if model.loadFailed {
                    Section {
                        Text("Could not load the followers. Try again.")
                            .foregroundStyle(Palette.danger)
                        Button("Try again") { Task { await model.load(session: session) } }
                    }
                }
                if let data = model.data {
                    if data.flagOn {
                        Section {
                            Toggle(isOn: Binding(
                                get: { data.allowed },
                                set: { next in Task { await model.setAllowed(next, session: session) } }
                            )) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Allow other servers to follow this Baú")
                                        .foregroundStyle(Palette.paper)
                                    Text("Free posts arrive as cards in the channels people choose. In a public community any member can set it up; otherwise only people who manage the server. Members-only posts never go out.")
                                        .font(Typography.caption)
                                        .foregroundStyle(Palette.paperMuted)
                                }
                            }
                            .tint(Palette.signal)
                            .disabled(model.busyKey != nil)
                            .accessibilityIdentifier("bau.follow.allow")
                        }
                    }

                    Section {
                        Text("Servers that receive your free posts as cards. You see server names, never people.")
                            .font(Typography.callout)
                            .foregroundStyle(Palette.paperMuted)
                        Text("\(data.count) followers")
                            .font(Typography.bodyMedium)
                            .foregroundStyle(Palette.paper)
                            .accessibilityIdentifier("bau.followers.count")
                    }

                    if data.followers.isEmpty {
                        Section {
                            Text("No server follows this Baú yet.")
                                .foregroundStyle(Palette.paperMuted)
                        }
                    } else {
                        Section {
                            ForEach(model.visibleFollowers) { follower in
                                followerRow(follower)
                            }
                            if model.hasMore {
                                Button("Show more") { model.showMore() }
                                    .accessibilityIdentifier("bau.followers.more")
                            }
                        }
                    }

                    if !data.blocked.isEmpty {
                        Section("Blocked servers") {
                            ForEach(data.blocked) { blocked in
                                HStack {
                                    Text(verbatim: blocked.serverName)
                                        .foregroundStyle(Palette.paper)
                                    Spacer()
                                    Button("Unblock") { Task { await model.unblock(blocked, session: session) } }
                                        .buttonStyle(.borderless)
                                        .tint(Palette.signal)
                                        .disabled(model.busyKey != nil)
                                        .accessibilityIdentifier("bau.followers.unblock")
                                }
                                .frame(minHeight: 44)
                            }
                        }
                    }
                } else if !model.loadFailed {
                    Section { HStack { Spacer(); ProgressView().tint(Palette.signal); Spacer() } }
                }

                if let error = model.error {
                    Section { Text(error).foregroundStyle(Palette.danger) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.ink)
            .navigationTitle("Followers of this Baú")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }
                        .tint(Palette.paperMuted)
                        .accessibilityIdentifier("bau.followers.close")
                }
            }
            // `presenting:` hands the action its own copy: the binding is
            // cleared as the dialog dismisses, which can be BEFORE the button's
            // action runs, so reading `confirmBlock` inside it would find nil.
            .confirmationDialog(
                String(localized: "Remove and block \(confirmBlock?.targetServerName ?? "")?"),
                isPresented: Binding(get: { confirmBlock != nil }, set: { if !$0 { confirmBlock = nil } }),
                titleVisibility: .visible,
                presenting: confirmBlock
            ) { target in
                Button("Remove and block", role: .destructive) {
                    Task { await model.remove(target, block: true, session: session) }
                }
                .accessibilityIdentifier("bau.followers.confirmBlock")
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("Every follow from that server stops now, and it cannot follow this Baú again until you unblock it. Cards already delivered stay.")
            }
            .task { await model.load(session: session) }
        }
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("bau.followers.sheet")
    }

    private func followerRow(_ follower: BauFollower) -> some View {
        HStack(spacing: 12) {
            ServerIconTile(name: follower.targetServerName, iconUrl: follower.targetServerIconUrl, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: follower.targetServerName)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                Text(verbatim: "# \(follower.targetChannelName)")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            }
            Spacer(minLength: 0)
            if follower.isPaused {
                Text("Paused")
                    .font(Typography.label)
                    .foregroundStyle(Palette.inkDeep)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Palette.warning))
            }
            Menu {
                Button("Remove") { Task { await model.remove(follower, block: false, session: session) } }
                    .accessibilityIdentifier("bau.followers.remove")
                Button("Remove and block", role: .destructive) { confirmBlock = follower }
                    .accessibilityIdentifier("bau.followers.block")
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(Palette.paperMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .disabled(model.busyKey != nil)
            .accessibilityLabel(Text("More"))
            .accessibilityIdentifier("bau.followers.rowMenu")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bau.followers.row")
    }
}

// MARK: - A destination channel's own list

@MainActor
@Observable
final class ChannelBauFollowsModel {
    let channelId: String
    private(set) var follows: [BauFollow] = []
    private(set) var isLoading = true
    private(set) var loadFailed = false
    private(set) var busyId: String?
    private(set) var error: String?

    init(channelId: String) { self.channelId = channelId }

    /// A 404 here is a deployment with the Baú off: an empty list, not a
    /// failure. Anything else says so and offers a retry, so a hiccup does not
    /// hide the way to unfollow.
    func load(session: SessionStore) async {
        isLoading = true
        loadFailed = false
        defer { isLoading = false }
        do {
            follows = try await session.api.channelBauFollows(channelId: channelId)
        } catch {
            if case .notFound = error as? APIError {
                follows = []
            } else {
                loadFailed = true
            }
        }
    }

    func unfollow(_ follow: BauFollow, session: SessionStore) async {
        guard busyId == nil else { return }
        busyId = follow.id
        error = nil
        defer { busyId = nil }
        do {
            try await session.api.deleteBauFollow(id: follow.id)
            follows.removeAll { $0.id == follow.id }
        } catch {
            self.error = String(localized: "That did not work. Try again.")
            // A lost answer can hide a change that did commit: show what is true.
            await load(session: session)
        }
    }

    func resume(_ follow: BauFollow, session: SessionStore) async {
        guard busyId == nil else { return }
        busyId = follow.id
        error = nil
        defer { busyId = nil }
        do {
            let updated = try await session.api.resumeBauFollow(id: follow.id)
            if let index = follows.firstIndex(where: { $0.id == follow.id }) { follows[index] = updated }
        } catch {
            self.error = String(localized: "That did not work. Try again.")
            // A lost answer can hide a change that did commit: show what is true.
            await load(session: session)
        }
    }
}

/// "Following" in a text channel's menu: the Baús this channel follows, each
/// with Deixar de seguir, and Retomar when the follow paused itself.
struct ChannelBauFollowsSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let channel: Channel
    @State private var model: ChannelBauFollowsModel

    init(channel: Channel) {
        self.channel = channel
        _model = State(initialValue: ChannelBauFollowsModel(channelId: channel.id))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("The Baús this channel follows. New free posts arrive here as cards.")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.paperMuted)
                }
                if model.loadFailed {
                    Section {
                        Text("Could not load what this channel follows.")
                            .foregroundStyle(Palette.danger)
                        Button("Try again") { Task { await model.load(session: session) } }
                            .accessibilityIdentifier("channel.follows.retry")
                    }
                }
                if model.isLoading && model.follows.isEmpty && !model.loadFailed {
                    Section { HStack { Spacer(); ProgressView().tint(Palette.signal); Spacer() } }
                } else if model.follows.isEmpty && !model.loadFailed {
                    Section {
                        Text("This channel does not follow any Baú yet. Open a Baú and tap the bell to follow it here.")
                            .foregroundStyle(Palette.paperMuted)
                            .accessibilityIdentifier("channel.follows.empty")
                    }
                } else if !model.follows.isEmpty {
                    Section {
                        ForEach(model.follows) { follow in
                            BauFollowRow(
                                follow: follow,
                                title: String(localized: "Baú of \(follow.sourceServerName)"),
                                subtitle: "",
                                iconName: follow.sourceServerName,
                                iconUrl: follow.sourceServerIconUrl,
                                busy: model.busyId != nil,
                                onUnfollow: { Task { await model.unfollow(follow, session: session) } },
                                onResume: { Task { await model.resume(follow, session: session) } }
                            )
                        }
                    }
                }
                if let error = model.error {
                    Section { Text(error).foregroundStyle(Palette.danger) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.ink)
            .navigationTitle("Following")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }
                        .tint(Palette.paperMuted)
                        .accessibilityIdentifier("channel.follows.close")
                }
            }
            .task { await model.load(session: session) }
        }
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("channel.follows.sheet")
    }
}

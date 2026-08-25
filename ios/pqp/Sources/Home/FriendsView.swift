import SwiftUI
import Observation

/// Friends.
///
/// Three tabs, matching the web client: who is around, everybody, and the
/// requests. The rules this screen has to respect are the server's, not its
/// own:
///
/// - A REFUSAL IS NOT AN ORACLE. Every rejected request answers with the same
///   sentence whether you blocked them, they blocked you, or the id is junk.
///   The server's wording is shown verbatim; inventing a more "helpful" one
///   here would turn the screen into a probe for who has blocked you.
/// - DECLINING IS SILENT, and so are cancelling and unfriending — all three are
///   one DELETE, and the other side is never told. That is what makes declining
///   cheap enough that people actually do it.
/// - PENDING ENTRIES CARRY NO PRESENCE. Until you accept, the other person is a
///   stranger, and a stranger must not learn whether you are at your keyboard
///   by the act of asking. So no status dot on a request row — the server does
///   not send one to draw.
struct FriendsView: View {
    /// Open the handle search as soon as this screen appears.
    ///
    /// For the hub's first-run checklist, whose "Add a friend" button has to land
    /// on the search field rather than on a screen with a search *button* in a
    /// corner. Pushing this view rather than presenting the sheet over the hub is
    /// deliberate: this is where the friend they are about to add will show up, so
    /// dismissing the sheet leaves them looking at the result.
    var opensAddImmediately = false

    @Environment(SessionStore.self) private var session
    @State private var model = FriendsModel()
    @State private var opened: DmSummary?
    /// One-shot, so returning from a pushed chat does not reopen the sheet.
    @State private var hasAutoOpenedAdd = false

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            VStack(spacing: 12) {
                tabBar

                if let error = model.error {
                    Text(error)
                        .font(Typography.callout)
                        .foregroundStyle(Palette.danger)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, Metrics.hPadding)
                } else if let live = model.liveNotice {
                    Text(live == .accepted
                         ? "Your friend request was accepted."
                         : "Someone sent you a friend request.")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.signal)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, Metrics.hPadding)
                        .accessibilityIdentifier("friends.liveNotice")
                } else if let notice = model.notice {
                    Text(notice)
                        .font(Typography.callout)
                        .foregroundStyle(Palette.signal)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, Metrics.hPadding)
                }

                if model.isLoading && model.data.friends.isEmpty {
                    ProgressView().tint(Palette.signal)
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            switch model.tab {
                            case .online, .all:
                                friendRows
                            case .pending:
                                requestRows
                            }
                        }
                        .padding(.horizontal, Metrics.hPadding)
                        .padding(.bottom, 24)
                    }
                    .refreshable { await model.refresh() }
                }
            }
            .padding(.top, 8)
        }
        .navigationTitle("Friends")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { model.showingAdd = true } label: {
                    Image(systemName: "person.badge.plus")
                }
                .tint(Palette.signal)
                .accessibilityLabel("Add friend")
            }
        }
        .sheet(isPresented: $model.showingAdd) {
            AddFriendView(known: model.knownIds(selfId: session.currentUser?.id)) { userId in
                await model.add(userId)
            }
        }
        .navigationDestination(item: $opened) { conversation in
            ChatView(channelId: conversation.channelId, title: conversation.title)
                // A DM reached from here is as much "where I was" as one
                // reached from the hub; recording it in only one of the two
                // places would make the restore look random.
                .onAppear { LastVisited.record(conversationId: conversation.channelId) }
        }
        .confirmationDialog(
            model.confirming?.prompt ?? "",
            isPresented: Binding(
                get: { model.confirming != nil },
                set: { if !$0 { model.confirming = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let pending = model.confirming {
                Button(pending.actionLabel, role: .destructive) {
                    Task { await model.commitConfirmed() }
                }
            }
            Button("Cancel", role: .cancel) { model.confirming = nil }
        } message: {
            Text(model.confirming?.explanation ?? "")
        }
        .task { await model.load(session: session) }
        .onAppear {
            guard opensAddImmediately, !hasAutoOpenedAdd else { return }
            hasAutoOpenedAdd = true
            model.showingAdd = true
        }
        .onDisappear { model.unload() }
    }

    private var tabBar: some View {
        HStack(spacing: 8) {
            ForEach(FriendsModel.Tab.allCases) { tab in
                let badge = tab == .pending ? model.pendingCount : 0
                Button {
                    withAnimation(Motion.standard) { model.tab = tab }
                } label: {
                    HStack(spacing: 6) {
                        Text(tab.label)
                            .font(Typography.caption)
                            .foregroundStyle(model.tab == tab ? Palette.inkDeep : Palette.paperMuted)
                        if badge > 0 {
                            Text(verbatim: "\(badge)")
                                .font(.system(size: 11, weight: .bold))
                                .monospacedDigit()
                                .foregroundStyle(model.tab == tab ? Palette.inkDeep : Palette.signal)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(
                        Capsule().fill(model.tab == tab ? Palette.signal : Palette.surface)
                    )
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(.horizontal, Metrics.hPadding)
    }

    @ViewBuilder
    private var friendRows: some View {
        let rows = model.tab == .online
            ? FriendsDigest.online(model.data.friends)
            : FriendsDigest.onlineFirst(model.data.friends)

        if rows.isEmpty {
            EmptyState(
                icon: "person.2",
                title: model.tab == .online ? "Nobody's around" : "No friends yet",
                message: model.tab == .online
                    ? "Your friends will show up here when they come online."
                    : "Add someone with their full handle, like name#1234."
            )
            .padding(.top, 30)
        } else {
            ForEach(rows) { friend in
                FriendRow(friend: friend, isBusy: model.busyId == friend.id)
                    .contextMenu {
                        Button {
                            Task { opened = await model.openConversation(with: friend.id) }
                        } label: {
                            Label("Message", systemImage: "bubble.left")
                        }
                        Button(role: .destructive) {
                            model.confirming = .remove(friend)
                        } label: {
                            Label("Remove friend", systemImage: "person.badge.minus")
                        }
                        Button(role: .destructive) {
                            model.confirming = .block(friend)
                        } label: {
                            Label("Block", systemImage: "hand.raised")
                        }
                    }
            }
        }
    }

    @ViewBuilder
    private var requestRows: some View {
        // The queue first: publishing something onto your own profile is a
        // bigger decision than answering a friend request, and it is the one
        // people did not know was waiting.
        PendingDepoimentosSection(
            depoimentos: model.pendingDepoimentos,
            busyId: model.depoimentoBusyId,
            onApprove: { id in Task { await model.approveDepoimento(id) } },
            onReject: { id in Task { await model.rejectDepoimento(id) } }
        )

        if model.data.incoming.isEmpty && model.data.outgoing.isEmpty
            && model.pendingDepoimentos.isEmpty {
            EmptyState(
                icon: "tray",
                title: "Nothing pending",
                message: "Friend requests waiting on you, and the ones you've sent, land here."
            )
            .padding(.top, 30)
        } else {
            if !model.data.incoming.isEmpty {
                SectionLabel(text: String(localized: "Waiting on you"))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
                ForEach(model.data.incoming) { entry in
                    RequestRow(entry: entry, isBusy: model.busyId == entry.id) {
                        // Accepting and declining are both offered inline: a
                        // request needs one tap to answer, not a menu.
                        Button("Accept") { Task { await model.accept(entry.id) } }
                            .font(Typography.caption)
                            .foregroundStyle(Palette.signal)
                        Button("Decline") { Task { await model.remove(entry.id) } }
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                    }
                }
            }

            if !model.data.outgoing.isEmpty {
                SectionLabel(text: String(localized: "Sent"))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 12)
                ForEach(model.data.outgoing) { entry in
                    RequestRow(entry: entry, isBusy: model.busyId == entry.id) {
                        Button("Cancel") { Task { await model.remove(entry.id) } }
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                    }
                }
            }
        }
    }
}

// MARK: - Model

@MainActor
@Observable
final class FriendsModel {
    enum Tab: String, CaseIterable, Identifiable {
        case online, all, pending
        var id: String { rawValue }
        var label: LocalizedStringKey {
            switch self {
            case .online: "Online"
            case .all: "All"
            case .pending: "Pending"
            }
        }
    }

    /// A destructive action held until it is confirmed. One case per action so
    /// the prompt and the verb cannot drift apart.
    enum Confirmation {
        case remove(Friend)
        case block(Friend)

        var person: Friend {
            switch self {
            case .remove(let friend), .block(let friend): friend
            }
        }

        var prompt: String {
            switch self {
            case .remove(let friend): String(localized: "Remove \(friend.displayName)?")
            case .block(let friend): String(localized: "Block \(friend.displayName)?")
            }
        }

        var explanation: String {
            switch self {
            case .remove:
                String(localized: "They won't be told. You can add each other again later.")
            case .block:
                // Stated because it is the one surprising consequence: the
                // schema's trigger deletes the friendship the moment a block
                // lands, in both directions.
                String(localized: "Blocking also ends the friendship and hides their messages.")
            }
        }

        var actionLabel: LocalizedStringKey {
            switch self {
            case .remove: "Remove"
            case .block: "Block"
            }
        }
    }

    var data = FriendsResponse()
    var tab: Tab = .online
    var isLoading = true
    var error: String?
    /// A success line — "request sent", "you're now friends" — which is the
    /// only feedback the protocol offers: there is no notification to the other
    /// side and no frame back to us.
    var notice: String?
    var busyId: String?
    var showingAdd = false
    var confirming: Confirmation?
    /// The last live nudge, so the screen can say what just happened. A row
    /// quietly appearing in a list is easy to miss; "someone sent you a friend
    /// request" is not. Never names the person — the frame carries no name, and
    /// the row that just appeared already does.
    var liveNotice: FriendActivityKind?
    /// Depoimentos friends have written about this account and nobody has seen.
    /// Kept beside the requests because they are answered from the same tab with
    /// the same two buttons — see `Depoimentos.waitingOnYou`.
    var pendingDepoimentos: [Depoimento] = []
    /// The depoimento currently being published or refused. Its own id rather
    /// than `busyId`, which belongs to a person: a row here is a piece of text,
    /// and its author may also be sitting in the requests list above.
    var depoimentoBusyId: String?

    private var session: SessionStore?
    private let handlerKey = "friends-" + UUID().uuidString

    /// What the Pending tab's badge counts: requests waiting on you, plus
    /// depoimentos waiting on you. One number for one errand.
    var pendingCount: Int {
        Depoimentos.waitingOnYou(
            friendRequests: FriendsDigest.pendingActionCount(data),
            pendingDepoimentos: pendingDepoimentos.count
        )
    }

    func knownIds(selfId: String?) -> Set<String> {
        FriendsDigest.alreadyKnown(data, selfId: selfId)
    }

    func load(session: SessionStore) async {
        self.session = session
        // A nudge while this screen is open moves the list itself, not only the
        // hub's badge. Without it, the one surface a person opens *to answer a
        // request* was the surface with no way to learn one had arrived: this
        // model has never polled, so before the frame existed a request could
        // only appear on a pull-to-refresh.
        session.eventHandlers[handlerKey] = { [weak self] event in
            guard let self, case .friendActivity(let kind) = event else { return }
            self.liveNotice = kind
            Task { await self.refresh() }
        }
        await refresh()
        // An account with no friends at all opens on the wrong tab. Online says
        // "Nobody's around", which is true and useless — it reads as "your
        // friends are offline" to somebody who has none, and carries no way to
        // change that. All says "No friends yet" and tells them a handle is what
        // to search for. Only on the first load: yanking the tab out from under
        // somebody who has chosen Online themselves would be worse than either.
        if data.friends.isEmpty, tab == .online {
            tab = .all
        }
    }

    /// Detach from the socket. Called from the view's `onDisappear`, because a
    /// model that has gone away must not leave a closure behind refreshing a
    /// screen nobody is looking at.
    func unload() {
        session?.eventHandlers.removeValue(forKey: handlerKey)
    }

    func refresh() async {
        guard let session else { return }
        isLoading = true
        // The queue is read alongside the three lists and its failure is NOT
        // fatal: a dropped request here must not blank the friends list, and it
        // must not empty a queue that still has something in it — the numbers on
        // this screen are answers people owe somebody, and a flicker to zero
        // reads as "it was dealt with".
        let api = session.api
        async let queue = try? await api.pendingDepoimentos()
        do {
            data = try await session.api.friends()
            error = nil
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        if let pending = await queue {
            pendingDepoimentos = pending
        }
        isLoading = false
    }

    /// Publish one. The author is told — the one moment they hear anything, and
    /// it is the warm one: their words are public now.
    func approveDepoimento(_ id: String) async {
        guard let session else { return }
        depoimentoBusyId = id
        liveNotice = nil
        defer { depoimentoBusyId = nil }
        do {
            try await session.api.approveDepoimento(id: id)
            pendingDepoimentos.removeAll { $0.id == id }
            notice = String(localized: "It's on your profile.")
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Refuse one. Silent, unconfirmed, and the row stops existing.
    ///
    /// THE SILENCE IS THE MITIGATION rather than politeness: telling the author
    /// "they read it and said no" is the single fact deleting the row exists to
    /// withhold, and it would make refusing socially expensive in a feature whose
    /// whole safety rests on refusing staying cheap.
    func rejectDepoimento(_ id: String) async {
        guard let session else { return }
        depoimentoBusyId = id
        liveNotice = nil
        defer { depoimentoBusyId = nil }
        do {
            try await session.api.deleteDepoimento(id: id)
            pendingDepoimentos.removeAll { $0.id == id }
            notice = nil
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func add(_ userId: String) async -> FriendActionOutcome {
        guard let session else {
            return FriendActionOutcome(message: String(localized: "Not signed in."), failed: true)
        }
        do {
            let result = try await session.api.sendFriendRequest(userId: userId)
            await refresh()
            return FriendActionOutcome(
                message: result.isAccepted
                    ? String(localized: "You're now friends.")
                    : String(localized: "Request sent."),
                failed: false
            )
        } catch {
            // Shown verbatim: the server answers every refusal with one
            // sentence on purpose, and paraphrasing it would leak which one.
            return FriendActionOutcome(
                message: (error as? APIError)?.errorDescription ?? error.localizedDescription,
                failed: true
            )
        }
    }

    func accept(_ userId: String) async {
        guard let session else { return }
        busyId = userId
        liveNotice = nil
        defer { busyId = nil }
        do {
            try await session.api.acceptFriendRequest(userId: userId)
            notice = String(localized: "You're now friends.")
            await refresh()
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Decline, cancel, or unfriend — one call, because the server models all
    /// three as the same removal.
    func remove(_ userId: String) async {
        guard let session else { return }
        busyId = userId
        liveNotice = nil
        defer { busyId = nil }
        do {
            try await session.api.removeFriendship(userId: userId)
            notice = nil
            await refresh()
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func commitConfirmed() async {
        guard let session, let pending = confirming else { return }
        let userId = pending.person.id
        confirming = nil
        busyId = userId
        liveNotice = nil
        defer { busyId = nil }
        do {
            switch pending {
            case .remove:
                try await session.api.removeFriendship(userId: userId)
            case .block:
                // No separate unfriend call: the block's trigger deletes the
                // friendship row itself, and issuing both would race it.
                try await session.api.setBlocked(userId: userId, blocked: true)
            }
            await refresh()
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Open (or reuse) the DM with a friend. Friends bypass a `server_members`
    /// DM privacy setting server-side, which is why this is offered here at all
    /// — but it does NOT override `nobody`, so a refusal is still possible and
    /// the server's wording is what gets shown.
    func openConversation(with userId: String) async -> DmSummary? {
        guard let session else { return nil }
        busyId = userId
        liveNotice = nil
        defer { busyId = nil }
        do {
            return try await session.api.openConversation(userIds: [userId])
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
            return nil
        }
    }
}

/// What a friend action has to say afterwards. Typed rather than "a string
/// that starts with the right word": whether something failed must not depend
/// on the wording, which is translated.
struct FriendActionOutcome: Sendable {
    let message: String
    let failed: Bool
}

// MARK: - Rows

private struct FriendRow: View {
    let friend: Friend
    var isBusy = false

    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: friend.displayName, seed: friend.id, size: 40, url: friend.avatarUrl)
                .overlay(alignment: .bottomTrailing) {
                    StatusDot(status: friend.status)
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(friend.displayName)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                if let tag = friend.tag {
                    Text(tag).font(Typography.mono).foregroundStyle(Palette.paperMuted)
                }
            }
            Spacer()
            if isBusy {
                ProgressView().tint(Palette.signal)
            } else {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.paperMuted)
            }
        }
        .padding(12)
        .pqpSurface()
    }
}

private struct RequestRow<Actions: View>: View {
    let entry: FriendRequestEntry
    var isBusy = false
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        HStack(spacing: 12) {
            // Deliberately no status dot — the server sends no status for a
            // pending entry, and drawing "offline" would be a claim.
            Avatar(name: entry.displayName, seed: entry.id, size: 40, url: entry.avatarUrl)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.displayName)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                if let tag = entry.tag {
                    Text(tag).font(Typography.mono).foregroundStyle(Palette.paperMuted)
                }
                Text(entry.requestedAt, format: .relative(presentation: .named))
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.paperMuted)
            }
            Spacer()
            if isBusy {
                ProgressView().tint(Palette.signal)
            } else {
                HStack(spacing: 12) { actions() }
            }
        }
        .padding(12)
        .pqpSurface()
    }
}

// MARK: - Add friend

/// Adding a friend reuses the two discovery paths that already exist — the
/// exact `name#1234` lookup and the budgeted prefix search — so friends add NO
/// new way to find a stranger. Anyone already befriended or mid-request is
/// filtered out: offering "Add" to an existing friend reads as a bug.
struct AddFriendView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let known: Set<String>
    let onAdd: (String) async -> FriendActionOutcome

    @State private var query = ""
    @State private var results: [PublicUser] = []
    @State private var searching = false
    @State private var message: String?
    @State private var isFailure = false
    @State private var busyId: String?
    @State private var searchTask: Task<Void, Never>?

    private var looksLikeTag: Bool {
        query.contains("#") && query.split(separator: "#").count == 2
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                VStack(spacing: 12) {
                    HStack(spacing: 8) {
                        Image(systemName: "at").foregroundStyle(Palette.paperMuted)
                        TextField("name#1234", text: $query)
                            .textFieldStyle(.plain)
                            .foregroundStyle(Palette.paper)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .onChange(of: query) { _, value in schedule(value) }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .pqpSurface(cornerRadius: 20)
                    .padding(.horizontal, Metrics.hPadding)

                    Text("Their full handle is the only way to find someone who isn't in a community with you.")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)

                    if let message {
                        Text(message)
                            .font(Typography.callout)
                            .foregroundStyle(isFailure ? Palette.danger : Palette.signal)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, Metrics.hPadding)
                    }

                    if searching {
                        ProgressView().tint(Palette.signal).padding(.top, 12)
                    }

                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(results) { user in
                                HStack(spacing: 12) {
                                    Avatar(name: user.displayName, seed: user.id,
                                           size: 40, url: user.avatarUrl)
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
                                    if busyId == user.id {
                                        ProgressView().tint(Palette.signal)
                                    } else if known.contains(user.id) {
                                        Text("Already added")
                                            .font(Typography.caption)
                                            .foregroundStyle(Palette.paperMuted)
                                    } else {
                                        Button("Add") { Task { await add(user) } }
                                            .font(Typography.caption)
                                            .foregroundStyle(Palette.signal)
                                    }
                                }
                                .padding(12)
                                .pqpSurface()
                            }
                        }
                        .padding(.horizontal, Metrics.hPadding)
                    }

                    Spacer(minLength: 0)
                }
                .padding(.top, 8)
            }
            .navigationTitle("Add friend")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }.tint(Palette.paperMuted)
                }
            }
        }
    }

    private func add(_ user: PublicUser) async {
        busyId = user.id
        defer { busyId = nil }
        let outcome = await onAdd(user.id)
        // Success sentences come from the model, refusals from the server; both
        // are shown as written. A refusal never says *why* — that is deliberate.
        isFailure = outcome.failed
        message = outcome.message
    }

    /// Debounced for the same reason NewConversationView is: user search is the
    /// tightest-budgeted endpoint on the server, and a request per keystroke is
    /// rate-limited within a word.
    private func schedule(_ value: String) {
        searchTask?.cancel()
        message = nil
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else {
            results = []
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
        do {
            if looksLikeTag {
                results = [try await session.api.lookupUser(tag: term)]
            } else {
                results = try await session.api.searchUsers(query: term)
            }
        } catch let apiError as APIError {
            // A tag nobody holds is a 404, which is an answer rather than a
            // failure — the four digits are exactly what makes it unguessable.
            if case .notFound = apiError {
                results = []
            } else {
                isFailure = true
                message = apiError.errorDescription
            }
        } catch {
            isFailure = true
            message = error.localizedDescription
        }
        searching = false
    }
}

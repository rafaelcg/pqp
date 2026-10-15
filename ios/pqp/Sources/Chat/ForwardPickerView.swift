import SwiftUI

// ENCAMINHAR, the picker: where does this go?
//
// Servers' channels and conversations this account can send to, recent ones
// first, searchable, up to five at once, with an optional comment. Everything
// that decides something (who is offered, in what order, what a refusal says)
// lives in `Core/Forward.swift` where a test can see it; this file is the
// model that loads the lists and the screen that draws them.

extension ForwardSource: Identifiable {}

/// What the success toast carries: how many places, and where "View" goes.
struct ForwardToast: Equatable, Identifiable {
    let id = UUID()
    let count: Int
    let open: DeepLinkTarget?
}

@MainActor
@Observable
final class ForwardPickerModel {
    let source: ForwardSource

    var query = ""
    var comment = ""
    private(set) var selected: [ForwardTarget] = []
    /// A sixth was tapped: the screen says so for a moment.
    private(set) var showsFullNotice = false

    private(set) var conversations: [ForwardTarget] = []
    private(set) var channels: [ForwardTarget] = []
    private(set) var isLoading = true
    private(set) var loadFailed = false

    private(set) var isSending = false
    /// Per channel id, once a send has answered.
    private(set) var outcomes: [String: ForwardOutcome] = [:]
    private(set) var failure: String?

    private var recentIds: [String]
    /// One per picker, reused by every retry: the server de-duplicates on it
    /// per channel, so a retry after a lost answer returns the messages that
    /// already went out instead of posting second cards.
    private let nonce = UUID().uuidString.lowercased()

    init(source: ForwardSource) {
        self.source = source
        recentIds = ForwardRecents().load()
    }

    /// A picker whose lists are already there, for tests of what it offers.
    init(
        source: ForwardSource, recentIds: [String],
        conversations: [ForwardTarget], channels: [ForwardTarget]
    ) {
        self.source = source
        self.recentIds = recentIds
        self.conversations = conversations
        self.channels = channels
        isLoading = false
    }

    // MARK: Loading

    /// Conversations first (one request, and what people forward to most), then
    /// every server's channels and this account's permissions in them, a few
    /// servers at a time so the list fills in rather than waiting on all of
    /// them. Whatever loaded is kept; anything that did not sets `loadFailed`,
    /// which the screen says out loud with a way to try again.
    func load(session: SessionStore) async {
        isLoading = true
        loadFailed = false
        conversations = []
        channels = []
        let api = session.api
        let stay = source.stayInServerId

        if stay == nil {
            if let list = try? await api.conversations() {
                conversations = list
                    .sorted { ($0.lastMessageAt ?? .distantPast) > ($1.lastMessageAt ?? .distantPast) }
                    .map { convo in
                        ForwardTarget(
                            channelId: convo.channelId, title: convo.title, serverId: nil,
                            serverName: nil, iconUrl: convo.participants.first?.avatarUrl,
                            seed: convo.participants.first?.id ?? convo.channelId,
                            isConversation: true
                        )
                    }
            } else {
                loadFailed = true
            }
        }

        guard let servers = try? await api.servers() else {
            loadFailed = true
            isLoading = false
            return
        }
        let wanted = servers.enumerated().filter { stay == nil || $0.element.id == stay }

        // Bounded: a few servers in flight, results appended as they land but
        // kept in the servers' own order.
        var byIndex: [Int: [ForwardTarget]] = [:]
        await withTaskGroup(of: (Int, ServerTargets?).self) { group in
            var next = 0
            func start() {
                guard next < wanted.count else { return }
                let (index, server) = wanted[next]
                next += 1
                group.addTask { (index, await Self.targets(in: server, api: api)) }
            }
            for _ in 0..<min(Self.concurrency, wanted.count) { start() }
            for await (index, loaded) in group {
                if let loaded { byIndex[index] = loaded.targets }
                // A channel list that did not load, or permissions that did not
                // (so the list may offer a place that will refuse): said out loud.
                if loaded == nil || loaded?.permissionsKnown == false { loadFailed = true }
                channels = byIndex.keys.sorted().flatMap { byIndex[$0] ?? [] }
                start()
            }
        }
        guard !Task.isCancelled else { return }
        isLoading = false
    }

    private static let concurrency = 4

    private struct ServerTargets: Sendable {
        let targets: [ForwardTarget]
        /// False when the permissions read failed and every text channel is
        /// offered (the server stays the authority and refuses per target).
        let permissionsKnown: Bool
    }

    /// One server's channels this account may send in, or nil when its channel
    /// list could not be read. Both reads depend only on the server, so they
    /// run together.
    private nonisolated static func targets(in server: Server, api: APIClient) async -> ServerTargets? {
        async let listed = try? await api.channels(serverId: server.id)
        async let allowed = try? await api.fetchMemberPermissions(serverId: server.id)
        guard let list = await listed else { return nil }
        let permissions = await allowed
        let targets = list
            .filter { $0.isText && (permissions?.can(PermissionBit.sendMessages, channelId: $0.id) ?? true) }
            .sorted { $0.position < $1.position }
            .map { channel in
                ForwardTarget(
                    channelId: channel.id, title: "#\(channel.name)", serverId: server.id,
                    serverName: server.name, iconUrl: server.iconUrl, seed: server.id,
                    isConversation: false
                )
            }
        return ServerTargets(targets: targets, permissionsKnown: permissions != nil)
    }

    // MARK: What the list shows

    private var allowed: [ForwardTarget] {
        (conversations + channels).filter {
            ForwardTargets.isAllowed($0, stayInServerId: source.stayInServerId)
        }
    }

    /// With nothing typed: recents, then conversations, then channels. Typed:
    /// one flat list of matches.
    var recentRows: [ForwardTarget] {
        guard query.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }
        return ForwardTargets.ranked(all: allowed, recent: recentIds).recent
    }

    var conversationRows: [ForwardTarget] {
        rows(conversations.filter { ForwardTargets.isAllowed($0, stayInServerId: source.stayInServerId) })
    }

    var channelRows: [ForwardTarget] {
        rows(channels.filter { ForwardTargets.isAllowed($0, stayInServerId: source.stayInServerId) })
    }

    private func rows(_ list: [ForwardTarget]) -> [ForwardTarget] {
        let recent = Set(recentRows.map(\.id))
        return list.filter { !recent.contains($0.id) && ForwardTargets.matches($0, query: query) }
    }

    var hasNoMatches: Bool {
        !isLoading && recentRows.isEmpty && conversationRows.isEmpty && channelRows.isEmpty
    }

    // MARK: Selecting

    func isSelected(_ target: ForwardTarget) -> Bool {
        selected.contains { $0.id == target.id }
    }

    /// A full selection dims the rest; the ones already picked stay tappable.
    func isDisabled(_ target: ForwardTarget) -> Bool {
        selected.count >= ForwardTargets.maxTargets && !isSelected(target)
    }

    func toggle(_ target: ForwardTarget) {
        // A place that already has it stays picked: taking it off and putting
        // it back would send it a second time.
        guard !isSending, outcomes[target.id]?.ok != true else { return }
        let result = ForwardTargets.toggled(selected, target)
        selected = result.selected
        // Picking again after an answer starts a new attempt on that place.
        outcomes[target.id] = nil
        failure = nil
        if result.refusedFull {
            showsFullNotice = true
            Task {
                try? await Task.sleep(for: .seconds(2.5))
                showsFullNotice = false
            }
        }
    }

    // MARK: Sending

    /// Where a send would go: places not answered yet, and places that were
    /// refused for a reason worth another try. A place that has it, or was
    /// refused for good, is not sent again.
    var pendingTargets: [ForwardTarget] { ForwardTargets.pending(selected, outcomes: outcomes) }

    var canSend: Bool {
        !pendingTargets.isEmpty && !isSending && comment.count <= ForwardRequest.commentMax
    }

    /// How many of the selected places already have it.
    var sentCount: Int { selected.filter { outcomes[$0.id]?.ok == true }.count }
    var hasTransientFailure: Bool {
        selected.contains { outcomes[$0.id]?.refusal?.isTransient == true }
    }
    var allSent: Bool { !selected.isEmpty && sentCount == selected.count }

    /// Sends to every place still pending. Returns the toast to show when the
    /// screen should close (everything went), nil when it should stay.
    func send(session: SessionStore) async -> ForwardToast? {
        guard canSend else { return nil }
        isSending = true
        failure = nil
        defer { isSending = false }
        let targets = pendingTargets
        let request = ForwardRequest(source: source, targets: targets, comment: comment, nonce: nonce)
        do {
            let answers = try await session.api.createForward(request)
            var byChannel: [String: ForwardOutcome] = [:]
            for answer in answers where !answer.channelId.isEmpty { byChannel[answer.channelId] = answer }
            // A target the answer never mentions is not claimed as sent.
            for target in targets {
                outcomes[target.id] = byChannel[target.id] ?? ForwardOutcome(
                    channelId: target.id, serverId: target.serverId,
                    refusal: .unavailable, retryAfterMs: nil
                )
            }
        } catch {
            failure = ForwardFailure.from(error).message
            return nil
        }
        ForwardRecents().remember(selected.filter { outcomes[$0.id]?.ok == true }.map(\.id))
        return allSent ? toast() : nil
    }

    /// The toast for whatever went through, "View" opening the first place.
    func toast() -> ForwardToast? {
        let sent = selected.filter { outcomes[$0.id]?.ok == true }
        guard let first = sent.first else { return nil }
        let open: DeepLinkTarget = first.serverId.map {
            DeepLinkTarget.channel(serverId: $0, channelId: first.channelId)
        } ?? .conversation(channelId: first.channelId)
        return ForwardToast(count: sent.count, open: open)
    }

    func message(for target: ForwardTarget) -> String? {
        guard let outcome = outcomes[target.id], let refusal = outcome.refusal else { return nil }
        return refusal.copy(retryAfterMs: outcome.retryAfterMs)
    }
}

// MARK: - The screen

struct ForwardPickerView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var model: ForwardPickerModel
    @FocusState private var commentFocused: Bool

    init(source: ForwardSource) {
        _model = State(initialValue: ForwardPickerModel(source: source))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()
                VStack(spacing: 0) {
                    list
                    composer
                }
            }
            .navigationTitle("Forward")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(model.sentCount > 0 ? "Done" : "Cancel") { finish() }
                        .tint(Palette.paperMuted)
                        .accessibilityIdentifier("forward.cancel")
                }
            }
        }
        .task { await model.load(session: session) }
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("forward.picker")
    }

    /// Closing after some places already have it still says so.
    private func finish() {
        if model.sentCount > 0, let toast = model.toast() { session.forwardToast = toast }
        dismiss()
    }

    // MARK: List

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: []) {
                sourceHeader
                searchField

                if model.source.stayInServerId != nil {
                    Text("This can only go inside this server.")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                        .padding(.horizontal, Metrics.hPadding)
                        .padding(.bottom, 8)
                        .accessibilityIdentifier("forward.stays")
                }

                if model.loadFailed && !model.isLoading {
                    HStack(spacing: 10) {
                        Text("Couldn't load all your places.")
                            .font(Typography.callout)
                            .foregroundStyle(Palette.danger)
                        Spacer(minLength: 0)
                        Button("Try again") { Task { await model.load(session: session) } }
                            .font(Typography.callout.weight(.semibold))
                            .foregroundStyle(Palette.signal)
                            .accessibilityIdentifier("forward.reload")
                    }
                    .padding(.horizontal, Metrics.hPadding)
                    .padding(.vertical, 8)
                    .accessibilityIdentifier("forward.loadFailed")
                }

                section(String(localized: "Recent"), rows: model.recentRows)
                section(String(localized: "Chats"), rows: model.conversationRows)
                section(String(localized: "Channels"), rows: model.channelRows)

                if model.isLoading {
                    ProgressView().tint(Palette.signal)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                } else if model.hasNoMatches && !model.loadFailed {
                    Text("Nothing matches.")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.paperMuted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                        .accessibilityIdentifier("forward.empty")
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    /// What is being forwarded, so the person knows what they are sending on.
    private var sourceHeader: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "arrowshape.turn.up.right.fill")
                .font(.system(size: 14))
                .foregroundStyle(Palette.signal)
                .padding(.top, 2)
            Text(verbatim: model.source.summary.isEmpty ? " " : model.source.summary)
                .font(Typography.callout)
                .foregroundStyle(Palette.paperSubtle)
                .lineLimit(3)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(Palette.surface)
        )
        .padding(.horizontal, Metrics.hPadding)
        .padding(.top, 8)
        .accessibilityIdentifier("forward.source")
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Palette.paperMuted)
            TextField("Search servers, channels and chats", text: $model.query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(Palette.paper)
                .accessibilityIdentifier("forward.search")
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                .fill(Palette.surfaceRaised)
        )
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private func section(_ title: String, rows: [ForwardTarget]) -> some View {
        if !rows.isEmpty {
            SectionLabel(text: title)
                .padding(.horizontal, Metrics.hPadding)
                .padding(.top, 8)
                .padding(.bottom, 2)
            ForEach(rows) { target in row(target) }
        }
    }

    private func row(_ target: ForwardTarget) -> some View {
        let picked = model.isSelected(target)
        let note = model.message(for: target)
        let sent = model.outcomes[target.id]?.ok == true
        return Button {
            Haptics.selection()
            withAnimation(Motion.standard) { model.toggle(target) }
        } label: {
            HStack(spacing: 12) {
                Avatar(name: target.title, seed: target.seed, size: 36, url: target.iconUrl)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: target.title)
                        .font(Typography.bodyMedium)
                        .foregroundStyle(Palette.paper)
                        .lineLimit(1)
                    if let subtitle = target.subtitle {
                        Text(verbatim: subtitle)
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                            .lineLimit(1)
                    }
                    if let note {
                        Text(verbatim: note)
                            .font(Typography.caption)
                            .foregroundStyle(Palette.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("forward.row.error")
                    } else if sent {
                        Text("Forwarded")
                            .font(Typography.caption)
                            .foregroundStyle(Palette.success)
                            .accessibilityIdentifier("forward.row.sent")
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: picked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22))
                    .foregroundStyle(picked ? Palette.signal : Palette.paperMuted)
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
            .opacity(model.isDisabled(target) ? 0.4 : 1)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(picked ? .isSelected : [])
        .accessibilityIdentifier("forward.row.\(target.channelId)")
    }

    // MARK: Composer

    private var composer: some View {
        VStack(spacing: 8) {
            if model.showsFullNotice {
                Text("You can pick up to 5.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.warning)
                    .transition(.opacity)
                    .accessibilityIdentifier("forward.full")
            }
            if let failure = model.failure {
                Text(verbatim: failure)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("forward.failure")
            }
            HStack(spacing: 10) {
                TextField("Add a comment", text: $model.comment, axis: .vertical)
                    .lineLimit(1...3)
                    .focused($commentFocused)
                    .foregroundStyle(Palette.paper)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                            .fill(Palette.surfaceRaised)
                    )
                    .accessibilityIdentifier("forward.comment")

                Button {
                    commentFocused = false
                    Task {
                        if let toast = await model.send(session: session) {
                            session.forwardToast = toast
                            dismiss()
                        }
                    }
                } label: {
                    sendLabel
                        .font(Typography.bodyMedium)
                        .foregroundStyle(Palette.inkDeep)
                        .padding(.horizontal, 16)
                        .frame(minWidth: 84, minHeight: 44)
                        .background(Capsule().fill(Palette.signal))
                        .opacity(model.canSend ? 1 : 0.4)
                }
                .buttonStyle(.plain)
                .disabled(!model.canSend)
                .accessibilityIdentifier("forward.send")
            }
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .background(Palette.inkDeep)
        .animation(Motion.standard, value: model.showsFullNotice)
    }

    @ViewBuilder
    private var sendLabel: some View {
        if model.isSending {
            ProgressView().tint(Palette.inkDeep)
        } else if model.hasTransientFailure {
            Text("Try again")
        } else if model.pendingTargets.isEmpty {
            Text("Send")
        } else {
            Text("Send to \(model.pendingTargets.count)")
        }
    }
}

// MARK: - Presenting it

extension View {
    /// The picker as a sheet over whatever asked for it.
    func forwardSheet(_ source: Binding<ForwardSource?>) -> some View {
        sheet(item: source) { source in
            ForwardPickerView(source: source)
                .presentationBackground(Palette.ink)
        }
    }
}

// MARK: - The toast

/// The toast at the app root, so it outlives the sheet that made it.
struct ForwardToastLayer: View {
    @Environment(SessionStore.self) private var session

    var body: some View {
        if session.phase == .ready, let toast = session.forwardToast {
            ForwardToastView(
                toast: toast,
                onView: {
                    if let target = toast.open { session.requestNavigation(target) }
                    withAnimation(Motion.standard) { session.forwardToast = nil }
                },
                onDismiss: {
                    withAnimation(Motion.standard) { session.forwardToast = nil }
                }
            )
            .padding(.top, 8)
            .transition(.opacity)
            .zIndex(3)
        }
    }
}

/// "Encaminhado" with a "Ver" that opens the first place it went. Dismisses
/// itself; under Reduce Motion it fades rather than slides.
struct ForwardToastView: View {
    let toast: ForwardToast
    let onView: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Palette.signal)
                .accessibilityHidden(true)
            Group {
                if toast.count > 1 {
                    Text("Forwarded to \(toast.count) places")
                } else {
                    Text("Forwarded")
                }
            }
            .font(Typography.bodyMedium)
            .foregroundStyle(Palette.paper)
            Spacer(minLength: 0)
            if toast.open != nil {
                Button(action: onView) {
                    Text("View")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.inkDeep)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 32)
                        .background(Capsule().fill(Palette.signal))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("forward.toast.view")
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .fill(Palette.surfaceRaised)
                .shadow(color: .black.opacity(0.35), radius: 18, y: 8)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .strokeBorder(Palette.signal.opacity(0.35), lineWidth: 1)
        )
        .padding(.horizontal, Metrics.hPadding)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("forward.toast")
        .task(id: toast.id) {
            try? await Task.sleep(for: .seconds(6))
            onDismiss()
        }
    }
}

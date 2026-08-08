import SwiftUI

// MARK: - Who the sheet is about

/// The person a profile sheet is opened on.
///
/// Deliberately its own small shape rather than one of the wire models: a
/// profile can be opened from a message (`Message`), from the members list
/// (`ServerMember`) or from a search result (`PublicUser`), and those three
/// carry the same four facts under different field names. Converting at the
/// call site keeps the sheet from knowing which screen it came from.
struct ProfileSubject: Identifiable, Hashable, Sendable {
    let id: String
    let displayName: String
    /// `name#1234`. Absent for a webhook author and for accounts that predate
    /// handles, in which case the line is simply not drawn.
    let tag: String?
    let avatarUrl: String?
    /// Presence the caller *already* knows (the members list resolves it
    /// server-side). Never guessed: there is no per-user presence endpoint, so
    /// nil here means "unknown", which is drawn as nothing rather than as
    /// "offline" — claiming someone is away because we failed to look is worse
    /// than saying nothing.
    var status: String?

    init(id: String, displayName: String, tag: String?, avatarUrl: String?, status: String? = nil) {
        self.id = id
        self.displayName = displayName
        self.tag = tag
        self.avatarUrl = avatarUrl
        self.status = status
    }

    init(message: Message) {
        self.init(id: message.authorId, displayName: message.authorName,
                  tag: message.authorTag, avatarUrl: message.authorAvatarUrl)
    }

    init(member: ServerMember) {
        self.init(id: member.id, displayName: member.displayName,
                  tag: member.tag, avatarUrl: member.avatarUrl, status: member.status)
    }

    init(user: PublicUser, status: String? = nil) {
        self.init(id: user.id, displayName: user.displayName,
                  tag: user.tag, avatarUrl: user.avatarUrl, status: status)
    }
}

// MARK: - Relationship state (pure)

/// Where you stand with someone, as the three lists in `GET /api/friends` plus
/// the block list describe it.
///
/// One enum rather than four booleans because the states are exclusive and the
/// buttons differ per state — a screen that reasons about `isFriend &&
/// !isBlocked && !hasOutgoing` grows a wrong combination eventually.
enum FriendshipState: String, Sendable, Hashable, CaseIterable {
    /// You, looking at yourself. Every relationship action is meaningless.
    case isSelf
    /// You blocked them. Outranks everything else, including friendship: the
    /// schema's trigger deletes the friend row when a block lands, so the two
    /// cannot legitimately coexist — and if a stale read says they do, the
    /// block is the fact with consequences.
    case blocked
    case friends
    /// They asked you. The one state with a one-tap answer.
    case pendingIncoming
    /// You asked them. Nothing to do but wait, or take it back.
    case pendingOutgoing
    case none
}

/// The single relationship button the sheet offers for a state.
enum FriendshipAction: String, Sendable, Hashable {
    case addFriend
    case acceptRequest
    case cancelRequest
    case removeFriend
    case unblock
    /// Your own profile: there is no relationship to act on.
    case noneAvailable

    var title: LocalizedStringKey {
        switch self {
        case .addFriend: "Add friend"
        case .acceptRequest: "Accept friend request"
        case .cancelRequest: "Cancel request"
        case .removeFriend: "Remove friend"
        case .unblock: "Unblock"
        case .noneAvailable: ""
        }
    }

    var systemImage: String {
        switch self {
        case .addFriend: "person.badge.plus"
        case .acceptRequest: "checkmark.circle"
        case .cancelRequest: "clock.arrow.circlepath"
        case .removeFriend: "person.badge.minus"
        case .unblock: "hand.raised.slash"
        case .noneAvailable: "person"
        }
    }

    /// Whether the action needs confirming before it fires. Adding, accepting
    /// and unblocking are all cheap and reversible; the three that end
    /// something are not — and "remove friend" in particular is silent, so a
    /// mis-tap is invisible to the other side and uncorrectable by them.
    var needsConfirmation: Bool {
        switch self {
        case .removeFriend, .cancelRequest: true
        case .addFriend, .acceptRequest, .unblock, .noneAvailable: false
        }
    }

    var isDestructive: Bool {
        switch self {
        case .removeFriend, .cancelRequest: true
        case .addFriend, .acceptRequest, .unblock, .noneAvailable: false
        }
    }
}

/// The profile sheet's logic, out of the view so the state machine is testable
/// without a screen or a network. Every function here is pure.
enum ProfileRelations {
    /// Resolve the one state that applies. Order matters and is stated in
    /// `FriendshipState`: self, then blocked, then friends, then the two
    /// pending directions.
    static func state(
        for userId: String,
        selfId: String?,
        friends: FriendsResponse,
        blockedIds: Set<String>
    ) -> FriendshipState {
        if let selfId, selfId == userId { return .isSelf }
        if blockedIds.contains(userId) { return .blocked }
        if friends.friends.contains(where: { $0.id == userId }) { return .friends }
        if friends.incoming.contains(where: { $0.id == userId }) { return .pendingIncoming }
        if friends.outgoing.contains(where: { $0.id == userId }) { return .pendingOutgoing }
        return .none
    }

    static func action(for state: FriendshipState) -> FriendshipAction {
        switch state {
        case .isSelf: .noneAvailable
        case .blocked: .unblock
        case .friends: .removeFriend
        case .pendingIncoming: .acceptRequest
        case .pendingOutgoing: .cancelRequest
        case .none: .addFriend
        }
    }

    /// Declining is offered *beside* accepting rather than behind a menu — a
    /// request you did not want should cost one tap, and it is silent, so the
    /// only way it can go wrong is by being hard to reach.
    static func offersDecline(_ state: FriendshipState) -> Bool {
        state == .pendingIncoming
    }

    /// DMs to yourself are not a thing the server models, and a DM to someone
    /// you blocked would be a message you cannot see the answer to. Everything
    /// else is offered — a refusal is still possible (`dmPrivacy`) and the
    /// server's wording is what gets shown when it happens.
    static func canMessage(_ state: FriendshipState) -> Bool {
        state != .isSelf && state != .blocked
    }

    static func canBlock(_ state: FriendshipState) -> Bool {
        state != .isSelf && state != .blocked
    }

    static func canReport(_ state: FriendshipState) -> Bool {
        state != .isSelf
    }

    /// Presence to draw. A friend's status comes from the friends list, which
    /// is the freshest thing we have; anything else falls back to whatever the
    /// caller knew. `nil` means "we do not know" and must draw nothing.
    static func presence(
        for userId: String,
        state: FriendshipState,
        friends: FriendsResponse,
        fallback: String?
    ) -> String? {
        if state == .friends,
           let friend = friends.friends.first(where: { $0.id == userId }) {
            return friend.status
        }
        return fallback
    }
}

// MARK: - The sheet

/// A person, and everything you can do about them from wherever you tapped.
///
/// This exists because there was no answer to "how do I add the person who just
/// said that to my friends" — the friends screen could only be reached from the
/// home tabs, and it wanted a full `name#1234` you would have to already know.
/// A tap on an avatar in the transcript is the discovery path that was missing.
struct UserProfileSheet: View {
    @Environment(SessionStore.self) private var session
    /// For the call button, which is only offered when a DM already exists —
    /// a call is placed into a conversation, not at a person.
    @Environment(CallModel.self) private var call
    @Environment(\.dismiss) private var dismiss
    let subject: ProfileSubject
    /// Where a DM should be opened. The sheet does not own navigation — it
    /// hands the conversation back and dismisses itself. Nil where the caller
    /// has nowhere to push a chat, and then Message is not offered at all: a
    /// button that opens a conversation you are not taken to is a button that
    /// looks broken.
    var onOpenConversation: ((DmSummary) -> Void)?

    @State private var friends = FriendsResponse()
    @State private var blockedIds: Set<String> = []
    /// The one-to-one conversation with this person, when there already is one.
    /// Reused by Message (so it does not create a second) and required by Call.
    @State private var existingDm: DmSummary?
    @State private var loading = true
    @State private var busy = false
    @State private var message: String?
    @State private var isFailure = false
    @State private var confirming: FriendshipAction?
    @State private var confirmingBlock = false
    @State private var reportTarget: ReportTarget?

    private var state: FriendshipState {
        ProfileRelations.state(
            for: subject.id, selfId: session.currentUser?.id,
            friends: friends, blockedIds: blockedIds
        )
    }

    private var action: FriendshipAction { ProfileRelations.action(for: state) }

    private var presence: String? {
        ProfileRelations.presence(
            for: subject.id, state: state, friends: friends, fallback: subject.status
        )
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Palette.ink.ignoresSafeArea()

            // No navigation bar: the sheet is one card, and a title bar over a
            // banner reads as a screen that got put in a sheet by accident.
            // Height is bounded by the detent instead, and the content is sized
            // to fit the medium one without scrolling in the common case.
            ScrollView {
                VStack(spacing: 0) {
                    banner
                    identity
                    if let message {
                        Text(message)
                            .font(Typography.callout)
                            .foregroundStyle(isFailure ? Palette.danger : Palette.signal)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, Metrics.hPadding)
                            .padding(.top, 10)
                    }
                    actions
                        .padding(.horizontal, Metrics.hPadding)
                        .padding(.top, 16)
                        .padding(.bottom, 24)
                }
            }

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Palette.paper)
                    .padding(8)
                    .background(Circle().fill(.black.opacity(0.35)))
            }
            .padding(12)
            .accessibilityIdentifier("profile.done")
            .accessibilityLabel("Done")
        }
        .sheet(item: $reportTarget) { target in ReportSheet(target: target) }
        .confirmationDialog(
            confirmPrompt,
            isPresented: Binding(
                get: { confirming != nil },
                set: { if !$0 { confirming = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let confirming {
                Button(confirming.title, role: .destructive) {
                    let pending = confirming
                    self.confirming = nil
                    Task { await run(pending) }
                }
            }
            Button("Cancel", role: .cancel) { confirming = nil }
        }
        .confirmationDialog(
            String(localized: "Block \(subject.displayName)?"),
            isPresented: $confirmingBlock,
            titleVisibility: .visible
        ) {
            Button("Block", role: .destructive) { Task { await block() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Blocking also ends the friendship and hides their messages.")
        }
        .task { await load() }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    // MARK: - Header

    /// There are no user banners on the server, so the band is drawn from the
    /// same hue the monogram avatar derives from the account id — the person's
    /// colour, consistently, without inventing a field to store one.
    private var banner: some View {
        let hue = Avatar.hue(seed: subject.id)
        return LinearGradient(
            colors: [
                Color(hue: hue, saturation: 0.5, brightness: 0.55),
                Color(hue: hue, saturation: 0.35, brightness: 0.28),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .frame(height: 96)
        .frame(maxWidth: .infinity)
    }

    private var identity: some View {
        VStack(spacing: 4) {
            Avatar(name: subject.displayName, seed: subject.id, size: 92, url: subject.avatarUrl)
                // The ground colour behind the avatar is what makes it read as
                // *overlapping* the banner rather than sitting on top of it.
                .background(
                    Circle().fill(Palette.ink).frame(width: 102, height: 102)
                )
                .overlay(alignment: .bottomTrailing) {
                    if presence != nil {
                        StatusDot(status: presence, size: 22)
                            .offset(x: -4, y: -4)
                    }
                }
                // Half of it hangs over the banner; the negative padding is
                // what stops the name from being pushed down by the overlap.
                .offset(y: -46)
                .padding(.bottom, -40)

            Text(subject.displayName)
                .font(Typography.title(24))
                .foregroundStyle(Palette.paper)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("profile.displayName")

            HStack(spacing: 6) {
                if let tag = subject.tag {
                    Text(tag)
                        .font(Typography.mono)
                        .foregroundStyle(Palette.paperMuted)
                        .textSelection(.enabled)
                }
                if let presence, subject.tag != nil {
                    Text("•").foregroundStyle(Palette.border)
                }
                if let presence {
                    Text(presenceLabel(presence))
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                }
            }

            if state == .friends,
               let friend = friends.friends.first(where: { $0.id == subject.id }) {
                Text("Friends since \(friend.friendsSince, format: .dateTime.month().year())")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, Metrics.hPadding)
    }

    // MARK: - Actions

    /// One row, in the order the errand actually runs: the relationship is the
    /// wide primary, and the two things you might do *with* someone — message,
    /// call — are compact squares beside it. Everything punitive lives behind
    /// the ellipsis, because a Block button the same size as Add friend makes a
    /// profile card read as a moderation console.
    @ViewBuilder
    private var actions: some View {
        if loading {
            ProgressView().tint(Palette.signal).padding(.vertical, 20)
        } else if state == .isSelf {
            Text("This is you.")
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
                .padding(.vertical, 12)
        } else {
            VStack(spacing: 10) {
                HStack(spacing: 8) {
                    ProfilePrimaryButton(
                        title: action.title,
                        systemImage: action.systemImage,
                        isDestructive: action.isDestructive,
                        isBusy: busy
                    ) {
                        if action.needsConfirmation {
                            confirming = action
                        } else {
                            Task { await run(action) }
                        }
                    }

                    if ProfileRelations.canMessage(state), onOpenConversation != nil {
                        ProfileIconButton(
                            systemImage: "bubble.left.fill",
                            label: "Message",
                            identifier: "profile.message",
                            isBusy: busy
                        ) {
                            Task { await openConversation() }
                        }
                    }

                    // Calling needs a conversation to ring, so it is offered
                    // only when one already exists — starting a call by
                    // creating a DM the other person has never seen is not a
                    // thing to do to somebody.
                    if ProfileRelations.canMessage(state), let existing = existingDm {
                        ProfileIconButton(
                            systemImage: "phone.fill",
                            label: "Call",
                            identifier: "profile.call",
                            isBusy: call.phase.isLive
                        ) {
                            Task { await call.start(conversation: existing, withVideo: false) }
                            dismiss()
                        }
                    }

                    if ProfileRelations.canBlock(state) || ProfileRelations.canReport(state) {
                        Menu {
                            if ProfileRelations.canBlock(state) {
                                Button(role: .destructive) {
                                    confirmingBlock = true
                                } label: {
                                    Label("Block", systemImage: "hand.raised")
                                }
                            }
                            if ProfileRelations.canReport(state) {
                                Button(role: .destructive) {
                                    reportTarget = .user(
                                        id: subject.id,
                                        displayName: subject.displayName,
                                        serverId: nil
                                    )
                                } label: {
                                    Label("Report", systemImage: "flag")
                                }
                            }
                        } label: {
                            ProfileIconLabel(systemImage: "ellipsis")
                        }
                        .accessibilityIdentifier("profile.more")
                        .accessibilityLabel("More")
                    }
                }

                // Declining is offered inline rather than behind the menu: a
                // request you did not want should cost one tap, and it is
                // silent, so the only way it can go wrong is by being hard to
                // reach.
                if ProfileRelations.offersDecline(state) {
                    Button {
                        Task { await run(.cancelRequest) }
                    } label: {
                        Text("Decline")
                            .font(Typography.callout)
                            .foregroundStyle(Palette.paperMuted)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                    .accessibilityIdentifier("profile.decline")
                }
            }
        }
    }

    private var confirmPrompt: String {
        switch confirming {
        case .removeFriend: String(localized: "Remove \(subject.displayName)?")
        case .cancelRequest: String(localized: "Cancel your request to \(subject.displayName)?")
        default: ""
        }
    }

    private func presenceLabel(_ status: String) -> LocalizedStringKey {
        switch status {
        case "online": "Online"
        case "idle": "Idle"
        case "dnd": "Do not disturb"
        default: "Offline"
        }
    }

    // MARK: - Work

    private func load() async {
        loading = true
        // Two reads, because the two facts live in two places server-side and
        // neither implies the other. Concurrent: they are independent, and the
        // sheet is showing a spinner until both land.
        // Hoisted: `async let` runs its initializer off this actor, so it must
        // capture the (Sendable) client rather than the main-actor session.
        let api = session.api
        async let friendsResponse = try? await api.friends()
        async let blocks = try? await api.blocks()
        // The DM list is already an endpoint every client calls on launch, so
        // this is a cheap third read rather than a new surface — and it is what
        // decides whether Call is offered at all.
        async let conversations = try? await api.conversations()
        friends = await friendsResponse ?? FriendsResponse()
        blockedIds = Set((await blocks ?? []).map(\.id))
        existingDm = (await conversations ?? []).first { conversation in
            // A one-to-one DM, not a group: the participant list the server
            // sends excludes us, so exactly this person and nobody else.
            conversation.participants.count == 1
                && conversation.participants[0].id == subject.id
        }
        loading = false
    }

    private func run(_ action: FriendshipAction) async {
        busy = true
        defer { busy = false }
        do {
            switch action {
            case .addFriend:
                let result = try await session.api.sendFriendRequest(userId: subject.id)
                note(result.isAccepted
                     ? String(localized: "You're now friends.")
                     : String(localized: "Request sent."), failed: false)
            case .acceptRequest:
                try await session.api.acceptFriendRequest(userId: subject.id)
                note(String(localized: "You're now friends."), failed: false)
            // Decline, cancel and unfriend are one call server-side — the
            // difference between them is entirely who is looking.
            case .cancelRequest, .removeFriend:
                try await session.api.removeFriendship(userId: subject.id)
                message = nil
            case .unblock:
                try await session.api.setBlocked(userId: subject.id, blocked: false)
                message = nil
            case .noneAvailable:
                return
            }
            await load()
        } catch {
            // Verbatim. The server answers every refused friend request with
            // one sentence on purpose; paraphrasing it here would turn the
            // sheet into a probe for who has blocked you.
            note((error as? APIError)?.errorDescription ?? error.localizedDescription, failed: true)
        }
    }

    private func block() async {
        busy = true
        defer { busy = false }
        do {
            // No separate unfriend call: the block's trigger deletes the
            // friendship row itself, and issuing both would race it.
            try await session.api.setBlocked(userId: subject.id, blocked: true)
            await load()
        } catch {
            note((error as? APIError)?.errorDescription ?? error.localizedDescription, failed: true)
        }
    }

    private func openConversation() async {
        // Already know it: no round trip, and no chance of the server handing
        // back a differently-shaped summary for a conversation we can see.
        if let existingDm {
            onOpenConversation?(existingDm)
            dismiss()
            return
        }
        busy = true
        defer { busy = false }
        do {
            let conversation = try await session.api.openConversation(userIds: [subject.id])
            onOpenConversation?(conversation)
            dismiss()
        } catch {
            note((error as? APIError)?.errorDescription ?? error.localizedDescription, failed: true)
        }
    }

    private func note(_ text: String, failed: Bool) {
        isFailure = failed
        message = text
    }
}

/// The relationship button: the wide one, and the only one on the card that
/// carries the loud colour.
private struct ProfilePrimaryButton: View {
    let title: LocalizedStringKey
    let systemImage: String
    var isDestructive = false
    var isBusy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isBusy {
                    ProgressView().tint(Palette.inkDeep)
                } else {
                    Image(systemName: systemImage).font(.system(size: 15, weight: .semibold))
                }
                Text(title).font(Typography.bodyMedium)
            }
            .foregroundStyle(isDestructive ? Palette.paper : Palette.inkDeep)
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .fill(isDestructive ? Palette.surfaceRaised : Palette.signal)
            )
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
        .accessibilityIdentifier("profile.friendAction")
    }
}

/// A compact square beside the primary. Same height, so the row reads as one
/// control group rather than as a button and some decorations.
private struct ProfileIconLabel: View {
    let systemImage: String

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(Palette.paper)
            .frame(width: 50, height: 50)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .fill(Palette.surfaceRaised)
            )
    }
}

private struct ProfileIconButton: View {
    let systemImage: String
    let label: LocalizedStringKey
    let identifier: String
    var isBusy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ProfileIconLabel(systemImage: systemImage)
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
        .accessibilityIdentifier(identifier)
        .accessibilityLabel(label)
    }
}

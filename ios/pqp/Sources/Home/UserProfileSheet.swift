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

/// A rung of the enforcement ladder, as the profile sheet offers it.
///
/// Named cases rather than a closure per button so the prompt, the verb and the
/// "does this need confirming" answer cannot drift apart — the same reason
/// `FriendsModel.Confirmation` is a enum.
enum ModerationRung: Identifiable {
    case timeout
    case endTimeout
    case kick
    case ban

    var id: String { String(describing: self) }

    var label: LocalizedStringKey {
        switch self {
        case .timeout: "Time out…"
        case .endTimeout: "End timeout"
        case .kick: "Remove from the community"
        case .ban: "Ban from the community"
        }
    }

    var icon: String {
        switch self {
        case .timeout: "clock.badge.exclamationmark"
        case .endTimeout: "clock.arrow.circlepath"
        case .kick: "person.fill.xmark"
        case .ban: "hand.raised.fill"
        }
    }

    /// Ending a timeout gives something back; the other three take something
    /// away. Colouring the whole block red would flatten the ladder that the
    /// order is trying to express.
    var isDestructive: Bool { self != .endTimeout }

    /// Confirmed only when something is lost that the person cannot get back by
    /// themselves. A timeout expires on its own and is lifted in one tap, and it
    /// needs a duration picked anyway — that picker IS its confirmation.
    var needsConfirmation: Bool { self == .kick || self == .ban }

    func prompt(_ name: String) -> String {
        switch self {
        case .kick: String(localized: "Remove \(name) from this community?")
        case .ban: String(localized: "Ban \(name) from this community?")
        case .timeout, .endTimeout: ""
        }
    }

    var explanation: LocalizedStringKey {
        switch self {
        case .kick: "They lose access now but can rejoin with any invite."
        case .ban: "They lose access and can't rejoin. The reason is kept on the ban list."
        case .timeout, .endTimeout: ""
        }
    }

    var actionLabel: LocalizedStringKey {
        switch self {
        case .kick: "Remove"
        case .ban: "Ban"
        case .timeout: "Time out"
        case .endTimeout: "End timeout"
        }
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
    /// The second parameter is a DRAFT to open the composer with, and it is
    /// empty for every path but one: the depoimento composer's DM fork hands the
    /// typed text across so the escape hatch does not make anybody retype what
    /// they wrote. See rule 2 in DepoimentoViews.swift.
    var onOpenConversation: ((DmSummary, String) -> Void)?
    /// The server this sheet was opened inside, and this account's rank in it.
    ///
    /// Nil in a conversation, and nil for the callers that have no server to
    /// name — a DM has no moderators at all. When it is set it does two things:
    /// it files a report with that server's moderators instead of the instance
    /// (the `serverId: nil` this sheet used to hardcode sent every report from a
    /// server channel to the wrong queue), and it unlocks the enforcement ladder
    /// behind the ellipsis for somebody who may use it.
    var server: Server?

    @State private var friends = FriendsResponse()
    @State private var blockedIds: Set<String> = []
    /// This person's rank in `server`, once known. `nil` means "not asked yet or
    /// not a member", and either way the ladder is not drawn: a card opened on a
    /// name in a channel is about somebody in that server, and a kick offered
    /// against a non-member would come back 404.
    @State private var targetRole: String?
    /// Whether a timeout is already running on them, so the menu offers ending
    /// one rather than a second.
    @State private var isTimedOut = false
    /// The rung awaiting confirmation, and the reason being typed for a ban.
    @State private var confirmingModeration: ModerationRung?
    @State private var banReason = ""
    @State private var timeoutSheet = false
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
    /// What this person chose to display, and the rooms they are in. Both hide
    /// themselves when empty — there is no count and no zero anywhere on this
    /// card. See `DepoimentoViews`.
    @State private var depoimentos: [Depoimento] = []
    @State private var communities = ProfileCommunityList()
    @State private var composing = false
    /// The last thing a depoimento action said, kept apart from `message` so a
    /// friend-action note and a depoimento note cannot overwrite each other.
    @State private var removingDepoimento: String?
    /// Text the DM fork is carrying out of the composer. Empty on every other
    /// path through `openConversation`.
    @State private var draft = ""

    private var state: FriendshipState {
        ProfileRelations.state(
            for: subject.id, selfId: session.currentUser?.id,
            friends: friends, blockedIds: blockedIds
        )
    }

    private var action: FriendshipAction { ProfileRelations.action(for: state) }

    /// Which rungs to draw. `Moderation.canModerate` is the single judge — the
    /// same one `MembersView` now asks and the same rule
    /// `packages/shared/src/moderation.ts` states for the web — so this surface
    /// cannot offer an action the API will refuse on rank.
    private var moderationRungs: [ModerationRung] {
        guard state != .isSelf, let server, let role = targetRole else { return [] }
        guard Moderation.canModerate(
            actorRole: server.role,
            actorId: session.currentUser?.id,
            targetRole: role,
            targetId: subject.id
        ) else { return [] }
        return isTimedOut ? [.endTimeout, .kick, .ban] : [.timeout, .kick, .ban]
    }

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

                    // Below the actions on purpose: this card exists to answer
                    // "who is this and what can I do about them", and the
                    // testimonials are what you read once that is settled.
                    VStack(alignment: .leading, spacing: 16) {
                        CommunityBadges(list: communities)
                        DepoimentosSection(
                            depoimentos: depoimentos,
                            // Only your own card gets the take-down button. Any
                            // published one, any time, without notice — which is
                            // what makes publishing safe to do in the first place.
                            onRemove: state == .isSelf ? { id in
                                Task { await removeDepoimento(id) }
                            } : nil,
                            busy: removingDepoimento != nil
                        )
                    }
                    .padding(.horizontal, Metrics.hPadding)
                    .padding(.top, 18)
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
        .sheet(isPresented: $composing) {
            DepoimentoComposer(
                subject: subject,
                onWritten: {
                    // Nothing to add to the list: it landed PENDING, and the
                    // only person who will ever see it before publication is its
                    // subject. Saying so is the whole feedback there is.
                    note(
                        String(localized: "Sent to \(subject.displayName). They decide if it goes up."),
                        failed: false
                    )
                },
                onSendAsDm: { text in
                    draft = text
                    composing = false
                    Task { await openConversation() }
                }
            )
        }
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
        // Kick and ban: both end a membership, so both are confirmed. iOS fired
        // them straight through before this — one long-press and a stray tap
        // banned somebody, with nothing between.
        .confirmationDialog(
            confirmingModeration?.prompt(subject.displayName) ?? "",
            isPresented: Binding(
                get: { confirmingModeration != nil },
                set: { if !$0 { confirmingModeration = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let rung = confirmingModeration {
                Button(rung.actionLabel, role: .destructive) {
                    confirmingModeration = nil
                    Task { await apply(rung, minutes: nil) }
                }
            }
            Button("Cancel", role: .cancel) { confirmingModeration = nil }
        } message: {
            Text(confirmingModeration?.explanation ?? "")
        }
        // The timeout picker. A sheet rather than a submenu of durations because
        // it also collects the reason — the field iOS used to hardcode as nil,
        // and the only record of *why* the sanction happened that a moderator
        // sees later without opening the audit log.
        .sheet(isPresented: $timeoutSheet) {
            TimeoutComposer(name: subject.displayName, reason: $banReason) { minutes in
                timeoutSheet = false
                Task { await apply(.timeout, minutes: minutes) }
            }
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

                    if ProfileRelations.canBlock(state)
                        || ProfileRelations.canReport(state)
                        || !moderationRungs.isEmpty {
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
                                        // The server whose moderators should see
                                        // this, when the sheet knows one. Nil
                                        // sends it to the instance queue, which
                                        // is right for a DM and was wrong for
                                        // every report filed from a channel.
                                        serverId: server?.id
                                    )
                                } label: {
                                    Label("Report", systemImage: "flag")
                                }
                            }
                            // The ladder, last and in order. Empty for a
                            // conversation, for a plain member, and for anybody
                            // the rank rule protects — so a member's menu is
                            // exactly the two entries it has always been.
                            ForEach(moderationRungs) { rung in
                                Button(role: rung.isDestructive ? .destructive : nil) {
                                    if rung == .timeout {
                                        timeoutSheet = true
                                    } else if rung.needsConfirmation {
                                        confirmingModeration = rung
                                    } else {
                                        Task { await apply(rung, minutes: nil) }
                                    }
                                } label: {
                                    Label(rung.label, systemImage: rung.icon)
                                }
                            }
                        } label: {
                            ProfileIconLabel(systemImage: "ellipsis")
                        }
                        .accessibilityIdentifier("profile.more")
                        .accessibilityLabel("More")
                    }
                }

                // Friends only, and never behind the ellipsis: writing one is
                // the warm thing you can do from this card, and the menu it
                // would otherwise share is where blocking and banning live.
                // `Depoimentos.canWrite` is deliberately stricter than "not a
                // stranger" — half a handshake would earn a 403 nobody can
                // explain.
                if Depoimentos.canWrite(state) {
                    Button { composing = true } label: {
                        Label("Write a depoimento", systemImage: "quote.bubble")
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(busy)
                    .accessibilityIdentifier("profile.writeDepoimento")
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
        await loadModeration()
        await loadProfileExtras()
    }

    /// The two blocks under the actions, both of which hide themselves when
    /// empty.
    ///
    /// AFTER the spinner clears, like the moderation reads and for the same
    /// reason: the relationship buttons are the point of this sheet and must not
    /// wait on two decorative lists. Neither read is fatal — a card with no
    /// depoimentos is a card, and a failure here must look exactly like a person
    /// who has none.
    private func loadProfileExtras() async {
        let api = session.api
        let userId = subject.id
        async let published = try? await api.depoimentos(userId: userId)
        async let rooms = try? await api.profileCommunities(userId: userId)
        depoimentos = await published ?? []
        communities = await rooms ?? ProfileCommunityList()
    }

    /// Take one of your own down. Silent, and available at any time — which is
    /// what makes publishing safe to do in the first place.
    private func removeDepoimento(_ id: String) async {
        removingDepoimento = id
        defer { removingDepoimento = nil }
        do {
            try await session.api.deleteDepoimento(id: id)
            depoimentos.removeAll { $0.id == id }
        } catch {
            note((error as? APIError)?.errorDescription ?? error.localizedDescription,
                 failed: true)
        }
    }

    /// This person's rank, and whether they are already timed out.
    ///
    /// AFTER the spinner clears, not inside it: the friend actions are the point
    /// of this sheet and must not wait on two reads that only a moderator's menu
    /// consumes. And only for a manager — a plain member is not allowed to ask
    /// for either list and has nothing to draw with the answer, so they make no
    /// request at all.
    private func loadModeration() async {
        guard let server, Moderation.isManager(server.role) else {
            targetRole = nil
            isTimedOut = false
            return
        }
        let api = session.api
        let serverId = server.id
        async let roster = try? await api.members(serverId: serverId)
        async let timeouts = try? await api.activeTimeouts(serverId: serverId)
        targetRole = (await roster ?? []).first { $0.id == subject.id }?.role
        isTimedOut = (await timeouts ?? []).contains { $0.userId == subject.id }
    }

    /// Run a rung. `minutes` is set only for `.timeout`.
    ///
    /// The server's own sentence is shown for a timeout — it names when the
    /// sanction ends and what it takes away, and it is the same string the
    /// sanctioned person reads, so the two sides cannot disagree about it.
    private func apply(_ rung: ModerationRung, minutes: Int?) async {
        guard let server else { return }
        busy = true
        defer { busy = false }
        do {
            switch rung {
            case .timeout:
                let issued = try await session.api.issueTimeout(
                    serverId: server.id,
                    userId: subject.id,
                    minutes: minutes ?? Moderation.timeoutPresets[1].minutes,
                    // The reason iOS used to hardcode as nil. It is the only
                    // thing the members panel can show later about *why*.
                    reason: banReason.isEmpty ? nil : banReason
                )
                banReason = ""
                note(issued.message, failed: false)
            case .endTimeout:
                try await session.api.liftTimeout(serverId: server.id, userId: subject.id)
                note(String(localized: "\(subject.displayName) can speak again."), failed: false)
            case .kick:
                // `ban: false` — a kick and a ban are one route server-side, and
                // the ban case below deliberately takes the *other* route
                // because only that one carries a reason.
                try await session.api.removeMember(
                    serverId: server.id, userId: subject.id, ban: false
                )
                note(String(localized: "\(subject.displayName) was removed from the community."),
                     failed: false)
            case .ban:
                try await session.api.banMember(
                    serverId: server.id, userId: subject.id,
                    reason: banReason.isEmpty ? nil : banReason
                )
                banReason = ""
                note(String(localized: "\(subject.displayName) was banned."), failed: false)
            }
            await loadModeration()
        } catch {
            note((error as? APIError)?.errorDescription ?? error.localizedDescription,
                 failed: true)
        }
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
            onOpenConversation?(existingDm, draft)
            dismiss()
            return
        }
        busy = true
        defer { busy = false }
        do {
            let conversation = try await session.api.openConversation(userIds: [subject.id])
            onOpenConversation?(conversation, draft)
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

// MARK: - Timeout composer

/// Pick how long, and say why.
///
/// A sheet rather than four menu entries because of the second half: the reason.
/// iOS shipped timeouts with `reason: nil` hardcoded, so every sanction issued
/// from a phone became a row in the members panel with a blank explanation —
/// precisely the field that panel draws to answer "why is this person silenced".
/// A duration submenu is faster to build and leaves the record useless.
///
/// The durations are `Moderation.timeoutPresets`, which mirrors
/// `TIMEOUT_PRESET_MINUTES` in shared, so both clients offer the same four.
struct TimeoutComposer: View {
    let name: String
    @Binding var reason: String
    let onApply: (Int) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var minutes = Moderation.timeoutPresets[1].minutes

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                VStack(alignment: .leading, spacing: 14) {
                    Text("They can still read. They can't post, react or join voice in this community until it ends.")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)

                    Picker("How long", selection: $minutes) {
                        ForEach(Moderation.timeoutPresets, id: \.minutes) { preset in
                            Text(preset.label).tag(preset.minutes)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("timeout.duration")

                    TextField("Reason (optional)", text: $reason)
                        .textFieldStyle(.plain)
                        .foregroundStyle(Palette.paper)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        .pqpSurface(cornerRadius: 14)
                        .accessibilityIdentifier("timeout.reason")

                    Button {
                        onApply(minutes)
                    } label: {
                        Text("Time out \(name)")
                            .font(Typography.bodyMedium)
                            .foregroundStyle(Palette.paper)
                            .frame(maxWidth: .infinity)
                            .frame(height: 50)
                            .background(
                                RoundedRectangle(
                                    cornerRadius: Metrics.cornerRadiusSmall,
                                    style: .continuous
                                ).fill(Palette.danger)
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("timeout.apply")

                    Spacer()
                }
                .padding(.horizontal, Metrics.hPadding)
                .padding(.top, 16)
            }
            .navigationTitle("Time out")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }.tint(Palette.paperMuted)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

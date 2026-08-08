import XCTest
@testable import pqp

/// The profile sheet's state machine.
///
/// Worth testing without a screen because it decides which buttons a stranger
/// sees, and two of the states differ only in *direction* — "they asked you"
/// and "you asked them" carry the same person in the same shape, one list
/// apart. Getting those backwards offers Accept for a request nobody sent.
final class ProfileRelationsTests: XCTestCase {
    private let me = "11111111-1111-1111-1111-111111111111"
    private let them = "22222222-2222-2222-2222-222222222222"

    private func friend(_ id: String, status: String = "online") -> Friend {
        Friend(id: id, displayName: "Them", username: "them", tag: "them#0001",
               avatarUrl: nil, status: status, friendsSince: Date(timeIntervalSince1970: 0))
    }

    private func entry(_ id: String) -> FriendRequestEntry {
        FriendRequestEntry(id: id, displayName: "Them", username: "them",
                           tag: "them#0001", avatarUrl: nil, requestedAt: Date())
    }

    // MARK: - State resolution

    func testStrangerIsNone() {
        let state = ProfileRelations.state(
            for: them, selfId: me, friends: FriendsResponse(), blockedIds: []
        )
        XCTAssertEqual(state, .none)
        XCTAssertEqual(ProfileRelations.action(for: state), .addFriend)
    }

    func testAcceptedFriendOffersRemoval() {
        let data = FriendsResponse(friends: [friend(them)])
        let state = ProfileRelations.state(for: them, selfId: me, friends: data, blockedIds: [])
        XCTAssertEqual(state, .friends)
        XCTAssertEqual(ProfileRelations.action(for: state), .removeFriend)
    }

    /// The direction that has an answer to give.
    func testIncomingRequestOffersAccept() {
        let data = FriendsResponse(incoming: [entry(them)])
        let state = ProfileRelations.state(for: them, selfId: me, friends: data, blockedIds: [])
        XCTAssertEqual(state, .pendingIncoming)
        XCTAssertEqual(ProfileRelations.action(for: state), .acceptRequest)
        XCTAssertTrue(ProfileRelations.offersDecline(state),
                      "Declining must be one tap, beside Accept — not behind a menu")
    }

    /// The direction that does not.
    func testOutgoingRequestOffersOnlyCancelling() {
        let data = FriendsResponse(outgoing: [entry(them)])
        let state = ProfileRelations.state(for: them, selfId: me, friends: data, blockedIds: [])
        XCTAssertEqual(state, .pendingOutgoing)
        XCTAssertEqual(ProfileRelations.action(for: state), .cancelRequest)
        XCTAssertFalse(ProfileRelations.offersDecline(state))
    }

    func testYourOwnProfileOffersNoRelationshipAction() {
        let state = ProfileRelations.state(
            for: me, selfId: me, friends: FriendsResponse(), blockedIds: []
        )
        XCTAssertEqual(state, .isSelf)
        XCTAssertEqual(ProfileRelations.action(for: state), .noneAvailable)
        XCTAssertFalse(ProfileRelations.canMessage(state))
        XCTAssertFalse(ProfileRelations.canBlock(state))
        XCTAssertFalse(ProfileRelations.canReport(state),
                       "Reporting yourself is not a thing the server models")
    }

    /// A block deletes the friendship server-side (a schema trigger does it in
    /// both directions), so the two cannot legitimately coexist. If a stale
    /// read says they do, the block is the fact with consequences and has to
    /// win — otherwise the sheet offers "Remove friend" for someone whose
    /// messages are already hidden.
    func testBlockOutranksFriendship() {
        let data = FriendsResponse(friends: [friend(them)])
        let state = ProfileRelations.state(
            for: them, selfId: me, friends: data, blockedIds: [them]
        )
        XCTAssertEqual(state, .blocked)
        XCTAssertEqual(ProfileRelations.action(for: state), .unblock)
        XCTAssertFalse(ProfileRelations.canMessage(state))
        XCTAssertFalse(ProfileRelations.canBlock(state), "Already blocked — offer Unblock instead")
        XCTAssertTrue(ProfileRelations.canReport(state))
    }

    /// Signed out (no self id) must not accidentally read as "this is you".
    func testUnknownSelfDoesNotMatchAnybody() {
        let state = ProfileRelations.state(
            for: them, selfId: nil, friends: FriendsResponse(), blockedIds: []
        )
        XCTAssertEqual(state, .none)
    }

    // MARK: - Confirmation

    /// Ending something is confirmed; starting something is not. Removing a
    /// friend in particular is silent to the other side, so a mis-tap is
    /// invisible to them and uncorrectable by them.
    func testOnlyTheActionsThatEndSomethingAreConfirmed() {
        XCTAssertTrue(FriendshipAction.removeFriend.needsConfirmation)
        XCTAssertTrue(FriendshipAction.cancelRequest.needsConfirmation)
        XCTAssertFalse(FriendshipAction.addFriend.needsConfirmation)
        XCTAssertFalse(FriendshipAction.acceptRequest.needsConfirmation)
        XCTAssertFalse(FriendshipAction.unblock.needsConfirmation)
    }

    // MARK: - Presence

    /// A friend's presence comes from the friends list, which is the freshest
    /// thing the client has.
    func testFriendPresenceComesFromTheFriendsList() {
        let data = FriendsResponse(friends: [friend(them, status: "idle")])
        let presence = ProfileRelations.presence(
            for: them, state: .friends, friends: data, fallback: "online"
        )
        XCTAssertEqual(presence, "idle")
    }

    /// Anyone else's comes from whatever the caller knew — the members list
    /// resolves it server-side, a message does not.
    func testNonFriendPresenceFallsBackToTheCallersKnowledge() {
        XCTAssertEqual(
            ProfileRelations.presence(
                for: them, state: .none, friends: FriendsResponse(), fallback: "dnd"
            ),
            "dnd"
        )
    }

    /// Unknown must stay unknown. Drawing "offline" because we failed to look
    /// is a claim about somebody's whereabouts that we cannot support.
    func testUnknownPresenceStaysNil() {
        XCTAssertNil(
            ProfileRelations.presence(
                for: them, state: .none, friends: FriendsResponse(), fallback: nil
            )
        )
    }

    // MARK: - Subjects

    /// The three call sites carry the same person under different field names;
    /// converting at the edge is what keeps the sheet from knowing which screen
    /// opened it.
    func testSubjectsConvertFromEveryShapeTheAppHas() {
        let member = ServerMember(
            id: them, displayName: "Them", username: "them", discriminator: "0001",
            tag: "them#0001", avatarUrl: nil, role: "member", status: "online"
        )
        let fromMember = ProfileSubject(member: member)
        XCTAssertEqual(fromMember.id, them)
        XCTAssertEqual(fromMember.tag, "them#0001")
        XCTAssertEqual(fromMember.status, "online", "The roster already knows presence")

        let user = PublicUser(id: them, displayName: "Them", username: "them",
                              tag: "them#0001", avatarUrl: nil)
        XCTAssertNil(ProfileSubject(user: user).status,
                     "A search result carries no presence, and must not invent one")
    }
}

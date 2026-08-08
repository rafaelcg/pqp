import XCTest
@testable import pqp

/// The rank rule, and the two message gates.
///
/// Worth pinning here rather than trusting the server to refuse, because every
/// bug this file exists to stop was a UI bug the server never saw: a menu that
/// offered something and then failed, or a menu that hid something a moderator
/// was entitled to. The rule is mirrored from
/// `packages/shared/src/moderation.ts`, whose own suite asserts the same
/// outcomes — so a divergence between the two clients shows up as a failure on
/// one side or the other rather than as a support complaint.
final class ModerationTests: XCTestCase {
    private let owner = "11111111-1111-1111-1111-111111111111"
    private let admin = "22222222-2222-2222-2222-222222222222"
    private let member = "33333333-3333-3333-3333-333333333333"

    // MARK: - The rank rule

    func testPlainMemberIsOfferedNothing() {
        XCTAssertFalse(Moderation.canModerate(
            actorRole: "member", actorId: member,
            targetRole: "member", targetId: admin
        ))
    }

    func testNilRoleIsNotAManager() {
        // A `Server` fetched outside `/api/servers` has no `role` key at all, so
        // `nil` is a real value here and must not be mistaken for authority.
        XCTAssertFalse(Moderation.isManager(nil))
        XCTAssertFalse(Moderation.canModerate(
            actorRole: nil, actorId: owner, targetRole: "member", targetId: member
        ))
    }

    func testOwnerMayActOnAnAdmin() {
        XCTAssertTrue(Moderation.canModerate(
            actorRole: "owner", actorId: owner,
            targetRole: "admin", targetId: admin
        ))
    }

    /// THE BUG THIS FILE WAS WRITTEN FOR. `MembersView` gated on "not the owner,
    /// not me" alone, so an admin was shown Kick, Ban and Timeout against a peer
    /// and got a 403 from `requireOutranked` every single time.
    func testAdminMayNotActOnAnotherAdmin() {
        XCTAssertFalse(Moderation.canModerate(
            actorRole: "admin", actorId: admin,
            targetRole: "admin", targetId: member
        ))
    }

    func testNobodyMayActOnTheOwner() {
        for actor in ["owner", "admin"] {
            XCTAssertFalse(Moderation.canModerate(
                actorRole: actor, actorId: admin,
                targetRole: "owner", targetId: owner
            ), "\(actor) should not be able to act on the owner")
        }
    }

    func testSelfTargetingIsRefused() {
        // The server answers 400 "use leave instead"; a button whose only
        // outcome is a scolding should not be drawn.
        XCTAssertFalse(Moderation.canModerate(
            actorRole: "owner", actorId: owner,
            targetRole: "owner", targetId: owner
        ))
    }

    func testUnknownActorIdStillGuardsRank() {
        // A missing `currentUser` cannot be used to slip past the rank rule —
        // only the self check is skipped, and only because there is no self to
        // compare against.
        XCTAssertFalse(Moderation.canModerate(
            actorRole: "admin", actorId: nil,
            targetRole: "admin", targetId: admin
        ))
    }

    func testNonMemberTargetIsAllowedForThePreEmptiveBan() {
        // `POST /api/servers/:id/bans` takes any existing user. Surfaces that
        // need the person to be present check that themselves.
        XCTAssertTrue(Moderation.canModerate(
            actorRole: "admin", actorId: admin,
            targetRole: nil, targetId: member
        ))
    }

    // MARK: - Messages

    /// Flat, with NO rank rule, matching `canManageServer` on the server: an
    /// admin removing the owner's post is a moderator doing their job.
    func testDeletingIsYoursOrAnybodysWhenYouManage() {
        XCTAssertTrue(Moderation.canDelete(isMine: true, serverRole: "member"))
        XCTAssertTrue(Moderation.canDelete(isMine: false, serverRole: "owner"))
        XCTAssertTrue(Moderation.canDelete(isMine: false, serverRole: "admin"))
        XCTAssertFalse(Moderation.canDelete(isMine: false, serverRole: "member"))
    }

    /// The gap this closed: `MessageActionsOverlay` gated Delete on `isMine`, so
    /// an owner reading their own server on a phone could not remove anything
    /// anybody else had posted.
    func testAnOwnerCanDeleteSomebodyElsesMessage() {
        XCTAssertTrue(Moderation.canDelete(isMine: false, serverRole: "owner"))
    }

    /// And its mirror image: Pin was gated on nothing at all, so a plain member
    /// tapped it and got a 403.
    func testPinningIsManagerOnlyInAServerAndFreeInADm() {
        XCTAssertFalse(Moderation.canPin(inServer: true, serverRole: "member"))
        XCTAssertTrue(Moderation.canPin(inServer: true, serverRole: "admin"))
        // `requirePinAccess` lets any participant pin in a conversation, and a
        // DM has no role to check — nil there means "no server", not "no rank".
        XCTAssertTrue(Moderation.canPin(inServer: false, serverRole: nil))
    }

    // MARK: - Presets

    func testTimeoutPresetsMatchTheSharedFour() {
        XCTAssertEqual(
            Moderation.timeoutPresets.map(\.minutes),
            [5, 60, 60 * 24, 60 * 24 * 7]
        )
    }
}

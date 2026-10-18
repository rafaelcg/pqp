import XCTest
@testable import pqp

/// The composer is offered only where SEND_MESSAGES is held, and a forum's
/// "Novo post" follows the same bit (QA S-F1: a member with it denied still got
/// the button, the composer and a dead-end error).
final class SendGateTests: XCTestCase {
    private let forumId = "forum-1"
    private let otherId = "other-1"

    private func snapshot(server: UInt64, channels: [String: UInt64] = [:]) throws -> PermissionsSnapshot {
        let json: [String: Any] = [
            "version": 1,
            "server": String(server),
            "channels": channels.mapValues { String($0) },
        ]
        return try JSONDecoder().decode(PermissionsSnapshot.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testUnknownSnapshotIsAllowedBecauseTheServerIsTheGate() {
        XCTAssertTrue(SendGate.canSend(nil, channelId: forumId))
    }

    func testServerBitsAnswerWhenThereIsNoOverwrite() throws {
        XCTAssertTrue(SendGate.canSend(try snapshot(server: PermissionBit.sendMessages), channelId: forumId))
        XCTAssertFalse(SendGate.canSend(try snapshot(server: 0), channelId: forumId))
    }

    func testAChannelOverwriteDenyingSendWinsOverServerBits() throws {
        let snap = try snapshot(server: PermissionBit.sendMessages, channels: [forumId: 0])
        XCTAssertFalse(SendGate.canSend(snap, channelId: forumId))
        // Another channel is untouched.
        XCTAssertTrue(SendGate.canSend(snap, channelId: otherId))
    }

    func testAChannelOverwriteGrantingSendWinsOverServerBits() throws {
        let snap = try snapshot(server: 0, channels: [forumId: PermissionBit.sendMessages])
        XCTAssertTrue(SendGate.canSend(snap, channelId: forumId))
    }

    @MainActor
    func testAForum403IsNotToldToRetry() {
        let refusal = ForumComposerRefusal.from(.refused(status: 403, error: "You cannot post in this forum"))
        XCTAssertEqual(refusal.field, .general)
        XCTAssertNil(refusal.retryUntil)
        XCTAssertFalse(refusal.message.lowercased().contains("try again"), refusal.message)
        XCTAssertFalse(refusal.message.contains("tenta"), refusal.message)
    }

    @MainActor
    func testAForumFailureWithoutAStatusStillSaysTheDraftIsKept() {
        let refusal = ForumComposerRefusal.from(.refused(status: 500, error: "boom"))
        XCTAssertTrue(refusal.message.contains("draft") || refusal.message.contains("rascunho"), refusal.message)
    }
}

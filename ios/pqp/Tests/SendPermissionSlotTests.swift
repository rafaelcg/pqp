import XCTest
@testable import pqp

/// Farol on #1316: a snapshot read for server A must never gate a channel of
/// server B, whether the switch drops it, a read fails, or a slow answer for A
/// lands after the switch.
final class SendPermissionSlotTests: XCTestCase {
    private let channel = "channel-1"

    private func snapshot(server: UInt64) throws -> PermissionsSnapshot {
        let json: [String: Any] = ["version": 1, "server": String(server), "channels": [String: String]()]
        return try JSONDecoder().decode(PermissionsSnapshot.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testAnEmptySlotAllowsBecauseTheServerIsTheGate() {
        XCTAssertTrue(SendPermissionSlot().canSend(channelId: channel))
    }

    func testAnAcceptedSnapshotGatesTheComposer() throws {
        var slot = SendPermissionSlot()
        slot.switchTo("A")
        XCTAssertTrue(slot.accept(try snapshot(server: 0), for: "A"))
        XCTAssertFalse(slot.canSend(channelId: channel))
    }

    func testSwitchingServerDropsTheOldSnapshotAtOnce() throws {
        var slot = SendPermissionSlot()
        slot.switchTo("A")
        slot.accept(try snapshot(server: 0), for: "A")
        slot.switchTo("B")
        XCTAssertNil(slot.snapshot)
        XCTAssertTrue(slot.canSend(channelId: channel))
    }

    func testAFailedReadForTheNewServerDoesNotLeaveTheOldBits() throws {
        var slot = SendPermissionSlot()
        slot.switchTo("A")
        slot.accept(try snapshot(server: 0), for: "A")
        slot.switchTo("B")
        slot.accept(nil, for: "B")
        XCTAssertTrue(slot.canSend(channelId: channel))
    }

    func testALateAnswerForTheServerJustLeftIsRefused() throws {
        var slot = SendPermissionSlot()
        slot.switchTo("A")
        slot.switchTo("B")
        XCTAssertFalse(slot.accept(try snapshot(server: 0), for: "A"))
        XCTAssertNil(slot.snapshot)
        XCTAssertTrue(slot.accept(try snapshot(server: PermissionBit.sendMessages), for: "B"))
        // And a late A answer cannot overwrite B's newer one.
        XCTAssertFalse(slot.accept(try snapshot(server: 0), for: "A"))
        XCTAssertTrue(slot.canSend(channelId: channel))
    }

    func testAConversationHasNoServerAndNoSnapshot() throws {
        var slot = SendPermissionSlot()
        slot.switchTo("A")
        slot.accept(try snapshot(server: 0), for: "A")
        slot.switchTo(nil)
        XCTAssertNil(slot.snapshot)
        XCTAssertTrue(slot.canSend(channelId: channel))
    }

    func testReSelectingTheSameServerKeepsItsSnapshot() throws {
        var slot = SendPermissionSlot()
        slot.switchTo("A")
        slot.accept(try snapshot(server: 0), for: "A")
        slot.switchTo("A")
        XCTAssertFalse(slot.canSend(channelId: channel))
    }
}

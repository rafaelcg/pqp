import XCTest
@testable import pqp

/**
 `PermissionsSnapshot`, decoded straight off the shape
 `GET /api/servers/:serverId/permissions` answers with, and its `can(_:
 channelId:)` -- the override-falls-back-to-server-bits rule mirrored from
 `use-permissions.ts`'s own `can` callback.

 THE WIRE VALUE IS ALREADY RESOLVED, which is why there is no ADMINISTRATOR
 or owner test here that constructs a role and expects `can` to special-case
 it: `computePermissions` (`packages/shared/src/permissions.ts`) resolves
 both to every bit BEFORE this snapshot is ever built, so simulating that is
 just simulating a server bitfield with every bit set -- `testEveryBitSetReadsAsHoldingTheOneThisBuildChecks`
 below is exactly that, standing in for both.
 */
final class PermissionBitsTests: XCTestCase {
    private func snapshot(
        version: Int = 1,
        server: String,
        channels: [String: String] = [:]
    ) throws -> PermissionsSnapshot {
        let json: [String: Any] = [
            "version": version,
            "server": server,
            "channels": channels,
        ]
        let data = try JSONSerialization.data(withJSONObject: json)
        return try JSONDecoder().decode(PermissionsSnapshot.self, from: data)
    }

    // MARK: - The bit value itself

    /// `1n << 23n` in `packages/shared/src/permissions.ts` -- 8388608.
    func testStartWatchPartyIsBitTwentyThree() {
        XCTAssertEqual(PermissionBit.startWatchParty, 1 << 23)
        XCTAssertEqual(PermissionBit.startWatchParty, 8_388_608)
    }

    // MARK: - Server bits alone

    func testServerBitsGrantingTheBitReadsAsHeld() throws {
        let snap = try snapshot(server: String(PermissionBit.startWatchParty))
        XCTAssertTrue(snap.can(PermissionBit.startWatchParty))
    }

    func testServerBitsNotGrantingTheBitReadsAsNotHeld() throws {
        // SEND_MESSAGES (1 << 7) only -- START_WATCH_PARTY is bit 23.
        let snap = try snapshot(server: String(1 << 7))
        XCTAssertFalse(snap.can(PermissionBit.startWatchParty))
    }

    func testZeroServerBitsHoldsNothing() throws {
        let snap = try snapshot(server: "0")
        XCTAssertFalse(snap.can(PermissionBit.startWatchParty))
    }

    // MARK: - Every bit set (owner / ADMINISTRATOR, already resolved server side)

    /// Owner and ADMINISTRATOR both resolve to `PERMISSION_ALL` before the
    /// bitfield ever reaches the wire (`computePermissions` steps 1 and 4),
    /// so there is nothing to special-case on this client -- a bitfield
    /// with every defined bit set already reads as holding this one, the
    /// same as it would for a role individually granted it.
    func testEveryBitSetReadsAsHoldingTheOneThisBuildChecks() throws {
        // PERMISSION_ALL as of packages/shared: (1n << 25n) - 1n.
        let permissionAll = (UInt64(1) << 25) - 1
        let snap = try snapshot(server: String(permissionAll))
        XCTAssertTrue(snap.can(PermissionBit.startWatchParty))
    }

    // MARK: - Channel override falls back to server bits

    func testAKnownChannelOverrideWinsOverServerBits() throws {
        // Server bits deny it; the channel's own resolved bits grant it.
        let snap = try snapshot(
            server: "0",
            channels: ["c1": String(PermissionBit.startWatchParty)]
        )
        XCTAssertTrue(snap.can(PermissionBit.startWatchParty, channelId: "c1"))
        // Server bits alone (no channel id) are unaffected by the override.
        XCTAssertFalse(snap.can(PermissionBit.startWatchParty))
    }

    func testAChannelOverrideCanDenyWhatServerBitsGrant() throws {
        let snap = try snapshot(
            server: String(PermissionBit.startWatchParty),
            channels: ["c1": "0"]
        )
        XCTAssertFalse(snap.can(PermissionBit.startWatchParty, channelId: "c1"))
    }

    func testAnUnknownChannelIdFallsBackToServerBits() throws {
        let snap = try snapshot(
            server: String(PermissionBit.startWatchParty),
            channels: ["other-channel": "0"]
        )
        XCTAssertTrue(snap.can(PermissionBit.startWatchParty, channelId: "c1"))
    }

    func testNoChannelIdAlwaysReadsServerBits() throws {
        // Mirrors the web sidebar's own call, `perms.can(Permission.START_WATCH_PARTY)`
        // with no second argument -- see `ServerWatchPartyListState.swift`'s
        // `canHost` doc.
        let snap = try snapshot(
            server: String(PermissionBit.startWatchParty),
            channels: ["c1": "0"]
        )
        XCTAssertTrue(snap.can(PermissionBit.startWatchParty, channelId: nil))
    }

    // MARK: - Fails closed on a bitfield this build cannot read

    func testAnOverflowingServerBitfieldFailsClosedRatherThanCrashing() throws {
        // One digit past UInt64.max (18446744073709551615).
        let snap = try snapshot(server: "99999999999999999999999999")
        XCTAssertEqual(snap.server, 0)
        XCTAssertFalse(snap.can(PermissionBit.startWatchParty))
    }

    func testANonDecimalServerBitfieldFailsClosed() throws {
        let snap = try snapshot(server: "not-a-number")
        XCTAssertEqual(snap.server, 0)
    }

    func testAnOverflowingChannelBitfieldFailsClosedForThatChannelOnly() throws {
        let snap = try snapshot(
            server: String(PermissionBit.startWatchParty),
            channels: ["c1": "99999999999999999999999999"]
        )
        XCTAssertEqual(snap.channels["c1"], 0)
        // The channel entry exists (so it is not treated as "unknown, fall
        // back to server"), but reads as holding nothing.
        XCTAssertFalse(snap.can(PermissionBit.startWatchParty, channelId: "c1"))
    }

    // MARK: - Missing channels key decodes as empty, not a throw

    func testAMissingChannelsKeyDecodesAsEmpty() throws {
        let json: [String: Any] = ["version": 1, "server": "0"]
        let data = try JSONSerialization.data(withJSONObject: json)
        let snap = try JSONDecoder().decode(PermissionsSnapshot.self, from: data)
        XCTAssertEqual(snap.channels, [:])
    }
}

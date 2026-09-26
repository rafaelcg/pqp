import XCTest
@testable import pqp

/**
 `watchPartyHostGate`, `canGoLiveWith`, `canEndParty` and
 `watchPartyMayJoinRoom`, as pure functions over the three/four inputs the
 review's spec calls out: only `watch_party` channels, only when the
 server's own `enabled` flag says so, only with `canStartWatchParty`.
 Mirrors `WatchPartyHostGateTest.kt` from Android's hosting PR (#834), case
 for case, on the port in `WatchPartyHostGate.swift`.
 */
final class WatchPartyHostGateTests: XCTestCase {
    private func party(
        state: String = "draft",
        viewerRole: String = "host"
    ) -> WatchPartyPayload {
        WatchPartyPayload(
            id: "p1", channelId: "c1", name: "Sessão", state: state,
            hostUserId: "u1", hostDisplayName: "Rafael", viewerRole: viewerRole
        )
    }

    // MARK: - watchPartyHostGate

    func testNotAWatchPartyChannelNeverOffersHostControls() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: false, serverWatchPartyEnabled: true,
            canStartWatchParty: true, party: nil
        )
        XCTAssertFalse(gate.canCreate)
        XCTAssertFalse(gate.canManage)
    }

    func testServerWatchPartiesOffNeverOffersHostControls() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: false,
            canStartWatchParty: true, party: nil
        )
        XCTAssertFalse(gate.canCreate)
        XCTAssertFalse(gate.canManage)
    }

    func testNoStartWatchPartyPermissionNeverOffersHostControls() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: true,
            canStartWatchParty: false, party: nil
        )
        XCTAssertFalse(gate.canCreate)
        XCTAssertFalse(gate.canManage)
    }

    func testEligibleWithNoPartyOffersCreateOnly() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: true,
            canStartWatchParty: true, party: nil
        )
        XCTAssertTrue(gate.canCreate)
        XCTAssertFalse(gate.canManage)
    }

    func testEligibleHostOfADraftOffersManageOnly() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: true,
            canStartWatchParty: true, party: party(state: "draft")
        )
        XCTAssertFalse(gate.canCreate)
        XCTAssertTrue(gate.canManage)
    }

    func testEligibleButNotTheHostOffersNeither() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: true,
            canStartWatchParty: true, party: party(state: "live", viewerRole: "cohost")
        )
        XCTAssertFalse(gate.canCreate)
        XCTAssertFalse(gate.canManage)
    }

    func testAnEndedPartyOffersNeitherEvenToItsOwnHost() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: true,
            canStartWatchParty: true, party: party(state: "ended")
        )
        XCTAssertFalse(gate.canCreate)
        XCTAssertFalse(gate.canManage)
    }

    func testACancelledPartyOffersNeitherEvenToItsOwnHost() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: true,
            canStartWatchParty: true, party: party(state: "cancelled")
        )
        XCTAssertFalse(gate.canManage)
    }

    // MARK: - canGoLiveWith / canEndParty

    func testGoLiveIsOfferedOnlyPreLive() {
        XCTAssertTrue(canGoLiveWith(party(state: "draft")))
        XCTAssertTrue(canGoLiveWith(party(state: "scheduled")))
        XCTAssertFalse(canGoLiveWith(party(state: "live")))
        XCTAssertFalse(canGoLiveWith(party(state: "ended")))
        XCTAssertFalse(canGoLiveWith(nil))
    }

    func testEndIsOfferedOnlyLive() {
        XCTAssertTrue(canEndParty(party(state: "live")))
        XCTAssertFalse(canEndParty(party(state: "draft")))
        XCTAssertFalse(canEndParty(party(state: "ended")))
        XCTAssertFalse(canEndParty(nil))
    }

    // MARK: - watchPartyMayJoinRoom

    func testCanStartWatchPartyAlwaysLetsTheRoomBeJoined() {
        XCTAssertTrue(watchPartyMayJoinRoom(canStartWatchParty: true, party: party(viewerRole: "viewer")))
    }

    func testNoActivePartyLetsAnybodyJoin() {
        XCTAssertTrue(watchPartyMayJoinRoom(canStartWatchParty: false, party: nil))
    }

    func testAPartysOwnHostMayRejoin() {
        XCTAssertTrue(watchPartyMayJoinRoom(canStartWatchParty: false, party: party(viewerRole: "host")))
    }

    func testACohostMayJoin() {
        XCTAssertTrue(watchPartyMayJoinRoom(canStartWatchParty: false, party: party(viewerRole: "cohost")))
    }

    func testAPlainViewerIsNotOfferedASeatOnceAPartyIsRunning() {
        XCTAssertFalse(watchPartyMayJoinRoom(canStartWatchParty: false, party: party(viewerRole: "viewer")))
    }

    func testAManagerRoleWithNoHostOrCohostStandingIsNotOfferedASeat() {
        // `manager` is a staff standing, not a seat grant -- Convidados is
        // out of scope for this build (see `watchPartyMayJoinRoom`'s doc).
        XCTAssertFalse(watchPartyMayJoinRoom(canStartWatchParty: false, party: party(viewerRole: "manager")))
    }
}

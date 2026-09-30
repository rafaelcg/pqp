import XCTest
@testable import pqp

/**
 `watchPartyHostGate`, `canGoLiveWith`, `canEndParty` and
 `watchPartyMayJoinRoom`, as pure functions over the inputs the review's
 spec calls out: only `watch_party` channels, only when the server's own
 `enabled` flag says so, only with `canStartWatchParty`, and (Farol findings
 on the first cut) never before the party's own state is actually KNOWN,
 and never confused by a TERMINAL party row into refusing everyone. Mirrors
 `WatchPartyHostGateTest.kt` from Android's hosting PR (#834) for the parts
 that carry over, plus the cases specific to `WatchPartyKnowledge`.
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
            canStartWatchParty: true, party: .known(nil)
        )
        XCTAssertFalse(gate.canCreate)
        XCTAssertFalse(gate.canManage)
    }

    func testServerWatchPartiesOffNeverOffersHostControls() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: false,
            canStartWatchParty: true, party: .known(nil)
        )
        XCTAssertFalse(gate.canCreate)
        XCTAssertFalse(gate.canManage)
    }

    func testNoStartWatchPartyPermissionNeverOffersHostControls() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: true,
            canStartWatchParty: false, party: .known(nil)
        )
        XCTAssertFalse(gate.canCreate)
        XCTAssertFalse(gate.canManage)
    }

    func testEligibleWithNoPartyOffersCreateOnly() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: true,
            canStartWatchParty: true, party: .known(nil)
        )
        XCTAssertTrue(gate.canCreate)
        XCTAssertFalse(gate.canManage)
    }

    func testEligibleHostOfADraftOffersManageOnly() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: true,
            canStartWatchParty: true, party: .known(party(state: "draft"))
        )
        XCTAssertFalse(gate.canCreate)
        XCTAssertTrue(gate.canManage)
    }

    func testEligibleButNotTheHostOffersNeither() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: true,
            canStartWatchParty: true, party: .known(party(state: "live", viewerRole: "cohost"))
        )
        XCTAssertFalse(gate.canCreate)
        XCTAssertFalse(gate.canManage)
    }

    /**
     Farol finding: a terminal party (`ended`/`cancelled`) used to leave
     `canCreate` off too, because it is not `nil`. `fetchChannelWatchParty`
     is documented to return a party in any state, so a channel whose last
     party just ended has to read as eligible to create a new one again,
     not as permanently blocked.
     */
    func testAnEndedPartyOffersCreateAgainEvenToItsOwnFormerHost() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: true,
            canStartWatchParty: true, party: .known(party(state: "ended"))
        )
        XCTAssertTrue(gate.canCreate)
        XCTAssertFalse(gate.canManage)
    }

    func testACancelledPartyOffersCreateAgainEvenToItsOwnFormerHost() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: true,
            canStartWatchParty: true, party: .known(party(state: "cancelled"))
        )
        XCTAssertTrue(gate.canCreate)
        XCTAssertFalse(gate.canManage)
    }

    /**
     Farol finding: before this, `party == nil` and "the lookup has not
     answered yet" were the same value, so a failed initial fetch showed
     Create to an eligible host as if the channel were genuinely idle --
     wrong the moment the lookup finally answered "someone else is already
     hosting". `.unknown` must offer neither until it resolves.
     */
    func testUnknownPartyStateOffersNeitherEvenWhenOtherwiseEligible() {
        let gate = watchPartyHostGate(
            isWatchPartyChannel: true, serverWatchPartyEnabled: true,
            canStartWatchParty: true, party: .unknown
        )
        XCTAssertFalse(gate.canCreate)
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
        XCTAssertTrue(
            watchPartyMayJoinRoom(canStartWatchParty: true, party: .known(party(viewerRole: "viewer")))
        )
    }

    /// `canStartWatchParty` answers the question outright even when the
    /// party lookup itself has not -- it is a stronger, independently
    /// resolved fact (this seat's own `welcome.canStream`), so it does not
    /// need to wait on `.unknown` to resolve.
    func testCanStartWatchPartyLetsTheRoomBeJoinedEvenIfThePartyIsUnknown() {
        XCTAssertTrue(watchPartyMayJoinRoom(canStartWatchParty: true, party: .unknown))
    }

    func testNoActivePartyLetsAnybodyJoin() {
        XCTAssertTrue(watchPartyMayJoinRoom(canStartWatchParty: false, party: .known(nil)))
    }

    func testAPartysOwnHostMayRejoin() {
        XCTAssertTrue(
            watchPartyMayJoinRoom(canStartWatchParty: false, party: .known(party(viewerRole: "host")))
        )
    }

    func testACohostMayJoin() {
        XCTAssertTrue(
            watchPartyMayJoinRoom(canStartWatchParty: false, party: .known(party(viewerRole: "cohost")))
        )
    }

    func testAPlainViewerIsNotOfferedASeatOnceAPartyIsRunning() {
        XCTAssertFalse(
            watchPartyMayJoinRoom(canStartWatchParty: false, party: .known(party(viewerRole: "viewer")))
        )
    }

    func testAManagerRoleWithNoHostOrCohostStandingIsNotOfferedASeat() {
        // `manager` is a staff standing, not a seat grant -- Convidados is
        // out of scope for this build (see `watchPartyMayJoinRoom`'s doc).
        XCTAssertFalse(
            watchPartyMayJoinRoom(canStartWatchParty: false, party: .known(party(viewerRole: "manager")))
        )
    }

    /// Farol finding, the join-room half of the terminal-party bug: a
    /// channel whose last party just ended is an ordinary voice room again,
    /// not one still locked to that party's former host.
    func testATerminalPartyLetsAnybodyJoinLikeAnOrdinaryVoiceRoom() {
        XCTAssertTrue(
            watchPartyMayJoinRoom(
                canStartWatchParty: false,
                party: .known(party(state: "ended", viewerRole: "viewer"))
            )
        )
    }

    /// Farol finding, the join-room half of the unknown-state bug: a
    /// lookup that has not answered yet cannot tell a plain viewer apart
    /// from a party's own host, so it must refuse rather than guess "no
    /// party" and let an ordinary viewer of a LIVE party in.
    func testUnknownPartyStateRefusesTheSeatRatherThanGuessing() {
        XCTAssertFalse(watchPartyMayJoinRoom(canStartWatchParty: false, party: .unknown))
    }
}

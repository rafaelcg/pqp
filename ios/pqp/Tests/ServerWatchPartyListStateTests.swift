import XCTest
@testable import pqp

/**
 `resolveServerWatchPartyListState`, the pure decision behind
 `ChannelListView`'s watch-party slot -- live wins, then this account's own
 pending party, then `canHost` alone, then nothing. See that function's doc
 for why the order is what it is; these cases are the same ladder the web's
 `LivePartyBlock` walks, read off `live-party-block.tsx`.
 */
final class ServerWatchPartyListStateTests: XCTestCase {
    private func party(
        id: String = "p1",
        state: String = "live",
        viewerRole: String = "viewer",
        wentLiveAt: String? = nil
    ) -> WatchPartyPayload {
        WatchPartyPayload(
            id: id, channelId: "c-\(id)", name: "Sessão", state: state,
            hostUserId: "u1", hostDisplayName: "Rafael", viewerRole: viewerRole,
            wentLiveAt: wentLiveAt
        )
    }

    // MARK: - Unknown (nil parties)

    /// The Farol finding this pins: `nil` (never fetched cleanly) must not
    /// offer the Create row even when `canHost` is true, because a party
    /// might already exist and this screen simply does not know it yet.
    func testUnknownPartiesNeverOffersTheCreateRowEvenWhenCanHostIsTrue() {
        XCTAssertEqual(resolveServerWatchPartyListState(parties: nil, canHost: true), .none)
    }

    func testUnknownPartiesWithNoHostPermissionIsAlsoNothing() {
        XCTAssertEqual(resolveServerWatchPartyListState(parties: nil, canHost: false), .none)
    }

    // MARK: - Nothing

    func testNoPartiesAndCannotHostIsNothing() {
        XCTAssertEqual(resolveServerWatchPartyListState(parties: [], canHost: false), .none)
    }

    func testAStrangersDraftIsInvisibleAndFallsThroughToNothing() {
        // The route itself never sends a draft this account is not host or
        // co-host of, but the decision function does not lean on that: a
        // `viewerRole` of plain `viewer` on a pre-live row must still read
        // as nothing here, not as a pending card this account cannot open.
        let stranger = party(state: "draft", viewerRole: "viewer")
        XCTAssertEqual(resolveServerWatchPartyListState(parties: [stranger], canHost: false), .none)
    }

    // MARK: - canHost alone

    func testCanHostWithNoPartiesOffersTheCreateRow() {
        XCTAssertEqual(resolveServerWatchPartyListState(parties: [], canHost: true), .canHost)
    }

    func testAStrangersDraftDoesNotBlockTheCreateRow() {
        let stranger = party(state: "draft", viewerRole: "viewer")
        XCTAssertEqual(resolveServerWatchPartyListState(parties: [stranger], canHost: true), .canHost)
    }

    // MARK: - Pending (this account's own)

    func testOwnDraftIsPendingEvenWithoutCanHost() {
        // A co-host who lost START_WATCH_PARTY still needs the way back into
        // a party they are already attached to.
        let mine = party(state: "draft", viewerRole: "host")
        XCTAssertEqual(resolveServerWatchPartyListState(parties: [mine], canHost: false), .pending(mine))
    }

    func testOwnScheduledPartyIsPendingToo() {
        let mine = party(state: "scheduled", viewerRole: "cohost")
        XCTAssertEqual(resolveServerWatchPartyListState(parties: [mine], canHost: true), .pending(mine))
    }

    func testPendingBeatsTheCreateRow() {
        let mine = party(state: "draft", viewerRole: "host")
        XCTAssertEqual(resolveServerWatchPartyListState(parties: [mine], canHost: true), .pending(mine))
    }

    // MARK: - Live beats everything

    func testLiveBeatsOwnPendingElsewhereInTheServer() {
        let live = party(id: "live1", state: "live", viewerRole: "viewer", wentLiveAt: "2026-09-26T20:00:00Z")
        let ownDraft = party(id: "draft1", state: "draft", viewerRole: "host")
        XCTAssertEqual(
            resolveServerWatchPartyListState(parties: [ownDraft, live], canHost: true),
            .live(live)
        )
    }

    func testLiveBeatsCanHost() {
        let live = party(state: "live", wentLiveAt: "2026-09-26T20:00:00Z")
        XCTAssertEqual(resolveServerWatchPartyListState(parties: [live], canHost: true), .live(live))
    }

    func testTwoLivePartiesPicksTheNewestByWentLiveAt() {
        let older = party(id: "older", state: "live", wentLiveAt: "2026-09-26T18:00:00Z")
        let newer = party(id: "newer", state: "live", wentLiveAt: "2026-09-26T20:00:00Z")
        XCTAssertEqual(
            resolveServerWatchPartyListState(parties: [older, newer], canHost: false),
            .live(newer)
        )
    }
}

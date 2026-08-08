import XCTest
@testable import pqp

/// The launch destination is decided by this codec, and a bad decision is
/// expensive: the app either opens on a screen that cannot load, or refuses to
/// restore at all. Both failure modes are cheap to test here and invisible in
/// a running app.
final class LastVisitedTests: XCTestCase {
    private func makeDefaults(_ name: String = #function) -> UserDefaults {
        let suite = "pqp.tests.\(name).\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    func testChannelTargetRoundTrips() {
        let target = LastVisited.Target(kind: .channel, channelId: "chan1", serverId: "srv1")
        let encoded = LastVisited.encode(target)
        XCTAssertEqual(encoded, "channel|chan1|srv1")
        XCTAssertEqual(LastVisited.decode(encoded!), target)
    }

    func testConversationTargetRoundTrips() {
        let target = LastVisited.Target(kind: .conversation, channelId: "dm1", serverId: nil)
        let encoded = LastVisited.encode(target)
        XCTAssertEqual(encoded, "conversation|dm1")
        XCTAssertEqual(LastVisited.decode(encoded!), target)
    }

    func testAChannelWithoutAServerIsNotEncodable() {
        // A server channel with no server id would decode into a target the
        // restore cannot validate — better to record nothing.
        XCTAssertNil(
            LastVisited.encode(
                LastVisited.Target(kind: .channel, channelId: "chan1", serverId: nil)
            )
        )
    }

    func testAConversationCarryingAServerIsNotEncodable() {
        XCTAssertNil(
            LastVisited.encode(
                LastVisited.Target(kind: .conversation, channelId: "dm1", serverId: "srv1")
            )
        )
    }

    func testIdsContainingTheSeparatorAreRefused() {
        XCTAssertNil(
            LastVisited.encode(
                LastVisited.Target(kind: .channel, channelId: "a|b", serverId: "srv1")
            )
        )
    }

    func testJunkDecodesToNothingRatherThanAGuess() {
        for junk in ["", "channel", "channel|", "channel|chan1", "conversation|",
                     "conversation|dm1|srv1", "voice|chan1|srv1", "|||", "chan1|srv1"] {
            XCTAssertNil(LastVisited.decode(junk), "\(junk) should not decode")
        }
    }

    func testSavingAndLoadingUsesTheOneStringKey() {
        let defaults = makeDefaults()
        XCTAssertNil(LastVisited.load(from: defaults))

        let target = LastVisited.Target(kind: .channel, channelId: "chan1", serverId: "srv1")
        LastVisited.save(target, to: defaults)
        XCTAssertEqual(defaults.string(forKey: LastVisited.defaultsKey), "channel|chan1|srv1")
        XCTAssertEqual(LastVisited.load(from: defaults), target)

        LastVisited.clear(from: defaults)
        XCTAssertNil(LastVisited.load(from: defaults))
    }

    /// The UI tests reset the pointer with a launch argument, which arrives as
    /// an empty string rather than an absent key. Empty must read as "nowhere".
    func testAnEmptyStringReadsAsNoDestination() {
        let defaults = makeDefaults()
        defaults.set("", forKey: LastVisited.defaultsKey)
        XCTAssertNil(LastVisited.load(from: defaults))
    }

    func testAnUnencodableTargetLeavesTheStoredValueAlone() {
        let defaults = makeDefaults()
        LastVisited.save(
            LastVisited.Target(kind: .channel, channelId: "chan1", serverId: "srv1"),
            to: defaults
        )
        LastVisited.save(
            LastVisited.Target(kind: .channel, channelId: "chan2", serverId: nil),
            to: defaults
        )
        XCTAssertEqual(
            LastVisited.load(from: defaults)?.channelId, "chan1",
            "A target that cannot be encoded must not blank the last good one"
        )
    }
}

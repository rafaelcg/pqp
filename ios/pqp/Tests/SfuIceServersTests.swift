import XCTest
@testable import pqp

/// The relay rule for a LiveKit join, pinned.
///
/// Both wrong answers are silent. Passing the API's list when it has no relay
/// replaces the SFU's own TURN with nothing, and the call still connects on
/// every network but the one that needed a relay. Passing nothing when the
/// list has one is what shipped: the media box's relay, whose TLS port is
/// owned by Caddy, and a Cloudflare credential nobody ever used.
final class SfuIceServersTests: XCTestCase {
    private let stun = IceServerConfig(urls: .single("stun:stun.l.google.com:19302"), username: nil, credential: nil)
    private let cloudflare = IceServerConfig(
        urls: .many(["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349"]),
        username: "u",
        credential: "c"
    )

    func testListWithRelayIsHandedOverWhole() {
        let out = SfuIceServers.select([stun, cloudflare])
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].urlList, ["stun:stun.l.google.com:19302"])
        XCTAssertEqual(out[1].urlList, cloudflare.urlList)
        XCTAssertEqual(out[1].username, "u")
        XCTAssertEqual(out[1].credential, "c")
    }

    func testSingleTurnsUrlCounts() {
        let relay = IceServerConfig(urls: .single("TURNS:relay.example:443?transport=tcp"), username: "u", credential: "c")
        XCTAssertEqual(SfuIceServers.select([relay]).count, 1)
    }

    /// STUN only means the server's relays stay in play.
    func testStunOnlyListPassesNothing() {
        XCTAssertTrue(SfuIceServers.select([stun]).isEmpty)
        XCTAssertTrue(SfuIceServers.select([stun, IceServerConfig(urls: .many(["stun:a", "stun:b"]), username: nil, credential: nil)]).isEmpty)
    }

    func testEmptyListPassesNothing() {
        XCTAssertTrue(SfuIceServers.select([]).isEmpty)
    }

    func testTurnDetection() {
        XCTAssertTrue(SfuIceServers.isTurnUrl("turn:h:3478"))
        XCTAssertTrue(SfuIceServers.isTurnUrl("turns:h:5349"))
        XCTAssertFalse(SfuIceServers.isTurnUrl("stun:h:3478"))
        XCTAssertFalse(SfuIceServers.isTurnUrl("stuns:h:5349"))
    }
}

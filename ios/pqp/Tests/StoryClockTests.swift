import XCTest
@testable import pqp

/// The viewer's clock: it waits for the first frame, a video's bar only
/// follows the player of the story on screen, and nothing moves once the viewer
/// is closing.
final class StoryClockTests: XCTestCase {
    private func progress(
        current: Double = 0, isVideo: Bool = false, ready: Bool = true, closing: Bool = false,
        playerIsForThisStory: Bool = true, seconds: Double? = nil, duration: Double? = nil
    ) -> Double? {
        StoryClockRules.nextProgress(
            current: current, isVideo: isVideo, ready: ready, closing: closing,
            playerIsForThisStory: playerIsForThisStory, videoSeconds: seconds, videoDuration: duration,
            tick: 1.0 / 30, displayMs: 5_000
        )
    }

    func testAPhotoRunsFiveSecondsFromItsFirstFrame() throws {
        XCTAssertNil(progress(ready: false), "The picture is not on screen yet: the time is not spent")
        var value = 0.0
        for _ in 0..<150 { value = try XCTUnwrap(progress(current: value)) }
        XCTAssertEqual(value, 1, accuracy: 0.001)
    }

    /// The bug: a video ends, the viewer moves on, and for a few ticks the
    /// player in hand is still the one that ended, at 100%. That read skipped
    /// the next video. It is not this story's player, so the bar does not move.
    func testAVideoFollowingAVideoDoesNotReadTheEndedPlayer() {
        XCTAssertNil(progress(isVideo: true, playerIsForThisStory: false, seconds: 8, duration: 8))
        // Its own player, at its own start, reads 0.
        XCTAssertEqual(progress(isVideo: true, seconds: 0, duration: 8), 0)
    }

    func testAVideoBarFollowsThePlayerAndHoldsWhileItStalls() {
        XCTAssertEqual(progress(isVideo: true, seconds: 2, duration: 8), 0.25)
        // A stall: the player's time stops, so the bar does.
        XCTAssertEqual(progress(current: 0.25, isVideo: true, seconds: 2, duration: 8), 0.25)
    }

    func testAVideoWaitsForItsFirstFrameToo() {
        XCTAssertNil(progress(isVideo: true, ready: false, seconds: 0, duration: 8))
    }

    func testNothingMovesOnceTheViewerIsClosing() {
        XCTAssertNil(progress(isVideo: true, closing: true, seconds: 8, duration: 8))
        XCTAssertNil(progress(closing: true))
    }

    func testAVideoWithNoUsableDurationFallsBackToItsOwnLength() throws {
        let value = try XCTUnwrap(progress(isVideo: true, seconds: nil, duration: .nan))
        XCTAssertEqual(value, (1.0 / 30) / 5, accuracy: 0.0001)
    }

    // MARK: - Posting with no connection

    private func options(_ servers: [(String, Bool)], friends: Bool = true) throws -> StoryAudienceOptions {
        let list = servers.map { #"{"serverId":"\#($0.0)","serverName":"S","iconUrl":null,"memberCount":3,"canPost":\#($0.1),"blockedReason":null}"# }
        return try JSONDecoder().decode(StoryAudienceOptions.self, from: Data(
            #"{"servers":[\#(list.joined(separator: ","))],"friends":{"enabled":\#(friends),"canPost":\#(friends)}}"#.utf8
        ))
    }

    func testTheRememberedAudienceTicksWhereTheLastStoryWentAsFarAsItIsStillOffered() throws {
        let offered = try options([("a", true), ("b", false)])
        let last = StoryAudienceMemory.Choice(serverIds: ["a", "b", "gone"], friends: true, repliesEnabled: false)
        let chosen = StoryAudienceMemory.selection(last: last, options: offered, preselectedServerId: "p", preselectsFriends: false)
        XCTAssertEqual(chosen.servers, ["a"], "Only what can still be posted to")
        XCTAssertTrue(chosen.friends)
    }

    /// Nothing remembered, no connection: the place the composer was opened
    /// from, so Post is not left with nothing ticked.
    func testWithNothingRememberedTheComposersOwnPlaceIsUsed() {
        let fromServer = StoryAudienceMemory.selection(last: nil, options: nil, preselectedServerId: "p", preselectsFriends: false)
        XCTAssertEqual(fromServer.servers, ["p"])
        XCTAssertFalse(fromServer.friends)
        let fromFriends = StoryAudienceMemory.selection(last: nil, options: nil, preselectedServerId: nil, preselectsFriends: true)
        XCTAssertTrue(fromFriends.servers.isEmpty)
        XCTAssertTrue(fromFriends.friends)
    }

    func testAChoiceSurvivesTheDiskPerAccount() {
        let id = "test-\(UUID().uuidString)"
        let choice = StoryAudienceMemory.Choice(serverIds: ["a"], friends: false, repliesEnabled: true)
        StoryAudienceMemory.save(choice: choice, userId: id)
        XCTAssertEqual(StoryAudienceMemory.lastChoice(id), choice)
        XCTAssertNil(StoryAudienceMemory.lastChoice("someone-else-\(UUID().uuidString)"))
    }
}

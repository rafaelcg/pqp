import XCTest
@testable import pqp

/// "Chama pra call" starts on the room the author is in, and says so when the
/// chosen room is not theirs: the server closes a call sticker whose author is
/// not in the room, so the sticker would be posted as "A call acabou".
@MainActor
final class StoryCallRoomTests: XCTestCase {
    private let me = "me"

    private func room(_ id: String) -> StoryCallChoice {
        StoryCallChoice(serverId: "s", serverName: "QG", channelId: id, channelName: id)
    }

    private func person(_ userId: String) -> VoiceParticipant {
        let json = #"{"peerId":"peer-\#(userId)","userId":"\#(userId)","displayName":"\#(userId)","avatarUrl":null}"#
        return try! Coding.decoder.decode(VoiceParticipant.self, from: Data(json.utf8))
    }

    private func occupants(_ rooms: [String: [String]]) -> (String) -> [VoiceParticipant] {
        { id in (rooms[id] ?? []).map(self.person) }
    }

    func testStartsOnTheRoomTheAuthorIsInEvenWhenAnotherIsBusier() {
        let rooms = [room("busy"), room("lobby"), room("empty")]
        let inside = occupants(["busy": ["a", "b", "c"], "lobby": [me]])
        XCTAssertEqual(StoryCallRoom.defaultChoice(rooms, userId: me, occupants: inside)?.channelId, "lobby")
    }

    func testPicksNothingWhenTheAuthorIsInNoRoom() {
        let rooms = [room("busy"), room("empty")]
        XCTAssertNil(StoryCallRoom.defaultChoice(rooms, userId: me, occupants: occupants(["busy": ["a", "b"]])))
        XCTAssertNil(StoryCallRoom.defaultChoice([], userId: me, occupants: occupants([:])))
    }

    func testAuthorInRoomReadsTheOccupants() {
        let inside = occupants(["lobby": [me], "busy": ["a"]])
        XCTAssertTrue(StoryCallRoom.authorIn("lobby", userId: me, occupants: inside))
        XCTAssertFalse(StoryCallRoom.authorIn("busy", userId: me, occupants: inside))
        XCTAssertFalse(StoryCallRoom.authorIn("lobby", userId: nil, occupants: inside))
    }
}

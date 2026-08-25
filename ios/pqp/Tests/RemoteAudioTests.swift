import XCTest
@testable import pqp

/**
 Deafen means silence, including from whoever is sharing their screen.

 THE BUG THIS PINS. Remote audio used to be one reference per peer
 (`[String: RTCAudioTrack]`). A peer sharing a screen with its sound publishes a
 *second* audio track, under the screen capture's own stream id, which the web
 client has done since 2026-08-22. The second one overwrote the first, and that
 overwritten reference was the only handle on the microphone track. Deafen then
 disabled the screen's audio and left the presenter's voice playing, with no
 error and no log line: the one control whose entire job is silence, quietly
 failing at it while the phone showed the deafened state.

 It is tested through `RemoteAudible` rather than through `VoiceClient` because
 making a real `RTCAudioTrack` needs a factory, an audio session and a device.
 The bookkeeping is the part that was wrong; the WebRTC objects were fine.
 */
final class RemoteAudioTests: XCTestCase {
    /// Stands in for `RTCAudioTrack`. Both properties start where WebRTC starts
    /// them, so a track the mixer never touches reads as audible at full level
    /// and a test that forgets to assert cannot pass by accident.
    private final class FakeTrack: RemoteAudible {
        var isEnabled = true
        var playbackVolume: Double = 1
    }

    private let peer = "peer-1"

    func testDeafeningSilencesBothTracksOfAPeerSharingTheirScreen() {
        var mixer = RemoteAudioMixer<FakeTrack>()
        let microphone = FakeTrack()
        let screenAudio = FakeTrack()
        mixer.add(microphone, id: "mic", for: peer)
        mixer.add(screenAudio, id: "pqp-screen-audio", for: peer)

        XCTAssertEqual(mixer.trackCount(for: peer), 2, "the second track replaced the first")

        mixer.setDeafened(true)
        XCTAssertFalse(microphone.isEnabled, "the microphone kept playing while deafened")
        XCTAssertFalse(screenAudio.isEnabled)

        mixer.setDeafened(false)
        XCTAssertTrue(microphone.isEnabled)
        XCTAssertTrue(screenAudio.isEnabled)
    }

    /// One person, one slider, whatever they happen to be publishing. This
    /// matches the web client, where the per-person level reaches the screen's
    /// sound as well as the voice.
    func testOnePersonsLevelReachesEverythingTheyAreSending() {
        var mixer = RemoteAudioMixer<FakeTrack>()
        let microphone = FakeTrack()
        let screenAudio = FakeTrack()
        mixer.add(microphone, id: "mic", for: peer)
        mixer.add(screenAudio, id: "screen", for: peer)

        mixer.setVolume(0.25, for: peer)
        XCTAssertEqual(microphone.playbackVolume, 0.25)
        XCTAssertEqual(screenAudio.playbackVolume, 0.25)
        XCTAssertEqual(mixer.volume(for: peer), 0.25)
    }

    /// A track that turns up mid-call has to turn up already in line with the
    /// room. Applying it a moment later is a track that plays for one tick,
    /// which for a deafened listener is the whole failure in miniature.
    func testATrackArrivingLaterAdoptsTheRoomItArrivesIn() {
        var mixer = RemoteAudioMixer<FakeTrack>()
        mixer.setDeafened(true)
        mixer.setVolume(0.5, for: peer)

        let arriving = FakeTrack()
        mixer.add(arriving, id: "screen", for: peer)
        XCTAssertFalse(arriving.isEnabled)
        XCTAssertEqual(arriving.playbackVolume, 0.5)
    }

    /// A share ending must not take the voice with it.
    func testEndingAShareLeavesTheMicrophoneFiled() {
        var mixer = RemoteAudioMixer<FakeTrack>()
        let microphone = FakeTrack()
        mixer.add(microphone, id: "mic", for: peer)
        mixer.add(FakeTrack(), id: "screen", for: peer)

        mixer.remove(trackId: "screen", for: peer)
        XCTAssertEqual(mixer.trackCount(for: peer), 1)

        mixer.setDeafened(true)
        XCTAssertFalse(microphone.isEnabled, "deafen stopped reaching the microphone")
    }

    /// The server mints a fresh peer id on every join, so the caller keys its
    /// own memory by user id and re-applies. Keeping the last value here too
    /// means a track that comes back mid-call comes back where it left off.
    func testAPeerLeavingKeepsTheLevelChosenForThem() {
        var mixer = RemoteAudioMixer<FakeTrack>()
        mixer.add(FakeTrack(), id: "mic", for: peer)
        mixer.setVolume(1.75, for: peer)

        mixer.remove(peerId: peer)
        XCTAssertEqual(mixer.trackCount(for: peer), 0)
        XCTAssertEqual(mixer.volume(for: peer), 1.75)

        let returning = FakeTrack()
        mixer.add(returning, id: "mic-2", for: peer)
        XCTAssertEqual(returning.playbackVolume, 1.75)
    }

    /// Leaving the room forgets the room. Deafen especially: it is a per-call
    /// choice, and carrying it into the next call is a call you cannot hear.
    func testLeavingTheRoomForgetsTheRoom() {
        var mixer = RemoteAudioMixer<FakeTrack>()
        mixer.add(FakeTrack(), id: "mic", for: peer)
        mixer.setVolume(0.1, for: peer)
        mixer.setDeafened(true)

        mixer.removeEverything()
        XCTAssertEqual(mixer.trackCount(for: peer), 0)
        XCTAssertEqual(mixer.volume(for: peer), 1)
        XCTAssertFalse(mixer.isDeafened)

        let next = FakeTrack()
        mixer.add(next, id: "mic", for: peer)
        XCTAssertTrue(next.isEnabled, "deafen survived into the next call")
    }

    /// Two people are two sets of tracks and two levels.
    func testPeersDoNotShareALevel() {
        var mixer = RemoteAudioMixer<FakeTrack>()
        let mine = FakeTrack()
        let theirs = FakeTrack()
        mixer.add(mine, id: "a", for: "peer-a")
        mixer.add(theirs, id: "b", for: "peer-b")

        mixer.setVolume(0, for: "peer-a")
        XCTAssertEqual(mine.playbackVolume, 0)
        XCTAssertEqual(theirs.playbackVolume, 1)
    }
}

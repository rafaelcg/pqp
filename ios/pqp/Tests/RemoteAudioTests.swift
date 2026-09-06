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

    // MARK: - Server mute

    /// THE RECEIVER IS THE ENFORCEMENT. On mesh the server never sees a byte of
    /// audio, so when a moderator mutes somebody the only thing that goes quiet
    /// is every listener's mixer playing them at zero. It has to win over the
    /// slider, and it has to win WITHOUT moving the slider: the level is the
    /// listener's choice about this person, and the mute is a moment in the
    /// call. When it clears they come back at the chosen level, not at zero.
    func testAServerMutePlaysThePersonAtZeroWithoutTouchingTheirLevel() {
        var mixer = RemoteAudioMixer<FakeTrack>()
        let microphone = FakeTrack()
        let unannounced = FakeTrack()
        mixer.add(microphone, id: "mic", streamId: "voice-stream", for: peer)
        // A second audio track under a stream the roster never named is read
        // as voice too: only an announced share is spared.
        mixer.add(unannounced, id: "other", streamId: "mystery", for: peer)
        mixer.setVolume(1.5, for: peer)

        mixer.setServerMuted(true, for: peer)
        XCTAssertEqual(microphone.playbackVolume, 0, "a server-muted person was still audible")
        XCTAssertEqual(unannounced.playbackVolume, 0, "an unannounced audio track escaped the mute")
        XCTAssertEqual(mixer.volume(for: peer), 1.5, "the mute overwrote the slider")
        XCTAssertEqual(mixer.effectiveVolume(for: peer), 0)
        XCTAssertTrue(mixer.isServerMuted(peer))

        mixer.setServerMuted(false, for: peer)
        XCTAssertEqual(microphone.playbackVolume, 1.5, "they did not come back at the chosen level")
        XCTAssertEqual(unannounced.playbackVolume, 1.5)
        XCTAssertFalse(mixer.isServerMuted(peer))
    }

    /// THE MICROPHONE ONLY. A host muting chatter during a watch party must
    /// not mute the film: the roster names the share's stream, the track
    /// arrives under it, and that one track keeps the listener's chosen level
    /// while the voice goes to zero. The web client does the same with its
    /// two sinks.
    func testAServerMuteSparesTheScreenAudioTheRosterAnnounced() {
        var mixer = RemoteAudioMixer<FakeTrack>()
        let microphone = FakeTrack()
        let screenAudio = FakeTrack()
        mixer.add(microphone, id: "mic", streamId: "voice-stream", for: peer)
        mixer.add(screenAudio, id: "screen-audio", streamId: "pqp-screen-1", for: peer)
        mixer.setScreenAudioStreamId("pqp-screen-1", for: peer)
        mixer.setVolume(0.7, for: peer)

        mixer.setServerMuted(true, for: peer)
        XCTAssertEqual(microphone.playbackVolume, 0, "the muted person's voice kept playing")
        XCTAssertEqual(screenAudio.playbackVolume, 0.7, "the mute took the film with it")
        XCTAssertTrue(mixer.isScreenAudio(trackId: "screen-audio", for: peer))
        XCTAssertFalse(mixer.isScreenAudio(trackId: "mic", for: peer))

        // The slider still reaches the share while the voice is muted.
        mixer.setVolume(0.2, for: peer)
        XCTAssertEqual(screenAudio.playbackVolume, 0.2)
        XCTAssertEqual(microphone.playbackVolume, 0)

        mixer.setServerMuted(false, for: peer)
        XCTAssertEqual(microphone.playbackVolume, 0.2)
        XCTAssertEqual(screenAudio.playbackVolume, 0.2)
    }

    /// The announcement and the track race: `set-sharing-screen` travels over
    /// the socket while the track waits on a renegotiation. Whichever lands
    /// second has to produce the same answer as if it had landed first.
    func testTheScreenAudioAnnouncementReappliesToATrackAlreadyFiled() {
        var mixer = RemoteAudioMixer<FakeTrack>()
        let screenAudio = FakeTrack()
        mixer.setServerMuted(true, for: peer)
        mixer.add(screenAudio, id: "screen-audio", streamId: "pqp-screen-1", for: peer)
        XCTAssertEqual(screenAudio.playbackVolume, 0, "an unannounced track must read as voice")

        mixer.setScreenAudioStreamId("pqp-screen-1", for: peer)
        XCTAssertEqual(screenAudio.playbackVolume, 1, "the announcement did not free the share")

        // The share ends, or loses its sound: the same track would be voice.
        mixer.setScreenAudioStreamId(nil, for: peer)
        XCTAssertEqual(screenAudio.playbackVolume, 0)
    }

    /// Moving the slider on somebody a moderator silenced changes what they
    /// come back at, not what plays now.
    func testMovingTheSliderWhileServerMutedIsRememberedButNotPlayed() {
        var mixer = RemoteAudioMixer<FakeTrack>()
        let microphone = FakeTrack()
        mixer.add(microphone, id: "mic", for: peer)
        mixer.setServerMuted(true, for: peer)

        mixer.setVolume(0.4, for: peer)
        XCTAssertEqual(microphone.playbackVolume, 0)
        XCTAssertEqual(mixer.volume(for: peer), 0.4)

        mixer.setServerMuted(false, for: peer)
        XCTAssertEqual(microphone.playbackVolume, 0.4)
    }

    /// The roster flag routinely lands before the media does: `peer-joined`
    /// is what opens the connection that eventually delivers the track. A
    /// track arriving after the flag has to arrive silent.
    func testATrackArrivingAfterTheServerMuteArrivesSilent() {
        var mixer = RemoteAudioMixer<FakeTrack>()
        mixer.setVolume(0.8, for: peer)
        mixer.setServerMuted(true, for: peer)

        let arriving = FakeTrack()
        mixer.add(arriving, id: "mic", for: peer)
        XCTAssertEqual(arriving.playbackVolume, 0)
    }

    /// A peer id is minted fresh on every join and the flag belongs to that
    /// roster entry, so a peer leaving takes their mute with them while their
    /// chosen level stays. Remembering the mute would be one the server never
    /// sent for the person who comes back.
    func testAPeerLeavingTakesTheServerMuteButNotTheLevel() {
        var mixer = RemoteAudioMixer<FakeTrack>()
        mixer.add(FakeTrack(), id: "mic", for: peer)
        mixer.setVolume(0.6, for: peer)
        mixer.setServerMuted(true, for: peer)

        mixer.remove(peerId: peer)
        XCTAssertFalse(mixer.isServerMuted(peer))
        XCTAssertEqual(mixer.effectiveVolume(for: peer), 0.6)
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

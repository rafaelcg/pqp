import AVFoundation
import XCTest
@testable import pqp

/// Voice notes: the parts that can be decided without a microphone or a
/// network. The recorder and the player themselves need hardware; what they
/// DECIDE (the waveform, the gesture, which bytes to play, what the wire says)
/// is pure and is pinned here.

// MARK: - Waveform

final class VoiceWaveformTests: XCTestCase {
    func testAlwaysExactlySixtyFourPeaks() {
        for count in [0, 1, 5, 63, 64, 65, 300, 6_000] {
            let readings = (0..<count).map { Float(-40 + ($0 % 30)) }
            XCTAssertEqual(VoiceWaveform.normalise(decibels: readings).count, 64, "\(count) readings")
        }
    }

    func testTheLoudestSliceIsFullScaleWhateverTheVolume() {
        // A quiet talker (-45 dB peaks) and a loud one (-5 dB) draw alike.
        let quiet = (0..<128).map { _ in Float.random(in: -48 ... -45) }
        let loud = (0..<128).map { _ in Float.random(in: -8 ... -5) }
        XCTAssertEqual(VoiceWaveform.normalise(decibels: quiet).max(), 255)
        XCTAssertEqual(VoiceWaveform.normalise(decibels: loud).max(), 255)
    }

    func testPeaksKeepTheirProportions() {
        // Two halves, one 20 dB louder: the quiet half must stay lower.
        let readings = [Float](repeating: -30, count: 64) + [Float](repeating: -10, count: 64)
        let peaks = VoiceWaveform.normalise(decibels: readings)
        XCTAssertEqual(peaks[0], UInt8((VoiceWaveform.level(decibels: -30) / VoiceWaveform.level(decibels: -10) * 255).rounded()))
        XCTAssertEqual(peaks[63], 255)
        XCTAssertLessThan(peaks[0], peaks[63])
    }

    func testOneLoudWordSurvivesAsAPeakNotAnAverage() {
        var readings = [Float](repeating: -60, count: 640)
        readings[321] = -5
        let peaks = VoiceWaveform.normalise(decibels: readings)
        XCTAssertEqual(peaks.max(), 255)
        XCTAssertEqual(peaks.filter { $0 > 0 }.count, 1)
    }

    func testSilenceStaysSilentRatherThanBeingAmplified() {
        XCTAssertEqual(VoiceWaveform.normalise(decibels: [Float](repeating: -160, count: 100)),
                       [UInt8](repeating: 0, count: 64))
        XCTAssertEqual(VoiceWaveform.normalise(decibels: []), [UInt8](repeating: 0, count: 64))
    }

    func testNonFiniteReadingsCountAsSilence() {
        XCTAssertEqual(VoiceWaveform.level(decibels: -.infinity), 0)
        XCTAssertEqual(VoiceWaveform.level(decibels: .nan), 0)
        XCTAssertEqual(VoiceWaveform.level(decibels: -160), 0)
        XCTAssertEqual(VoiceWaveform.level(decibels: 0), 1)
        // A positive reading (clipping) is clamped, not allowed past full scale.
        XCTAssertEqual(VoiceWaveform.level(decibels: 6), 1)
    }

    func testAShortNoteStretchesAcrossAllSixtyFourPeaks() {
        // Five readings: every peak still gets a value, none is left empty.
        let peaks = VoiceWaveform.normalise(decibels: [-40, -30, -20, -10, -5])
        XCTAssertEqual(peaks.count, 64)
        XCTAssertFalse(peaks.contains(0), "the quietest reading is above the floor, so no peak is empty")
        XCTAssertEqual(peaks.first, peaks[1])
        XCTAssertEqual(peaks.last, 255)
    }

    func testTheWireFormIsWhatTheServerAccepts() {
        // `createVoiceNoteSchema`: 64 bytes base64 are 86 characters then `==`.
        let encoded = VoiceWaveform.encode(VoiceWaveform.normalise(decibels: [-20, -10]))
        XCTAssertEqual(encoded.count, 88)
        XCTAssertNotNil(encoded.range(of: "^[A-Za-z0-9+/]{86}==$", options: .regularExpression))
    }

    func testDecodeRoundTripsAndToleratesGarbage() {
        let peaks: [UInt8] = (0..<64).map { UInt8($0 * 4) }
        let decoded = VoiceWaveform.decode(VoiceWaveform.encode(peaks))
        XCTAssertEqual(decoded.count, 64)
        XCTAssertEqual(decoded[0], 0)
        XCTAssertEqual(decoded[63], Float(252) / 255)
        XCTAssertEqual(VoiceWaveform.decode("not base64 !!"), [])
        XCTAssertEqual(VoiceWaveform.decode(""), [])
    }

    func testBarsResampleForTheCardWidth() {
        let peaks: [Float] = [0.1, 0.9, 0.2, 0.3]
        XCTAssertEqual(VoiceWaveform.bars(from: peaks, count: 2), [0.9, 0.3])
        XCTAssertEqual(VoiceWaveform.bars(from: peaks, count: 8).count, 8)
        XCTAssertEqual(VoiceWaveform.bars(from: [], count: 3), [0, 0, 0])
    }
}

// MARK: - Gesture

final class VoiceGestureTests: XCTestCase {
    private func holding() -> VoiceGesture {
        var gesture = VoiceGesture()
        XCTAssertEqual(gesture.handle(.pressBegan), [.haptic(.start), .startRecording])
        return gesture
    }

    func testPressStartsRecordingWithAHaptic() {
        XCTAssertEqual(holding().phase, .holding)
    }

    func testReleasingAfterAWhileSends() {
        var gesture = holding()
        XCTAssertEqual(gesture.handle(.released(elapsedMs: 2_000)), [.send])
        XCTAssertEqual(gesture.phase, .idle)
    }

    func testAQuickTapIsNotAMessage() {
        var gesture = holding()
        XCTAssertEqual(gesture.handle(.released(elapsedMs: 200)), [.discardTooShort])
        XCTAssertEqual(gesture.phase, .idle)
    }

    func testSlidingLeftPastTheThresholdCancelsAndAllowsUndo() {
        var gesture = holding()
        XCTAssertEqual(gesture.handle(.moved(dx: -50, dy: 3)), [])
        XCTAssertEqual(gesture.cancelProgress, 50 / VoiceGesture.cancelDistance, accuracy: 0.001)
        XCTAssertEqual(gesture.handle(.moved(dx: -VoiceGesture.cancelDistance, dy: 3)),
                       [.haptic(.cancel), .discard(undoable: true)])
        XCTAssertEqual(gesture.phase, .idle)
        // Lifting afterwards must not send what was just cancelled.
        XCTAssertEqual(gesture.handle(.released(elapsedMs: 3_000)), [])
    }

    func testSlidingUpPastTheThresholdLocks() {
        var gesture = holding()
        XCTAssertEqual(gesture.handle(.moved(dx: 2, dy: -40)), [])
        XCTAssertEqual(gesture.lockProgress, 40 / VoiceGesture.lockDistance, accuracy: 0.001)
        XCTAssertEqual(gesture.handle(.moved(dx: 2, dy: -VoiceGesture.lockDistance)), [.haptic(.lock)])
        XCTAssertEqual(gesture.phase, .locked(paused: false, canResume: true))
        // Lifting the finger after the lock keeps recording.
        XCTAssertEqual(gesture.handle(.released(elapsedMs: 4_000)), [])
        XCTAssertEqual(gesture.phase, .locked(paused: false, canResume: true))
    }

    func testTheFirstDirectionWinsSoADiagonalWobbleDoesNotCancelALock() {
        var gesture = holding()
        // Committed upward first...
        _ = gesture.handle(.moved(dx: 0, dy: -30))
        // ...then drifting far left must not cancel.
        XCTAssertEqual(gesture.handle(.moved(dx: -300, dy: -30)), [])
        XCTAssertEqual(gesture.phase, .holding)
    }

    func testSlidingTheWrongWayDoesNothing() {
        var gesture = holding()
        XCTAssertEqual(gesture.handle(.moved(dx: 200, dy: 0)), [])
        XCTAssertEqual(gesture.handle(.moved(dx: 0, dy: 200)), [])
        XCTAssertEqual(gesture.phase, .holding)
        XCTAssertEqual(gesture.cancelProgress, 0)
    }

    func testLockedPauseResumeSend() {
        var gesture = holding()
        _ = gesture.handle(.moved(dx: 0, dy: -VoiceGesture.lockDistance))
        XCTAssertEqual(gesture.handle(.pause), [.pauseRecording])
        XCTAssertEqual(gesture.phase, .locked(paused: true, canResume: true))
        XCTAssertEqual(gesture.handle(.pause), [], "already paused")
        XCTAssertEqual(gesture.handle(.resume), [.resumeRecording])
        XCTAssertEqual(gesture.handle(.send(elapsedMs: 9_000)), [.send])
        XCTAssertEqual(gesture.phase, .idle)
    }

    func testLockedDiscardCanBeUndone() {
        var gesture = holding()
        _ = gesture.handle(.moved(dx: 0, dy: -VoiceGesture.lockDistance))
        XCTAssertEqual(gesture.handle(.discard), [.haptic(.cancel), .discard(undoable: true)])
        XCTAssertEqual(gesture.phase, .idle)
        // The banner's Desfazer brings it back, ready to send, not extendable.
        XCTAssertEqual(gesture.handle(.undoDiscard), [])
        XCTAssertEqual(gesture.phase, .locked(paused: true, canResume: false))
        XCTAssertEqual(gesture.handle(.resume), [], "a stopped file cannot be appended to")
        XCTAssertEqual(gesture.handle(.send(elapsedMs: 5_000)), [.send])
    }

    func testSendingALockedNoteThatIsTooShortDropsIt() {
        var gesture = holding()
        _ = gesture.handle(.moved(dx: 0, dy: -VoiceGesture.lockDistance))
        XCTAssertEqual(gesture.handle(.send(elapsedMs: 300)), [.discardTooShort])
    }

    func testTheFiveMinuteCapHandsTheNoteOverForReview() {
        var gesture = holding()
        XCTAssertEqual(gesture.handle(.capReached), [.haptic(.lock), .pauseRecording])
        XCTAssertEqual(gesture.phase, .locked(paused: true, canResume: false))
        // The finger is probably still down; lifting it must not send.
        XCTAssertEqual(gesture.handle(.released(elapsedMs: 300_000)), [])
        XCTAssertEqual(gesture.handle(.resume), [])
        XCTAssertEqual(gesture.handle(.send(elapsedMs: 300_000)), [.send])
    }

    func testAnInterruptionMidHoldCancelsUndoably() {
        var gesture = holding()
        XCTAssertEqual(gesture.handle(.interrupted), [.haptic(.cancel), .discard(undoable: true)])
        XCTAssertEqual(gesture.phase, .idle)
    }

    func testAnInterruptionWhileLockedKeepsTheNote() {
        var gesture = holding()
        _ = gesture.handle(.moved(dx: 0, dy: -VoiceGesture.lockDistance))
        XCTAssertEqual(gesture.handle(.interrupted), [.pauseRecording])
        XCTAssertEqual(gesture.phase, .locked(paused: true, canResume: true))
    }

    func testStrayEventsAreIgnored() {
        var gesture = VoiceGesture()
        XCTAssertEqual(gesture.handle(.released(elapsedMs: 5_000)), [])
        XCTAssertEqual(gesture.handle(.send(elapsedMs: 5_000)), [])
        XCTAssertEqual(gesture.handle(.moved(dx: -500, dy: 0)), [])
        XCTAssertEqual(gesture.handle(.capReached), [])
        XCTAssertEqual(gesture.handle(.interrupted), [])
        XCTAssertEqual(gesture.phase, .idle)
        // A second press while recording does not start a second recording.
        _ = gesture.handle(.pressBegan)
        XCTAssertEqual(gesture.handle(.pressBegan), [])
    }
}

// MARK: - Refusing to record

final class VoiceRecordGateTests: XCTestCase {
    func testALiveCallBlocksRecording() {
        XCTAssertEqual(VoiceRecordGate.refusal(callIsLive: true, seatedInVoiceRoom: false), .inCall)
    }

    func testASeatInAVoiceRoomBlocksRecording() {
        XCTAssertEqual(VoiceRecordGate.refusal(callIsLive: false, seatedInVoiceRoom: true), .inCall)
    }

    func testNothingLiveAllowsRecording() {
        XCTAssertNil(VoiceRecordGate.refusal(callIsLive: false, seatedInVoiceRoom: false))
    }

    func testTheRecorderSettingsAreWhatTheContractAsksFor() {
        let settings = VoiceRecorder.settings
        XCTAssertEqual(settings[AVFormatIDKey] as? UInt32, kAudioFormatMPEG4AAC)
        XCTAssertEqual(settings[AVNumberOfChannelsKey] as? Int, 1)
        XCTAssertEqual(settings[AVSampleRateKey] as? Int, 24_000)
        // The server's ceiling is 64 kbps; the recorder aims well under it.
        XCTAssertLessThanOrEqual(settings[AVEncoderBitRateKey] as? Int ?? .max, 64_000)
    }
}

// MARK: - Which bytes to play

final class VoiceNotePlaybackSourceTests: XCTestCase {
    private let original = "https://files.example/orig.webm"
    private let copy = "https://files.example/copy.m4a"

    func testTheAACCopyWinsOverEverything() {
        XCTAssertEqual(
            VoiceNotePlaybackSource.choose(contentType: "audio/webm", url: original, playbackUrl: copy),
            .play(URL(string: copy)!)
        )
        // Even over an original that would have played.
        XCTAssertEqual(
            VoiceNotePlaybackSource.choose(contentType: "audio/mp4", url: "https://files.example/o.m4a", playbackUrl: copy),
            .play(URL(string: copy)!)
        )
    }

    func testAnMP4OriginalPlaysWhenThereIsNoCopy() {
        let mp4 = "https://files.example/o.m4a"
        XCTAssertEqual(
            VoiceNotePlaybackSource.choose(contentType: "audio/mp4", url: mp4, playbackUrl: nil),
            .play(URL(string: mp4)!)
        )
        // A parameterised or oddly cased type is still mp4.
        XCTAssertEqual(
            VoiceNotePlaybackSource.choose(contentType: "Audio/MP4; codecs=mp4a.40.2", url: mp4, playbackUrl: nil),
            .play(URL(string: mp4)!)
        )
    }

    func testAnOpusOriginalWithNoCopyIsPending() {
        XCTAssertEqual(VoiceNotePlaybackSource.choose(contentType: "audio/webm", url: original, playbackUrl: nil), .pending)
        XCTAssertEqual(VoiceNotePlaybackSource.choose(contentType: "audio/ogg", url: original, playbackUrl: nil), .pending)
        // An empty playbackUrl is not a copy.
        XCTAssertEqual(VoiceNotePlaybackSource.choose(contentType: "audio/webm", url: original, playbackUrl: ""), .pending)
    }

    func testTheDurationReadsLikeTheServersAndThePushes() {
        XCTAssertEqual(formatNoteDuration(milliseconds: 12_000), "0:12")
        XCTAssertEqual(formatNoteDuration(milliseconds: 245_000), "4:05")
        // Never below one second: a 300 ms note is "0:01".
        XCTAssertEqual(formatNoteDuration(milliseconds: 300), "0:01")
        XCTAssertEqual(formatNoteDuration(milliseconds: 11_500), "0:12")
    }
}

// MARK: - The queue

final class VoiceNoteQueueTests: XCTestCase {
    private func note(
        _ id: String, from author: String = "them", listened: Bool? = false,
        contentType: String = "audio/mp4", playback: String? = nil
    ) -> VoicePlayable {
        let message = """
        {"id":"m-\(id)","channelId":"c","authorId":"\(author)","authorName":"x","body":"",
         "createdAt":"2026-10-08T12:00:00.000Z","reactions":[],"attachments":[
          {"id":"\(id)","filename":"v","contentType":"\(contentType)","byteSize":10,"url":"https://f/\(id)",
           "voice":{"durationMs":3000,"waveform":""\(listened.map { ",\"listenedByMe\":\($0)" } ?? "")\(playback.map { ",\"playbackUrl\":\"\($0)\"" } ?? "")}}]}
        """
        let decoded = try! Coding.decoder.decode(Message.self, from: Data(message.utf8))
        return VoicePlayable(message: decoded, attachment: decoded.attachments[0])!
    }

    func testContinuesToTheNextUnheardNoteFromSomeoneElse() {
        let notes = [note("a"), note("b", listened: true), note("c", from: "me"), note("d")]
        XCTAssertEqual(VoiceNoteQueue.next(after: "a", in: notes, me: "me", heard: []), notes[3])
    }

    func testSkipsNotesHeardThisSessionBeforeTheServerCaughtUp() {
        let notes = [note("a"), note("b"), note("c")]
        XCTAssertEqual(VoiceNoteQueue.next(after: "a", in: notes, me: "me", heard: ["b"]), notes[2])
    }

    func testStopsAtTheEndOfTheChain() {
        let notes = [note("a"), note("b", listened: true)]
        XCTAssertNil(VoiceNoteQueue.next(after: "a", in: notes, me: "me", heard: []))
        XCTAssertNil(VoiceNoteQueue.next(after: "missing", in: notes, me: "me", heard: []))
    }

    func testNeverGoesBackwards() {
        let notes = [note("a"), note("b"), note("c")]
        XCTAssertEqual(VoiceNoteQueue.next(after: "b", in: notes, me: "me", heard: []), notes[2])
    }

    func testSkipsANoteStillWaitingForItsAACCopy() {
        let notes = [note("a"), note("b", contentType: "audio/webm"), note("c")]
        XCTAssertEqual(VoiceNoteQueue.next(after: "a", in: notes, me: "me", heard: []), notes[2])
        // Once the copy exists it is playable and in the chain.
        let ready = [note("a"), note("b", contentType: "audio/webm", playback: "https://f/b.m4a")]
        XCTAssertEqual(VoiceNoteQueue.next(after: "a", in: ready, me: "me", heard: []), ready[1])
    }

    func testAServerWithoutReceiptsNeverAutoPlaysTheHistory() {
        // `listenedByMe` absent: unknown reads as heard, so nothing is queued.
        let notes = [note("a"), note("b", listened: nil)]
        XCTAssertNil(VoiceNoteQueue.next(after: "a", in: notes, me: "me", heard: []))
    }
}

// MARK: - Decoding

final class VoiceNoteDecodingTests: XCTestCase {
    private func attachment(voice: String?) throws -> Attachment {
        let tail = voice.map { ",\"voice\":\($0)" } ?? ""
        let json = """
        {"id":"a1","filename":"voice-note.m4a","contentType":"audio/mp4","byteSize":2048,
         "width":null,"height":null,"url":"https://files.example/a1"\(tail)}
        """
        return try Coding.decoder.decode(Attachment.self, from: Data(json.utf8))
    }

    func testAPlainAttachmentHasNoVoiceBlock() throws {
        let decoded = try attachment(voice: nil)
        XCTAssertNil(decoded.voice)
        XCTAssertFalse(decoded.isVoiceNote)
        XCTAssertTrue(decoded.isAudio)
    }

    func testTheFullBlockDecodes() throws {
        let decoded = try attachment(voice: """
        {"durationMs":12000,"waveform":"AAAA","listenedByMe":false,
         "listenedBy":[{"userId":"u1","listenedAt":"2026-10-08T12:00:00.000Z"}],
         "playbackUrl":"https://files.example/copy.m4a"}
        """)
        let voice = try XCTUnwrap(decoded.voice)
        XCTAssertTrue(decoded.isVoiceNote)
        XCTAssertEqual(voice.durationMs, 12_000)
        XCTAssertEqual(voice.listenedByMe, false)
        XCTAssertTrue(voice.isUnplayedForMe)
        XCTAssertEqual(voice.listenedBy?.map(\.userId), ["u1"])
        XCTAssertNotNil(voice.listenedBy?.first?.listenedAt)
        XCTAssertEqual(voice.playbackUrl, "https://files.example/copy.m4a")
    }

    func testEveryFieldPastTheDurationIsOptional() throws {
        let voice = try XCTUnwrap(try attachment(voice: "{\"durationMs\":4000}").voice)
        XCTAssertEqual(voice.waveform, "")
        XCTAssertNil(voice.listenedByMe)
        XCTAssertNil(voice.listenedBy)
        XCTAssertNil(voice.playbackUrl)
        // Unknown receipts are not "unplayed": no dot on a server without them.
        XCTAssertFalse(voice.isUnplayedForMe)
    }

    func testListenedByAcceptsBareUserIdsAndObjects() throws {
        let voice = try XCTUnwrap(try attachment(voice: """
        {"durationMs":4000,"listenedBy":["u1",{"userId":"u2"}]}
        """).voice)
        XCTAssertEqual(voice.listenedBy?.map(\.userId), ["u1", "u2"])
        XCTAssertTrue(voice.heardByAnyone)
    }

    func testAnEmptyPlaybackUrlIsNotACopy() throws {
        let voice = try XCTUnwrap(try attachment(voice: "{\"durationMs\":4000,\"playbackUrl\":\"\"}").voice)
        XCTAssertNil(voice.playbackUrl)
    }

    func testAnUnreadableFieldCostsTheFieldNotTheNote() throws {
        let voice = try XCTUnwrap(try attachment(voice: """
        {"durationMs":4000,"waveform":12,"listenedByMe":"yes","listenedBy":{"nope":1},"playbackUrl":5}
        """).voice)
        XCTAssertEqual(voice.durationMs, 4_000)
        XCTAssertEqual(voice.waveform, "")
        XCTAssertNil(voice.listenedByMe)
        XCTAssertNil(voice.listenedBy)
        XCTAssertNil(voice.playbackUrl)
    }

    func testAVoiceBlockWithNoDurationDegradesToAPlainAudioFile() throws {
        let decoded = try attachment(voice: "{\"waveform\":\"AAAA\"}")
        XCTAssertNil(decoded.voice, "no duration, nothing to draw: the plain audio chip")
        XCTAssertTrue(decoded.isAudio)
    }

    func testAMessageCarriesItsNote() throws {
        let json = """
        {"id":"m1","channelId":"c1","authorId":"u1","authorName":"Dede","body":"",
         "createdAt":"2026-10-08T12:00:00.000Z","reactions":[],
         "attachments":[{"id":"a1","filename":"voice-note.m4a","contentType":"audio/mp4","byteSize":2048,
           "width":null,"height":null,"url":"https://files.example/a1",
           "voice":{"durationMs":72000,"waveform":"","listenedByMe":true}}]}
        """
        let message = try Coding.decoder.decode(Message.self, from: Data(json.utf8))
        XCTAssertEqual(message.attachments.first?.voice?.durationMs, 72_000)
    }

    func testTheVoiceBlockSurvivesTheReadCache() throws {
        // The transcript is cached on disk as JSON this app encodes itself.
        let original = try attachment(voice: """
        {"durationMs":12000,"waveform":"AAAA","listenedByMe":false,"playbackUrl":"https://f/c.m4a"}
        """)
        let data = try Coding.encoder.encode(original)
        let again = try Coding.decoder.decode(Attachment.self, from: data)
        XCTAssertEqual(again, original)
    }

    func testTheConfigReportsVoiceNotes() throws {
        func config(_ json: String) throws -> AttachmentConfig {
            try Coding.decoder.decode(AttachmentConfig.self, from: Data(json.utf8))
        }
        XCTAssertTrue(try config("{\"enabled\":true,\"maxBytes\":10,\"voiceNotes\":true}").offersVoiceNotes)
        XCTAssertFalse(try config("{\"enabled\":true,\"maxBytes\":10,\"voiceNotes\":false}").offersVoiceNotes)
        // A server that predates the flag: off.
        XCTAssertFalse(try config("{\"enabled\":true,\"maxBytes\":10}").offersVoiceNotes)
        // A note is an upload: no storage, no notes, whatever the flag says.
        XCTAssertFalse(try config("{\"enabled\":false,\"maxBytes\":10,\"voiceNotes\":true}").offersVoiceNotes)
    }

    func testTheMintBodyCarriesTheVoiceBlockOnlyForANote() throws {
        struct Probe: Encodable { let voice: VoiceMintBlock? }
        let note = try JSONSerialization.jsonObject(with: Coding.encoder.encode(
            Probe(voice: VoiceMintBlock(durationMs: 1200, waveform: "AAAA"))
        )) as? [String: Any]
        let voice = note?["voice"] as? [String: Any]
        XCTAssertEqual(voice?["durationMs"] as? Int, 1200)
        XCTAssertEqual(voice?["waveform"] as? String, "AAAA")
        let plain = try JSONSerialization.jsonObject(with: Coding.encoder.encode(Probe(voice: nil))) as? [String: Any]
        XCTAssertNil(plain?["voice"])
    }
}

// MARK: - Frames

final class VoiceNoteFrameTests: XCTestCase {
    private func firstEvent(from json: String) async -> RealtimeEvent? {
        let client = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await client.events()
        await client.ingest(Data(json.utf8))
        var iterator = stream.makeAsyncIterator()
        let waiter = Task { await iterator.next() }
        let timeout = Task {
            try? await Task.sleep(for: .seconds(2))
            waiter.cancel()
        }
        let event = await waiter.value
        timeout.cancel()
        return event
    }

    func testListenedFrameDecodes() async {
        let event = await firstEvent(from: """
        {"type":"voice-note-listened","channelId":"c1","messageId":"m1","attachmentId":"a1",
         "userId":"u2","listenedAt":"2026-10-08T12:00:00.000Z"}
        """)
        guard case .voiceNoteListened(let channelId, let messageId, let attachmentId, let userId, let at) = event else {
            return XCTFail("Expected voiceNoteListened, got \(String(describing: event))")
        }
        XCTAssertEqual([channelId, messageId, attachmentId, userId], ["c1", "m1", "a1", "u2"])
        XCTAssertNotNil(at)
    }

    func testListenedFrameSurvivesAnUnreadableTimestamp() async {
        let event = await firstEvent(from: """
        {"type":"voice-note-listened","channelId":"c1","messageId":"m1","attachmentId":"a1",
         "userId":"u2","listenedAt":"yesterday-ish"}
        """)
        guard case .voiceNoteListened(_, _, _, _, let at) = event else {
            return XCTFail("The dot must still clear, got \(String(describing: event))")
        }
        XCTAssertNil(at)
    }

    func testUpdatedFrameDecodesWithOrWithoutTheMessage() async {
        let named = await firstEvent(from: """
        {"type":"voice-note-updated","channelId":"c1","messageId":"m1"}
        """)
        guard case .voiceNoteUpdated(let channelId, let messageId, let message) = named else {
            return XCTFail("Expected voiceNoteUpdated, got \(String(describing: named))")
        }
        XCTAssertEqual(channelId, "c1")
        XCTAssertEqual(messageId, "m1")
        XCTAssertNil(message)

        let whole = await firstEvent(from: """
        {"type":"voice-note-updated","channelId":"c1","message":{"id":"m1","channelId":"c1","authorId":"u1",
         "authorName":"Dede","body":"","createdAt":"2026-10-08T12:00:00.000Z","reactions":[],"attachments":[]}}
        """)
        guard case .voiceNoteUpdated(_, _, let carried) = whole else {
            return XCTFail("Expected voiceNoteUpdated, got \(String(describing: whole))")
        }
        XCTAssertEqual(carried?.id, "m1")
    }

    @MainActor
    func testTheListenFrameClearsTheDotAndLightsTheReceipt() {
        let model = ChatModel()
        model.stage(channelId: "c1", messages: [], draft: "")
        let json = """
        {"id":"m1","channelId":"c1","authorId":"u1","authorName":"Dede","body":"",
         "createdAt":"2026-10-08T12:00:00.000Z","reactions":[],
         "attachments":[{"id":"a1","filename":"v.m4a","contentType":"audio/mp4","byteSize":2048,"url":"https://f/a1",
           "voice":{"durationMs":5000,"waveform":"","listenedByMe":false}}]}
        """
        let message = try! Coding.decoder.decode(Message.self, from: Data(json.utf8))
        model.stage(channelId: "c1", messages: [message])
        // Somebody else listened: the receipt appears on the author's copy.
        model.apply(.voiceNoteListened(channelId: "c1", messageId: "m1", attachmentId: "a1",
                                       userId: "u2", listenedAt: Date()))
        XCTAssertEqual(model.messages[0].attachments[0].voice?.listenedBy?.map(\.userId), ["u2"])
        // The same frame twice is one receipt.
        model.apply(.voiceNoteListened(channelId: "c1", messageId: "m1", attachmentId: "a1",
                                       userId: "u2", listenedAt: Date()))
        XCTAssertEqual(model.messages[0].attachments[0].voice?.listenedBy?.count, 1)
        // Another channel's frame is none of this transcript's business.
        model.apply(.voiceNoteListened(channelId: "other", messageId: "m1", attachmentId: "a1",
                                       userId: "u3", listenedAt: nil))
        XCTAssertEqual(model.messages[0].attachments[0].voice?.listenedBy?.count, 1)
    }
}

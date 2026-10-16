import XCTest
@testable import pqp

/// Voice note transcripts: the wire, what goes under the card, the opt-out, and
/// what a frame does to a transcript. The web's `voice-note-transcript.tsx` and
/// `voice-transcription-prefs.ts`, case for case.
final class VoiceTranscriptTests: XCTestCase {
    private func transcript(_ status: String, _ text: String? = nil) -> VoiceNoteTranscript {
        VoiceNoteTranscript(status: status, text: text, language: nil)
    }

    private func line(
        _ transcript: VoiceNoteTranscript?, shows: Bool = true, isMine: Bool = false,
        request: VoiceTranscriptRequest = .idle
    ) -> VoiceTranscriptLine {
        VoiceTranscriptLine.resolve(transcript: transcript, shows: shows, isMine: isMine, request: request)
    }

    // MARK: - The wire

    func testAVoiceBlockDecodesItsTranscriptAndATranscriptlessOneStillDecodes() throws {
        let with = #"{"durationMs":4000,"waveform":"","transcript":{"status":"done","text":"bora jogar","language":"pt"}}"#
        let note = try Coding.decoder.decode(VoiceNote.self, from: Data(with.utf8))
        XCTAssertEqual(note.transcript, VoiceNoteTranscript(status: "done", text: "bora jogar", language: "pt"))
        let without = try Coding.decoder.decode(VoiceNote.self, from: Data(#"{"durationMs":4000}"#.utf8))
        XCTAssertNil(without.transcript)
    }

    func testABrokenTranscriptBlockCostsTheLineNotTheNote() throws {
        let note = try Coding.decoder.decode(VoiceNote.self, from: Data(#"{"durationMs":4000,"transcript":{"text":5}}"#.utf8))
        XCTAssertEqual(note.durationMs, 4000)
        XCTAssertNil(note.transcript)
    }

    func testAStatusANewerServerInventsReadsAsNothingToDraw() {
        XCTAssertEqual(transcript("brand_new_state").kind, .unknown)
        XCTAssertEqual(line(transcript("brand_new_state")), .none)
    }

    func testTheFrameDecodes() throws {
        let json = #"{"type":"voice-note-transcript","channelId":"c1","messageId":"m1","attachmentId":"a1","transcript":{"status":"pending"}}"#
        let frame = try Coding.decoder.decode(VoiceNoteTranscriptFrame.self, from: Data(json.utf8))
        XCTAssertEqual(frame.attachmentId, "a1")
        XCTAssertEqual(frame.transcript.kind, .pending)
    }

    // MARK: - What goes under the card

    func testEachStateDrawsWhatTheWebDraws() {
        XCTAssertEqual(line(transcript("done", " bora jogar ")), .text("bora jogar"))
        XCTAssertEqual(line(transcript("done", "   ")), .none, "an empty text draws nothing")
        XCTAssertEqual(line(transcript("pending")), .pending)
        XCTAssertEqual(line(transcript("no_speech")), .noSpeech)
        XCTAssertEqual(line(transcript("failed")), .failed)
        XCTAssertEqual(line(transcript("unavailable")), .none, "nothing to say and nothing to press")
        XCTAssertEqual(line(nil), .none, "no block on the read: no transcript where this note lives")
    }

    func testTranscribeIsOfferedOnSomeoneElsesNoteWithNoneYet() {
        XCTAssertEqual(line(transcript("none")), .request(.idle))
        XCTAssertEqual(line(transcript("none"), isMine: true), .none, "your own notes never offer it")
        XCTAssertEqual(line(transcript("none"), request: .slow), .request(.slow))
        XCTAssertEqual(line(transcript("none"), request: .failed), .request(.failed))
        XCTAssertEqual(line(transcript("none"), request: .refused), .none, "no button to press in vain")
    }

    func testTurningTranscriptsOffHidesEveryOne() {
        for status in ["done", "pending", "no_speech", "failed", "none"] {
            XCTAssertEqual(line(transcript(status, "texto"), shows: false), .none, status)
        }
    }

    func testLongTextsOfferShowMoreWithoutMeasuring() {
        XCTAssertFalse(VoiceTranscriptLine.isLong(String(repeating: "a", count: VoiceTranscriptLine.longText)))
        XCTAssertTrue(VoiceTranscriptLine.isLong(String(repeating: "a", count: VoiceTranscriptLine.longText + 1)))
    }

    // MARK: - What a refused request means

    func testARequestFailureSaysWhatKindItWas() {
        XCTAssertEqual(VoiceTranscriptRequest.from(APIError.rateLimited(retryAfter: 3)), .slow)
        XCTAssertEqual(VoiceTranscriptRequest.from(APIError.notFound("gone")), .refused)
        XCTAssertEqual(VoiceTranscriptRequest.from(APIError.server(status: 403, message: "no")), .refused)
        XCTAssertEqual(VoiceTranscriptRequest.from(APIError.server(status: 503, message: "down")), .failed)
        XCTAssertEqual(VoiceTranscriptRequest.from(APIError.transport("offline")), .failed)
    }

    // MARK: - The opt-out

    func testBothHalvesAreOnUntilTurnedOff() {
        let none = UserPreferences()
        XCTAssertTrue(none.transcribesMyNotes)
        XCTAssertTrue(none.showsTranscripts)
        var off = UserPreferences()
        off.voiceTranscription = VoiceTranscriptionPreferences(mine: false, show: nil)
        XCTAssertFalse(off.transcribesMyNotes)
        XCTAssertTrue(off.showsTranscripts, "an absent half reads as on")
    }

    func testAWriteAlwaysCarriesBothHalves() throws {
        let next = UserPreferences().settingTranscription(mine: false)
        XCTAssertEqual(next.voiceTranscription, VoiceTranscriptionPreferences(mine: false, show: true))
        let again = next.settingTranscription(show: false)
        XCTAssertEqual(again.voiceTranscription, VoiceTranscriptionPreferences(mine: false, show: false))
        let json = String(decoding: try Coding.encoder.encode(again), as: UTF8.self)
        XCTAssertTrue(json.contains("\"mine\":false") && json.contains("\"show\":false"), json)
    }

    func testTheAttachmentConfigNeedsBothFlagsForATranscript() throws {
        func config(_ json: String) throws -> AttachmentConfig {
            try Coding.decoder.decode(AttachmentConfig.self, from: Data(json.utf8))
        }
        XCTAssertTrue(try config(#"{"enabled":true,"maxBytes":1,"voiceNotes":true,"voiceTranscription":true}"#).offersTranscription)
        XCTAssertFalse(try config(#"{"enabled":true,"maxBytes":1,"voiceNotes":false,"voiceTranscription":true}"#).offersTranscription)
        XCTAssertFalse(try config(#"{"enabled":true,"maxBytes":1,"voiceNotes":true}"#).offersTranscription, "an older server: off")
    }

    // MARK: - A frame lands in its note

    @MainActor
    func testAFrameMergesIntoItsNoteAndIgnoresOtherChannels() throws {
        let model = ChatModel()
        let json = """
        {"id":"m1","channelId":"c1","authorId":"u1","authorName":"Dede","body":"",
         "createdAt":"2026-10-08T12:00:00.000Z","reactions":[],
         "attachments":[{"id":"a1","filename":"v.m4a","contentType":"audio/mp4","byteSize":2048,"url":"https://f/a1",
           "voice":{"durationMs":5000,"waveform":"","transcript":{"status":"none"}}}]}
        """
        let message = try Coding.decoder.decode(Message.self, from: Data(json.utf8))
        model.stage(channelId: "c1", messages: [message])
        model.apply(.voiceNoteTranscript(channelId: "c1", messageId: "m1", attachmentId: "a1", transcript: transcript("pending")))
        XCTAssertEqual(model.messages[0].attachments[0].voice?.transcript?.kind, .pending)
        model.apply(.voiceNoteTranscript(channelId: "c1", messageId: "m1", attachmentId: "a1", transcript: transcript("done", "oi")))
        XCTAssertEqual(model.messages[0].attachments[0].voice?.transcript?.text, "oi")
        model.apply(.voiceNoteTranscript(channelId: "other", messageId: "m1", attachmentId: "a1", transcript: transcript("failed")))
        XCTAssertEqual(model.messages[0].attachments[0].voice?.transcript?.kind, .done, "another channel's frame is not ours")
    }
}

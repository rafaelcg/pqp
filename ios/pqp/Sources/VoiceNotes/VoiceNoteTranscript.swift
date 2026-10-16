import Foundation

// VOICE NOTE TRANSCRIPTS on the phone.
//
// The `voice_note_transcription` flag is on, and it defaults to transcribing:
// a note recorded on a phone has been sent to the speech-to-text provider since
// the flag went on, and nobody on a phone could read the result or opt out.
// This is the phone's half, from `packages/shared/src/attachments.ts`
// (`voiceNoteTranscriptSchema`), the `voice-note-transcript` frame
// (`chat.ts`) and the web's `voice-note-transcript.tsx` /
// `voice-transcription-prefs.ts`. Everything that decides something is here, in
// pure functions, where a test can see it; the card and the Settings rows only
// draw it.

/// A note's transcript as it travels: on the attachment's `voice` block, on the
/// `voice-note-transcript` frame and as the answer to
/// `POST /api/attachments/:id/transcript`. `text` is set only when `status` is
/// `done`. Absent from a read when the flag is off where the note lives.
struct VoiceNoteTranscript: Codable, Hashable, Sendable {
    /// `none`, `pending`, `done`, `no_speech`, `failed`, `unavailable`. A string
    /// so a state a newer server invents reads as "nothing to draw" instead of
    /// failing the whole message.
    var status: String
    var text: String?
    var language: String?

    var kind: Kind { Kind(rawValue: status) ?? .unknown }

    enum Kind: String, Sendable {
        case none, pending, done, noSpeech = "no_speech", failed, unavailable, unknown
    }
}

/// The two halves of transcription, both on until turned off
/// (`voiceTranscriptionPrefs` in `packages/shared/src/api.ts`).
///
///  - `mine`: my notes may be transcribed. The server copies it onto each note
///    when it is minted, so turning it off never reaches back into notes
///    already sent.
///  - `show`: I read transcripts. Off hides every transcript from this account.
///
/// Replaced as a whole on write: both halves are always sent.
struct VoiceTranscriptionPreferences: Codable, Hashable, Sendable {
    var mine: Bool?
    var show: Bool?
}

extension UserPreferences {
    var transcribesMyNotes: Bool { voiceTranscription?.mine != false }
    var showsTranscripts: Bool { voiceTranscription?.show != false }

    /// The preference with one half changed and the other kept: both go up on
    /// every write.
    func settingTranscription(mine: Bool? = nil, show: Bool? = nil) -> UserPreferences {
        var next = self
        next.voiceTranscription = VoiceTranscriptionPreferences(
            mine: mine ?? transcribesMyNotes, show: show ?? showsTranscripts
        )
        return next
    }
}

/// What a request for a transcript came to, for the line under the card.
enum VoiceTranscriptRequest: Equatable, Sendable {
    case idle
    case asking
    /// 429: "calma, tenta de novo daqui a pouco".
    case slow
    /// The server said no for this note (a 4xx other than 429): no button to
    /// press in vain.
    case refused
    /// Anything else (a transport error, a 5xx): try again.
    case failed

    static func from(_ error: any Error) -> VoiceTranscriptRequest {
        guard let api = error as? APIError else { return .failed }
        switch api {
        case .rateLimited: return .slow
        case .notFound, .unauthorized: return .refused
        case .server(let status, _) where (400..<500).contains(status): return .refused
        default: return .failed
        }
    }
}

/// What goes under a voice note's card, decided from the data alone. The web's
/// `VoiceNoteTranscriptLine`, case for case.
enum VoiceTranscriptLine: Equatable, Sendable {
    case none
    case text(String)
    case pending
    case noSpeech
    case failed
    /// "Transcrever": explicit rather than automatic, because a transcript in a
    /// server channel is paid for by the first person who asks.
    case request(VoiceTranscriptRequest)

    /// Past this many characters a transcript is long enough to need "ver mais"
    /// without measuring.
    static let longText = 140

    static func resolve(
        transcript: VoiceNoteTranscript?, shows: Bool, isMine: Bool, request: VoiceTranscriptRequest
    ) -> VoiceTranscriptLine {
        // Nothing at all unless the message was read WITH a transcript block (the
        // server leaves it off where transcripts do not exist or its sender did
        // not allow it) and this reader has transcripts on.
        guard shows, let transcript else { return .none }
        switch transcript.kind {
        case .done:
            let text = transcript.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return text.isEmpty ? .none : .text(text)
        case .pending: return .pending
        case .noSpeech: return .noSpeech
        case .failed: return .failed
        case .unavailable, .unknown:
            // No provider, or the day's budget is spent: nothing to say and nothing
            // to press.
            return .none
        case .none:
            // The only state with something to offer. Your own notes never offer
            // it, and a refusal leaves no button.
            if isMine || request == .refused { return .none }
            return .request(request)
        }
    }

    static func isLong(_ text: String) -> Bool { text.count > longText }
}

/// `voice-note-transcript`: `{channelId, messageId, attachmentId, transcript}`.
/// Decoded on its own, so a state this build cannot read costs that update and
/// nothing else.
struct VoiceNoteTranscriptFrame: Decodable, Sendable {
    let channelId: String
    let messageId: String
    let attachmentId: String
    let transcript: VoiceNoteTranscript
}

extension APIClient {
    /// `POST /api/attachments/:id/transcript`: ask for one. The answer is the
    /// settled state (or `pending`, with the text arriving on the frame).
    func requestTranscript(attachmentId: String) async throws -> VoiceNoteTranscript {
        struct Response: Decodable { let transcript: VoiceNoteTranscript }
        let response: Response = try await post("/api/attachments/\(attachmentId)/transcript", body: EmptyBody())
        return response.transcript
    }
}

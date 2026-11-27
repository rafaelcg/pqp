import Foundation

// WHAT THE PHONE READS OF PUBLIC JAM: the wire of take notices, and nothing
// else. The phones have no public jam view (a public song opens on the web),
// so this is only the part a SONG THE PHONE CAN ALREADY OPEN needs: the
// starter's inbox of outside takes waiting for an answer, the durable notice
// items, and the two live frames. The contract is `packages/shared/src/jam-public.ts`
// (`jamTakeNoticeSchema`, `jamPublicNoticeSchema`, `jamTakeDecisionSchema`,
// `jamPublicInboxItemSchema`, `jamPublicMeConfigSchema`), decoded leniently the
// way the schemas' `.catch` does: an instrument or a kind this build does not
// know reads as the schema's fallback and never costs the whole list.

/// `GET /api/jam-public/config`. Off on any failure, which is what keeps every
/// surface below invisible on a server that has not turned public jam on.
struct JamPublicConfig: Decodable, Equatable, Sendable {
    let enabled: Bool

    static let off = JamPublicConfig(enabled: false)

    init(enabled: Bool) { self.enabled = enabled }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
    }

    private enum CodingKeys: String, CodingKey { case enabled }
}

/// The three kinds of a take notice (`JAM_TAKE_NOTICE_KINDS`). The schema reads
/// an unknown kind as `take`, so a newer server cannot make this build show the
/// sender a question.
enum JamTakeNoticeKind: String, Sendable {
    case take, accepted, refused

    init(wire: String?) {
        self = wire.flatMap(JamTakeNoticeKind.init(rawValue:)) ?? .take
    }
}

/// One open item of `GET /api/jam-public/notices`: parts waiting for this
/// account as a starter (`take`), or the starter's answer to its own part
/// (`accepted`, `refused`). `count` and `instruments` of a `take` item are read
/// live by the server from the takes still waiting.
struct JamTakeNotice: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let kind: JamTakeNoticeKind
    let songId: String
    let title: String
    let instruments: [JamInstrument]
    let count: Int
    let createdAt: Date
    let updatedAt: Date

    init(
        id: String, kind: JamTakeNoticeKind, songId: String, title: String,
        instruments: [JamInstrument] = [], count: Int = 1,
        createdAt: Date = Date(), updatedAt: Date = Date()
    ) {
        self.id = id
        self.kind = kind
        self.songId = songId
        self.title = title
        self.instruments = instruments
        self.count = max(1, count)
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, songId, title, instruments, count, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = JamTakeNoticeKind(wire: try c.decodeIfPresent(String.self, forKey: .kind))
        songId = try c.decode(String.self, forKey: .songId)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        instruments = try c.decodeIfPresent([JamInstrument].self, forKey: .instruments) ?? []
        count = max(1, try c.decodeIfPresent(Int.self, forKey: .count) ?? 1)
        // A date this build cannot read is "now", never a dropped notice.
        createdAt = (try? c.decode(Date.self, forKey: .createdAt)) ?? Date(timeIntervalSince1970: 0)
        updatedAt = (try? c.decode(Date.self, forKey: .updatedAt)) ?? createdAt
    }
}

struct JamTakeNoticesResponse: Decodable, Sendable {
    let notices: [JamTakeNotice]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // One item this build cannot read is skipped, not the whole list.
        notices = (try c.decodeIfPresent([Lossy<JamTakeNotice>].self, forKey: .notices) ?? []).compactMap(\.value)
    }

    private enum CodingKeys: String, CodingKey { case notices }
}

/// One outside take waiting for the starter, from `GET /api/jam-public/inbox`.
/// `track` is the private shape (`JamTrack`), so the starter can audition it.
struct JamPublicInboxItem: Decodable, Identifiable, Hashable, Sendable {
    let songId: String
    let songTitle: String
    let track: JamTrack

    var id: String { track.id }

    init(songId: String, songTitle: String, track: JamTrack) {
        self.songId = songId
        self.songTitle = songTitle
        self.track = track
    }
}

struct JamPublicInboxResponse: Decodable, Sendable {
    let takes: [JamPublicInboxItem]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        takes = (try c.decodeIfPresent([Lossy<JamPublicInboxItem>].self, forKey: .takes) ?? []).compactMap(\.value)
    }

    private enum CodingKeys: String, CodingKey { case takes }
}

// MARK: - Live frames

/// `jam-public-notice`, to one account. Only `take` matters to this build (the
/// starter's live nudge: read the lists again); every other kind (`consent`,
/// `removed`, `unpublished`, `part-removed`, `approved`, `rejected`) is a public
/// jam matter the phone has no surface for, and is kept as `.other` so it still
/// counts as "something changed, read again" without being mistaken for a take.
struct JamPublicNoticeFrame: Equatable, Sendable {
    enum Kind: String, Sendable {
        case consent, take, removed, unpublished
        case partRemoved = "part-removed"
        case approved, rejected
    }

    let kind: Kind
    let songId: String
    let title: String
    /// `take` only: auto-accept already put it in the mix, nothing waits.
    let admitted: Bool
    /// `take` only: the instrument that just arrived. Nil from a server that
    /// predates it.
    let instrument: JamInstrument?
}

/// `jam-take-decision`, to the SENDER of a take: the starter put it in the mix
/// or declined it. Its own frame type on purpose (see the shared schema), so a
/// build that does not know it ignores it.
struct JamTakeDecisionFrame: Equatable, Sendable {
    enum Decision: String, Sendable { case accepted, refused }

    let decision: Decision
    let songId: String
    let title: String
    let instrument: JamInstrument
}

enum JamPublicFrame: Equatable, Sendable {
    case notice(JamPublicNoticeFrame)
    case decision(JamTakeDecisionFrame)

    static let types: Set<String> = ["jam-public-notice", "jam-take-decision"]

    private struct Envelope: Decodable {
        let type: String
        let kind: String?
        let decision: String?
        let songId: String?
        let title: String?
        let admitted: Bool?
        let instrument: String?
    }

    /// A frame this build cannot read (a missing id, a decision it does not
    /// know) is dropped, not guessed at.
    static func parse(_ data: Data) -> JamPublicFrame? {
        guard let e = try? Coding.decoder.decode(Envelope.self, from: data),
              let songId = e.songId, !songId.isEmpty else { return nil }
        let instrument = e.instrument.map { JamInstrument(rawValue: $0) ?? .other }
        switch e.type {
        case "jam-public-notice":
            // The schema reads an unknown kind as `consent` (`.catch`), so this
            // does too: a kind from a newer server is never a take.
            let kind = e.kind.flatMap(JamPublicNoticeFrame.Kind.init(rawValue:)) ?? .consent
            return .notice(JamPublicNoticeFrame(
                kind: kind, songId: songId, title: e.title ?? "",
                admitted: e.admitted ?? false, instrument: instrument
            ))
        case "jam-take-decision":
            guard let decision = e.decision.flatMap(JamTakeDecisionFrame.Decision.init(rawValue:)) else { return nil }
            return .decision(JamTakeDecisionFrame(
                decision: decision, songId: songId, title: e.title ?? "", instrument: instrument ?? .other
            ))
        default:
            return nil
        }
    }
}

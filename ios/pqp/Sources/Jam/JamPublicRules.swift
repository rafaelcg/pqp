import Foundation

// THE RULES OF TAKE NOTICES, PURE. What the starter's inbox says about a song,
// which one card a person is shown, what a card's sentence is, and how an
// answer reads. Mirrors `client/src/lib/jam-public-store.ts`,
// `jam-notice-placement.ts`, `jam-take-notice-cards.tsx` and
// `jam-answer-notice.tsx`; the copy is the web's own (`jam.public.*` keys).

enum JamWaiting {
    /// Takes from outside waiting for this account's answer on one song.
    static func tracks(in inbox: [JamPublicInboxItem], songId: String) -> [JamTrack] {
        inbox.filter { $0.songId == songId }.map(\.track)
    }

    static func count(in inbox: [JamPublicInboxItem], songId: String) -> Int {
        inbox.reduce(0) { $0 + ($1.songId == songId ? 1 : 0) }
    }

    /// Every song with something waiting, for the wall's tile marker.
    static func counts(in inbox: [JamPublicInboxItem]) -> [String: Int] {
        inbox.reduce(into: [:]) { $0[$1.songId, default: 0] += 1 }
    }

    /// The wall's row: with every waiting part on ONE song its button opens that
    /// song, where they are the first thing on the page; across several songs
    /// it has no single place to go (the web opens a dialog, the phone asks the
    /// person to pick a marked tile, see `JamWaitingRow`).
    static func soleSong(in inbox: [JamPublicInboxItem]) -> String? {
        let songs = Set(inbox.map(\.songId))
        return songs.count == 1 ? songs.first : nil
    }

    /// The waiting parts that belong on THIS wall: the ones whose song is one of
    /// the wall's. The inbox is account-wide (a starter's songs in every jam
    /// channel and standalone), and a wall counts only what it can open.
    static func onWall(_ inbox: [JamPublicInboxItem], songIds: Set<String>) -> [JamPublicInboxItem] {
        inbox.filter { songIds.contains($0.songId) }
    }
}

/// Which card is drawn, and how many wait behind it (`jamNoticeQueue`: one at a
/// time, the newest first, with a count of the rest).
struct JamNoticeQueue: Equatable, Sendable {
    let card: JamTakeNotice?
    let more: Int

    static func of(_ notices: [JamTakeNotice]) -> JamNoticeQueue {
        JamNoticeQueue(card: notices.first, more: max(0, notices.count - 1))
    }
}

/// The sentence of a card, in the web's words (`jam.public.card.*`).
enum JamNoticeText {
    /// "chegou uma parte de baixo", "3 partes esperando tua resposta em ...".
    static func card(_ notice: JamTakeNotice) -> String {
        let title = JamBidi.isolate(notice.title)
        let names = ListFormatter.localizedString(
            byJoining: notice.instruments.map { $0 == .other ? String(localized: "another instrument") : $0.name }
        )
        switch (notice.kind, notice.count == 1) {
        case (.take, true):
            return String(localized: "A \(names) part arrived in \"\(title)\".")
        case (.take, false):
            return String(localized: "\(notice.count) parts are waiting for your answer in \"\(title)\" (\(names)).")
        case (.accepted, true):
            return String(localized: "Your \(names) part is in \"\(title)\".")
        case (.accepted, false):
            return String(localized: "\(notice.count) of your parts are in \"\(title)\".")
        case (.refused, true):
            return String(localized: "Your \(names) part in \"\(title)\" did not make it in.")
        case (.refused, false):
            return String(localized: "\(notice.count) of your parts in \"\(title)\" did not make it in.")
        }
    }

    /// The same sentence for VoiceOver: no isolate characters, only the explicit
    /// bidi controls dropped (read in logical order).
    static func spoken(_ notice: JamTakeNotice) -> String {
        JamBidi.clean(card(notice))
    }
}

/// What happened when the starter answered an outside part, said where they
/// answered (`jam-answer-notice.tsx`): in, with "Undo" for a few seconds; back in
/// the queue; or declined (no undo: a declined take is deleted and the API has no
/// way to bring it back).
struct JamAnswer: Equatable, Sendable {
    enum Kind: Equatable, Sendable { case accepted, undone, refused }

    let kind: Kind
    let trackId: String
    let instrument: JamInstrument
    /// The sender, as the starter sees them.
    let name: String?

    /// How long the answer stays, and how long "Undo" is offered (the same
    /// window: the button is the point of the box).
    static let seconds: Double = 8
    static let undoneSeconds: Double = 5

    var visibleFor: Double { kind == .undone ? Self.undoneSeconds : Self.seconds }

    func text() -> String {
        let instrument = self.instrument.name
        let person = JamBidi.isolate(name.map(JamBidi.clean).flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "Deleted account"))
        switch kind {
        case .accepted:
            return String(localized: "\(person): the \(instrument) part is in the song. It already shows for anyone who opens it, on the site and in the app.")
        case .undone:
            return String(localized: "Back in the queue. \(person)'s \(instrument) part is still waiting for your answer.")
        case .refused:
            return String(localized: "Part declined. \(person)'s \(instrument) part stays out of the song, and \(person) is told.")
        }
    }
}

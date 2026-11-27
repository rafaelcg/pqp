import Foundation

// WHAT A SHARED SONG SAYS. The twin of the web's "chama a galera"
// (`client/src/lib/jam-share-text.ts`, `jam-share-link.ts`, PR #1773): for a song
// that is PUBLIC, the message asks for the part the song is still missing and
// the link is the song's public page (anybody can open it, no account); a song
// that is not public keeps the link it always had, the channel permalink
// (`JamLinks.song`), because a stranger could not open the public one.
//
// The message never carries a "made with" line: it is the person's own message
// to their own people, and the link at its end is the only mention of pqp.

enum JamShareKind: Equatable, Sendable {
    /// The song asks for parts: "falta baixo nessa. Grava a tua parte:".
    case needs
    /// Any part is welcome, none is asked for by name.
    case open
    /// Nothing is missing (complete, or closed): an invitation to listen.
    case listen
}

enum JamShare {
    /// The one rule for what a song still asks for: the instruments it wants,
    /// minus those already in the band, minus the ones THE SHARER sent that wait
    /// for the starter (they cannot ask their friends for a part they just
    /// sent). An open or closed song names nothing. `jamStillNeeds`.
    static func stillNeeds(
        _ song: JamSongSummary, pending: [JamInstrument] = []
    ) -> [JamInstrument] {
        guard song.joinMode == .wanted else { return [] }
        return song.wantedInstruments.filter { !pending.contains($0) && !song.instruments.contains($0) }
    }

    /// The instruments of the viewer's own parts that wait for somebody else's
    /// answer: recorded by them, out of the mix, on a song they did not start.
    /// `jamPendingOf`.
    static func pending(tracks: [JamTrack], viewerId: String?, isStarter: Bool) -> [JamInstrument] {
        guard let viewerId, !isStarter else { return [] }
        var seen: [JamInstrument] = []
        for track in tracks where track.authorId == viewerId && !track.inMix && !seen.contains(track.instrument) {
            seen.append(track.instrument)
        }
        return seen
    }

    static func kind(joinMode: JamJoinMode, needs: [JamInstrument]) -> JamShareKind {
        if joinMode == .closed { return .listen }
        if !needs.isEmpty { return .needs }
        return joinMode == .open ? .open : .listen
    }

    /// The song's public page, tagged `ref=share` so a sign-up that comes out of
    /// it is its own row in the acquisition report (`jamPublicSongLink`):
    /// `jam.pqp.gg/m/<id>` on the hosted instance. Never an `/app/...` address,
    /// which a stranger cannot open.
    static func publicLink(songId: String) -> URL? {
        URL(string: "https://jam.pqp.gg/m/\(songId)?ref=share")
    }

    /// Only a song a stranger can open gets the public message and link: its
    /// publication is `live` and it lives in a channel (the phone has no
    /// standalone public jam).
    static func isShareable(publicationStatus: String?) -> Bool { publicationStatus == "live" }

    /// What goes to the share sheet: the message, a space, the link, the way the
    /// web composes it for WhatsApp (`${text} ${url}`).
    static func shareItem(text: String, link: URL) -> String { "\(text) \(link.absoluteString)" }

    /// The prepared message, without the link (the link travels beside it).
    static func text(song: JamSongSummary, pending: [JamInstrument]) -> String {
        let needs = stillNeeds(song, pending: pending)
        let title = JamBidi.clean(song.title)
        let list = ListFormatter.localizedString(byJoining: needs.map(\.name))
        let mine = ListFormatter.localizedString(byJoining: pending.map(\.name))
        // One key per sentence, with BOTH languages in the catalogue: pt-BR says
        // "falta" for one and "faltam" for several where the English does not change.
        let key: String
        switch (kind(joinMode: song.joinMode, needs: needs), pending.isEmpty, needs.count == 1) {
        case (.needs, true, true): key = "jam.share.text.needsOne"
        case (.needs, true, false): key = "jam.share.text.needsMany"
        case (.open, true, _): key = "jam.share.text.open"
        case (.listen, true, _): key = "jam.share.text.listen"
        case (.needs, false, true): key = "jam.share.textSent.needsOne"
        case (.needs, false, false): key = "jam.share.textSent.needsMany"
        case (.open, false, _): key = "jam.share.textSent.open"
        case (.listen, false, _): key = "jam.share.textSent.listen"
        }
        let format = Bundle.main.localizedString(forKey: key, value: nil, table: nil)
        // `%1$@` is the title, `%2$@` the list of what is missing, `%3$@` the sender's own parts.
        let sentence = String(format: format, title, list, mine)
        return sentence
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

extension APIClient {
    /// `GET /api/jam-songs/:id/public`: where the song stands as a public jam,
    /// or nil when it was never published or the read failed. Only the status
    /// is read; "do not know" is "not public", which keeps today's link.
    func jamPublicationStatus(songId: String) async -> String? {
        struct Answer: Decodable {
            struct Publication: Decodable { let status: String }
            let publication: Publication?
        }
        let answer: Answer? = try? await get("/api/jam-songs/\(songId)/public")
        return answer?.publication?.status
    }
}

import Foundation

// FINDING A SONG ON THE WALL. The twin of the web's palette search
// (`client/src/hooks/use-jam-song-search.ts`): the SERVER does the matching and
// the authorization (`GET /api/channels/:id/jam-songs?q=`, title and artist,
// accent- and case-blind, and only songs this viewer may see), so the phone never
// filters a list of its own. Asked once the words have settled and are long
// enough to mean something; the answer for words that are no longer the words is
// dropped. Any failure is an empty list: a search that cannot reach the jam is
// just a search with no songs.

enum JamSongSearch {
    /// Two letters mean something; one is every song.
    static let minLength = 2
    /// How long the words must stay still before they are asked.
    static let settle: Duration = .milliseconds(180)
    /// `JAM_SEARCH_MAX`: the server refuses more, so the field stops here.
    static let maxLength = 100
    /// A page of results. The web's palette shows 6 because it is a palette; a
    /// wall shows a page of songs, like its own list.
    static let limit = JamLimits.pageSize

    /// The words that are asked: trimmed, and nil while they are too short.
    static func words(_ typed: String) -> String? {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= minLength else { return nil }
        return String(trimmed.prefix(maxLength))
    }
}

/// What the search has to show.
enum JamSearchState: Equatable {
    /// Nothing typed that means something yet: the wall is the wall.
    case idle
    /// The words are out.
    case searching(words: String)
    case results(words: String, songs: [JamSongSummary])
    /// The server could not be reached or refused: NOT an empty result. What was
    /// on screen before stays (`kept`), with the failure and a retry above it.
    case failed(words: String, kept: [JamSongSummary])
}

extension APIClient {
    /// `GET /api/channels/:id/jam-songs?q=`, newest activity first, one page.
    func searchJamSongs(channelId: String, words: String, limit: Int = JamSongSearch.limit) async throws -> [JamSongSummary] {
        let query = [
            URLQueryItem(name: "q", value: words),
            URLQueryItem(name: "limit", value: String(min(limit, JamLimits.pageMax))),
        ]
        let page: JamSongListResponse = try await get("/api/channels/\(channelId)/jam-songs", query: query)
        return page.songs
    }
}

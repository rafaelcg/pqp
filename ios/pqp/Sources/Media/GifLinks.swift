import Foundation

/// A message body that is nothing but a GIF URL.
///
/// GIFs reach a channel by two routes and only one of them is an attachment.
/// The picker calls `POST /api/channels/:id/attachments/gif`, which stores a
/// row with a remote URL, so those arrive in `message.attachments` and render
/// there. A **pasted** link does not: it is stored as the message body and
/// nothing else, and `packages/shared/src/gifs.ts` is where the other clients
/// agree that such a body renders as media rather than as text (the web in
/// `client/src/lib/gif-media.ts`, Android in `ui/media/GifLinks.kt`).
///
/// Without this, a Klipy link that animates on the web and on Android reads
/// on iOS as a hundred characters of URL.
///
/// The allowlist is a security boundary rather than a convenience: a body is
/// drawn as a picture from a host we did not upload to, so anything outside
/// these hosts stays a piece of text. It is copied from shared by hand, like
/// every other wire fact in this layer, and `GifLinksTests` reads
/// `packages/shared/src/gifs.ts` off disk and fails when the two drift.
enum GifLinks {
    /// Hosts whose URLs may be drawn as an image. Anchored at both ends,
    /// exactly as the shared regexes are. `giphy.com` itself is deliberately
    /// absent: only the media subdomains serve bytes.
    ///
    /// Computed, not stored: `Regex` is not `Sendable`, and a stored static of
    /// it is shared mutable state under strict concurrency. Five literals are
    /// cheap to build per message body.
    static var mediaHosts: [Regex<Substring>] { [
        // Klipy is the live search provider; every picker result points here.
        /^static\.klipy\.com$/,
        // GIPHY and Tenor no longer back the search, but stored messages
        // hot-link them and must keep rendering.
        /^media\d*\.giphy\.com$/,
        /^i\.giphy\.com$/,
        /^media\d*\.tenor\.com$/,
        /^c\.tenor\.com$/,
    ] }

    static let mediaExtensions = [".gif", ".webp", ".png", ".jpg", ".jpeg"]

    /// True when a URL may be drawn as an image rather than shown as a link.
    static func isMediaURL(_ value: String) -> Bool {
        parse(value) != nil
    }

    /// Read a body as inline media, or nil when it is ordinary text.
    ///
    /// A body qualifies only when it is *nothing but* an allowlisted URL. Any
    /// surrounding words mean somebody wrote a sentence that contains a link,
    /// and swallowing the sentence to show the picture would lose what they
    /// said. Same rule as `gifMessageMedia` on the web, for the same reason.
    static func mediaBody(_ body: String) -> URL? {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else {
            return nil
        }
        return parse(trimmed)
    }

    private static func parse(_ value: String) -> URL? {
        guard let components = URLComponents(string: value), let url = components.url else { return nil }

        // https only, and no embedded credentials. Both are copied from
        // shared: http would be a mixed-content block in a browser, and
        // `https://media.giphy.com@evil.example/a.gif` is the classic way to
        // make a hostile host read as a trusted one to somebody skimming.
        guard components.scheme?.lowercased() == "https" else { return nil }
        guard components.user == nil, components.password == nil else { return nil }

        guard let host = components.host?.lowercased(), !host.isEmpty else { return nil }
        guard mediaHosts.contains(where: { host.wholeMatch(of: $0) != nil }) else { return nil }

        // Only the path decides. `?x=.gif` on an HTML page would otherwise be
        // enough to get that page drawn as a picture.
        let path = components.path.lowercased()
        guard mediaExtensions.contains(where: { path.hasSuffix($0) }) else { return nil }

        return url
    }
}

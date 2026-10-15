import Foundation

// Compartilhar on a public Baú post: the link the system share sheet is handed.
//
// THE SWIFT TWIN of `bauShareUrl` in `packages/shared/src/community-home-public.ts`.
// The page's address (`publicUrl`) always comes from the API, which is the only
// side that knows the post has a page (published, free, an addressed community,
// the flag on). The app adds the campaign and nothing else: it never builds the
// address from a slug and an id, and with no `publicUrl` there is no button.
//
// Pure and free of SwiftUI so `BauPublicShareTests` can pin it.

enum BauPublicShare {
    /// `utm_source` for every link that leaves through the iOS share sheet.
    /// The sheet does not say which app the person picked, so it is one bucket.
    static let nativeSource = "native"

    /// The URL the share sheet gets, or nil when there is nothing to share.
    ///
    /// Any `utm_*` already on the address is dropped before the campaign is
    /// appended, so a link never carries two `utm_source`s; every other query
    /// item and the fragment are kept as they were. Only an absolute http(s)
    /// URL qualifies: anything else the server might send is no button rather
    /// than a sheet with a broken link in it.
    static func shareURL(publicUrl: String?, source: String = nativeSource) -> URL? {
        guard let raw = publicUrl?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              var components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = components.host, !host.isEmpty
        else { return nil }
        let kept = (components.queryItems ?? []).filter { !$0.name.lowercased().hasPrefix("utm_") }
        components.queryItems = kept + [
            URLQueryItem(name: "utm_source", value: source),
            URLQueryItem(name: "utm_medium", value: "share"),
            URLQueryItem(name: "utm_campaign", value: "bau"),
        ]
        return components.url
    }

    /// The share URL for a post in the feed, or nil when the post must not
    /// offer Compartilhar. A locked post never does, whatever the server sent:
    /// a members-only post has no public page.
    static func shareURL(for post: CommunityHomePost) -> URL? {
        guard !post.locked else { return nil }
        return shareURL(publicUrl: post.publicUrl)
    }

    /// The words that go with the link: the title, else the server's plain-text
    /// teaser, first line only. Never the raw body, which can be a GIF URL or
    /// carry `<#channel>` markup. Empty when there is neither, and the sheet
    /// shows the URL (the page's own unfurl carries the rest).
    static func shareTitle(for post: CommunityHomePost) -> String {
        for candidate in [post.title, post.teaser] {
            let text = (candidate ?? "")
                .split(whereSeparator: \.isNewline).first
                .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
            if !text.isEmpty { return text.count > 120 ? String(text.prefix(119)) + "…" : text }
        }
        return ""
    }
}

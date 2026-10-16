import Foundation
import SwiftUI
import UIKit

// CUSTOM SERVER EMOJI in a message body.
//
// A server's staff upload a small picture under a name, and members use it as
// `:name:`. The wire stores `<:name:id>` (`packages/shared/src/server-emoji.ts`):
// the id is what resolves, the name is only the fallback text. Anybody with a
// server can upload emoji now (no flag, gated only by storage), so a web user's
// `:party:` used to arrive on a phone as `<:party:1b2c...>` markup noise. This
// is the RENDER half: the token becomes the picture, or `:name:` while it
// loads or when it cannot. Picking and sending custom emoji from a phone is a
// separate piece of work.
//
// The picture comes from `GET /api/emoji/:id`, which answers with a 302 to the
// stored object and needs no token (it is served before auth, like an
// avatar), so a plain request is enough.

enum CustomEmoji {
    /// `<:name:id>` anywhere in a body (static emoji only, as the web's
    /// `CUSTOM_EMOJI_TOKEN_PATTERN`).
    static let tokenPattern =
        "<:([a-z0-9_]{2,32}):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>"

    /// The stand-in left in the text while markdown is parsed: a private-use
    /// character no message carries, one per token, in order.
    static let placeholder: Character = "\u{E000}"

    struct Token: Equatable, Sendable {
        let name: String
        let id: String
    }

    /// The body with every token replaced by `placeholder`, and the tokens in
    /// the order they stood. A body with none comes back untouched.
    static func prepare(_ source: String) -> (text: String, tokens: [Token]) {
        // A body that already carries the stand-in (nobody types it; somebody
        // hostile might) loses it, so the tokens always line up with the stand-ins.
        let body = source.contains(placeholder) ? source.filter { $0 != placeholder } : source
        guard body.contains("<:"), let regex = try? NSRegularExpression(pattern: tokenPattern) else {
            return (body, [])
        }
        let whole = NSRange(body.startIndex..., in: body)
        let matches = regex.matches(in: body, range: whole)
        guard !matches.isEmpty else { return (body, []) }
        var tokens: [Token] = []
        var text = ""
        var cursor = body.startIndex
        for match in matches {
            guard let range = Range(match.range, in: body),
                  let name = Range(match.range(at: 1), in: body),
                  let id = Range(match.range(at: 2), in: body) else { continue }
            text += body[cursor..<range.lowerBound]
            text.append(placeholder)
            tokens.append(Token(name: String(body[name]), id: String(body[id]).lowercased()))
            cursor = range.upperBound
        }
        text += body[cursor...]
        return (text, tokens)
    }

    /// Every token as the `:name:` a person typed, for plain-text surfaces (a
    /// reply's excerpt, an accessibility label).
    static func asText(_ body: String) -> String {
        guard body.contains("<:"), let regex = try? NSRegularExpression(pattern: tokenPattern) else { return body }
        return regex.stringByReplacingMatches(
            in: body, range: NSRange(body.startIndex..., in: body), withTemplate: ":$1:"
        )
    }

    static func imageURL(id: String, backend: Backend = .current) -> URL? {
        Avatar.resolve("/api/emoji/\(id)", backend: backend)
    }

    /// The text size an emoji is drawn at: a little taller than the body font,
    /// like the web's inline emoji.
    static let points: CGFloat = 22
}

/// The pictures fetched so far. One per id for the life of the process (an
/// emoji's bytes never change under an id), capped, and a failure is remembered
/// so a deleted emoji is not asked for again on every redraw.
@MainActor
@Observable
final class EmojiImages {
    static let shared = EmojiImages()

    private(set) var images: [String: UIImage] = [:]
    @ObservationIgnored private var inFlight: Set<String> = []
    @ObservationIgnored private var failed: Set<String> = []
    @ObservationIgnored private var order: [String] = []
    private static let cap = 256

    func image(for id: String) -> UIImage? { images[id] }

    /// Starts the fetch for each id that is not here, in flight or known bad.
    func load(_ ids: [String]) async {
        let wanted = Set(ids).filter { images[$0] == nil && !inFlight.contains($0) && !failed.contains($0) }
        guard !wanted.isEmpty else { return }
        inFlight.formUnion(wanted)
        await withTaskGroup(of: (String, UIImage?).self) { group in
            for id in wanted {
                group.addTask { (id, await Self.fetch(id)) }
            }
            for await (id, image) in group {
                inFlight.remove(id)
                if let image {
                    images[id] = image
                    order.append(id)
                    if order.count > Self.cap, let oldest = order.first {
                        order.removeFirst()
                        images.removeValue(forKey: oldest)
                    }
                } else {
                    failed.insert(id)
                }
            }
        }
    }

    private nonisolated static func fetch(_ id: String) async -> UIImage? {
        guard let url = CustomEmoji.imageURL(id: id) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let source = UIImage(data: data)
        else { return nil }
        // Drawn once at the size it is shown, at the screen's scale: a 128 px
        // picture inside a line of text would otherwise be laid out at its own
        // pixel size.
        let side = CustomEmoji.points
        let format = UIGraphicsImageRendererFormat.default()
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            source.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }.withRenderingMode(.alwaysOriginal)
    }
}

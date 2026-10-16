import Foundation
import SwiftUI
import ImageIO
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

/// How many emoji downloads run at once, across every message on screen. A
/// burst of distinct ids (a long scroll, a message made of emoji) waits its
/// turn instead of opening a connection each.
private actor EmojiFetchGate {
    private var available = 4
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if available > 0 {
            available -= 1
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        if waiters.isEmpty { available += 1 } else { waiters.removeFirst().resume() }
    }
}

/// The pictures fetched so far. One per id for the life of the process (an
/// emoji's bytes never change under an id), capped. Only a CONFIRMED bad one
/// (gone, not a picture, absurdly large) is remembered for good, so a deleted
/// emoji is not asked for again on every redraw; a cancelled or failed request
/// is retried, after a pause, the next time the message is drawn.
@MainActor
@Observable
final class EmojiImages {
    static let shared = EmojiImages()

    private(set) var images: [String: UIImage] = [:]
    @ObservationIgnored private var inFlight: Set<String> = []
    @ObservationIgnored private var failed: Set<String> = []
    @ObservationIgnored private var retryAt: [String: Date] = [:]
    @ObservationIgnored private var order: [String] = []
    private static let cap = 256
    private static let retryDelay: TimeInterval = 20
    /// An emoji is a small picture; anything past this is not one.
    private nonisolated static let maxBytes = 512 * 1024
    private static let gate = EmojiFetchGate()

    enum Outcome: Sendable {
        case image(UIImage)
        /// The server said no, or it is not a usable picture: never again.
        case rejected
        /// The network, a timeout, or a cancelled view: ask again later.
        case transient
    }

    func image(for id: String) -> UIImage? { images[id] }

    /// Starts the fetch for each id that is not here, in flight or known bad.
    func load(_ ids: [String]) async {
        let now = Date()
        let wanted = Set(ids).filter {
            images[$0] == nil && !inFlight.contains($0) && !failed.contains($0)
                && (retryAt[$0].map { $0 <= now } ?? true)
        }
        guard !wanted.isEmpty else { return }
        inFlight.formUnion(wanted)
        await withTaskGroup(of: (String, Outcome).self) { group in
            for id in wanted {
                group.addTask {
                    await Self.gate.acquire()
                    let outcome = await Self.fetch(id)
                    await Self.gate.release()
                    return (id, outcome)
                }
            }
            for await (id, outcome) in group {
                inFlight.remove(id)
                switch outcome {
                case .image(let image):
                    retryAt.removeValue(forKey: id)
                    images[id] = image
                    order.append(id)
                    if order.count > Self.cap, let oldest = order.first {
                        order.removeFirst()
                        images.removeValue(forKey: oldest)
                    }
                case .rejected:
                    failed.insert(id)
                case .transient:
                    retryAt[id] = Date().addingTimeInterval(Self.retryDelay)
                }
            }
        }
    }

    /// An emoji is a few hundred pixels at most. Past these it is not one.
    nonisolated static func fitsDecodeBudget(width: Int, height: Int) -> Bool {
        width > 0 && height > 0 && width <= 2048 && height <= 2048 && width * height <= 2_000_000
    }

    private nonisolated static func fetch(_ id: String) async -> Outcome {
        guard let url = CustomEmoji.imageURL(id: id) else { return .rejected }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        var data = Data()
        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { return .transient }
            // A gone or forbidden emoji will not come back; a server error might.
            guard http.statusCode == 200 else {
                // Gone or forbidden will not come back; a timeout (408), a rate
                // limit (429) or any server error might.
                let permanent = (400..<500).contains(http.statusCode) && ![408, 425, 429].contains(http.statusCode)
                return permanent ? .rejected : .transient
            }
            if http.expectedContentLength > Int64(maxBytes) { return .rejected }
            for try await byte in bytes {
                data.append(byte)
                if data.count > maxBytes { return .rejected }
            }
        } catch {
            return .transient
        }
        if Task.isCancelled { return .transient }
        // Decoded straight to the size it is drawn at, so a picture with absurd
        // dimensions never becomes a full-size bitmap.
        let side = CustomEmoji.points
        let scale = await MainActor.run { UIScreen.main.scale }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(side * scale * 2),
        ]
        // The size is read from the header BEFORE anything is decoded: a small
        // file can claim enormous dimensions, and a thumbnail may need the whole
        // bitmap to make a 44 px one.
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              fitsDecodeBudget(width: width, height: height),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { return .rejected }
        // Drawn once at the size it is shown, at the screen's scale: a 128 px
        // picture inside a line of text would otherwise be laid out at its own
        // pixel size.
        let format = UIGraphicsImageRendererFormat.default()
        let drawn = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            UIImage(cgImage: thumbnail).draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }.withRenderingMode(.alwaysOriginal)
        return .image(drawn)
    }
}

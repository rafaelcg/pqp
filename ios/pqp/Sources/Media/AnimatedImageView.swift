import SwiftUI

/// The animated equivalent of `AsyncImage` for a URL that points at a GIF.
///
/// Fetches the bytes, decodes them through `AnimatedImageCache` (which keeps
/// the result around so scrolling a chat back into view doesn't re-run
/// ImageIO on the same attachment), and plays them looping via
/// `GIFPlayerView`. Used for inline GIF attachments in chat, GIF picker
/// preview cells, and the fullscreen viewer.
struct AnimatedImageView: View {
    let url: URL?
    var contentMode: UIView.ContentMode = .scaleAspectFit
    /// Fired once if the fetch or decode fails, so a caller sitting on a
    /// presigned URL that may have expired (chat attachments) can retry with
    /// a freshly signed one — mirrors the one-retry pattern the rest of the
    /// app uses for expired attachment links.
    var onFailure: (() -> Void)?

    @State private var frames: [GIFFrame] = []
    @State private var failed = false

    var body: some View {
        ZStack {
            if !frames.isEmpty {
                GIFPlayerView(frames: frames, key: url?.absoluteString ?? "", contentMode: contentMode)
                    // Hidden from accessibility, which is also what keeps an
                    // enclosing Button's *frame* honest. The hosted
                    // `UIImageView` reports an accessibility frame derived from
                    // the decoded image rather than from the layout, and a
                    // control containing it inherits that union — in the GIF
                    // picker that turned four tidy 182×110 cells into four
                    // overlapping 460pt rectangles in the accessibility tree,
                    // half of them off-screen. There is nothing to announce
                    // here anyway: the animation is the content, and the
                    // control around it carries the label.
                    .accessibilityHidden(true)
            } else if failed {
                Rectangle()
                    .fill(Palette.surface)
                    .overlay(
                        Image(systemName: "photo")
                            .foregroundStyle(Palette.paperMuted)
                    )
            } else {
                Rectangle()
                    .fill(Palette.surface)
                    .overlay(ProgressView().tint(Palette.paperMuted))
            }
        }
        // The one line that makes a GIF tappable.
        //
        // Once the frames arrive this view's entire content is a
        // `UIViewRepresentable` — and a representable draws nothing SwiftUI can
        // hit-test, while the `UIImageView` it hosts has
        // `isUserInteractionEnabled == false` like every UIImageView. So a
        // `Button` whose label is just this had no hit region at all: taps went
        // straight through it to whatever was behind. That is exactly the GIF
        // picker's dead tap, and the same bug made a GIF in the transcript
        // refuse to open fullscreen. It only looked intermittent because the
        // placeholder shown *while* loading is a real `Rectangle`, which is
        // hittable — tap early enough and it worked.
        .contentShape(Rectangle())
        .task(id: url) { await load() }
    }

    private func load() async {
        failed = false
        frames = []
        guard let url else {
            failed = true
            return
        }

        if let cached = await AnimatedImageCache.shared.cached(for: url.absoluteString) {
            frames = cached
            return
        }

        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw URLError(.badServerResponse)
            }
            let decoded = await AnimatedImageCache.shared.decodeAndStore(data: data, key: url.absoluteString)
            guard !Task.isCancelled else { return }
            if decoded.isEmpty {
                failed = true
                onFailure?()
            } else {
                frames = decoded
            }
        } catch {
            guard !Task.isCancelled else { return }
            failed = true
            onFailure?()
        }
    }
}

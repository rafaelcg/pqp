import SwiftUI
import WebRTC

/// Draws one WebRTC video track.
///
/// `RTCMTLVideoView` rather than `RTCEAGLVideoView`: the GL view is deprecated
/// and, on a call showing two streams at once, noticeably hotter. It is a plain
/// `UIView` subclass that implements `RTCVideoRenderer`, so the whole job here is
/// attaching and — crucially — *detaching* the renderer, because a track keeps a
/// strong reference to every renderer added to it. Leave one attached and the
/// view outlives the call, still decoding frames.
struct VideoSurface: UIViewRepresentable {
    let track: RTCVideoTrack?
    /// `.scaleAspectFill` crops to fill (right for a self-preview tile),
    /// `.scaleAspectFit` letterboxes (the only honest way to show a shared
    /// screen, whose aspect ratio is not ours to choose).
    var contentMode: UIView.ContentMode = .scaleAspectFill
    /// Mirrored, like every self-view on a phone. Never applied to a remote
    /// track: you are the only person you see reversed in real life.
    var mirrored: Bool = false

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView(frame: .zero)
        view.videoContentMode = contentMode
        view.backgroundColor = .clear
        // The renderer is attached in updateUIView, which SwiftUI always calls
        // right after make — keeping attach/detach in one place means one rule
        // to get right instead of two.
        context.coordinator.attach(track: track, to: view)
        return view
    }

    func updateUIView(_ view: RTCMTLVideoView, context: Context) {
        view.videoContentMode = contentMode
        view.transform = mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity
        context.coordinator.attach(track: track, to: view)
    }

    static func dismantleUIView(_ view: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.detach(from: view)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// Holds the currently-rendered track so a re-render with the same track is
    /// a no-op rather than a detach/attach flicker.
    final class Coordinator {
        private var attached: RTCVideoTrack?

        func attach(track: RTCVideoTrack?, to view: RTCMTLVideoView) {
            guard attached !== track else { return }
            attached?.remove(view)
            attached = track
            track?.add(view)
        }

        func detach(from view: RTCMTLVideoView) {
            attached?.remove(view)
            attached = nil
        }
    }
}

/// A video tile with the app's ground behind it, so a track that has not
/// produced its first frame reads as "connecting" rather than a hole.
struct VideoTile: View {
    let track: RTCVideoTrack?
    var contentMode: UIView.ContentMode = .scaleAspectFill
    var mirrored: Bool = false

    var body: some View {
        ZStack {
            Palette.inkDeep
            if let track {
                VideoSurface(track: track, contentMode: contentMode, mirrored: mirrored)
            }
        }
    }
}
